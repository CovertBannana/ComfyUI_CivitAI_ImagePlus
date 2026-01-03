
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[CivitAI Gallery] frontend script loaded");

const STORAGE_KEY = "civitai_gallery_simple_v1";
let currentAbort = null;

// cursor paging state
let nextCursor = null;
let nextPageUrl = null;
let seenIds = new Set();

// ---------------- Clipboard helper ----------------
async function copyText(text) {
  const t = (text || "").toString().trim();
  if (!t) return false;

  // Modern clipboard
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {}

  // Fallback (works on many HTTP/LAN contexts)
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {}

  // Last resort
  try {
    window.prompt("Copy to clipboard (Ctrl+C, Enter):", t);
    return true;
  } catch {}

  return false;
}

// ---------------- Simple modal editor ----------------
function openModalEditor({ title, value, onSave }) {
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.7)";
  overlay.style.zIndex = "20000";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.padding = "24px";

  const panel = document.createElement("div");
  panel.style.width = "min(1000px, 92vw)";
  panel.style.height = "min(700px, 82vh)";
  panel.style.background = "#1f1f1f";
  panel.style.border = "1px solid #444";
  panel.style.borderRadius = "10px";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.overflow = "hidden";
  panel.style.boxShadow = "0 10px 40px rgba(0,0,0,0.6)";

  const header = document.createElement("div");
  header.style.padding = "12px 14px";
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "12px";
  header.style.borderBottom = "1px solid #333";
  header.style.background = "#242424";

  const hTitle = document.createElement("div");
  hTitle.textContent = title || "Edit";
  hTitle.style.color = "#eee";
  hTitle.style.fontSize = "14px";
  hTitle.style.fontWeight = "600";
  hTitle.style.flex = "1";

  const mkBtn = (label) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.background = "#3a3a3a";
    b.style.border = "1px solid #666";
    b.style.color = "#eee";
    b.style.padding = "8px 12px";
    b.style.borderRadius = "6px";
    b.style.cursor = "pointer";
    return b;
  };

  const saveBtn = mkBtn("Save");
  const cancelBtn = mkBtn("Cancel");

  header.append(hTitle, cancelBtn, saveBtn);

  const body = document.createElement("div");
  body.style.padding = "12px";
  body.style.flex = "1";
  body.style.display = "flex";

  const ta = document.createElement("textarea");
  ta.value = value || "";
  ta.style.flex = "1";
  ta.style.width = "100%";
  ta.style.height = "100%";
  ta.style.resize = "none";
  ta.style.background = "#111";
  ta.style.color = "#ddd";
  ta.style.border = "1px solid #333";
  ta.style.borderRadius = "8px";
  ta.style.padding = "10px";
  ta.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ta.style.fontSize = "12px";
  ta.style.lineHeight = "1.35";
  ta.spellcheck = false;

  body.appendChild(ta);
  panel.append(header, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  cancelBtn.onclick = () => close();
  saveBtn.onclick = () => {
    try {
      onSave?.(ta.value);
    } finally {
      close();
    }
  };

  setTimeout(() => ta.focus(), 50);
}

// ---------------- UI helpers ----------------
function stylizeButton(btn) {
  btn.style.background = "#3a3a3a";
  btn.style.border = "1px solid #666";
  btn.style.color = "#eee";
  btn.style.padding = "8px 12px";
  btn.style.borderRadius = "6px";
  btn.style.cursor = "pointer";
}

function makeSelect(label, options, defValue) {
  const c = document.createElement("label");
  c.style.display = "flex";
  c.style.flexDirection = "column";
  c.style.gap = "4px";
  c.style.fontSize = "12px";

  const s = document.createElement("span");
  s.textContent = label;
  s.style.opacity = ".8";

  const sel = document.createElement("select");
  sel.style.background = "#2a2a2a";
  sel.style.border = "1px solid #555";
  sel.style.color = "#ddd";
  sel.style.padding = "6px 8px";
  sel.style.borderRadius = "6px";

  options.forEach(([t, v]) => {
    const o = document.createElement("option");
    o.textContent = t;
    o.value = v;
    sel.appendChild(o);
  });

  sel.value = defValue;
  c.append(s, sel);
  return { container: c, select: sel };
}

