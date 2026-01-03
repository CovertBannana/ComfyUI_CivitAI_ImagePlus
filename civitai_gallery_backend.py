
import os
import json
import aiohttp
from aiohttp import web
import server
import torch
import numpy as np
from PIL import Image
import io
import urllib.request
from urllib.parse import urlparse, quote

# ------------------------------------------------------------
# API key handling
# ------------------------------------------------------------
NODE_DIR = os.path.dirname(os.path.abspath(__file__))
API_KEY_FILE = os.path.join(NODE_DIR, "api_key.txt")


def load_api_key():
    if not os.path.exists(API_KEY_FILE):
        return None
    with open(API_KEY_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("CIVITAI_API_KEY="):
                return line.split("=", 1)[1].strip()
    return None


# ------------------------------------------------------------
# Simple in-memory stores (keyed by node unique_id)
# ------------------------------------------------------------
PROMPT_STORE = {}  # unique_id -> {"positive": str, "negative": str, "rev": int}
PREVIEW_STORE = {}  # unique_id -> {"url": str, "rev": int}


def _bump(store: dict, unique_id: str):
    item = store.get(unique_id)
    if not item:
        return 1
    item["rev"] = int(item.get("rev", 0)) + 1
    return item["rev"]


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------
def _tensor_from_pil(img: Image.Image) -> torch.Tensor:
    img = img.convert("RGB")
    arr = np.asarray(img).astype("float32") / 255.0
    return torch.from_numpy(arr)[None, ...]


def _redact_params(d: dict):
    safe = dict(d or {})
    if "token" in safe and safe["token"]:
        safe["token"] = "***redacted***"
    return safe


def _is_allowed_image_url(raw_url: str) -> bool:
    """
    Prevent SSRF: only allow civitai image hosts.
    """
    try:
        u = urlparse(raw_url)
        if u.scheme not in ("http", "https"):
            return False
        host = (u.netloc or "").lower()
        if host == "image.civitai.com":
            return True
        if host.endswith(".civitai.com"):
            return True
        if host == "civitai.com":
            return True
        return False
    except Exception:
        return False


async def fetch_bytes_authed(url: str, api_key: str, timeout_s: int = 60) -> tuple[bytes, str]:
    headers = {
        "User-Agent": "ComfyUI-CivitAI-Gallery",
        "Authorization": f"Bearer {api_key}",
        "Referer": "https://civitai.com/",
    }
    timeout = aiohttp.ClientTimeout(total=timeout_s)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers) as resp:
            content_type = resp.headers.get("Content-Type", "application/octet-stream")
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"Upstream image fetch failed ({resp.status}): {text[:300]}")
            data = await resp.read()
            return data, content_type


# ------------------------------------------------------------
# Nodes
# ------------------------------------------------------------
class CivitaiGalleryNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"selection_data": ("STRING", {"default": "{}", "multiline": True})}}

    RETURN_TYPES = ("STRING", "STRING", "IMAGE", "STRING")
    RETURN_NAMES = ("Positive", "Negative", "Image", "Info")
    FUNCTION = "run"
    CATEGORY = "Asset Gallery/Civitai"

    def _extract_prompts(self, meta: dict):
        if not isinstance(meta, dict):
            return "", ""
        positive = (
            meta.get("prompt")
            or meta.get("positivePrompt")
            or meta.get("positive")
            or (meta.get("parameters") or {}).get("prompt", "")
        )
        negative = (
            meta.get("negativePrompt")
            or meta.get("negative")
            or (meta.get("parameters") or {}).get("negative", "")
        )
        return positive or "", negative or ""

    def _build_civitai_page_url(self, image_id=None, post_id=None):
        if image_id:
            return f"https://civitai.com/images/{image_id}"
        if post_id:
            return f"https://civitai.com/posts/{post_id}"
        return ""

    def run(self, selection_data="{}"):
        try:
            data = json.loads(selection_data) if selection_data else {}
        except Exception:
            data = {}

        item = data.get("item", {}) or {}
        image_id = item.get("id") or item.get("imageId")
        post_id = item.get("postId")

        meta = item.get("meta")
        if meta is None:
            meta = item.get("metadata")
        if meta is None:
            meta = {}

        # Flatten nested meta wrapper
        if isinstance(meta, dict) and isinstance(meta.get("meta"), dict):
            if not image_id and "id" in meta:
                image_id = meta.get("id")
            meta = meta["meta"]

        positive, negative = self._extract_prompts(meta)

        # Best-effort image tensor (protected-safe preview uses proxy route)
        tensor = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
        image_url = item.get("url")
        if image_url:
            try:
                req = urllib.request.Request(
                    image_url, headers={"User-Agent": "ComfyUI-CivitAI-Gallery"}
                )
                with urllib.request.urlopen(req, timeout=30) as r:
                    img_bytes = r.read()
                img = Image.open(io.BytesIO(img_bytes))
                tensor = _tensor_from_pil(img)
            except Exception as e:
                print(f"[CivitAI Gallery] Image download failed: {e}")

        model_name = ""
        try:
            res_list = meta.get("resources") or []
            if isinstance(res_list, list) and res_list:
                model_name = res_list[0].get("name") or ""
        except Exception:
            pass

        page_url = self._build_civitai_page_url(image_id, post_id)
        info = f"CivitAI Page: {page_url}" + (f"\nModel: {model_name}" if model_name else "")
        if not positive and not negative:
            info = "No prompts found.\n" + info

        return (positive, negative, tensor, info)


