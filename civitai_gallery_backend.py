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
from urllib.parse import urlparse, quote, parse_qs
from typing import Optional

# ------------------------------------------------------------
# API key handling
# ------------------------------------------------------------
NODE_DIR = os.path.dirname(os.path.abspath(__file__))
API_KEY_FILE = os.path.join(NODE_DIR, "api_key.txt")

# ------------------------------------------------------------
# Config / future-proofing
# ------------------------------------------------------------
DEFAULT_SITE_API_BASES = (
    "https://civitai.com/api/v1",
    "https://civitai.red/api/v1",
)

DEFAULT_PAGE_BASES = {
    "com": "https://civitai.com",
    "red": "https://civitai.red",
}


def load_api_key():
    if not os.path.exists(API_KEY_FILE):
        return None
    with open(API_KEY_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("CIVITAI_API_KEY="):
                return line.split("=", 1)[1].strip()
    return None


def _get_site_api_bases():
    """
    Future-proof:
    - allows override via env var
    - tries both .com and .red
    """
    env_base = (os.getenv("CIVITAI_SITE_API_BASE") or "").strip().rstrip("/")
    bases = []
    if env_base:
        bases.append(env_base)
    for b in DEFAULT_SITE_API_BASES:
        if b not in bases:
            bases.append(b)
    return tuple(bases)


def _get_page_domain_mode():
    """
    auto | com | red
    """
    mode = (os.getenv("CIVITAI_PAGE_DOMAIN_MODE") or "auto").strip().lower()
    if mode not in ("auto", "com", "red"):
        return "auto"
    return mode


# ------------------------------------------------------------
# Simple in-memory stores (keyed by node unique_id)
# ------------------------------------------------------------
PROMPT_STORE = {}   # unique_id -> {"positive": str, "negative": str, "rev": int}
PREVIEW_STORE = {}  # unique_id -> {"url": str, "page_url": str, "rev": int}


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


def _is_allowed_page_host(host: str) -> bool:
    host = (host or "").lower()
    return host in {
        "civitai.com",
        "www.civitai.com",
        "civitai.red",
        "www.civitai.red",
    }


def _is_allowed_page_url(raw_url: str) -> bool:
    try:
        u = urlparse(raw_url)
        if u.scheme not in ("http", "https"):
            return False
        return _is_allowed_page_host(u.netloc)
    except Exception:
        return False


def _is_allowed_image_url(raw_url: str) -> bool:
    """
    Prevent SSRF: only allow known civitai hosts.
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
        if host.endswith(".civitai.red"):
            return True
        if host == "civitai.red":
            return True
        return False
    except Exception:
        return False


def _page_base_from_url(raw_url: str) -> Optional[str]:
    if not raw_url:
        return None
    try:
        u = urlparse(raw_url)
        if u.scheme not in ("http", "https"):
            return None
        if not _is_allowed_page_host(u.netloc):
            return None
        return f"{u.scheme}://{u.netloc}"
    except Exception:
        return None


def _preferred_page_base(
    explicit_url: str = "",
    source_url: str = "",
    page_domain: str = "",
) -> str:
    """
    Resolution order:
    1) explicit URL (e.g. fetched post/image URL)
    2) page_domain forced by frontend ("com" or "red")
    3) source URL if it is a civitai page URL
    4) env override mode
    5) safe default: civitai.com
    """
    forced = (page_domain or "").strip().lower()
    if forced in DEFAULT_PAGE_BASES:
        return DEFAULT_PAGE_BASES[forced]

    base = _page_base_from_url(explicit_url)
    if base:
        return base

    base = _page_base_from_url(source_url)
    if base:
        return base

    mode = _get_page_domain_mode()
    if mode in DEFAULT_PAGE_BASES:
        return DEFAULT_PAGE_BASES[mode]

    return DEFAULT_PAGE_BASES["com"]


def _build_civitai_page_url(image_id=None, post_id=None, page_base: str = ""):
    base = (page_base or DEFAULT_PAGE_BASES["com"]).rstrip("/")
    if image_id:
        return f"{base}/images/{image_id}"
    if post_id:
        return f"{base}/posts/{post_id}"
    return ""


def _auth_headers(api_key: str, referer_url: str = "") -> dict:
    referer_base = _preferred_page_base(explicit_url=referer_url)
    return {
        "User-Agent": "ComfyUI-CivitAI-Gallery",
        "Authorization": f"Bearer {api_key}",
        "Referer": referer_base.rstrip("/") + "/",
    }


async def fetch_bytes_authed(
    url: str,
    api_key: str,
    timeout_s: int = 60,
    referer_url: str = "",
) -> tuple[bytes, str]:
    headers = _auth_headers(api_key, referer_url=referer_url)
    timeout = aiohttp.ClientTimeout(total=timeout_s)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers) as resp:
            content_type = resp.headers.get("Content-Type", "application/octet-stream")
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"Upstream image fetch failed ({resp.status}): {text[:300]}")
            data = await resp.read()
            return data, content_type


def fetch_bytes_authed_sync(
    url: str,
    api_key: str,
    timeout_s: int = 60,
    referer_url: str = "",
) -> tuple[bytes, str]:
    headers = _auth_headers(api_key, referer_url=referer_url)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        data = r.read()
        content_type = r.headers.get("Content-Type", "application/octet-stream")
        return data, content_type


async def _call_site_api_json(
    path: str,
    params: dict,
    api_key: str,
    timeout_s: int = 60,
):
    """
    Try configured API bases in order. This future-proofs against
    any host-level routing changes while keeping auth in headers.
    """
    clean_params = dict(params or {})
    headers = _auth_headers(api_key)
    timeout = aiohttp.ClientTimeout(total=timeout_s)

    last_error = None
    for base in _get_site_api_bases():
        url = base.rstrip("/") + "/" + path.lstrip("/")
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, params=clean_params, headers=headers) as resp:
                    text = await resp.text()
                    if resp.status != 200:
                        last_error = {
                            "error": "CivitAI request failed",
                            "status": resp.status,
                            "details": text[:800],
                            "params": _redact_params(clean_params),
                            "url": url,
                        }
                        continue
                    try:
                        data = json.loads(text)
                    except Exception:
                        last_error = {
                            "error": "CivitAI returned non-JSON response",
                            "status": resp.status,
                            "details": text[:800],
                            "params": _redact_params(clean_params),
                            "url": url,
                        }
                        continue
                    return data, None
        except Exception as e:
            last_error = {
                "error": "CivitAI request exception",
                "details": str(e),
                "params": _redact_params(clean_params),
                "url": url,
            }

    return None, last_error or {"error": "Unknown CivitAI API failure"}


def _safe_int(value, default, min_value=None, max_value=None):
    try:
        n = int(value)
    except Exception:
        n = default
    if min_value is not None:
        n = max(min_value, n)
    if max_value is not None:
        n = min(max_value, n)
    return n


def _nsfw_to_browsing_level(nsfw_value: str):
    """Map gallery NSFW setting to Civitai browsingLevel."""
    rating_map = {
        "none": 1,
        "soft": 3,
        "mature": 7,
        "x": 15,
        "xxx": 31,
        "true": 15,
    }
    v = str(nsfw_value or "").strip().lower()
    return rating_map.get(v, None)


def _normalize_tags(raw_tags):
    """Return a clean list of tag names from a few possible API shapes."""
    tags = []
    if isinstance(raw_tags, list):
        for t in raw_tags:
            if isinstance(t, dict):
                name = (t.get("name") or t.get("label") or "").strip()
                if name:
                    tags.append(name)
            elif isinstance(t, str):
                name = t.strip()
                if name:
                    tags.append(name)
    elif isinstance(raw_tags, str):
        for part in raw_tags.split(","):
            name = part.strip()
            if name:
                tags.append(name)

    deduped = []
    seen = set()
    for tag in tags:
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(tag)
    return deduped


def _iter_lookup_param_variants(id_key: str, id_value: str, nsfw: str = ""):
    """
    Future-proof against possible API changes around content filtering.
    Explicitly request flattened metadata + tags so prompt data is present
    for gallery picks and URL fetches.
    """
    base = {
        id_key: id_value,
        "limit": 1,
        "withMeta": "true",
        "flatMeta": "true",
        "withTags": "true",
    }
    level = _nsfw_to_browsing_level(nsfw)
    if level is not None:
        base["browsingLevel"] = level
    if nsfw:
        yield dict(base, nsfw=nsfw)
    yield dict(base)
    yield dict(base, nsfw="X")
    yield dict(base, nsfw="true")
    yield dict(base, nsfw=True)


def _maybe_fetch_tensor_from_image_url(image_url: str, page_url: str = "") -> torch.Tensor:
    """
    Best-effort:
    - try authed fetch first when API key exists
    - otherwise try plain public fetch
    """
    if not image_url:
        return torch.zeros((1, 1, 1, 3), dtype=torch.float32)

    api_key = load_api_key()

    # First: try authenticated fetch when we can
    if api_key and _is_allowed_image_url(image_url):
        try:
            img_bytes, _ = fetch_bytes_authed_sync(
                image_url,
                api_key,
                timeout_s=30,
                referer_url=page_url,
            )
            img = Image.open(io.BytesIO(img_bytes))
            return _tensor_from_pil(img)
        except Exception:
            pass

    # Fallback: direct public fetch
    try:
        req = urllib.request.Request(
            image_url,
            headers={"User-Agent": "ComfyUI-CivitAI-Gallery"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            img_bytes = r.read()
        img = Image.open(io.BytesIO(img_bytes))
        return _tensor_from_pil(img)
    except Exception as e:
        print(f"[CivitAI Gallery] Image download failed: {e}")
        return torch.zeros((1, 1, 1, 3), dtype=torch.float32)


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

        params = meta.get("parameters") or {}
        if isinstance(params, str):
            try:
                params = json.loads(params)
            except Exception:
                params = {}
        if not isinstance(params, dict):
            params = {}

        positive = (
            meta.get("prompt")
            or meta.get("positivePrompt")
            or meta.get("positive")
            or params.get("prompt")
            or params.get("positivePrompt")
            or params.get("positive")
            or ""
        )
        negative = (
            meta.get("negativePrompt")
            or meta.get("negative")
            or params.get("negativePrompt")
            or params.get("negative")
            or ""
        )
        return positive or "", negative or ""

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
            
        if isinstance(meta, dict) and isinstance(meta.get("meta"), dict):
            if not image_id and "id" in meta:
                image_id = meta.get("id")
            meta = meta["meta"]
            
        positive, negative = self._extract_prompts(meta)
        page_url = item.get("page_url") or item.get("pageUrl") or ""
        source_page_url = item.get("source_page_url") or item.get("sourcePageUrl") or ""
        page_domain = item.get("page_domain") or item.get("pageDomain") or ""
        
        page_base = _preferred_page_base(
            explicit_url=page_url,
            source_url=source_page_url,
            page_domain=page_domain,
        )
        if not page_url:
            page_url = _build_civitai_page_url(image_id, post_id, page_base=page_base)
            
        tensor = _maybe_fetch_tensor_from_image_url(item.get("url"), page_url=page_url)
        
# --- FIXED MODEL NAME LOGIC WITH VARIATION FALLBACKS ---
        model_name = ""
        try:
            # 1. Fallback to direct top-level metadata strings
            if not model_name:
                direct_model = meta.get("Model type") or meta.get("Model") or meta.get("model") or meta.get("ecosystem")
                if direct_model and isinstance(direct_model, str):
                    model_name = direct_model.strip()

            # 2. Fallback to processing resource list arrays
            if not model_name:
                res_list = meta.get("resources") or []
                if isinstance(res_list, list) and res_list:
                    for res in res_list:
                        r_type = str(res.get("type", "")).strip().lower()
                        r_name = str(res.get("name", "")).strip()
                        if r_name and r_type not in ["lora", "textualinversion", "embeddings"]:
                            model_name = r_name
                            break
                    if not model_name:
                        first_type = str(res_list[0].get("type", "")).strip().lower()
                        if first_type not in ["lora", "textualinversion", "embeddings"]:
                            model_name = res_list[0].get("name") or ""
        except Exception:
            pass

        # --- SAMPLER & SCHEDULER LOGIC ---
        sampler = meta.get("sampler") or meta.get("Sampler") or ""
        scheduler = meta.get("scheduler") or meta.get("Scheduler") or ""
        steps = meta.get("steps")
        cfg = meta.get("cfgScale")
        
        info = f"CivitAI Page: ${page_url}"
        if model_name:
            info += f"\nModel: {model_name}"
        if steps:
            info += f"\nSteps: {steps}"
        if cfg:
            info += f"\nCFG: {cfg}"
        if sampler:
            info += f"\nSampler: {sampler}"
        if scheduler:
            info += f"\nScheduler: {scheduler}"
            
        if not positive and not negative:
            info = "No prompts found.\n" + info
            
        return (positive, negative, tensor, info)

class LocalImageInfoNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_data": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive", "negative", "info")
    FUNCTION = "process"
    CATEGORY = "CivitAI Gallery"

    def process(self, image_data="", unique_id=None):
        """
        image_data is expected to be JSON written by the frontend JS.

        Suggested shape:
        {
            "positive": "...",
            "negative": "...",
            "info": "...",
            "meta": {...},
            "filename": "image.png"
        }
        """
        positive = ""
        negative = ""
        info = ""

        try:
            data = json.loads(image_data or "{}")
            if isinstance(data, dict):
                positive = data.get("positive", "") or ""
                negative = data.get("negative", "") or ""
                info = data.get("info", "") or ""

                # Fallback: if frontend only sends raw metadata,
                # try some common prompt keys.
                meta = data.get("meta", {})
                if isinstance(meta, dict):
                    positive = positive or meta.get("prompt", "") or meta.get("positivePrompt", "") or meta.get("positive", "")
                    negative = negative or meta.get("negativePrompt", "") or meta.get("negative", "")

                    if not info:
                        parts = []
                        filename = data.get("filename", "")
                        if filename:
                            parts.append(f"File: {filename}")

                        model = (
                            meta.get("Model")
                            or meta.get("model")
                            or meta.get("Model type")
                            or meta.get("ecosystem")
                            or ""
                        )
                        if model:
                            parts.append(f"Model: {model}")

                        steps = meta.get("steps") or meta.get("Steps")
                        cfg = meta.get("cfgScale") or meta.get("CFG scale") or meta.get("CFG")
                        sampler = meta.get("sampler") or meta.get("Sampler")
                        scheduler = meta.get("scheduler") or meta.get("Scheduler")

                        if steps:
                            parts.append(f"Steps: {steps}")
                        if cfg:
                            parts.append(f"CFG: {cfg}")
                        if sampler:
                            parts.append(f"Sampler: {sampler}")
                        if scheduler:
                            parts.append(f"Scheduler: {scheduler}")

                        info = "\n".join(parts)

        except Exception as e:
            info = f"Local Image Info parse error: {e}"

        return (positive, negative, info)

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
        entry = PREVIEW_STORE.get(uid) or {}
        url = (entry.get("url", "") or "").strip()
        page_url = (entry.get("page_url", "") or "").strip()

        if not url:
            tensor = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            return (tensor,)

        try:
            tensor = _maybe_fetch_tensor_from_image_url(url, page_url=page_url)
            return (tensor,)
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
    Body: {"node_id": "<id>", "url": "...", "page_url": "..."}
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_id = str(body.get("node_id", "")).strip()
    if not node_id:
        return web.json_response({"error": "Missing node_id"}, status=400)

    url = (body.get("url", "") or "").strip()
    page_url = (body.get("page_url", "") or body.get("pageUrl", "") or "").strip()

    entry = PREVIEW_STORE.get(node_id) or {"rev": 0}
    entry["url"] = url
    entry["page_url"] = page_url
    PREVIEW_STORE[node_id] = entry
    _bump(PREVIEW_STORE, node_id)

    return web.json_response({"ok": True})


@prompt_server.routes.get("/civitai_gallery/images")
async def civitai_images(request):
    api_key = load_api_key()
    if not api_key:
        return web.json_response({"error": "CivitAI API key missing (api_key.txt)"}, status=401)

    p = dict(request.query)
    limit = _safe_int(p.get("limit", "36"), 36, min_value=1, max_value=200)
    sort = p.get("sort", "Most Reactions")
    period = p.get("period", "AllTime")
    nsfw = (p.get("nsfw", "None") or "").strip()
    cursor = p.get("cursor", None)
    if cursor is not None:
        cursor = str(cursor).strip()
        if cursor == "":
            cursor = None

    params = {
        "limit": limit,
        "sort": sort,
        "period": period,
        "withMeta": "true",
        "flatMeta": "true",
        "withTags": "true",
    }
    level = _nsfw_to_browsing_level(nsfw)
    if level is not None:
        params["browsingLevel"] = level
    if nsfw:
        params["nsfw"] = nsfw
    if cursor is not None:
        params["cursor"] = cursor

    data, err = await _call_site_api_json("/images", params, api_key)
    if err and "nsfw" in params:
        # Fallback in case the API changes NSFW filter behavior
        params2 = dict(params)
        params2.pop("nsfw", None)
        data, err = await _call_site_api_json("/images", params2, api_key)

    if err:
        return web.json_response(err, status=err.get("status", 500))

    return web.json_response(
        {"items": data.get("items", []), "metadata": data.get("metadata", {}) or {}}
    )


@prompt_server.routes.get("/civitai_gallery/image_by_url")
async def civitai_image_by_url(request):
    api_key = load_api_key()
    if not api_key:
        return web.json_response({"error": "Missing API key"}, status=401)

    raw_url = request.query.get("url", "").strip()
    if not raw_url:
        return web.json_response({"error": "Missing url parameter"}, status=400)

    if not _is_allowed_page_url(raw_url):
        return web.json_response({"error": "Only civitai.com and civitai.red page URLs are supported"}, status=400)

    parsed = urlparse(raw_url)
    qs = parse_qs(parsed.query)
    path_parts = [p for p in parsed.path.strip("/").split("/") if p]

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

    page_base = _preferred_page_base(explicit_url=raw_url)

    async def _lookup(id_key: str, id_value: str):
        last_err = None
        request_nsfw = (request.query.get("nsfw", "") or "").strip()
        for params in _iter_lookup_param_variants(id_key, id_value, nsfw=request_nsfw):
            data, err = await _call_site_api_json("/images", params, api_key)
            if err:
                last_err = err
                continue
            items = data.get("items", []) if isinstance(data, dict) else []
            if items:
                item = dict(items[0])
                item["pageUrl"] = _build_civitai_page_url(
                    image_id=item.get("id") if id_key == "imageId" else None,
                    post_id=id_value if id_key == "postId" else item.get("postId"),
                    page_base=page_base,
                )
                item["sourcePageUrl"] = raw_url
                if page_base.endswith(".red"):
                    item["pageDomain"] = "red"
                elif page_base.endswith(".com"):
                    item["pageDomain"] = "com"
                return item, None
        return None, last_err

    if post_id:
        item, err = await _lookup("postId", post_id)
        if item:
            return web.json_response({"item": item})
        if err:
            return web.json_response(err, status=err.get("status", 500))
        return web.json_response(
            {
                "error": "No items returned for postId",
                "postId": post_id,
                "hint": "The post may not currently expose an image through the images API, or visibility may be limited by account/domain/region settings.",
            },
            status=404,
        )

    if image_id:
        item, err = await _lookup("imageId", image_id)
        if item:
            return web.json_response({"item": item})
        if err:
            return web.json_response(err, status=err.get("status", 500))
        return web.json_response(
            {
                "error": "No items returned for imageId",
                "imageId": image_id,
                "hint": "This can happen for protected items or when image lookup behavior changes upstream.",
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

    page_url = (request.query.get("page_url", "") or "").strip()
    if page_url and not _is_allowed_page_url(page_url):
        return web.json_response({"error": "page_url host not allowed"}, status=400)

    try:
        img_bytes, content_type = await fetch_bytes_authed(
            raw_url,
            api_key,
            timeout_s=60,
            referer_url=page_url,
        )
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
    "LocalImageInfoNode": LocalImageInfoNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CivitaiGalleryNode": "CivitAI Gallery",
    "CivitaiPromptEditorNode": "CivitAI Prompt Editor",
    "CivitaiInfoDisplayNode": "CivitAI Info Display",
    "CivitaiImagePreviewNode": "CivitAI Image Preview",
    "LocalImageInfoNode": "CivitAI Local Image Info",
}