function makeInput(label, defValue, type = "text", attrs = {}) {
  const c = document.createElement("label");
  c.style.display = "flex";
  c.style.flexDirection = "column";
  c.style.gap = "4px";
  c.style.fontSize = "12px";

  const s = document.createElement("span");
  s.textContent = label;
  s.style.opacity = ".8";

  const i = document.createElement("input");
  i.type = type;
  i.value = defValue;
  i.style.background = "#2a2a2a";
  i.style.border = "1px solid #555";
  i.style.color = "#ddd";
  i.style.padding = "6px 8px";
  i.style.borderRadius = "6px";

  Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
  c.append(s, i);
  return { container: c, input: i };
}

// ---------------- Node detection ----------------
function isGalleryNode(node) {
  const title = String(node?.title || node?.comfyClass || "").toLowerCase();
  return node?.comfyClass === "CivitaiGalleryNode" || title.includes("civitai gallery");
}
function isPromptEditorNode(node) {
  const title = String(node?.title || node?.comfyClass || "").toLowerCase();
  return node?.comfyClass === "CivitaiPromptEditorNode" || title.includes("civitai prompt editor");
}
function isInfoNode(node) {
  const title = String(node?.title || node?.comfyClass || "").toLowerCase();
  return node?.comfyClass === "CivitaiInfoDisplayNode" || title.includes("civitai info display");
}
function isPreviewNode(node) {
  const title = String(node?.title || node?.comfyClass || "").toLowerCase();
  return node?.comfyClass === "CivitaiImagePreviewNode" || title.includes("civitai image preview");
}

// ---------------- Data helpers ----------------
function normalizeItemForSelection(item) {
  const url = item?.url || item?.imageUrl || item?.src || "";
  let meta = item?.meta ?? {};
  let id = item?.id ?? null;
  let postId = item?.postId ?? null;

  if (meta && typeof meta === "object" && meta.meta && typeof meta.meta === "object") {
    if (id == null && typeof meta.id !== "undefined") id = meta.id;
    meta = meta.meta;
  }

  if (id != null) id = String(id);
  if (postId != null) postId = String(postId);

  return { url, meta: meta || {}, id, postId };
}

function extractPrompts(meta) {
  if (!meta || typeof meta !== "object") return { positive: "", negative: "" };
  const positive =
    meta.prompt ||
    meta.positivePrompt ||
    meta.positive ||
    (meta.parameters && meta.parameters.prompt) ||
    "";
  const negative =
    meta.negativePrompt ||
    meta.negative ||
    (meta.parameters && meta.parameters.negative) ||
    "";
  return { positive: positive || "", negative: negative || "" };
}

function buildPageUrl(imageId, postId) {
  if (imageId) return `https://civitai.com/images/${imageId}`;
  if (postId) return `https://civitai.com/posts/${postId}`;
  return "";
}

function modelNameFromMeta(meta) {
  try {
    const res = meta?.resources;
    if (Array.isArray(res) && res.length) return res[0]?.name || "";
  } catch {}
  return "";
}

async function postJSON(path, payload) {
  const res = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

// ---------------- Text wrapping drawing helpers ----------------
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const raw = (text || "").toString();
  const words = raw.length ? raw.split(/\s+/g) : [""];
  let line = "";
  let lines = 0;

  for (let i = 0; i < words.length; i++) {
    const test = line ? line + " " + words[i] : words[i];
    const w = ctx.measureText(test).width;

    if (w > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines++;
      line = words[i];
      if (maxLines && lines >= maxLines) {
        ctx.fillText("…", x, y + lines * lineHeight);
        return lines + 1;
      }
    } else {
      line = test;
    }
  }

  if (line) {
    ctx.fillText(line, x, y + lines * lineHeight);
    lines++;
  }

  return lines;
}

function drawPanel(ctx, x, y, w, h, title, text) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.strokeRect(x, y, w, h);

  ctx.fillStyle = "#bbb";
  ctx.font = "12px sans-serif";
  ctx.fillText(title, x + 8, y + 16);

  ctx.fillStyle = "#ddd";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  const tx = x + 8;
  const ty = y + 34;
  const maxWidth = w - 16;
  const lineHeight = 14;
  const maxLines = Math.floor((h - 40) / lineHeight);

  drawWrappedText(ctx, text || "", tx, ty, maxWidth, lineHeight, maxLines);
  ctx.restore();
}

// ---------------- Support node state setters ----------------
async function setPromptEditor(node, positive, negative) {
  node.__civitaiPositive = positive || "";
  node.__civitaiNegative = negative || "";
  node.__civitaiOriginalPrompts = {
    positive: node.__civitaiPositive,
    negative: node.__civitaiNegative,
  };

  node.graph?.setDirtyCanvas(true, true);

  await postJSON("/civitai_gallery/set_prompt", {
    node_id: String(node.id),
    positive: node.__civitaiPositive,
    negative: node.__civitaiNegative,
  });
}

