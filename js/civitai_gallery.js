import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[CivitAI Gallery] frontend script loaded");

const STORAGE_KEY = "civitai_gallery_simple_v2";

const PAGE_BASES = {
  com: "https://civitai.com",
  red: "https://civitai.red",
};

let currentAbort = null;

// cursor paging state
let nextCursor = null;
let nextPageUrl = null;
let seenIds = new Set();

function normalizePageDomain(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "com" || v === "red" || v === "auto") return v;
  return "auto";
}

function pageBaseFromSetting(value) {
  const v = normalizePageDomain(value);
  if (v === "com" || v === "red") return PAGE_BASES[v];
  return "";
}

function pageBaseFromUrl(raw) {
  try {
    if (!raw) return "";
    const u = new URL(String(raw));
    const host = (u.hostname || "").toLowerCase();
    if (
      host === "civitai.com" ||
      host === "www.civitai.com" ||
      host === "civitai.red" ||
      host === "www.civitai.red"
    ) {
      return `${u.protocol}//${u.host}`;
    }
  } catch {}
  return "";
}

function buildProxyImageUrl(srcUrl, pageUrl = "") {
  const proxy = new URL("/civitai_gallery/proxy_image", window.location.origin);
  proxy.searchParams.set("url", srcUrl ?? "");
  if (pageUrl) proxy.searchParams.set("page_url", pageUrl);
  return proxy.toString();
}

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
function isLocalImageInfoNode(node) {
  const title = String(node?.title || node?.comfyClass || "").toLowerCase();
  return node?.comfyClass === "LocalImageInfoNode" || title.includes("local image info");
}