class CivitaiPromptEditorNode:
    """
    Output-only prompt editor (no input sockets).
    JS updates prompt values instantly via /civitai_gallery/set_prompt
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("Positive", "Negative")
    FUNCTION = "run"
    CATEGORY = "Asset Gallery/Civitai"

    @classmethod
    def IS_CHANGED(cls, unique_id=None, **kwargs):
        uid = str(unique_id) if unique_id is not None else ""
        rev = PROMPT_STORE.get(uid, {}).get("rev", 0)
        return str(rev)

    def run(self, unique_id=None):
        uid = str(unique_id) if unique_id is not None else ""
        entry = PROMPT_STORE.get(uid) or {}
        return (entry.get("positive", "") or "", entry.get("negative", "") or "")


class CivitaiInfoDisplayNode:
    """
    Display-only node:
    - No inputs
    - No outputs
    - JS adds a textarea widget and updates it instantly.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "Asset Gallery/Civitai"
    OUTPUT_NODE = True

    def noop(self):
        return ()


class CivitaiImagePreviewNode:
    """
    Protected-safe preview + runtime image output for img2img:
    - Optional IMAGE input (pass-through)
    - Output IMAGE
    - No source_url socket (JS writes URL into backend via /civitai_gallery/set_preview)
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("Image",)
    FUNCTION = "run"
    CATEGORY = "Asset Gallery/Civitai"

    @classmethod
    def IS_CHANGED(cls, unique_id=None, **kwargs):
        uid = str(unique_id) if unique_id is not None else ""
        rev = PREVIEW_STORE.get(uid, {}).get("rev", 0)
        return str(rev)

    def run(self, image=None, unique_id=None):
        # Pass-through if provided
        if image is not None:
            return (image,)

        uid = str(unique_id) if unique_id is not None else ""
        url = (PREVIEW_STORE.get(uid) or {}).get("url", "") or ""
        if not url:
            tensor = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            return (tensor,)

        # Fetch via local proxy route to keep auth handling consistent
        try:
            local = f"http://127.0.0.1:8188/civitai_gallery/proxy_image?url={quote(url, safe='')}"
            req = urllib.request.Request(local, headers={"User-Agent": "ComfyUI-CivitAI-Gallery"})
            with urllib.request.urlopen(req, timeout=60) as r:
                img_bytes = r.read()
            img = Image.open(io.BytesIO(img_bytes))
            return (_tensor_from_pil(img),)
        except Exception as e:
            print(f"[CivitAI Preview] Failed to fetch image: {e}")
            tensor = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            return (tensor,)


# ------------------------------------------------------------
# Routes
# ------------------------------------------------------------
prompt_server = server.PromptServer.instance


@prompt_server.routes.post("/civitai_gallery/set_prompt")
async def civitai_set_prompt(request):
    """
    Body: {"node_id": "<id>", "positive": "...", "negative": "..."}
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_id = str(body.get("node_id", "")).strip()
    if not node_id:
        return web.json_response({"error": "Missing node_id"}, status=400)

    positive = body.get("positive", "") or ""
    negative = body.get("negative", "") or ""

    entry = PROMPT_STORE.get(node_id) or {"rev": 0}
    entry["positive"] = positive
    entry["negative"] = negative
    PROMPT_STORE[node_id] = entry
    _bump(PROMPT_STORE, node_id)

    return web.json_response({"ok": True})