function setInfoNode(node, text, pageUrl) {
  node.__civitaiInfoText = text || "";
  node.__civitaiPageUrl = pageUrl || "";
  node.graph?.setDirtyCanvas(true, true);
}

async function setPreviewNode(node, srcUrl, pageUrl) {
  node.__civitaiPageUrl = pageUrl || "";
  node.__civitaiSourceUrl = srcUrl || "";

  await postJSON("/civitai_gallery/set_preview", {
    node_id: String(node.id),
    url: node.__civitaiSourceUrl,
  });

  const proxyUrl = `/civitai_gallery/proxy_image?url=${encodeURIComponent(node.__civitaiSourceUrl)}`;
  node.__civitaiThumbUrl = proxyUrl;

  if (!node.__civitaiThumbImg) {
    node.__civitaiThumbImg = new Image();
    node.__civitaiThumbImg.onload = () => node.graph?.setDirtyCanvas(true, true);
    node.__civitaiThumbImg.onerror = () => node.graph?.setDirtyCanvas(true, true);
  }
  node.__civitaiThumbImg.src = proxyUrl;

  node.graph?.setDirtyCanvas(true, true);
}

// ---------------- Apply selection pipeline ----------------
async function updateSupportNodes(normalized) {
  const graph = app?.graph;
  if (!graph || !Array.isArray(graph._nodes)) return;

  const prompts = extractPrompts(normalized.meta);
  const model = modelNameFromMeta(normalized.meta);
  const page = buildPageUrl(normalized.id, normalized.postId);

  const infoText =
    `CivitAI Page: ${page}` +
    (model ? `\nModel: ${model}` : "") +
    (normalized.meta?.steps ? `\nSteps: ${normalized.meta.steps}` : "") +
    (normalized.meta?.cfgScale ? `\nCFG: ${normalized.meta.cfgScale}` : "");

  for (const n of graph._nodes) {
    if (isPromptEditorNode(n)) await setPromptEditor(n, prompts.positive, prompts.negative);
  }
  for (const n of graph._nodes) {
    if (isInfoNode(n)) setInfoNode(n, infoText, page);
  }
  for (const n of graph._nodes) {
    if (isPreviewNode(n)) await setPreviewNode(n, normalized.url, page);
  }
}

function applySelection(galleryNode, item) {
  const normalized = normalizeItemForSelection(item);

  const payload = JSON.stringify({
    item: {
      url: normalized.url,
      meta: normalized.meta,
      id: normalized.id,
      postId: normalized.postId,
    },
  });

  const widget = galleryNode.widgets?.find((w) => w.name === "selection_data");
  if (widget) {
    try {
      widget.value = payload;
      widget.callback?.(payload);
    } catch {}
  }

  galleryNode.graph?.setDirtyCanvas(true, true);
  galleryNode.flags = galleryNode.flags || {};
  galleryNode.flags.dirty = true;

  updateSupportNodes(normalized);
}

// ---------------- Gallery overlay ----------------
function closeFullGallery() {
  const el = document.getElementById("civitai-full-overlay");
  if (el) el.remove();
}

function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { sort: "Most Reactions", period: "AllTime", limit: 36, nsfw: "None" };
}

function cursorFromNextPage(url) {
  try {
    if (!url) return null;
    const u = new URL(url);
    const c = u.searchParams.get("cursor");
    return c ? String(c) : null;
  } catch {
    return null;
  }
}