// ---------------- Data helpers ----------------
function normalizeItemForSelection(item) {
  const url = item?.url ?? item?.imageUrl ?? item?.src ?? "";
  let meta = item?.meta ?? {};
  let id = item?.id ?? null;
  let postId = item?.postId ?? null;

  if (meta && typeof meta === "object" && meta.meta && typeof meta.meta === "object") {
    if (id == null && typeof meta.id !== "undefined") id = meta.id;
    meta = meta.meta;
  }

  if (id != null) id = String(id);
  if (postId != null) postId = String(postId);

  return {
    url,
    meta: meta ?? {},
    id,
    postId,
    pageUrl: item?.pageUrl ?? item?.page_url ?? "",
    sourcePageUrl: item?.sourcePageUrl ?? item?.source_page_url ?? "",
    pageDomain: item?.pageDomain ?? item?.page_domain ?? "",
  };
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

function buildPageUrl(imageId, postId, options = {}) {
  const settings = loadSettings();
  const pageDomain = normalizePageDomain(options.pageDomain ?? settings.pageDomain ?? "auto");

  const forcedBase = pageBaseFromSetting(pageDomain);
  const explicitBase = pageBaseFromUrl(options.explicitPageUrl);
  const sourceBase = pageBaseFromUrl(options.sourcePageUrl);

  const base = forcedBase || explicitBase || sourceBase || PAGE_BASES.com;

  if (imageId) return `${base}/images/${imageId}`;
  if (postId) return `${base}/posts/${postId}`;
  return "";
}

function modelNameFromMeta(meta) {
  try {
    if (!meta) return "";

    // 1. Check common direct top-level strings first
    const directModel = meta["Model type"] || meta["Model"] || meta["model"] || meta["ecosystem"];
    if (directModel && typeof directModel === "string") {
      return directModel.trim();
    }

    // 2. Check the standard resources array if it has items
    const res = meta?.resources;
    if (Array.isArray(res) && res.length) {
      for (const r of res) {
        const type = String(r?.type ?? "").trim().toLowerCase();
        const name = String(r?.name ?? "").trim();
        if (name && type !== "lora" && type !== "textualinversion" && type !== "embeddings") {
          return name;
        }
      }

      const firstType = String(res[0]?.type ?? "").trim().toLowerCase();
      if (firstType !== "lora" && firstType !== "textualinversion" && firstType !== "embeddings") {
        return String(res[0]?.name ?? "").trim();
      }
    }
  } catch {}
  return "";
}

function loraNamesFromMeta(meta) {
  try {
    const res = meta?.resources;
    if (!Array.isArray(res)) return [];

    const names = [];
    const seen = new Set();

    for (const r of res) {
      const type = String(r?.type ?? "").trim().toLowerCase();
      const name = String(r?.name ?? "").trim();
      if (!name || type !== "lora") continue;

      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
    }

    return names;
  } catch {}
  return [];
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
  node.__civitaiPageUrl = pageUrl ?? "";
  node.__civitaiSourceUrl = srcUrl ?? "";

  const isLocalObjectUrl =
    typeof srcUrl === "string" &&
    (srcUrl.startsWith("blob:") || srcUrl.startsWith("data:"));

  if (!isLocalObjectUrl) {
    await postJSON("/civitai_gallery/set_preview", {
      node_id: String(node.id),
      url: node.__civitaiSourceUrl,
      page_url: node.__civitaiPageUrl,
    });
  }

  const previewUrl = isLocalObjectUrl
    ? srcUrl
    : buildProxyImageUrl(node.__civitaiSourceUrl, node.__civitaiPageUrl);

  node.__civitaiThumbUrl = previewUrl;

  if (!node.__civitaiThumbImg) {
    node.__civitaiThumbImg = new Image();
    node.__civitaiThumbImg.onload = () => node.graph?.setDirtyCanvas(true, true);
    node.__civitaiThumbImg.onerror = () => node.graph?.setDirtyCanvas(true, true);
  }

  node.__civitaiThumbImg.src = previewUrl;
  node.graph?.setDirtyCanvas(true, true);
}

// ---------------- Apply selection pipeline ----------------
async function updateSupportNodes(normalized) {
  const graph = app?.graph;
  if (!graph || !Array.isArray(graph._nodes)) return;
  const prompts = extractPrompts(normalized.meta);
  const model = modelNameFromMeta(normalized.meta);
  const page = buildPageUrl(normalized.id, normalized.postId, {
    explicitPageUrl: normalized.pageUrl,
    sourcePageUrl: normalized.sourcePageUrl,
    pageDomain: normalized.pageDomain,
  });

  const sampler = normalized.meta?.sampler || normalized.meta?.Sampler || "";
  const scheduler = normalized.meta?.scheduler || normalized.meta?.Scheduler || "";

let infoText = normalized.infoText || "";

if (!infoText) {
  infoText =
    `CivitAI Page: ${page}` +
    (model ? `\nModel: ${model}` : "") +
    (normalized.meta?.steps ? `\nSteps: ${normalized.meta.steps}` : "") +
    (normalized.meta?.cfgScale ? `\nCFG: ${normalized.meta.cfgScale}` : "");

  if (sampler) infoText += `\nSampler: ${sampler}`;
  if (scheduler) infoText += `\nScheduler: ${scheduler}`;
}

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
  const selectedPageDomain = normalized.pageDomain || loadSettings().pageDomain || "auto";

  const payload = JSON.stringify({
    item: {
      url: normalized.url,
      meta: normalized.meta,
      id: normalized.id,
      postId: normalized.postId,
      pageUrl: normalized.pageUrl,
      sourcePageUrl: normalized.sourcePageUrl,
      pageDomain: selectedPageDomain,
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

  updateSupportNodes({
    ...normalized,
    pageDomain: selectedPageDomain,
  });
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
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        sort: parsed.sort ?? "Most Reactions",
        period: parsed.period ?? "AllTime",
        limit: parsed.limit ?? 36,
        nsfw: parsed.nsfw ?? "None",
        pageDomain: normalizePageDomain(parsed.pageDomain ?? "auto"),
      };
    }
  } catch {}
  return {
    sort: "Most Reactions",
    period: "AllTime",
    limit: 36,
    nsfw: "None",
    pageDomain: "auto",
  };
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

      const selectedPageDomain = settings.pageDomain || "auto";
      const normalized = normalizeItemForSelection({
        ...item,
        pageDomain: item?.pageDomain ?? selectedPageDomain,
      });
      const pageUrl = buildPageUrl(normalized.id, normalized.postId, {
        explicitPageUrl: normalized.pageUrl,
        sourcePageUrl: normalized.sourcePageUrl,
        pageDomain: normalized.pageDomain,
      });

      const card = document.createElement("div");
      card.style.display = "flex";
      card.style.flexDirection = "column";
      card.style.gap = "6px";

      const img = document.createElement("img");
      img.src = buildProxyImageUrl(item.url, pageUrl);
      img.loading = "lazy";
      img.style.width = "100%";
      img.style.borderRadius = "6px";
      img.style.cursor = "pointer";

      img.onclick = (e) => {
        e.stopPropagation();
        applySelection(node, {
          ...item,
          pageDomain: normalized.pageDomain,
          pageUrl,
        });
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

  const pageDomainSel = makeSelect(
    "Page Links",
    [
      ["Auto", "auto"],
      ["Civitai.com", "com"],
      ["Civitai.red", "red"],
    ],
    settings.pageDomain ?? "auto"
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
    pageDomainSel.container,
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
    pageDomain: pageDomainSel.select.value,
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
      pageDomain: pageDomainSel.select.value,
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
      pageDomain: pageDomainSel.select.value,
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

    try {
      item.sourcePageUrl = trimmed;
      if (!item.pageUrl) item.pageUrl = trimmed;
    } catch {}

    applySelection(node, item);
  } catch (e) {
    console.warn("[CivitAI Gallery] node fetch URL failed", e);
    alert("Failed to fetch image from the provided URL.");
  }
}

async function openLocalImagePicker(node) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/*";
  input.style.display = "none";

  input.onchange = async () => {
    const file = input.files?.[0];
    input.remove();

    if (!file) return;

    await handleLocalImageFile(node, file);
  };

  document.body.appendChild(input);
  input.click();
}

function getCanvasPosFromDragEvent(e) {
  try {
    const canvas = app?.canvas;
    if (!canvas) return null;

    // LiteGraph/Comfy commonly exposes this helper.
    if (typeof canvas.convertEventToCanvasOffset === "function") {
      return canvas.convertEventToCanvasOffset(e);
    }

    // Fallback calculation.
    const rect = canvas.canvas?.getBoundingClientRect?.();
    if (!rect) return null;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const ds = canvas.ds;
    if (ds && Array.isArray(ds.offset)) {
      return [
        x / ds.scale - ds.offset[0],
        y / ds.scale - ds.offset[1],
      ];
    }

    return [x, y];
  } catch {
    return null;
  }
}

function findLocalImageInfoNodeAtEvent(e) {
  const graph = app?.graph;
  if (!graph || !Array.isArray(graph._nodes)) return null;

  const pos = getCanvasPosFromDragEvent(e);
  if (!pos) return null;

  const [x, y] = pos;

  // Walk backwards so top-most nodes win.
  for (let i = graph._nodes.length - 1; i >= 0; i--) {
    const n = graph._nodes[i];
    if (!isLocalImageInfoNode(n)) continue;

    const nx = n.pos?.[0] ?? 0;
    const ny = n.pos?.[1] ?? 0;
    const nw = n.size?.[0] ?? 0;
    const nh = n.size?.[1] ?? 0;

    if (x >= nx && x <= nx + nw && y >= ny && y <= ny + nh) {
      return n;
    }
  }

  return null;
}

function installLocalImageDropGuard() {
  if (window.__localImageInfoDropGuardInstalled) return;
  window.__localImageInfoDropGuardInstalled = true;

  const hasImageFile = (e) => {
    const items = Array.from(e.dataTransfer?.items || []);
    return items.some((item) => item.kind === "file" && item.type?.startsWith("image/"));
  };

  document.addEventListener(
    "dragover",
    (e) => {
      const node = findLocalImageInfoNodeAtEvent(e);
      if (!node || !hasImageFile(e)) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      e.dataTransfer.dropEffect = "copy";

      node.__localImageInfoDragOver = true;
      node.graph?.setDirtyCanvas(true, true);
    },
    true
  );

  document.addEventListener(
    "dragleave",
    (e) => {
      const graph = app?.graph;
      if (!graph || !Array.isArray(graph._nodes)) return;

      for (const n of graph._nodes) {
        if (isLocalImageInfoNode(n) && n.__localImageInfoDragOver) {
          n.__localImageInfoDragOver = false;
          n.graph?.setDirtyCanvas(true, true);
        }
      }
    },
    true
  );

  document.addEventListener(
    "drop",
    async (e) => {
      const node = findLocalImageInfoNodeAtEvent(e);
      if (!node || !hasImageFile(e)) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      node.__localImageInfoDragOver = false;

      const files = Array.from(e.dataTransfer?.files || []);
      const file = files.find((f) => f.type?.startsWith("image/"));

      if (file) {
        await handleLocalImageFile(node, file);
      }

      node.graph?.setDirtyCanvas(true, true);
    },
    true
  );
}

installLocalImageDropGuard();

// ---------------- Local Image Info helpers ----------------

async function readFileAsArrayBuffer(file) {
  return await file.arrayBuffer();
}

function decodeLatin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
}

function readUint32BE(view, offset) {
  return view.getUint32(offset, false);
}

function parsePngMetadata(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];

  for (let i = 0; i < pngSig.length; i++) {
    if (bytes[i] !== pngSig[i]) return {};
  }

  const meta = {};
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(view, offset);
    offset += 4;

    const type = decodeLatin1(bytes.slice(offset, offset + 4));
    offset += 4;

    const dataStart = offset;
    const dataEnd = offset + length;
    const data = bytes.slice(dataStart, dataEnd);

    offset = dataEnd + 4; // skip CRC

    if (type === "tEXt") {
      const nul = data.indexOf(0);

      if (nul > -1) {
        const key = decodeLatin1(data.slice(0, nul));
        const value = decodeLatin1(data.slice(nul + 1));
        meta[key] = value;
      }
    }

    if (type === "iTXt") {
      let p = 0;
      const nul1 = data.indexOf(0, p);

      if (nul1 > -1) {
        const key = decodeUtf8(data.slice(p, nul1));
        p = nul1 + 1;

        const compressionFlag = data[p];
        p += 1;

        // compression method
        p += 1;

        const nulLang = data.indexOf(0, p);

        if (nulLang > -1) {
          p = nulLang + 1;

          const nulTranslated = data.indexOf(0, p);

          if (nulTranslated > -1) {
            p = nulTranslated + 1;

            // Only uncompressed iTXt for now.
            if (compressionFlag === 0) {
              meta[key] = decodeUtf8(data.slice(p));
            }
          }
        }
      }
    }

    if (type === "IEND") break;
  }

  return meta;
}
function cleanExifText(value) {
  return String(value || "")
    .replace(/^ASCII\x00\x00\x00/, "")
    .replace(/\0/g, "")
    .trim();
}

function parseJpegExifMetadata(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const meta = {};

  // JPEG SOI marker
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return meta;
  }

  function readAscii(start, length) {
    let s = "";

    for (let i = 0; i < length && start + i < bytes.length; i++) {
      s += String.fromCharCode(bytes[start + i]);
    }

    return s;
  }

  function parseExifSegment(segmentStart, segmentLength) {
    // EXIF payload should start with Exif\0\0
    if (readAscii(segmentStart, 6) !== "Exif\0\0") {
      return;
    }

    const tiffStart = segmentStart + 6;
    const endian = readAscii(tiffStart, 2);

    const little = endian === "II";
    const big = endian === "MM";

    if (!little && !big) {
      return;
    }

    const read16 = (offset) => view.getUint16(offset, little);
    const read32 = (offset) => view.getUint32(offset, little);

    const firstIfdOffset = read32(tiffStart + 4);

    function readExifValue(type, count, valueOffsetField) {
      const typeSize =
        {
          1: 1, // BYTE
          2: 1, // ASCII
          3: 2, // SHORT
          4: 4, // LONG
          7: 1, // UNDEFINED
        }[type] || 1;

      const totalBytes = typeSize * count;

      let valueStart;

      if (totalBytes <= 4) {
        valueStart = valueOffsetField;
      } else {
        const realOffset = read32(valueOffsetField);
        valueStart = tiffStart + realOffset;
      }

      if (valueStart < 0 || valueStart >= bytes.length) {
        return "";
      }

      if (type === 2 || type === 7 || type === 1) {
        return cleanExifText(readAscii(valueStart, totalBytes));
      }

      return "";
    }

    function readIfd(ifdRelativeOffset) {
      const ifdStart = tiffStart + ifdRelativeOffset;

      if (ifdStart < 0 || ifdStart + 2 >= bytes.length) {
        return;
      }

      const entryCount = read16(ifdStart);

      for (let i = 0; i < entryCount; i++) {
        const entry = ifdStart + 2 + i * 12;

        if (entry + 12 > bytes.length) {
          continue;
        }

        const tag = read16(entry);
        const type = read16(entry + 2);
        const count = read32(entry + 4);
        const valueOffsetField = entry + 8;

        // 270 = ImageDescription
        if (tag === 270) {
          const value = readExifValue(type, count, valueOffsetField);

          if (value) {
            meta.Description = value;
          }
        }

        // 37510 = UserComment
        if (tag === 37510) {
          const value = readExifValue(type, count, valueOffsetField);

          if (value) {
            meta.UserComment = value;
          }
        }

        // 34665 = ExifIFDPointer
        if (tag === 34665) {
          const subIfdOffset = read32(valueOffsetField);

          if (subIfdOffset) {
            readIfd(subIfdOffset);
          }
        }
      }
    }

    readIfd(firstIfdOffset);
  }

  let offset = 2;

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      break;
    }

    const marker = bytes[offset + 1];

    // Start of Scan or End of Image
    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    const segmentLength = view.getUint16(offset + 2, false);
    const segmentStart = offset + 4;
    const segmentDataLength = segmentLength - 2;

    // APP1 = EXIF
    if (marker === 0xe1) {
      parseExifSegment(segmentStart, segmentDataLength);
    }

    offset += 2 + segmentLength;
  }

  const candidate = meta.UserComment || meta.Description || "";

  if (
    candidate &&
    (
      candidate.includes("Negative prompt:") ||
      candidate.includes("Steps:") ||
      candidate.includes("Sampler:") ||
      candidate.includes("CFG scale:")
    )
  ) {
    meta.parameters = candidate;
  }

  return meta;
}

function tryParseJson(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseAutomatic1111Parameters(parametersText) {
  const raw = String(parametersText || "").trim();
  if (!raw) return {};

  const meta = {
    raw_parameters: raw,
  };

  const negativeMarker = "Negative prompt:";
  const stepsMarker = "Steps:";

  const negIdx = raw.indexOf(negativeMarker);
  const stepsIdx = raw.indexOf(stepsMarker);

  if (negIdx >= 0) {
    meta.prompt = raw.slice(0, negIdx).trim();

    if (stepsIdx >= 0 && stepsIdx > negIdx) {
      meta.negativePrompt = raw
        .slice(negIdx + negativeMarker.length, stepsIdx)
        .trim()
        .replace(/,$/, "");
    } else {
      meta.negativePrompt = raw.slice(negIdx + negativeMarker.length).trim();
    }
  } else if (stepsIdx >= 0) {
    meta.prompt = raw.slice(0, stepsIdx).trim();
  } else {
    meta.prompt = raw;
  }

  const settingsText = stepsIdx >= 0 ? raw.slice(stepsIdx) : "";

  if (settingsText) {
    const parts = settingsText.split(",").map((p) => p.trim());

    for (const part of parts) {
      const colon = part.indexOf(":");
      if (colon <= 0) continue;

      const key = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim();
      const lower = key.toLowerCase();

      if (lower === "steps") meta.steps = value;
      else if (lower === "sampler") meta.sampler = value;
      else if (lower === "schedule type" || lower === "scheduler") meta.scheduler = value;
      else if (lower === "cfg scale") meta.cfgScale = value;
      else if (lower === "seed") meta.seed = value;
      else if (lower === "size") meta.size = value;
      else if (lower === "model") meta.Model = value;
      else if (lower === "model hash") meta.modelHash = value;
      else meta[key] = value;
    }
  }

  return meta;
}

function extractPromptsFromCivitaiSelectionData(promptJson) {
  const result = {
    positive: "",
    negative: "",
  };

  if (!promptJson || typeof promptJson !== "object") {
    return result;
  }

  for (const node of Object.values(promptJson)) {
    if (!node || typeof node !== "object") continue;

    const classType = String(node.class_type || "");
    if (classType !== "CivitaiGalleryNode") continue;

    const selectionData = node.inputs?.selection_data;
    if (typeof selectionData !== "string" || !selectionData.trim()) continue;

    try {
      const parsed = JSON.parse(selectionData);
      const meta = parsed?.item?.meta || {};

      if (!result.positive) {
        result.positive =
          meta.prompt ||
          meta.positivePrompt ||
          meta.positive ||
          "";
      }

      if (!result.negative) {
        result.negative =
          meta.negativePrompt ||
          meta.negative ||
          "";
      }

      if (result.positive || result.negative) {
        return result;
      }
    } catch {}
  }

  return result;
}

function extractComfyPromptsFromPromptJson(promptJson) {
  const result = {
    positive: "",
    negative: "",
  };

  if (!promptJson || typeof promptJson !== "object") {
    return result;
  }

  const nodes = promptJson;

const getNodeText = (node) => {
  const text = node?.inputs?.text;

  // Direct prompt text.
  if (typeof text === "string") {
    return text;
  }

  // Detect link info
  if (Array.isArray(text)) {
    return "";
  }

  return "";
};

  const isTextEncodeNode = (node) => {
    const classType = String(node?.class_type || "").toLowerCase();
    const title = String(node?._meta?.title || "").toLowerCase();

    return (
      classType.includes("cliptextencode") ||
      classType.includes("textencode") ||
      title.includes("clip text encode") ||
      title.includes("positive prompt") ||
      title.includes("negative prompt")
    );
  };

  // 1. Title-based extraction.
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== "object") continue;
    if (!isTextEncodeNode(node)) continue;

    const title = String(node?._meta?.title || "").toLowerCase();
    const text = getNodeText(node);

    if (!text) continue;

    if (!result.positive && title.includes("positive")) {
      result.positive = text;
    }

    if (!result.negative && title.includes("negative")) {
      result.negative = text;
    }
  }

  // 2. KSampler link-based extraction.
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== "object") continue;

    const classType = String(node.class_type || "").toLowerCase();

    if (!classType.includes("ksampler")) continue;

    const positiveLink = node.inputs?.positive;
    const negativeLink = node.inputs?.negative;

    if (!result.positive && Array.isArray(positiveLink)) {
      const positiveNodeId = String(positiveLink[0]);
      const positiveNode = nodes[positiveNodeId];
      const text = getNodeText(positiveNode);

      if (text) {
        result.positive = text;
      }
    }

    if (!result.negative && Array.isArray(negativeLink)) {
      const negativeNodeId = String(negativeLink[0]);
      const negativeNode = nodes[negativeNodeId];
      const text = getNodeText(negativeNode);

      if (text) {
        result.negative = text;
      }
    }
  }

  // 3. Fallback: first/second text encode nodes.
  if (!result.positive || !result.negative) {
    const textNodes = [];

    for (const node of Object.values(nodes)) {
      if (!node || typeof node !== "object") continue;
      if (!isTextEncodeNode(node)) continue;

      const text = getNodeText(node);

      if (text) {
        textNodes.push(text);
      }
    }

    if (!result.positive && textNodes[0]) {
      result.positive = textNodes[0];
    }

    if (!result.negative && textNodes[1]) {
      result.negative = textNodes[1];
    }
  }

  if (!result.positive || !result.negative) {
    const civitaiPrompts = extractPromptsFromCivitaiSelectionData(promptJson);

    if (!result.positive && civitaiPrompts.positive) {
      result.positive = civitaiPrompts.positive;
    }

    if (!result.negative && civitaiPrompts.negative) {
      result.negative = civitaiPrompts.negative;
    }
  }

  return result;
}

function extractComfyPromptsFromWorkflowJson(workflowJson) {
  const result = {
    positive: "",
    negative: "",
  };

  const nodes = Array.isArray(workflowJson?.nodes) ? workflowJson.nodes : [];
  const links = Array.isArray(workflowJson?.links) ? workflowJson.links : [];

  if (!nodes.length) {
    return result;
  }

  const nodeById = new Map();

  for (const node of nodes) {
    nodeById.set(String(node.id), node);
  }

  const linkById = new Map();

  for (const link of links) {
    // Comfy workflow links are usually:
    // [link_id, origin_node_id, origin_slot, target_node_id, target_slot, type]
    if (Array.isArray(link) && link.length >= 6) {
      linkById.set(String(link[0]), {
        id: link[0],
        originNodeId: String(link[1]),
        originSlot: link[2],
        targetNodeId: String(link[3]),
        targetSlot: link[4],
        type: link[5],
      });
    }
  }

  const isTextEncodeNode = (node) => {
    const type = String(node?.type || node?.class_type || "").toLowerCase();
    const title = String(node?.title || node?._meta?.title || "").toLowerCase();

    return (
      type.includes("cliptextencode") ||
      type.includes("textencode") ||
      title.includes("clip text encode") ||
      title.includes("positive prompt") ||
      title.includes("negative prompt")
    );
  };

  const getWidgetText = (node) => {
    const values = Array.isArray(node?.widgets_values) ? node.widgets_values : [];

    const strings = values
      .filter((v) => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);

    if (!strings.length) return "";

    // Most CLIPTextEncode nodes have the prompt as the first string widget.
    return strings.join("\n");
  };

  const getLinkedOriginNodeForInput = (node, inputName) => {
    const inputs = Array.isArray(node?.inputs) ? node.inputs : [];

    const input = inputs.find((i) => String(i?.name || "").toLowerCase() === inputName);

    if (!input || input.link == null) {
      return null;
    }

    const linkInfo = linkById.get(String(input.link));

    if (!linkInfo) {
      return null;
    }

    return nodeById.get(String(linkInfo.originNodeId)) || null;
  };

  // 1. Title-based extraction.
  for (const node of nodes) {
    if (!isTextEncodeNode(node)) continue;

    const title = String(node?.title || node?._meta?.title || "").toLowerCase();
    const text = getWidgetText(node);

    if (!text) continue;

    if (!result.positive && title.includes("positive")) {
      result.positive = text;
    }

    if (!result.negative && title.includes("negative")) {
      result.negative = text;
    }
  }

  // 2. KSampler link-based extraction.
  for (const node of nodes) {
    const type = String(node?.type || node?.class_type || "").toLowerCase();

    if (!type.includes("ksampler")) continue;

    const positiveNode = getLinkedOriginNodeForInput(node, "positive");
    const negativeNode = getLinkedOriginNodeForInput(node, "negative");

    if (!result.positive && positiveNode) {
      const text = getWidgetText(positiveNode);

      if (text) {
        result.positive = text;
      }
    }

    if (!result.negative && negativeNode) {
      const text = getWidgetText(negativeNode);

      if (text) {
        result.negative = text;
      }
    }
  }

  // 3. Fallback: first/second text encode nodes.
  if (!result.positive || !result.negative) {
    const textNodes = nodes
      .filter(isTextEncodeNode)
      .map(getWidgetText)
      .filter(Boolean);

    if (!result.positive && textNodes[0]) {
      result.positive = textNodes[0];
    }

    if (!result.negative && textNodes[1]) {
      result.negative = textNodes[1];
    }
  }

  return result;
}

function extractComfyGenerationInfoFromWorkflowJson(workflowJson) {
  const info = {};
  const nodes = Array.isArray(workflowJson?.nodes) ? workflowJson.nodes : [];

  for (const node of nodes) {
    const type = String(node?.type || node?.class_type || "");
    const values = Array.isArray(node?.widgets_values) ? node.widgets_values : [];

    if (type === "UNETLoader") {
      if (values[0] && !info.unet_name) info.unet_name = String(values[0]);
      if (values[1] && !info.weight_dtype) info.weight_dtype = String(values[1]);
    }

    if (type === "CheckpointLoaderSimple") {
      if (values[0] && !info.ckpt_name) info.ckpt_name = String(values[0]);
    }

    if (type === "VAELoader") {
      if (values[0] && !info.vae_name) info.vae_name = String(values[0]);
    }

    if (type === "CLIPLoaderGGUF") {
      if (values[0] && !info.clip_name) info.clip_name = String(values[0]);
      if (values[1] && !info.clip_type) info.clip_type = String(values[1]);
    }

    if (type === "KSampler") {
      // Common KSampler widget order:
      // seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise
      if (values[0] != null && info.seed == null) info.seed = String(values[0]);
      if (values[2] != null && info.steps == null) info.steps = String(values[2]);
      if (values[3] != null && info.cfgScale == null) info.cfgScale = String(values[3]);
      if (values[4] && !info.sampler) info.sampler = String(values[4]);
      if (values[5] && !info.scheduler) info.scheduler = String(values[5]);
      if (values[6] != null && info.denoise == null) info.denoise = String(values[6]);
    }
  }

  return info;
}

function extractComfyGenerationInfoFromPromptJson(promptJson) {
  const info = {};

  if (!promptJson || typeof promptJson !== "object") {
    return info;
  }

  for (const node of Object.values(promptJson)) {
    if (!node || typeof node !== "object") continue;

    const classType = String(node.class_type || "");
    const inputs = node.inputs || {};

    // UNETLoader
    if (classType === "UNETLoader") {
      if (inputs.unet_name && !info.unet_name) {
        info.unet_name = String(inputs.unet_name);
      }
      if (inputs.weight_dtype && !info.weight_dtype) {
        info.weight_dtype = String(inputs.weight_dtype);
      }
    }

    // CheckpointLoaderSimple
    if (classType === "CheckpointLoaderSimple") {
      if (inputs.ckpt_name && !info.ckpt_name) {
        info.ckpt_name = String(inputs.ckpt_name);
      }
    }

    // VAELoader
    if (classType === "VAELoader") {
      if (inputs.vae_name && !info.vae_name) {
        info.vae_name = String(inputs.vae_name);
      }
    }

    // CLIPLoaderGGUF
    if (classType === "CLIPLoaderGGUF") {
      if (inputs.clip_name && !info.clip_name) {
        info.clip_name = String(inputs.clip_name);
      }
      if (inputs.type && !info.clip_type) {
        info.clip_type = String(inputs.type);
      }
    }

    // KSampler
    if (classType === "KSampler") {
      if (inputs.seed != null && info.seed == null) {
        info.seed = String(inputs.seed);
      }
      if (inputs.steps != null && info.steps == null) {
        info.steps = String(inputs.steps);
      }
      if (inputs.cfg != null && info.cfgScale == null) {
        info.cfgScale = String(inputs.cfg);
      }
      if (inputs.sampler_name && !info.sampler) {
        info.sampler = String(inputs.sampler_name);
      }
      if (inputs.scheduler && !info.scheduler) {
        info.scheduler = String(inputs.scheduler);
      }
      if (inputs.denoise != null && info.denoise == null) {
        info.denoise = String(inputs.denoise);
      }
    }
  }

  return info;
}

function assignMissing(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (
      typeof v !== "undefined" &&
      v !== null &&
      v !== "" &&
      (typeof target[k] === "undefined" || target[k] === null || target[k] === "")
    ) {
      target[k] = v;
    }
  }
}

function normalizeLocalImageMetadata(rawMeta) {
  const meta = {};

  for (const [k, v] of Object.entries(rawMeta || {})) {
    meta[k] = v;
  }

  const promptJson =
    tryParseJson(rawMeta?.prompt) ||
    tryParseJson(rawMeta?.Prompt) ||
    null;

  const workflowJson =
    tryParseJson(rawMeta?.workflow) ||
    tryParseJson(rawMeta?.Workflow) ||
    null;

  if (promptJson) {
    meta.comfy_prompt = promptJson;

    const comfyPrompts = extractComfyPromptsFromPromptJson(promptJson);
    const comfyInfo = extractComfyGenerationInfoFromPromptJson(promptJson);

    meta.prompt = comfyPrompts.positive || "";
    meta.negativePrompt = comfyPrompts.negative || "";

    assignMissing(meta, comfyInfo);
  }

  if (workflowJson) {
    meta.comfy_workflow = workflowJson;

    const workflowPrompts = extractComfyPromptsFromWorkflowJson(workflowJson);
    const workflowInfo = extractComfyGenerationInfoFromWorkflowJson(workflowJson);

    if (!meta.prompt && workflowPrompts.positive) {
      meta.prompt = workflowPrompts.positive;
    }

    if (!meta.negativePrompt && workflowPrompts.negative) {
      meta.negativePrompt = workflowPrompts.negative;
    }

    assignMissing(meta, workflowInfo);
  }

  if (!meta.Model) {
    meta.Model = meta.ckpt_name || meta.unet_name || "";
  }

  const parameters =
    rawMeta?.parameters ||
    rawMeta?.Parameters ||
    rawMeta?.Description ||
    rawMeta?.UserComment ||
    "";

  if (parameters && typeof parameters === "string") {
    const parsedParams = parseAutomatic1111Parameters(parameters);

    // A1111 params should fill blanks, but should not overwrite good ComfyUI extracted prompts.
    assignMissing(meta, parsedParams);
  }

  if (!meta.prompt) {
    meta.prompt =
      rawMeta?.positive ||
      rawMeta?.Positive ||
      rawMeta?.positivePrompt ||
      rawMeta?.PositivePrompt ||
      "";
  }

  if (!meta.negativePrompt) {
    meta.negativePrompt =
      rawMeta?.negative ||
      rawMeta?.Negative ||
      rawMeta?.negativePrompt ||
      rawMeta?.NegativePrompt ||
      "";
  }

  // Safety: never send full Comfy JSON graph to the Prompt Editor.
  if (typeof meta.prompt === "string") {
    const trimmed = meta.prompt.trim();

    if (
      trimmed.startsWith("{") &&
      trimmed.includes("class_type") &&
      trimmed.includes("inputs")
    ) {
      meta.prompt = "";
    }
  }

  if (typeof meta.negativePrompt === "string") {
    const trimmed = meta.negativePrompt.trim();

    if (
      trimmed.startsWith("{") &&
      trimmed.includes("class_type") &&
      trimmed.includes("inputs")
    ) {
      meta.negativePrompt = "";
    }
  }

  return meta;
}

function buildLocalInfoText({ file, meta }) {
  const lines = [];

  lines.push("Source: Local image");

  if (file?.name) lines.push(`File: ${file.name}`);
  if (file?.type) lines.push(`Type: ${file.type}`);
  if (file?.size != null) lines.push(`Size: ${file.size} bytes`);

  const model =
    meta?.Model ||
    meta?.model ||
    meta?.["Model type"] ||
    meta?.ckpt_name ||
    meta?.unet_name ||
    meta?.ecosystem ||
    "";

  const checkpoint = meta?.ckpt_name || "";
  const unet = meta?.unet_name || "";
  const weightDtype = meta?.weight_dtype || "";
  const vae = meta?.vae_name || "";
  const clip = meta?.clip_name || "";
  const clipType = meta?.clip_type || "";

  const steps = meta?.steps || meta?.Steps || "";
  const cfg = meta?.cfgScale || meta?.["CFG scale"] || meta?.CFG || "";
  const sampler = meta?.sampler || meta?.Sampler || "";
  const scheduler = meta?.scheduler || meta?.Scheduler || "";
  const seed = meta?.seed || meta?.Seed || "";
  const denoise = meta?.denoise || "";
  const imageSize = meta?.size || meta?.Size || "";

  if (model) {
    lines.push(`Model: ${model}`);
  }

  if (checkpoint && checkpoint !== model) {
    lines.push(`Checkpoint: ${checkpoint}`);
  }

  if (unet && unet !== model) {
    lines.push(`UNET: ${unet}`);
  }

  if (weightDtype) {
    lines.push(`Weight dtype: ${weightDtype}`);
  }

  if (vae) {
    lines.push(`VAE: ${vae}`);
  }

  if (clip) {
    lines.push(`CLIP: ${clip}`);
  }

  if (clipType) {
    lines.push(`CLIP Type: ${clipType}`);
  }

  if (steps) {
    lines.push(`Steps: ${steps}`);
  }

  if (cfg) {
    lines.push(`CFG: ${cfg}`);
  }

  if (sampler) {
    lines.push(`Sampler: ${sampler}`);
  }

  if (scheduler) {
    lines.push(`Scheduler: ${scheduler}`);
  }

  if (seed) {
    lines.push(`Seed: ${seed}`);
  }

  if (denoise) {
    lines.push(`Denoise: ${denoise}`);
  }

  if (imageSize) {
    lines.push(`Image Size: ${imageSize}`);
  }

  return lines.join("\n");
}

async function handleLocalImageFile(node, file) {
  if (!file || !file.type?.startsWith("image/")) {
    alert("Please choose an image file.");
    return;
  }

  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);

let rawMeta = {};

const fileNameLower = file.name.toLowerCase();

if (file.type === "image/png" || fileNameLower.endsWith(".png")) {
  rawMeta = parsePngMetadata(arrayBuffer);
} else if (
  file.type === "image/jpeg" ||
  fileNameLower.endsWith(".jpg") ||
  fileNameLower.endsWith(".jpeg")
) {
  rawMeta = parseJpegExifMetadata(arrayBuffer);
}

    const normalizedMeta = normalizeLocalImageMetadata(rawMeta);
    const prompts = extractPrompts(normalizedMeta);

    const positive = prompts.positive || "";
    const negative = prompts.negative || "";

    let infoText = buildLocalInfoText({
      file,
      meta: normalizedMeta,
    });

    if (!Object.keys(rawMeta || {}).length) {
     infoText += "\n\nMetadata: No readable AI generation metadata found.";
    }

    const objectUrl = URL.createObjectURL(file);

    const data = {
      source: "local",
      filename: file.name,
      type: file.type,
      size: file.size,
      positive,
      negative,
      info: infoText,
      meta: normalizedMeta,
      rawMeta,
    };

    node.__localImageInfoFileName = file.name;
    node.__localImageInfoData = data;
    node.__localImageInfoText = infoText;

    const widget = node.widgets?.find((w) => w.name === "image_data");

    if (widget) {
      const payload = JSON.stringify(data);
      widget.value = payload;
      widget.callback?.(payload);
    }

    node.graph?.setDirtyCanvas(true, true);

    await updateSupportNodes({
      url: objectUrl,
      meta: normalizedMeta,
      id: null,
      postId: null,
      pageUrl: "",
      sourcePageUrl: "",
      pageDomain: "",
      infoText,
      isLocal: true,
      filename: file.name,
    });
  } catch (err) {
    console.warn("[Local Image Info] failed to parse image metadata", err);

    const fallbackInfo =
      `Source: Local image\n` +
      `File: ${file.name}\n` +
      `Type: ${file.type}\n` +
      `Size: ${file.size} bytes\n\n` +
      `Metadata parse failed: ${err?.message || err}`;

    node.__localImageInfoFileName = file.name;
    node.__localImageInfoText = fallbackInfo;
    node.graph?.setDirtyCanvas(true, true);

    alert("Failed to read image metadata. See browser console for details.");
  }
}

function openUrlInNewTab(url) {
  const finalUrl = String(url || "").trim();

  if (!finalUrl) {
    alert("No preview image is currently loaded.");
    return;
  }

  const opened = window.open(finalUrl, "_blank", "noopener,noreferrer");

  // Fallback if popup blocking prevents window.open.
  if (!opened) {
    const a = document.createElement("a");
    a.href = finalUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

function openPreviewImage(node) {
  const srcUrl = String(node?.__civitaiSourceUrl || "").trim();
  const thumbUrl = String(node?.__civitaiThumbUrl || "").trim();
  const pageUrl = String(node?.__civitaiPageUrl || "").trim();

  const isLocalObjectUrl =
    srcUrl.startsWith("blob:") ||
    srcUrl.startsWith("data:") ||
    thumbUrl.startsWith("blob:") ||
    thumbUrl.startsWith("data:");

  // Local image: open the browser object/data URL directly.
  if (isLocalObjectUrl) {
    openUrlInNewTab(thumbUrl || srcUrl);
    return;
  }

  // CivitAI/remote image: prefer the proxied preview image URL that ComfyUI can serve.
  // This avoids opening the CivitAI page and instead opens the actual image preview.
  if (thumbUrl) {
    openUrlInNewTab(thumbUrl);
    return;
  }

  // If thumbUrl has not been initialized yet, rebuild the proxy URL from source.
  if (srcUrl) {
    openUrlInNewTab(buildProxyImageUrl(srcUrl, pageUrl));
    return;
  }

  alert("No preview image is currently loaded.");
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

if (isLocalImageInfoNode(node)) {
  if (node.__localImageInfoHooked) return;
  node.__localImageInfoHooked = true;

  node.size = node.size || [420, 260];
  node.size[0] = Math.max(node.size[0], 420);
  node.size[1] = Math.max(node.size[1], 260);

  node.addWidget("button", "Upload Image", null, async () => {
    await openLocalImagePicker(node);
  });

  const oldSerialize = node.onSerialize?.bind(node);
  node.onSerialize = function (o) {
    oldSerialize?.(o);
    o.__localImageInfoFileName = this.__localImageInfoFileName || "";
    o.__localImageInfoText = this.__localImageInfoText || "";
    o.__localImageInfoData = this.__localImageInfoData || null;
  };

  const oldConfigure = node.onConfigure?.bind(node);
  node.onConfigure = function (o) {
    oldConfigure?.(o);
    this.__localImageInfoFileName = o?.__localImageInfoFileName || "";
    this.__localImageInfoText = o?.__localImageInfoText || "";
    this.__localImageInfoData = o?.__localImageInfoData || null;
    this.graph?.setDirtyCanvas(true, true);
  };

  const oldDraw = node.onDrawForeground?.bind(node);
  node.onDrawForeground = function (ctx) {
    oldDraw?.(ctx);

  if (this.__localImageInfoDragOver) {
    ctx.save();
    ctx.strokeStyle = "rgba(120, 200, 255, 0.95)";
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, this.size[0] - 12, this.size[1] - 12);
    ctx.restore();
  }

    const pad = 10;
    const top = 70;
    const w = this.size[0] - pad * 2;
    const h = this.size[1] - top - pad;

    drawPanel(
      ctx,
      pad,
      top,
      w,
      h,
      "Local Image Info",
      this.__localImageInfoText || "Click Upload Image, or drop an image directly onto this node."
    );
  };

  return;
}

    // Prompt Editor: bottom button bar (canvas), no widget buttons
    if (isPromptEditorNode(node)) {
      if (node.__civitaiPromptHooked) return;
      node.__civitaiPromptHooked = true;

      node.size = node.size || [560, 520];
      node.size[0] = Math.max(node.size[0], 560);
      node.size[1] = Math.max(node.size[1], 520);


const oldSerialize = node.onSerialize?.bind(node);
node.onSerialize = function (o) {
  oldSerialize?.(o);
  o.__civitaiPositive = this.__civitaiPositive || "";
  o.__civitaiNegative = this.__civitaiNegative || "";
};

const oldConfigure = node.onConfigure?.bind(node);
node.onConfigure = function (o) {
  oldConfigure?.(o);
  this.__civitaiPositive = o?.__civitaiPositive || this.__civitaiPositive || "";
  this.__civitaiNegative = o?.__civitaiNegative || this.__civitaiNegative || "";

  this.__civitaiOriginalPrompts = {
    positive: this.__civitaiPositive,
    negative: this.__civitaiNegative,
  };

  this.graph?.setDirtyCanvas(true, true);
};

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


const oldSerializeInfo = node.onSerialize?.bind(node);
node.onSerialize = function (o) {
  oldSerializeInfo?.(o);
  o.__civitaiInfoText = this.__civitaiInfoText || "";
  o.__civitaiPageUrl = this.__civitaiPageUrl || "";
};

const oldConfigureInfo = node.onConfigure?.bind(node);
node.onConfigure = function (o) {
  oldConfigureInfo?.(o);
  this.__civitaiInfoText = o?.__civitaiInfoText || this.__civitaiInfoText || "";
  this.__civitaiPageUrl = o?.__civitaiPageUrl || this.__civitaiPageUrl || "";
  this.graph?.setDirtyCanvas(true, true);
};


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

  node.addWidget("button", "Open Image", null, () => {
    openPreviewImage(node);
  });

      node.size = node.size || [320, 420];
      node.size[0] = Math.max(node.size[0], 320);
      node.size[1] = Math.max(node.size[1], 420);


const oldSerializePrev = node.onSerialize?.bind(node);
node.onSerialize = function (o) {
  oldSerializePrev?.(o);
  o.__civitaiPageUrl = this.__civitaiPageUrl || "";
  o.__civitaiSourceUrl = this.__civitaiSourceUrl || "";
};

const oldConfigurePrev = node.onConfigure?.bind(node);
node.onConfigure = function (o) {
  oldConfigurePrev?.(o);

  this.__civitaiPageUrl = o?.__civitaiPageUrl || this.__civitaiPageUrl || "";
  this.__civitaiSourceUrl = o?.__civitaiSourceUrl || this.__civitaiSourceUrl || "";

if (this.__civitaiSourceUrl) {
  const isLocalObjectUrl =
    typeof this.__civitaiSourceUrl === "string" &&
    (this.__civitaiSourceUrl.startsWith("blob:") ||
      this.__civitaiSourceUrl.startsWith("data:"));

  const previewUrl = isLocalObjectUrl
    ? this.__civitaiSourceUrl
    : buildProxyImageUrl(this.__civitaiSourceUrl, this.__civitaiPageUrl);

this.__civitaiThumbUrl = previewUrl;

  if (!this.__civitaiThumbImg) {
    this.__civitaiThumbImg = new Image();
    this.__civitaiThumbImg.onload = () =>
      this.graph?.setDirtyCanvas(true, true);
  }

  this.__civitaiThumbImg.src = previewUrl;
}

  this.graph?.setDirtyCanvas(true, true);
};

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