@prompt_server.routes.post("/civitai_gallery/set_preview")
async def civitai_set_preview(request):
    """
    Body: {"node_id": "<id>", "url": "..."}
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_id = str(body.get("node_id", "")).strip()
    if not node_id:
        return web.json_response({"error": "Missing node_id"}, status=400)

    url = (body.get("url", "") or "").strip()
    entry = PREVIEW_STORE.get(node_id) or {"rev": 0}
    entry["url"] = url
    PREVIEW_STORE[node_id] = entry
    _bump(PREVIEW_STORE, node_id)

    return web.json_response({"ok": True})


@prompt_server.routes.get("/civitai_gallery/images")
async def civitai_images(request):
    api_key = load_api_key()
    if not api_key:
        return web.json_response({"error": "CivitAI API key missing (api_key.txt)"}, status=401)

    p = dict(request.query)
    limit = int(p.get("limit", "36"))
    sort = p.get("sort", "Most Reactions")
    period = p.get("period", "AllTime")
    nsfw = p.get("nsfw", "None")
    cursor = p.get("cursor", None)
    if cursor is not None:
        cursor = str(cursor).strip()
        if cursor == "":
            cursor = None

    api_url = "https://civitai.com/api/v1/images"
    headers = {"Authorization": f"Bearer {api_key}"}
    params = {"limit": min(200, limit), "sort": sort, "period": period, "nsfw": nsfw}
    if cursor is not None:
        params["cursor"] = cursor

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(api_url, params=params, headers=headers) as resp:
                data = await resp.json()
                return web.json_response(
                    {"items": data.get("items", []), "metadata": data.get("metadata", {}) or {}}
                )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@prompt_server.routes.get("/civitai_gallery/image_by_url")
async def civitai_image_by_url(request):
    api_key = load_api_key()
    if not api_key:
        return web.json_response({"error": "Missing API key"}, status=401)

    raw_url = request.query.get("url", "").strip()
    if not raw_url:
        return web.json_response({"error": "Missing url parameter"}, status=400)

    from urllib.parse import urlparse, parse_qs

    parsed = urlparse(raw_url)
    qs = parse_qs(parsed.query)
    path_parts = [p for p in parsed.path.strip("/").split("/") if p]

    images_api = "https://civitai.com/api/v1/images"
    headers = {"Authorization": f"Bearer {api_key}"}

    image_id = None
    post_id = None

    try:
        if len(path_parts) >= 2:
            kind, id_str = path_parts[0].lower(), path_parts[1]
            if id_str.isdigit():
                if kind == "images":
                    image_id = id_str
                elif kind == "posts":
                    post_id = id_str
    except Exception:
        pass

    if not image_id:
        image_id = (qs.get("imageId") or [None])[0]
    if not post_id:
        post_id = (qs.get("postId") or [None])[0]

    async def _call(params):
        params = dict(params)
        params["token"] = api_key
        params.setdefault("nsfw", "X")  # Option A

        async with aiohttp.ClientSession() as session:
            async with session.get(images_api, params=params, headers=headers) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    return None, {
                        "error": "CivitAI request failed",
                        "status": resp.status,
                        "details": text,
                        "params": _redact_params(params),
                    }
                data = await resp.json()
                return data, None

    if post_id:
        data, err = await _call({"postId": post_id, "limit": 1})
        if err:
            return web.json_response(err, status=err.get("status", 500))
        items = data.get("items", []) if isinstance(data, dict) else []
        if items:
            return web.json_response({"item": items[0]})
        return web.json_response(
            {
                "error": "No items returned for postId",
                "postId": post_id,
                "hint": "If this is a video-only post, /api/v1/images may return empty. Otherwise it may be restricted by browsing settings.",
            },
            status=404,
        )

    if image_id:
        data, err = await _call({"imageId": image_id, "limit": 1})
        if err:
            return web.json_response(err, status=err.get("status", 500))
        items = data.get("items", []) if isinstance(data, dict) else []
        if items:
            return web.json_response({"item": items[0]})
        return web.json_response(
            {
                "error": "No items returned for imageId",
                "imageId": image_id,
                "hint": "This can happen for login-gated images or due to imageId lookup behavior returning empty.",
            },
            status=404,
        )

    return web.json_response(
        {"error": "Could not parse postId or imageId from URL", "url": raw_url},
        status=400,
    )


@prompt_server.routes.get("/civitai_gallery/proxy_image")
async def civitai_proxy_image(request):
    api_key = load_api_key()
    if not api_key:
        return web.json_response({"error": "Missing API key"}, status=401)

    raw_url = request.query.get("url", "").strip()
    if not raw_url:
        return web.json_response({"error": "Missing url parameter"}, status=400)

    if not _is_allowed_image_url(raw_url):
        return web.json_response({"error": "URL host not allowed"}, status=400)

    try:
        img_bytes, content_type = await fetch_bytes_authed(raw_url, api_key, timeout_s=60)
        return web.Response(
            body=img_bytes,
            status=200,
            headers={"Content-Type": content_type, "Cache-Control": "no-store"},
        )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


NODE_CLASS_MAPPINGS = {
    "CivitaiGalleryNode": CivitaiGalleryNode,
    "CivitaiPromptEditorNode": CivitaiPromptEditorNode,
    "CivitaiInfoDisplayNode": CivitaiInfoDisplayNode,
    "CivitaiImagePreviewNode": CivitaiImagePreviewNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CivitaiGalleryNode": "CivitAI Gallery (Rebuilt)",
    "CivitaiPromptEditorNode": "CivitAI Prompt Editor",
    "CivitaiInfoDisplayNode": "CivitAI Info Display",
    "CivitaiImagePreviewNode": "CivitAI Image Preview (Protected)",
}