async function fetchPage(node, grid, settings, cursor, append = false) {
  if (!append && currentAbort) currentAbort.abort();
  currentAbort = new AbortController();

  if (!append) {
    grid.innerHTML = "";
    const spinner = document.createElement("div");
    spinner.textContent = "Loading…";
    spinner.style.color = "#bbb";
    spinner.style.fontSize = "12px";
    spinner.style.padding = "8px";
    grid.appendChild(spinner);
    nextCursor = null;
    nextPageUrl = null;
    seenIds = new Set();
  }

  const params = new URLSearchParams();
  params.set("sort", settings.sort);
  params.set("period", settings.period);
  params.set("limit", String(settings.limit ?? 36));
  params.set("nsfw", settings.nsfw);
  if (cursor != null) params.set("cursor", String(cursor));

  try {
    const res = await api.fetchApi(`/civitai_gallery/images?${params.toString()}`, {
      signal: currentAbort.signal,
    });
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const meta = data.metadata || {};

    nextCursor = meta.nextCursor ?? null;
    nextPageUrl = meta.nextPage ?? null;

    if (!append) grid.innerHTML = "";

    const frag = document.createDocumentFragment();

    for (const item of items) {
      const itemId = item?.id != null ? String(item.id) : null;
      if (itemId && seenIds.has(itemId)) continue;
      if (itemId) seenIds.add(itemId);
      if (!item.url) continue;

      const card = document.createElement("div");
      card.style.display = "flex";
      card.style.flexDirection = "column";
      card.style.gap = "6px";

      const img = document.createElement("img");
      img.src = item.url;
      img.loading = "lazy";
      img.style.width = "100%";
      img.style.borderRadius = "6px";
      img.style.cursor = "pointer";

      img.onclick = (e) => {
        e.stopPropagation();
        applySelection(node, item);
        closeFullGallery();
      };

      card.append(img);
      frag.appendChild(card);
    }

    grid.appendChild(frag);

    const derivedCursor = cursorFromNextPage(nextPageUrl);
    const hasMore = nextCursor != null || derivedCursor != null;
    return { hasMore };
  } catch (err) {
    if (err?.name === "AbortError") return { hasMore: false };
    return { hasMore: false };
  }
}

async function openFullGallery(node) {
  if (document.getElementById("civitai-full-overlay")) return;

  const settings = loadSettings();

  const overlay = document.createElement("div");
  overlay.id = "civitai-full-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.85)",
    zIndex: "10000",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    color: "#ddd",
    fontFamily: "system-ui, sans-serif",
  });

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    padding: "12px 16px",
    background: "#1f1f1f",
    borderBottom: "1px solid #444",
  });

  const sortSel = makeSelect(
    "Sort",
    [
      ["Most Reactions", "Most Reactions"],
      ["Most Comments", "Most Comments"],
      ["Newest", "Newest"],
    ],
    settings.sort
  );

  const periodSel = makeSelect(
    "Period",
    [
      ["AllTime", "AllTime"],
      ["Month", "Month"],
      ["Week", "Week"],
      ["Day", "Day"],
    ],
    settings.period
  );

  const limitInput = makeInput("Limit", String(settings.limit ?? 36), "number", {
    min: "12",
    max: "200",
  });

  const nsfwSel = makeSelect(
    "NSFW",
    [
      ["None", "None"],
      ["Soft", "Soft"],
      ["Mature", "Mature"],
      ["X", "X"],
    ],
    settings.nsfw
  );

  const searchBtn = document.createElement("button");
  searchBtn.textContent = "Search";
  stylizeButton(searchBtn);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  stylizeButton(closeBtn);
  closeBtn.style.marginLeft = "auto";

  header.append(
    sortSel.container,
    periodSel.container,
    limitInput.container,
    nsfwSel.container,
    searchBtn,
    closeBtn
  );

  const gridWrap = document.createElement("div");
  Object.assign(gridWrap.style, { padding: "16px", overflow: "auto" });

  const grid = document.createElement("div");
  Object.assign(grid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "12px",
    alignItems: "start",
  });

  gridWrap.appendChild(grid);

  const footer = document.createElement("div");
  Object.assign(footer.style, {
    display: "flex",
    gap: "12px",
    padding: "12px 16px",
    borderTop: "1px solid #444",
    background: "#1f1f1f",
    alignItems: "center",
  });

  const loadMoreBtn = document.createElement("button");
  loadMoreBtn.textContent = "Load more";
  stylizeButton(loadMoreBtn);

  const pagingHint = document.createElement("span");
  pagingHint.style.color = "#aaa";
  pagingHint.style.fontSize = "12px";

  footer.append(loadMoreBtn, pagingHint);
  overlay.append(header, gridWrap, footer);
  document.body.appendChild(overlay);

  const s0 = {
    sort: sortSel.select.value,
    period: periodSel.select.value,
    limit: parseInt(limitInput.input.value || "36", 10),
    nsfw: nsfwSel.select.value,
  };
  saveSettings(s0);

  const r0 = await fetchPage(node, grid, s0, 0, false);
  loadMoreBtn.disabled = !r0.hasMore;

  searchBtn.onclick = async () => {
    const s2 = {
      sort: sortSel.select.value,
      period: periodSel.select.value,
      limit: parseInt(limitInput.input.value || "36", 10),
      nsfw: nsfwSel.select.value,
    };
    saveSettings(s2);
    const r = await fetchPage(node, grid, s2, 0, false);
    loadMoreBtn.disabled = !r.hasMore;
  };

  loadMoreBtn.onclick = async () => {
    const s = {
      sort: sortSel.select.value,
      period: periodSel.select.value,
      limit: parseInt(limitInput.input.value || "36", 10),
      nsfw: nsfwSel.select.value,
    };
    saveSettings(s);

    let cursor = nextCursor;
    if (cursor == null) cursor = cursorFromNextPage(nextPageUrl);
    if (cursor == null) {
      loadMoreBtn.disabled = true;
      return;
    }

    const r = await fetchPage(node, grid, s, cursor, true);
    loadMoreBtn.disabled = !r.hasMore;
  };

  closeBtn.onclick = () => closeFullGallery();
  overlay.onclick = (e) => {
    if (e.target === overlay) closeFullGallery();
  };
}

// ---------------- Fetch URL button ----------------
async function fetchAndApplyUrl(node, url) {
  const trimmed = (url || "").trim();
  if (!trimmed) {
    alert("Please paste a CivitAI /posts/<id> URL (recommended), or /images/<id> (best-effort).");
    return;
  }

  try {
    const res = await api.fetchApi(`/civitai_gallery/image_by_url?url=${encodeURIComponent(trimmed)}`);
    const data = await res.json();

    if (data?.error) {
      const msg = [
        "Fetch failed.",
        data.error,
        data.status ? `Status: ${data.status}` : "",
        data.details ? `Details: ${String(data.details).slice(0, 400)}` : "",
        data.hint ? `Hint: ${data.hint}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      alert(msg);
      return;
    }

    const item = data?.item;
    if (!item || !item.url) {
      alert("Could not resolve an image from that URL.");
      return;
    }

    applySelection(node, item);
  } catch (e) {
    console.warn("[CivitAI Gallery] node fetch URL failed", e);
    alert("Failed to fetch image from the provided URL.");
  }
}

// ---------------- Register extension ----------------
app.registerExtension({
  name: "CivitaiGallery.Extension.Register",
  nodeCreated(node) {
    // Gallery node buttons
    if (isGalleryNode(node)) {
      if (node.__civitaiButtonsAdded) return;
      node.__civitaiButtonsAdded = true;

      node.addWidget("button", "Open Gallery", null, () => openFullGallery(node));
      const urlWidget = node.addWidget("string", "Fetch URL", "", () => {});
      node.addWidget("button", "Fetch", null, async () => {
        await fetchAndApplyUrl(node, urlWidget?.value || "");
      });
      return;
    }

    // Prompt Editor: bottom button bar (canvas), no widget buttons
    if (isPromptEditorNode(node)) {
      if (node.__civitaiPromptHooked) return;
      node.__civitaiPromptHooked = true;

      node.size = node.size || [560, 520];
      node.size[0] = Math.max(node.size[0], 560);
      node.size[1] = Math.max(node.size[1], 520);

      const syncPromptStore = async () => {
        await postJSON("/civitai_gallery/set_prompt", {
          node_id: String(node.id),
          positive: node.__civitaiPositive || "",
          negative: node.__civitaiNegative || "",
        });
      };

      const editPositive = () => {
        openModalEditor({
          title: "Edit Positive Prompt",
          value: node.__civitaiPositive || "",
          onSave: async (val) => {
            node.__civitaiPositive = val || "";
            node.graph?.setDirtyCanvas(true, true);
            await syncPromptStore();
          },
        });
      };

      const editNegative = () => {
        openModalEditor({
          title: "Edit Negative Prompt",
          value: node.__civitaiNegative || "",
          onSave: async (val) => {
            node.__civitaiNegative = val || "";
            node.graph?.setDirtyCanvas(true, true);
            await syncPromptStore();
          },
        });
      };

      const restoreOriginal = async () => {
        const orig = node.__civitaiOriginalPrompts;
        if (!orig) return;
        node.__civitaiPositive = orig.positive || "";
        node.__civitaiNegative = orig.negative || "";
        node.graph?.setDirtyCanvas(true, true);
        await syncPromptStore();
      };

      const clearBoth = async () => {
        node.__civitaiPositive = "";
        node.__civitaiNegative = "";
        node.graph?.setDirtyCanvas(true, true);
        await syncPromptStore();
      };

      function drawBottomButtons(ctx, pad, y, w, h) {
        const gap = 8;
        const labels = ["Edit Positive", "Edit Negative", "Restore", "Clear"];
        const actions = [editPositive, editNegative, restoreOriginal, clearBoth];

        const btnW = Math.floor((w - gap * (labels.length - 1)) / labels.length);
        const btnH = h;

        node.__civitaiBtnRects = [];

        for (let i = 0; i < labels.length; i++) {
          const x = pad + i * (btnW + gap);

          ctx.save();
          ctx.fillStyle = "rgba(58,58,58,0.95)";
          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.fillRect(x, y, btnW, btnH);
          ctx.strokeRect(x, y, btnW, btnH);

          ctx.fillStyle = "#eee";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(labels[i], x + btnW / 2, y + btnH / 2);
          ctx.restore();

          node.__civitaiBtnRects.push({ x, y, w: btnW, h: btnH, action: actions[i] });
        }
      }

      const oldMouseDown = node.onMouseDown?.bind(node);
      node.onMouseDown = function (e, localPos, graphcanvas) {
        const r = this.__civitaiBtnRects;
        if (Array.isArray(r) && localPos) {
          const mx = localPos[0];
          const my = localPos[1];
          for (const b of r) {
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
              try {
                b.action?.();
              } catch {}
              return true; // swallow click
            }
          }
        }
        return oldMouseDown ? oldMouseDown(e, localPos, graphcanvas) : false;
      };

      const oldDraw = node.onDrawForeground?.bind(node);
      node.onDrawForeground = function (ctx) {
        oldDraw?.(ctx);

        const pad = 10;
        const top = 40;
        const bottomBarH = 34;
        const gapBetween = 10;

        const contentW = this.size[0] - pad * 2;
        const contentH = this.size[1] - top - pad - bottomBarH - gapBetween;

        const halfH = Math.max(80, Math.floor((contentH - gapBetween) / 2));

        drawPanel(ctx, pad, top, contentW, halfH, "Positive (preview)", this.__civitaiPositive || "");
        drawPanel(
          ctx,
          pad,
          top + halfH + gapBetween,
          contentW,
          contentH - halfH - gapBetween,
          "Negative (preview)",
          this.__civitaiNegative || ""
        );

        const btnY = this.size[1] - pad - bottomBarH;
        drawBottomButtons(ctx, pad, btnY, contentW, bottomBarH);
      };

      return;
    }

    // Info node: small + readable preview
    if (isInfoNode(node)) {
      if (node.__civitaiInfoHooked) return;
      node.__civitaiInfoHooked = true;

      node.size = node.size || [520, 220];
      node.size[0] = Math.max(node.size[0], 520);
      node.size[1] = Math.max(node.size[1], 220);

      const oldDraw = node.onDrawForeground?.bind(node);
      node.onDrawForeground = function (ctx) {
        oldDraw?.(ctx);

        const pad = 10;
        const top = 52;
        const w = this.size[0] - pad * 2;
        const h = this.size[1] - top - pad;

        drawPanel(ctx, pad, top, w, h, "Info (preview)", this.__civitaiInfoText || "");
      };

      return;
    }

    // Preview node (thumbnail + copy button)
    if (isPreviewNode(node)) {
      if (node.__civitaiPreviewHooked) return;
      node.__civitaiPreviewHooked = true;

      node.addWidget("button", "Copy CivitAI Page URL", null, async () => {
        const page = (node.__civitaiPageUrl || "").toString().trim();
        const fallback = (node.__civitaiSourceUrl || "").toString().trim();
        await copyText(page || fallback);
      });

      node.size = node.size || [320, 420];
      node.size[0] = Math.max(node.size[0], 320);
      node.size[1] = Math.max(node.size[1], 420);

      const oldDraw = node.onDrawForeground?.bind(node);
      node.onDrawForeground = function (ctx) {
        oldDraw?.(ctx);

        const img = this.__civitaiThumbImg;
        if (!img || !img.complete || img.naturalWidth <= 0) {
          ctx.save();
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(10, 60, this.size[0] - 20, this.size[1] - 80);
          ctx.fillStyle = "#bbb";
          ctx.font = "12px sans-serif";
          ctx.fillText("No preview loaded (select an image)", 16, 80);
          ctx.restore();
          return;
        }

        const pad = 10;
        const top = 60;
        const w = this.size[0] - pad * 2;
        const h = this.size[1] - top - pad;

        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const scale = Math.min(w / iw, h / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        const dx = pad + (w - dw) / 2;
        const dy = top + (h - dh) / 2;

        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(pad, top, w, h);
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
      };

      return;
    }
  },
});

console.log("[CivitAI Gallery] extension registered");
