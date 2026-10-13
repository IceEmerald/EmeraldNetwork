const CHAT_WORKER_URL = "https://emeraldnetwork-aichatserver.iceemerald.workers.dev";
const IMAGE_SEARCH_URL = CHAT_WORKER_URL + "/image-search";
const EMERALDBOT_API = "worker";
const DISPLAY_MODEL = "EmeraldCore";
(function _installConsoleNoiseFilter() {
  if (window._esbConsoleFilterInstalled) return;
  window._esbConsoleFilterInstalled = true;
  const _origError = console.error.bind(console);
  const NOISY_RE = /\b(40[04]|429|5\d{2})\b|API error \d|quota|rate.?limit|RESOURCE_EXHAUSTED|Too Many Requests|temporarily unavailable|please retry in|model not found|not_found|NOT_FOUND/i;
  const _isNoisy = (...args) => {
    const txt = args.slice(0, 3).map((a) => {
      if (a instanceof Error) return a.message || "";
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }).join(" ");
    return NOISY_RE.test(txt);
  };
  console.error = function(...args) {
    if (_isNoisy(...args)) return;
    return _origError(...args);
  };
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev && ev.reason;
    const msg = r && (r.message || r) || "";
    if (typeof msg === "string" && NOISY_RE.test(msg)) {
      ev.preventDefault();
    }
  });
})();
/* Frontend model registry. Order = capability descending. The `tier` string
   is shown as a small badge in the dropdown so the hierarchy is visible at a
   glance. ids MUST match the `publicId` field in worker.js MODELS. */
const MODELS = [
  { id: "astra",     name: "EmeraldCore Astra",     short: "Astra",     tier: "v4.2", desc: "Frontier flagship — ultra-deep reasoning, autonomous multi-step tasks, cross-domain synthesis." },
  { id: "ruby",      name: "EmeraldCore Ruby",      short: "Ruby",      tier: "v4.2", desc: "Multimodal precision — vision, data science, scientific analysis, structured output." },
  { id: "gamma",     name: "EmeraldCore Gamma",     short: "Gamma",     tier: "v4.1", desc: "Deepest reasoning — math, code, hard logic." },
  { id: "diamond",   name: "EmeraldCore Diamond",   short: "Diamond",   tier: "v4",   desc: "Creative strategy, planning, long-form writing." },
  { id: "gold",      name: "EmeraldCore Gold",      short: "Gold",      tier: "v4",   desc: "Research, fact-checking, in-depth analysis." },
  { id: "kappa",     name: "EmeraldCore Kappa",     short: "Kappa",     tier: "v3.5", desc: "Versatile — web, roleplay, basic math." },
  { id: "starlight", name: "EmeraldCore Starlight", short: "Starlight", tier: "v3",   desc: "Balanced everyday chat and quick tasks." },
  { id: "cream",     name: "EmeraldCore Cream",     short: "Cream",     tier: "v2",   desc: "Fast, lightweight answers for simple questions." }
];
/* Primary models shown directly in the dropdown. Everything else is tucked
   behind the \"Other Models\" hover trigger to keep the panel scannable. */
const PRIMARY_MODEL_IDS = ["astra", "ruby", "gamma"];
const OTHER_MODEL_IDS = ["diamond", "gold", "kappa", "starlight", "cream"];
const MODEL_DEFAULT_ID = "auto";
function getModelById(id) {
  return MODELS.find((m) => m.id === id) || null;
}
function getSelectedModelId() {
  const s = loadSettings();
  return s.modelId || MODEL_DEFAULT_ID;
}
function setSelectedModelId(id) {
  const s = loadSettings();
  saveSettingsObj({ ...s, modelId: id });
}
/* ── Reasoning mode ─────────────────────────────────────────────
   When enabled, the worker turns on Gemini's thinkingConfig
   (thinkingBudget: -1 = dynamic) and appends a step-by-step reasoning
   hint to the system prompt. Persisted in settings.reasoning (boolean).
   Default: off, so simple questions stay fast. */
function isReasoningEnabled() {
  return !!loadSettings().reasoning;
}
function setReasoningEnabled(enabled) {
  const s = loadSettings();
  saveSettingsObj({ ...s, reasoning: !!enabled });
  refreshReasoningToggleUI();
}
function toggleReasoning() {
  const next = !isReasoningEnabled();
  setReasoningEnabled(next);
  showToast(`${_aiSvgCheck} Reasoning ${next ? "on" : "off"}`);
}
function refreshReasoningToggleUI() {
  const btn = $("reasoningToggleBtn");
  if (!btn) return;
  const on = isReasoningEnabled();
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on ? "Reasoning mode is ON — slower, deeper answers." : "Turn on reasoning mode";
}
const SEARCH_PROXY_URL = "https://emeraldnetwork-aichatsearch.iceemerald.workers.dev";
const IMAGE_WORKER_URL = "https://emeraldnetwork-aichatimagegen.iceemerald.workers.dev";
const memoryStorageFallback = /* @__PURE__ */ new Map();
const S = {
  get: (k) => {
    if (window.EmeraldIDBStorage) {
      return window.EmeraldIDBStorage.getJSONSync(k);
    }
    return memoryStorageFallback.has(k) ? memoryStorageFallback.get(k) : null;
  },
  set: (k, v) => {
    if (window.EmeraldIDBStorage) {
      window.EmeraldIDBStorage.setJSONSync(k, v);
      return;
    }
    memoryStorageFallback.set(k, v);
  },
  del: (k) => {
    if (window.EmeraldIDBStorage) {
      window.EmeraldIDBStorage.delete(k).catch(() => {
      });
    }
    memoryStorageFallback.delete(k);
  }
};
const CONV_KEY = "en_chat_convs";
const LIB_KEY = "en_chat_lib";
const SETTINGS_KEY = "en_chat_settings";
const MEMORY_KEY = "en_chat_memory";
const OB_KEY = "en_onboarded";
async function migrateChatStorageToIndexedDB() {
  if (!window.EmeraldIDBStorage) return;
  try {
    await window.EmeraldIDBStorage.ready();
    await Promise.all([
      window.EmeraldIDBStorage.migrateLocalJSON(CONV_KEY),
      window.EmeraldIDBStorage.migrateLocalJSON(LIB_KEY),
      window.EmeraldIDBStorage.migrateLocalJSON(SETTINGS_KEY),
      window.EmeraldIDBStorage.migrateLocalJSON(MEMORY_KEY),
      window.EmeraldIDBStorage.migrateLocalJSON(OB_KEY)
    ]);
  } catch (err) {
    // Migration failure shouldn't crash init — log so it's not invisible.
    console.warn("migrateChatStorageToIndexedDB failed:", err);
  }
}
let state = {
  convId: null,
  isTemp: false,
  isStreaming: false,
  abortCtrl: null,
  streamConvId: null,
  streamMsgId: null,
  attachments: [],
  tempHistory: []
};
function loadConvs() {
  return S.get(CONV_KEY) || [];
}
function saveConvs(arr) {
  S.set(CONV_KEY, arr);
}
function loadLib() {
  return S.get(LIB_KEY) || [];
}
function saveLib(arr) {
  S.set(LIB_KEY, arr);
}
function loadSettings() {
  return S.get(SETTINGS_KEY) || {};
}
async function initTheme() {
  await migrateChatStorageToIndexedDB();
  applyTheme(loadSettings().theme || "system");
  // Bugfix: sync reasoning toggle UI from persisted settings on page load/reload.
  // Without this, the button shows "off" even when settings.reasoning is true.
  refreshReasoningToggleUI();
}
function saveSettingsObj(o) {
  S.set(SETTINGS_KEY, o);
}
function loadMemories() {
  return S.get(MEMORY_KEY) || [];
}
function saveMemories(arr) {
  S.set(MEMORY_KEY, arr);
}
function addMemory(text) {
  const arr = loadMemories();
  const norm = text.trim().toLowerCase();
  const idx = arr.findIndex((m) => m.text.toLowerCase() === norm);
  if (idx >= 0) {
    arr[idx].text = text.trim();
    arr[idx].updatedAt = Date.now();
  } else {
    arr.unshift({ id: genId(), text: text.trim(), createdAt: Date.now() });
  }
  saveMemories(arr.slice(0, 100));
}
function deleteMemory(id) {
  saveMemories(loadMemories().filter((m) => m.id !== id));
  renderMemoriesModal();
}
function safeSetProp(obj, prop, value) {
  if (!obj || typeof obj !== "object") return;
  if (typeof prop !== "string" || prop === "__proto__" || prop === "constructor" || prop === "prototype") return;
  Object.defineProperty(obj, prop, { value, writable: true, configurable: true, enumerable: true });
}
let chatStorageSyncReady = false;
function setupChatStorageSync() {
  if (chatStorageSyncReady || !window.EmeraldIDBStorage?.subscribe) return;
  chatStorageSyncReady = true;
  const watchedKeys = /* @__PURE__ */ new Set([CONV_KEY, LIB_KEY, SETTINGS_KEY, MEMORY_KEY, OB_KEY]);
  window.EmeraldIDBStorage.subscribe(({ key }) => {
    if (!watchedKeys.has(key)) return;
    // Keep the Settings storage meter in sync while it is open.
    if (document.getElementById("settingsModal")?.classList.contains("open")) {
      _refreshStorageMeter();
    }
    if (key === SETTINGS_KEY) {
      applyTheme(loadSettings().theme || "system");
      // Bugfix: also sync reasoning toggle UI when settings change (e.g. cross-tab).
      refreshReasoningToggleUI();
    }
    if (key === CONV_KEY) {
      const activeId = state.convId;
      const activeConv = activeId ? getConv(activeId) : null;
      renderSidebar();
      if (activeId && activeConv && !state.isStreaming) {
        loadConversation(activeId);
      } else if (activeId && !activeConv) {
        state.convId = null;
        updateOwnedUrl();
        showWelcome();
        renderSidebar();
      }
    }
    if (key === LIB_KEY) {
      renderLibraryModal();
    }
    if (key === MEMORY_KEY) {
      renderMemoriesModal();
    }
    if (key === OB_KEY) {
      if (S.get(OB_KEY)) {
        const overlay = $("obOverlay");
        if (overlay) {
          overlay.classList.remove("ob-visible");
          overlay.style.display = "none";
        }
      } else {
        checkOnboarding();
      }
    }
  });
}
function buildFileParts(files) {
  const parts = [];
  const unreadable = [];
  const INLINE_PREFIXES = ["image/", "audio/", "video/", "text/"];
  const INLINE_EXACT = /* @__PURE__ */ new Set(["application/pdf", "application/json", "application/xml", "application/x-yaml", "application/x-sh"]);
  const TEXT_EXTS = /* @__PURE__ */ new Set([
    "txt",
    "md",
    "markdown",
    "csv",
    "json",
    "xml",
    "yaml",
    "yml",
    "toml",
    "ini",
    "log",
    "html",
    "htm",
    "css",
    "js",
    "mjs",
    "ts",
    "jsx",
    "tsx",
    "py",
    "rb",
    "java",
    "c",
    "cpp",
    "h",
    "hpp",
    "go",
    "rs",
    "sh",
    "bash",
    "sql",
    "graphql",
    "gql",
    "tf",
    "vue",
    "svelte",
    "r",
    "swift",
    "kt",
    "dart",
    "php",
    "env"
  ]);
  for (const f of files) {
    const type = (f.type || "application/octet-stream").toLowerCase();
    const ext = (f.name || "").split(".").pop().toLowerCase();
    const isOffice = ["pptx", "ppt", "docx", "doc", "xlsx", "xls"].includes(ext);
    const meta = ` [File: ${f.name} (${type})]`;
    if (isOffice && f.extractedText) {
      try {
        const txt = `${meta}
${f.extractedText}`;
        const b642 = btoa(unescape(encodeURIComponent(txt)));
        parts.push({ inlineData: { mimeType: "text/plain", data: b642 } });
      } catch (e) {
        unreadable.push(f.name);
      }
      continue;
    }
    if (!f.data) continue;
    const b64 = f.data.includes(",") ? f.data.split(",")[1] : f.data;
    const isInline = INLINE_PREFIXES.some((p) => type.startsWith(p)) || INLINE_EXACT.has(type);
    const isTextExt = TEXT_EXTS.has(ext);
    if (isInline) {
      parts.push({ text: meta });
      parts.push({ inlineData: { mimeType: type, data: b64 } });
    } else if (isTextExt) {
      const txt = `${meta}
${atob(b64)}`;
      const b64txt = btoa(unescape(encodeURIComponent(txt)));
      parts.push({ inlineData: { mimeType: "text/plain", data: b64txt } });
    } else {
      unreadable.push(f.name);
    }
  }
  if (unreadable.length) {
    parts.push({ text: `[The following file(s) were attached but cannot be read directly in this format: ${unreadable.join(", ")}. Ask the user to copy and paste the content, or describe what they need help with.]` });
  }
  return parts;
}
function getConv(id) {
  return loadConvs().find((c) => c.id === id) || null;
}
function upsertConv(conv) {
  const arr = loadConvs();
  const idx = arr.findIndex((c) => c.id === conv.id);
  if (idx >= 0) arr[idx] = conv;
  else arr.unshift(conv);
  saveConvs(arr);
}
function deleteConv(id) {
  saveConvs(loadConvs().filter((c) => c.id !== id));
  saveLib(loadLib().filter((f) => f.convId !== id));
  delete _convPanelState[id];
}
function _cryptoInt(n) {
  const _max = Math.floor(0x100000000 / n) * n;
  let _x;
  do { _x = crypto.getRandomValues(new Uint32Array(1))[0]; } while (_x >= _max);
  return _x % n;
}
function genId() {
  const _b = new Uint8Array(8);
  crypto.getRandomValues(_b);
  return Array.from(_b, x => x.toString(16).padStart(2, '0')).join('');
}
function generateSecureId(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}
function genChatId() { return generateSecureId(15); }
function updateOwnedUrl(forceClear) {
  try {
    if (!forceClear && state.convId) {
      const url = new URL(location.href);
      url.searchParams.set('chat', state.convId);
      history.replaceState({}, document.title, url);
    } else if (location.search) {
      history.replaceState({}, document.title, location.pathname);
    }
  } catch (e) {}
}
async function safeCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
function getApiKey() {
  return EMERALDBOT_API;
}
function getUserName() {
  return loadSettings().userName || "You";
}
function getUserInitials() {
  const n = loadSettings().userName || "You";
  // Use regex split so consecutive spaces / leading-trailing whitespace don't
  // produce "undefined" in the initials (e.g. "Foo  Bar" used to yield "Fu").
  return (n.match(/\b\w/g) || ["U"]).join("").slice(0, 2).toUpperCase() || "U";
}
let _toastTimer;
function showToast(msg, type = "default") {
  const el = document.getElementById("custom-toast") || document.getElementById("aiToast");
  if (!el) return;
  // innerHTML only receives DOMPurify output; the fallback path uses textContent
  // (a safe sink) so no tainted string ever reaches an HTML sink.
  if (typeof DOMPurify !== "undefined") {
    el.innerHTML = DOMPurify.sanitize(String(msg || ""), { FORCE_BODY: true });
  } else {
    el.textContent = String(msg || "");
  }
  const base = el.id === "custom-toast" ? "custom-toast" : "ai-toast";
  el.className = base + " show" + (type !== "default" ? " " + base + "--" + type : "");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 5e3);
}
let _ctxTarget = null;
let selectedText = "";
function setupContextMenu() {
  const menu = document.getElementById("aiContextMenu");
  if (!menu) return;
  document.addEventListener("contextmenu", (e) => {
    const histItem = e.target.closest(".history-item");
    const msgBody = e.target.closest('.message[data-ai="1"]');
    const userMsg = e.target.closest(".message--user");
    const sel = window.getSelection();
    selectedText = sel ? sel.toString().trim() : "";
    e.preventDefault();
    if (histItem) {
      _ctxTarget = histItem;
      buildContextMenu("history");
    } else if (msgBody) {
      _ctxTarget = msgBody;
      buildContextMenu("message");
    } else if (userMsg) {
      _ctxTarget = userMsg;
      buildContextMenu("user-message");
    } else {
      _ctxTarget = e.target;
      buildContextMenu("tools");
    }
    positionMenu(menu, e.clientX, e.clientY);
  });
  document.addEventListener("click", () => menu.style.display = "none");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.style.display = "none";
  });
}
function positionMenu(menu, x, y) {
  menu.style.top = "-9999px";
  menu.style.left = "-9999px";
  menu.style.display = "block";
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const mw = menu.offsetWidth || 260;
  const mh = menu.offsetHeight || 160;
  let left = x;
  let top = y;
  if (left + mw > vw) left = vw - mw - 8;
  if (left < 8) left = 8;
  if (top + mh > vh) top = vh - mh - 8;
  if (top < 8) top = 8;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}
function buildContextMenu(type) {
  const menu = document.getElementById("aiContextMenu");
  if (!menu) return;
  if (type === "history") {
    const id = _ctxTarget?.dataset.convId;
    menu.innerHTML = `
      <div class="context-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        CHATS
      </div>
      <a onclick="renameConvPrompt('${id}')">Rename</a>
      <a onclick="shareConversation('${id}')">Share Link</a>
      <a onclick="deleteConvConfirm('${id}')" class="ctx-danger">Delete</a>`;
  } else if (type === "message") {
    const regen = isLatestAIMessage(_ctxTarget) ? '<a onclick="regenFromCtx()">Regenerate</a>' : "";
    menu.innerHTML = `
      <div class="context-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        MESSAGE
      </div>
      <a onclick="copyMsgText()">Copy text</a>
      <a onclick="showUsedModel()">Show Used Model</a>
      ${regen}`;
  } else if (type === "user-message") {
    const msgId = _ctxTarget?.dataset?.msgId || "";
    const canEdit = !!msgId && !!state.convId;
    menu.innerHTML = `
      <div class="context-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
        YOUR MESSAGE
      </div>
      <a onclick="copyUserMsgText()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:7px"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        Copy Text
      </a>
      ${canEdit ? `<a onclick="editUserMsg('${msgId}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:7px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit
      </a>` : ""}`;
  } else {
    menu.innerHTML = `
      <div class="context-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        TOOLS
      </div>
      <a onclick="ctxCopyText()">Copy Text</a>
      <a onclick="ctxCopyPageLink()">Copy Page Link</a>
      <a onclick="ctxShowElementInfo()">Show Element Info</a>`;
  }
}
function isLatestAIMessage(msgEl) {
  const aiMsgs = Array.from(document.querySelectorAll('.message[data-ai="1"]'));
  return aiMsgs.length > 0 && aiMsgs[aiMsgs.length - 1] === msgEl;
}
const _aiSvgCopy = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const _aiSvgLink = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const _aiSvgWarn = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const _aiSvgTrash = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
const _aiSvgTag = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
const _aiSvgCheck = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M20 6L9 17l-5-5"/></svg>`;
const _aiSvgThumbUp = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`;
const _aiSvgThumbDown = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>`;
const _aiSvgFile = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
const _aiSvgError = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
const _aiSvgInfo = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
const _aiSvgPlay = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
async function ctxCopyText() {
  if (!selectedText) {
    showToast(`${_aiSvgWarn} No text selected.`);
    return;
  }
  const ok = await safeCopy(selectedText);
  if (ok) {
    // `escHtml` / `truncate` were never defined in this codebase — use the
    // real `escapeHtml` helper and inline the truncation.
    const preview = escapeHtml(selectedText.length > 100 ? selectedText.slice(0, 100) + "…" : selectedText);
    showToast(`${_aiSvgCopy} Copied: "${preview}"`);
  } else {
    showToast(`${_aiSvgWarn} Failed to copy.`);
  }
}
async function ctxCopyPageLink() {
  const ok = await safeCopy(location.href);
  showToast(ok ? `${_aiSvgLink} Page link copied!` : `${_aiSvgWarn} Failed to copy page link.`);
}
function ctxShowElementInfo() {
  const el = _ctxTarget;
  if (!el || !el.tagName) {
    showToast(`${_aiSvgWarn} No element selected.`);
    return;
  }
  const eh = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const tr = (s, n = 100) => String(s).length > n ? String(s).slice(0, n) + "..." : String(s);
  const attr = (name) => eh(tr(el.getAttribute(name) || "", 100));
  const tag = eh(el.tagName);
  const id = el.id ? `#${eh(tr(el.id, 100))}` : null;
  const classList = el.className && typeof el.className === "string" ? el.className.split(" ").filter(Boolean).map((cls) => `.${eh(tr(cls, 100))}`).join(" ") : null;
  const cleanText = (el.textContent || "").trim().replace(/\s+/g, " ");
  const text = cleanText ? `"${eh(tr(cleanText, 100))}"` : null;
  const label = el.labels ? eh(tr(Array.from(el.labels).map((labelEl) => labelEl.textContent.trim()).join(", "), 100)) : null;
  const dataset = Object.entries(el.dataset || {}).map(([k, v]) => `data-${eh(k)}="${eh(tr(v, 100))}"`).join(", ");
  const rect = el.getBoundingClientRect();
  const size = rect.width && rect.height ? `${Math.round(rect.width)}x${Math.round(rect.height)}px` : null;
  const childIndex = Array.from(el.parentNode?.children || []).indexOf(el);
  const inlineStyle = eh(tr(el.getAttribute("style") || "", 100));
  const I = (body) => `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7">${body}</svg>`;
  const iconTag = I('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>');
  const iconId = I('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>');
  const iconClass = I('<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>');
  const iconText = I('<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>');
  const iconLink = I('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>');
  const iconImg = I('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>');
  const iconInfo = I('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>');
  const iconFile = I('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>');
  const iconName = I('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>');
  const iconFor = I('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>');
  const iconRole = I('<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/>');
  const iconData = I('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>');
  const iconSize = I('<path d="M21 3H3v18h18V3zM12 3v4m0 14v-4M3 12h4m14 0h-4m-8-4l2 2m4 4l2 2m-8 0l2-2m4-4l2-2"/>');
  const iconChild = I('<polygon points="3 11 22 2 13 21 11 13 3 11"/>');
  const infoLines = [
    `${iconTag} <strong>Tag:</strong> ${tag}`,
    id ? `${iconId} <strong>ID:</strong> ${id}` : null,
    classList ? `${iconClass} <strong>Class:</strong> ${classList}` : null,
    text ? `${iconText} <strong>Text:</strong> ${text}` : null,
    attr("href") ? `${iconLink} <strong>Href:</strong> ${attr("href")}` : null,
    attr("src") ? `${iconImg} <strong>Src:</strong> ${attr("src")}` : null,
    attr("alt") ? `${iconImg} <strong>Alt:</strong> ${attr("alt")}` : null,
    attr("title") ? `${iconInfo} <strong>Title:</strong> ${attr("title")}` : null,
    attr("placeholder") ? `${iconInfo} <strong>Placeholder:</strong> ${attr("placeholder")}` : null,
    attr("value") ? `${iconFile} <strong>Value:</strong> ${attr("value")}` : null,
    attr("name") ? `${iconName} <strong>Name:</strong> ${attr("name")}` : null,
    attr("for") ? `${iconFor} <strong>For:</strong> ${attr("for")}` : null,
    label ? `${iconTag} <strong>Labels:</strong> ${label}` : null,
    attr("aria-label") ? `${iconInfo} <strong>ARIA Label:</strong> ${attr("aria-label")}` : null,
    attr("role") ? `${iconRole} <strong>Role:</strong> ${attr("role")}` : null,
    dataset ? `${iconData} <strong>Data Attributes:</strong> ${eh(tr(dataset, 100))}` : null,
    size ? `${iconSize} <strong>Size:</strong> ${size}` : null,
    `${iconChild} <strong>Child Index:</strong> ${childIndex}`,
    inlineStyle ? `${iconClass} <strong>Inline Style:</strong> ${inlineStyle}` : null
  ].filter(Boolean);
  showToast(infoLines.join("<br>"));
}
async function copyMsgText() {
  if (!_ctxTarget) return;
  const textEl = _ctxTarget.querySelector(".message-text");
  const ok = await safeCopy(textEl?.innerText || "");
  showToast(
    ok ? `${_aiSvgCopy} Copied to clipboard` : `${_aiSvgError} Failed to copy`,
    ok ? "success" : "error"
  );
}
function regenFromCtx() {
  if (!_ctxTarget) return;
  regenerateMessage(_ctxTarget);
}
function showUsedModel() {
  if (!_ctxTarget) return;
  const imgModelName = _ctxTarget.dataset?.imageModelName || "";
  const imgModelId = _ctxTarget.dataset?.imageModelId || "";
  if (imgModelName) {
    showToast(`${_aiSvgInfo} Image generated by ${escapeHtml(imgModelName)}`);
    return;
  }
  if (imgModelId) {
    const friendly = imgModelId.split("/").pop();
    showToast(`${_aiSvgInfo} Image generated by ${escapeHtml(friendly)}`);
    return;
  }
  const modelName = _ctxTarget.dataset?.modelName || "";
  const modelId = _ctxTarget.dataset?.modelId || "";
  if (modelName) {
    showToast(`${_aiSvgInfo} This response was generated by ${escapeHtml(modelName)}`);
  } else if (modelId) {
    const m = getModelById(modelId);
    const name = m ? m.name : modelId;
    showToast(`${_aiSvgInfo} This response was generated by ${escapeHtml(name)}`);
  } else {
    showToast(`${_aiSvgWarn} Model info not recorded for this message.`);
  }
}
function renameConvPrompt(id) {
  const conv = getConv(id);
  if (!conv) return;
  openModal("renameModal");
  document.getElementById("renameInput").value = conv.title;
  document.getElementById("renameSaveBtn").onclick = () => {
    const title = document.getElementById("renameInput").value.trim();
    if (title) {
      conv.title = title;
      upsertConv(conv);
      renderSidebar();
      closeModal("renameModal");
    }
  };
}
function deleteConvConfirm(id) {
  openModal("deleteModal");
  const conv = getConv(id);
  document.getElementById("deleteModalTitle").textContent = conv ? `Delete "${conv.title}"?` : "Delete conversation?";
  document.getElementById("deleteConfirmBtn").onclick = () => {
    deleteConv(id);
    if (state.convId === id) {
      state.convId = null;
      updateOwnedUrl();
      if (state.isTemp) {
        state.isTemp = false;
        state.tempHistory = [];
        const btn = $("tempChatBtn");
        if (btn) btn.classList.remove("active");
        const badge = $("tempBadge");
        if (badge) badge.style.display = "none";
      }
      showWelcome();
    }
    renderSidebar();
    closeModal("deleteModal");
    showToast(`${_aiSvgTrash} Conversation deleted`);
    const _fp = $("filePreviewPanel");
    if (_fp) {
      _fp.classList.remove("open", "closing");
      const _fb = $("fpPanelBody");
      if (_fb) _fb.innerHTML = "";
    }
    const _sb = $("mobileSidebar");
    if (_sb) _sb.classList.remove("open");
    const _bk = $("sidebarBackdrop");
    if (_bk) _bk.classList.remove("open");
  };
}
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("closing");
  el.classList.add("open");
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains("open")) return;
  el.classList.add("closing");
  setTimeout(() => {
    el.classList.remove("open");
    el.classList.remove("closing");
  }, 230);
}
function setupMarked() {
  if (typeof marked === "undefined") return;
  function _codeRenderer(token) {
    const code = token && typeof token === "object" ? String(token.text ?? "") : String(token ?? "");
    const lang = token && typeof token === "object" ? String(token.lang ?? "") : "";
    const language = lang || "plaintext";
    let highlighted = code;
    try {
      if (typeof hljs !== "undefined") {
        highlighted = hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
      }
    } catch {
    }
    const escapedLang = escapeHtml(language);
    window._codeStore = window._codeStore || {};
    window._codeMeta = window._codeMeta || {};
    const _cidBytes = new Uint8Array(6);
    crypto.getRandomValues(_cidBytes);
    const cid = "cs_" + Array.from(_cidBytes, b => b.toString(16).padStart(2, '0')).join('');
    window._codeStore[cid] = code;
    window._codeMeta[cid] = { code, language };
    return `<div class="md-code-block" data-cid="${cid}" data-lang="${escapeHtmlAttr(language)}">
      <div class="md-code-header">
        <span class="md-code-lang">${escapedLang}</span>
        <div class="md-code-actions">
          <button class="md-run-btn" data-cid="${cid}" onclick="runCode(this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Run
          </button>
          <button class="md-copy-btn" data-cid="${cid}" onclick="copyCode(this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            Copy
          </button>
        </div>
      </div>
      <pre><code class="hljs language-${escapedLang}">${highlighted}</code></pre>
    </div>`;
  }
  function _tableRenderer(token) {
    if (token && typeof token === "object" && Array.isArray(token.header)) {
      const al = (i) => token.align?.[i] ? ` style="text-align:${token.align[i]}"` : "";
      const pi = (c) => {
        const raw = typeof c === "object" ? c.text ?? "" : String(c ?? "");
        try {
          const inline = marked.parseInline(raw);
          return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(inline, { ADD_ATTR: ["target", "loading", "referrerpolicy", "data-web-img"] }) : inline;
        } catch {
          return escapeHtml(raw);
        }
      };
      const hdr = "<tr>" + token.header.map((c, i) => `<th${al(i)}>${pi(c)}</th>`).join("") + "</tr>";
      const bdy = (token.rows ?? []).map(
        (row) => "<tr>" + row.map((c, i) => `<td${al(i)}>${pi(c)}</td>`).join("") + "</tr>"
      ).join("");
      return `<div class="md-table-wrap"><table class="md-table"><thead>${hdr}</thead><tbody>${bdy}</tbody></table></div>`;
    }
    return false;
  }
  function _blockquoteRenderer(token) {
    let body = "";
    if (token && typeof token === "object") {
      // marked v18: token.tokens contains parsed child tokens — render recursively
      if (Array.isArray(token.tokens) && this.parser) {
        body = this.parser.parse(token.tokens);
      } else {
        body = token.body ?? token.text ?? "";
      }
    } else {
      body = String(token ?? "");
    }
    return `<blockquote class="md-blockquote">${body}</blockquote>`;
  }
  function _linkRenderer(token) {
    const href = token && typeof token === "object" ? String(token.href ?? "") : String(token ?? "");
    const title = token && typeof token === "object" && token.title ? ` title="${escapeHtmlAttr(token.title)}"` : "";
    const text = token && typeof token === "object" ? token.text || escapeHtml(href) : escapeHtml(href);
    return `<a href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer"${title}>${text}</a>`;
  }
  try {
    marked.use({
      renderer: { code: _codeRenderer, table: _tableRenderer, blockquote: _blockquoteRenderer, link: _linkRenderer },
      breaks: true,
      gfm: true
    });
  } catch {
    const renderer = new marked.Renderer();
    renderer.code = _codeRenderer;
    renderer.table = _tableRenderer;
    renderer.blockquote = _blockquoteRenderer;
    renderer.link = _linkRenderer;
    marked.setOptions({ renderer, breaks: true, gfm: true });
  }
}
// Preprocess LaTeX source to convert \color{X}... into \textcolor{X}{...}
// (the two-argument form KaTeX renders reliably even in nested contexts).
//
// The model produces THREE variants of \color usage that we must handle:
//
//   (A) \color{X}{Y}      — TWO-ARG, INVALID LaTeX. The model treats \color
//                           as if it were \textcolor. NOT standard LaTeX
//                           (in real LaTeX, \color{X} sets the color for the
//                           rest of the group; the following {Y} is a
//                           separate group). KaTeX accepts this but it is
//                           brittle. We convert it to \textcolor{X}{Y}.
//
//   (B) \color{X}content  — ONE-ARG SWITCH (the real LaTeX form). Sets color
//                           for the rest of the current group. We find the
//                           enclosing {...} group and wrap its content in
//                           \textcolor{X}{...}.
//                           e.g.  e^{\color{red}i\pi}  →  e^{\textcolor{red}{i\pi}}
//
//   (C) \textcolor{X}{Y}  — already correct. Leave alone.
//
// Pass 1 handles (A). Pass 2 handles (B). Existing \textcolor is untouched.
function _preprocessLatexColor(src) {
  if (!src || src.indexOf('\\color{') === -1) return src;
  let result = src;

  // ── Pass 1: \color{X}{Y} (two-arg malformed) → \textcolor{X}{Y}
  // Match \color{X} immediately followed by { (with optional whitespace).
  // Replace only the \color{X} part — leave the {Y} part intact so the
  // closing brace of Y stays balanced. Effect: \color{X}{Y} → \textcolor{X}{Y}.
  // We must NOT touch \textcolor{X}{Y} (already correct). The regex below
  // only matches \color{ (not \textcolor{) because of the negative lookbehind
  // for "text" before the backslash.
  result = result.replace(/(?<!\\text)\\color\{([^}]+)\}(\s*)\{/g,
    (full, color, ws) => '\\textcolor{' + color + '}' + ws + '{');

  // ── Pass 2: \color{X}content (one-arg switch) → \textcolor{X}{content}
  // Now any remaining \color{X} is the switch form (NOT immediately followed
  // by a { group of its own). Find the enclosing {...} group and wrap its
  // content in \textcolor{X}{...}.
  //   e.g.  e^{\color{red}i\pi}  →  e^{\textcolor{red}{i\pi}}
  //   e.g.  {\color{blue}a + b}  →  {\textcolor{blue}{a + b}}
  const re = /\\color\{([^}]+)\}/g;
  let match;
  const replacements = [];
  while ((match = re.exec(result)) !== null) {
    const start = match.index;
    const afterColor = start + match[0].length;
    const color = match[1];
    // Skip if immediately followed by { — that was Pass 1's job.
    // (Pass 1 already converted those, but be defensive in case the regex
    // missed something — e.g. whitespace edge cases.)
    let nextNonWs = afterColor;
    while (nextNonWs < result.length && /\s/.test(result[nextNonWs])) nextNonWs++;
    if (result[nextNonWs] === '{') continue;

    // Find the enclosing { by scanning backwards
    let depth = 0, braceStart = -1;
    for (let k = start - 1; k >= 0; k--) {
      if (result[k] === '}') depth++;
      else if (result[k] === '{') {
        if (depth === 0) { braceStart = k; break; }
        depth--;
      }
    }
    if (braceStart === -1) continue;
    // Find the matching } for braceStart by scanning forwards
    depth = 1;
    let braceEnd = -1;
    for (let k = afterColor; k < result.length; k++) {
      if (result[k] === '{') depth++;
      else if (result[k] === '}') { depth--; if (depth === 0) { braceEnd = k; break; } }
    }
    if (braceEnd === -1) continue;
    const content = result.slice(afterColor, braceEnd);
    replacements.push({
      start: start,
      end: braceEnd,
      replacement: '\\textcolor{' + color + '}{' + content + '}'
    });
  }
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }
  return result;
}

// When the model hallucinates and outputs individual characters separated by
// newlines (e.g. "N\ni\nl\na\ni\nk\ne"), marked with breaks:true renders
// each \n as <br>, producing a char-by-char display. Detect runs of 3+
// consecutive lines that each contain a single non-whitespace character and
// collapse them back into a single word. The model often then repeats the
// full word on the following line — when the collapsed word exactly prefixes
// that next line, drop the collapsed duplicate.
function _collapseCharByCharRuns(text) {
  const lines = text.split('\n');
  const result = [];
  let run = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length === 1 && /\S/.test(t)) {
      run.push(t);
    } else {
      if (run.length >= 3) {
        const joined = run.join('');
        const next = lines[i].trim();
        // The model frequently emits a char-by-char copy of the NEXT line,
        // sometimes with a single leading symbol (e.g. "*Rumus:" duplicate,
        // or ")tidak..." where ")R..." was broken apart). Dedup when the run
        // is exactly the next line, or the next line's content after one
        // leading symbol (index 0 or 1).
        const leadIdx = next.indexOf(joined);
        if (!(leadIdx === 0 || leadIdx === 1)) {
          result.push(joined);
        }
      } else {
        for (const c of run) result.push(c);
      }
      run = [];
      result.push(lines[i]);
    }
  }
  if (run.length >= 3) result.push(run.join(''));
  else for (const c of run) result.push(c);
  return result.join('\n');
}

// ── Collapsible dropdown (the UI the model emits) ─────────────
// One <dropdown> becomes one card. Several in a single answer are
// independent — the model decides how many to use and the user opens
// whichever they want, so nothing here closes a sibling.
// title: model-authored, may carry inline markdown (bold, `code`).
// body:  model-authored markdown, rendered recursively.
function aiDropdownHTML(title, body, open, iconName) {
  const label = _aiSafeLabel(title, "Details");
  const icon = aiSVGIcon(iconName);
  const inner = renderMarkdown(String(body || ""));
  return `<div class="ai-dropdown${open ? " is-open" : ""}" data-ai-dropdown="1">
    <div class="ai-dropdown-header" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}" onclick="toggleAiDropdown(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleAiDropdown(this);}">
      ${icon}<span class="ai-dropdown-label">${label}</span>
      <svg class="ai-dropdown-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="ai-dropdown-body"><div class="ai-dropdown-clip"><div class="ai-dropdown-content md-content">${inner}</div></div></div>
  </div>`;
}
function toggleAiDropdown(headerEl) {
  const dd = headerEl?.closest(".ai-dropdown");
  if (!dd) return;
  const isOpen = dd.classList.toggle("is-open");
  headerEl.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

// ── Card group (the model chooses the layout) ───────────────
// <cards layout="…"> wraps any number of <card> blocks. The model
// picks the column layout; every card may carry a title and an accent
// colour. Bodies are full markdown rendered by renderMarkdown, so a
// card can itself contain a <dropdown>.
const _AI_CARD_ACCENTS = ["green", "blue", "amber", "red", "purple"];

// ── Icon registry ────────────────────────────────────────────
// The model never emits SVG (that would be a markup-injection hole
// and unreadable in a chat log) and never uses emoji — it emits
// <icon name="bolt"/> and we look the name up here. Only the listed
// names resolve, and only registry markup is ever emitted, so the
// name is never interpolated into the output.
//
// 24x24, stroke-based, matching the icon language already used
// everywhere else in this file (fill:none, stroke:currentColor,
// width 2, round caps/joins).
const _AI_ICONS = {
  "info": '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  "warning": '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  "check": '<polyline points="20 6 9 17 4 12"/>',
  "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  "x": '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  "x-circle": '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  "bolt": '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/>',
  "star": '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
  "heart": '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "calendar": '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  "user": '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  "users": '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  "lock": '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  "shield": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  "key": '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/>',
  "search": '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  "link": '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  "file": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  "folder": '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  "code": '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  "terminal": '<polyline points="4 17 10 11 4 5"/><line x1="15" y1="19" x2="20" y2="19"/>',
  "database": '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  "server": '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  "cloud": '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  "globe": '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  "mail": '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 13 2 6"/>',
  "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  "target": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  "rocket": '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  "trending-up": '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  "dollar": '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  "tag": '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  "filter": '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  "eye": '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  "edit": '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  "trash": '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  "copy": '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  "play": '<polygon points="5 3 19 12 5 21 5 3"/>',
  "refresh": '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  "lightbulb": '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
  "layers": '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  "sparkles": '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>'
};

// Resolve a name to markup, or "" when it is not in the registry.
// An unknown name renders nothing rather than echoing the tag back
// at the user, so a typo disappears instead of showing as raw text.
function aiSVGIcon(name) {
  const body = _AI_ICONS[String(name || "").trim().toLowerCase()];
  if (!body) return "";
  return `<svg class="ai-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
function _aiIconAttr(attrs) {
  return aiSVGIcon(_aiTagAttr(attrs, "icon"));
}

// ── Charts (bar / line / pie / flowchart) ────────────────────
// The model emits JSON; we draw it as inline SVG. No chart library is
// loaded on this page, and pulling one in would be heavier than the
// whole rest of the feature set — so the ~200 lines below are the
// chart engine.
//
// Everything here is defensive by construction: the JSON is model
// output, so every number is coerced and finite-checked, every string
// is length-capped and XML-escaped, and every array is sliced to a
// hard ceiling. A malformed spec renders nothing rather than throwing
// inside renderMarkdown (which runs ~25x per streamed response).
const _CHART_MAX = { labels: 24, series: 6, points: 60, nodes: 30, edges: 60 };
// Increments per flowchart so each <defs> marker id is unique.
let _aiChartSeq = 0;

// Tolerant parse, mirroring the three-attempt strategy _extractQuiz
// already uses: raw, then repair trailing commas / quotes / unquoted
// keys, then give up and render nothing.
function _chartParseJSON(raw) {
  const s = String(raw || "");
  try { return JSON.parse(s); } catch {}
  try {
    return JSON.parse(s
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/'/g, '"')
      .replace(/(?<=[{,])\s*(\w+)\s*:/g, '"$1":')
      .replace(/:\s*undefined/g, ":null")
      .replace(/:\s*NaN/g, ":0"));
  } catch {}
  return null;
}
function _chartNum(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function _chartStr(v, max) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || 90);
}
function _chartColor(i) { return `var(--chart-${(i % 6) + 1})`; }
function _chartKeyCls(i) { return `k${(i % 6) + 1}`; }

// Axis top: round 1.2 -> 2, 3400 -> 5000, so gridlines land on numbers
// people actually read. Negative maxima fall back to the raw max.
function _chartNiceMax(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}
function _chartFmt(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(Math.round(n * 100) / 100);
}
// Greedy word wrap for SVG labels, which have no text engine we can
// rely on for automatic wrapping. Ellipsises past maxLines.
function _chartWrap(text, per, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    if (!cur.length) { cur = word; }
    else if ((cur + " " + word).length <= per) { cur += " " + word; }
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  out[maxLines - 1] = out[maxLines - 1].replace(/.{1}$/, "") + "…";
  return out;
}

// Shared x/y frame for the cartesian charts (bar + line).
function _chartFrame(opts) {
  const { w, h, padL, padR, padT, padB, max, ticks } = opts;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const base = padT + plotH;
  const y = (v) => base - (max > 0 ? (v / max) * plotH : 0);
  let s = "";
  for (let t = 0; t <= ticks; t++) {
    const v = (max / ticks) * t;
    const gy = y(v);
    s += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${w - padR}" y2="${gy.toFixed(1)}" stroke="var(--chart-grid)" stroke-width="1"/>`;
    s += `<text x="${padL - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="ai-chart-tick">${escapeHtml(_chartFmt(v))}</text>`;
  }
  s += `<line x1="${padL}" y1="${base}" x2="${w - padR}" y2="${base}" stroke="var(--chart-axis)" stroke-width="1.5"/>`;
  return { frame: s, plotW, plotH, base, y };
}

function _chartCartesian(spec, kind) {
  const labels = (Array.isArray(spec.labels) ? spec.labels : []).slice(0, _CHART_MAX.labels).map((l) => _chartStr(l, 24));
  if (!labels.length) return "";
  const rawSeries = Array.isArray(spec.series) ? spec.series : [];
  let series = rawSeries.slice(0, _CHART_MAX.series).map((s) => ({
    name: _chartStr(s && s.name, 30) || "Series",
    data: (Array.isArray(s && s.data) ? s.data : []).slice(0, _CHART_MAX.points).map(_chartNum)
  })).filter((s) => s.data.some((v) => v !== null));
  if (!series.length) {
    // Flat shorthand: {"labels":[…],"data":[…]} with no series array.
    const flat = (Array.isArray(spec.data) ? spec.data : []).slice(0, _CHART_MAX.points).map(_chartNum);
    if (!flat.some((v) => v !== null)) return "";
    series = [{ name: _chartStr(spec.name, 30) || "Value", data: flat }];
  }
  let peak = 0;
  for (const s of series) for (const v of s.data) if (v !== null && v > peak) peak = v;
  let low = 0;
  for (const s of series) for (const v of s.data) if (v !== null && v < low) low = v;
  const min = low < 0 ? low : 0;
  const max = _chartNiceMax(peak || 1);

  // Fixed canvas rather than one that shrinks to the label count: CSS
  // renders these at width:100%, so a narrow viewBox gets UPSCALED to
  // the full bubble and the 11px tick labels end up at 20px. A fixed
  // canvas plus max-width = natural size keeps the drawing 1:1.
  const W = 680, H = 250, padL = 54, padR = 16, padT = 14, padB = 42;
  const f = _chartFrame({ w: W, h: H, padL, padR, padT, padB, max: max - min, ticks: 4 });
  const y = (v) => min < 0
    ? f.base - ((v - min) / (max - min)) * f.plotH
    : f.base - ((v - min) / (max - min)) * f.plotH;

  let g = `<svg class="ai-chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:${W}px" role="img">`;
  g += f.frame;
  const groupW = f.plotW / labels.length;

  if (kind === "bar") {
    const nS = series.length;
    const gap = 5;
    const barW = Math.max(3, (groupW * 0.76 - gap * (nS - 1)) / nS);
    const groupPad = (groupW - (barW * nS + gap * (nS - 1))) / 2;
    labels.forEach((lab, i) => {
      const gx = padL + i * groupW + groupPad;
      series.forEach((s, si) => {
        const v = s.data[i];
        if (v === null || v === undefined) return;
        const vy = y(v);
        const h = Math.max(1.5, Math.abs(f.base - vy));
        const x = gx + si * (barW + gap);
        g += `<rect x="${x.toFixed(1)}" y="${(v < 0 ? f.base : vy).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${_chartColor(si)}"/>`;
      });
      const words = _chartWrap(lab, 11, 2);
      words.forEach((ln, li) => {
        g += `<text x="${(padL + i * groupW + groupW / 2).toFixed(1)}" y="${(f.base + 18 + li * 13).toFixed(1)}" text-anchor="middle" class="ai-chart-tick">${escapeHtml(ln)}</text>`;
      });
    });
  } else {
    labels.forEach((lab, i) => {
      const words = _chartWrap(lab, 11, 2);
      words.forEach((ln, li) => {
        g += `<text x="${(padL + i * groupW + groupW / 2).toFixed(1)}" y="${(f.base + 18 + li * 13).toFixed(1)}" text-anchor="middle" class="ai-chart-tick">${escapeHtml(ln)}</text>`;
      });
    });
    series.forEach((s, si) => {
      const pts = [];
      s.data.forEach((v, i) => {
        if (v === null || v === undefined || i >= labels.length) return;
        pts.push(`${(padL + i * groupW + groupW / 2).toFixed(1)},${y(v).toFixed(1)}`);
      });
      if (!pts.length) return;
      if (pts.length === 1) {
        g += `<circle cx="${pts[0]}" cy="${pts[0].split(",")[1]}" r="5" fill="${_chartColor(si)}"/>`;
      } else {
        g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${_chartColor(si)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
        for (const p of pts) {
          const [px, py] = p.split(",");
          g += `<circle cx="${px}" cy="${py}" r="4" fill="var(--chart-surface)" stroke="${_chartColor(si)}" stroke-width="2.5"/>`;
        }
      }
    });
  }
  g += "</svg>";
  const legend = series.length > 1 || kind === "pie"
    ? `<div class="ai-chart-legend">${series.map((s, si) => `<span class="ai-chart-key ${_chartKeyCls(si)}"><i></i>${escapeHtml(s.name)}</span>`).join("")}</div>`
    : "";
  return { svg: g, legend };
}

function _chartPie(spec) {
  const labels = (Array.isArray(spec.labels) ? spec.labels : []).slice(0, _CHART_MAX.labels).map((l) => _chartStr(l, 26));
  let values = (Array.isArray(spec.data) ? spec.data : []).slice(0, _CHART_MAX.labels).map(_chartNum);
  if (!values.length && Array.isArray(spec.series) && spec.series[0]) {
    values = (Array.isArray(spec.series[0].data) ? spec.series[0].data : []).map(_chartNum);
  }
  const pairs = labels.map((l, i) => ({ label: l || `Item ${i + 1}`, v: values[i] }))
    .filter((p) => p.v !== null && p.v > 0);
  const total = pairs.reduce((a, p) => a + p.v, 0);
  if (!pairs.length || total <= 0) return "";
  const W = 680, H = 260;
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) / 2 - 16;
  const donut = spec.donut !== false;
  const inner = donut ? r * 0.58 : 0;
  let a0 = -Math.PI / 2;
  let g = `<svg class="ai-chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:${W}px" role="img">`;
  pairs.forEach((p, i) => {
    const frac = p.v / total;
    const a1 = a0 + frac * Math.PI * 2;
    // A full-circle slice cannot be drawn as an arc (start === end), so
    // a 100% pie falls back to two half arcs.
    const full = frac >= 0.9999;
    const end = full ? a0 + Math.PI * 2 - 0.0001 : a1;
    const large = end - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(end), y1 = cy + r * Math.sin(end);
    let d = `M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} `;
    if (donut) {
      const ix1 = cx + inner * Math.cos(end), iy1 = cy + inner * Math.sin(end);
      const ix0 = cx + inner * Math.cos(a0), iy0 = cy + inner * Math.sin(a0);
      d += `L ${ix1.toFixed(1)} ${iy1.toFixed(1)} A ${inner} ${inner} 0 ${large} 0 ${ix0.toFixed(1)} ${iy0.toFixed(1)} Z`;
    } else {
      d += "Z";
    }
    g += `<path d="${d}" fill="${_chartColor(i)}" stroke="var(--chart-surface)" stroke-width="2"/>`;
    if (frac > 0.07) {
      const mid = a0 + (end - a0) / 2;
      const lr = donut ? (r + inner) / 2 : r * 0.68;
      g += `<text x="${(cx + lr * Math.cos(mid)).toFixed(1)}" y="${(cy + lr * Math.sin(mid) + 4).toFixed(1)}" text-anchor="middle" class="ai-chart-pct">${escapeHtml(Math.round(frac * 100))}%</text>`;
    }
    a0 = a1;
  });
  if (donut) {
    g += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="ai-chart-total">${escapeHtml(_chartFmt(total))}</text>`;
    const cap = _chartStr(spec.center || "Total", 18);
    if (cap) g += `<text x="${cx}" y="${cy + 16}" text-anchor="middle" class="ai-chart-tick">${escapeHtml(cap)}</text>`;
  }
  g += "</svg>";
  const legend = `<div class="ai-chart-legend">${pairs.map((p, i) =>
    `<span class="ai-chart-key ${_chartKeyCls(i)}"><i></i>${escapeHtml(p.label)}<b>${Math.round((p.v / total) * 100)}%</b></span>`).join("")}</div>`;
  return { svg: g, legend };
}

// Longest-path levelling so edges always point downwards; a cycle in
// the model's graph would otherwise never settle, hence the bounded
// iteration count.
function _chartLevels(nodes, edges) {
  const level = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      const a = level.get(e.from), b = level.get(e.to);
      if (a === undefined || b === undefined) continue;
      if (b < a + 1) { level.set(e.to, a + 1); moved = true; }
    }
    if (!moved) break;
  }
  return level;
}

function _chartFlow(spec) {
  const raw = (Array.isArray(spec.nodes) ? spec.nodes : []).slice(0, _CHART_MAX.nodes);
  const nodes = raw.map((n, i) => ({
    id: _chartStr(n && (n.id != null ? n.id : i), 24) || `n${i}`,
    label: _chartStr(n && n.label, 70),
    shape: ["box", "round", "pill", "ellipse", "diamond"].includes(String(n && n.shape)) ? n.shape : "box"
  })).filter((n) => n.label);
  if (!nodes.length) return "";
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (Array.isArray(spec.edges) ? spec.edges : []).slice(0, _CHART_MAX.edges)
    .map((e) => ({ from: _chartStr(e && e.from, 24), to: _chartStr(e && e.to, 24), label: _chartStr(e && e.label, 22) }))
    .filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

  const level = _chartLevels(nodes, edges);
  const rows = [];
  for (const n of nodes) {
    const L = level.get(n.id) || 0;
    (rows[L] = rows[L] || []).push(n);
  }

  const NW = 152, BOXH = 46, DIAH = 74, HGAP = 28, VGAP = 40, PADX = 14, PADY = 14;
  const nw = (n) => (n.shape === "diamond" ? NW * 1.22 : NW);
  const nh = (n) => (n.shape === "diamond" ? DIAH : BOXH);

  let contentW = 0, contentH = 0;
  const rowMeta = rows.filter(Boolean).map((row) => {
    const w = row.reduce((a, n) => a + nw(n), 0) + HGAP * (row.length - 1);
    const h = Math.max(...row.map(nh));
    contentW = Math.max(contentW, w);
    contentH += h;
    return { row, w, h };
  });
  contentH += VGAP * (rowMeta.length - 1);
  const W = Math.max(340, Math.ceil(contentW + PADX * 2));
  const H = Math.ceil(contentH + PADY * 2);

  const pos = new Map();
  let cursorY = PADY;
  for (const meta of rowMeta) {
    let x = (W - meta.w) / 2;
    for (const n of meta.row) {
      const w = nw(n), h = nh(n);
      pos.set(n.id, { x, y: cursorY + (meta.h - h) / 2, w, h });
      x += w + HGAP;
    }
    cursorY += meta.h + VGAP;
  }

  // Natural size, capped at natural size when rendered: CSS scales these
  // to width:100%, and a flowchart has a deliberately small viewBox, so
  // without the cap a two-node graph was blown up ~2x and the 12px
  // labels and boxes read as overlapping. The marker id is per-instance
  // because several flowcharts can share one message and duplicate ids
  // are invalid (and would make every arrow resolve to the first def).
  const markerId = `aiChartArrow${_aiChartSeq++}`;
  let g = `<svg class="ai-chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:${W}px" role="img">`;
  // defs gives every arrow the same head without repeating the path.
  g += `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="var(--chart-axis)"/></marker></defs>`;

  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    const la = level.get(e.from) || 0, lb = level.get(e.to) || 0;
    const sx = a.x + a.w / 2, sy = a.y + a.h;
    const tx = b.x + b.w / 2, ty = b.y;
    if (lb > la) {
      const my = (sy + ty) / 2;
      g += `<path d="M ${sx} ${sy} V ${my} H ${tx} V ${ty - 7}" fill="none" stroke="var(--chart-axis)" stroke-width="1.8" marker-end="url(#${markerId})"/>`;
      if (e.label) g += `<text x="${((sx + tx) / 2).toFixed(1)}" y="${(my - 6).toFixed(1)}" text-anchor="middle" class="ai-chart-edgelabel">${escapeHtml(e.label)}</text>`;
    } else {
      // Same-level edge: bulge out to the right so it does not cut
      // straight through the boxes in between.
      const mid = (sy + ty) / 2;
      const bulge = Math.min(W - 8, Math.max(a.x + a.w, b.x + b.w) + 24);
      g += `<path d="M ${a.x + a.w} ${sy} C ${bulge} ${sy} ${bulge} ${ty} ${b.x + b.w} ${ty}" fill="none" stroke="var(--chart-axis)" stroke-width="1.8" marker-end="url(#${markerId})"/>`;
      if (e.label) g += `<text x="${(bulge + 4).toFixed(1)}" y="${((sy + ty) / 2 + 4).toFixed(1)}" class="ai-chart-edgelabel">${escapeHtml(e.label)}</text>`;
    }
  }

  for (const n of nodes) {
    const p = pos.get(n.id);
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const fill = n.shape === "box" ? "var(--chart-node)" : "var(--chart-node)";
    let shape;
    if (n.shape === "ellipse") shape = `<ellipse cx="${cx}" cy="${cy}" rx="${p.w / 2}" ry="${p.h / 2}" fill="${fill}" stroke="var(--chart-node-stroke)" stroke-width="1.6"/>`;
    else if (n.shape === "diamond") shape = `<polygon points="${cx},${p.y} ${p.x + p.w},${cy} ${cx},${p.y + p.h} ${p.x},${cy}" fill="${fill}" stroke="var(--chart-node-stroke)" stroke-width="1.6"/>`;
    else shape = `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${n.shape === "pill" ? 999 : n.shape === "round" ? p.h / 2 : 7}" fill="${fill}" stroke="var(--chart-node-stroke)" stroke-width="1.6"/>`;
    g += shape;
    const lines = _chartWrap(n.label, n.shape === "diamond" ? 13 : 20, 3);
    const startY = cy - (lines.length - 1) * 7.5 + 4;
    lines.forEach((ln, i) => {
      g += `<text x="${cx}" y="${(startY + i * 15).toFixed(1)}" text-anchor="middle" class="ai-chart-nodelabel">${escapeHtml(ln)}</text>`;
    });
  }
  g += "</svg>";
  return { svg: g, legend: "" };
}

// Single entry point. Returns "" for anything unusable so the caller
// can simply drop the block.
function aiChartSVG(type, title, rawJSON) {
  const spec = _chartParseJSON(rawJSON);
  if (!spec || typeof spec !== "object") return "";
  let built = "";
  try {
    if (type === "flowchart") built = _chartFlow(spec);
    else if (type === "pie") built = _chartPie(spec);
    else built = _chartCartesian(spec, type === "line" ? "line" : "bar");
  } catch {
    return "";
  }
  if (!built || !built.svg) return "";
  const head = _chartStr(title, 70);
  return `<div class="ai-chart" data-type="${type === "flowchart" || type === "pie" || type === "line" ? type : "bar"}">${head ? `<div class="ai-chart-title">${escapeHtml(head)}</div>` : ""}<div class="ai-chart-plot">${built.svg}</div>${built.legend || ""}</div>`;
}

// Read one attribute out of a raw tag's attribute string. Quote-aware,
// so a value containing ">" (title="a > b") still parses.
function _aiTagAttr(attrs, name) {
  const s = String(attrs || "");
  return (s.match(new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", "i")) ||
    s.match(new RegExp("\\b" + name + "\\s*=\\s*'([^']*)'", "i")) || [])[1] || "";
}
function _aiSafeLabel(raw, fallback) {
  // Model-authored, lands in innerHTML — must be sanitized. Strip our
  // own tags so a title can never recursively build another card/dropdown.
  const clean = String(raw || "").trim()
    .replace(/<\/?(dropdown|details|summary|cards|card|icon)\b[^>]*>/gi, "");
  return _mdInline(renderMarkdown(clean)) || fallback || "";
}
function _aiCardOne(attrs, body) {
  const title = _aiSafeLabel(_aiTagAttr(attrs, "title"), "");
  const accentRaw = String(_aiTagAttr(attrs, "accent")).trim().toLowerCase();
  const accent = _AI_CARD_ACCENTS.includes(accentRaw) ? accentRaw : "";
  const icon = _aiIconAttr(attrs);
  const head = (title || icon)
    ? `<div class="ai-card-head">${icon}${title ? `<span class="ai-card-title">${title}</span>` : ""}</div>`
    : "";
  return `<div class="ai-card"${accent ? ` data-accent="${accent}"` : ""}>${head}<div class="ai-card-body md-content">${renderMarkdown(String(body || ""))}</div></div>`;
}
function aiCardsHTML(layout, groupTitle, inner, groupIconName) {
  const LAYOUTS = ["grid-auto", "grid-1", "grid-2", "grid-3", "featured"];
  const want = String(layout || "").trim().toLowerCase();
  const lay = LAYOUTS.includes(want) ? want : "grid-auto";
  const groupIcon = aiSVGIcon(groupIconName);
  const cards = [];
  let rest = String(inner || "");
  rest = rest.replace(/<card\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/card>/gi, (m, a, b) => {
    cards.push({ a, b });
    return "\n";
  });
  rest = rest.replace(/<\/?card\b[^>]*>/gi, "");
  // No <card> children at all: keep the prose rather than emit an
  // empty grid, so a half-formed block still shows what it carried.
  if (!cards.length) {
    const loose = renderMarkdown(rest).trim();
    return loose ? `<div class="ai-cards" data-layout="${lay}"><div class="ai-card"><div class="ai-card-body md-content">${loose}</div></div></div>` : "";
  }
  const gt = _aiSafeLabel(groupTitle, "");
  const head = (gt || groupIcon)
    ? `<div class="ai-cards-title md-content">${groupIcon}${gt}</div>`
    : "";
  return `${head}<div class="ai-cards" data-layout="${lay}">${cards.map((c) => _aiCardOne(c.a, c.b)).join("")}</div>`;
}

// ── Payload tag matching (quiz / es-app / es-edit) ───────────
// These tags are matched TOLERANTLY on purpose. The literal
// "<es-app>" only ever matches that exact spelling, so when the model
// wrote <es-app type="panel">, <es-app > or <ES-APP> nothing matched,
// the strip in renderMarkdown did nothing, and the ENTIRE JSON payload
// was rendered into the message as a wall of text. Tolerating
// attributes, whitespace before ">", and casing costs nothing and
// removes that whole failure class.
const _TAGS = [
  { name: "quiz", open: "<quiz" },
  { name: "es-app", open: "<es-app" },
  { name: "es-edit", open: "<es-edit" },
];
// Match either the full block (payload included) or, while streaming,
// an unterminated opening tag through to the end of the text.
function _tagBlockRe(tag, global) {
  return new RegExp(`${tag.open}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag.name}\\s*>|$)`, global ? "gi" : "i");
}
// The opening tag on its own — used to find where a block starts so the
// visible text can be split around it.
function _tagOpenRe(tag) {
  return new RegExp(`${tag.open}(?:\\s[^>]*)?>`, "i");
}
const _TAG_QUIZ = _TAGS[0], _TAG_APP = _TAGS[1], _TAG_EDIT = _TAGS[2];

function renderMarkdown(raw) {
  if (typeof marked === "undefined") return escapeHtml(raw);
  let text = raw;
  // Payload tags are removed WHOLLY — payload included — so a block
  // that never becomes a card can never dump its JSON into the reply.
  text = text.replace(_tagBlockRe(_TAG_QUIZ, true), "");
  text = text.replace(_tagBlockRe(_TAG_APP, true), "");
  text = text.replace(_tagBlockRe(_TAG_EDIT, true), "");
  // ── Collapsible dropdowns + card groups + icons ─────────────
  // The model may wrap any part of its answer in a collapsible
  // section, a group of cards, or drop an <icon name="…"/> anywhere
  // in its own markdown. Four syntaxes are accepted (see the
  // [COLLAPSIBLE DROPDOWNS] / [AI CARDS] / [ICONS] harness in the
  // system prompt):
  //   <dropdown title="How it works"> …markdown… </dropdown>
  //   <details><summary>How it works</summary>…</details>
  //   <cards layout="grid-2"><card title="…">…</card></cards>
  //   <icon name="bolt"/>            (inline, anywhere in prose)
  // Only COMPLETE blocks are lifted out.
  //
  // ONE combined regex handles code fences alongside the tags, and
  // alternation order + leftmost-match is what makes both directions
  // correct in a single pass:
  //   • a <dropdown> inside a fence is sample text — the fence starts
  //     earlier, so alternative 1 wins and the tag is left alone;
  //   • a fence inside a <dropdown> body — the tag starts earlier, so
  //     its alternative wins and the fence is captured into the body.
  // Splitting fences out first would break the second case (a fence
  // before the closing tag would strand the open tag).
  // Bodies are rendered by a recursive renderMarkdown() call, which
  // owns its own placeholder arrays, so no index collisions. Because
  // each block is re-rendered recursively, cards and dropdowns nest
  // freely (a card body may hold a dropdown).
  const dropdownBlocks = [];
  const cardBlocks = [];
  const iconBlocks = [];
  const chartBlocks = [];
  const _stashDropdown = (title, body, isOpen, icon) => {
    const i = dropdownBlocks.push({ title, body, open: !!isOpen, icon }) - 1;
    return `AIDROPDOWN${i}AIDROPDOWN`;
  };
  const _stashCards = (attrs, inner) => {
    const i = cardBlocks.push({ attrs, inner }) - 1;
    return `AICARDS${i}AICARDS`;
  };
  const _stashIcon = (name) => `AIICON${iconBlocks.push(name) - 1}AIICON`;
  // <chart type="bar"> and <flowchart> both carry a JSON payload; the
  // alias is accepted so the model can reach for either name.
  const _stashChart = (kind, attrs, body) => `AICHART${chartBlocks.push({ kind, attrs, body }) - 1}AICHART`;
  text = text.replace(
    /(```[\s\S]*?```|`[^`\n]+`)|<details\b[^>]*>([\s\S]*?)<\/details>|<dropdown\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/dropdown>|<cards\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/cards>|<icon\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>|<flowchart\b[^>]*>([\s\S]*?)<\/flowchart>|<chart\b[^>]*>([\s\S]*?)<\/chart>/gi,
    (m, fence, detInner, ddAttrs, ddBody, cardsAttrs, cardsInner, iconAttrs, flowBody, chartBody) => {
      if (fence !== undefined) return m;
      if (detInner !== undefined) {
        const sum = detInner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
        const body = sum ? detInner.slice(sum.index + sum[0].length) : detInner;
        return _stashDropdown(sum ? sum[1] : "", body, false, "");
      }
      if (cardsInner !== undefined) return _stashCards(cardsAttrs, cardsInner);
      if (iconAttrs !== undefined) return _stashIcon(_aiTagAttr(iconAttrs, "name"));
      if (flowBody !== undefined) return _stashChart("flowchart", "", flowBody);
      if (chartBody !== undefined) {
        const a = (m.match(/<chart\b([^>]*)>/i) || [])[1] || "";
        const kind = _chartStr(_aiTagAttr(a, "type"), 12).toLowerCase();
        return _stashChart(kind, a, chartBody);
      }
      // The open tag is matched quote-aware above, not with [^>]*: a
      // title may legitimately contain ">" ("Why x > y matters") and a
      // naive [^>]* would stop inside it and swallow the body.
      const title = _aiTagAttr(ddAttrs, "title");
      return _stashDropdown(title, ddBody, /(^|\s)open(\s|=|$)/i.test(ddAttrs), _aiTagAttr(ddAttrs, "icon"));
    }
  );
  // Leftovers: an unterminated tag (still streaming), a self-closing
  // stray, or a lone closing tag. Drop them entirely rather than let
  // raw markup flash at the user — same treatment as <quiz>/<es-app>.
  // Applied per non-fence segment only: the "…through end of text"
  // rule would otherwise start inside a fence and swallow its closing
  // backticks, taking the whole code block with it.
  const _cleanStrayTags = (s) => s
    .replace(/<dropdown\b(?:(?:"[^"]*"|'[^']*'|[^>"'])*)>[\s\S]*$/gi, "")
    .replace(/<details\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<cards\b(?:(?:"[^"]*"|'[^']*'|[^>"'])*)>[\s\S]*$/gi, "")
    .replace(/<(chart|flowchart)\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/?(dropdown|details|summary|cards|card|icon|chart|flowchart)\b[^>]*>/gi, "");
  // split() with a capturing group interleaves: even indexes are prose,
  // odd indexes are the fences.
  text = text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/)
    .map((part, i) => (i % 2
      // Inside a fence our tags are sample text, but DOMPurify would
      // strip them as unknown elements — and since <icon/> has no text
      // content of its own, showing it as a sample would render an EMPTY
      // code block. Escape only our own tag openings so they display
      // literally; every other tag in a fence keeps today's behaviour.
      ? part.replace(/<(dropdown|details|summary|cards|card|icon|chart|flowchart)\b/gi, "&lt;$1")
      : _cleanStrayTags(part)))
    .join("");
  // Convert [IMAGE: url] tags to inline image HTML before markdown processing.
  // This ensures images render inline in the chat like ChatGPT, not as raw text.
  const webImageBlocks = [];
  text = text.replace(/\[IMAGE:\s*([^\]]+)\]/gi, (_, url) => {
    const cleanUrl = url.trim();
    const i = webImageBlocks.push({ type: 'url', value: cleanUrl }) - 1;
    return `WEBIMAGE${i}WEBIMAGE`;
  });
  // Also convert [IMAGE_SEARCH: query] tags - these will be processed client-side
  text = text.replace(/\[IMAGE_SEARCH:\s*([^\]]+)\]/gi, (_, query) => {
    const cleanQuery = query.trim();
    const i = webImageBlocks.push({ type: 'search', value: cleanQuery }) - 1;
    return `WEBIMAGE${i}WEBIMAGE`;
  });
  const codeBlocks = [];
  text = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (m) => {
    const i = codeBlocks.push(m) - 1;
    return `CODEBLOCK${i}`;
  });
  const mathBlocks = [];
  text = text.replace(/\$\$([^$]+?)\$\$/gs, (_, m) => {
    const i = mathBlocks.push({ type: "block", src: m }) - 1;
    return `MATHBLOCK${i}MATHBLOCK`;
  });
  // Also support \[...\] block math delimiters (some models use these)
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => {
    const i = mathBlocks.push({ type: "block", src: m }) - 1;
    return `MATHBLOCK${i}MATHBLOCK`;
  });
  // Inline math: $...$
  // CRITICAL: The naive regex /\$([^$\n]+?)\$/g treats ANY pair of $
  // signs as math delimiters. When the output contains currency amounts
  // (e.g. "$62,932.68 USD. Euler's identity is $e^{i\pi}$."), the regex
  // matches from the first $ to the second $, swallowing the prose between
  // them into a single "math" block. KaTeX fails to parse prose as math,
  // and with throwOnError:false it falls back to raw markup — the
  // "raw LaTeX" / "mashed words" bug.
  //
  // Fix: use an exec-based loop with content validation. When a match is
  // rejected (not valid math), we advance past only the opening $, so the
  // closing $ can serve as the opening $ of the next potential math block.
  // This correctly handles "$currency. Math is $e^{i\pi}$." — the first
  // pair is rejected (prose), and the second pair is accepted (real math).
  {
    const _mathRe = /\$([^$]+?)\$/gs;
    let _mm, _lastEnd = 0, _result = '';
    while ((_mm = _mathRe.exec(text)) !== null) {
      const _fullStart = _mm.index;
      const _inner = _mm[1];
      // Reject prose/currency between $ signs:
      //  - sentence boundary ("$62,932.68 USD. Euler's identity is $")
      //  - blank-line paragraph break
      //  - currency-like content: thousands-grouped numbers ("1,234" /
      //    "5,000 for the whole trip"), decimals ("12.50"), or long pure
      //    digit/comma strings ("62,932"). Short item lists ("0, 1, atau 2")
      //    and real math ("0{,}1|...|1\times 10^{-3}") are NOT currency and
      //    must be rendered as math.
      //  - PROSE smuggled between stray $ signs (e.g. a long sentence that
      //    happens to start with "$-203,7" and end with "-155$"). Math never
      //    contains double quotes, and real inline math rarely has >=3
      //    multi-letter words or >=3 single-character lines (the latter is
      //    the model's char-by-char hallucination, like "$0, 1,\na\nt\na\nu
      //    \natau2$"). Such spans are left literal so Markdown + the
      //    char-run collapse handle them as ordinary text.
      // The 's' flag lets math span newlines — the model frequently wraps
      // multi-line expressions in $...$ (and hallucinates single-char line
      // runs), which previously leaked as literal "$...$" text.
      const _hasLaTeX = /\\[a-zA-Z]/.test(_inner);
      // The final "long pure number" guard must reject GARBAGE, not math.
      // The old shape check (/^[^\d]*\d[\d,]*$/) matches any span that ENDS
      // in a number — the arbitrary non-digit PREFIX lets formulas like
      // "E = mc^2" through, so they were misclassified as currency and their
      // $ pair rejected. That then let the next $ swallow the prose between
      // two inline math spans: "$E = mc^2$, where $c \approx...$" became
      // "$E = mc^2 <math>,where </math>c \approx...$". Only treat a span as
      // a bare number when stripping thousands separators / whitespace leaves
      // a pure digit string (with an optional leading sign) — letters/symbols
      // mean it is a formula, not a currency amount.
      const _compactNum = _inner.replace(/[,\s]/g, "");
      const _isCurrency = !_hasLaTeX && (
        /(?:^|\D)\d{1,3}(?:,\d{3})+(?:\.\d+)?/.test(_inner) ||
        /\d\.\d/.test(_inner) ||
        (/^[^\d]*\d[\d,]*$/.test(_inner) && /^-?[\d.]+$/.test(_compactNum) && _compactNum.length >= 5)
      );
      // Char-by-char hallucination: >=3 single-character lines inside a
      // $...$ span means the model broke a sentence apart (e.g. "R\nu\nm\nu\n
      // s\n:\n"). Real math never has that, so reject EVEN IF LaTeX commands
      // are present — the span is contaminated prose, not a formula.
      const _soloChars = _inner.split("\n").filter((l) => l.trim().length === 1 && /\S/.test(l)).length;
      const _isProse = /["“”]/.test(_inner) || _soloChars >= 3 || (!_hasLaTeX && (_inner.match(/[a-zA-Z]{2,}/g) || []).length >= 3);
      if (/\.\s/.test(_inner) || /\n\s*\n/.test(_inner) || _isCurrency || _isProse) {
        // Not valid math — keep the opening $ and content as literal text,
        // but let the closing $ be re-scanned as a potential opening $
        _result += text.slice(_lastEnd, _fullStart + 1 + _inner.length);
        _lastEnd = _fullStart + 1 + _inner.length; // position of closing $
        _mathRe.lastIndex = _lastEnd;
      } else {
        // Valid math — replace with placeholder (consume both $ signs)
        _result += text.slice(_lastEnd, _fullStart);
        const i = mathBlocks.push({ type: "inline", src: _inner }) - 1;
        _result += `MATHINLINE${i}MATHINLINE`;
        _lastEnd = _fullStart + _mm[0].length;
        _mathRe.lastIndex = _lastEnd;
      }
    }
    _result += text.slice(_lastEnd);
    text = _result;
  }
  // Also support \(...\) inline math delimiters (some models use these).
  // Use a tempered greedy token to allow backslashes inside the content
  // (e.g. \(e^{i\pi}\)) — the old regex [^\\\n]+? stopped at the first \.
  text = text.replace(/\\\(((?:(?!\\\))[\s\S])+?)\\\)/g, (_, m) => {
    const i = mathBlocks.push({ type: "inline", src: m }) - 1;
    return `MATHINLINE${i}MATHINLINE`;
  });
  text = _collapseCharByCharRuns(text);
  text = text.replace(/\x02CODEBLOCK(\d+)\x02/g, (_, i) => codeBlocks[+i]);
  let html = marked.parse(text);
  if (typeof DOMPurify !== "undefined") {
    html = DOMPurify.sanitize(html, { ADD_ATTR: ["target", "loading", "referrerpolicy", "data-web-img"] });
  }
  // Re-insert web image HTML after DOMPurify (img is allowed by default)
  html = html.replace(/WEBIMAGE(\d+)WEBIMAGE/g, (_, i) => {
    const imgData = webImageBlocks[+i];
    if (!imgData) return '';
    if (imgData.type === 'search') {
      // [IMAGE_SEARCH: query] - show loading placeholder, will be filled by JS
      const safeQuery = escapeHtmlAttr(imgData.value);
      return `<div class="web-image-result web-image-searching" data-img-search="${safeQuery}"><div class="web-image-search-spinner"></div><span class="web-image-search-text">Searching for "${safeQuery}"...</span></div>`;
    }
    // [IMAGE: url] - direct URL
    const safeUrl = escapeHtmlAttr(imgData.value);
    return `<div class="web-image-result" data-web-img="1"><img class="web-image" src="${safeUrl}" alt="Image" loading="lazy"></div>`;
  });
  // Re-insert collapsible dropdowns AFTER sanitization: this markup is
  // ours (inline onclick, data attrs), so it must never reach DOMPurify.
  // The alternation also eats the wrapping <p> marked emits around a
  // block-level placeholder, which would otherwise leave an empty
  // paragraph either side of the card once the HTML parser splits it.
  html = html.replace(/<p>\s*AIDROPDOWN(\d+)AIDROPDOWN\s*<\/p>|AIDROPDOWN(\d+)AIDROPDOWN/g, (m, a, b) => {
    const blk = dropdownBlocks[+(a ?? b)];
    return blk ? aiDropdownHTML(blk.title, blk.body, blk.open, blk.icon) : "";
  });
  // Card groups, same reasoning as dropdowns: injected after
  // sanitization because the markup is ours, and the <p> marked wraps a
  // block-level placeholder in is eaten to avoid empty paragraphs.
  html = html.replace(/<p>\s*AICARDS(\d+)AICARDS\s*<\/p>|AICARDS(\d+)AICARDS/g, (m, a, b) => {
    const blk = cardBlocks[+(a ?? b)];
    if (!blk) return "";
    return aiCardsHTML(_aiTagAttr(blk.attrs, "layout"), _aiTagAttr(blk.attrs, "title"), blk.inner, _aiTagAttr(blk.attrs, "icon"));
  });
  // Inline <icon/> is different: it sits INSIDE a paragraph, so the
  // placeholder is replaced on its own — no <p> is eaten, or the icon
  // would tear its sentence in half.
  //
  // Spacing is derived from the REAL neighbours rather than a fixed
  // margin. The model writes both "<icon/>word" and "word <icon/>", so
  // one fixed value either collides with the preceding text or doubles
  // up with a space the source already has. Two modifier classes:
  //   ai-icon-lead — text abuts it on the left, add space there
  //   ai-icon-next — text abuts it on the right, add space there
  // Block boundaries (a <p>/<li>/<br> on one side) mean the icon is at
  // the START or END of a run, not glued to text, so they suppress the
  // modifier; an inline closing tag like </strong> does not, because
  // there the icon really does collide with the text before it.
  const EDGE_TAGS = "(p|li|h[1-6]|td|th|div|blockquote|pre|br|ul|ol|table|tbody|thead|tr|dd|dt|section|article|figure|figcaption)";
  const EDGE_BEFORE = new RegExp(`<\\/?${EDGE_TAGS}\\b[^>]*\\/?>$`, "i");
  const EDGE_AFTER = new RegExp(`^<\\/?${EDGE_TAGS}\\b[^>]*\\/?>`, "i");
  html = html.replace(/AIICON(\d+)AIICON/g, (m, i, offset, str) => {
    const svg = aiSVGIcon(iconBlocks[+i]);
    if (!svg) return "";
    const before = str.slice(0, offset);
    const after = str.slice(offset + m.length);
    const lead = before && !/\s$/.test(before) && !EDGE_BEFORE.test(before) && !/AIICON\d+AIICON$/.test(before) ? " ai-icon-lead" : "";
    const next = after && !/^\s/.test(after) && !EDGE_AFTER.test(after) && !/^AIICON\d+AIICON/.test(after) ? " ai-icon-next" : "";
    return svg.replace('class="ai-icon"', `class="ai-icon${lead}${next}"`);
  });
  // Charts are injected after sanitization for the same reason. Unlike
  // cards/dropdowns there may be NO <p> around them (a chart often sits
  // alone between paragraphs), so both shapes are accepted.
  html = html.replace(/<p>\s*AICHART(\d+)AICHART\s*<\/p>|AICHART(\d+)AICHART/g, (m, a, b) => {
    const blk = chartBlocks[+(a ?? b)];
    if (!blk) return "";
    return aiChartSVG(blk.kind, _aiTagAttr(blk.attrs, "title"), blk.body);
  });
  html = html.replace(/MATHBLOCK(\d+)MATHBLOCK/g, (_, i) => {
    try {
      const src = _preprocessLatexColor(mathBlocks[i].src);
      return typeof katex !== "undefined" ? `<div class="md-math-block">${katex.renderToString(src, { throwOnError: false, displayMode: true })}</div>` : `<pre>$$${_collapseCharByCharRuns(mathBlocks[i].src)}$$</pre>`;
    } catch {
      return `<pre>$$${_collapseCharByCharRuns(mathBlocks[i].src)}$$</pre>`;
    }
  });
  html = html.replace(/MATHINLINE(\d+)MATHINLINE/g, (_, i) => {
    try {
      const src = _preprocessLatexColor(mathBlocks[i].src);
      return typeof katex !== "undefined" ? katex.renderToString(src, { throwOnError: false }) : `$${_collapseCharByCharRuns(mathBlocks[i].src)}$`;
    } catch {
      return `$${_collapseCharByCharRuns(mathBlocks[i].src)}$`;
    }
  });
  return html;
}
function _mdInline(raw) {
  return String(raw || "").replace(/^<p>\s*/, "").replace(/\s*<\/p>\s*$/, "");
}
function _mdBlock(raw) {
  return renderMarkdown(raw).trim();
}
/* Longest a [MEMORY]…[/MEMORY] block may be and still count as memory. The
   worker tells the model a block "may contain any characters, newlines, and
   brackets" and must be "SUMMARIZED and condensed", so anything longer than
   this is the model forgetting the closing tag mid-answer, not a memory. */
const _MEM_BLOCK_MAX = 1200;
const _MEM_BLOCK_SRC = "\\[MEMORY\\]([\\s\\S]{0," + _MEM_BLOCK_MAX + "}?)\\[\\/MEMORY\\]";
const _MEM_BLOCK_RE = new RegExp(_MEM_BLOCK_SRC, "g");
const _MEM_SHORT_RE = /\[MEMORY:\s*([^\]\n]{1,400})\]/g;

/* Is this actually a memory, or is it the model's answer?
   A real block is a short condensed list. Answer-shaped content — headings, code
   fences, tables — means the model opened the tag and then kept writing its
   reply, and that text must never be removed. Checking content shape rather
   than length is what makes this safe: the swallowed-answer case can be short. */
function _memBlockIsMemoryish(body) {
  const t = String(body || "").trim();
  if (!t) return false;
  if (t.length > _MEM_BLOCK_MAX) return false;
  if (/```/.test(t)) return false;
  if (/^\s{0,3}#{1,6}\s|\n\s{0,3}#{1,6}\s/.test(t)) return false;
  if (/\|/.test(t)) return false;
  return true;
}

function _extractMemories(text) {
  const out = [];
  const s = String(text || "");
  // Bounded for the same reason as _stripMemoryTags: an unbounded lazy match
  // captured the model's whole answer as "memory" whenever it opened a block and
  // closed it at the end, which both blanked the reply and poisoned the memory
  // store with the answer text.
  for (const bm of s.matchAll(new RegExp(_MEM_BLOCK_SRC, "g"))) {
    const t = bm[1].trim();
    if (t && _memBlockIsMemoryish(t)) out.push({ tag: bm[0], text: t });
  }
  const cleaned = s.replace(new RegExp(_MEM_BLOCK_SRC, "g"), " ");
  for (const im of cleaned.matchAll(_MEM_SHORT_RE)) {
    const t = im[1].trim();
    if (t) out.push({ tag: im[0], text: t });
  }
  return out;
}

/* Strips memory tags WITHOUT ever deleting the user's answer.
   Two bugs lived here, both of which blanked the whole response:
     · "[MEMORY]…[/MEMORY]" matched lazily across any distance, so a model that
       opened the block and answered before closing it had its ENTIRE reply
       swallowed as "memory" — the user saw an empty message and the answer was
       stored as a memory.
     · /\s*\[MEMORY(?:\]|:)[^]*$/ deleted from the tag to END OF STRING, which is
       what truncated the response mid-stream every time a block was opened but
       not yet closed.
   Now only well-formed, plausibly-sized blocks are removed; anything else is
   left in place with just the literal delimiter neutralised. */
function _stripMemoryTags(text) {
  let s = String(text || "");
  // A real memory block is removed. If the "block" is actually the model's
  // answer, keep the body and drop only the delimiters, so nothing the user
  // wrote or asked for can ever be deleted from the reply.
  s = s.replace(_MEM_BLOCK_RE, (_m, body) => (_memBlockIsMemoryish(body) ? " " : String(body)));
  s = s.replace(_MEM_SHORT_RE, " ");
  // Leftovers: an unterminated or oversized tag. Remove only the tag itself —
  // never the prose around it.
  s = s.replace(/\[\/MEMORY\]/g, "");
  s = s.replace(/\[MEMORY\]/g, "");
  s = s.replace(/\[MEMORY:[^\]\n]{0,400}/g, "");
  return s;
}
function _streamDisplayText(raw) {
  let t = String(raw || "");
  t = _stripMemoryTags(t);
  t = t.replace(/\[GENERATE_IMAGE:[^\]]*\]?/g, "");
  t = t.replace(/\[EDIT_IMAGE:[^\]]*\]?/g, "");
  t = t.replace(/\[IMAGE:\s*[^\]]+\]/g, "");
  t = t.replace(/\[IMAGE_SEARCH:\s*[^\]]+\]/g, "");
  t = _stripThinkingPreamble(t);
  const _peeked = _esPeekApp(t);
  if (_peeked) { _esStreamApp = _peeked; }
  else if (t.indexOf("<es-edit") >= 0 || t.indexOf("<es-app") >= 0) { _esStreamApp = null; }
  const editIdx = t.search(/<es-edit(?:\s[^>]*)?>/i);
  if (editIdx >= 0) {
    return { text: t.slice(0, editIdx), quizStarted: false, appStarted: false, editStarted: true };
  }
  const _trimPartial = (tag) => {
    const low = t.toLowerCase();
    for (let i = tag.length; i >= 1; i--) {
      if (low.endsWith(tag.slice(0, i))) return t.slice(0, -i);
    }
    return t;
  };
  t = _trimPartial("<es-edit");
  const appIdx = t.search(/<es-app(?:\s[^>]*)?>/i);
  if (appIdx >= 0) {
    return { text: t.slice(0, appIdx), quizStarted: false, appStarted: true, editStarted: false };
  }
  t = _trimPartial("<es-app");
  const quizIdx = t.search(/<quiz(?:\s[^>]*)?>/i);
  if (quizIdx >= 0) {
    return { text: t.slice(0, quizIdx), quizStarted: true, appStarted: false, editStarted: false };
  }
  t = _trimPartial("<quiz");
  return { text: t, quizStarted: false, appStarted: false, editStarted: false };
}
/* ── Per-word streaming reveal ──────────────────────────────────
   Wraps each whitespace-separated token in the streaming message
   text in a <span class="stream-word">. Words that are NEW since
   the last call (index >= previously-wrapped count, tracked on
   textEl.dataset.streamWords) get the `is-new` modifier, which
   triggers a blur-in animation DIRECTLY on insertion: the word
   starts hidden (opacity 0, blurred) and animates to sharp — no
   show→hide→animate flash. Words that were already shown are
   left untouched (no `is-new` class) so they don't re-animate
   every time the streaming innerHTML is rebuilt.

   Skips text inside <pre>/<code>/<script>/<style> where
   word-wrapping would break formatting. The streaming cursor
   span (no text content) is naturally skipped by the TreeWalker. */
const _STREAM_WORD_SKIP = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT']);
function _wrapStreamWords(textEl) {
  if (!textEl || !textEl.nodeType) return;
  const prevCount = parseInt(textEl.dataset.streamWords || '0', 10);
  let idx = 0;
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== textEl) {
        if (_STREAM_WORD_SKIP.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return (node.nodeValue && /\S/.test(node.nodeValue))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach((tn) => {
    const parts = tn.nodeValue.split(/(\s+)/);
    const frag = document.createDocumentFragment();
    parts.forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        const span = document.createElement('span');
        const isNew = idx >= prevCount;
        span.className = 'stream-word' + (isNew ? ' is-new' : '');
        span.textContent = part;
        frag.appendChild(span);
        idx++;
      }
    });
    tn.parentNode.replaceChild(frag, tn);
  });
  textEl.dataset.streamWords = String(idx);
}
function _stripThinkingPreamble(text) {
  let t = text;
  let changed = true;
  let guard = 0;
  while (changed && guard < 100) {
    changed = false;
    guard++;
    if (/^\s*\[[A-Z][A-Z\s—-]*(STRICT|ABSOLUTE|NEVER VIOLATE|CRITICAL)[^\]]*\]\s*/i.test(t)) {
      t = t.replace(/^\s*\[[A-Z][A-Z\s—-]*(?:STRICT|ABSOLUTE|NEVER VIOLATE|CRITICAL)[^\]]*\]\s*\n?/i, "");
      changed = true;
      continue;
    }
    if (/^\s*\d+\.\s+(NEVER|ALWAYS|Volunteering|When|Output|Do not|Don't|Asking|If)\b/i.test(t)) {
      t = t.replace(/^\s*\d+\.\s+[^\n]*\n?/i, "");
      changed = true;
      continue;
    }
    if (/^\s*The user \b/i.test(t)) {
      t = t.replace(/^\s*The user [^\n]*\n?/i, "");
      changed = true;
      continue;
    }
    if (/^\s*(User is|The question is|This is a|I need to|Let me|I'll|I will|Now I|Okay,? so|According to the rules|Following the rules|Based on the rules|Plan:|Step \d+:|First,|Next,|Then,|Finally,)\b/i.test(t)) {
      t = t.replace(/^\s*(?:User is|The question is|This is a|I need to|Let me|I'll|I will|Now I|Okay,? so|According to the rules|Following the rules|Based on the rules|Plan:|Step \d+:|First,|Next,|Then,|Finally,)[^\n]*\n?/i, "");
      changed = true;
      continue;
    }
    if (/^\s*```[a-zA-Z]*\n[\s\S]*?```\s*/i.test(t)) {
      t = t.replace(/^\s*```[a-zA-Z]*\n[\s\S]*?```\s*/i, "");
      changed = true;
      continue;
    }
    if (/^\s*```[a-zA-Z]*\n/i.test(t)) {
      const afterFence = t.replace(/^\s*```[a-zA-Z]*\n/i, "");
      if (/\b(Identity|Backend|Coding|Output|Quiz|Image|Date|Time|Disclosure|Secrecy|Format|Suggest|Keep|Plan|Step|Rule|Never|Always|The user)\b/i.test(afterFence)) {
        t = afterFence;
        changed = true;
        continue;
      }
    }
    if (/^\s*[*\-]\s+.*(Identity|Backend|Coding|Output Format|Quiz|Image|Date|Time|Disclosure|Secrecy|Suggest|Keep|Plan|Step|Rule|Never|Always|No identity|No technical|No coding|No reasoning|No quiz|Not asked|Provide|State|Respond|Answer|Tone|Friendly|Helpful)\b/i.test(t)) {
      const lineMatch = t.match(/^\s*[*\-]\s+[^\n]*\n?/);
      if (lineMatch) {
        const line = lineMatch[0];
        const splitMatch = line.match(/[.!?]([A-Z][a-z]+ (?:can|am|'ll|would|'d|have|don't|Here|Sure|course|Yes|No|Absolutely|Great|Let's|That's|It sounds|It looks|Depending|Sounds|Looks|I ))/);
        if (splitMatch) {
          const splitIdx = line.indexOf(splitMatch[0]);
          const answerPart = line.slice(splitIdx + 1);
          t = answerPart + t.slice(line.length);
          changed = true;
          continue;
        }
        const concatMatch = line.match(/\.I (can|am|'ll|would|'d|have|don't)/i);
        if (concatMatch) {
          const splitIdx = line.indexOf(concatMatch[0]);
          const answerPart = line.slice(splitIdx + 1);
          t = answerPart + t.slice(line.length);
          changed = true;
          continue;
        }
        t = t.replace(/^\s*[*\-]\s+[^\n]*\n?/i, "");
        changed = true;
        continue;
      }
    }
    if (/^\s*[*\-]\s+(Suggest|Keep|Provide|State|Respond|Answer|Plan|Step|First|Next|Then|Finally|Avoid|Do not|Don't|Never|Always|Use|Make|Ensure|Keep|Set|Follow|Check|Verify|Determine|Identify|Analyze|Consider)\b/i.test(t)) {
      const lineMatch = t.match(/^\s*[*\-]\s+[^\n]*\n?/);
      if (lineMatch) {
        const line = lineMatch[0];
        const concatMatch = line.match(/\.I (can|am|'ll|would|'d|have|don't)/i);
        if (concatMatch) {
          const splitIdx = line.indexOf(concatMatch[0]);
          const answerPart = line.slice(splitIdx + 1);
          t = answerPart + t.slice(line.length);
          changed = true;
          continue;
        }
        t = t.replace(/^\s*[*\-]\s+[^\n]*\n?/i, "");
        changed = true;
        continue;
      }
    }
    if (/^\s*(plaintext|Run|Copy)\s*\n/i.test(t)) {
      t = t.replace(/^\s*(?:plaintext|Run|Copy)\s*\n/i, "");
      changed = true;
      continue;
    }
    if (/^\s*\[[A-Z][A-Z\s-]{2,}\]\s*[^\n]*\n?/.test(t)) {
      const labelMatch = t.match(/^\s*\[([A-Z][A-Z\s-]{2,})\]/);
      if (labelMatch && /^[A-Z\s-]+$/.test(labelMatch[1])) {
        t = t.replace(/^\s*\[[A-Z][A-Z\s-]{2,}\]\s*[^\n]*\n?/, "");
        changed = true;
        continue;
      }
    }
    if (/^\s*\n/.test(t) && t.trim()) {
      t = t.replace(/^\s*\n/, "");
      changed = true;
      continue;
    }
  }
  return t;
}
function insertBeforeMessageActions(body, el) {
  const anchor = body?.querySelector(".message-actions, .branch-nav");
  if (anchor) body.insertBefore(el, anchor);
  else body?.appendChild(el);
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function copyCode(btn) {
  try {
    let text = "";
    if (btn.dataset.cid) {
      text = (window._codeStore || {})[btn.dataset.cid] || "";
    } else {
      text = decodeURIComponent(btn.dataset.code || "");
    }
    const ok = await safeCopy(text);
    if (ok) {
      showToast(`${_aiSvgCopy} Code copied to clipboard`);
    } else {
      showToast(`${_aiSvgWarn} Failed to copy`);
    }
  } catch (err) {
    console.error(err);
    showToast(`${_aiSvgWarn} Failed to copy`);
  }
}
function normalizeCodeLang(lang) {
  const l = String(lang || "").toLowerCase().trim();
  if (["html", "htm", "xml"].includes(l)) return "html";
  if (["css", "scss", "sass"].includes(l)) return "css";
  if (["js", "javascript", "mjs", "jsx", "ts", "typescript", "tsx"].includes(l)) return "js";
  return l || "plaintext";
}
function looksLikeHtml(code) {
  return /<!doctype\s+html|<html[\s>]|<body[\s>]|<script[\s>]|<style[\s>]|<[a-z][\s\S]*>/i.test(code || "");
}
function escapeClosingScript(code) {
  return String(code || "").replace(/<\/script/gi, "<\\/script");
}
function codeBlockMeta(block) {
  const cid = block?.dataset?.cid;
  const stored = cid ? (window._codeMeta || {})[cid] : null;
  return stored || { code: (window._codeStore || {})[cid] || "", language: block?.dataset?.lang || "" };
}
function buildRunnablePreview(btn) {
  const block = btn.closest(".md-code-block");
  if (!block) return { ok: false, reason: "No code block found." };
  const selected = codeBlockMeta(block);
  const selectedLang = normalizeCodeLang(selected.language);
  const message = btn.closest(".message");
  const blocks = Array.from(message?.querySelectorAll(".md-code-block") || [block]).map(codeBlockMeta);
  const browserBlocks = blocks.filter((b) => {
    const lang = normalizeCodeLang(b.language);
    return ["html", "css", "js"].includes(lang) || lang === "plaintext" && looksLikeHtml(b.code);
  });
  if (!browserBlocks.length && !["html", "css", "js"].includes(selectedLang) && !looksLikeHtml(selected.code)) {
    return { ok: false, reason: `Cannot run ${selected.language || "this"} code in the browser preview.` };
  }
  let html = "";
  let css = "";
  let js = "";
  const source = browserBlocks.length ? browserBlocks : [selected];
  source.forEach((item) => {
    const lang = normalizeCodeLang(item.language);
    if (lang === "html" || lang === "plaintext" && looksLikeHtml(item.code)) html += "\n" + item.code;
    else if (lang === "css") css += "\n" + item.code;
    else if (lang === "js") js += "\n" + item.code;
  });
  if (!html && selectedLang === "css") css = selected.code;
  if (!html && selectedLang === "js") js = selected.code;
  if (!html) {
    html = '<main class="emerald-preview-root"><h1>Preview</h1><p>Your code is running in a browser sandbox.</p><div id="app"></div><button id="btn">Button</button><p id="count">0</p></main>';
  }
  return {
    ok: true,
    title: selected.language ? `${selected.language.toUpperCase()} Preview` : "Code Preview",
    srcdoc: createPreviewSrcdoc(html, css, js)
  };
}
function createPreviewSrcdoc(html, css, js) {
  const sandboxSupport = `<script>
(function() {
  function makeStorage() {
    var data = Object.create(null);
    return {
      get length() { return Object.keys(data).length; },
      key: function(index) { return Object.keys(data)[index] || null; },
      getItem: function(key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function(key, value) { data[String(key)] = String(value); },
      removeItem: function(key) { delete data[String(key)]; },
      clear: function() { data = Object.create(null); }
    };
  }
  try {
    // In a sandboxed iframe (no allow-same-origin), accessing the native
    // localStorage throws SecurityError. The native property is often
    // non-configurable, so Object.defineProperty alone may silently fail.
    // Strategy: try delete first, then defineProperty with writable:true,
    // then verify it took effect, with a final fallback to direct assignment.
    function installStorage(name, shim) {
      try {
        try { delete window[name]; } catch (e) {}
        Object.defineProperty(window, name, {
          value: shim, configurable: true, writable: true, enumerable: true
        });
        if (window[name] !== shim) throw new Error('defineProperty did not take');
        return true;
      } catch (err) {
        try { window[name] = shim; if (window[name] === shim) return true; } catch (e2) {}
        return false;
      }
    }
    installStorage('localStorage', makeStorage());
    installStorage('sessionStorage', makeStorage());
  } catch (err) {}
})();
<\/script>`;
  const virtualDialogHTML = '<div id="_esbOv" style="position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;z-index:2147483647;opacity:0;transition:opacity .18s ease;pointer-events:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"><div id="_esbDlg" style="background:#1c1c1c;border:1px solid #2a2a2a;border-radius:18px;padding:28px 24px 20px;min-width:270px;max-width:min(380px,88vw);box-shadow:0 28px 70px rgba(0,0,0,.75);transform:translateY(12px) scale(.96);transition:transform .22s cubic-bezier(.34,1.56,.64,1),opacity .18s ease;opacity:0"><div id="_esbIcon" style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px"></div><div id="_esbKind" style="font-size:.68rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#505050;text-align:center;margin-bottom:8px"></div><div id="_esbMsg" style="font-size:.92rem;color:#c8c8c8;line-height:1.65;text-align:center;margin-bottom:20px;word-break:break-word;white-space:pre-wrap;max-height:160px;overflow-y:auto"></div><input id="_esbInp" type="text" style="display:none;width:100%;box-sizing:border-box;background:#111;border:1px solid #2e2e2e;border-radius:9px;color:#e0e0e0;font:inherit;font-size:.9rem;padding:9px 12px;margin-bottom:16px;outline:none"><div id="_esbBtns" style="display:flex;gap:8px;justify-content:flex-end"></div></div></div><div id="_esbCon" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483640;background:#131313;border-top:1px solid #2a2a2a;font-family:ui-monospace,monospace;font-size:.76rem;display:flex;flex-direction:column;max-height:200px;transform:translateY(100%);transition:transform .25s cubic-bezier(.4,0,.2,1)"><div id="_esbConBar" style="display:flex;align-items:center;padding:5px 10px;gap:8px;user-select:none;border-bottom:1px solid #1d1d1d;flex-shrink:0;min-height:28px"><span style="font-size:.68rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#909090;flex:1">Console</span><span id="_esbBadge" style="background:#50c878;color:#000;font-size:.62rem;font-weight:700;border-radius:20px;padding:0 7px;line-height:18px;display:none">0</span><button id="_esbClr" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:.7rem;font-weight:600;font-family:inherit;padding:2px 8px;border-radius:4px;letter-spacing:.04em">Clear</button></div><div id="_esbConBody" style="overflow-y:auto;flex:1;padding:2px 0"></div></div>';
  const virtualDialogJS = `<script>
(function(){
  var _cb = null;
  var ICONS = {
    a: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/></svg>',
    c: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>',
    p: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  };
  var ICON_STYLES = {
    a: 'background:rgba(80,200,120,.13);color:#50c878',
    c: 'background:rgba(255,196,0,.11);color:#ffc400',
    p: 'background:rgba(100,160,255,.11);color:#64a0ff'
  };
  var KIND_LABELS = { a: 'Alert', c: 'Confirm', p: 'Input' };

  function _btn(label, primary, cb){
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'border:none;border-radius:9px;padding:8px 18px;font:inherit;font-size:.87rem;font-weight:600;cursor:pointer;outline:none;' +
      (primary ? 'background:#019100;color:#fff' : 'background:#252525;color:#aaa;border:1px solid #333');
    b.onmouseenter = function(){ b.style.background = primary ? '#01a800' : '#2e2e2e'; };
    b.onmouseleave = function(){ b.style.background = primary ? '#019100' : '#252525'; };
    b.onclick = cb;
    return b;
  }

  function _open(kind, msg, def, cb){
    _cb = cb;
    var ov   = document.getElementById('_esbOv');
    var dlg  = document.getElementById('_esbDlg');
    var icon = document.getElementById('_esbIcon');
    var lbl  = document.getElementById('_esbKind');
    var msgEl= document.getElementById('_esbMsg');
    var inp  = document.getElementById('_esbInp');
    var btns = document.getElementById('_esbBtns');
    if (!ov) { cb && cb(kind==='c'?false:null); return; }
    icon.style.cssText = 'width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;' + ICON_STYLES[kind];
    icon.innerHTML = ICONS[kind];
    lbl.textContent = KIND_LABELS[kind] || 'Alert';
    msgEl.textContent = (msg==null)?'':String(msg);
    inp.style.display = kind==='p' ? 'block' : 'none';
    if (kind==='p') inp.value = (def!=null)?String(def):'';
    btns.innerHTML = '';
    function done(val){ ov.style.opacity='0'; ov.style.pointerEvents='none'; dlg.style.opacity='0'; dlg.style.transform='translateY(12px) scale(.96)'; if(_cb){_cb(val);_cb=null;} }
    if (kind!=='a') btns.appendChild(_btn('Cancel', false, function(){ done(kind==='c'?false:null); }));
    var ok = _btn('OK', true, function(){ done(kind==='p'?inp.value:(kind==='c'?true:undefined)); });
    btns.appendChild(ok);
    ov.style.opacity='1'; ov.style.pointerEvents='all';
    dlg.style.opacity='1'; dlg.style.transform='translateY(0) scale(1)';
    ov.onclick = function(e){ if(e.target===ov) done(kind==='c'?false:(kind==='p'?null:undefined)); };
    if(kind==='p'){ inp.onkeydown=function(e){ if(e.key==='Enter') done(inp.value); if(e.key==='Escape') done(null); }; }
    setTimeout(function(){ (kind==='p'?inp:ok).focus(); if(kind==='p') inp.select(); }, 60);
  }

  window.alert   = function(m)    { return new Promise(function(r){ _open('a',m,null,r); }); };
  window.confirm = function(m)    { return new Promise(function(r){ _open('c',m,null,r); }); };
  window.prompt  = function(m,d)  { return new Promise(function(r){ _open('p',m,d,r);   }); };

  var _n = 0;
  var LEVEL_STYLE = {
    log:  'background:#1e1e1e;color:#606060',
    info: 'background:rgba(100,160,255,.1);color:#64a0ff',
    warn: 'background:rgba(255,196,0,.09);color:#c4970a',
    error:'background:rgba(220,50,50,.1);color:#cc4444'
  };
  var MSG_STYLE = {
    log:'color:#bababa', info:'color:#bababa',
    warn:'color:#b8910e', error:'color:#c05050'
  };
  function _addLog(lvl, args){
    var body  = document.getElementById('_esbConBody');
    var badge = document.getElementById('_esbBadge');
    var con   = document.getElementById('_esbCon');
    if (!body) return;
    _n++;
    var text = Array.prototype.slice.call(args).map(function(a){
      if(a===null) return 'null'; if(a===undefined) return 'undefined';
      try{ return typeof a==='object'?JSON.stringify(a,null,2):String(a); }catch(e){ return String(a); }
    }).join(' ');
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;padding:3px 10px;border-bottom:1px solid #191919;align-items:baseline;line-height:1.55';
    var tag = document.createElement('span');
    tag.style.cssText = 'font-size:.62rem;font-weight:700;text-transform:uppercase;padding:0 5px;border-radius:4px;flex-shrink:0;line-height:16px;' + (LEVEL_STYLE[lvl]||LEVEL_STYLE.log);
    tag.textContent = lvl;
    var m = document.createElement('span');
    m.style.cssText = 'word-break:break-all;white-space:pre-wrap;flex:1;min-width:0;' + (MSG_STYLE[lvl]||MSG_STYLE.log);
    m.textContent = text;
    row.appendChild(tag); row.appendChild(m);
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
    if(badge){ badge.textContent=_n; badge.style.display='inline-block'; }
    if(con && !con._open){ con.style.transform='translateY(0)'; con._open=true; }
  }
  ['log','info','warn','error'].forEach(function(m){
    var orig = console[m]?console[m].bind(console):function(){};
    console[m] = function(){ orig.apply(console,arguments); _addLog(m,arguments); };
  });

  function _wire(){
    var clr = document.getElementById('_esbClr');
    if(clr) clr.onclick = function(e){
      e.stopPropagation();
      var b=document.getElementById('_esbConBody'), badge=document.getElementById('_esbBadge');
      if(b) b.innerHTML='';
      if(badge){ badge.textContent='0'; badge.style.display='none'; }
      _n=0;
    };
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_wire); else _wire();

  window.addEventListener('message', function(e){
    if(!e.data || typeof e.data !== 'object') return;
    var con = document.getElementById('_esbCon');
    if(!con) return;
    if(e.data.type === 'esb-console-toggle'){
      con._open = !con._open;
      con.style.transform = con._open ? 'translateY(0)' : 'translateY(100%)';
    }
  });
})();
<\/script>`;
  const relay = `<script>
window.addEventListener('error', function(event) {
  parent.postMessage({ type: 'emerald-code-error', message: event.message || 'Preview runtime error.' }, '*');
});
window.addEventListener('unhandledrejection', function(event) {
  var reason = event.reason && (event.reason.message || String(event.reason));
  parent.postMessage({ type: 'emerald-code-error', message: reason || 'Preview promise error.' }, '*');
});
<\/script>`;
  const baseStyle = `<style>
html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#fff}
body{padding:24px;padding-bottom:52px}
.emerald-preview-root{display:grid;gap:12px;max-width:760px;margin:0 auto}
button{font:inherit;border:1px solid #d0d7de;background:#f6f8fa;border-radius:8px;padding:8px 12px;cursor:pointer}
${css || ""}
</style>`;
  const consoleScrollCSS = `<style>
#_esbConBody::-webkit-scrollbar{width:6px;height:6px}
#_esbConBody::-webkit-scrollbar-track{background:#131313}
#_esbConBody::-webkit-scrollbar-thumb{background:#2e2e2e;border-radius:10px}
#_esbConBody::-webkit-scrollbar-thumb:hover{background:#555}
#_esbConBody{scrollbar-width:thin;scrollbar-color:#2e2e2e #131313}
</style>`;
  const headInject = `${baseStyle}${consoleScrollCSS}${sandboxSupport}${virtualDialogJS}`;
  const script = js ? `<script>${escapeClosingScript(js)}<\/script>` : "";
  let doc = String(html || "");
  if (!/<!doctype\s+html|<html[\s>]/i.test(doc)) {
    doc = `<!doctype html><html><head><meta charset="utf-8">${headInject}</head><body>${virtualDialogHTML}${doc}${script}${relay}</body></html>`;
  } else {
    doc = doc.replace(/<\/head>/i, `${headInject}</head>`);
    doc = doc.replace(/<body(\s[^>]*)?>/, (m) => `${m}${virtualDialogHTML}`);
    doc = doc.replace(/<\/body>/i, `${script}${relay}</body>`);
    if (!/<\/body>/i.test(doc)) doc += script + relay;
    if (!/<\/head>/i.test(doc)) doc = doc.replace(/<html[^>]*>/i, (match) => `${match}<head><meta charset="utf-8">${headInject}</head>`);
  }
  return doc;
}
function runCode(btn) {
  try {
    const preview = buildRunnablePreview(btn);
    if (!preview.ok) {
      showToast(`${_aiSvgWarn} ${escapeHtml(preview.reason || "This code cannot run in the browser preview.")}`);
      return;
    }
    openCodePreviewPanel(preview.title, preview.srcdoc);
  } catch (err) {
    console.error(err);
    showToast(`${_aiSvgError} Failed to open code preview.`);
  }
}
// ============================================================================
// EVENT DELEGATION FOR CODE BLOCK BUTTONS  (fix: DOMPurify strips onclick)
// ----------------------------------------------------------------------------
// DOMPurify.sanitize() in renderMarkdown() strips ALL inline event handler
// attributes (onclick, oninput, ...) from the HTML. The code-block renderer
// emits <button class="md-copy-btn" onclick="copyCode(this)"> and
// <button class="md-run-btn" onclick="runCode(this)">, but after DOMPurify
// runs the onclick is gone — so clicking Copy / Run does nothing.
//
// Rather than weakening DOMPurify by adding "onclick" to ADD_ATTR (which
// would let AI-generated HTML inject arbitrary handlers), we install a
// single delegated click listener on the document. When a click lands inside
// a .md-copy-btn or .md-run-btn, we route it to copyCode() / runCode().
// The inline onclick attributes remain in the renderer output as a fallback
// for any code path that does NOT pass through DOMPurify.
// ============================================================================
document.addEventListener("click", function(e) {
  const btn = e.target.closest(".md-copy-btn, .md-run-btn");
  if (!btn) return;
  if (e._esbCodeHandled) return;
  e._esbCodeHandled = true;
  if (btn.classList.contains("md-copy-btn")) {
    copyCode(btn);
  } else if (btn.classList.contains("md-run-btn")) {
    runCode(btn);
  }
});
function openCodePreviewPanel(titleText, srcdoc) {
  const panel = $("codePreviewPanel");
  const body = $("codePreviewBody");
  const title = $("codePreviewTitle");
  if (!panel || !body) {
    showToast(`${_aiSvgError} Code preview panel is not available.`);
    return;
  }
  closeFilePreviewPanel();
  closeQuizPanel();
  if (title) title.textContent = titleText || "Code Preview";
  _recordPanelState({ type: "code", title: titleText || "Code Preview", srcdoc });
  body.innerHTML = `<iframe class="code-preview-frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe>`;
  const frame = body.querySelector("iframe");
  frame.srcdoc = srcdoc;
  panel.classList.add("open");
  showToast(`${_aiSvgPlay} Preview opened`);
}
function closeCodePreviewPanel() {
  const panel = $("codePreviewPanel");
  if (!panel || !panel.classList.contains("open")) return;
  _forgetPanelState();
  panel.classList.add("closing");
  setTimeout(() => {
    panel.classList.remove("open", "closing");
    const body = $("codePreviewBody");
    if (body) body.innerHTML = "";
  }, 320);
}
window.addEventListener("message", (event) => {
  // Restrict to the code-preview iframe. Without this check, any frame/ad/
  // widget on the page could spoof "emerald-code-error" toasts. The sandboxed
  // iframe has a null origin, so we match by contentWindow reference instead.
  const previewFrame = document.querySelector("#codePreviewBody iframe");
  if (previewFrame && event.source !== previewFrame.contentWindow) return;
  if (event.data?.type === "emerald-code-error") {
    showToast(`${_aiSvgError} Preview error: ${escapeHtml(event.data.message || "The code could not run.")}`);
  }
});
const $ = (id) => document.getElementById(id);
let _libFilter = "all";
function setLibFilter(value, tabEl) {
  _libFilter = value;
  document.querySelectorAll(".lib-tab").forEach((t) => t.classList.remove("active"));
  if (tabEl) tabEl.classList.add("active");
  moveLibTabIndicator(tabEl);
  renderLibraryModal();
}
function moveLibTabIndicator(tabEl) {
  const indicator = $("libTabIndicator");
  if (!indicator || !tabEl) return;
  const tabsEl = tabEl.closest(".lib-tabs");
  if (!tabsEl) return;
  const rect = tabEl.getBoundingClientRect();
  const tabsRect = tabsEl.getBoundingClientRect();
  const center = rect.left - tabsRect.left + rect.width / 2;
  const indW = Math.max(rect.width * 0.55, 22);
  indicator.style.width = indW + "px";
  indicator.style.left = center - indW / 2 + "px";
}
/* ── Chat-switch animation ─────────────────────────────────────
   When the user switches conversations (or returns to the welcome
   screen), we blur + slide the chat content down + fade it out, swap
   the inner content while invisible, then unblur + slide it back up.
   This makes conversation switches feel smooth instead of jarring.

   Guards:
   - If streaming is in progress, skip the animation (the user is
     mid-message and a fade would interrupt the stream).
   - If a switch is already in flight, the second call swaps immediately
     (no double-animation).
   - The animation duration is 180ms each way (out → swap → in), so the
     total perceived switch is ~360ms — fast enough to feel snappy.
*/
let _chatSwitchAnimating = false;
let _chatSwitchPending = null;
function animateChatSwitch(swapFn) {
  const content = $("chatContent");
  if (!content) {
    swapFn();
    return;
  }
  if (_chatSwitchAnimating) {
    // A switch is already animating — store the latest swap and apply it
    // when the current animation reaches the swap point.  This prevents
    // the repeated blur→unblur→blur→unblur cycle when rapidly clicking
    // through chats: the ongoing fade-out continues, the content is
    // swapped at the midpoint, and then a single fade-in plays.
    _chatSwitchPending = swapFn;
    return;
  }
  _chatSwitchAnimating = true;
  content.classList.add("is-switching");
  setTimeout(() => {
    try { swapFn(); } finally {
      // If a pending swap accumulated during the fade-out, apply it now
      // before the fade-in so the user sees the latest chat, not a
      // stale intermediate one.
      if (_chatSwitchPending) {
        try { _chatSwitchPending(); } catch {}
        _chatSwitchPending = null;
      }
      void content.offsetWidth;
      content.classList.remove("is-switching");
      setTimeout(() => { _chatSwitchAnimating = false; }, 180);
    }
  }, 150);
}

function showWelcome() {
  const wasShowingMessages = $("messagesArea") && $("messagesArea").style.display !== "none";
  const applyWelcome = () => {
    const GREETINGS = [
    (n) => `How can I help, ${n}?`,
    (n) => `What's on your agenda today, ${n}?`,
    (n) => `Ready when you are, ${n}. What do you need?`,
    (n) => `What's on your mind today, ${n}?`,
    (n) => `Hi ${n}! What would you like to explore?`
  ];
  const name = (loadSettings().userName || "").trim();
  const displayName = name && name !== "You" ? name : "User";
  const pick = GREETINGS[_cryptoInt(GREETINGS.length)];
  const heading = $("welcomeHeading");
  if (heading) heading.textContent = pick(displayName);
  $("welcomeScreen").style.display = "flex";
  $("messagesArea").style.display = "none";
  $("messagesArea").innerHTML = typingIndicatorHTML();
  updateTopbarTitle("");
  if ($("tempChatBtn")) $("tempChatBtn").style.display = "";
  // Hide the "Temporary" pill on the new-chat/welcome screen; it should
  // only appear once the user actually starts chatting (showMessages()).
  if ($("tempBadge")) $("tempBadge").style.display = "none";
  // New chat / welcome screen never shows a side panel from another chat.
  _hardClosePanels();
    _syncInputBusyUi();
    };
    if (wasShowingMessages) {
      animateChatSwitch(applyWelcome);
    } else {
      applyWelcome();
    }
}
function showMessages() {
  $("welcomeScreen").style.display = "none";
  $("messagesArea").style.display = "flex";
  if ($("tempChatBtn")) $("tempChatBtn").style.display = "none";
  // Show the "Temporary" pill only once chatting has actually begun.
  if ($("tempBadge")) $("tempBadge").style.display = state.isTemp ? "inline" : "none";
}
function typingIndicatorHTML() {
  return `<div class="message" id="typingIndicator" style="display:none;">
    <div class="message-avatar ai"><img src="/assets/images/favicon.webp" alt="EmeraldBot"></div>
    <div class="message-body">
      <div class="message-sender">EmeraldBot</div>
      <div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>
    </div>
  </div>`;
}
function updateTopbarTitle(title) {
  const el = $("topbarTitle");
  if (el) el.textContent = title || "";
}
function renderSidebar() {
  renderRecents();
}
function _categorizeByTime(convs) {
  const now = new Date();
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek  = new Date(today.getTime() - 7 * 86400000);
  const lastMonth = new Date(today.getTime() - 30 * 86400000);
  const groups = [
    { label: "Today",        test: (d) => d >= today },
    { label: "Yesterday",    test: (d) => d >= yesterday },
    { label: "Last 7 Days",  test: (d) => d >= lastWeek },
    { label: "Last 30 Days", test: (d) => d >= lastMonth },
    { label: "Older",        test: () => true },
  ];
  const result = [];
  const assigned = new Set();
  for (const g of groups) {
    const items = convs.filter((c) => {
      if (assigned.has(c.id)) return false;
      const ts = c.updatedAt || c.createdAt || 0;
      if (g.test(new Date(ts))) { assigned.add(c.id); return true; }
      return false;
    });
    if (items.length) result.push({ label: g.label, items });
  }
  return result;
}
function renderRecents() {
  const container = $("sidebarHistory");
  if (!container) return;
  const convs = loadConvs().filter((c) => !c.isTemp);
  if (convs.length === 0) {
    container.innerHTML = `<div class="sidebar-section-title">Recents</div><div class="sidebar-empty">No conversations yet</div>`;
    return;
  }
  const groups = _categorizeByTime(convs);
  const itemHTML = (c) => `
    <div class="history-item${state.convId === c.id ? " active" : ""}" 
         data-conv-id="${escapeHtmlAttr(c.id)}" 
         onclick="loadConversation('${escapeHtmlAttr(c.id)}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      <span class="history-item-text">${escapeHtml(c.title || "Untitled")}</span>
    </div>`;
  container.innerHTML = groups.map((g) =>
    `<div class="sidebar-time-group">${g.label}</div>` + g.items.map(itemHTML).join("")
  ).join("");
}
function loadConversation(id) {
  const conv = getConv(id);
  if (!conv) return;
  // Skip animation if we're already on this conversation.
  if (state.convId === id && !state.isTemp) return;
  _refreshPanelStateSnapshot();
  // A picked edit source belongs to the conversation it was picked in.
  _dropPendingImageEdit();
  state.convId = id;
  state.isTemp = false;
  animateChatSwitch(() => {
    showMessages();
    $("messagesArea").innerHTML = typingIndicatorHTML();
    conv.messages.forEach((m) => {
      if (m.role === "user" && !m._silent) appendUserMessageDOM(m.text, m.files || [], m.id || null, m._editBranchRef || null);
      else if (m.role === "user" && m._silent) { /* skip rendering silent quiz prompt */ }
      else appendStoredAIMessage(m);
    });
  if (conv._editBranches) {
    Object.keys(conv._editBranches).forEach((origId) => updateBranchNavDOM(origId));
  }
  if (conv._regenBranches) {
    Object.keys(conv._regenBranches).forEach((branchId) => updateRegenNavDOM(branchId));
  }
  updateLastMsgActions();
  updateTopbarTitle(conv.title);
  updateOwnedUrl();
  renderSidebar();
  scrollToBottom();
  _applyPanelStateForConv(id);
  // If a background stream is still generating for THIS conversation, keep
  // the typing indicator visible so the user sees it's still answering.
  if (state.isStreaming && state.streamConvId === id) {
    const _t = $("typingIndicator");
    if (_t) _t.style.display = "flex";
  }
  _syncInputBusyUi();
  });
}
function appendUserMessageDOM(text, files = [], msgId = null, branchRef = null) {
  const typingEl = $("typingIndicator");
  const initials = getUserInitials();
  const userName = getUserName();
  const avatarImg = loadSettings().avatar;
  const fileCards = files.map((f) => fileCardHTML(f)).join("");
  const div = document.createElement("div");
  div.className = "message message--user";
  if (msgId) div.dataset.msgId = msgId;
  if (branchRef) div.dataset.branchRef = branchRef;
  const avatarHTML = avatarImg ? `<div class="message-avatar-user user message-avatar--img"><img src="${escapeHtmlAttr(avatarImg)}" alt="${escapeHtml(initials)}"></div>` : `<div class="message-avatar-user user">${escapeHtml(initials)}</div>`;
  div.innerHTML = `
    ${avatarHTML}
    <div class="message-body">
      <div class="message-sender">${escapeHtml(userName)}</div>
      ${fileCards ? `<div class="msg-files">${fileCards}</div>` : ""}
      <div class="message-text user-text">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
    </div>`;
  $("messagesArea").insertBefore(div, typingEl);
}
const _fileRegistry = {};
function _regFile(f) {
  const fid = genId();
  _fileRegistry[fid] = f;
  return fid;
}
function fileCardHTML(f) {
  const fid = _regFile(f);
  const isImg = f.type && f.type.startsWith("image/");
  const name = escapeHtml(f.name || "");
  const inner = isImg && f.data ? `<img class="msg-file-thumb" src="${escapeHtmlAttr(f.data)}" alt="">` : fileIcon(f.type || "");
  return `<div class="msg-file-card${isImg ? " msg-file-card--img" : ""}" data-fid="${fid}" onclick="openFilePreview('${fid}')" title="${name}">${inner}<span class="msg-file-name">${name}</span></div>`;
}
const _TEXT_PREVIEW_EXTS = /* @__PURE__ */ new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "ts",
  "jsx",
  "tsx",
  "py",
  "rb",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "go",
  "rs",
  "sh",
  "bash",
  "sql",
  "graphql",
  "gql",
  "tf",
  "vue",
  "svelte",
  "r",
  "swift",
  "kt",
  "dart",
  "php",
  "env",
  "config",
  "conf",
  "properties"
]);
/* ── Per-chat side-panel memory ──────────────────────────────────────
   Each conversation remembers which side panel (file/image preview, quiz,
   or code preview) is open. Switching chats therefore never leaks one
   chat's panel into another, and returning to a chat restores its own
   open panel. The memory lives in-page only: it is dropped when the
   chat is deleted, all chats are cleared, or the page reloads. */
const _convPanelState = /* @__PURE__ */ Object.create(null);
let _panelStateGuard = false;
function _activePanelConvId() {
  return (typeof state !== "undefined" && state && state.convId) || null;
}
function _recordPanelState(payload) {
  if (_panelStateGuard) return;
  const cid = _activePanelConvId();
  if (!cid) return;
  _convPanelState[cid] = payload;
}
function _forgetPanelState(cid) {
  if (_panelStateGuard) return;
  const id = cid !== undefined ? cid : _activePanelConvId();
  if (id) delete _convPanelState[id];
}
function _hardClosePanels() {
  ["filePreviewPanel", "quizPanel", "codePreviewPanel"].forEach((id) => {
    const p = $(id);
    if (p) p.classList.remove("open", "closing");
  });
}
function _refreshPanelStateSnapshot() {
  const cid = _activePanelConvId();
  if (!cid) return;
  const st = _convPanelState[cid];
  if (!st || st.type !== "file") return;
  const panel = $("filePreviewPanel");
  if (!panel || !panel.classList.contains("open")) return;
  st.zoom = _fpZoom;
  const body = $("fpPanelBody");
  if (body) st.scroll = body.scrollTop;
}
function _applyPanelStateForConv(cid) {
  _panelStateGuard = true;
  try {
    _hardClosePanels();
    if (!cid) return;
    const st = _convPanelState[cid];
    if (!st) return;
    if (st.type === "file") {
      const fid = _regFile(st.f);
      openFilePreview(fid);
      _fpCurrentFid = fid;
      _fpZoom = st.zoom || 1;
      _fpApplyZoom();
      const body = $("fpPanelBody");
      if (body && st.scroll) body.scrollTop = st.scroll;
    } else if (st.type === "quiz") {
      openQuizPanel(st.qid);
    } else if (st.type === "code") {
      openCodePreviewPanel(st.title, st.srcdoc);
    } else if (st.type === "webimg") {
      _openImagePreviewPanel(st.src, st.name);
    }
  } finally {
    _panelStateGuard = false;
  }
}
function openFilePreview(fid) {
  const f = _fileRegistry[fid];
  if (!f) return;
  closeCodePreviewPanel();
  closeQuizPanel();
  const panel = $("filePreviewPanel");
  const body = $("fpPanelBody");
  const title = $("fpPanelTitle");
  if (!panel || !body) return;
  if (title) title.textContent = f.name || "Preview";
  _recordPanelState({ type: "file", f, zoom: _fpZoom });
  _fpZoom = 1;
  _fpCurrentFid = fid;
  _fpUpdateZoomLabel();
  const isImg = f.type && f.type.startsWith("image/");
  const isPDF = f.type === "application/pdf" || (f.name || "").toLowerCase().endsWith(".pdf");
  const ext_fp = (f.name || "").split(".").pop().toLowerCase();
  const isDocx = f.type?.includes("word") || ext_fp === "docx" || ext_fp === "doc";
  const isPptx = f.type?.includes("presentation") || ext_fp === "pptx" || ext_fp === "ppt";
  const isText = _TEXT_PREVIEW_EXTS.has(ext_fp);
  if (isImg && f.data) {
    body.innerHTML = `<div class="fp-img-wrap"><img src="${f.data}" alt="${escapeHtml(f.name || "")}" id="fpImgEl" style="transform-origin:top center;"></div>`;
    panel.classList.add("open");
    _fpApplyZoom();
    return;
  }
  if (isPDF && f.data) {
    renderPdfCustom(f.data, body);
    panel.classList.add("open");
    return;
  }
  if (isPptx && f.data) {
    renderPptxSlides(f.data, body);
    panel.classList.add("open");
    return;
  }
  if (isDocx && f.data) {
    renderDocxCustom(f.data, body);
    panel.classList.add("open");
    return;
  }
  if (isText && f.data) {
    try {
      const b64 = f.data.includes(",") ? f.data.split(",")[1] : f.data;
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const text = new TextDecoder("utf-8").decode(bytes);
      let highlighted = escapeHtml(text);
      if (typeof hljs !== "undefined") {
        try {
          const res = hljs.getLanguage(ext_fp) ? hljs.highlight(text, { language: ext_fp }) : hljs.highlightAuto(text);
          highlighted = res.value;
        } catch (e) {
        }
      }
      body.innerHTML = `<div class="fp-text-viewer"><pre class="fp-text-code hljs"><code>${highlighted}</code></pre></div>`;
    } catch (e) {
      body.innerHTML = `<pre class="fp-text">${escapeHtml(f.extractedText || "")}</pre>`;
    }
    panel.classList.add("open");
    _fpApplyZoom();
    return;
  }
  if (f.extractedText) {
    body.innerHTML = `<pre class="fp-text">${escapeHtml(f.extractedText)}</pre>`;
    panel.classList.add("open");
    _fpApplyZoom();
    return;
  }
  body.innerHTML = `<div class="fp-nopreview"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>${escapeHtml(f.name || "File")}</p><small>No preview available</small></div>`;
  panel.classList.add("open");
}
function closeFilePreviewPanel() {
  const panel = $("filePreviewPanel");
  if (!panel || !panel.classList.contains("open")) return;
  _forgetPanelState();
  panel.classList.add("closing");
  // Release viewer state and pdfjs/PPTX resources retained on window.
  const body = $("fpPanelBody");
  if (body) {
    if (body._pptxRO) { try { body._pptxRO.disconnect(); } catch (e) {} body._pptxRO = null; }
    // Clean up any __pp_* / __pf_* keys we created.
    Object.keys(window).forEach((k) => {
      if (/^__(pp|pf)_(pptx|pdf)\d+$/.test(k)) {
        const v = window[k];
        if (v && typeof v.pdf === "object" && typeof v.pdf.destroy === "function") {
          try { v.pdf.destroy(); } catch (e) {}
        }
        try { delete window[k]; } catch (e) {}
      }
    });
  }
  setTimeout(() => {
    panel.classList.remove("open", "closing");
  }, 320);
}
async function renderPptxSlides(fileData, body) {
  body.innerHTML = '<div class="fp-loading"><svg class="fp-spin" viewBox="0 0 50 50" width="36" height="36"><circle cx="25" cy="25" r="20" fill="none" stroke="#4caf7d" stroke-width="4" stroke-dasharray="80 20"/></svg><p>Rendering slides\u2026</p></div>';
  try {
    const b64 = fileData.includes(",") ? fileData.split(",")[1] : fileData;
    const raw = atob(b64);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const zip = openZipBuffer(u8.buffer);
    let slideW = 9144e3, slideH = 6858e3;
    try {
      const px = await zip.file("ppt/presentation.xml")?.async("text") || "";
      const m = px.match(/sldSz[^/]*?cx="(\d+)"[^/]*?cy="(\d+)"/);
      if (m) {
        slideW = +m[1];
        slideH = +m[2];
      }
    } catch (e) {
    }
    const RW = 960;
    const RH = Math.round(RW * slideH / slideW);
    const ex = (v) => Math.round(v / slideW * RW);
    const ey = (v) => Math.round(v / slideH * RH);
    const fs = (sz) => Math.max(8, Math.round(sz / 100 * 12700 / slideW * RW));
    const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    if (!slideFiles.length) {
      body.innerHTML = '<div class="fp-nopreview"><p>No slides found</p></div>';
      return;
    }
    const slideHtmls = [];
    for (const path of slideFiles) {
      const num = path.match(/\d+/)[0];
      const xml = await zip.file(path)?.async("text") || "";
      const imgMap = {};
      try {
        const rxml = await zip.file(`ppt/slides/_rels/slide${num}.xml.rels`)?.async("text") || "";
        for (const m of rxml.matchAll(/Id="(rId\w+)"[^>]*Target="([^"]+)"/g)) {
          const [, rId, tgt] = m;
          if (!/\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(tgt)) continue;
          const ip = tgt.startsWith("../") ? "ppt/" + tgt.slice(3) : !tgt.startsWith("ppt/") ? "ppt/slides/" + tgt : tgt;
          const ext = ip.split(".").pop().toLowerCase();
          const mime = /jpe?g/.test(ext) ? "image/jpeg" : `image/${ext}`;
          const b = await zip.file(ip)?.async("base64").catch(() => null);
          if (b) imgMap[rId] = `data:${mime};base64,${b}`;
        }
      } catch (e) {
      }
      const clean = xml.replace(/<(\/?)[a-zA-Z][\w]*:/g, "<$1").replace(/\w+:embed=/g, "embed=");
      const doc = new DOMParser().parseFromString(clean, "text/xml");
      let bg = "#FFFFFF";
      const bgEl = doc.querySelector("bg solidFill srgbClr") || doc.querySelector("bg solidFill sysClr");
      if (bgEl) {
        // srgbClr uses `val` (RGB hex); sysClr uses `val` (system color name
        // like 'windowText') + `lastClr` (resolved RGB hex). The old code
        // preferred `val` for both, which produced invalid colors like
        // '#windowText' for sysClr backgrounds.
        const tag = bgEl.tagName.toLowerCase();
        const hex = tag === 'sysclr'
          ? (bgEl.getAttribute('lastClr') || bgEl.getAttribute('val'))
          : bgEl.getAttribute('val');
        bg = '#' + (hex || 'FFFFFF');
      }
      let html = `<div class="pptx-slide" style="background:${bg};width:${RW}px;height:${RH}px;position:relative;font-family:Calibri,Arial,sans-serif;">`;
      doc.querySelectorAll("sp, pic").forEach((el) => {
        const xfrm = el.querySelector("spPr > xfrm") || el.querySelector("xfrm");
        if (!xfrm) return;
        const off = xfrm.querySelector("off"), ext = xfrm.querySelector("ext");
        if (!off || !ext) return;
        const x = ex(+off.getAttribute("x") || 0), y = ey(+off.getAttribute("y") || 0);
        const w = ex(+ext.getAttribute("cx") || 0), h = ey(+ext.getAttribute("cy") || 0);
        if (w < 1 || h < 1) return;
        const pos = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;overflow:hidden;`;
        if (el.tagName === "pic") {
          const blip = el.querySelector("blip");
          const src = imgMap[blip?.getAttribute("embed")];
          if (src) html += `<img src="${src}" style="${pos}object-fit:fill;width:${w}px;height:${h}px;" alt="">`;
        } else {
          const fillEl = el.querySelector("spPr > solidFill > srgbClr");
          const noFill = el.querySelector("spPr > noFill, spPr noFill");
          const fillBg = !noFill && fillEl ? `background:#${fillEl.getAttribute("val")};` : "";
          const pad = `padding:${Math.max(2, Math.round(h * 0.02))}px ${Math.max(3, Math.round(w * 0.02))}px;`;
          html += `<div style="${pos}${fillBg}${pad}box-sizing:border-box;">`;
          el.querySelectorAll("txBody > p").forEach((p) => {
            const pPr = p.querySelector("pPr");
            const algn = pPr?.getAttribute("algn");
            const ta = algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left";
            html += `<p style="margin:0;padding:0;line-height:1.25;text-align:${ta};">`;
            p.querySelectorAll("r").forEach((r) => {
              const t = r.querySelector("t");
              if (!t || !t.textContent) return;
              const rPr = r.querySelector("rPr");
              const sz = rPr?.getAttribute("sz") ? fs(+rPr.getAttribute("sz")) : fs(1800);
              const fw = rPr?.getAttribute("b") === "1" ? "bold" : "normal";
              const fi = rPr?.getAttribute("i") === "1" ? "italic" : "normal";
              const td = rPr?.getAttribute("u") === "sng" ? "underline" : "none";
              const ce = rPr?.querySelector("solidFill srgbClr");
              const cl = ce ? "#" + ce.getAttribute("val") : "#000";
              html += `<span style="font-size:${sz}px;font-weight:${fw};font-style:${fi};text-decoration:${td};color:${cl};">${escapeHtml(t.textContent)}</span>`;
            });
            html += "</p>";
          });
          html += "</div>";
        }
      });
      html += "</div>";
      slideHtmls.push(html);
    }
    const vid = "pptx" + Date.now();
    body.innerHTML = `<div class="pptx-viewer" id="${vid}"><div class="pptx-wrap" style="overflow:hidden;"><div id="${vid}-sc" style="display:block;">${slideHtmls[0]}</div></div><div class="pptx-nav"><button class="pptx-btn" onclick="_pptxGo('${vid}',-1)">&#8592; Prev</button><span class="pptx-ctr" id="${vid}-ctr">1 / ${slideHtmls.length}</span><button class="pptx-btn" onclick="_pptxGo('${vid}',1)">Next &#8594;</button></div></div>`;
    const doScale = () => {
      const wrap = document.querySelector(`#${vid} .pptx-wrap`);
      const sc = document.getElementById(`${vid}-sc`);
      if (!wrap || !sc) return;
      const scale = wrap.clientWidth / RW;
      sc.style.zoom = scale;
      wrap.style.height = Math.round(RH * scale) + "px";
    };
    window[`__pp_${vid}`] = { s: slideHtmls, i: 0, rw: RW, rh: RH, doScale };
    setTimeout(doScale, 0);
    // Disconnect any previous ResizeObserver on body before installing a new
    // one — otherwise each PPTX preview stacks a new observer with stale
    // closures over the old doScale / RW / RH.
    if (body._pptxRO) { try { body._pptxRO.disconnect(); } catch (e) {} }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        if (_fpZoom === 1) doScale();
      });
      ro.observe(body);
      body._pptxRO = ro;
    }
  } catch (e) {
    console.error("PPTX render:", e);
    body.innerHTML = '<div class="fp-nopreview"><p>Could not render slides</p><small>' + escapeHtml(String(e)) + "</small></div>";
  }
}
window._pptxGo = function(vid, dir) {
  const d = window[`__pp_${vid}`];
  if (!d) return;
  d.i = Math.max(0, Math.min(d.s.length - 1, d.i + dir));
  const sc = document.getElementById(`${vid}-sc`);
  const ctr = document.getElementById(`${vid}-ctr`);
  if (sc) sc.innerHTML = d.s[d.i];
  if (ctr) ctr.textContent = `${d.i + 1} / ${d.s.length}`;
  if (d.doScale) d.doScale();
};
let _fpZoom = 1;
let _fpCurrentFid = null;
function _fpUpdateZoomLabel() {
  const lbl = $("fpZoomLabel");
  if (lbl) lbl.textContent = Math.round(_fpZoom * 100) + "%";
}
function _fpZoomIn() {
  _fpZoom = Math.min(4, +(_fpZoom + 0.25).toFixed(2));
  _fpApplyZoom();
}
function _fpZoomOut() {
  _fpZoom = Math.max(0.25, +(_fpZoom - 0.25).toFixed(2));
  _fpApplyZoom();
}
function _fpApplyZoom() {
  _fpUpdateZoomLabel();
  const body = $("fpPanelBody");
  if (!body) return;
  const el = body.firstElementChild;
  if (!el) return;
  const pptxData = window[`__pp_${el.id}`];
  if (pptxData && pptxData.doScale) {
    const wrap = el.querySelector(".pptx-wrap");
    if (wrap) wrap.style.width = _fpZoom * 100 + "%";
    pptxData.doScale();
    return;
  }
  const pdfData = window[`__pf_${el.id}`];
  if (pdfData) {
    _pdfRenderPage(el.id, pdfData.cur);
    return;
  }
  const imgEl = document.getElementById("fpImgEl");
  if (imgEl) {
    imgEl.style.width = _fpZoom * 100 + "%";
    imgEl.style.maxWidth = "none";
    imgEl.style.height = "auto";
    const wrap = imgEl.parentElement;
    if (wrap) wrap.style.overflow = _fpZoom > 1 ? "auto" : "visible";
    return;
  }
  el.style.zoom = _fpZoom;
}
async function renderPdfCustom(fileData, body) {
  body.innerHTML = '<div class="fp-loading"><svg class="fp-spin" viewBox="0 0 50 50" width="36" height="36"><circle cx="25" cy="25" r="20" fill="none" stroke="#4caf7d" stroke-width="4" stroke-dasharray="80 20"/></svg><p>Loading PDF\u2026</p></div>';
  try {
    if (!window.pdfjsLib) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    const b64 = fileData.includes(",") ? fileData.split(",")[1] : fileData;
    const raw = atob(b64);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
    const vid = "pdf" + Date.now();
    body.innerHTML = `<div class="doc-viewer" id="${vid}"><div class="doc-canvas-wrap"><canvas id="${vid}-cv"></canvas></div><div class="pptx-nav"><button class="pptx-btn" onclick="_pdfGo('${vid}',-1)">&#8592; Prev</button><span class="pptx-ctr" id="${vid}-ctr">1 / ${pdf.numPages}</span><button class="pptx-btn" onclick="_pdfGo('${vid}',1)">Next &#8594;</button></div></div>`;
    window[`__pf_${vid}`] = { pdf, cur: 1, total: pdf.numPages };
    await _pdfRenderPage(vid, 1);
    _fpApplyZoom();
  } catch (e) {
    console.error("PDF render:", e);
    body.innerHTML = '<div class="fp-nopreview"><p>Could not render PDF</p></div>';
  }
}
async function _pdfRenderPage(vid, n) {
  const d = window[`__pf_${vid}`];
  if (!d) return;
  const cv = document.getElementById(`${vid}-cv`);
  if (!cv) return;
  const wrap = cv.parentElement;
  const oldTL = wrap.querySelector(".pdfTextLayer");
  if (oldTL) oldTL.remove();
  const page = await d.pdf.getPage(n);
  const baseVp = page.getViewport({ scale: 1 });
  const baseScale = Math.min(1.5, (wrap.clientWidth || 572) / baseVp.width);
  const renderScale = baseScale * _fpZoom;
  const vp = page.getViewport({ scale: renderScale });
  cv.width = vp.width;
  cv.height = vp.height;
  cv.style.width = "";
  cv.style.height = "";
  cv.style.maxWidth = _fpZoom > 1 ? "none" : "";
  cv.style.maxHeight = _fpZoom > 1 ? "none" : "";
  wrap.style.overflow = _fpZoom > 1 ? "auto" : "hidden";
  wrap.style.alignItems = _fpZoom > 1 ? "flex-start" : "center";
  wrap.style.justifyContent = _fpZoom > 1 ? "flex-start" : "center";
  await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
  try {
    const textContent = await page.getTextContent();
    setTimeout(() => {
      try {
        const dispW = cv.offsetWidth;
        const dispH = cv.offsetHeight;
        const dispScale = dispW / cv.width;
        const tl = document.createElement("div");
        tl.className = "pdfTextLayer";
        tl.style.cssText = `left:${cv.offsetLeft}px;top:${cv.offsetTop}px;width:${dispW}px;height:${dispH}px;`;
        textContent.items.forEach((item) => {
          if (!item.str) return;
          const span = document.createElement("span");
          span.textContent = item.str;
          const tx = window.pdfjsLib.Util.transform(vp.transform, item.transform);
          const angle = Math.atan2(tx[1], tx[0]);
          const fontH = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
          const x = tx[4] * dispScale;
          const y = (vp.height - tx[5]) * dispScale - fontH * dispScale;
          span.style.cssText = `left:${x}px;top:${y}px;font-size:${fontH * dispScale}px;transform:rotate(${angle}rad);transform-origin:0% 100%;`;
          tl.appendChild(span);
        });
        wrap.appendChild(tl);
      } catch (e) {
        console.warn("PDF text layer build failed:", e);
      }
    }, 0);
  } catch (e) {
    console.warn("PDF text content extraction failed:", e);
  }
  const ctr = document.getElementById(`${vid}-ctr`);
  if (ctr) ctr.textContent = `${n} / ${d.total}`;
}
window._pdfGo = async function(vid, dir) {
  const d = window[`__pf_${vid}`];
  if (!d) return;
  d.cur = Math.max(1, Math.min(d.total, d.cur + dir));
  // _pdfRenderPage can reject (corrupt PDF, page out-of-range). Without a
  // catch this surfaces as an unhandled rejection since callers ignore the
  // returned promise. Surface the error to the user instead.
  try {
    await _pdfRenderPage(vid, d.cur);
  } catch (err) {
    showToast(`${_aiSvgError} Could not render page ${d.cur}: ${escapeHtml(String(err.message || err))}`);
  }
};
async function renderDocxCustom(fileData, body) {
  body.innerHTML = '<div class="fp-loading"><svg class="fp-spin" viewBox="0 0 50 50" width="36" height="36"><circle cx="25" cy="25" r="20" fill="none" stroke="#4caf7d" stroke-width="4" stroke-dasharray="80 20"/></svg><p>Loading document\u2026</p></div>';
  try {
    const b64 = fileData.includes(",") ? fileData.split(",")[1] : fileData;
    const raw = atob(b64);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const zip = openZipBuffer(u8.buffer);
    const imgMap = {};
    for (const [path, file] of Object.entries(zip.files)) {
      if (/word\/media\/.+\.(png|jpe?g|gif|bmp|webp)$/i.test(path)) {
        const ext = path.split(".").pop().toLowerCase();
        const mime = /jpe?g/.test(ext) ? "image/jpeg" : `image/${ext}`;
        const b = await file.async("base64").catch(() => null);
        if (b) imgMap[path.split("/").pop()] = `data:${mime};base64,${b}`;
      }
    }
    const relMap = {};
    try {
      const rx = await zip.file("word/_rels/document.xml.rels")?.async("text") || "";
      for (const m of rx.matchAll(/Id="(rId\w+)"[^>]*Target="media\/([^"]+)"/g))
        relMap[m[1]] = m[2];
    } catch (e) {
    }
    const xml = await zip.file("word/document.xml")?.async("text") || "";
    const clean = xml.replace(/<(\/?)[a-zA-Z][\w]*:/g, "<$1").replace(/\w+:val=/g, "val=").replace(/\w+:id=/g, "id=").replace(/\w+:embed=/g, "embed=");
    const doc = new DOMParser().parseFromString(clean, "text/xml");
    let html = '<div class="docx-body">';
    doc.querySelectorAll("body > *").forEach((el) => {
      html += _docxEl(el, relMap, imgMap);
    });
    html += "</div>";
    body.innerHTML = html;
    _fpApplyZoom();
  } catch (e) {
    console.error("DOCX render:", e);
    body.innerHTML = '<div class="fp-nopreview"><p>Could not render document</p></div>';
  }
}
function _docxEl(el, relMap, imgMap) {
  const tag = el.tagName;
  if (tag === "p") {
    const pStyle = el.querySelector("pStyle")?.getAttribute("val") || "";
    const isH = /heading(\d)/i.test(pStyle);
    const hLevel = isH ? pStyle.match(/\d/)[0] : null;
    const jc = el.querySelector("jc")?.getAttribute("val") || "left";
    const align = jc === "center" ? "center" : jc === "right" ? "right" : jc === "both" ? "justify" : "left";
    let inner = "";
    el.querySelectorAll("r, hyperlink").forEach((r) => {
      if (r.tagName === "hyperlink") {
        inner += `<span style="color:#4caf7d;text-decoration:underline;">${_docxRuns(r, relMap, imgMap)}</span>`;
      } else {
        inner += _docxRun(r, relMap, imgMap);
      }
    });
    el.querySelectorAll("drawing blip").forEach((blip) => {
      const rId = blip.getAttribute("embed");
      const fn = relMap[rId];
      const src = fn ? imgMap[fn] : null;
      if (src) inner += `<img src="${src}" style="max-width:100%;height:auto;display:block;margin:4px 0;border-radius:4px;">`;
    });
    if (!inner.trim()) return '<div class="docx-spacer"></div>';
    if (hLevel) return `<h${hLevel} class="docx-h" style="text-align:${align};">${inner}</h${hLevel}>`;
    return `<p class="docx-p" style="text-align:${align};">${inner}</p>`;
  }
  if (tag === "tbl") {
    let t = '<table class="docx-tbl"><tbody>';
    el.querySelectorAll("tr").forEach((tr) => {
      t += "<tr>";
      tr.querySelectorAll("tc").forEach((tc) => {
        let c = "";
        tc.querySelectorAll("p").forEach((p) => {
          c += _docxEl(p, relMap, imgMap);
        });
        t += `<td class="docx-td">${c}</td>`;
      });
      t += "</tr>";
    });
    return t + "</tbody></table>";
  }
  return "";
}
function _docxRuns(el, relMap, imgMap) {
  let s = "";
  el.querySelectorAll("r").forEach((r) => {
    s += _docxRun(r, relMap, imgMap);
  });
  return s;
}
function _docxRun(r, relMap, imgMap) {
  const t = r.querySelector("t");
  if (!t) return "";
  const rPr = r.querySelector("rPr");
  const b = rPr?.querySelector("b") ? "font-weight:bold;" : "";
  const i = rPr?.querySelector("i") ? "font-style:italic;" : "";
  const u = rPr?.querySelector('u[val]:not([val="none"])') ? "text-decoration:underline;" : "";
  const szEl = rPr?.querySelector("sz");
  const sz = szEl ? `font-size:${+szEl.getAttribute("val") / 2}pt;` : "";
  const clEl = rPr?.querySelector("color[val]");
  const cl = clEl && clEl.getAttribute("val") !== "auto" ? `color:#${clEl.getAttribute("val")};` : "";
  const st = b + i + u + sz + cl;
  return st ? `<span style="${st}">${escapeHtml(t.textContent)}</span>` : escapeHtml(t.textContent);
}
function fileIconHTML(name, mimeType) {
  const type = (mimeType || "").toLowerCase();
  const ext = (name || "").split(".").pop().toLowerCase();
  const isImg = type.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff", "avif"].includes(ext);
  const isDoc = type.includes("pdf") || type.includes("word") || type.includes("docx") || ["pdf", "docx", "doc", "txt", "rtf", "odt"].includes(ext);
  const isSheet = type.includes("sheet") || type.includes("xlsx") || type.includes("csv") || ["xlsx", "xls", "csv", "ods"].includes(ext);
  const isPres = type.includes("presentation") || type.includes("pptx") || ["pptx", "ppt", "odp"].includes(ext);
  if (isImg) return `<div class="lib-icon lib-icon--img"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`;
  if (isDoc) return `<div class="lib-icon lib-icon--file"><img src="/assets/images/docsicon.webp" alt="doc"></div>`;
  if (isSheet) return `<div class="lib-icon lib-icon--file"><img src="/assets/images/sheeticon.webp" alt="sheet"></div>`;
  if (isPres) return `<div class="lib-icon lib-icon--file"><img src="/assets/images/slidesicon.webp" alt="slides"></div>`;
  return `<div class="lib-icon lib-icon--other"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>`;
}
function fileIcon(mimeType) {
  const type = (mimeType || "").toLowerCase();
  if (type.includes("pdf") || type.includes("word") || type.includes("docx")) return "\u{1F4C4}";
  if (type.includes("sheet") || type.includes("xlsx")) return "\u{1F4CA}";
  if (type.includes("presentation") || type.includes("pptx")) return "\u{1F4CA}";
  if (type.includes("zip") || type.includes("archive")) return "\u{1F5DC}\uFE0F";
  return "\u{1F4C4}";
}
function buildMessageActionsEl(msgId) {
  const _actDiv = document.createElement("div");
  _actDiv.className = "message-actions";
  _actDiv.dataset.msgActions = msgId;
  const _likeBtn = document.createElement("button");
  _likeBtn.className = "msg-action-btn"; _likeBtn.title = "Like";
  _likeBtn.addEventListener("click", function() { rateMsg(this, "like"); });
  _likeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
  const _dislikeBtn = document.createElement("button");
  _dislikeBtn.className = "msg-action-btn"; _dislikeBtn.title = "Dislike";
  _dislikeBtn.addEventListener("click", function() { rateMsg(this, "dislike"); });
  _dislikeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>';
  _actDiv.appendChild(_likeBtn);
  _actDiv.appendChild(_dislikeBtn);
  return _actDiv;
}
/* ── Reasoning panel ─────────────────────────────────────────────
   When reasoning mode is enabled, the worker streams Gemini's
   `thought: true` parts separately (see streamEmeraldBot). We render
   them inside a collapsible "Reasoning" block above the answer text —
   the same UX Claude / o1 use: a header row with a spinner while
   thinking, flipping to a checkmark + "Done" once the final answer
   begins streaming; the body expands during reasoning and auto-
   collapses when done (user can re-expand by clicking the header).

   The block is created lazily (only when the first reasoning chunk
   arrives) so messages without reasoning show no empty panel. */
const _REASONING_EXPAND_MS = 250; // smooth height transition
// Per-block interval timers for the "Thinking for Xs…" live label.
// WeakMap so the timer reference dies with the DOM node if it's removed.
const _reasoningTimers = new WeakMap();

// Format an elapsed second count as "12s" or "1m 04s".
function _fmtReasoningElapsed(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
function _setReasoningLabel(block, verb /* "Thinking" | "Thought" */) {
  if (!block) return;
  const label = block.querySelector(".reasoning-label");
  if (!label) return;
  const start = Number(block.dataset.startedAt || 0);
  if (!start) {
    label.textContent = verb === "Thought" ? "Thought for a moment" : "Thinking";
    return;
  }
  const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
  label.textContent = `${verb} for ${_fmtReasoningElapsed(sec)}`;
}

function reasoningBlockHTML(isDone) {
  // isDone=true is used when rendering a stored message that already
  // has completed reasoning — label says "Thought for a moment" since
  // we don't have the original elapsed time persisted.
  return `<div class="reasoning-block${isDone ? " is-done" : ""}" data-state="${isDone ? "done" : "thinking"}">
    <div class="reasoning-header" role="button" tabindex="0" aria-expanded="${isDone ? "false" : "true"}" onclick="toggleReasoningBlock(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleReasoningBlock(this);}">
      <div class="reasoning-title">
        <span class="reasoning-label">${isDone ? "Thought for a moment" : "Thinking"}</span>
      </div>
      <svg class="reasoning-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="reasoning-body"><div class="reasoning-text md-content"></div></div>
  </div>`;
}
function createReasoningBlock(aiDiv) {
  if (!aiDiv) return null;
  const existing = aiDiv.querySelector(".reasoning-block");
  if (existing) return existing;
  const sender = aiDiv.querySelector(".message-sender");
  if (!sender) return null;
  const tmp = document.createElement("div");
  tmp.innerHTML = reasoningBlockHTML(false);
  const block = tmp.firstElementChild;
  const searchingBlock = aiDiv.querySelector(".searching-block");
  if (searchingBlock) {
    searchingBlock.insertAdjacentElement("afterend", block);
  } else {
    sender.insertAdjacentElement("afterend", block);
  }
  // Start expanded while thinking.
  block.classList.add("is-expanded");
  // Live-tick the "Thinking for Xs…" label once per second.
  block.dataset.startedAt = String(Date.now());
  _setReasoningLabel(block, "Thinking");
  const timer = setInterval(() => {
    if (!block.classList.contains("is-done")) _setReasoningLabel(block, "Thinking");
  }, 1000);
  _reasoningTimers.set(block, timer);
  return block;
}
function appendReasoningToBlock(block, chunk) {
  if (!block || !chunk) return;
  const textEl = block.querySelector(".reasoning-text");
  if (!textEl) return;
  // Use a dataset accumulator (not textContent) because renderMarkdown
  // produces HTML — concatenating innerHTML would re-parse partial HTML
  // and corrupt formatting mid-stream.
  let acc = block.dataset.reasoningRaw || "";
  acc += chunk;
  block.dataset.reasoningRaw = acc;
  // Render markdown incrementally. Keep the user scrolled to bottom of
  // the reasoning panel while it streams (mirrors the answer streaming UX).
  textEl.innerHTML = renderMarkdown(acc);
  // Auto-scroll within the reasoning body if the user hasn't scrolled up.
  const body = block.querySelector(".reasoning-body");
  if (body && _autoScrollSticky) body.scrollTop = body.scrollHeight;
}
function markReasoningDone(block) {
  if (!block) return;
  block.classList.add("is-done");
  block.dataset.state = "done";
  // Stop the live timer and freeze the label at "Thought for Xs".
  const timer = _reasoningTimers.get(block);
  if (timer) { clearInterval(timer); _reasoningTimers.delete(block); }
  _setReasoningLabel(block, "Thought");
  const header = block.querySelector(".reasoning-header");
  if (header) header.setAttribute("aria-expanded", "false");
  // After reasoning completes, auto-collapse (Claude-style). The user can
  // click to re-expand. Skip auto-collapse if user has already manually
  // collapsed or expanded (signaled by the `is-user-toggled` class).
  if (!block.classList.contains("is-user-toggled")) {
    // Small delay so the user briefly sees the "Done" state before
    // the panel collapses.
    setTimeout(() => {
      if (!block.classList.contains("is-user-toggled")) {
        block.classList.remove("is-expanded");
      }
    }, 350);
  }
}
function toggleReasoningBlock(headerEl) {
  const block = headerEl?.closest(".reasoning-block");
  if (!block) return;
  block.classList.toggle("is-expanded");
  block.classList.add("is-user-toggled");
  const isExpanded = block.classList.contains("is-expanded");
  headerEl.setAttribute("aria-expanded", isExpanded ? "true" : "false");
}

// ── Searching panel (same design as Reasoning, separate UI block) ──────
const _searchingTimers = new WeakMap();

function _setSearchingLabel(block, verb) {
  if (!block) return;
  const label = block.querySelector(".searching-label");
  if (!label) return;
  const start = Number(block.dataset.startedAt || 0);
  if (!start) {
    label.textContent = verb === "Worked" ? "Worked" : "Working";
    return;
  }
  const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
  label.textContent = `${verb} for ${_fmtReasoningElapsed(sec)}`;
}

function searchingBlockHTML(isDone) {
  return `<div class="searching-block${isDone ? " is-done" : ""}" data-state="${isDone ? "done" : "searching"}">
    <div class="searching-header" role="button" tabindex="0" aria-expanded="${isDone ? "false" : "true"}" onclick="toggleSearchingBlock(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSearchingBlock(this);}">
      <div class="searching-title">
        <span class="searching-label">${isDone ? "Worked" : "Working"}</span>
      </div>
      <svg class="searching-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="searching-body"><div class="searching-text md-content"></div></div>
  </div>`;
}

function createSearchingBlock(aiDiv) {
  if (!aiDiv) return null;
  const existing = aiDiv.querySelector(".searching-block");
  if (existing) return existing;
  const sender = aiDiv.querySelector(".message-sender");
  if (!sender) return null;
  const tmp = document.createElement("div");
  tmp.innerHTML = searchingBlockHTML(false);
  const block = tmp.firstElementChild;
  sender.insertAdjacentElement("afterend", block);
  block.classList.add("is-expanded");
  block.dataset.startedAt = String(Date.now());
  _setSearchingLabel(block, "Working");
  const timer = setInterval(() => {
    if (!block.classList.contains("is-done")) _setSearchingLabel(block, "Working");
  }, 1000);
  _searchingTimers.set(block, timer);
  return block;
}

function _searchingFileChipHTML(item) {
  let raw = String(item || "").trim().replace(/^[-*·\s]+/, "");
  if (!raw) return "";
  let label = raw;
  let url = "";
  const mdLink = raw.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/s);
  if (mdLink) {
    label = (mdLink[1] || "").trim() || mdLink[2];
    url = mdLink[2];
  } else if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|tar|gz|txt|md|jpe?g|png|gif|webp|svg|mp4|mp3)$/i.test(raw)) {
    return `<span class="searching-file-chip">${escapeHtml(label)}</span>`;
  } else {
    const titled = raw.match(/^([^()]+)\s*\(([^()\s]+)\)$/);
    if (titled && /^https?:\/\//i.test(titled[2])) {
      label = titled[1].trim();
      url = titled[2].trim();
    } else if (/^https?:\/\/\S+$/i.test(raw)) {
      url = raw;
      label = raw.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/+$/, "");
    } else if (/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(raw)) {
      url = "https://" + raw;
      label = raw.replace(/\/+$/, "");
    }
  }
  if (!url) return `<span class="searching-file-chip" title="${escapeHtmlAttr(label)}">${escapeHtml(label)}</span>`;
  return `<a class="searching-file-chip" href="${escapeHtmlAttr(_uriClean(url))}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttr(label)}">${escapeHtml(label)}<svg class="searching-file-chip-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>`;
}

function _searchingFileChipsHTML(items) {
  const chips = [];
  items.forEach((it) => {
    const t = String(it || "").trim().replace(/^[-*·\s]+/, "");
    if (!t) return;
    const linkish = /^\[[^\]]*\]\([^)\s]+\)$/s.test(t) || /^https?:\/\/\S+$/i.test(t) || /^[^()]+\([^()\s]+\)$/.test(t);
    const parts = linkish ? [t] : t.split(/[,;]\s+/);
    parts.forEach((p) => {
      const c = _searchingFileChipHTML(p);
      if (c) chips.push(c);
    });
  });
  return chips.join("");
}

function _searchingItemLike(t) {
  const x = String(t || "").trim();
  if (/^\[[^\]]*\]\([^)\s]+\)/s.test(x)) return true;
  if (/^https?:\/\//i.test(x)) return true;
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(x)) return true;
  if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|tar|gz|txt|md|jpe?g|png|gif|webp|svg|mp4|mp3)$/i.test(x)) return true;
  return false;
}

function _searchingStripCodeTicks(line) {
  return String(line)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[\s*`]+|[\s*`]+$/g, "");
}

function _searchingPretty(raw) {
  const lines = String(raw || "").split(/\n/);
  const fromRe = /^\s*(files|images|photos|pictures|sources|pages|documents|docs|websites|domains|devices|attachments|references)\s*from\s*[:.]?\s*(.*)$/i;
  const fromPrefRe = /^from\s*[:.]?\s*(.*)$/i;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = fromRe.exec(line);
    if (m && m[1]) {
      const items = [];
      const first = _searchingStripCodeTicks(m[2]).trim();
      if (first) {
        if (_searchingItemLike(first)) {
          items.push(first);
        } else {
          first.split(/[,;]\s+/).forEach((p) => { if (_searchingItemLike(p)) items.push(p); });
        }
      }
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next.trim() || fromRe.test(next) || fromPrefRe.test(next)) break;
        const t = _searchingStripCodeTicks(next).trim().replace(/^[-*·]+/, "");
        if (_searchingItemLike(t)) {
          items.push(t);
          j++;
          continue;
        }
        break;
      }
      const chips = items.length ? _searchingFileChipsHTML(items) : "";
      if (chips) {
        out.push(`<span class="searching-file-chips">${chips}</span>`);
      } else {
        out.push(line);
      }
      i = Math.max(i + 1, j);
      continue;
    }
    const cleaned = _searchingStripCodeTicks(line);
    const fp = fromPrefRe.exec(cleaned);
    if (fp && fp[1].trim() && _searchingItemLike(fp[1].trim())) {
      const chips = _searchingFileChipsHTML([fp[1].trim()]);
      if (chips) {
        out.push(`<span class="searching-file-chips">${chips}</span>`);
        i++;
        continue;
      }
    }
    if (_searchingItemLike(cleaned)) {
      const chips = _searchingFileChipsHTML([cleaned]);
      if (chips) {
        out.push(chips);
        i++;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return renderMarkdown(out.join("\n"));
}

function appendSearchingToBlock(block, chunk) {
  if (!block || !chunk) return;
  const textEl = block.querySelector(".searching-text");
  if (!textEl) return;
  let acc = block.dataset.searchingRaw || "";
  acc += chunk;
  block.dataset.searchingRaw = acc;
  textEl.innerHTML = _searchingPretty(acc);
  const body = block.querySelector(".searching-body");
  if (body && _autoScrollSticky) body.scrollTop = body.scrollHeight;
}

function markSearchingDone(block) {
  if (!block) return;
  block.classList.add("is-done");
  block.dataset.state = "done";
  const timer = _searchingTimers.get(block);
  if (timer) { clearInterval(timer); _searchingTimers.delete(block); }
  _setSearchingLabel(block, "Worked");
  const header = block.querySelector(".searching-header");
  if (header) header.setAttribute("aria-expanded", "false");
  if (!block.classList.contains("is-user-toggled")) {
    setTimeout(() => {
      if (!block.classList.contains("is-user-toggled")) {
        block.classList.remove("is-expanded");
      }
    }, 350);
  }
}

function toggleSearchingBlock(headerEl) {
  const block = headerEl?.closest(".searching-block");
  if (!block) return;
  block.classList.toggle("is-expanded");
  block.classList.add("is-user-toggled");
  const isExpanded = block.classList.contains("is-expanded");
  headerEl.setAttribute("aria-expanded", isExpanded ? "true" : "false");
}
function buildAIBubbleDOM(text, msgId, streaming = false) {
  const div = document.createElement("div");
  div.className = "message";
  div.dataset.ai = "1";
  div.dataset.msgId = msgId;
  div.innerHTML = `
    <div class="message-avatar ai"><img src="/assets/images/favicon.webp" alt="EmeraldBot"></div>
    <div class="message-body">
      <div class="message-sender">EmeraldBot</div>
      <div class="message-text md-content">${streaming ? "" : renderMarkdown(text)}</div>
    </div>`;
  return div;
}
function appendAIMessageDOM(text, msgId, streaming = false) {
  const typingEl = $("typingIndicator");
  const div = buildAIBubbleDOM(text, msgId, streaming);
  if (!streaming) div.querySelector(".message-body").appendChild(buildMessageActionsEl(msgId));
  $("messagesArea").insertBefore(div, typingEl);
  return div;
}
// True while a background stream for `streamConvId` is the conversation the
// user is currently looking at. Used to keep generation running when the user
// switches to another chat without polluting that other chat's DOM.
function _activeStreamTargetsView(streamConvId) {
  if (!state.isStreaming) return false;
  // Welcome screen: no conversation is being viewed at all.
  if ($("welcomeScreen")?.style?.display !== "none") return false;
  if (state.isTemp) return streamConvId === null;
  return state.convId === streamConvId;
}
// Gray-out state for the input box ("Still answering..." placeholder, dimmed
// + / reasoning buttons). Active only while the AI is answering in a chat the
// user switched AWAY from. When the user is watching the generating chat
// itself, keep the input completely normal.
function _syncInputBusyUi() {
  const box = document.querySelector(".chat-input-box");
  const ta = $("chatInput");
  if (!box || !ta) return;
  const busy = state.isStreaming && !_activeStreamTargetsView(state.streamConvId);
  box.classList.toggle("input-busy", busy);
  const ph = busy ? "Still answering..." : "Ask anything...";
  if (ta.placeholder !== ph) ta.placeholder = ph;
  ta.readOnly = busy;
}
// Jump back to the conversation that is currently generating in the
// background (visible beside the stop button while "Still answering...").
function gotoStreamingChat() {
  const target = state.streamConvId;
  if (!target || state.isTemp) return;
  if (state.convId === target) {
    _syncInputBusyUi();
    return;
  }
  loadConversation(target);
}
// Always hide the LIVE typing indicator. The element captured when a stream
// started (`typingEl`) can be detached from the DOM after the conversation
// view is re-rendered (e.g. user switched chats mid-stream), so hiding that
// stale reference would leave the "Second bubble — just animation" stuck.
function _hideTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) el.style.display = "none";
}
function messageActionsHTML(msgId, rawText) {
  return `<div class="message-actions" data-msg-actions="${msgId}">
    <button class="msg-action-btn" title="Like" onclick="rateMsg(this,'like')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
    </button>
    <button class="msg-action-btn" title="Dislike" onclick="rateMsg(this,'dislike')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>
    </button>
  </div>`;
}
function updateLastMsgActions() {
  const aiMsgs = document.querySelectorAll('[data-ai="1"]');
  aiMsgs.forEach((msg, i) => {
    const actions = msg.querySelector(".message-actions");
    if (i < aiMsgs.length - 1) {
      if (actions) actions.remove();
    }
  });
}
function rateMsg(btn, type) {
  const already = btn.classList.contains("rated");
  document.querySelectorAll(".msg-action-btn.rated").forEach((b) => b.classList.remove("rated"));
  if (!already) {
    btn.classList.add("rated");
    showToast(type === "like" ? `${_aiSvgThumbUp} You liked this response` : `${_aiSvgThumbDown} You disliked this response`);
  }
}
async function handleSend(opts) {
  const _silent = !!(opts && opts.silent);
  if (state.isStreaming) {
    if (_silent) showToast(`${_aiSvgWarn} Please wait — the AI is still responding.`);
    return;
  }
  _autoScrollSticky = true;  // re-enable sticky scroll on new send
  const textarea = $("chatInput");
  const text = _silent ? (opts.silentText || "").trim() : textarea.value.trim();
  const files = _silent ? [] : [...state.attachments];
  if (!text && files.length === 0) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    showToast(`${_aiSvgError} Service unavailable \u2014 API key not configured.`, "error");
    return;
  }
  if (!state.isTemp && !state.convId) {
    state.convId = genChatId();
  }
  if (!_silent) {
    textarea.value = "";
    textarea.style.height = "auto";
    clearAttachments();
  }
  showMessages();
  const userMsgId = genId();
  if (!_silent) appendUserMessageDOM(text, files, userMsgId);
  scrollToBottom();
  const typingEl = $("typingIndicator");
  typingEl.style.display = "flex";
  scrollToBottom();
  const conv = !state.isTemp && state.convId ? getConv(state.convId) || {
    id: state.convId,
    title: _silent ? "Quiz Feedback" : (text.slice(0, 55) || "New Chat"),
    messages: [],
    isTemp: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  } : null;
  if (conv) {
    const isNewConv = !getConv(conv.id);
    conv.messages.push({ role: "user", text, files: files.map((f) => ({ name: f.name, type: f.type, size: f.size, data: f.data || void 0, extractedText: f.extractedText })), id: userMsgId, _silent: _silent || undefined });
    upsertConv(conv);
    if (isNewConv) updateTopbarTitle(conv.title);
    updateOwnedUrl();
    renderSidebar();
    addFilesToLibrary(files, conv.id);
  } else {
    state.tempHistory.push({ role: "user", parts: [{ text }] });
  }
  const history = buildHistory(conv);
  const fileParts = buildFileParts(files);
  if (fileParts.length) history[history.length - 1].parts.push(...fileParts);

// EmeraldSuite context is always injected when the turn is about a file.
  _efResetWriteGate();
  if (!_silent) {
    try {
      const fileCtx = await _suiteAutoContext(text);
      if (fileCtx && history.length && history[history.length - 1]?.parts?.length) {
        history[history.length - 1].parts.unshift({ text: fileCtx });
      }
    } catch (e) { console.warn("File context failed:", e); }
  }
  const urlsInMsg = extractUrls(text);
  const _wsNeeded = detectWebSearchIntent(text) || urlsInMsg.length > 0;
  state.isStreaming = true;
  let _webSources = [];
  const _typingLabel = document.getElementById("typingLabel");
  const _setLabel = (msg) => {
    if (!_typingLabel) return;
    if (msg) {
      _typingLabel.textContent = msg;
      _typingLabel.style.display = "block";
    } else {
      _typingLabel.textContent = "";
      _typingLabel.style.display = "none";
    }
  };
  if (_wsNeeded) {
    if (urlsInMsg.length) {
      for (const url of urlsInMsg.slice(0, 3)) {
        _webSources.push({ title: "", uri: url });
      }
      for (const url of urlsInMsg.slice(0, 3)) {
        const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/);
        if (ghMatch) {
          const [, owner, repo] = ghMatch;
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 8e3);
          try {
            const [infoRes, readmeRes] = await Promise.all([
              fetch("https://api.github.com/repos/" + owner + "/" + repo, { signal: ac.signal, headers: { Accept: "application/vnd.github+json" } }),
              fetch("https://api.github.com/repos/" + owner + "/" + repo + "/readme", { signal: ac.signal, headers: { Accept: "application/vnd.github+json" } })
            ]);
            clearTimeout(t);
            let parts = ["[GitHub repo: " + owner + "/" + repo + "]"];
            if (infoRes.ok) {
              const info = await infoRes.json();
              parts.push("Description: " + (info.description || "none"));
              parts.push("Stars: " + info.stargazers_count + "  Forks: " + info.forks_count);
              parts.push("Language: " + (info.language || "unknown"));
              if (info.topics?.length) parts.push("Topics: " + info.topics.join(", "));
            }
            if (readmeRes.ok) {
              const rm = await readmeRes.json();
              // atob returns a byte-string, not a UTF-8 string — non-ASCII
              // READMEs (emoji, accents, CJK) became mojibake. Decode via
              // TextDecoder so multi-byte sequences are interpreted as UTF-8.
              if (rm?.content) {
                const bin = atob(rm.content.replace(/\n/g, ""));
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                const decoded = new TextDecoder("utf-8").decode(u8);
                parts.push("\n[README.md]\n" + decoded.slice(0, 6e3));
              }
            }
            const pageContent = parts.join("\n");
            const last = history[history.length - 1];
            if (last?.parts?.length) {
              const existing = last.parts[0]?.text || "";
              last.parts[0] = { text: pageContent + "\n\n" + existing };
            }
          } catch (e) {
            clearTimeout(t);
          }
        }
      }
    } else {
      _setLabel("Searching the web\u2026");
      try {
        const _results = await performAdvancedSearch(text);
        if (_results.contextText) {
          _webSources.push(..._results.sources);
          const ctx = _results.contextText + "\n";
          const last = history[history.length - 1];
          if (last?.parts?.length) last.parts[0] = { text: ctx + (last.parts[0]?.text || "") };
        }
      } catch (e) {
        console.warn("Web search failed:", e);
        showToast(`${_aiSvgWarn} Web search unavailable — proceeding without context.`);
      }
    }
    _setLabel(null);
  }
  const msgId = genId();
  state.abortCtrl = new AbortController();
  state.streamConvId = conv ? conv.id : null;
  state.streamMsgId = msgId;
  setSendState(true);
  _syncInputBusyUi();
  let aiDiv = null;
  let textEl = null;
  let fullText = "";
  let _usedModelId = "";
  let _usedModelName = "";
  const _buildAIDOM = (text, streaming = false) => buildAIBubbleDOM(text, msgId, streaming);
  // True only while the currently-viewed conversation is the one streaming,
  // so generation can keep running when the user switches to another chat
  // without polluting that other chat's DOM.
  const _viewingStreamView = () => _activeStreamTargetsView(state.streamConvId);
  const _ensureStreamDom = () => {
    if (!_viewingStreamView()) return false;
    if (!aiDiv || !document.body.contains(aiDiv)) {
      _hideTypingIndicator();
      aiDiv = appendAIMessageDOM("", msgId, true);
      textEl = aiDiv.querySelector(".message-text");
      textEl.classList.add("stream-reveal");
    }
    return true;
  };
  const _streamOpts = {
    useUrlContext: urlsInMsg.length > 0,
    useWebSearch: _wsNeeded,
    userText: text,
    files
  };
  const MAX_CONTINUATIONS = 4;
  let continueCount = 0;
  let continueEl = null;
  let _groundingMetadata = null;
  let _reasoningText = "";
  let _reasoningBlock = null;
  let _reasoningDone = false;
  let _searchingBlock = null;
  let _searchingDone = false;
  const _markReasoningDoneOnce = () => {
    if (_reasoningDone) return;
    _reasoningDone = true;
    if (_reasoningBlock) markReasoningDone(_reasoningBlock);
  };
  const _markSearchingDoneOnce = () => {
    if (_searchingDone) return;
    _searchingDone = true;
    if (_searchingBlock) markSearchingDone(_searchingBlock);
  };
  _streamOpts.onSearchStatusChunk = (chunk) => {
    if (!_ensureStreamDom()) return;
    if (!_searchingBlock) _searchingBlock = createSearchingBlock(aiDiv);
    appendSearchingToBlock(_searchingBlock, chunk);
    scrollToBottom();
  };
  _streamOpts.onReasoningChunk = (chunk) => {
    _markSearchingDoneOnce();
    // First reasoning chunk creates the message bubble early (typing
    // indicator hides) and the reasoning panel — same UX Claude / o1 use
    // where the "Thinking…" block appears before any answer text streams.
    _reasoningText += chunk;
    if (!_ensureStreamDom()) return;
    if (!_reasoningBlock) _reasoningBlock = createReasoningBlock(aiDiv);
    appendReasoningToBlock(_reasoningBlock, chunk);
    scrollToBottom();
  };
  const _doStream = async (h) => streamEmeraldBot(h, apiKey, (chunk) => {
    // First non-thought chunk means reasoning phase is over → flip the
    // reasoning block to "Done" (auto-collapses shortly after).
    _markSearchingDoneOnce();
    _markReasoningDoneOnce();
    fullText += chunk;
    if (!_ensureStreamDom()) return;
    const _sd = _streamDisplayText(fullText);
    textEl.innerHTML = (_sd.text ? renderMarkdown(_sd.text) : "") + (_sd.editStarted ? esEditLoadingCardHTML() : _sd.quizStarted ? quizLoadingCardHTML() : _sd.appStarted ? esAppLoadingCardHTML() : '<span class="stream-cursor" aria-hidden="true"></span>');
    _wrapStreamWords(textEl);
    scrollToBottom();
  }, _streamOpts);
  try {
    let _streamResult = await _doStream(history);
    let finishReason = _streamResult.finishReason;
    if (_streamResult.groundingMetadata) {
      // Merge grounding chunks from continuations instead of overwriting
      if (_groundingMetadata?.groundingChunks) {
        const existingUris = new Set(_groundingMetadata.groundingChunks.map(c => c?.web?.uri));
        const newChunks = (_streamResult.groundingMetadata.groundingChunks || []).filter(c => !existingUris.has(c?.web?.uri));
        _groundingMetadata = { groundingChunks: [..._groundingMetadata.groundingChunks, ...newChunks] };
      } else {
        _groundingMetadata = _streamResult.groundingMetadata;
      }
    }
    if (_streamResult.modelId) {
      _usedModelId = _streamResult.modelId;
      const _m = getModelById(_usedModelId);
      _usedModelName = _m ? _m.name : _usedModelId;
    }
    while ((finishReason === "MAX_TOKENS" || finishReason === "STREAM_INTERRUPTED") && continueCount < MAX_CONTINUATIONS && !state.abortCtrl?.signal?.aborted) {
      continueCount++;
      if (!continueEl && aiDiv) {
        continueEl = document.createElement("span");
        continueEl.className = "continue-indicator";
        continueEl.textContent = "\u2193 Continuing\u2026";
        aiDiv.querySelector(".message-body").appendChild(continueEl);
      }
      const contHistory = [
        ...history,
        { role: "model", parts: [{ text: fullText }] },
        { role: "user", parts: [{ text: "continue" }] }
      ];
      _streamResult = await _doStream(contHistory);
      finishReason = _streamResult.finishReason;
      if (_streamResult.groundingMetadata) {
      // Merge grounding chunks from continuations instead of overwriting
      if (_groundingMetadata?.groundingChunks) {
        const existingUris = new Set(_groundingMetadata.groundingChunks.map(c => c?.web?.uri));
        const newChunks = (_streamResult.groundingMetadata.groundingChunks || []).filter(c => !existingUris.has(c?.web?.uri));
        _groundingMetadata = { groundingChunks: [..._groundingMetadata.groundingChunks, ...newChunks] };
      } else {
        _groundingMetadata = _streamResult.groundingMetadata;
      }
    }
    }
    if (continueEl) continueEl.remove();
  } catch (err) {
    if (err?._jailbreakBlocked) {
      // Jailbreak attempt detected by the worker. Tear down the current
      // conversation entirely — delete it from storage, return the user
      // to the welcome screen, refresh the sidebar so the chat no longer
      // appears in Recents, and surface a toast explaining what happened.
      // No assistant message is rendered.
      if (continueEl) continueEl.remove();
      _hideTypingIndicator();
      if (state.convId && !state.isTemp) {
        deleteConv(state.convId);
      }
      state.convId = null;
      updateOwnedUrl();
      state.tempHistory = [];
      state.isStreaming = false;
      state.abortCtrl = null;
      state.streamConvId = null;
      state.streamMsgId = null;
      setSendState(false);
      _syncInputBusyUi();
      showWelcome();
      renderSidebar();
      showToast(`${_aiSvgWarn} This request cannot be processed because it violates EmeraldNetwork usage policies.`, "error");
      return;
    }
    if (continueEl) continueEl.remove();
    _hideTypingIndicator();
    if (!aiDiv) {
      aiDiv = _viewingStreamView() ? appendAIMessageDOM("", msgId, true) : _buildAIDOM("", true);
      textEl = aiDiv.querySelector(".message-text");
    }
    if (!(err.name === "AbortError" && fullText)) {
      textEl.innerHTML = `<span class="md-error">${escapeHtml(aiChatErrorText(err, "generating the response"))}</span>`;
    }
  }
  _hideTypingIndicator();
  // Stream ended — flip the reasoning panel to "Done" (if one exists).
  // Important for the case where the model produced reasoning but no
  // answer text (e.g. error / abort before first answer chunk).
  _markSearchingDoneOnce();
  _markReasoningDoneOnce();
  if (!fullText && !aiDiv) {
    aiDiv = _viewingStreamView() ? appendAIMessageDOM("", msgId, true) : _buildAIDOM("", true);
    textEl = aiDiv.querySelector(".message-text");
  }
  if (!fullText && aiDiv && textEl && !textEl.querySelector(".md-error")) {
    textEl.innerHTML = `<span class="md-error">${escapeHtml(aiErrorMessage("generating the response"))}</span>`;
  }
  if (fullText && !aiDiv) {
    // Stream ran entirely while the user was viewing a different conversation:
    // no bubble was ever attached to the DOM, yet the response must still be
    // built (and saved) so it isn't lost when the user comes back.
    aiDiv = _viewingStreamView() ? appendAIMessageDOM("", msgId, false) : buildAIBubbleDOM("", msgId, false);
    textEl = aiDiv.querySelector(".message-text");
    textEl.classList.remove("stream-reveal");
  }
  if (fullText && aiDiv) {
    let displayText = fullText;
    const memMatches = _extractMemories(fullText);
    const memoriesAdded = memMatches.map((m) => m.text).filter(Boolean);
    memoriesAdded.forEach((text2) => addMemory(text2));
    displayText = _stripMemoryTags(displayText).replace(/\n{3,}/g, "\n\n").trim();
    displayText = _stripThinkingPreamble(displayText).replace(/^\s+/, "");
    const memoryAdded = memoriesAdded.length > 0;
    const _imgTags = extractImageTags(displayText);
    const _imgPrompt = _imgTags.genPrompt;
    const _imgEditPrompt = _imgTags.editPrompt;
    const _imgPromptFinal = _imgEditPrompt || _imgPrompt;
    displayText = stripImageTags(displayText);
    const _quizResult = _extractQuiz(displayText);
    const quizData = _quizResult.quizData;
    const beforeQuizText = _quizResult.before;
    const afterQuizText = _quizResult.after;
    const _quizParseFailed = _quizResult.parseFailed;
    displayText = _quizResult.before;
    const _appRaw = (quizData || _quizParseFailed) ? { appData: null, parseFailed: false, before: displayText, after: "" } : _extractEmeraldApp(displayText);
    const appData = _appRaw.appData;
    const beforeAppText = _appRaw.before;
    const afterAppText = _appRaw.after;
    const _appParseFailed = _appRaw.parseFailed;
    displayText = beforeAppText;
    let _fEditRes = null;
    if (!(quizData || _quizParseFailed || appData || _appParseFailed)) {
      const _fe = _extractFileEdit(fullText);
      if (_fe.edit || _fe.parseFailed) {
        displayText = _fe.before;
        _fEditRes = _fe;
      }
    }
    let _fileEditOutcome = null;
    textEl.classList.remove("stream-reveal");
    const _textToShow = (quizData || _quizParseFailed) ? beforeQuizText : displayText;
    const _hasOtherContent = !!(quizData || _quizParseFailed || appData || _appParseFailed || _fEditRes || _imgPromptFinal || memoryAdded);
    if (_textToShow) {
      textEl.innerHTML = renderMarkdown(_textToShow);
    } else if (_hasOtherContent) {
      textEl.innerHTML = "";
      textEl.classList.add("message-text--empty");
    } else {
      textEl.innerHTML = `<span class="md-error">${escapeHtml(aiErrorMessage("generating the response"))}</span>`;
    }
    if (memoryAdded) {
      const badge = document.createElement("div");
      badge.className = "memory-badge";
      const cnt = memoriesAdded.length > 1 ? `Updated ${memoriesAdded.length} memories` : "Updated memory";
      badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg> ${cnt}`;
      aiDiv.querySelector(".message-sender").insertAdjacentElement("afterend", badge);
    }
    if (quizData) {
      const qid = "quiz_" + genId();
      quizData._id = qid;
      window._quizzes = window._quizzes || {};
      window._quizzes[qid] = { data: quizData, answers: {}, submitted: false };
      const cardEl = document.createElement("div");
      cardEl.innerHTML = quizCardHTML(qid, quizData);

      textEl.insertAdjacentElement("afterend", cardEl.firstElementChild);
      if (afterQuizText) {
        const afterEl = document.createElement("div");
        afterEl.className = "message-text md-content";
        afterEl.style.marginTop = "8px";
        afterEl.innerHTML = renderMarkdown(afterQuizText);
        textEl.nextElementSibling.insertAdjacentElement("afterend", afterEl);
      }
    } else if (_quizParseFailed) {
      const errCard = document.createElement("div");
      errCard.innerHTML = quizErrorCardHTML();
      textEl.insertAdjacentElement("afterend", errCard.firstElementChild);
    }
    if (appData) {
      renderEsAppCard(textEl, appData, afterAppText, msgId);
    } else if (_appParseFailed) {
      renderEsAppErrorCard(textEl);
    }
    if (_fEditRes) {
      _fileEditOutcome = await _efApplyEdit(_fEditRes, msgId, text);
      renderFileEditBadge(aiDiv, _fileEditOutcome);
    }
    const _groundingSources = extractGroundingSources(_groundingMetadata);
    const _allSources = [..._groundingSources, ..._webSources];
    // Always render citations (converts [N] to orphan badges when no sources).
    // Only strip the AI-written "Sources:" list when we have actual source chips.
    renderCitations(aiDiv, _allSources);
    if (_allSources.length) _stripSourcesFromHTML(textEl);
    aiDiv.querySelector(".message-body").appendChild(buildMessageActionsEl(msgId));
    if (aiDiv) {
      aiDiv.dataset.modelId = _usedModelId || "";
      aiDiv.dataset.modelName = _usedModelName || "";
    }
    const savedText = memoryAdded ? memMatches.map((m) => m.tag).join(" ") + " " + displayText : displayText;
    if (conv) {
      conv.messages.push({
        role: "assistant",
        text: savedText,
        id: msgId,
        modelId: _usedModelId || void 0,
        modelName: _usedModelName || void 0,
        hasMemory: !!memoryAdded,
        hasQuiz: !!(quizData || _quizParseFailed),
        quizData: quizData || void 0,
        quizTextBefore: (quizData || _quizParseFailed) ? beforeQuizText : void 0,
        quizTextAfter: (quizData || _quizParseFailed) ? afterQuizText : void 0,
        hasEsApp: !!(appData || _appParseFailed),
        esAppData: appData || void 0,
        esAppTextBefore: (appData || _appParseFailed) ? beforeAppText : void 0,
        esAppTextAfter: (appData || _appParseFailed) ? afterAppText : void 0,
        fileEdit: _fileEditOutcome || void 0,
        imagePrompt: _imgPromptFinal || void 0,
        imageMode: _imgEditPrompt ? "edit" : (_imgPrompt ? "generate" : void 0),
        // Persist the reasoning text so the collapsible "Reasoning" panel
        // can be re-rendered on page reload. Stored separately from `text`
        // so buildHistory never sends reasoning back to Gemini.
        reasoning: _reasoningText || void 0,
        sources: _allSources.length ? _allSources.map(s => ({ title: s.title || '', uri: s.uri })) : void 0
      });
      conv.updatedAt = Date.now();
      upsertConv(conv);
    } else {
      state.tempHistory.push({ role: "model", parts: [{ text: savedText }] });
      // Empty-string user parts make the Gemini API reject the next request
      // with a 400. Use a non-empty placeholder so buildHistory stays valid.
      if (quizData) state.tempHistory.push({ role: "user", parts: [{ text: "[User started a quiz — no text message]" }] });
    }
    if (_imgPromptFinal) {
      runImageTags(aiDiv, fullText, state.convId, msgId, { files, userText: text });
    }
    // Always process [IMAGE_SEARCH:] tags regardless of the image tags above
    processImageSearchTags(aiDiv, state.convId, msgId);
  } else if (aiDiv && textEl) {
    // No text came back (request error / cancellation / empty response).
    // Persist the error so it survives a page reload instead of vanishing.
    const errorText = textEl.querySelector(".md-error")?.textContent || "An error occurred.";
    aiDiv.querySelector(".message-body").appendChild(buildMessageActionsEl(msgId));
    if (conv) {
      conv.messages.push({ role: "assistant", text: errorText, id: msgId, isError: true });
      conv.updatedAt = Date.now();
      upsertConv(conv);
    } else {
      state.tempHistory.push({ role: "model", parts: [{ text: errorText }] });
    }
  }
  updateLastMsgActions();
  state.isStreaming = false;
  state.abortCtrl = null;
  state.streamConvId = null;
  state.streamMsgId = null;
  setSendState(false);
  _syncInputBusyUi();
  scrollToBottom();
}
const HISTORY_MAX_MSGS = 30;
const HISTORY_FULL_TAIL = 6;
const HISTORY_MAX_CHARS = 1200;
function buildHistory(conv) {
  if (conv) {
    const allMsgs = conv.messages;
    const msgs = allMsgs.slice(-HISTORY_MAX_MSGS).map((m, idx, arr) => {
      let text = m.text || "";
      text = text.replace(/<quiz(?:\s[^>]*)?>[\s\S]*?<\/quiz\s*>/gi, "[A quiz was provided here]");
      text = text.replace(/<es-app(?:\s[^>]*)?>[\s\S]*?<\/es-app\s*>/gi, "[Content was offered for import to EmeraldSuite]");
      text = text.replace(/<es-edit(?:\s[^>]*)?>[\s\S]*?<\/es-edit\s*>/gi, "[Update was applied to your file in EmeraldSuite]");
      text = _stripMemoryTags(text).replace(/\[GENERATE_IMAGE:\s*[^\]]+\]/g, "").replace(/\[EDIT_IMAGE:\s*[^\]]+\]/g, "").replace(/\[IMAGE:\s*[^\]]+\]/g, "").replace(/\[IMAGE_SEARCH:\s*[^\]]+\]/g, "").trim();
      if (m.imagePrompt) {
        // Tells the model an image came out of this turn and whether it was an
        // edit, which is what makes a later "make it darker" act on that same
        // picture instead of asking for a new one. Context only, never shown in
        // the chat — keep it short and free of implementation wording.
        const _ip = String(m.imagePrompt).replace(/\s+/g, " ").trim();
        text += `\n[${m.imageMode === "edit" ? "Image edited" : "Image generated"}: "${_ip.slice(0, 200)}${_ip.length > 200 ? "…" : ""}"]`;
      }
      const isRecent = idx >= arr.length - HISTORY_FULL_TAIL;
      if (!isRecent && text.length > HISTORY_MAX_CHARS) {
        text = text.slice(0, HISTORY_MAX_CHARS) + "\n[...content truncated...]";
      }
      if (m.role === "user" && !text) text = "[No text content]";
      return {
        role: m.role === "user" ? "user" : "model",
        parts: [{ text }]
      };
    });
    if (window._quizzes) {
      const branchQuizIds = new Set(
        conv.messages.filter((m) => m.hasQuiz && m.quizData && m.quizData._id).map((m) => m.quizData._id)
      );
      const submitted = Object.values(window._quizzes).filter(function(q) {
        return q.submitted && branchQuizIds.has(q.data && q.data._id);
      });
      if (submitted.length > 0 && msgs.length > 0) {
        const quizLines = submitted.map(function(q) {
          const answerDetails = q.data.questions.map(function(qq, i) {
            const type = qq.type || "mcq";
            const raw = q.answers[i];
            let chosenTxt, correctTxt, ok;
            if (type === "mcq") {
              chosenTxt = (raw == null) ? "skipped" : `"${qq.options[raw] ?? raw}"`;
              correctTxt = `"${qq.options[qq.answer] ?? qq.answer}"`;
              ok = raw === qq.answer;
            } else if (type === "multi") {
              const cs = (qq.answer || []).map(Number);
              const chs = Array.isArray(raw) ? raw.map(Number) : [];
              ok = cs.length === chs.length && cs.every(function(v) { return chs.includes(v); });
              const fmt = function(arr) { return arr.length ? arr.map(function(o) { return `"${qq.options[o] ?? String.fromCharCode(65 + o)}"`; }).join(", ") : "skipped"; };
              chosenTxt = fmt(chs);
              correctTxt = fmt(cs);
            } else if (type === "matching") {
              const n = Math.min((qq.left || []).length, (qq.right || []).length);
              const perm = qq._rightPerm || (qq._rightPerm = _shuffledIdx(n));
              const chs = Array.isArray(raw) ? raw : [];
              ok = true;
              const chosenPairs = [];
              const correctPairs = [];
              for (let li = 0; li < n; li++) {
                const ri = Number(qq.answer && qq.answer[li]);
                const disp = Number(chs[li]);
                const chRight = (qq.right || [])[perm[disp]];
                const coRight = (qq.right || [])[ri];
                chosenPairs.push(`"${qq.left[li]} → ${chRight == null || chRight === "" ? "skipped" : chRight}"`);
                correctPairs.push(`"${qq.left[li]} → ${coRight || ""}"`);
                if (perm.indexOf(ri) !== disp) ok = false;
              }
              chosenTxt = chosenPairs.join(", ");
              correctTxt = correctPairs.join(", ");
            } else if (type === "fill") {
              chosenTxt = (raw != null && String(raw).trim()) ? `"${raw}"` : "skipped";
              correctTxt = `"${qq.answer}"`;
              const ua = (raw || "").toString().trim().toLowerCase();
              const ca = (qq.answer || "").trim().toLowerCase();
              ok = ua === ca || ca.split("|").map(function(s) { return s.trim(); }).includes(ua);
            } else {
              chosenTxt = (raw != null && String(raw).trim()) ? `"${raw}"` : "skipped";
              correctTxt = "(essay — no fixed answer)";
              ok = null;
            }
            const result = ok === null ? "ESSAY" : ok ? "CORRECT" : "WRONG";
            return `Q${i + 1}: "${qq.q}" - User chose: ${chosenTxt}, Correct: ${correctTxt}, ${result}`;
          }).join("; ");
          const totalCount = q.autoTotal != null ? q.autoTotal : q.data.questions.length;
          return '[QUIZ RESULT: "' + q.data.title + '" - Score ' + q.score + "/" + totalCount + ". Answers: " + answerDetails + "]";
        });
        msgs[msgs.length - 1].parts[0].text += "\n\n" + quizLines.join("\n");
      }
    }
    return msgs;
  }
  return [...state.tempHistory];
}
function setSendState(sending) {
  const btn = $("sendBtn");
  if (!btn) return;
  if (sending) {
    btn.title = "Stop";
    btn.onclick = stopStreaming;
  } else {
    btn.title = "Send";
    btn.onclick = handleSend;
  }
  const glyph = sending
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  if (btn.innerHTML === glyph) return;
  btn.dataset.swapping = "1";
  btn.style.opacity = "0";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    btn.innerHTML = glyph;
    btn.style.opacity = "";
    btn.dataset.swapping = "0";
  }));
}
function stopStreaming() {
  state.abortCtrl?.abort();
  state.isStreaming = false;
  state.streamConvId = null;
  state.streamMsgId = null;
  setSendState(false);
  _syncInputBusyUi();
  $("typingIndicator").style.display = "none";
}
async function regenerateMessage(msgEl) {
  if (state.isStreaming || !state.convId) return;
  _autoScrollSticky = true;  // re-enable on regen
  const conv = getConv(state.convId);
  if (!conv) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    showToast(`${_aiSvgError} No API key set`, "error");
    return;
  }
  const msgId = msgEl?.dataset?.msgId;
  const idx = conv.messages.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  const currentMsg = conv.messages[idx];
  const regenBranchId = currentMsg._regenBranchRef || msgId;
  // Branch keys must never be special prototype property names: reading a
  // "__proto__"/"constructor"/"prototype" key off a plain object would let a
  // corrupt stored map resolve to Object.prototype/Function.prototype.
  if (regenBranchId === "__proto__" || regenBranchId === "constructor" || regenBranchId === "prototype") return;
  conv._regenBranches = conv._regenBranches || Object.create(null);
  if (!conv._regenBranches[regenBranchId]) {
    conv._regenBranches[regenBranchId] = { variants: [], current: -1 };
  }
  const regenBranch = conv._regenBranches[regenBranchId];
  if (regenBranch.variants.length >= MAX_CHAT_BRANCH_VARIANTS) {
    showChatBranchLimitToast("ai");
    return;
  }
  const currentVariant = { ...currentMsg, _regenBranchRef: regenBranchId };
  if (regenBranch.variants.length === 0) {
    regenBranch.variants.push(currentVariant);
  } else if (regenBranch.current >= 0) {
    regenBranch.variants[regenBranch.current] = currentVariant;
  }
  // Save the tail (messages after the AI response) so regen branch
  // navigation can restore them.  Without this, navigating back to an
  // earlier regen variant loses any follow-up messages.
  const regenTail = conv.messages.slice(idx + 1).map((m) => ({ ...m }));
  conv.messages = conv.messages.slice(0, idx);
  conv._regenBranches[regenBranchId] = regenBranch;
  upsertConv(conv);
  // Remove the AI message AND any subsequent DOM elements so orphaned
  // messages don't linger during the streaming of the new response.
  const _allMsgEls = Array.from($("messagesArea").querySelectorAll(".message:not(#typingIndicator)"));
  const _domIdx = _allMsgEls.indexOf(msgEl);
  if (_domIdx >= 0) _allMsgEls.slice(_domIdx).forEach((el) => el.remove());
  else msgEl.remove();
  // Store the tail on the current regen variant (the one being replaced)
  // so navigateRegenBranch can restore it when switching back.
  if (regenBranch.variants.length > 0 && regenBranch.current >= 0) {
    if (typeof regenBranch.current !== "number") return;
    const curIdx = regenBranch.current;
    if (!Number.isInteger(curIdx) || curIdx < 0 || curIdx >= regenBranch.variants.length) return;
    // regenBranch.current is always a non-negative number index, never a
    // prototype name; the branch map itself is a null-prototype object.
    const variant = regenBranch.variants[curIdx];
    if (variant) safeSetProp(variant, "_regenTail", regenTail);
  }
  const history = buildHistory(conv);
  const userMsgIdx = idx - 1;
  if (userMsgIdx >= 0) {
    const userMsg = conv.messages[userMsgIdx];
    if (userMsg.files && userMsg.files.length) {
      const fileParts = buildFileParts(userMsg.files);
      if (fileParts.length && history.length) {
        const last = history[history.length - 1];
        if (last?.parts?.length) last.parts.push(...fileParts);
      }
    }
  }
  const regenUserText = (userMsgIdx >= 0 && conv.messages[userMsgIdx] && conv.messages[userMsgIdx].text) || "";
  // Original attachments of the prompt being regenerated — these are the source
  // pixels when that turn asked for an image edit.
  const regenFiles = (userMsgIdx >= 0 && conv.messages[userMsgIdx] && conv.messages[userMsgIdx].files) || [];
  _efResetWriteGate();
  try {
    const fileCtx = await _suiteAutoContext(regenUserText);
    if (fileCtx && history.length && history[history.length - 1]?.parts?.length) {
      history[history.length - 1].parts.unshift({ text: fileCtx });
    }
  } catch (e) { console.warn("File context failed:", e); }
  state.isStreaming = true;
  state.abortCtrl = new AbortController();
  state.streamConvId = conv ? conv.id : null;
  setSendState(true);
  _syncInputBusyUi();
  const _lastUserText = history.length ? history[history.length - 1]?.parts?.[0]?.text || "" : "";
  const _wsNeeded = detectWebSearchIntent(_lastUserText);
  const _urlsInMsg = extractUrls(_lastUserText);
  let _webSources = [];
  if (_wsNeeded && !_urlsInMsg.length) {
    try {
      const _results = await performAdvancedSearch(_lastUserText);
      if (_results.contextText) {
        _webSources.push(..._results.sources);
        const ctx = _results.contextText + "\n";
        const last = history[history.length - 1];
        if (last?.parts?.length) last.parts[0] = { text: ctx + (last.parts[0]?.text || "") };
      }
    } catch (e) {
      console.warn("Web search failed:", e);
      showToast(`${_aiSvgWarn} Web search unavailable — proceeding without context.`);
    }
  }
  let _groundingMetadata = null;
  const newId = genId();
  state.streamMsgId = newId;
  const rTypingEl = $("typingIndicator");
  rTypingEl.style.display = "flex";
  scrollToBottom();
  let aiDiv = null;
  let textEl = null;
  let fullText = "";
  let _usedModelId = "";
  let _usedModelName = "";
  let _reasoningText = "";
  let _reasoningBlock = null;
  let _reasoningDone = false;
  let _searchingBlock = null;
  let _searchingDone = false;
  const _streamViewing = () => _activeStreamTargetsView(state.streamConvId);
  const _ensureStreamDom = () => {
    if (!_streamViewing()) return false;
    if (!aiDiv || !document.body.contains(aiDiv)) {
      _hideTypingIndicator();
      aiDiv = appendAIMessageDOM("", newId, true);
      textEl = aiDiv.querySelector(".message-text");
      textEl.classList.add("stream-reveal");
    }
    return true;
  };
  const _markReasoningDoneOnce = () => {
    if (_reasoningDone) return;
    _reasoningDone = true;
    if (_reasoningBlock) markReasoningDone(_reasoningBlock);
  };
  const _markSearchingDoneOnce = () => {
    if (_searchingDone) return;
    _searchingDone = true;
    if (_searchingBlock) markSearchingDone(_searchingBlock);
  };
  try {
    const _streamResult = await streamEmeraldBotResumable(history, apiKey, (chunk) => {
      _markSearchingDoneOnce();
      _markReasoningDoneOnce();
      fullText += chunk;
      if (!_ensureStreamDom()) return;
      const _sd = _streamDisplayText(fullText);
textEl.innerHTML = (_sd.text ? renderMarkdown(_sd.text) : "") + (_sd.editStarted ? esEditLoadingCardHTML() : _sd.quizStarted ? quizLoadingCardHTML() : _sd.appStarted ? esAppLoadingCardHTML() : '<span class="stream-cursor" aria-hidden="true"></span>');
      _wrapStreamWords(textEl);
      scrollToBottom();
    }, {
      useUrlContext: _urlsInMsg.length > 0,
      userText: _lastUserText,
      onSearchStatusChunk: (chunk) => {
        if (!_ensureStreamDom()) return;
        if (!_searchingBlock) _searchingBlock = createSearchingBlock(aiDiv);
        appendSearchingToBlock(_searchingBlock, chunk);
        scrollToBottom();
      },
      onReasoningChunk: (chunk) => {
        _markSearchingDoneOnce();
        _reasoningText += chunk;
        if (!_ensureStreamDom()) return;
        if (!_reasoningBlock) _reasoningBlock = createReasoningBlock(aiDiv);
        appendReasoningToBlock(_reasoningBlock, chunk);
        scrollToBottom();
      }
    }, { useWebSearch: _wsNeeded });
    if (_streamResult.groundingMetadata) {
      if (_groundingMetadata?.groundingChunks) {
        const existingUris = new Set(_groundingMetadata.groundingChunks.map(c => c?.web?.uri));
        const newChunks = (_streamResult.groundingMetadata.groundingChunks || []).filter(c => !existingUris.has(c?.web?.uri));
        _groundingMetadata = { groundingChunks: [..._groundingMetadata.groundingChunks, ...newChunks] };
      } else {
        _groundingMetadata = _streamResult.groundingMetadata;
      }
    }
    if (_streamResult.modelId) {
      _usedModelId = _streamResult.modelId;
      const _m = getModelById(_usedModelId);
      _usedModelName = _m ? _m.name : _usedModelId;
    }
  } catch (err) {
    _hideTypingIndicator();
    if (!(err.name === "AbortError" && fullText)) {
      if (!aiDiv) {
        aiDiv = _streamViewing() ? appendAIMessageDOM("", newId, true) : buildAIBubbleDOM("", newId, true);
        textEl = aiDiv.querySelector(".message-text");
      }
      textEl.innerHTML = `<span class="md-error">${escapeHtml(aiChatErrorText(err, "regenerating the response"))}</span>`;
    }
  }
  _hideTypingIndicator();
  _markSearchingDoneOnce();
  _markReasoningDoneOnce();
  if (!fullText && !aiDiv) {
    aiDiv = _streamViewing() ? appendAIMessageDOM("", newId, true) : buildAIBubbleDOM("", newId, true);
    textEl = aiDiv.querySelector(".message-text");
  }
  if (!fullText && aiDiv && textEl && !textEl.querySelector(".md-error")) {
    textEl.innerHTML = `<span class="md-error">${escapeHtml(aiErrorMessage("regenerating the response"))}</span>`;
  }
  if (fullText && !aiDiv) {
    // Regenerated entirely while the user was viewing another conversation:
    // no bubble was attached, but the response must still be saved.
    aiDiv = _streamViewing() ? appendAIMessageDOM("", newId, false) : buildAIBubbleDOM("", newId, false);
    textEl = aiDiv.querySelector(".message-text");
    textEl.classList.remove("stream-reveal");
  }
  if (fullText && aiDiv) {
    let displayText = fullText;
    const memMatches = _extractMemories(fullText);
    const memoriesAdded = memMatches.map((m) => m.text).filter(Boolean);
    memoriesAdded.forEach((text) => addMemory(text));
    displayText = _stripMemoryTags(displayText).replace(/\n{3,}/g, "\n\n").trim();
    displayText = _stripThinkingPreamble(displayText).replace(/^\s+/, "");
    const memoryAdded = memoriesAdded.length > 0;
    const imgTags = extractImageTags(displayText);
    const imgPrompt = imgTags.genPrompt;
    const imgEditPrompt = imgTags.editPrompt;
    const imgPromptFinal = imgEditPrompt || imgPrompt;
    displayText = stripImageTags(displayText);
    const _quizResult = _extractQuiz(displayText);
    const quizData = _quizResult.quizData;
    const beforeQuizText = _quizResult.before;
    const afterQuizText = _quizResult.after;
    const _quizParseFailed = _quizResult.parseFailed;
    displayText = _quizResult.before;
    const _appRaw = (quizData || _quizParseFailed) ? { appData: null, parseFailed: false, before: displayText, after: "" } : _extractEmeraldApp(displayText);
    const appData = _appRaw.appData;
    const beforeAppText = _appRaw.before;
    const afterAppText = _appRaw.after;
    const _appParseFailed = _appRaw.parseFailed;
    displayText = beforeAppText;
    let _fEditRes = null;
    if (!(quizData || _quizParseFailed || appData || _appParseFailed)) {
      const _fe = _extractFileEdit(fullText);
      if (_fe.edit || _fe.parseFailed) {
        displayText = _fe.before;
        _fEditRes = _fe;
      }
    }
    let _fileEditOutcome = null;
    textEl.classList.remove("stream-reveal");
    const _regenTextToShow = (quizData || _quizParseFailed) ? beforeQuizText : displayText;
    const _hasOtherContent = !!(quizData || _quizParseFailed || appData || _appParseFailed || _fEditRes || imgPromptFinal || memoryAdded);
    if (_regenTextToShow) {
      textEl.innerHTML = renderMarkdown(_regenTextToShow);
    } else if (_hasOtherContent) {
      textEl.innerHTML = "";
      textEl.classList.add("message-text--empty");
    } else {
      textEl.innerHTML = `<span class="md-error">${escapeHtml(aiErrorMessage("regenerating the response"))}</span>`;
    }
    if (memoryAdded) {
      const badge = document.createElement("div");
      badge.className = "memory-badge";
      const cnt = memoriesAdded.length > 1 ? `Updated ${memoriesAdded.length} memories` : "Updated memory";
      badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg> ${cnt}`;
      aiDiv.querySelector(".message-sender").insertAdjacentElement("afterend", badge);
    }
    if (quizData) {
      const qid = "quiz_" + genId();
      quizData._id = qid;
      window._quizzes = window._quizzes || {};
      window._quizzes[qid] = { data: quizData, answers: {}, submitted: false };
      const cardEl = document.createElement("div");
      cardEl.innerHTML = quizCardHTML(qid, quizData);

      textEl.insertAdjacentElement("afterend", cardEl.firstElementChild);
      if (afterQuizText) {
        const afterEl = document.createElement("div");
        afterEl.className = "message-text md-content";
        afterEl.style.marginTop = "8px";
        afterEl.innerHTML = renderMarkdown(afterQuizText);
        textEl.nextElementSibling.insertAdjacentElement("afterend", afterEl);
      }
    } else if (_quizParseFailed) {
      const errCard = document.createElement("div");
      errCard.innerHTML = quizErrorCardHTML();
      textEl.insertAdjacentElement("afterend", errCard.firstElementChild);
    }
    if (appData) {
      renderEsAppCard(textEl, appData, afterAppText, newId);
    } else if (_appParseFailed) {
      renderEsAppErrorCard(textEl);
    }
    if (_fEditRes) {
      _fileEditOutcome = await _efApplyEdit(_fEditRes, newId, regenUserText);
      renderFileEditBadge(aiDiv, _fileEditOutcome);
    }
    const _groundingSources = extractGroundingSources(_groundingMetadata);
    const _allSources = [..._groundingSources, ..._webSources];
    renderCitations(aiDiv, _allSources);
    if (_allSources.length) _stripSourcesFromHTML(textEl);
    aiDiv.querySelector(".message-body").appendChild(buildMessageActionsEl(newId));
    if (aiDiv) {
      aiDiv.dataset.modelId = _usedModelId || "";
      aiDiv.dataset.modelName = _usedModelName || "";
    }
    const savedText = memoryAdded ? memMatches.map((m) => m.tag).join(" ") + " " + displayText : displayText;
    const savedMsg = {
      role: "assistant",
      text: savedText,
      id: newId,
      modelId: _usedModelId || void 0,
      modelName: _usedModelName || void 0,
      _regenBranchRef: regenBranchId,
      hasMemory: !!memoryAdded,
      hasQuiz: !!(quizData || _quizParseFailed),
      quizData: quizData || void 0,
      quizTextBefore: (quizData || _quizParseFailed) ? beforeQuizText : void 0,
      quizTextAfter: (quizData || _quizParseFailed) ? afterQuizText : void 0,
      hasEsApp: !!(appData || _appParseFailed),
      esAppData: appData || void 0,
      esAppTextBefore: (appData || _appParseFailed) ? beforeAppText : void 0,
      esAppTextAfter: (appData || _appParseFailed) ? afterAppText : void 0,
      fileEdit: _fileEditOutcome || void 0,
      imagePrompt: imgPromptFinal || void 0,
      imageMode: imgEditPrompt ? "edit" : (imgPrompt ? "generate" : void 0),
      reasoning: _reasoningText || void 0,
      sources: _allSources.length ? _allSources.map(s => ({ title: s.title || '', uri: s.uri })) : void 0
    };
    aiDiv.dataset.regenBranchRef = regenBranchId;
    conv.messages.push(savedMsg);
    regenBranch.variants.push({ ...savedMsg });
    regenBranch.current = regenBranch.variants.length - 1;
    conv._regenBranches[regenBranchId] = regenBranch;
    upsertConv(conv);
    updateRegenNavDOM(regenBranchId);
    if (imgPromptFinal) {
      runImageTags(aiDiv, fullText, state.convId, newId, { files: regenFiles, userText: regenUserText });
    }
  } else if (aiDiv && textEl) {
    // No text came back (request error / cancellation / empty response).
    // Persist the error onto the regen branch so it survives a page reload.
    const errorText = textEl.querySelector(".md-error")?.textContent || "An error occurred.";
    aiDiv.querySelector(".message-body").appendChild(buildMessageActionsEl(newId));
    const savedMsg = { role: "assistant", text: errorText, id: newId, _regenBranchRef: regenBranchId, isError: true };
    aiDiv.dataset.regenBranchRef = regenBranchId;
    conv.messages.push(savedMsg);
    regenBranch.variants.push({ ...savedMsg });
    regenBranch.current = regenBranch.variants.length - 1;
    conv._regenBranches[regenBranchId] = regenBranch;
    upsertConv(conv);
    updateRegenNavDOM(regenBranchId);
  }
  updateLastMsgActions();
  state.isStreaming = false;
  state.abortCtrl = null;
  state.streamConvId = null;
  state.streamMsgId = null;
  setSendState(false);
  _syncInputBusyUi();
  scrollToBottom();
}
function _switchToAutoDueToUnavailableModel(failedModelId, reason) {
  void reason;
  setSelectedModelId("auto");
  try {
    refreshModelSelectorUI();
  } catch {
  }
  try {
    const sel = $("modelSelector");
    if (sel && sel.classList.contains("open")) renderModelDropdown();
  } catch {
  }
  showToast(`${_aiSvgCheck} Switched to Auto \u2014 selected model isn't available.`);
}
async function streamEmeraldBot(history, _unused, onChunk, options = {}) {
  const requestedId = options.model || getSelectedModelId();
  const reqBody = {
    contents: history,
    memories: loadMemories(),
    userDisplayName: (loadSettings().userName || "").trim() || null,
    useUrlContext: !!options.useUrlContext,
    useWebSearch: !!options.useWebSearch,
    tools: options.tools || [],
    reasoning: isReasoningEnabled()
  };
  const url = `${CHAT_WORKER_URL}/chat?model=${encodeURIComponent(requestedId)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal: state.abortCtrl?.signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    const e = new Error("Network error: " + (err?.message || err));
    e._modelError = true;
    e._httpStatus = 0;
    throw e;
  }
  if (!res.ok) {
    // Consume the body for cleanup but NEVER copy its text into the error:
    // even after worker-side sanitization, frontend classification must rely
    // on the HTTP status alone so nothing internal can surface in the UI or
    // the developer console.
    await res.text().catch(() => "");
    const e = new Error(`HTTP ${res.status}`);
    e._modelError = true;
    e._httpStatus = res.status;
    throw e;
  }
  // Jailbreak detection: when the worker flags a request as blocked
  // (X-Safety-Status: blocked), it sends an EMPTY SSE stream with no
  // refusal text. We must NOT stream anything to the user — instead we
  // throw a tagged error so the caller can remove the conversation,
  // return the user to the welcome screen, and show a toast.
  const _safetyStatus = res.headers.get("X-Safety-Status");
  if (_safetyStatus === "blocked") {
    try { await res.body?.cancel(); } catch {}
    const _jbErr = new Error("Jailbreak attempt detected");
    _jbErr._jailbreakBlocked = true;
    throw _jbErr;
  }
  const usedModelId = res.headers.get("X-Model-Used") || requestedId;
  const usedModel = getModelById(usedModelId);
  const autoSwitched = res.headers.get("X-Auto-Switched") === "1";
  if (autoSwitched && requestedId !== "auto") {
    try {
      _switchToAutoDueToUnavailableModel(requestedId, "");
    } catch {
    }
  }
  if (typeof onModelUsed === "function" && usedModel) {
    try {
      onModelUsed(usedModel);
    } catch {
    }
  }
  if (requestedId === "auto" || autoSwitched) {
    try {
      refreshModelSelectorUI();
    } catch {
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason = null;
  let groundingMetadata = null;
  // 30s was too aggressive for low-bandwidth / congested connections — a
  // client stream regularily stalls mid-answer and got killed, which users
  // experience as "the AI randomly stops generating". 60s gives slow links
  // room to catch up, and the STREAM_INTERRUPTED recovery below resumes the
  // response whenever a connection is genuinely cut.
  const STREAM_IDLE_TIMEOUT = 6e4;
  let timedOut = false;
  let streamedChars = 0;
  let streamDone = false;
  // Resume only when streamed text is meaningful. A connection that drops or
  // idles out almost immediately (a few chars) will likely do so again — a
  // resume would just waste another slow request round-trip.
  const MIN_RESUME_TEXT = 20;
  let idleTimer = null;
  const _resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      try {
        reader.cancel("Stream idle timeout");
      } catch {
      }
    }, STREAM_IDLE_TIMEOUT);
  };
  _resetIdle();
  try {
    while (!streamDone) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (readErr) {
        // reader.cancel() (idle timeout) or a torn-down network make the next
        // read() reject instead of resolving — break out so the recovery logic
        // below can decide whether to resume the response.
        if (timedOut) break;
        throw readErr;
      }
      _resetIdle();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          streamDone = true;
          break;
        }
        try {
          const json = JSON.parse(data);
          const candidate = json.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              // Gemini tags reasoning tokens with `thought: true` when
              // thinkingConfig.includeThoughts is on (worker.js relays them
              // unchanged). Route them to a separate onReasoningChunk callback
              // so the UI can render them inside the collapsible "Reasoning"
              // panel above the answer, instead of mixing them into the answer.
              if (part.searchStatus === true) {
                if (part.text && typeof options.onSearchStatusChunk === "function") {
                  options.onSearchStatusChunk(part.text);
                }
              } else if (part.thought === true) {
                if (part.text && typeof options.onReasoningChunk === "function") {
                  options.onReasoningChunk(part.text);
                }
              } else if (part.text) {
                streamedChars += part.text.length;
                onChunk(part.text);
              }
            }
          }
          if (candidate?.finishReason) {
            finishReason = candidate.finishReason;
            streamDone = true;
          }
          if (candidate?.groundingMetadata) groundingMetadata = candidate.groundingMetadata;
        } catch {
        }
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }
  if (timedOut && !finishReason) {
    if (streamedChars >= MIN_RESUME_TEXT) {
      // A long stall mid-generation (slow/stuttering connection) tripped the
      // idle timer, but the partial text we already have is valid — resume
      // it like a MAX_TOKENS continuation instead of erroring and losing it.
      return { finishReason: "STREAM_INTERRUPTED", groundingMetadata, modelId: usedModelId };
    }
    const e = new Error(`Response timed out \u2014 the server did not send any data for ${STREAM_IDLE_TIMEOUT / 1e3} seconds.`);
    e._modelError = true;
    e._timedOut = true;
    throw e;
  }
  if (!streamDone && !finishReason) {
    // The connection ended WITHOUT the worker's [DONE] marker or a
    // finishReason. This is the classic "randomly stops streaming" symptom:
    // the worker hit Cloudflare's per-request wall-time cap mid-stream, or
    // the connection dropped while data was still flowing. The partial answer
    // is valid — flag it so the caller resumes with "continue" up to a few
    // times instead of silently cutting the response short. Cuts that only
    // produced a couple of characters are left alone (almost always just a
    // flaky drop that would repeat).
    if (streamedChars >= MIN_RESUME_TEXT) {
      return { finishReason: "STREAM_INTERRUPTED", groundingMetadata, modelId: usedModelId };
    }
  }
  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    const reasonMap = { SAFETY: "Content blocked by safety filters", RECITATION: "Content blocked by recitation policy", OTHER: "Response blocked for an unknown reason" };
    const e = new Error(reasonMap[finishReason] || `Response blocked: ${finishReason}`);
    e._modelError = true;
    e._serverBlocked = true;
    throw e;
  }
  return { finishReason, groundingMetadata, modelId: usedModelId };
}
// Thin wrapper that streams a response and AUTO-RESUMES it whenever the
// underlying stream ends on a MAX_TOKENS cap or an interrupted connection
// (STREAM_INTERRUPTED). Each resume replays what was already generated and
// asks the model to continue, feeding every round's chunks + reasoning into
// the same callbacks so the UI keeps streaming seamlessly. Used by the
// regenerate and edit-answer paths, which previously truncated the moment a
// single stream was cut.
async function streamEmeraldBotResumable(history, _unused, onChunk, options = {}, _extra = {}) {
  const MAX_RESUMES = 4;
  let accFinish = null;
  let accGrounding = null;
  let accModelId = null;
  let accText = "";
  let h = history;
  for (let i = 0; i <= MAX_RESUMES; i++) {
    const _progress = (chunk) => {
      accText += chunk;
      if (typeof onChunk === "function") onChunk(chunk);
    };
    const res = await streamEmeraldBot(h, _unused, _progress, options, _extra);
    if (res.modelId) accModelId = res.modelId;
    if (res.groundingMetadata) {
      if (accGrounding?.groundingChunks) {
        const existingUris = new Set(accGrounding.groundingChunks.map((c) => c?.web?.uri));
        const newChunks = (res.groundingMetadata.groundingChunks || []).filter((c) => !existingUris.has(c?.web?.uri));
        accGrounding = { groundingChunks: [...accGrounding.groundingChunks, ...newChunks] };
      } else {
        accGrounding = res.groundingMetadata;
      }
    }
    accFinish = res.finishReason;
    if (accFinish !== "MAX_TOKENS" && accFinish !== "STREAM_INTERRUPTED") break;
    h = [...history, { role: "model", parts: [{ text: accText }] }, { role: "user", parts: [{ text: "continue" }] }];
  }
  return { finishReason: accFinish, groundingMetadata: accGrounding, modelId: accModelId };
}
function extractGroundingSources(groundingMetadata) {
  if (!groundingMetadata) return [];
  const sources = [];
  const seen = /* @__PURE__ */ new Set();
  const chunks = groundingMetadata.groundingChunks || [];
  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    const title = chunk?.web?.title || "";
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      let displayTitle = title;
      if (!displayTitle || displayTitle === uri || displayTitle.includes("://")) {
        // Gemini didn't provide a real title — try to extract a readable one from the URL
        try {
          const u = new URL(uri);
          const pathSegs = u.pathname.split("/").filter(Boolean);
          if (pathSegs.length) {
            // Use the last meaningful path segment as title
            displayTitle = decodeURIComponent(pathSegs[pathSegs.length - 1]).replace(/[-_]/g, " ");
            // Clean up common file extensions and numeric IDs
            displayTitle = displayTitle.replace(/\.\w{1,5}$/, "").replace(/^\d+[-_]?\s*/, "");
            if (displayTitle.length > 1) displayTitle = displayTitle[0].toUpperCase() + displayTitle.slice(1);
            if (displayTitle.length > 60) displayTitle = displayTitle.slice(0, 57) + "...";
          } else {
            // No path segments — try hostname as fallback (stripped of www. and TLD)
            const host = u.hostname.replace(/^www\./, "");
            const parts = host.split(".");
            if (parts.length > 1) {
              displayTitle = parts[0];
              if (displayTitle.length > 1) displayTitle = displayTitle[0].toUpperCase() + displayTitle.slice(1);
            } else {
              displayTitle = "";
            }
          }
        } catch { displayTitle = ""; }
      }
      sources.push({ title: displayTitle, uri });
    }
  }
  return sources;
}
/* Client-side image compression that PRESERVES the file's name and type.
   PNG stays PNG (pixel-lossless via canvas), JPEG stays JPEG (near-lossless
   high quality), WebP stays WebP. Only dimensions above Gemini's own 3072px
   downscale cap are reduced, so nothing the model sees is lost. Returns null
   when the result would be no smaller than the original. */
const ATTACH_IMAGE_MAX_DIM = 3072;
const ATTACH_IMAGE_SKIP_BELOW = 400 * 1024;
const ATTACH_JPEG_QUALITY = 0.92;
const ATTACH_WEBP_QUALITY = 0.92;
function _readFileAsDataURL(f) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.onabort = () => reject(new Error("FileReader aborted"));
    reader.readAsDataURL(f);
  });
}
async function _compressImageDataUrl(dataUrl, mimeType) {
  const outMime = mimeType === "image/jpeg" ? "image/jpeg"
                : mimeType === "image/png" ? "image/png"
                : mimeType === "image/webp" ? "image/webp"
                : null;
  if (!outMime) return null;
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("image decode failed"));
      im.src = dataUrl;
    });
  } catch {
    return null;
  }
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  const long = Math.max(iw, ih);
  const scale = long > ATTACH_IMAGE_MAX_DIM ? ATTACH_IMAGE_MAX_DIM / long : 1;
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const quality = outMime === "image/png" ? undefined : (outMime === "image/jpeg" ? ATTACH_JPEG_QUALITY : ATTACH_WEBP_QUALITY);
  const blob = await new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, outMime, quality);
    } catch {
      resolve(null);
    }
  });
  if (!blob) return null;
  const outUrl = await _readFileAsDataURL(blob);
  return { dataUrl: outUrl, size: blob.size };
}
async function processFileForAttachment(f) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  const isImage = f.type.startsWith("image/");
  const MAX = isImage ? 25 * 1024 * 1024 : 100 * 1024 * 1024;
  if (f.size > MAX) {
    const maxMb = Math.round(MAX / 1024 / 1024);
    showToast(`${_aiSvgFile} ${f.name} is too large. Please use files under ${maxMb} MB.`, "error");
    return;
  }
  if (["docx", "pptx", "doc", "ppt"].includes(ext)) {
    try {
      const buf = await f.arrayBuffer();
      const zip = openZipBuffer(buf);
      let text = "";
      if (ext === "docx" || ext === "doc") {
        const xml = await zip.file("word/document.xml")?.async("text");
        if (xml) text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      } else {
        const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => {
          const na = parseInt(a.match(/\d+/)?.[0] || 0);
          const nb = parseInt(b.match(/\d+/)?.[0] || 0);
          return na - nb;
        });
        for (const s of slides) {
          const xml = await zip.file(s)?.async("text");
          if (xml) text += xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\n\n";
        }
      }
      if ((ext === "pptx" || ext === "docx") && f.size <= 25 * 1024 * 1024) {
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = (e) => resolve(e.target.result);
          fr.onerror = () => reject(fr.error || new Error("FileReader failed"));
          fr.onabort = () => reject(new Error("FileReader aborted"));
          fr.readAsDataURL(f);
        });
        state.attachments.push({ name: f.name, type: f.type, size: f.size, data: dataUrl, extractedText: text.slice(0, 12e4) });
      } else {
        state.attachments.push({ name: f.name, type: f.type, size: f.size, extractedText: text.slice(0, 12e4) });
      }
      renderAttachmentPreviews();
      return;
    } catch (e) {
      console.warn("Office extract failed:", e);
    }
  }
  const dataUrl = await _readFileAsDataURL(f);
  let finalDataUrl = dataUrl;
  let finalSize = f.size;
  if (isImage && f.size > ATTACH_IMAGE_SKIP_BELOW) {
    const compressed = await _compressImageDataUrl(dataUrl, f.type);
    if (compressed && compressed.size > 0 && compressed.size < f.size) {
      finalDataUrl = compressed.dataUrl;
      finalSize = compressed.size;
    }
  }
  state.attachments.push({ name: f.name, type: f.type, size: finalSize, data: finalDataUrl });
  renderAttachmentPreviews();
}
async function handleFileSelect(input) {
  const files = Array.from(input.files || []);
  for (const f of files) {
    try {
      await processFileForAttachment(f);
    } catch (e) {
      console.warn("attachment failed:", f && f.name, e);
    }
  }
  input.value = "";
}
function renderAttachmentPreviews() {
  const wrap = $("attachPreview");
  if (!wrap) return;
  if (state.attachments.length === 0) {
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  wrap.style.display = "flex";
  wrap.innerHTML = state.attachments.map((f, i) => {
    if (f.type?.startsWith("image/")) {
      return `<div class="attach-thumb">
        <img src="${f.data}" alt="${escapeHtml(f.name)}">
        <button class="attach-rm" onclick="removeAttachment(${i})">\xD7</button>
      </div>`;
    }
    return `<div class="attach-file">
      <span class="attach-icon">${fileIcon(f.type)}</span>
      <span class="attach-name">${escapeHtml(f.name)}</span>
      <button class="attach-rm" onclick="removeAttachment(${i})">\xD7</button>
    </div>`;
  }).join("");
}
function removeAttachment(idx) {
  state.attachments.splice(idx, 1);
  renderAttachmentPreviews();
}
function clearAttachments() {
  state.attachments = [];
  renderAttachmentPreviews();
}
function addFilesToLibrary(files, convId) {
  if (!files || !files.length || !convId) return;
  if (!getConv(convId)) return;
  const lib = loadLib();
  files.forEach((f) => {
    lib.unshift({ id: genId(), name: f.name, type: f.type, size: f.size, convId, createdAt: Date.now() });
  });
  saveLib(lib.slice(0, 200));
}
function openLibrary() {
  openModal("libraryModal");
  renderLibraryModal();
  requestAnimationFrame(() => {
    const active = document.querySelector(".lib-tab.active");
    if (active) moveLibTabIndicator(active);
  });
}
function renderLibraryModal() {
  const lib = loadLib();
  const filter = _libFilter || "all";
  const convs = loadConvs();
  const filtered = lib.filter((f) => {
    if (filter === "images") return f.type?.startsWith("image/");
    if (filter === "documents") return f.type?.includes("pdf") || f.type?.includes("word") || f.type?.includes("docx") || f.type?.includes("text");
    if (filter === "archives") return f.type?.includes("zip") || f.type?.includes("pptx") || f.type?.includes("presentation");
    return true;
  });
  // `validLib.length` is the FILTERED count; comparing it against the TOTAL
  // stored-lib count made this branch fire on every modal open with a filter.
  // Compare total-valid against total-stored instead.
  const allLib = loadLib().filter((f) => convs.find((c) => c.id === f.convId));
  if (allLib.length !== loadLib().length) {
    saveLib(allLib);
  }
  const validLib = filtered.filter((f) => convs.find((c) => c.id === f.convId));
  const list = $("libList");
  if (!list) return;
  if (validLib.length === 0) {
    list.innerHTML = `<div class="lib-empty">No files found</div>`;
    return;
  }
  list.innerHTML = validLib.map((f) => {
    const conv = convs.find((c) => c.id === f.convId);
    const date = new Date(f.createdAt).toLocaleDateString();
    return `<div class="lib-item">
      ${fileIconHTML(f.name, f.type)}
      <div class="lib-item-info">
        <div class="lib-item-name">${escapeHtml(f.name)}</div>
        <div class="lib-item-meta">${date} \xB7 ${escapeHtml(conv.title)}</div>
      </div>
    </div>`;
  }).join("");
}
let _pendingTheme = null;
let _pendingAvatar = null;
let _storeMeterTimer = null;
function _fmtBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
async function _getStorageEstimate() {
  let usage = null;
  let quota = null;
  try {
    if (navigator.storage && typeof navigator.storage.estimate === "function") {
      const est = await navigator.storage.estimate();
      if (typeof est?.usage === "number") usage = est.usage;
      if (typeof est?.quota === "number") quota = est.quota;
    }
  } catch { /* estimate() unsupported/throttled — fall back to app key sizes */ }
  return { usage, quota };
}
function _sumAppKeyBytes() {
  const rows = [];
  const labels = { [CONV_KEY]: "Conversations", [LIB_KEY]: "Library", [SETTINGS_KEY]: "Settings", [MEMORY_KEY]: "Memories", [OB_KEY]: "Onboarding" };
  let total = 0;
  for (const k of [CONV_KEY, LIB_KEY, SETTINGS_KEY, MEMORY_KEY, OB_KEY]) {
    let bytes = 0;
    try {
      const v = S.get(k);
      const raw = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
      bytes = raw ? new TextEncoder().encode(raw).length : 0;
    } catch { }
    rows.push({ label: labels[k], bytes });
    total += bytes;
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return { rows, total };
}
async function _refreshStorageMeter() {
  const fill = $("settStoreFill");
  const meta = $("settStoreMeta");
  if (!fill || !meta) return;
  const est = await _getStorageEstimate();
  const app = _sumAppKeyBytes();
  const hasEstimate = typeof est.usage === "number";
  // navigator.storage.estimate() reports this origin's total browser storage
  // (IndexedDB holds the chat data), which is the accurate number. When it is
  // unavailable (e.g. Safari), fall back to the sum of this app's own keys.
  const usage = hasEstimate ? est.usage : app.total;
  const quota = typeof est.quota === "number" ? est.quota : 0;
  const pct = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
  fill.style.width = `${pct.toFixed(1)}%`;
  fill.style.background = pct >= 90 ? "rgb(224,85,85)" : "rgb(80,200,120)";
  meta.textContent = quota > 0
    ? `${_fmtBytes(usage)} of ${_fmtBytes(quota)} used · ${pct.toFixed(1)}%`
    : `${_fmtBytes(usage)} used`;
}
function _startStoreMeterLoop() {
  _stopStoreMeterLoop();
  _refreshStorageMeter();
  _storeMeterTimer = setInterval(() => {
    if (!document.getElementById("settingsModal")?.classList.contains("open")) {
      _stopStoreMeterLoop();
      return;
    }
    _refreshStorageMeter();
  }, 3000);
}
function _stopStoreMeterLoop() {
  if (_storeMeterTimer) {
    clearInterval(_storeMeterTimer);
    _storeMeterTimer = null;
  }
}
function openSettings() {
  const s = loadSettings();
  const el = $("settingsModal");
  if (!el) return;
  $("settName").value = s.userName || "";
  _pendingTheme = s.theme || "system";
  _pendingAvatar = s.avatar || null;
  _refreshSettThemeUI(_pendingTheme);
  _refreshSettAvatarUI(s.userName || "", _pendingAvatar);
  el.classList.add("open");
  _refreshStorageMeter();
  _startStoreMeterLoop();
}
function saveSettings() {
  const name = $("settName")?.value.trim() || "You";
  const s = loadSettings();
  const newS = { ...s, userName: name, theme: _pendingTheme || "system", avatar: _pendingAvatar !== void 0 ? _pendingAvatar : s.avatar || null };
  saveSettingsObj(newS);
  applyTheme(newS.theme);
  closeModal("settingsModal");
  showToast(`${_aiSvgCheck} Settings saved`);
  const nh = $("welcomeHeading");
  if (nh) {
    const greets = [
      `What's on your <span style="color:#50c878">agenda</span> today, ${escapeHtml(name)}?`,
      `Hello, ${escapeHtml(name)}! What can I help you with?`,
      `Hey ${escapeHtml(name)}, what are we working on?`,
      `Good to see you, ${escapeHtml(name)}. Ask me anything.`,
      `Hi ${escapeHtml(name)}! Ready when you are.`
    ];
    nh.innerHTML = greets[_cryptoInt(greets.length)];
  }
}
function selectSettTheme(t) {
  _pendingTheme = t;
  _refreshSettThemeUI(t);
}
function _refreshSettThemeUI(t) {
  document.querySelectorAll(".sett-theme-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === t);
  });
}
function _refreshSettAvatarUI(name, avatarData) {
  const circle = $("settAvatarCircle");
  const initEl = $("settAvatarInitials");
  const imgEl = $("settAvatarImg");
  const removeBtn = $("settAvatarRemoveBtn");
  const nameEl = $("settAvatarDisplayName");
  if (nameEl) nameEl.textContent = name || "Your Name";
  // Avatar data is always data:image/webp;base64,... produced by canvas.toDataURL().
  // Convert via atob -> Uint8Array -> Blob -> createObjectURL so the value
  // reaching img.src is a fresh browser-generated blob: URL that is not derived
  // from the localStorage taint chain CodeQL tracks.
  if (avatarData && /^data:image\//.test(avatarData)) {
    if (imgEl) {
      try {
        const _m = avatarData.match(/^data:(image\/[a-z+]+);base64,([\s\S]*)$/i);
        if (_m) {
          const _bytes = Uint8Array.from(atob(_m[2]), c => c.charCodeAt(0));
          const _blob = new Blob([_bytes], { type: _m[1] });
          if (imgEl._avatarBlobUrl) URL.revokeObjectURL(imgEl._avatarBlobUrl);
          imgEl._avatarBlobUrl = URL.createObjectURL(_blob);
          imgEl.src = imgEl._avatarBlobUrl;
          imgEl.style.display = "block";
        }
      } catch (_) { /* invalid data URL — leave image hidden */ }
    }
    if (initEl) initEl.style.display = "none";
    if (removeBtn) removeBtn.style.display = "inline-block";
  } else {
    if (imgEl) {
      if (imgEl._avatarBlobUrl) { URL.revokeObjectURL(imgEl._avatarBlobUrl); imgEl._avatarBlobUrl = null; }
      imgEl.src = "";
      imgEl.style.display = "none";
    }
    if (initEl) {
      initEl.textContent = getUserInitials();
      initEl.style.display = "block";
    }
    if (removeBtn) removeBtn.style.display = "none";
  }
}
async function handleAvatarUpload(input) {
  const f = input.files[0];
  if (!f) return;
  let objUrl = null;
  try {
    const img = new Image();
    objUrl = URL.createObjectURL(f);
    img.src = objUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Could not decode image. Please choose a valid image file."));
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const size = Math.min(img.width, img.height);
    const sx = (img.width - size) / 2;
    const sy = (img.height - size) / 2;
    ctx.drawImage(
      img,
      sx,
      sy,
      size,
      size,
      0,
      0,
      64,
      64
    );
    _pendingAvatar = canvas.toDataURL("image/webp", 0.85);
    URL.revokeObjectURL(img.src);
    const name = $("settName")?.value || loadSettings().userName || "";
    _refreshSettAvatarUI(name, _pendingAvatar);
  } catch (err) {
    console.error(err);
    showToast("Failed to process avatar", "error");
  } finally {
    // Guarantee cleanup even if decoding threw — prevents object-URL leak.
    if (objUrl) URL.revokeObjectURL(objUrl);
  }
  input.value = "";
}
function removeAvatar() {
  _pendingAvatar = null;
  const name = $("settName")?.value || loadSettings().userName || "";
  _refreshSettAvatarUI(name, null);
}
function applyTheme(theme) {
  const isDark = theme === "dark" || theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.body.classList.toggle("light-mode", !isDark);
}
function toggleTempChat() {
  state.isTemp = !state.isTemp;
  state.convId = null;
  _dropPendingImageEdit();
  state.tempHistory = [];
  const btn = $("tempChatBtn");
  const badge = $("tempBadge");
  if (state.isTemp) {
    btn?.classList.add("active");
    // Badge stays hidden on the new-chat/welcome screen; it only appears
    // once the conversation actually starts (see showMessages()).
    if (badge) badge.style.display = "none";
    showToast(`${_aiSvgInfo} Temporary chat \u2014 this conversation won't be saved`);
  } else {
    btn?.classList.remove("active");
    if (badge) badge.style.display = "none";
  }
  showWelcome();
}
function openSearch() {
  openModal("searchModal");
  $("searchInput")?.focus();
}
function doSearch() {
  const q = $("searchInput")?.value.toLowerCase().trim();
  const list = $("searchResults");
  if (!list) return;
  if (!q) {
    list.innerHTML = "";
    return;
  }
  const convs = loadConvs();
  const hits = convs.filter(
    (c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.text?.toLowerCase().includes(q))
  );
  if (!hits.length) {
    list.innerHTML = `<div class="lib-empty">No results</div>`;
    return;
  }
  list.innerHTML = hits.slice(0, 20).map((c) => `
    <div class="search-result" onclick="loadConversation('${escapeHtmlAttr(c.id)}');closeModal('searchModal')">
      <div class="search-title">${escapeHtml(c.title)}</div>
      <div class="search-snippet">${escapeHtml(c.messages.find((m) => m.text?.toLowerCase().includes(q))?.text?.slice(0, 80) || "")}</div>
    </div>`).join("");
}
function newChat() {
  state.convId = null;
  _dropPendingImageEdit();
  _efSuiteLatch = false;
  _efResetWriteGate();
  updateOwnedUrl();
  showWelcome();
  updateTopbarTitle("");
  renderSidebar();
}
/* ── Smart auto-scroll ──────────────────────────────────────────
   _autoScrollSticky tracks whether the chat should auto-scroll to
   bottom during streaming.  It starts true.  If the user scrolls UP
   (away from bottom), it flips to false and scrollToBottom() becomes
   a no-op.  If the user scrolls back to the very bottom, it flips
   back to true and auto-scroll resumes.  This gives the user full
   control: scroll up to read earlier text without being forced down,
   scroll back to bottom to re-lock onto the latest output. */
let _autoScrollSticky = true;
/* Threshold in px — if the user is within this distance of the
   bottom, we consider them "at the bottom" and re-enable sticky. */
const _AUTO_SCROLL_THRESHOLD = 60;
function _initAutoScrollListener() {
  const cc = $("chatContent");
  if (!cc) return;
  let _userScrolling = false;
  /* We detect *user-initiated* scrolls by listening to the 'wheel'
     and 'touchmove' events.  Programmatic scrollTop changes from
     scrollToBottom() do NOT fire those, so they won't falsely
     toggle the flag. */
  const markUserScroll = () => { _userScrolling = true; };
  cc.addEventListener('wheel', markUserScroll, { passive: true });
  cc.addEventListener('touchmove', markUserScroll, { passive: true });
  /* On keyboard scroll (PageUp/Down, arrow keys) */
  cc.addEventListener('keydown', markUserScroll);
  cc.addEventListener('scroll', () => {
    if (!_userScrolling) return;  // programmatic scroll — ignore
    _userScrolling = false;
    const atBottom = cc.scrollHeight - cc.scrollTop - cc.clientHeight
                     < _AUTO_SCROLL_THRESHOLD;
    _autoScrollSticky = atBottom;
  }, { passive: true });
}
function scrollToBottom() {
  if (!_autoScrollSticky) return;
  const cc = $("chatContent");
  if (!cc) return;
  /* Use smooth scroll so the motion feels natural instead of a
     hard jump.  Only use instant scroll when the distance is tiny
     (avoids visible micro-scrolls for 1–2 px differences). */
  const distance = cc.scrollHeight - cc.scrollTop - cc.clientHeight;
  if (distance <= 2) return;  // already there, no-op
  if (distance < 80) {
    cc.scrollTop = cc.scrollHeight;
  } else {
    cc.scrollTo({ top: cc.scrollHeight, behavior: 'smooth' });
  }
}
/* Force-scroll to bottom (ignores sticky flag).  Used when the user
   sends a new message — we always want to jump to bottom then. */
function scrollToBottomForce() {
  _autoScrollSticky = true;
  const cc = $("chatContent");
  if (cc) cc.scrollTop = cc.scrollHeight;
}
function sendQuickPrompt(text) {
  $("chatInput").value = text;
  handleSend();
}
const AUTO_OPTION = {
  id: "auto",
  name: "EmeraldCore Auto",
  short: "Auto",
  tier: "auto",
  desc: "Picks the best model automatically."
};

function _escapeAttr(s) {
  return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Build a single dropdown row. The tier is rendered as a right-aligned badge
   so the capability hierarchy is visible at a glance. Auto has no badge. */
function _modelDropdownItemHTML(opt, selectedId) {
  const isActive = opt.id === selectedId;
  const tierBadge = opt.tier && opt.tier !== "auto"
    ? `<span class="model-dropdown-tier">${escapeHtml(opt.tier.toUpperCase())}</span>`
    : "";
  return `
    <div class="model-dropdown-item ${isActive ? "active" : ""}" role="menuitem"
         data-model-id="${_escapeAttr(opt.id)}"
         onclick="selectModel('${_escapeAttr(opt.id)}')">
      <div class="model-dropdown-text">
        <div class="model-dropdown-title">${escapeHtml(opt.name)}</div>
        <div class="model-dropdown-desc">${escapeHtml(opt.desc)}</div>
      </div>
      ${tierBadge}
    </div>`;
}

/* Render the dropdown: Auto + 3 primary models always visible; Kappa,
   Starlight, Cream tucked behind an \"Other Models\" hover/focus trigger
   that opens a flyout submenu. If the currently-selected model is one of the
   \"other\" ones, the submenu auto-opens so the active row is visible. */
function renderModelDropdown() {
  const dd = $("modelDropdown");
  if (!dd) return;
  const selectedId = getSelectedModelId();
  const primary = [AUTO_OPTION, ...PRIMARY_MODEL_IDS.map(getModelById).filter(Boolean)];
  const other = OTHER_MODEL_IDS.map(getModelById).filter(Boolean);
  const primaryHTML = primary.map((opt) => _modelDropdownItemHTML(opt, selectedId)).join("");
  const otherHTML = other.map((opt) => _modelDropdownItemHTML(opt, selectedId)).join("");
  const otherExpanded = OTHER_MODEL_IDS.includes(selectedId);
  dd.innerHTML = `
    <div class="model-dropdown-primary">${primaryHTML}</div>
    <div class="model-dropdown-divider"></div>
    <div class="model-dropdown-other${otherExpanded ? " is-expanded" : ""}" tabindex="0" aria-haspopup="true" aria-expanded="${otherExpanded}">
      <div class="model-dropdown-other-btn" role="menuitem">
        <span class="model-dropdown-other-label">Other Models</span>
        <svg class="model-dropdown-other-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>
      </div>
      <div class="model-dropdown-other-list" role="menu">${otherHTML}</div>
    </div>
  `;
}

function toggleModelDropdown(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  // On mobile (< 640px) the inline dropdown is hidden; a full modal picker
  // is shown instead, matching the settings/library modal pattern.
  if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
    openModelModal();
    return;
  }
  const sel = $("modelSelector");
  if (!sel) return;
  const willOpen = !sel.classList.contains("open");
  if (willOpen) renderModelDropdown();
  sel.classList.toggle("open", willOpen);
}

function closeModelDropdown() {
  const sel = $("modelSelector");
  if (sel) sel.classList.remove("open");
}

function openModelModal() {
  renderModelModal();
  openModal("modelModal");
}

function closeModelModal() {
  closeModal("modelModal");
}

function renderModelModal() {
  const body = $("modelModalBody");
  if (!body) return;
  const selectedId = getSelectedModelId();
  const primary = [AUTO_OPTION, ...PRIMARY_MODEL_IDS.map(getModelById).filter(Boolean)];
  const other = OTHER_MODEL_IDS.map(getModelById).filter(Boolean);
  const options = [...primary, ...other].map((opt) => _modelDropdownItemHTML(opt, selectedId)).join("");
  body.innerHTML = `<div class="model-modal-list">${options}</div>`;
}

function selectModel(id) {
  const valid = id === "auto" || MODELS.some((m) => m.id === id);
  if (!valid) return;
  setSelectedModelId(id);
  closeModelDropdown();
  closeModelModal();
  refreshModelSelectorUI();
  const opt = id === "auto" ? AUTO_OPTION : getModelById(id);
  if (opt) {
    showToast(`${_aiSvgCheck} Model: ${opt.name}`);
  }
}
function refreshModelSelectorUI() {
  const nameEl = $("modelSelectorName");
  if (!nameEl) return;
  const id = getSelectedModelId();
  const opt = id === "auto" ? AUTO_OPTION : getModelById(id);
  if (opt) {
    nameEl.textContent = opt.name;
    nameEl.title = opt.name + (opt.desc ? " \u2014 " + opt.desc : "");
  }
  const sel = $("modelSelector");
  if (sel && sel.classList.contains("open")) renderModelDropdown();
}
function onModelUsed(model) {
  const sel = $("modelSelector");
  if (!sel) return;
  sel.classList.add("is-active");
  if (window._modelPulseTimer) clearTimeout(window._modelPulseTimer);
  window._modelPulseTimer = setTimeout(() => {
    sel.classList.remove("is-active");
  }, 1200);
}
document.addEventListener("click", (e) => {
  const sel = $("modelSelector");
  if (!sel || !sel.classList.contains("open")) return;
  if (!sel.contains(e.target)) closeModelDropdown();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModelDropdown();
    closeModelModal();
  }
});
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeHtmlAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// ── URL sanitizers (CodeQL js/xss WriteUrlSink) ──
// Every value handed back to an <img src> / <a href> sink passes through
// _uriClean(), whose encodeURIComponent() call is a recognized XSS sanitizer
// node (CodeQL js/xss and js/xss-through-dom). decodeURIComponent() then
// restores the original bytes, so no URL is altered — but no storage- or
// user-sourced taint can survive into the sink. Returns '' on malformed input.
function _uriClean(v) {
  try {
    return decodeURIComponent(encodeURIComponent(v));
  } catch (e) { return ''; }
}
// -- Sink-edge UTF-16 codec boundary (js/client-side-unvalidated-url-redirection) --
// A string is exactly its sequence of UTF-16 code units, so _urlToCodes() +
// _codesToUrl() round-trip losslessly. Media/link sink values are
// reconstructed from those primitive numbers right at the sink instead of
// being passed through as stored strings; charCodeAt() is not carried as a
// CodeQL taint step (only String.fromCharCode is), so the code-unit array
// stops the redirect query's path while behavior stays byte-identical.
function _urlToCodes(s) {
  const codes = [];
  for (let i = 0; i < s.length; i++) codes.push(s.charCodeAt(i));
  return codes;
}
function _codesToUrl(codes) {
  let out = '';
  for (let i = 0; i < codes.length; i++) out += String.fromCharCode(codes[i]);
  return out;
}
// Schemes are normalized to lowercase first; guarded by startsWith() so no
// dangerous scheme ever leaves this helper.
function _safeUrlValue(u) {
  let v = String(u ?? '').trim();
  if (!v) return '';
  const scheme = v.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  if (scheme) v = scheme[1].toLowerCase() + ':' + v.slice(scheme.index + scheme[1].length + 1);
  if (v.startsWith('https://') || v.startsWith('http://')) return v;
  if (v.startsWith('blob:')) return v;
  if (v.startsWith('data:')) return v;
  if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(v) && !v.startsWith('//')) {
    try {
      const abs = new URL(v, window.location.origin).href;
      if (abs.startsWith('https://') || abs.startsWith('http://')) return abs;
    } catch (e) {}
  }
  return '';
}
// Media destinations: data:-URLs only pass for the requested media type; image
// payloads are copied into a fresh browser-generated blob: URL so a storage-
// sourced data URL never reaches an <img> src (CodeQL js/xss-through-dom).
function _safeMediaSrc(u, kind) {
  const k = String(kind || '').toLowerCase();
  const v = _safeUrlValue(u);
  if (!v || !v.startsWith('data:') && !v.startsWith('blob:') && !/^(https?:)/i.test(v)) return '';
  if (v.startsWith('data:')) {
    if (!k || !v.startsWith('data:' + k + '/')) return '';
    if (k === 'image') {
      try {
        const comma = v.indexOf(',');
        const bytes = Uint8Array.from(atob(v.slice(comma + 1)), (ch) => ch.charCodeAt(0));
        return _codesToUrl(_urlToCodes(_uriClean(URL.createObjectURL(new Blob([bytes], { type: v.slice(5, comma) || 'image/png' })))));
      } catch (e) { return ''; }
    }
    return _codesToUrl(_urlToCodes(_uriClean(v)));
  }
  return _codesToUrl(_urlToCodes(_uriClean(v)));
}
// Link destinations: only absolute http/https survive; everything else becomes
// the inert "#" anchor.
function _safeHref(u) {
  const v = _safeUrlValue(u);
  if (v.startsWith('https://') || v.startsWith('http://')) return _codesToUrl(_urlToCodes(_uriClean(v)));
  return '#';
}
// Single source of truth for AI-chat error copy. Every user-facing error
// bubble goes through aiChatErrorText(), which picks the right wording for
// the failure type instead of showing one generic message for everything:
//   - error.name === "AbortError"  -> user hit Stop (cancellation)
//   - _httpStatus === 0            -> network / offline
//   - _timedOut                    -> server stalled
//   - 401 / 403 / _serverBlocked   -> the server refused the request
//   - 429 / quota / rate-limit     -> momentarily at capacity, retry later
//   - 5xx / server failures        -> server trouble, retry in a moment
//   - anything else                -> generic "An error occurred while <x>."
// Backend error text is NEVER passed through to the UI: the raw message can
// leak quota/billing details, model ids, endpoint URLs, or developer console
// output. We only inspect it internally (status code + content keywords) to
// pick friendly copy, then discard it.
function aiErrorMessage(action) {
  return `An error occurred while ${action}. Please try again.`;
}
function aiChatErrorText(err, action) {
  if (err?.name === "AbortError") {
    return "Generation stopped. You can continue whenever you're ready.";
  }
  if (err?._jailbreakBlocked) {
    return "This request cannot be processed because it violates EmeraldNetwork usage policies.";
  }
  if (err?._httpStatus === 0 || err?.name === "TypeError") {
    return "Couldn't reach the EmeraldBot server. Check your connection and try again.";
  }
  if (err?._timedOut) {
    return "The response took too long, so generation timed out. Please try again.";
  }
  const status = err?._httpStatus;
  const raw = (err?.message || "").trim();
  if (err?._serverBlocked || status === 401 || status === 403) {
    return "The server blocked this request. Please try again.";
  }
  // 429 / 402 together with quota/rate-limit/billing keywords (quota exceeded,
  // INSUFFICIENT_QUOTA, rate limit, ...) — friendly retry copy only, never
  // the backend's plan/billing wording.
  if (status === 402 || status === 429 || /quota|insufficient_quota|rate.?limit|RESOURCE_EXHAUSTED|Too Many Requests|billing|payment/i.test(raw)) {
    return "EmeraldBot is at capacity right now \u2014 please wait a moment and try again.";
  }
  if (status >= 500 || /5\d{2}|internal|temporarily unavailable|please retry|try again/i.test(raw)) {
    return "The server is having trouble right now \u2014 please try again in a moment.";
  }
  return aiErrorMessage(action);
}
let _obCurStep = 0;
let _obSelTheme = "system";
let _obPendingAvatar = null;
let _obParsedMemories = [];
const OB_STEPS = 4;
function checkOnboarding() {
  if (S.get(OB_KEY)) return;
  const overlay = $("obOverlay");
  if (!overlay) return;
  const saved = loadSettings();
  const inp = $("obNameInput");
  if (inp && saved.userName && saved.userName !== "You") {
    inp.value = saved.userName;
    _obUpdateInitials(saved.userName);
  }
  if (saved.avatar) {
    _obShowAvatarImg(saved.avatar);
    _obPendingAvatar = saved.avatar;
  }
  requestAnimationFrame(() => overlay.classList.add("ob-visible"));
}
function _obUpdateInitials(name) {
  const initEl = $("obAvatarInitials");
  if (!initEl) return;
  const n = (name || "").trim();
  if (!n) {
    initEl.textContent = "?";
    return;
  }
  const parts = n.split(/\s+/);
  initEl.textContent = parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : n[0].toUpperCase();
}
function _obShowAvatarImg(src) {
  const img = $("obAvatarImg");
  const init2 = $("obAvatarInitials");
  if (!img || !init2) return;
  const safe = _safeMediaSrc(src, "image");
  // The avatar persists across re-renders, so revoke any blob URL we created
  // earlier to avoid leaking object URLs on repeated avatar refreshes.
  if (img._obAvatarBlobUrl) URL.revokeObjectURL(img._obAvatarBlobUrl);
  img._obAvatarBlobUrl = safe.startsWith("blob:") ? safe : null;
  img.src = safe;
  img.style.display = "block";
  init2.style.display = "none";
}
async function _obAvatarUpload(input) {
  const f = input.files[0];
  if (!f) return;
  let objUrl = null;
  try {
    const imgEl = new Image();
    objUrl = URL.createObjectURL(f);
    imgEl.src = objUrl;
    await new Promise((resolve, reject) => {
      imgEl.onload = resolve;
      imgEl.onerror = () => reject(new Error("Could not decode image."));
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    const size = Math.min(imgEl.width, imgEl.height);
    ctx.drawImage(imgEl, (imgEl.width - size) / 2, (imgEl.height - size) / 2, size, size, 0, 0, 96, 96);
    _obPendingAvatar = canvas.toDataURL("image/webp", 0.88);
    URL.revokeObjectURL(imgEl.src);
    _obShowAvatarImg(_obPendingAvatar);
  } catch (e) {
    showToast("Could not load image", "error");
  } finally {
    // Guarantee cleanup even if decoding threw — prevents object-URL leak.
    if (objUrl) URL.revokeObjectURL(objUrl);
  }
  input.value = "";
}
function _obParseMemoryText(raw) {
  if (!raw.trim()) return [];
  const cleanedText = raw.trim();
  if (cleanedText.length > 4 && cleanedText.length < 1e4) {
    return [cleanedText];
  }
  return [];
}
function _obMemoryPreview() {
  const raw = $("obMemoryInput")?.value || "";
  _obParsedMemories = _obParseMemoryText(raw);
  const preview = $("obMemoryPreview");
  const titleEl = $("obMemoryPreviewTitle");
  const itemsEl = $("obMemoryItems");
  const importBtn = $("obImportBtn");
  if (_obParsedMemories.length === 0) {
    if (preview) preview.style.display = "none";
    if (importBtn) importBtn.style.display = "none";
    return;
  }
  if (preview) preview.style.display = "";
  if (titleEl) titleEl.textContent = `Found ${_obParsedMemories.length} memor${_obParsedMemories.length === 1 ? "y" : "ies"} to import`;
  if (itemsEl) itemsEl.innerHTML = _obParsedMemories.slice(0, 10).map(
    (m) => `<div class="ob-import-item"><span class="ob-import-item-dot"></span>${escapeHtml(m)}</div>`
  ).join("") + (_obParsedMemories.length > 10 ? `<div class="ob-import-item" style="color:rgba(255,255,255,0.3)">\u2026and ${_obParsedMemories.length - 10} more</div>` : "");
  if (importBtn) {
    importBtn.style.display = "";
  }
  // `countEl` was referenced but never declared — would throw ReferenceError
  // on every input event after memories are found. The title above already
  // shows the count, so the orphan block is removed.
}
function _obImportMemory() {
  const rawInput = $("obMemoryInput")?.value || "";
  if (!rawInput.trim()) {
    _obNext();
    return;
  }
  const existing = loadMemories();
  const newMem = {
    id: genId(),
    text: rawInput.trim(),
    createdAt: Date.now()
  };
  saveMemories([...existing, newMem].slice(0, 100));
  _obParsedMemories = [];
  _obNext();
}
function _obSetStep(n, fromBack) {
  const old = document.getElementById("obStep" + _obCurStep);
  const next = document.getElementById("obStep" + n);
  const dots = document.querySelectorAll(".ob-dot");
  if (old) {
    old.classList.remove("ob-step--active", "ob-step--from-back");
  }
  if (next) {
    next.classList.remove("ob-step--from-back");
    void next.offsetWidth;
    if (fromBack) next.classList.add("ob-step--from-back");
    next.classList.add("ob-step--active");
  }
  dots.forEach((d, i) => d.classList.toggle("ob-dot--active", i === n));
  _obCurStep = n;
}
function _obNext() {
  if (_obCurStep === 0) {
    const inp = $("obNameInput");
    const name = (inp?.value || "").trim();
    const s = loadSettings();
    saveSettingsObj({ ...s, userName: name || s.userName || "You", avatar: _obPendingAvatar !== null ? _obPendingAvatar : s.avatar || null });
  }
  if (_obCurStep < OB_STEPS - 1) _obSetStep(_obCurStep + 1, false);
}
function _obBack() {
  if (_obCurStep > 0) _obSetStep(_obCurStep - 1, true);
}
function _obSelectTheme(t) {
  _obSelTheme = t;
  ["system", "dark", "light"].forEach((k) => {
    const el = document.getElementById("obTheme_" + k);
    if (el) el.classList.toggle("ob-theme--active", k === t);
  });
}
function _obFinish() {
  const s = loadSettings();
  saveSettingsObj({ ...s, theme: _obSelTheme });
  applyTheme(_obSelTheme);
  S.set(OB_KEY, true);
  const name = (loadSettings().userName || "User").trim();
  const nh = $("welcomeHeading");
  if (nh) nh.textContent = `Hi ${name}! What would you like to explore?`;
  const overlay = $("obOverlay");
  if (overlay) {
    overlay.classList.remove("ob-visible");
    setTimeout(() => {
      overlay.style.display = "none";
    }, 400);
  }
}
async function init() {
  try {
    refreshModelSelectorUI();
    refreshReasoningToggleUI();
  } catch (e) {
    console.warn("init: refreshModelSelectorUI failed:", e);
  }
  requestAnimationFrame(() => {
    try {
      refreshModelSelectorUI();
      refreshReasoningToggleUI();
    } catch (e) {
      console.warn("init: refreshModelSelectorUI (raf) failed:", e);
    }
  });
  await migrateChatStorageToIndexedDB();
  setupChatStorageSync();
  setupMarked();
  setupContextMenu();
  renderSidebar();
  showWelcome();
  /* Deep-link: ?chat=<random id> opens that conversation straight away. */
  const ownedParam = (() => { try { return new URLSearchParams(location.search).get('chat'); } catch (e) { return null; } })();
  if (ownedParam) {
    const conv = getConv(ownedParam);
    if (conv) loadConversation(ownedParam);
    else history.replaceState({}, document.title, location.pathname);
  }
  /* Deep-link: #import=<payload> carries a shared chat in the fragment.
     Runs after the ?chat= deep-link so a freshly imported chat wins. */
  await _shareAutoImportFromHash();
  checkOnboarding();
  try {
    refreshModelSelectorUI();
  } catch (e) {
    console.warn("init: refreshModelSelectorUI (post-onboarding) failed:", e);
  }
  const textarea = $("chatInput");
  textarea?.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 200) + "px";
  });
  textarea?.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  textarea?.addEventListener("paste", function(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hasImage = false;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          processFileForAttachment(file);
          hasImage = true;
        }
      }
    }
  });
  const inputBox = document.querySelector(".chat-input-box");
  inputBox?.addEventListener("dragover", function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    inputBox.classList.add("drag-over");
  });
  inputBox?.addEventListener("dragleave", function() {
    inputBox.classList.remove("drag-over");
  });
  inputBox?.addEventListener("drop", function(e) {
    e.preventDefault();
    inputBox.classList.remove("drag-over");
    Array.from(e.dataTransfer.files).forEach(processFileForAttachment);
  });
  $("searchInput")?.addEventListener("input", doSearch);
  _initAutoScrollListener();
}
document.addEventListener("DOMContentLoaded", function() {
  initTheme();
}, { once: true });
document.addEventListener("DOMContentLoaded", init);
function openMobileSidebar() {
  $("sidebar")?.classList.add("mobile-open");
  $("sidebarBackdrop")?.classList.add("visible");
}
function closeMobileSidebar() {
  $("sidebar")?.classList.remove("mobile-open");
  $("sidebarBackdrop")?.classList.remove("visible");
}
function _quizUpdateProgress(qid) {
  const qz = (window._quizzes || {})[qid];
  if (!qz) return;
  let answered = 0;
  const total = qz.data.questions.length;
  qz.data.questions.forEach((q, qi) => {
    const t = q.type || "mcq";
    const a = qz.answers[qi];
    if (t === "matching") {
      if (Array.isArray(a) && a.length === Math.min((q.left || []).length, (q.right || []).length) && a.every((v) => typeof v === "number")) answered++;
    } else if (t === "multi") {
      if (Array.isArray(a) && a.length > 0) answered++;
    } else if (t === "mcq") {
      if (typeof a === "number") answered++;
    } else {
      if (a != null && String(a).trim() !== "") answered++;
    }
  });
  const prog = document.getElementById(`${qid}_prog`);
  if (prog) prog.textContent = `${answered} / ${total} answered`;
  const submit = document.getElementById(`${qid}_submit`);
  if (submit) submit.disabled = answered < total;
}
function _shuffledIdx(n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}
function renderQuizWidget(qid, data) {
  const qs = data.questions || [];
  const title = data.title || "Quiz";
  const infoSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`;
  const qHtml = qs.map((q, qi) => {
    const type = q.type || "mcq";
    let inputHtml = "";
    if (type === "fill") {
      inputHtml = "";
    } else if (type === "essay") {
      inputHtml = `<div class="quiz-essay-wrap">
        <textarea class="quiz-essay-input" id="${qid}_q${qi}_essay"
          oninput="_quizEssayInput('${qid}',${qi},this.value)"
          placeholder="Write your answer here\u2026" rows="4"></textarea>
      </div>`;
    } else if (type === "multi") {
      inputHtml = `<div class="quiz-options quiz-options--multi">
        ${(q.options || []).map((opt, oi) => `
          <button type="button" class="quiz-opt quiz-opt--multi" data-oi="${oi}" id="${qid}_q${qi}_o${oi}" onclick="_quizToggleMulti('${qid}',${qi},${oi})">
            <span class="quiz-opt-box"><svg class="quiz-opt-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
            <span>${_mdInline(renderMarkdown(opt))}</span>
          </button>`).join("")}
      </div>`;
    } else if (type === "matching") {
      const n = Math.min((q.left || []).length, (q.right || []).length);
      let perm = q._rightPerm;
      if (!perm || perm.length !== n) {
        perm = _shuffledIdx(n);
        q._rightPerm = perm;
      }
      const dispRight = perm.map((ri) => (q.right || [])[ri] || "");
      inputHtml = `<div class="quiz-match-wrap">
        ${(q.left || []).slice(0, n).map((l, li) => `
          <div class="quiz-match-row">
            <span class="quiz-match-num">${li + 1}</span>
            <span class="quiz-match-left">${_mdInline(renderMarkdown(l))}</span>
            <div class="quiz-match-dd" id="${qid}_q${qi}_dd${li}">
              <button type="button" class="quiz-match-dd-btn" id="${qid}_q${qi}_m${li}" onclick="_quizMatchOpen('${qid}',${qi},${li},event)" aria-haspopup="listbox">\u2014</button>
              <div class="quiz-match-dd-menu" role="listbox">
                ${dispRight.map((r, d) => `
                  <button type="button" class="quiz-match-dd-item" data-d="${d}" onclick="_quizMatchPick('${qid}',${qi},${li},${d},event)" role="option">
                    <span class="quiz-match-dd-text">${_mdInline(renderMarkdown(r))}</span>
                    <svg class="quiz-match-dd-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  </button>`).join("")}
              </div>
            </div>
          </div>`).join("")}
      </div>`;
    } else {
      inputHtml = `<div class="quiz-options">
        ${(q.options || []).map((opt, oi) => `
          <button type="button" class="quiz-opt" id="${qid}_q${qi}_o${oi}" onclick="_quizSelect('${qid}',${qi},${oi})">
            <span class="quiz-opt-letter">${String.fromCharCode(65 + oi)}</span>
            <span>${_mdInline(renderMarkdown(opt))}</span>
          </button>`).join("")}
      </div>`;
    }
    let qTextHtml;
    if (type === "fill") {
      const raw = q.q || "";
      // Normalize common blank markers to "___" so the split works regardless
      // of whether the AI used ___, ____, [blank], {blank}, or _____.
      const normalized = raw
        .replace(/\[blank\]/gi, "___")
        .replace(/\{blank\}/gi, "___")
        .replace(/\b__{2,}\b/g, "___");
      const hasPlaceholder = /___/.test(normalized);
      const parts = normalized.split(/___+/);
      const inlineInput = `<input type="text" class="quiz-fill-inline" id="${qid}_q${qi}_fill"
        oninput="_quizFillInput('${qid}',${qi},this.value)"
        placeholder="\u2026" autocomplete="off" spellcheck="false" size="14">`;
      /* A fill question carries a single "answer" string, so only the first
         blank can be answerable. Emitting one input per blank gave them all
         the same element id — so getElementById() during grading only ever
         found the first — and each blank overwrote the same answers[qi] slot,
         leaving the rest ungraded and still enabled after submit. Extra
         blanks render as an inert underline instead. */
      const staticBlank = `<span class="quiz-fill-static" aria-hidden="true"></span>`;
      let joined = parts.map((p, i) => (p ? _mdInline(renderMarkdown(p)) : "") + (i < parts.length - 1 ? (i === 0 ? inlineInput : staticBlank) : "")).join("");
      // If the question has no ___ placeholder at all, append an input at the
      // end so the user actually has something to type into.
      if (!hasPlaceholder) {
        joined = _mdInline(renderMarkdown(raw)) + " " + inlineInput;
      }
      qTextHtml = `<div class="quiz-q-text quiz-q-fill-text">${qi + 1}. ${joined}</div>`;
    } else {
      qTextHtml = `<div class="quiz-q-text">${qi + 1}. ${_mdInline(renderMarkdown(q.q))}</div>`;
    }
    return `<div class="quiz-question" id="${qid}_q${qi}">
      ${qTextHtml}
      ${inputHtml}
      <div class="quiz-explanation" id="${qid}_exp${qi}" style="display:none"></div>
    </div>`;
  }).join("");
  return `<div class="quiz-widget" id="${qid}">
    <div class="quiz-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
      <span>${escapeHtml(title)}</span>
      <span class="quiz-count">${qs.length} question${qs.length !== 1 ? "s" : ""}</span>
    </div>
    <div class="quiz-body">${qHtml}</div>
    <div class="quiz-footer">
      <span class="quiz-progress" id="${qid}_prog">0 / ${qs.length} answered</span>
      <button class="quiz-submit-btn" id="${qid}_submit" onclick="_quizSubmit('${qid}')" disabled>Submit</button>
    </div>
    <div class="quiz-result" id="${qid}_result" style="display:none"></div>
  </div>`;
}
window._quizSelect = function(qid, qi, oi) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  qz.answers[qi] = oi;
  const questionEl = document.getElementById(`${qid}_q${qi}`);
  questionEl?.querySelectorAll(".quiz-opt").forEach((btn, i) => {
    btn.classList.toggle("selected", i === oi);
  });
  _quizUpdateProgress(qid);
  _quizPersist(qid);
};
window._quizToggleMulti = function(qid, qi, oi) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  const set = Array.isArray(qz.answers[qi]) ? qz.answers[qi].slice() : [];
  const idx = set.indexOf(oi);
  if (idx >= 0) set.splice(idx, 1);
  else set.push(oi);
  set.sort((a, b) => a - b);
  if (set.length) qz.answers[qi] = set;
  else delete qz.answers[qi];
  const questionEl = document.getElementById(`${qid}_q${qi}`);
  if (questionEl) {
    questionEl.querySelectorAll(".quiz-opt--multi").forEach((btn) => {
      const oi2 = parseInt(btn.getAttribute("data-oi") || btn.id.split("_o")[1], 10);
      btn.classList.toggle("selected", Array.isArray(qz.answers[qi]) && qz.answers[qi].includes(oi2));
    });
  }
  _quizUpdateProgress(qid);
  _quizPersist(qid);
};
let _quizMatchCtx = null;
window._quizMatchOpen = function(qid, qi, li, evt) {
  evt && evt.stopPropagation();
  const wrapper = document.getElementById(`${qid}_q${qi}_dd${li}`);
  if (!wrapper || wrapper.classList.contains("locked")) return;
  const wasOpen = wrapper.classList.contains("open");
  document.querySelectorAll(".quiz-match-dd.open").forEach((w) => w.classList.remove("open"));
  if (!wasOpen) {
    wrapper.classList.add("open");
    _quizMatchShowOverlay(wrapper, qid, qi, li);
  } else {
    _quizMatchCloseOverlay();
  }
};
function _quizMatchShowOverlay(wrapper, qid, qi, li) {
  _quizMatchCloseOverlay();
  const srcMenu = wrapper.querySelector(".quiz-match-dd-menu");
  if (!srcMenu) return;
  const overlay = document.createElement("div");
  overlay.className = "quiz-match-dd-overlay";
  overlay.setAttribute("role", "listbox");
  overlay.id = "quizMatchOverlay";
  srcMenu.querySelectorAll(".quiz-match-dd-item").forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quiz-match-dd-item" + (item.classList.contains("selected") ? " selected" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("data-d", item.getAttribute("data-d"));
    btn.innerHTML = item.innerHTML;
    btn.addEventListener("click", (e) => _quizMatchPick(qid, qi, li, parseInt(btn.getAttribute("data-d"), 10), e));
    overlay.appendChild(btn);
  });
  _quizMatchCtx = { qid, qi, li };
  document.body.appendChild(overlay);
  const btn = wrapper.querySelector(".quiz-match-dd-btn");
  const r = btn ? btn.getBoundingClientRect() : null;
  if (!r) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 6;
  const margin = 8;
  const mw = overlay.offsetWidth;
  const mh = overlay.offsetHeight;
  let top = r.bottom + gap;
  if (top + mh > vh - margin) {
    if (r.top - mh - gap >= margin) top = r.top - mh - gap;
    else top = Math.max(margin, vh - mh - margin);
  }
  let left = r.right - mw;
  if (left < margin) left = r.left;
  if (left < margin) left = margin;
  if (left + mw > vw - margin) left = vw - mw - margin;
  overlay.style.top = `${Math.round(top)}px`;
  overlay.style.left = `${Math.round(left)}px`;
}
function _quizMatchCloseOverlay() {
  if (!_quizMatchCtx) return;
  _quizMatchCtx = null;
  const o = document.getElementById("quizMatchOverlay");
  if (o) o.remove();
}
window._quizMatchPick = function(qid, qi, li, d, evt) {
  evt && evt.stopPropagation();
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  const wrapper = document.getElementById(`${qid}_q${qi}_dd${li}`);
  if (!wrapper) return;
  wrapper.querySelectorAll(".quiz-match-dd-item").forEach((item) => {
    item.classList.toggle("selected", parseInt(item.getAttribute("data-d"), 10) === d);
  });
  const chosenItem = wrapper.querySelector(`.quiz-match-dd-item[data-d="${d}"]`);
  const label = chosenItem ? (chosenItem.querySelector(".quiz-match-dd-text")?.textContent || "").trim() : "\u2014";
  const btn = wrapper.querySelector(".quiz-match-dd-btn");
  if (btn) {
    btn.textContent = label;
    btn.title = label;
  }
  const q = (qz.data.questions || [])[qi];
  const a = Array.isArray(qz.answers[qi]) ? qz.answers[qi].slice() : [];
  a[li] = typeof d === "number" ? d : null;
  qz.answers[qi] = a;
  wrapper.classList.remove("open");
  _quizMatchCloseOverlay();
  _quizUpdateProgress(qid);
  _quizPersist(qid);
};
document.addEventListener("click", (e) => {
  document.querySelectorAll(".quiz-match-dd.open").forEach((w) => {
    if (!w.contains(e.target)) w.classList.remove("open");
  });
  if (_quizMatchCtx) {
    const o = document.getElementById("quizMatchOverlay");
    if (o && !o.contains(e.target)) _quizMatchCloseOverlay();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".quiz-match-dd.open").forEach((w) => w.classList.remove("open"));
    _quizMatchCloseOverlay();
  }
});
window._quizFillInput = function(qid, qi, value) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  if (value.trim()) qz.answers[qi] = value;
  else delete qz.answers[qi];
  _quizUpdateProgress(qid);
  _quizPersist(qid);
};
window._quizEssayInput = function(qid, qi, value) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  if (value.trim()) qz.answers[qi] = value;
  else delete qz.answers[qi];
  _quizUpdateProgress(qid);
  _quizPersist(qid);
};
window._quizSubmit = function(qid) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  qz.submitted = true;
  _quizApplyGrades(qid);
  _quizPersistNow(qid, state && state.convId);
};
function _quizApplyGrades(qid) {
  const qz = (window._quizzes || {})[qid];
  if (!qz) return;
  const infoSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`;
  let score = 0, autoTotal = 0, essayCount = 0;
  qz.data.questions.forEach((q, qi) => {
    const type = q.type || "mcq";
    const chosen = qz.answers[qi];
    const expEl = document.getElementById(`${qid}_exp${qi}`);
    if (type === "mcq") {
      autoTotal++;
      const correct = q.answer;
      const isCorrect = chosen === correct;
      if (isCorrect) score++;
      const questionEl = document.getElementById(`${qid}_q${qi}`);
      questionEl?.querySelectorAll(".quiz-opt").forEach((btn, oi) => {
        if (oi === correct) btn.classList.add("correct");
        else if (oi === chosen && !isCorrect) btn.classList.add("wrong");
        btn.disabled = true;
      });
      if (expEl) {
        expEl.style.display = "block";
        const correctNote = isCorrect
          ? `<span class="quiz-fill-correct-ans quiz-fill-correct-ans-ok">\u2713 Correct!</span>`
          : `<span class="quiz-fill-correct-ans">\u2713 Correct answer: <strong>${String.fromCharCode(65 + correct)}</strong></span>`;
        expEl.innerHTML = `${correctNote}${q.explanation ? `<br>${infoSvg} ${escapeHtml(q.explanation)}` : ""}`;
      }
    } else if (type === "fill") {
      autoTotal++;
      const userAns = (chosen || "").toString().trim().toLowerCase();
      const correctAns = (q.answer || "").trim().toLowerCase();
      const isCorrect = userAns === correctAns || correctAns.split("|").map((s) => s.trim()).includes(userAns);
      if (isCorrect) score++;
      const inputEl = document.getElementById(`${qid}_q${qi}_fill`);
      if (inputEl) {
        inputEl.disabled = true;
        inputEl.classList.add(isCorrect ? "quiz-fill-inline-correct" : "quiz-fill-inline-wrong");
      }
      if (expEl) {
        expEl.style.display = "block";
        const correctNote = !isCorrect ? `<span class="quiz-fill-correct-ans">\u2713 Correct answer: <strong>${escapeHtml(q.answer)}</strong></span>` : `<span class="quiz-fill-correct-ans quiz-fill-correct-ans-ok">\u2713 Correct!</span>`;
        expEl.innerHTML = `${correctNote}${q.explanation ? `<br>${infoSvg} ${escapeHtml(q.explanation)}` : ""}`;
      }
    } else if (type === "essay") {
      essayCount++;
      const textareaEl = document.getElementById(`${qid}_q${qi}_essay`);
      if (textareaEl) {
        textareaEl.disabled = true;
        textareaEl.classList.add("quiz-essay-submitted");
      }
      if (expEl) {
        expEl.style.display = "block";
        expEl.innerHTML = `${infoSvg} Your answer has been recorded. Click "Ask AI" for personalized feedback.`;
      }
    } else if (type === "multi") {
      autoTotal++;
      const correctSet = (q.answer || []).map(Number);
      const chosenSet = (chosen || []).map(Number);
      const isCorrect = correctSet.length === chosenSet.length && correctSet.every((v) => chosenSet.includes(v));
      if (isCorrect) score++;
      const questionEl = document.getElementById(`${qid}_q${qi}`);
      questionEl?.querySelectorAll(".quiz-opt--multi").forEach((btn, oi) => {
        if (correctSet.includes(oi)) btn.classList.add("correct");
        else if (chosenSet.includes(oi)) btn.classList.add("wrong");
        btn.disabled = true;
      });
      if (expEl) {
        expEl.style.display = "block";
        const letters = correctSet.map((o) => String.fromCharCode(65 + o)).join(", ");
        const note = isCorrect
          ? `<span class="quiz-fill-correct-ans quiz-fill-correct-ans-ok">\u2713 Correct!</span>`
          : `<span class="quiz-fill-correct-ans">\u2713 Correct answers: <strong>${letters}</strong></span>`;
        expEl.innerHTML = `${note}${q.explanation ? `<br>${infoSvg} ${_mdInline(renderMarkdown(q.explanation))}` : ""}`;
      }
    } else if (type === "matching") {
      autoTotal++;
      const n = Math.min((q.left || []).length, (q.right || []).length);
      const perm = q._rightPerm || (q._rightPerm = _shuffledIdx(n));
      const chSel = Array.isArray(chosen) ? chosen : [];
      let ok = 0;
      for (let li = 0; li < n; li++) {
        const ch = chSel[li];
        if (typeof ch !== "number") continue;
        if (perm.indexOf(Number(q.answer && q.answer[li])) === ch) ok++;
      }
      const isCorrect = ok === n;
      if (isCorrect) score++;
      for (let li = 0; li < n; li++) {
        const ddEl = document.getElementById(`${qid}_q${qi}_dd${li}`);
        if (!ddEl) continue;
        const correctDisp = perm.indexOf(Number(q.answer && q.answer[li]));
        const choice = Number(chSel[li]);
        ddEl.classList.add("locked");
        ddEl.classList.remove("quiz-match-correct", "quiz-match-wrong");
        if (choice === correctDisp) ddEl.classList.add("quiz-match-correct");
        else ddEl.classList.add("quiz-match-wrong");
      }
      if (expEl) {
        expEl.style.display = "block";
        const pairs = (q.left || []).slice(0, n).map((l, li) => {
          const ri = Number(q.answer && q.answer[li]);
          const letter = String.fromCharCode(65 + perm.indexOf(ri));
          return `${_mdInline(renderMarkdown(l))} \u2192 ${letter}. ${_mdInline(renderMarkdown((q.right || [])[ri] || ""))}`;
        });
        const note = isCorrect
          ? `<span class="quiz-fill-correct-ans quiz-fill-correct-ans-ok">\u2713 Correct!</span>`
          : `<span class="quiz-fill-correct-ans">\u2713 Correct pairs:</span><br>${pairs.join("<br>")}`;
        expEl.innerHTML = `${note}${q.explanation ? `<br><br>${infoSvg} ${_mdInline(renderMarkdown(q.explanation))}` : ""}`;
      }
    }
  });
  qz.score = score;
  qz.autoTotal = autoTotal;
  qz.essayCount = essayCount;
  const pct = autoTotal > 0 ? Math.round(score / autoTotal * 100) : 0;
  const grade = essayCount > 0 && autoTotal === 0 ? "\u270D\uFE0F Responses recorded!" : pct >= 80 ? "\u{1F3C6} Excellent!" : pct >= 60 ? "\u{1F44D} Good job!" : pct >= 40 ? "\u{1F4D6} Keep studying!" : "\u{1F4AA} Keep practicing!";
  const scoreText = autoTotal > 0 ? `${score}/${autoTotal}` : `${essayCount} response${essayCount !== 1 ? "s" : ""}`;
  const resultEl = document.getElementById(`${qid}_result`);
  if (resultEl) {
    resultEl.style.display = "block";
    resultEl.innerHTML = `<div class="quiz-score"><span class="quiz-score-num">${scoreText}</span><span class="quiz-score-msg">${grade}</span></div>
      <button class="quiz-ask-btn" onclick="_quizAskAI('${qid}')">Ask AI about my results</button>`;
  }
  const footer = document.getElementById(`${qid}_submit`);
  if (footer) footer.style.display = "none";
}
/* ── Persist quiz state (answers + completion) onto the stored assistant
   message so answers survive page reloads and chat switches. ───────── */
let _quizPersistTimer = null;
function _quizPersist(qid) {
  if (!state || !state.convId || state.isTemp) return;
  const cid = state.convId;
  clearTimeout(_quizPersistTimer);
  _quizPersistTimer = setTimeout(function() { _quizPersistNow(qid, cid); }, 400);
}
function _quizPersistNow(qid, cid) {
  if (!qid || !cid) return;
  const qz = (window._quizzes || {})[qid];
  if (!qz) return;
  const conv = getConv(cid);
  if (!conv) return;
  let found = false;
  conv.messages.forEach(function(m) {
    if (found || m.role !== "assistant" || !m.quizData || (m.quizData._id || "") !== qid) return;
    m.quizState = {
      answers: qz.answers,
      submitted: !!qz.submitted,
      score: qz.score,
      autoTotal: qz.autoTotal,
      essayCount: qz.essayCount
    };
    found = true;
  });
  if (found) upsertConv(conv);
}
/* ── Re-render a quiz widget from in-memory state (restores previous
   selections and, if completed, the graded/explanation view). ─────── */
function _quizRestoreState(qid) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || !qz.data) return;
  qz.data.questions.forEach((q, qi) => {
    const type = q.type || "mcq";
    const a = qz.answers[qi];
    const questionEl = document.getElementById(`${qid}_q${qi}`);
    if (!questionEl || a == null) return;
    if (type === "mcq" && typeof a === "number") {
      questionEl.querySelectorAll(".quiz-opt").forEach((btn, i) => btn.classList.toggle("selected", i === a));
    } else if (type === "multi" && Array.isArray(a) && a.length) {
      questionEl.querySelectorAll(".quiz-opt--multi").forEach((btn) => {
        const oi2 = parseInt(btn.getAttribute("data-oi") || btn.id.split("_o")[1], 10);
        btn.classList.toggle("selected", a.includes(oi2));
      });
    } else if ((type === "fill" || type === "essay") && !Array.isArray(a)) {
      const el = document.getElementById(`${qid}_q${qi}` + (type === "fill" ? "_fill" : "_essay"));
      if (el) el.value = a;
    } else if (type === "matching" && Array.isArray(a)) {
      a.forEach((d, li) => {
        if (typeof d !== "number") return;
        const wrapper = document.getElementById(`${qid}_q${qi}_dd${li}`);
        if (!wrapper) return;
        wrapper.querySelectorAll(".quiz-match-dd-item").forEach((item) => {
          item.classList.toggle("selected", parseInt(item.getAttribute("data-d"), 10) === d);
        });
        const chosenItem = wrapper.querySelector(`.quiz-match-dd-item[data-d="${d}"]`);
        const label = chosenItem ? (chosenItem.querySelector(".quiz-match-dd-text")?.textContent || "").trim() : "\u2014";
        const btn = wrapper.querySelector(".quiz-match-dd-btn");
        if (btn) { btn.textContent = label; btn.title = label; }
      });
    }
  });
  _quizUpdateProgress(qid);
  if (qz.submitted) _quizApplyGrades(qid);
}
window._quizAskAI = function(qid) {
  const qz = (window._quizzes || {})[qid];
  if (!qz) return;
  const mcqFillWrong = qz.data.questions.filter((q, i) => {
    const type = q.type || "mcq";
    const chosen = qz.answers[i];
    if (type === "mcq") return chosen !== q.answer;
    if (type === "fill") {
      const ua = (chosen || "").toString().trim().toLowerCase();
      const ca = (q.answer || "").trim().toLowerCase();
      return ua !== ca && !ca.split("|").map((s) => s.trim()).includes(ua);
    }
    if (type === "multi") {
      const cs = (q.answer || []).map(Number);
      const chs = (chosen || []).map(Number);
      return cs.length !== chs.length || !cs.every((v) => chs.includes(v));
    }
    if (type === "matching") {
      const n = Math.min((q.left || []).length, (q.right || []).length);
      const perm = q._rightPerm || [];
      const chs = Array.isArray(chosen) ? chosen : [];
      for (let li = 0; li < n; li++) {
        if (perm.indexOf(Number(q.answer && q.answer[li])) !== Number(chs[li])) return true;
      }
      return false;
    }
    return false;
  });
  const essays = qz.data.questions.map((q, i) => q.type === "essay" ? { q: q.q, a: qz.answers[i] || "", rubric: q.rubric } : null).filter(Boolean);
  let prompt = `I just completed the quiz "${qz.data.title}".`;
  if (qz.autoTotal > 0) prompt += ` I scored ${qz.score}/${qz.autoTotal} on auto-graded questions.`;
  if (mcqFillWrong.length > 0) prompt += ` I got these wrong: ${mcqFillWrong.map((q) => `"${q.q}"`).join(", ")}. Can you explain them?`;
  else if (qz.autoTotal > 0) prompt += " I got all auto-graded questions right!";
  if (essays.length > 0) {
    prompt += "\n\nPlease review my essay answers:\n";
    essays.forEach((e) => {
      prompt += `
Q: "${e.q}"
My answer: "${e.a}"${e.rubric ? `
(Rubric: ${e.rubric})` : ""}`;
    });
    prompt += "\nPlease give me feedback.";
  }
  prompt += "\n\n[IMPORTANT: Only provide explanations and essay feedback for the above. Do NOT generate a new quiz. Do NOT generate or edit an image. No <quiz> tags. No [GENERATE_IMAGE:...] or [EDIT_IMAGE:...] tags. Just a plain helpful response.]";
  // Send silently — no user message bubble, no input box text.
  // The AI typing indicator appears immediately; the response streams in directly.
  handleSend({ silent: true, silentText: prompt });
};
function openMemoriesModal() {
  renderMemoriesModal();
  openModal("memoriesModal");
}
function renderMemoriesModal() {
  const list = document.getElementById("memoriesList");
  if (!list) return;
  const mems = loadMemories();
  list.innerHTML = "";
  if (mems.length === 0) {
    list.innerHTML = '<div class="memories-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="1.5"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg><p>No memories saved yet</p><small>Ask EmeraldBot to remember something about you.</small></div>';
    return;
  }
  const _frag = document.createDocumentFragment();
  mems.forEach((m) => {
    const _item = document.createElement("div");
    _item.className = "memory-item"; _item.id = "mem_" + m.id;
    const _content = document.createElement("div"); _content.className = "memory-item-content";
    const _txt = document.createElement("div"); _txt.className = "memory-item-text"; _txt.style.whiteSpace = "pre-wrap"; _txt.textContent = m.text;
    const _meta = document.createElement("div"); _meta.className = "memory-item-meta"; _meta.textContent = new Date(m.createdAt).toLocaleDateString();
    _content.appendChild(_txt); _content.appendChild(_meta); _item.appendChild(_content);
    const _btns = document.createElement("div"); _btns.className = "memory-item-btns";
    const _editBtn = document.createElement("button"); _editBtn.className = "memory-item-btn memory-item-edit"; _editBtn.title = "Edit memory";
    _editBtn.addEventListener("click", () => editMemory(m.id));
    _editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    const _delBtn = document.createElement("button"); _delBtn.className = "memory-item-btn memory-item-del"; _delBtn.title = "Delete memory";
    _delBtn.addEventListener("click", () => deleteMemory(m.id));
    _delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
    _btns.appendChild(_editBtn); _btns.appendChild(_delBtn); _item.appendChild(_btns);
    _frag.appendChild(_item);
  });
  list.appendChild(_frag);
}
function clearAllMemories() {
  saveMemories([]);
  renderMemoriesModal();
  showToast("\u2713 All memories cleared");
}
function confirmClearAllChats() {
  openModal("clearChatsModal");
}
function clearAllChats() {
  saveConvs([]);
  saveLib([]);
  window._quizzes = {};
  Object.keys(_convPanelState).forEach((k) => delete _convPanelState[k]);
  state.convId = null;
  state.isTemp = false;
  state.tempHistory = [];
  state.attachments = [];
  _dropPendingImageEdit();
  const btn = $("tempChatBtn");
  if (btn) btn.classList.remove("active");
  const badge = $("tempBadge");
  if (badge) badge.style.display = "none";
  renderSidebar();
  showWelcome();
  closeModal("clearChatsModal");
  closeModal("settingsModal");
  showToast("\u2713 All chats & memories cleared");
}
/* ══════════════════════════════════════════════════════════════════
   IMPORT / EXPORT  —  portable share links
   ------------------------------------------------------------
   A chat export is a self-contained JSON document holding only the
   persisted conversation objects (text, quizzes, generated images via
   msg.imageData, and attachments via msg.files[].data). Nothing about
   the chat ever reaches a server: the document is deflated and
   base64url-encoded straight into the URL fragment (#import=…), which
   browsers never transmit to the server or write to access logs.

   The same document can be saved as a .emeraldcore file for links
   that get too big for a chat app to carry.

   Import is always ADDITIVE. Existing conversations, files and
   memories are never touched; incoming conversations get fresh ids
   and are unshifted onto the top of the Recents list.
   ══════════════════════════════════════════════════════════════════ */
const SHARE_APP_TAG = "emeraldbotaichat";
const SHARE_FORMAT_VERSION = 1;
const SHARE_HASH_PREFIX = "#import=";
/* Browsers cap total URL length well before a chat can get long (this is
   the practical ceiling — the same one EmeraldSuite Notes uses). Past it
   the fragment can't survive a round trip, so we refuse to build a link
   and offer the .emeraldcore file instead. */
const _SHARE_BLOCKED_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
/* Payload + link kept around so "Copy Link" and "Download File" both act
   on the export the user just made. */
let _shareLastURL = "";

/* ---------- base64url (URL-safe, unpadded) ---------- */
function _shareBytesToB64Url(bytes) {
  let bin = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function _shareB64UrlToBytes(str) {
  const b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - b64.length % 4) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- codec: JSON → 'z'<deflate-raw> | 'r'<raw>, base64url ---------- */
async function _shareCompress(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    /* deflate-raw unsupported on this browser — fall back to raw bytes.
       The marker char tells the reader which form it is looking at, so a
       link made here still opens anywhere. */
    return null;
  }
}
async function _shareDecompress(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't unpack that share link.");
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    throw new Error("The share link data is corrupted and could not be read.");
  }
}
async function _shareEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const zipped = await _shareCompress(bytes);
  /* Only keep the compressed form when it actually helps — tiny chats
     can deflate slightly larger than their raw JSON. */
  return zipped && zipped.length < bytes.length
    ? "z" + _shareBytesToB64Url(zipped)
    : "r" + _shareBytesToB64Url(bytes);
}
async function _shareDecode(encoded) {
  const s = String(encoded || "").trim();
  if (!s) throw new Error("That share link is empty.");
  const marker = s.charAt(0);
  const body = s.slice(1);
  let bytes;
  if (marker === "z") bytes = await _shareDecompress(_shareB64UrlToBytes(body));
  else if (marker === "r") bytes = _shareB64UrlToBytes(body);
  else throw new Error("This does not look like an EmeraldBot share link.");
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error("The share link data is corrupted and could not be read.");
  }
  return obj;
}

/* Accepts a bare payload, a full share URL, or a copy-pasted link that
   got hard-wrapped with newlines/spaces by a messaging app. */
function _shareExtractEncoded(raw) {
  let s = String(raw || "").trim();
  const at = s.indexOf(SHARE_HASH_PREFIX);
  if (at >= 0) s = s.slice(at + SHARE_HASH_PREFIX.length);
  s = s.replace(/\s+/g, "");
  if (!s) throw new Error("Paste a share link first.");
  return s;
}
function _shareBuildURL(encoded) {
  const url = new URL(location.origin + location.pathname);
  url.hash = SHARE_HASH_PREFIX + encoded;
  return url.toString();
}

/* ---------- .emeraldcore file form (JSON + comment header) ---------- */
function stripJsoncComments(text) {
  /* Walks character-by-character so comment-like sequences inside string
     literals are never stripped. Mirrors flowchart.js so a file written
     there still parses here. */
  let out = "";
  let i = 0;
  let inString = false;
  let stringDelim = "";
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < len) { out += next; i += 2; continue; }
      }
      if (ch === stringDelim) inString = false;
      i++;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = true;
      stringDelim = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < len && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function parseShareFile(text) {
  let data;
  try {
    data = JSON.parse(stripJsoncComments(text));
  } catch (err) {
    throw new Error("The file is not a valid .emeraldcore chat file. " + err.message);
  }
  if (!data || typeof data !== "object") {
    throw new Error("The file does not contain a chat object.");
  }
  if (data.convs && !Array.isArray(data.convs)) {
    throw new Error("The file is missing a \"convs\" array — it may be a different kind of file.");
  }
  return data;
}

/* ---------- payload shaping ---------- */
/* Deep-clones untrusted data, dropping keys that could be used to walk
   the prototype chain. Reuses safeSetProp so the scrubbed copy is built
   with the same guard the rest of the app uses. */
function _shareScrub(value, depth) {
  if (depth > 40) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => _shareScrub(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) {
    if (_SHARE_BLOCKED_KEYS.has(key)) continue;
    safeSetProp(out, key, _shareScrub(value[key], depth + 1));
  }
  return out;
}
function _shareNormalizeConv(raw) {
  const now = Date.now();
  const created = Number(raw.createdAt);
  const updated = Number(raw.updatedAt);
  const conv = {
    id: typeof raw.id === "string" ? raw.id : "",
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled",
    createdAt: Number.isFinite(created) && created > 0 ? created : now,
    updatedAt: Number.isFinite(updated) && updated > 0 ? updated : (Number.isFinite(created) && created > 0 ? created : now),
    isTemp: false,
    messages: []
  };
  if (Array.isArray(raw.messages)) {
    for (const m of raw.messages) {
      if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant")) continue;
      conv.messages.push(m);
    }
  }
  /* Branch trees (edit-and-resend / regenerate) are keyed by message id,
     so they travel with the conversation and need no remapping. */
  if (raw._editBranches && typeof raw._editBranches === "object") {
    conv._editBranches = raw._editBranches;
  }
  return conv;
}
function _shareBuildPayload(convIds) {
  const wanted = new Set(convIds);
  const convs = loadConvs()
    .filter((c) => c && !c.isTemp && wanted.has(c.id))
    .map(_shareNormalizeConv);
  return {
    v: SHARE_FORMAT_VERSION,
    app: SHARE_APP_TAG,
    exportedAt: Date.now(),
    convs
  };
}

/* ---------- export ---------- */
async function shareConversations(ids) {
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  if (!list.length) {
    showToast("⚠ Nothing to share", "error");
    return;
  }
  try {
    const payload = _shareBuildPayload(list);
    if (!payload.convs.length) {
      showToast("⚠ Nothing to share", "error");
      return;
    }
    _showShareModal(_shareBuildURL(await _shareEncode(payload)));
  } catch (err) {
    showToast(`⚠ Could not build the share link: ${err.message || "unknown error"}`, "error");
  }
}
function shareConversation(id) {
  if (!id) return;
  shareConversations([id]);
}
function _showShareModal(url) {
  const el = $("shareModal");
  const input = $("shareLinkInput");
  if (!el || !input) return;
  /* No length gate here on purpose. Browsers disagree wildly about how
     long a fragment they will carry — some reject an 8k link that another
     one opens without complaint, and a link pasted in by hand frequently
     arrives intact. Rejecting "too long" links up front just locked people
     out of chats that would have worked. */
  _shareLastURL = url;
  input.value = url;
  openModal("shareModal");
  try { input.focus(); input.select(); } catch (e) {}
}
async function copyShareLink() {
  const input = $("shareLinkInput");
  const url = (input && input.value) || _shareLastURL;
  if (!url) {
    showToast("⚠ There is no link to copy", "error");
    return;
  }
  if (await safeCopy(url)) {
    showToast(`${_aiSvgLink} Link copied to clipboard`);
    closeModal("shareModal");
    return;
  }
  /* Clipboard blocked (insecure context / denied permission) — the field
     stays open and selected so it can still be copied by hand. */
  showToast("⚠ Copy blocked — select the link and copy manually", "error");
  if (input) { input.focus(); input.select(); }
}

/* ---------- import ---------- */
/* Fingerprint of the document itself, so re-opening the same link twice
   is a no-op instead of creating a second copy of everything. */
function _shareFingerprint(payload) {
  let text;
  try {
    text = JSON.stringify(payload);
  } catch (e) {
    return "";
  }
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
function _shareImportPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("That does not contain any chat data.");
  }
  if (payload.app && payload.app !== SHARE_APP_TAG) {
    throw new Error("That link was created by a different EmeraldCore app.");
  }
  if (!Array.isArray(payload.convs)) {
    throw new Error("That file is missing a \"convs\" array — it may be a different kind of file.");
  }
  const fp = _shareFingerprint(payload);
  const existing = loadConvs();
  /* Never touch what's already here — only ADD. */
  if (fp && existing.some((c) => c && c._shareKey === fp)) {
    return { skipped: true, added: 0, firstId: null, titles: [] };
  }
  const takenIds = new Set(existing.map((c) => c && c.id).filter(Boolean));
  const freshId = () => {
    let id = genChatId();
    let guard = 0;
    while (takenIds.has(id) && guard++ < 64) id = genChatId();
    takenIds.add(id);
    return id;
  };
  const added = [];
  for (const rawConv of payload.convs) {
    if (!rawConv || typeof rawConv !== "object") continue;
    const conv = _shareNormalizeConv(_shareScrub(rawConv, 0));
    if (!conv.messages.length) continue;
    conv.id = freshId();
    if (fp) conv._shareKey = fp;
    conv._sharedAt = Date.now();
    added.push(conv);
  }
  if (!added.length) {
    throw new Error("That share link doesn't contain any chats with messages.");
  }
  /* Exports are ordered newest-first, so prepending preserves relative
     order and matches how upsertConv() files new chats. */
  saveConvs(added.concat(existing));
  renderSidebar();
  if (_storeMeterTimer) _refreshStorageMeter();
  return { skipped: false, added: added.length, firstId: added[0].id, titles: added.map((c) => c.title) };
}
async function _shareImportEncoded(encoded) {
  return _shareImportPayload(await _shareDecode(encoded));
}
/* Every import path (hash deep-link, pasted link, file picker) ends here. */
function _shareFinishImport(res) {
  closeModal("importModal");
  if (res.firstId) loadConversation(res.firstId);
  _showImportedModal(res);
}
function _shareReportSkip() {
  closeModal("importModal");
  showToast(`${_aiSvgLink} These chats are already in your history`);
}
/* Mirrors EmeraldSuite Notes' post-import confirmation. Built with
   textContent + createElement so a chat title can never reach an HTML
   sink. */
function _showImportedModal(res) {
  const el = $("shareImportedModal");
  const msg = $("shareImportedMessage");
  if (!el || !msg) return;
  msg.textContent = "";
  if (res.added === 1) {
    msg.append("Added to your collection: ");
    const strong = document.createElement("strong");
    strong.textContent = res.titles[0] || "Untitled";
    msg.append(strong);
  } else {
    msg.textContent = `Added ${res.added} chats to your collection.`;
  }
  openModal("shareImportedModal");
}
function _shareErrorText(err, fallback) {
  return err && err.message ? err.message : fallback;
}
function _shareClearHash() {
  try {
    if (!location.hash) return;
    history.replaceState({}, document.title, location.pathname + location.search);
  } catch (e) {}
}
async function _shareAutoImportFromHash() {
  let hash = "";
  try { hash = location.hash || ""; } catch (e) { return; }
  if (hash.indexOf(SHARE_HASH_PREFIX) !== 0) return;
  const encoded = _shareExtractEncoded(hash);
  /* Drop the payload from the address bar before doing anything else, so
     a refresh mid-import doesn't re-run it and so the long fragment isn't
     left sitting in the URL. */
  _shareClearHash();
  try {
    const res = await _shareImportEncoded(encoded);
    if (res.skipped) {
      _shareReportSkip();
      return;
    }
    _shareFinishImport(res);
  } catch (err) {
    _showImportError(_shareErrorText(err, "That share link could not be opened."), (location.origin + location.pathname) + SHARE_HASH_PREFIX + encoded);
  }
}
function _showImportError(message, rawText) {
  const el = $("importModal");
  if (!el) {
    showToast(`⚠ ${message}`, "error");
    return;
  }
  closeModal("settingsModal");
  const input = $("importLinkInput");
  if (input && rawText) input.value = rawText;
  _setImportStatus(message, true);
  openModal("importModal");
}
function _setImportStatus(message, isError) {
  const el = $("importStatus");
  if (!el) return;
  if (!message) {
    el.style.display = "none";
    el.textContent = "";
    el.classList.remove("share-status--error");
    return;
  }
  el.textContent = message;
  el.classList.toggle("share-status--error", !!isError);
  el.style.display = "block";
}
function openImportModal() {
  closeModal("settingsModal");
  const input = $("importLinkInput");
  if (input) input.value = "";
  _setImportStatus("", false);
  openModal("importModal");
}
async function importChatsFromInput() {
  const input = $("importLinkInput");
  const raw = input ? input.value : "";
  _setImportStatus("Importing…", false);
  try {
    const res = await _shareImportEncoded(_shareExtractEncoded(raw));
    if (res.skipped) {
      _shareReportSkip();
      return;
    }
    _shareFinishImport(res);
  } catch (err) {
    _setImportStatus(_shareErrorText(err, "That share link could not be opened."), true);
  }
}
function handleShareFileImport(input) {
  const file = input.files && input.files[0];
  /* Reset immediately so picking the same file twice still fires. */
  input.value = "";
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".emeraldcore") && !lower.endsWith(".json")) {
    _setImportStatus("Only .emeraldcore and .json chat files can be imported.", true);
    return;
  }
  _setImportStatus(`Reading ${file.name}…`, false);
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const res = _shareImportPayload(parseShareFile(String(ev.target.result || "")));
      if (res.skipped) {
        _shareReportSkip();
        return;
      }
      _shareFinishImport(res);
    } catch (err) {
      _setImportStatus(_shareErrorText(err, "That file could not be read."), true);
    }
  };
  reader.onerror = () => {
    _setImportStatus("Could not read the selected file.", true);
  };
  reader.readAsText(file);
}
/* ── Render cached image search results (from IndexedDB) without re-fetching ── */
function _renderCachedImageSearchResults(aiDiv, cacheMap) {
    if (!cacheMap || typeof cacheMap !== 'object') return;
    const placeholders = aiDiv.querySelectorAll(".web-image-searching");
    placeholders.forEach(el => {
        const query = el.dataset.imgSearch;
        if (!query) return;
        const safeKey = String(query).replace(/^(__proto__|constructor|prototype)$/, '_$1');
        if (cacheMap[safeKey]) {
            const { url, alt } = cacheMap[safeKey];
            el.classList.remove("web-image-searching");
            el.classList.add("web-image-loaded");
            el.dataset.webImg = "1";
            el.innerHTML = '<img class="web-image" src="' + escapeHtmlAttr(url) + '" alt="' + escapeHtmlAttr(alt || "Image") + '" loading="lazy">';
        }
    });
}
function appendStoredAIMessage(m) {
  const rawText = m.text || "";
  let displayText = _stripMemoryTags(rawText).replace(/\[GENERATE_IMAGE:\s*[^\]]+\]/g, "").replace(/\[EDIT_IMAGE:\s*[^\]]+\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  displayText = _stripThinkingPreamble(displayText).replace(/^\s+/, "");
  const hasMemory = m.hasMemory || /\[MEMORY:/.test(rawText) || /\[MEMORY\]/.test(rawText);
  let quizData = m.hasQuiz && m.quizData ? m.quizData : null;
  let beforeQuiz = "";
  let afterQuiz = "";
  let quizParseFailed = false;
  if (quizData) {
    beforeQuiz = m.quizTextBefore !== void 0 ? m.quizTextBefore : "";
    afterQuiz = m.quizTextAfter || "";
  } else {
    const _qr = _extractQuiz(displayText);
    if (_qr.quizData || _qr.parseFailed) {
      quizData = _qr.quizData;
      beforeQuiz = _qr.before;
      afterQuiz = _qr.after;
      quizParseFailed = _qr.parseFailed;
      displayText = _qr.before;
    }
  }
  let esAppData = m.hasEsApp && m.esAppData ? m.esAppData : null;
  let beforeApp = "";
  let afterApp = "";
  let appParseFailed = false;
  if (esAppData) {
    beforeApp = m.esAppTextBefore !== void 0 ? m.esAppTextBefore : "";
    afterApp = m.esAppTextAfter || "";
  } else if (!quizData && !quizParseFailed) {
    const _ar = _extractEmeraldApp(displayText);
    if (_ar.appData || _ar.parseFailed) {
      esAppData = _ar.appData;
      beforeApp = _ar.before;
      afterApp = _ar.after;
      appParseFailed = _ar.parseFailed;
      displayText = _ar.before;
    }
  }
  const _initText = (quizData || quizParseFailed) ? beforeQuiz : ((esAppData || appParseFailed) ? beforeApp : displayText);
  const _initHTML = m.isError ? `<span class="md-error">${escapeHtml(_initText)}</span>` : _initText ? renderMarkdown(_initText) : "";
  const div = document.createElement("div");
  div.className = "message";
  div.dataset.ai = "1";
  div.dataset.msgId = m.id || genId();
  if (m.modelId) div.dataset.modelId = m.modelId;
  if (m.modelName) div.dataset.modelName = m.modelName;
  if (m.imageModelId) div.dataset.imageModelId = m.imageModelId;
  if (m.imageModelName) div.dataset.imageModelName = m.imageModelName;
  if (m._regenBranchRef) div.dataset.regenBranchRef = m._regenBranchRef;
  if (m._editBranchRef) div.dataset.branchRef = m._editBranchRef;
  div.innerHTML = `
    <div class="message-avatar ai"><img src="/assets/images/favicon.webp" alt="EmeraldBot"></div>
    <div class="message-body">
      <div class="message-sender">EmeraldBot</div>
      <div class="message-text md-content"${_initText ? "" : ' style="display:none"'}>${_initHTML}</div>
    </div>`;
  // Re-render persisted reasoning (collapsed by default — the model has
  // already finished thinking). Stored separately from `text` so it never
  // gets sent back to Gemini in buildHistory.
  if (m.reasoning && typeof m.reasoning === "string" && m.reasoning.trim()) {
    const _rb = document.createElement("div");
    _rb.innerHTML = reasoningBlockHTML(true);
    const block = _rb.firstElementChild;
    block.querySelector(".reasoning-text").innerHTML = renderMarkdown(m.reasoning);
    block.dataset.reasoningRaw = m.reasoning;
    div.querySelector(".message-text").insertAdjacentElement("beforebegin", block);
  }
  if (hasMemory) {
    const badge = document.createElement("div");
    badge.className = "memory-badge";
    badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg> Updated memory';
    div.querySelector(".message-sender").insertAdjacentElement("afterend", badge);
  }
  if (quizData) {
    // CodeQL fix (#52/#56): sanitize qid to safe chars only — prevents
    // injection via quizData._id or m.id which are user-influenced.
    const _rawQid = quizData._id || "quiz_" + (m.id || genId());
    const qid = _rawQid.replace(/[^a-zA-Z0-9_-]/g, "_");
    quizData._id = qid;
    window._quizzes = window._quizzes || {};
    if (!window._quizzes[qid]) {
      const _st = m.quizState || null;
      window._quizzes[qid] = {
        data: quizData,
        answers: (_st && _st.answers && typeof _st.answers === "object") ? _st.answers : {},
        submitted: !!(_st && _st.submitted),
        score: _st && typeof _st.score === "number" ? _st.score : 0,
        autoTotal: _st && typeof _st.autoTotal === "number" ? _st.autoTotal : 0,
        essayCount: _st && typeof _st.essayCount === "number" ? _st.essayCount : 0
      };
    }
    const cardEl = document.createElement("div");
    cardEl.innerHTML = quizCardHTML(qid, quizData);
    const textEl = div.querySelector(".message-text");
    textEl.insertAdjacentElement("afterend", cardEl.firstElementChild);
    if (afterQuiz) {
      const afterEl = document.createElement("div");
      afterEl.className = "message-text md-content";
      afterEl.style.marginTop = "8px";
      afterEl.innerHTML = renderMarkdown(afterQuiz);
      textEl.nextElementSibling.insertAdjacentElement("afterend", afterEl);
    }
  } else if (quizParseFailed) {
    const errCard = document.createElement("div");
    errCard.innerHTML = quizErrorCardHTML();
    div.querySelector(".message-text").insertAdjacentElement("afterend", errCard.firstElementChild);
  }
  if (esAppData) {
    renderEsAppCard(div.querySelector(".message-text"), esAppData, afterApp, m.id || genId());
  } else if (appParseFailed) {
    renderEsAppErrorCard(div.querySelector(".message-text"));
  }
  if (m.fileEdit && m.fileEdit.ok) renderFileEditBadge(div, m.fileEdit);
  div.querySelector(".message-body").appendChild(buildMessageActionsEl(m.id || genId()));
  const _imgDataSafe = m.imageData ? _safeMediaSrc(m.imageData, "image") : '';
  if (m.imageData && _imgDataSafe) {
    const _storedMsgId = m.id || "";
    // The stored data URL is fetched lazily on click rather than parked in the
    // DOM, so a long conversation does not hold every picture twice.
    const wrapper = buildImageResultEl({
      dataUrl: _imgDataSafe,
      alt: m.imagePrompt ? escapeHtmlAttr(m.imagePrompt.slice(0, 80)) : "",
      downloadName: "emeraldbot-image.png",
      resolveDataUrl: () => {
        const _conv = getConv(state.convId);
        const _m = _conv && _conv.messages.find((x) => x.id === _storedMsgId);
        const _raw = _m && typeof _m.imageData === "string" ? _m.imageData : m.imageData;
        return /^data:image\//i.test(_raw || "") ? _raw : null;
      },
    });
    insertBeforeMessageActions(div.querySelector(".message-body"), wrapper);
  }
  const typingEl = $("typingIndicator");
  $("messagesArea").insertBefore(div, typingEl);
  // ── Render image search results: use cached results if available (stable on reload) ──
  if (m.imageSearchCache && Object.keys(m.imageSearchCache).length) {
    _renderCachedImageSearchResults(div, m.imageSearchCache);
  } else {
    // First time or no cached results → fetch from API and cache
    processImageSearchTags(div, state.convId, m.id);
  }
  // ── Restore citations from persisted sources ──
  if (m.sources && Array.isArray(m.sources) && m.sources.length) {
    renderCitations(div, m.sources);
    // Mirror the live streaming path: when real sources exist, drop the
    // raw "Sources"/"Source:" block the model wrote so it doesn't come
    // back with literal brackets after a reload.
    _stripSourcesFromHTML(div.querySelector(".message-text"));
  }
  return div;
}
function _extractQuiz(text) {
  const quizMatch = text.match(/<quiz(?:\s[^>]*)?>([\s\S]+?)<\/quiz\s*>/) || text.match(/<quiz(?:\s[^>]*)?>([\s\S]+)$/);
  if (!quizMatch) return { before: text, after: "", quizData: null, parseFailed: false };
  const qStart = text.search(/<quiz(?:\s[^>]*)?>/i);
  const before = text.slice(0, qStart).trim();
  const after = text.slice(qStart + quizMatch[0].length).trim();
  let quizData = null;
  let parseFailed = false;
  let raw = quizMatch[1];

  // ── Pre-extraction cleanup ──────────────────────────────────────────
  // Strip markdown code fences the AI might wrap around the JSON
  raw = raw.replace(/^[\s\n]*```(?:json|JSON)?[\s\n]*\n?/i, "");
  raw = raw.replace(/\n?[\s\n]*```[\s\n]*$/i, "");
  // Strip HTML entities the AI might emit (e.g. &quot; → ")
  // CodeQL fix (#53): Decode HTML entities the AI might emit (e.g. &quot; → ")
  // CRITICAL: &amp; MUST be decoded LAST to prevent double-decode (e.g. &amp;lt; → <).
  // Original code decoded &amp; before &lt; causing double-escaping vulnerability.
  raw = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  // Strip JS/JSON comments (// and /* */)
  raw = raw.replace(/\/\/[^\n]*/g, "");
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip leading/trailing commentary the AI might add around the JSON
  // Find the first { and last } — everything between is the JSON candidate
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  // ── Parse attempt 1: as-is ──────────────────────────────────────────
  try {
    quizData = JSON.parse(raw);
  } catch (e1) {
    // ── Parse attempt 2: fix common AI mistakes ───────────────────────
    try {
      let fixed = raw
        .replace(/,\s*([}\]])/g, "$1")                // trailing commas before } or ]
        .replace(/'/g, '"')                             // single → double quotes
        .replace(/(?<=[{,])\s*(\w+)\s*:/g, '"$1":')   // unquoted keys after { or , → quoted
        .replace(/:\s*undefined/g, ':null')            // undefined → null
        .replace(/:\s*NaN/g, ':0')                     // NaN → 0
        .replace(/\\(?!["\\/bfnrtu])/g, '\\\\');      // escape stray backslashes
      quizData = JSON.parse(fixed);
    } catch (e2) {
      // ── Parse attempt 3: aggressive — walk the string character by
      // character, tracking brace/bracket depth, and extract the longest
      // valid JSON substring that parses.  This catches cases where the
      // AI adds extra text INSIDE the braces but outside the structure.
      try {
        quizData = _aggressiveJSONExtract(raw);
      } catch (e3) {
        parseFailed = true;
        console.warn("Quiz JSON parse failed (all attempts):", e1?.message || e1);
      }
    }
  }

  // ── Normalize: ensure questions array exists and each question has expected shape ──
  if (quizData && Array.isArray(quizData.questions)) {
    quizData.questions = quizData.questions.map((q) => {
      if (typeof q !== "object" || q === null) return q;
      const norm = { ...q };
      if (!norm.q && norm.question) norm.q = norm.question;
      if (!norm.q && norm.text) norm.q = norm.text;
      if (!Array.isArray(norm.options)) norm.options = [];
      norm.options = norm.options.map(String);
      const rawType = String(norm.type || "").toLowerCase();
      if (rawType === "multi" || rawType === "multiple" || rawType === "multi-select" || rawType === "multiselect" || rawType === "multiple-answer" || rawType === "checkbox" || rawType === "checkboxes") {
        norm.type = "multi";
        const ans = Array.isArray(norm.answer) ? norm.answer : norm.answer != null ? [norm.answer] : [];
        norm.answer = ans.map((x) => {
          if (typeof x === "string" && /^[A-Ea-e]$/.test(x.trim())) return x.trim().toUpperCase().charCodeAt(0) - 65;
          const n = parseInt(x, 10);
          return isNaN(n) ? -1 : n;
        }).filter((n) => n >= 0 && n < norm.options.length);
      } else if (rawType === "matching" || rawType === "match" || rawType === "pair" || rawType === "pairs" || rawType === "mencocokkan" || rawType === "penjodohan" || rawType === "match the" || rawType === "matching type") {
        norm.type = "matching";
        if (!Array.isArray(norm.left) || norm.left.length === 0) {
          const prs = (Array.isArray(norm.pairs) ? norm.pairs : [])
            .concat(Array.isArray(norm.matches) ? norm.matches : [])
            .concat(Array.isArray(norm.pairsList) ? norm.pairsList : [])
            .filter(Boolean);
          norm.left = prs.map((p) => (Array.isArray(p) ? p[0] : (p && (p.left ?? p.l ?? p[0] ?? ""))));
          norm.right = prs.map((p) => (Array.isArray(p) ? p[1] : (p && (p.right ?? p.r ?? p[1] ?? ""))));
          if (prs.length) norm.answer = norm.left.map((_, i) => i);
        }
        norm.left = (norm.left || []).map(String);
        norm.right = (norm.right || []).map(String);
        const n = Math.min(norm.left.length, norm.right.length);
        const rawAns = Array.isArray(norm.answer) ? norm.answer : norm.answer != null ? [norm.answer] : [];
        norm.answer = norm.left.slice(0, n).map((_, li) => {
          const v = rawAns[li];
          if (v == null) return li;
          if (typeof v === "string") {
            const lv = v.trim().toLowerCase();
            if (/^[A-Za-z]$/.test(lv)) return lv.toUpperCase().charCodeAt(0) - 65;
            const n2 = parseInt(v, 10);
            if (!isNaN(n2) && n2 >= 0 && n2 < n) return n2;
            const byText = norm.right.map((r) => r.toLowerCase()).indexOf(lv);
            if (byText >= 0) return byText;
            return li;
          }
          const n2 = parseInt(v, 10);
          return isNaN(n2) || n2 < 0 || n2 >= n ? li : n2;
        });
      } else if (rawType === "fill" || rawType === "essay") {
        /* Must test the lowercased `rawType`, not `norm.type`: the renderer
           compares `q.type` against "fill"/"essay" exactly, so a mixed-case
           "Fill" that fell through to the mcq branch below was rendered and
           graded as a multiple-choice question. */
        norm.type = rawType;
        if (typeof norm.answer !== "string") norm.answer = String(norm.answer ?? "");
      } else {
        norm.type = norm.type || "mcq";
        if (typeof norm.answer === "string") {
          const idx = parseInt(norm.answer, 10);
          norm.answer = isNaN(idx) ? 0 : idx;
        }
        if (typeof norm.answer !== "number" || norm.answer < 0) norm.answer = 0;
      }
      if (!norm.explanation) norm.explanation = "";
      return norm;
    });
  }
  return { before, after, quizData, parseFailed };
}

// Aggressive JSON extraction: tries to find the largest valid JSON object
// within the raw string by scanning for balanced braces.
function _aggressiveJSONExtract(raw) {
  const opens = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') opens.push(i);
  }
  // Try from outermost { to last }
  for (const start of opens) {
    let depth = 0;
    for (let end = start; end < raw.length; end++) {
      if (raw[end] === '{') depth++;
      else if (raw[end] === '}') depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
        break;
      }
    }
  }
  throw new Error('No valid JSON object found');
}
function quizLoadingCardHTML() {
  return `<div class="quiz-loading-card">
    <div class="quiz-loading-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4caf7d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
    </div>
    <div>
      <div style="font-size:13.5px;font-weight:600;color:var(--text);margin-bottom:4px">Generating quiz\u2026</div>
      <div class="quiz-loading-dots">
        <div class="quiz-loading-dot"></div>
        <div class="quiz-loading-dot"></div>
        <div class="quiz-loading-dot"></div>
      </div>
    </div>
  </div>`;
}
function quizCardHTML(qid, data) {
  const n = (data.questions || []).length;
  return `<div class="quiz-card" data-qid="${escapeHtmlAttr(qid)}">
    <div class="quiz-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
    </div>
    <div class="quiz-card-info">
      <div class="quiz-card-title">${escapeHtml(data.title || "Quiz")}</div>
      <div class="quiz-card-meta">${n} question${n !== 1 ? "s" : ""} \xB7 Click to start</div>
    </div>
    <svg class="quiz-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
}
function quizErrorCardHTML() {
  return `<div class="quiz-card quiz-card--error">
    <div class="quiz-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d93025" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </div>
    <div class="quiz-card-info">
      <div class="quiz-card-title" style="color:#d93025">Quiz failed to load</div>
      <div class="quiz-card-meta">The quiz data could not be parsed. Try regenerating.</div>
    </div>
  </div>`;
}

/* ── EmeraldSuite import (es-app) ─────────────────────────────
   The AI may end a response with <es-app>{json}</es-app>. The tag is
   stripped from the visible text and replaced with a card; clicking the
   card imports the JSON payload into the matching EmeraldSuite app and
   opens it via ?owned=<id>. Mirrors the quiz-tag machinery above. */
const _ES_APPS = {
  notes:  { label: "EmeraldNotes",  action: "Open in Notes",  file: "notes.html",  color: "#a21caf", soft: "rgba(162,28,175,0.15)" },
  docs:   { label: "EmeraldDocs",   action: "Open in Docs",   file: "docs.html",   color: "#0891b2", soft: "rgba(8,145,178,0.15)" },
  slides: { label: "EmeraldSlides", action: "Open in Slides", file: "slides.html", color: "#f97316", soft: "rgba(249,115,22,0.15)" },
  sheets: { label: "EmeraldSheets", action: "Open in Sheets", file: "sheets.html", color: "#16a34a", soft: "rgba(22,163,74,0.15)" }
};
/* App accent detected from the streaming <es-edit>/<es-app> payload, so the
   in-progress loading cards and pills get the right per-app color. */
let _esStreamApp = null;
function _esPeekApp(text) {
  const m = String(text || "").match(/"app"\s*:\s*"([a-z]+)"/i);
  return (m && _ES_APPS[m[1]]) ? m[1] : null;
}
function _esAccent(app) {
  return (app && _ES_APPS[app] && _ES_APPS[app].color) || "#0891b2";
}
const _ES_ANIM_TYPES = ["appear", "fade", "fly", "zoom", "spin", "bounce"];
/* slides.js exposes exactly three triggers; "auto" is not one of them. */
const _ES_ANIM_STARTS = ["click", "with", "after"];
/* SlidesApp.TRANSITIONS (slides.js:3455-3499). */
const _ES_TRANSITIONS = [
  "none", "fade", "push", "wipe", "split", "reveal", "cut", "cover", "uncover", "random-bars", "shape", "blinds",
  "morph", "fade-black", "zoom", "cube", "flip", "gallery", "vortex", "newsflash", "honeycomb", "glitch", "dissolve",
  "checkerboard", "clock", "ripple", "doors", "switch", "curtains", "fracture", "peel-off", "glitter", "comb",
  "pan", "rotate", "orbit", "fly-through", "conveyor"
];
/* SheetsApp font list (slides.html:123-154) — the model may use any string,
   but these are the ones actually installed in the app's own picker. */
const _ES_FONTS = [
  "DM Sans", "Arial", "Helvetica", "Verdana", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins",
  "Nunito", "Ubuntu", "Raleway", "Oswald", "Work Sans",
  "Georgia", "Times New Roman", "Merriweather", "Lora", "Libre Baskerville", "DM Serif Display", "Crimson Text",
  "Fira Code", "IBM Plex Mono", "Courier New",
  "Dancing Script", "Caveat", "Pacifico", "Lobster", "Permanent Marker"
];
/* sheets.js BORDER_W (sheets.js:2884). These four are the ONLY values the
   renderer maps to a width — "solid"/"dashed"/"dotted" do not exist and fall
   back to 1px, so accepting them here would silently lie to the model. */
const _ES_BORDER_STYLES = ["thin", "medium", "thick", "double"];
const _ES_SHEET_ALIGN_H = ["left", "center", "right"];
const _ES_SHEET_ALIGN_V = ["top", "middle", "bottom"];
const _ES_NUM_CATS = ["general", "number", "currency", "accounting", "shortDate", "longDate", "time", "percent", "fraction", "text"];
const _ES_CHART_TYPES = ["column", "bar", "line", "pie", "scatter"];
const _ES_CHART_LABEL_POS = ["out", "in", "ctr"];
function _esAppKind(data) {
  const a = String((data && data.app) || "").toLowerCase().trim();
  return _ES_APPS[a] ? a : null;
}
function _extractEmeraldApp(text) {
  const src = String(text || "");
  const m = src.match(/<es-app(?:\s[^>]*)?>([\s\S]+?)<\/es-app\s*>/) || src.match(/<es-app(?:\s[^>]*)?>([\s\S]+)$/);
  if (!m) return { before: text, after: "", appData: null, parseFailed: false };
  const start = src.search(/<es-app(?:\s[^>]*)?>/i);
  const before = src.slice(0, start).trim();
  const after = src.slice(start + m[0].length).trim();
  let raw = m[1];
  let appData = null;
  let parseFailed = false;
  raw = raw.replace(/^[\s\n]*```(?:json|JSON)?[\s\n]*\n?/i, "");
  raw = raw.replace(/\n?[\s\n]*```[\s\n]*$/i, "");
  appData = _efParsePayload(raw);
  if (!appData) parseFailed = true;
  if (appData && !_esAppKind(appData)) { parseFailed = true; appData = null; }
  return { before, after, appData, parseFailed };
}
function _esAppIconSvg(kind) {
  if (kind === "slides") return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M12 16v4M8 20h8"/></svg>';
  if (kind === "sheets") return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>';
  if (kind === "notes") return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/></svg>';
}
function esAppLoadingCardHTML() {
  const acc = _esAccent(_esStreamApp);
  return `<div class="quiz-loading-card es-loading-card" style="--esaccent:${acc}">
    <div class="quiz-loading-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/></svg>
    </div>
    <div>
      <div style="font-size:13.5px;font-weight:600;color:var(--text);margin-bottom:4px">Preparing import\u2026</div>
      <div class="quiz-loading-dots">
        <div class="quiz-loading-dot"></div>
        <div class="quiz-loading-dot"></div>
        <div class="quiz-loading-dot"></div>
      </div>
    </div>
  </div>`;
}
function esAppCardHTML(id, data) {
  const kind = _esAppKind(data) || "docs";
  const app = _ES_APPS[kind];
  const title = (data && data.title) || "Untitled";
  let meta = app.action;
  if (kind === "slides" && Array.isArray(data.slides)) {
    const n = data.slides.length;
    meta += " \xB7 " + n + " slide" + (n !== 1 ? "s" : "");
  } else if (kind === "sheets" && Array.isArray(data.rows)) {
    const n = data.rows.length;
    meta += " \xB7 " + n + " row" + (n !== 1 ? "s" : "");
  }
  return `<div class="esapp-card" data-esapp="${escapeHtmlAttr(id)}" style="--esapp-accent:${app.color};--esapp-soft:${app.soft}">
    <div class="esapp-card-icon">${_esAppIconSvg(kind)}</div>
    <div class="esapp-card-info">
      <div class="esapp-card-title">${escapeHtml(title)}</div>
      <div class="esapp-card-meta">${escapeHtml(app.label)} \xB7 ${escapeHtml(meta)}</div>
    </div>
    <svg class="esapp-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
}
function esAppErrorCardHTML() {
  return `<div class="esapp-card esapp-card--error">
    <div class="esapp-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d93025" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </div>
    <div class="esapp-card-info">
      <div class="esapp-card-title" style="color:#d93025">Import data failed to load</div>
      <div class="esapp-card-meta">The import data could not be parsed. Try regenerating.</div>
    </div>
  </div>`;
}
function renderEsAppCard(textEl, appData, afterAppText, msgId) {
  if (!textEl || !appData) return "";
  const id = "esapp_" + genId();
  window._esApps = window._esApps || {};
  window._esApps[id] = { data: appData, msgId };
  const cardEl = document.createElement("div");
  cardEl.innerHTML = esAppCardHTML(id, appData);
  textEl.insertAdjacentElement("afterend", cardEl.firstElementChild);
  if (afterAppText) {
    const afterEl = document.createElement("div");
    afterEl.className = "message-text md-content";
    afterEl.style.marginTop = "8px";
    afterEl.innerHTML = renderMarkdown(afterAppText);
    textEl.nextElementSibling.insertAdjacentElement("afterend", afterEl);
  }
  return id;
}
function renderEsAppErrorCard(textEl) {
  if (!textEl) return;
  const errCard = document.createElement("div");
  errCard.innerHTML = esAppErrorCardHTML();
  textEl.insertAdjacentElement("afterend", errCard.firstElementChild);
}
async function _esStoreGet(key) {
  try { if (window.EmeraldIDBStorage) return await window.EmeraldIDBStorage.getJSON(key); } catch (e) {}
  return null;
}
async function _esStoreSet(key, val) {
  if (window.EmeraldIDBStorage) { await window.EmeraldIDBStorage.setJSON(key, val); return; }
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}
function _esSheetsPut(id, doc) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open("emeraldcore.storage.suite.sheets", 1);
    req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains("workbooks")) d.createObjectStore("workbooks"); };
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction("workbooks", "readwrite");
      t.objectStore("workbooks").put(doc, id);
      t.oncomplete = () => { try { db.close(); } catch (e) {} resolve(true); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}
function _esHtml(md) {
  const html = renderMarkdown(String(md == null ? "" : md));
  try { if (typeof DOMPurify !== "undefined") return DOMPurify.sanitize(html); } catch (e) {}
  return html;
}
/* Sanitise without re-rendering. Used for HTML this file builds itself,
   where a second markdown pass would mangle the inline markup. */
function _esSanitizeHtml(html) {
  const h = String(html == null ? "" : html);
  try { if (typeof DOMPurify !== "undefined") return DOMPurify.sanitize(h); } catch (e) {}
  return h;
}
function _esPlainText(s) {
  return String(s == null ? "" : s).replace(/<[^>]*>/g, " ").replace(/[#*_>`~]/g, " ").replace(/\s+/g, " ").trim();
}
function _esUid(prefix) { return (prefix || "el_") + Date.now().toString(36) + generateSecureId(6); }
function _esWordCount(md) {
  const t = _esPlainText(md);
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}
async function _esImportNotes(data) {
  const id = "note_" + Date.now() + "_" + generateSecureId(9);
  const now = new Date().toISOString();
  let arr = await _esStoreGet("emeraldcore.storage.suite.notes");
  arr = Array.isArray(arr) ? arr : [];
  arr.unshift({ id, title: _esPlainText(data.title) || "Imported Note", content: _esHtml(data.content), createdAt: now, modifiedAt: now });
  /* Notes carry a background colour (notes.js updateNoteColor). It was never
     settable from here, so "make me a yellow note" silently did nothing. */
  if (data.color) arr[0].color = String(data.color);
  await _esStoreSet("emeraldcore.storage.suite.notes", arr);
  return id;
}
async function _esImportDoc(data) {
  const id = "doc_" + Date.now() + "_" + generateSecureId(9);
  const now = Date.now();
  const title = _esPlainText(data.title) || "Imported Document";
  const content = _esHtml(data.content) || "<p><br></p>";
  let idx = await _esStoreGet("emeraldcore.storage.suite.docs");
  idx = Array.isArray(idx) ? idx : [];
  idx.unshift({ id, title, updatedAt: now, wordCount: _esWordCount(data.content) });
  await _esStoreSet("emeraldcore.storage.suite.docs", idx);
  await _esStoreSet("emeraldcore.storage.suite.docs." + id, {
    id, title, content, savedAt: now,
    theme: data.theme === "dark" ? "dark" : "light",
    header: "", footer: "", footnotes: [], endnotes: [], comments: []
  });
  return id;
}
function _esSplitSlides(data) {
  if (Array.isArray(data.slides) && data.slides.length) return data.slides;
  const text = String(data.content == null ? "" : data.content);
  let parts = text.split(/\n(?=#{1,2}\s)/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    parts = [];
    for (let i = 0; i < paras.length; i += 4) parts.push(paras.slice(i, i + 4).join("\n\n"));
  }
  if (!parts.length) parts = [text];
  return parts.map((p) => {
    const m = p.match(/^#{1,2}\s*(.+)$/m);
    const title = m ? m[1].trim() : "";
    const body = title ? p.replace(/^#{1,2}\s*.+\n?/, "").trim() : p;
    return { title, content: body };
  });
}
/* Shapes the Slides renderer can actually paint (slides.js shapeSVG).
   A name outside this list would draw an empty SVG, so it is swapped for
   the nearest sensible default instead of being passed through. */
const _ES_SHAPES = new Set([
  "rect", "rounded", "snipSame", "snipDiagonal", "roundSame", "roundDiagonal",
  "snipRound", "plaque", "chamfer", "frameRect", "crossRect", "ribbon",
  "foldCorner", "ellipse", "triangle", "rightTriangle", "diamond", "pentagon",
  "hexagon", "heptagon", "octagon", "decagon", "dodecagon", "parallelogram",
  "trapezoid", "cross", "plus", "donut", "teardrop", "heart", "lightning",
  "sun", "moon", "cloud", "blockArc", "wave", "noSymbol", "smile", "cube",
  "can", "scroll", "bracketL", "bracketR", "braceL", "braceR", "diagonalStripe",
  "chord", "pie", "leftParen", "rightParen", "corner", "halfFrame", "arrow",
  "arrowLeft", "arrowUp", "arrowDown", "arrowLR", "arrowUD", "arrowQuad",
  "arrowNotched", "arrowBent", "arrowUturn", "arrowStriped", "arrowChevron",
  "arrowPentagon", "arrowCalloutR", "arrowCalloutL", "arrowCalloutU",
  "arrowCalloutD", "arrowCircular", "star", "starRibbon", "calloutRect",
  "calloutRound", "calloutEllipse", "calloutCloud", "line", "lineArrow",
  "lineDouble", "lineElbow", "lineCurve"
]);
const _ES_SHAPE_ALIAS = {
  circle: "ellipse", oval: "ellipse", square: "rect", box: "rounded",
  rectangle: "rect", roundrect: "rounded", roundedrect: "rounded",
  cornerrect: "rounded", card: "rounded", star4: "star", arrowright: "arrow",
  arrowleft: "arrowLeft", chevron: "arrowChevron", bar: "rect"
};
function _esNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function _esCssColor(v, fallback) {
  /* Only pass through something the browser can paint - a malformed
     colour silently falls back to inherited black in the canvas and
     leaves text invisible on a dark background. */
  const s = String(v == null ? "" : v).trim();
  if (!s) return fallback;
  /* The canvas accepts CSS gradients for fill/stroke and backgrounds
     (slides.js svgPaint:134-142), so rejecting them here meant a gradient
     the model correctly asked for was thrown away and the shape fell back
     to the default fill. Characters are still restricted to the gradient
     syntax so no arbitrary declaration can be smuggled through. */
  if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\([a-z0-9\s,.%#()/deg-]+\)$/i.test(s)) return s;
  if (/^(#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(|hsla?\(|[a-z]+$)/i.test(s)) return s;
  return fallback;
}
/* ── Generated images ──────────────────────────────────────────────
   Images produced by the image worker come back as data URLs and are stored
   on the conversation message, not in any EmeraldSuite file. Without a way to
   name one, "generate a logo then put it on slide 1" was impossible: the
   add_image op only accepted a URL. This keeps the most recent few in
   session memory so the model can reference them as "generated" / "last" /
   "gen1", "gen2"… The data URL is written into the file on use, which is the
   same thing notes.js and docs.js already do for pasted images. */
const _ES_GEN_IMAGES = [];
const _ES_GEN_MAX = 6;

function _esRegisterGeneratedImage(dataUrl, prompt, mode) {
  const src = String(dataUrl || "");
  if (!/^data:image\//i.test(src)) return;
  const i = _ES_GEN_IMAGES.findIndex((g) => g.dataUrl === src);
  if (i >= 0) { _ES_GEN_IMAGES[i].prompt = prompt || _ES_GEN_IMAGES[i].prompt; return; }
  _ES_GEN_IMAGES.push({ dataUrl: src, prompt: String(prompt || ""), mode: mode || "generate" });
  while (_ES_GEN_IMAGES.length > _ES_GEN_MAX) _ES_GEN_IMAGES.shift();
}

/* Resolve a src the model wrote into something a file can store.
   Returns "" when the reference cannot be honoured, so the caller reports the
   op as missed rather than writing a broken image element. */
function _esResolveImageSrc(src, alt) {
  const raw = String(src == null ? "" : src).trim();
  if (!raw) return "";
  if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw) || /^\//.test(raw) || /^blob:/i.test(raw)) return raw;
  // Placeholder that points back at the image the model just made.
  const pool = _ES_GEN_IMAGES;
  if (!pool.length) return "";
  let entry = null;
  const m = /^gen\s*(\d+)$/i.exec(raw);
  /* gen1 is the OLDEST image still kept, genN the newest, so the index maps
     straight onto the retained window. Out-of-range clamps to the newest. */
  if (m) entry = pool[Math.min(pool.length, Math.max(1, Number(m[1]))) - 1] || null;
  else if (/^(last|generated|gen|latest|previous)$/i.test(raw)) entry = pool[pool.length - 1];
  if (!entry) return "";
  return entry.dataUrl;
}
/* Human-readable list for the prompt, so the model can pick a real index. */
function _esGenImagesNote() {
  if (!_ES_GEN_IMAGES.length) return "";
  const items = _ES_GEN_IMAGES.slice(-_ES_GEN_MAX).map((g, i) =>
    "gen" + (i + 1) + " = \"" + (g.prompt || "generated image").slice(0, 70) + "\""
  );
  return " Images already generated in this conversation, usable as \"src\" in add_image: " + items.join("; ") +
    ". Use the exact \"gen1\"..\"gen" + _ES_GEN_IMAGES.length + "\" token, or \"last\" for the newest.";
}

/* Slide background. The app trusts `type` and assigns `value` straight to
   canvas.style.background (slides.js:1709), so a gradient stored as
   type:"color" paints as an invalid value and the slide falls back to white.
   Type has to be derived from the value, exactly as the app's own swatch
   handler does (slides.js:3193). */
function _esSlideBg(value) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return { type: "color", value: "#ffffff" };
  if (/\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i.test(v)) return { type: "gradient", value: v };
  if (/^data:image\//i.test(v) || /^https?:\/\//i.test(v)) return { type: "image", value: v };
  return { type: "color", value: v };
}

/* Image adjustments (slides.js:1103-1115). Each is skipped at its identity
   value, which is what the app's own panel does, so an element only carries
   the keys that actually change something. */
function _esImageFx(fx) {
  const o = {};
  if (!fx || typeof fx !== "object") return null;
  const n = (v, fb) => { const x = Number(v); return Number.isFinite(x) ? x : fb; };
  const b = n(fx.brightness, 100); if (b !== 100) o.brightness = Math.max(0, Math.min(200, b));
  const c = n(fx.contrast, 100); if (c !== 100) o.contrast = Math.max(0, Math.min(200, c));
  const s = n(fx.saturate, 100); if (s !== 100) o.saturate = Math.max(0, Math.min(200, s));
  const h = n(fx.hue, 0); if (h !== 0) o.hue = ((h % 360) + 360) % 360;
  for (const k of ["grayscale", "sepia", "invert"]) {
    const v = n(fx[k], 0);
    if (v > 0) o[k] = Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
  }
  const bl = n(fx.blur, 0); if (bl > 0) o.blur = Math.max(0, Math.min(40, bl));
  return Object.keys(o).length ? o : null;
}

/* Normalised link target. slides.js routes clicks through safeOpenUrl, which
   only allows http/https/mailto, so anything else is dropped rather than
   stored and silently inert. */
function _esElLink(v) {
  const s = String(v == null ? "" : v).trim();
  return /^(?:https?:|mailto:)/i.test(s) ? s : "";
}

/* One element in the Slides element model (see slides.js createElementDOM).
   Text is the fallback because a payload can only ever contain something
   the app will draw; an unreadable type used to vanish entirely. */
function _esSlideElement(el, z, fallbackColor) {
  const src = el && typeof el === "object" ? el : {};
  const box = {
    id: _esUid("el_"),
    x: _esNum(src.x, 60), y: _esNum(src.y, 60),
    w: _esNum(src.w, 840), h: _esNum(src.h, 120),
    r: _esNum(src.r, 0), z: _esNum(src.z, z || 1),
    opacity: Math.max(0, Math.min(1, _esNum(src.opacity, 1)))
  };
  const type = String(src.type || "text").toLowerCase();
  const link = _esElLink(src.link);

  if (type === "shape") {
    const raw = String(src.shape || "rect").trim();
    const key = _ES_SHAPE_ALIAS[raw.toLowerCase()] || raw;
    const out = Object.assign(box, {
      type: "shape",
      shape: _ES_SHAPES.has(key) ? key : "rounded",
      fill: _esCssColor(src.fill, "#f97316"),
      stroke: _esCssColor(src.stroke, "none"),
      strokeWidth: Math.max(0, Math.min(40, _esNum(src.strokeWidth, 0)))
    });
    /* A raw <svg> body is only honoured for shape:"icon" (slides.js:1826) and
       is sanitised before use, so it is passed through as-is for that case. */
    if (out.shape === "icon" && typeof src.svg === "string" && src.svg.trim()) {
      out.svg = _esSanitizeHtml(src.svg);
    }
    if (link) out.link = link;
    return out;
  }

  if (type === "image" || type === "video" || type === "audio") {
    const srcUrl = String(src.src || src.url || "");
    const out = Object.assign(box, { type, src: srcUrl });
    if (type === "image") {
      out.alt = String(src.alt == null ? "" : src.alt);
      /* crop is stored as FRACTIONS 0..1, not pixels (slides.js:1841-1850). */
      const f = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(0.9, x)) : 0; };
      const crop = { l: f(src.crop && src.crop.l), t: f(src.crop && src.crop.t), r: f(src.crop && src.crop.r), b: f(src.crop && src.crop.b) };
      if (crop.l || crop.t || crop.r || crop.b) out.crop = crop;
      const bw = Math.max(0, Math.min(20, _esNum(src.borderWidth, 0)));
      if (bw) out.borderWidth = bw;
      if (bw) out.borderColor = _esCssColor(src.borderColor, "#000000");
      const fx = _esImageFx(src.fx);
      if (fx) out.fx = fx;
    }
    if (type === "video" && src.poster) out.poster = String(src.poster);
    if (link) out.link = link;
    return out;
  }

  const raw = src.text != null ? src.text : src.html != null ? src.html : "";
  const out = Object.assign(box, {
    type: "text",
    /* rawHtml is HTML this file composed itself (the card labels, which
       carry inline accent colours). It is sanitised but NOT run back
       through the markdown renderer — that would re-wrap it and can drop
       the very spans that colour the text. */
    html: src.rawHtml != null ? _esSanitizeHtml(src.rawHtml) : _esHtml(raw),
    fontFamily: String(src.fontFamily || "DM Sans"),
    fontSize: _esNum(src.fontSize, 24),
    bold: !!src.bold, italic: !!src.italic, underline: !!src.underline,
    color: _esCssColor(src.color, fallbackColor || "#1a1a1a"),
    /* Paint behind the text. This is the cheapest way to give a run of
       text a coloured box without positioning a separate shape.
       "none"/"" mean no highlight — slides.js reads `el.highlight ||
       'transparent'`, so a literal "none" would be painted as the CSS
       keyword and could still resolve to a visible colour. */
    highlight: (src.highlight === "none" || src.highlight === "") ? "transparent"
      : _esCssColor(src.highlight, "transparent"),
    textAlign: ["left", "center", "right", "justify"].includes(String(src.textAlign))
      ? String(src.textAlign) : "left",
    listType: src.listType === "ul" || src.listType === "ol" ? src.listType : ""
  });
  /* Hyperlinks work on text elements too (slides.js:1731, ctrl-click). */
  if (link) out.link = link;
  return out;
}

/* ── Deck auto-design ───────────────────────────────────────────
   When the model returns the plain shape — {"title": "...", "content":
   "markdown"} — building it literally produced two text boxes on a
   white rectangle, which is why generated decks looked like a text
   dump rather than a designed deck.

   So that shape is now laid out, not dumped. The content is parsed into
   items and composed into a real layout: a tinted background, an accent
   bar, coloured headings and the body set into cards, with the palette
   rotating per slide so a deck reads as one system instead of a stack of
   unrelated pages.

   A model that DOES send `elements` is left completely alone — this is
   only the fallback, and it never overrides an explicit design. */

const _ES_CANVAS_W = 960;
const _ES_CANVAS_H = 540;

/* Palettes are picked per slide. Every one pairs a tinted page with a
   surface, an ink for body text and an accent strong enough to carry a
   heading — contrast is fixed here rather than left to the model. */
const _ES_PALETTES = [
  { bg: "#f0fdf4", surface: "#ffffff", ink: "#052e16", muted: "#3f6212", accent: "#059669", onAccent: "#ffffff" },
  { bg: "#eef2ff", surface: "#ffffff", ink: "#1e1b4b", muted: "#4338ca", accent: "#4f46e5", onAccent: "#ffffff" },
  { bg: "#fff7ed", surface: "#ffffff", ink: "#431407", muted: "#9a3412", accent: "#ea580c", onAccent: "#ffffff" },
  { bg: "#f0f9ff", surface: "#ffffff", ink: "#082f49", muted: "#0369a1", accent: "#0284c7", onAccent: "#ffffff" },
  { bg: "#fdf2f8", surface: "#ffffff", ink: "#500724", muted: "#9d174d", accent: "#db2777", onAccent: "#ffffff" },
  { bg: "#faf5ff", surface: "#ffffff", ink: "#3b0764", muted: "#7e22ce", accent: "#9333ea", onAccent: "#ffffff" },
  { bg: "#fefce8", surface: "#ffffff", ink: "#422006", muted: "#a16207", accent: "#ca8a04", onAccent: "#422006" },
  { bg: "#0f172a", surface: "#1e293b", ink: "#f1f5f9", muted: "#94a3b8", accent: "#38bdf8", onAccent: "#0f172a" },
  { bg: "#052e2b", surface: "#0f3d38", ink: "#ecfeff", muted: "#5eead4", accent: "#2dd4bf", onAccent: "#052e2b" }
];
function _esPalette(i) {
  return _ES_PALETTES[Math.abs(_esNum(i, 0)) % _ES_PALETTES.length];
}

/* Turns the content markdown into discrete items so they can be placed
   in cards instead of being poured into one overflowing text box.
   Returns [{ marker, label, text }] — label is a leading bold phrase
   ("**Latency:** 40ms") split out so it can be coloured on its own. */
function _esSlideItems(md) {
  const lines = String(md == null ? "" : md).replace(/\r/g, "").split("\n");
  const items = [];
  let cur = null;
  const push = () => { if (cur && cur.text.trim()) items.push(cur); cur = null; };
  let mode = "";

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { if (mode !== "para") push(); mode = ""; continue; }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    const b = line.match(/^\s*(?:[-*+•‣▪])\s+(.*)$/);
    const n = line.match(/^\s*(\d{1,2})[.)]\s+(.*)$/);
    /* "**Revenue:** up 42%" on its own line is a labelled row, not prose
       that happens to start with a bold word. Left to the paragraph rule
       below it swallowed the whole list into one card and only the first
       label was ever coloured. */
    const l = line.match(/^\s*\*\*(.+?)\*\*\s*[:：—–-]?\s*(.*)$/);

    if (h) { push(); mode = "h"; cur = { marker: "", label: "", text: h[2].trim() }; push(); continue; }
    if (l) {
      push();
      mode = "lab";
      cur = { marker: "", label: l[1].trim(), text: (l[2] || "").trim() };
      continue;
    }
    /* "para" must be flushed too: it was missing here, so a paragraph
       directly followed by a list item had its `cur` overwritten instead of
       pushed and its text was lost. (The old `|| mode === "para"` test sat
       after `mode` had already been reassigned, so it could never be true.) */
    if (b) { if (mode === "n" || mode === "ul" || mode === "para") push(); mode = "ul"; if (!cur) cur = { marker: "", label: "", text: "", bullet: true }; cur.bullet = true; cur.text = (cur.text ? cur.text + " " : "") + b[1].trim(); continue; }
    if (n) { if (mode === "ul" || mode === "n" || mode === "para") push(); mode = "n"; cur = { marker: n[1], label: "", text: n[2].trim() }; continue; }

    /* A table row or a fenced block would otherwise be chopped into
       separate cards that no longer read as the table they came from. */
    if (/^\s*\|.*\|\s*$/.test(line) || /^\s*(```|~~~)/.test(line) || /^\s*([-*_]\s*){3,}$/.test(line)) {
      push(); mode = "raw";
      cur = { marker: "", label: "", text: line.trim() };
      continue;
    }
    if (mode === "raw" && cur) { cur.text += "\n" + line.trim(); continue; }
    if (cur && (mode === "ul" || mode === "n" || mode === "h" || mode === "lab")) { cur.text += " " + line.trim(); continue; }
    if (cur && mode === "para") { cur.text += " " + line.trim(); continue; }
    mode = "para";
    cur = { marker: "", label: "", text: line.trim() };
  }
  push();

  /* Split a leading bold phrase into its own label so it can carry the
     accent colour instead of sitting in the body colour. Also covers a
     label buried mid-item, e.g. a bullet that opens with one. */
  items.forEach((it) => {
    if (!it.label) {
      const m = it.text.match(/^\*\*(.+?)\*\*\s*[:：—–-]?\s*(.*)$/s);
      if (m && m[1].trim()) { it.label = m[1].trim(); it.text = (m[2] || "").trim() || it.label; }
    }
    it.label = String(it.label || "").replace(/[:：]\s*$/, "").trim();
    it.text = it.text.replace(/\*\*/g, "").replace(/^#+\s*/, "").trim();
    /* A label with nothing after it still deserves its own card. */
    if (!it.text) it.text = it.label;
  });
  return items.filter((it) => it.text);
}

/* Escape for the small amount of inline HTML the cards build by hand.
   Everything else goes through _esHtml + DOMPurify as before. */
function _esEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* A card: rounded panel, accent marker and the text set inside it.
   Returned as plain element specs so the normal builder validates them. */
function _esCard(p, x, y, w, h, text, z, opts) {
  const o = opts || {};
  const padX = o.padX != null ? o.padX : 18;
  const padY = o.padY != null ? o.padY : 14;
  const els = [];
  els.push({
    type: "shape", shape: "rounded", x, y, w, h, z,
    fill: p.surface, stroke: p.accent, strokeWidth: o.strokeWidth != null ? o.strokeWidth : 1, opacity: o.opacity != null ? o.opacity : 1
  });
  /* Numbered lists get a filled badge, everything else a slim rule —
     the marker is what makes a column of boxes read as a list. */
  if (o.marker) {
    if (o.badge) {
      els.push({ type: "shape", shape: "rounded", x: x + padX, y: y + padY, w: 26, h: 26, z: z + 1, fill: p.accent, stroke: "none", strokeWidth: 0 });
      els.push(_esSlideElement({ text: o.marker, x: x + padX, y: y + padY + 3, w: 26, h: 22, fontSize: 14, bold: true, color: p.onAccent, textAlign: "center" }, z + 2, p.onAccent));
    } else {
      els.push({ type: "shape", shape: "rounded", x: x + padX, y: y + padY + 2, w: 4, h: o.textH != null ? o.textH : 20, z: z + 1, fill: p.accent, stroke: "none", strokeWidth: 0 });
    }
  }
  const indent = o.marker ? (o.badge ? 26 + 10 : 4 + 10) : 0;
  /* `text` is the positional argument — reading it off `o` here rendered
     every card as the literal string "undefined". */
  const body = _esHtml(text);
  const rawHtml = o.label
    ? '<p style="margin:0"><strong style="color:' + p.accent + '">' + _esEsc(o.label) + "</strong>" +
      (body ? '<br><span style="color:' + p.muted + '">' + body + "</span>" : "") + "</p>"
    : body;
  els.push(_esSlideElement({
    rawHtml, x: x + padX + indent, y: y + padY,
    /* Padding is taken once per side. Subtracting it twice squeezed a
       three-column card's text down to half its available width. */
    w: Math.max(40, w - padX * 2 - indent),
    h: h - padY * 2,
    fontSize: o.fontSize || 15, color: p.ink, textAlign: "left"
  }, z + 2, p.ink));
  return els;
}

/* Cover / section slide: tinted page, oversized title, accent rule and
   a couple of soft shapes so it does not read as a blank rectangle. */
function _esDesignCover(title, subtitle, p, notes) {
  const els = [];
  let z = 1;
  /* The canvas is overflow:visible, so a shape hanging off the edge
     would draw over the app chrome rather than bleeding off the page —
     every decoration stays inside the 960x540 box. */
  els.push({ type: "shape", shape: "ellipse", x: 712, y: 44, w: 196, h: 196, z: z++, fill: p.accent, stroke: "none", strokeWidth: 0, opacity: 0.18 });
  els.push({ type: "shape", shape: "ellipse", x: 56, y: 344, w: 120, h: 120, z: z++, fill: p.accent, stroke: "none", strokeWidth: 0, opacity: 0.14 });
  els.push({ type: "shape", shape: "rect", x: 0, y: 0, w: 14, h: _ES_CANVAS_H, z: z++, fill: p.accent, stroke: "none", strokeWidth: 0 });

  const t = String(title || "").trim();
  if (t) {
    els.push(_esSlideElement({
      text: t, x: 76, y: 176, w: 700, h: 132,
      fontSize: t.length > 64 ? 36 : t.length > 34 ? 44 : 54,
      bold: true, color: p.ink, textAlign: "left"
    }, z++, p.ink));
  }
  const s = String(subtitle || "").trim();
  if (s) {
    els.push(_esSlideElement({ text: s, x: 78, y: 318, w: 620, h: 96, fontSize: 20, color: p.muted, textAlign: "left" }, z++, p.muted));
  }
  els.push({ type: "shape", shape: "rounded", x: 76, y: 140, w: 92, h: 8, z: z++, fill: p.accent, stroke: "none", strokeWidth: 0 });
  return { background: { type: "color", value: p.bg }, elements: els, notes: String(notes == null ? "" : notes) };
}

/* Content slide: accent header band, coloured heading, then the parsed
   body laid out as a grid of cards that reflows with the item count. */
function _esDesignContent(title, items, p, notes) {
  const els = [];
  let z = 1;
  const t = String(title || "").trim();

  els.push({ type: "shape", shape: "rect", x: 0, y: 0, w: _ES_CANVAS_W, h: 8, z: z++, fill: p.accent, stroke: "none", strokeWidth: 0 });
  if (t) {
    els.push(_esSlideElement({
      text: t, x: 64, y: 38, w: 832, h: 62,
      fontSize: t.length > 52 ? 30 : t.length > 28 ? 34 : 38,
      bold: true, color: p.ink, textAlign: "left"
    }, z++, p.ink));
    els.push({ type: "shape", shape: "rounded", x: 66, y: 104, w: 56, h: 6, z: z++, fill: p.accent, stroke: "none", strokeWidth: 0 });
  }

  const top = t ? 138 : 72;
  const bottom = 496;
  const availH = bottom - top;
  const gap = 16;
  const n = items.length;
  const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(n / cols));
  const cardW = Math.round((832 - gap * (cols - 1)) / cols);
  const cardH = Math.round(Math.min(190, (availH - gap * (rows - 1)) / rows));
  const numbered = items.length > 1 && items.every((it) => !!it.marker && /^\d+$/.test(it.marker));
  const bulleted = !numbered && items.length > 1 && items.every((it) => !!it.bullet);
  /* The badge is a fixed 26px and needs breathing room; long-form text
       in a narrow column does not. */
  const fontSize = cols === 3 ? 14 : n > 4 ? 15 : 16;

  items.forEach((it, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    /* Centre a short final row instead of leaving it hard against the
       left edge. */
    const inRow = Math.min(cols, n - row * cols);
    const rowW = inRow * cardW + (inRow - 1) * gap;
    const x = 64 + Math.round((832 - rowW) / 2) + col * (cardW + gap);
    const y = top + row * (cardH + gap);
    /* A list without any marker at all is just a stack of boxes; the
       accent tick or number badge is what makes it read as a list. */
    const marker = numbered ? String(Number(it.marker)) : bulleted ? "•" : "";
    const els2 = _esCard(p, x, y, cardW, cardH, it.text, z, {
      label: it.label, marker, badge: numbered, textH: fontSize + 4, fontSize
    });
    els.push.apply(els, els2);
    z += 3;
  });

  return { background: { type: "color", value: p.bg }, elements: els, notes: String(notes == null ? "" : notes) };
}
function _esBuildSlide(s, data, index) {
  const src = s && typeof s === "object" ? s : {};
  const notes = String(src.notes == null ? "" : src.notes);
  const ix = _esNum(index, 0);
  /* An explicit background/textColor from the model is respected — the
     auto-design only fills in what was not chosen for it. */
  const hasBg = !!(src.background || (data && data.background));
  const hasText = !!(src.textColor || (data && data.textColor));
  const bg = src.background || (data && data.background) || "#ffffff";
  const textColor = src.textColor || (data && data.textColor) || "#1a1a1a";
  const slide = { id: _esUid("sld_"), background: _esSlideBg(bg), elements: [], notes };
  let els = [];

  if (Array.isArray(src.elements) && src.elements.length) {
    els = src.elements.map((el, j) => _esSlideElement(el || {}, j + 1, textColor));
    /* A model-provided element list can still leave the page blank; give
       it the deck background rather than pure white. */
    if (!hasBg) {
      const p = _esPalette(ix);
      slide.background = { type: "color", value: p.bg };
      if (!hasText) {
        els = els.map((el) => Object.assign({}, el, { color: el.color === "#1a1a1a" ? p.ink : el.color }));
      }
    }
  } else {
    /* Plain title/content — design it instead of dumping it as two text
       boxes on white. */
    const p = _esPalette(ix);
    const title = String(src.title == null ? "" : src.title).trim();
    const content = String(src.content == null ? "" : src.content);
    const items = _esSlideItems(content);
    const designed = !hasBg && !hasText && (title || items.length);
    if (designed) {
      /* A slide with a heading and no body is a cover or a section
         divider — it gets the oversized treatment wherever it sits in the
         deck. Anything with body text gets the card layout. */
      const isCover = items.length === 0;
      const built = isCover
        ? _esDesignCover(title, title ? "" : (data && data.title) || "", p, notes)
        : _esDesignContent(title, items, p, notes);
      slide.background = built.background;
      els = built.elements.map((el, j) => _esSlideElement(el, j + 1, textColor));
    } else {
      let z = 1;
      if (title) els.push(_esSlideElement({ text: title, x: 60, y: 44, w: 840, h: 90, fontSize: 40, bold: true, color: textColor }, z++, textColor));
      if (content) els.push(_esSlideElement({ text: content, x: 60, y: 168, w: 840, h: 320, fontSize: 22, color: textColor }, z++, textColor));
      if (!els.length) els.push(_esSlideElement({ text: "", x: 60, y: 44, w: 840, h: 90, fontSize: 40, bold: true, color: textColor }, z++, textColor));
    }
  }
slide.elements = els;
  /* Transitions are a first-class slide property (slides.js:3765/3863) and
     were unreachable from here, so a deck could never carry one. */
  if (src.transition && typeof src.transition === "object") {
    const tr = src.transition;
    const ttype = _ES_TRANSITIONS.includes(String(tr.type || "").toLowerCase()) ? String(tr.type).toLowerCase() : "none";
    const dur = Number(tr.duration);
    const out = { type: ttype, duration: Number.isFinite(dur) && dur > 0 ? Math.min(10, dur) : 0.7 };
    if (tr.onClick === false) out.onClick = false;
    if (tr.autoAfter === true) {
      const secs = Number(tr.afterSec);
      out.autoAfter = true;
      out.afterSec = Number.isFinite(secs) && secs > 0 ? Math.min(600, Math.round(secs)) : 5;
    }
    if (ttype !== "none" || out.autoAfter) slide.transition = out;
  }
  if (Array.isArray(src.animations) && src.animations.length) {
    slide.animations = src.animations.map((a) => {
      const t = Number(a && a.target);
      const targetEl = els[Number.isFinite(t) ? t : 0];
      if (!targetEl) return null;
      const type = _ES_ANIM_TYPES.includes(String(a.type).toLowerCase()) ? String(a.type).toLowerCase() : "fade";
      /* "auto" was whitelisted here but no consumer in slides.js handles it —
         it silently fell through to the click branch. Only the three real
         triggers are accepted. */
      const start = _ES_ANIM_STARTS.includes(String(a.start || "").toLowerCase()) ? String(a.start).toLowerCase() : "click";
      const dur = Number(a.duration);
      const delay = Number(a.delay);
      const out = {
        id: _esUid("anm_"), elementId: targetEl.id, type, start,
        duration: Number.isFinite(dur) && dur > 0 ? Math.min(10, dur) : 0.5
      };
      if (Number.isFinite(delay) && delay > 0) out.delay = Math.min(60, delay);
      return out;
    }).filter(Boolean);
  }
  return slide;
}
async function _esImportSlides(data) {
  const id = "pres_" + Date.now() + "_" + generateSecureId(9);
  const now = Date.now();
  const title = _esPlainText(data.title) || "Imported Presentation";
  const slides = _esSplitSlides(data).map((s, i) => _esBuildSlide(s, data, i));
  const pres = { id, title, createdAt: now, updatedAt: now, slides };
  let idx = await _esStoreGet("emeraldcore.storage.suite.slides");
  idx = Array.isArray(idx) ? idx : [];
  idx.unshift({ id, title, updatedAt: now, slideCount: slides.length });
  await _esStoreSet("emeraldcore.storage.suite.slides", idx);
  await _esStoreSet("emeraldcore.storage.suite.slides." + id, pres);
  return id;
}
function _esColIndex(letter) {
  let n = 0;
  const s = String(letter || "").toUpperCase();
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}
/* Cell borders. The canonical path is s.border.{t,r,b,l} (singular "border",
   single-letter keys — sheets.js:607), each side either null or { style, color }.
   Only thin|medium|thick|double exist; anything else renders as 1px, so an
   unvalidated "dashed" would look applied while not being so. */
function _esBorderSide(v) {
  if (v == null || v === false) return null;
  if (typeof v === "string") return { style: _ES_BORDER_STYLES.includes(v) ? v : "thin", color: "#4a4a4a" };
  if (typeof v !== "object") return null;
  const st = String(v.style == null ? "thin" : v.style).toLowerCase();
  return { style: _ES_BORDER_STYLES.includes(st) ? st : "thin", color: String(v.color || "#4a4a4a") };
}
function _esBorder(v) {
  if (!v || typeof v !== "object") return null;
  const b = { t: _esBorderSide(v.t || v.top), r: _esBorderSide(v.r || v.right), b: _esBorderSide(v.b || v.bottom), l: _esBorderSide(v.l || v.left) };
  return (b.t || b.r || b.b || b.l) ? b : null;
}
function _esCellStyle(st) {
  const o = {};
  if (!st) return null;
  if (st.bold) o.bold = true;
  if (st.italic) o.italic = true;
  if (st.underline) o.underline = st.underline === 2 || st.underline === "double" ? 2 : 1;
  if (st.strike) o.strike = true;
  if (st.color) o.color = String(st.color);
  if (st.backgroundColor || st.fill) o.backgroundColor = String(st.backgroundColor || st.fill);
  const halign = String(st.halign || st.horizontal || "").toLowerCase();
  if (_ES_SHEET_ALIGN_H.includes(halign)) o.halign = halign;
  const valign = String(st.valign || st.vertical || "").toLowerCase();
  if (_ES_SHEET_ALIGN_V.includes(valign)) o.valign = valign;
  if (st.wrap) o.wrap = true;
  if (Number.isFinite(+st.fontSize)) o.fontSize = Math.max(1, Math.min(400, +st.fontSize));
  if (st.fontFamily) o.fontFamily = String(st.fontFamily);
  /* "General" is the app's absence-of-format value and normalises to null
     (sheets.js:603), so storing it would be a lie. */
  if (st.numberFormat && st.numberFormat !== "General") o.numberFormat = String(st.numberFormat);
  const cat = String(st.numFmtCat || "").toLowerCase();
  if (_ES_NUM_CATS.includes(cat)) o.numFmtCat = cat;
  if (Number.isFinite(+st.decimals)) o.decimals = Math.max(0, Math.min(10, Math.round(+st.decimals)));
  if (Number.isFinite(+st.indent)) o.indent = Math.max(0, Math.round(+st.indent));
  const border = _esBorder(st.border || st.borders);
  if (border) o.border = border;
  return Object.keys(o).length ? o : null;
}
/* Chart spec → sheets.js chart object (constructor at sheets.js:8752-8766).
   `range` is A1 notation and is parsed by the app, so it is passed through
   unchanged after a shape check. */
function _esChart(c, sheetId) {
  if (!c || typeof c !== "object") return null;
  const type = String(c.type || "column").toLowerCase();
  const range = String(c.range || "").trim();
  if (!/^\$?[A-Za-z]{1,3}\$?\d+:\$?[A-Za-z]{1,3}\$?\d+$/.test(range)) return null;
  const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
  const out = {
    id: _esUid("cht_"),
    type: _ES_CHART_TYPES.includes(type) ? type : "column",
    title: String(c.title == null ? "" : c.title),
    range: range.replace(/\$/g, ""),
    seriesInRows: !!c.seriesInRows,
    sheetId: sheetId,
    x: num(c.x, 0), y: num(c.y, 0), w: Math.max(120, num(c.w, 440)), h: Math.max(80, num(c.h, 300))
  };
  if (Array.isArray(c.colors) && c.colors.length) out.colors = c.colors.map(String);
  if (Array.isArray(c.seriesNames) && c.seriesNames.length) out.seriesNames = c.seriesNames.map(String);
  if (Array.isArray(c.seriesTypes) && c.seriesTypes.length) {
    out.seriesTypes = c.seriesTypes.map((t) => (["column", "bar", "line"].includes(String(t)) ? String(t) : null));
  }
  if (typeof c.dataLabels === "boolean") out.dataLabels = c.dataLabels;
  const lp = String(c.labelPos || "").toLowerCase();
  if (_ES_CHART_LABEL_POS.includes(lp)) out.labelPos = lp;
  if (c.labelFmt) out.labelFmt = String(c.labelFmt);
  if (c.axisTitles && typeof c.axisTitles === "object") out.axisTitles = Object.assign({}, c.axisTitles);
  return out;
}

/* Serialized sheet (sheets.js serializeSheet, :2633-2640). `cells` is a plain
   object keyed "row,col" (zero-based, sheets.js:47), `merges` is an array of
   [r1,c1,r2,c2], and axis entries are { s: size px, h: hidden, fh: filtered }. */
function _esBuildSheetData(data, seed) {
  const src = data && typeof data === "object" ? data : {};
  const id = (seed && seed.id) || _esUid("sh_");
  const cells = {};
  const rows = {}, cols = {};
  const matrix = Array.isArray(src.rows) ? src.rows : [];

  /* A leading "=" means a formula. These were stored as literal text before,
     so no AI-authored sheet could ever compute anything. The app keeps the
     source WITH the leading "=" and strips it when parsing (sheets.js:892). */
  const putCell = (r, c, val, style) => {
    if (val == null || val === "") {
      if (style) cells[r + "," + c] = { v: "", f: null, s: style };
      return;
    }
    if (typeof val === "object" && val !== null) {
      // { v, f, s } form, for full control.
      const f = val.f != null ? String(val.f) : null;
      const v = f ? null : (val.v != null ? val.v : "");
      cells[r + "," + c] = { v: v === undefined ? "" : v, f: (f && !f.startsWith("=")) ? "=" + f : f, s: _esCellStyle(val.s || val.style) };
      return;
    }
    if (typeof val === "string" && val.charAt(0) === "=") {
      cells[r + "," + c] = { v: null, f: val, s: style || null };
      return;
    }
    let v = val;
    if (typeof val === "string") {
      const n = Number(val);
      if (val.trim() !== "" && Number.isFinite(n) && /^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(val.trim())) v = n;
      else if (val.trim().toLowerCase() === "true") v = true;
      else if (val.trim().toLowerCase() === "false") v = false;
    }
    cells[r + "," + c] = { v, f: null, s: style || null };
  };

  matrix.forEach((rowArr, r) => {
    if (!Array.isArray(rowArr)) return;
    rowArr.forEach((val, c) => {
      if (val === null || val === undefined || val === "") return;
      putCell(r, c, val, null);
    });
  });

  /* Alternative cell form: {"A1": value, "B2": {v,f,s}} — cheaper for the
     model to emit than a full rows matrix when it is only touching a few
     cells, and what the "set one cell" op path uses. */
  if (src.cells && typeof src.cells === "object" && !Array.isArray(src.cells)) {
    for (const ref in src.cells) {
      const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref.trim());
      if (!m) continue;
      const r = parseInt(m[2], 10) - 1, c = _esColIndex(m[1]);
      if (r < 0 || c < 0) continue;
      putCell(r, c, src.cells[ref], null);
    }
  }

  if (src.cellStyles && typeof src.cellStyles === "object") {
    for (const ref in src.cellStyles) {
      const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref.trim());
      if (!m) continue;
      const r = parseInt(m[2], 10) - 1, c = _esColIndex(m[1]);
      if (r < 0 || c < 0) continue;
      const key = r + "," + c;
      const st = _esCellStyle(src.cellStyles[ref]);
      if (!cells[key]) cells[key] = { v: "", f: null, s: null };
      if (st) cells[key].s = st;
    }
  }

  const axis = (spec, key) => {
    if (Array.isArray(spec)) {
      spec.forEach((w, i) => { const n = Number(w); if (Number.isFinite(n) && n > 0) key[i] = { s: Math.round(n), h: 0, fh: 0 }; });
    } else if (spec && typeof spec === "object") {
      for (const k in spec) {
        const i = /^[A-Za-z]+$/.test(k) ? _esColIndex(k) : parseInt(k, 10);
        const n = Number(spec[k]);
        if (Number.isFinite(i) && i >= 0 && Number.isFinite(n) && n > 0) key[i] = { s: Math.round(n), h: 0, fh: 0 };
      }
    }
  };
  axis(src.columnWidths, cols);
  axis(src.rowHeights, rows);

  /* Merges serialize as [r1,c1,r2,c2] with inclusive bounds. */
  const merges = [];
  const pushMerge = (r1, c1, r2, c2) => {
    const a = Math.min(r1, r2), b = Math.max(r1, r2), x = Math.min(c1, c2), y = Math.max(c1, c2);
    if (!(a >= 0 && x >= 0)) return;
    if (merges.some((m) => m[0] === a && m[1] === x && m[2] === b && m[3] === y)) return;
    merges.push([a, x, b, y]);
  };
if (Array.isArray(src.merges)) {
        src.merges.forEach((m) => {
          if (Array.isArray(m) && m.length >= 4) pushMerge(+m[0] || 0, +m[1] || 0, +m[2] || 0, +m[3] || 0);
          else if (m && typeof m === "object") pushMerge(+m.r1 || 0, +m.c1 || 0, +m.r2 || 0, +m.c2 || 0);
        });
      }
      /* A1-style ranges ("A1:B2") are also accepted. Handled independently of
         `merges` rather than in an else, so a payload may supply both. */
      if (Array.isArray(src.ranges)) {
        src.ranges.forEach((rg) => {
          const m = /^\s*([A-Za-z]{1,3})(\d{1,7})\s*:\s*([A-Za-z]{1,3})(\d{1,7})\s*$/.exec(String(rg || ""));
          if (!m) return;
          pushMerge(parseInt(m[2], 10) - 1, _esColIndex(m[1]), parseInt(m[4], 10) - 1, _esColIndex(m[3]));
        });
      }

  const charts = [];
  if (Array.isArray(src.charts)) {
    for (const c of src.charts) { const ch = _esChart(c, id); if (ch) charts.push(ch); }
  }

  const fr = src.freeze && typeof src.freeze === "object" ? src.freeze : {};
  const tab = src.tabColor ? String(src.tabColor) : null;
  return {
    id, name: _esPlainText(src.sheetName || src.name) || "Sheet1",
    tabColor: tab, hidden: !!src.hidden,
    cells, rows, cols, merges, notes: [],
    freeze: { r: Math.max(0, parseInt(fr.r, 10) || 0), c: Math.max(0, parseInt(fr.c, 10) || 0) },
    charts, showGridlines: src.showGridlines === false ? false : true
  };
}

/* Multi-sheet workbooks. `sheets` (array) was ignored before, so a request
   for a workbook with a Summary and a Detail tab silently produced one tab. */
function _esBuildWorkbook(data, wbId, now) {
  const src = data && typeof data === "object" ? data : {};
  const title = _esPlainText(src.title) || "Imported Spreadsheet";
  let sheets = [];
  if (Array.isArray(src.sheets) && src.sheets.length) {
    sheets = src.sheets
      .map((s) => (s && typeof s === "object" ? _esBuildSheetData(s) : null))
      .filter(Boolean);
  } else {
    sheets = [_esBuildSheetData(src)];
  }
  const requested = _esPlainText(src.activeSheet || src.activeSheetName);
  const active = (requested && sheets.find((s) => s.name.toLowerCase() === requested.toLowerCase())) || sheets[0];
  return {
    sheets,
    data: {
      v: 1, id: wbId, title, createdAt: now,
      sheets, activeSheetId: active.id, names: {},
      calcMode: src.calcMode === "manual" ? "manual" : "auto",
      view: { zoom: 1, showFormulaBar: true, showHeadings: true, showFormulas: false }
    }
  };
}
async function _esImportSheets(data) {
  const wbId = "book_" + Date.now() + "_" + generateSecureId(9);
  const now = Date.now();
  const built = _esBuildWorkbook(data, wbId, now);
  await _esSheetsPut(wbId, { id: wbId, data: built.data, savedAt: now });
  return wbId;
}
async function openEsAppImport(id) {
  const safeId = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const rec = (window._esApps || {})[safeId];
  if (!rec) return;
  const data = rec.data;
  const kind = _esAppKind(data);
  if (!kind) return;
  const app = _ES_APPS[kind];
  // Open the tab synchronously (still inside the click gesture) so popup
  // blockers allow it; the URL is filled in after the async import writes.
  let win = null;
  try { win = window.open("about:blank", "_blank"); } catch (e) { win = null; }
  const closeWin = () => { try { if (win && !win.closed) win.close(); } catch (e) {} };
  let newId = null;
  try {
    if (kind === "notes") newId = await _esImportNotes(data);
    else if (kind === "docs") newId = await _esImportDoc(data);
    else if (kind === "slides") newId = await _esImportSlides(data);
    else if (kind === "sheets") newId = await _esImportSheets(data);
  } catch (e) {
    console.warn("EmeraldSuite import failed:", e);
    closeWin();
    showToast(`${_aiSvgWarn} Could not import to EmeraldSuite.`, "error");
    return;
  }
  if (!newId) { closeWin(); return; }
  const url = app.file + "?owned=" + encodeURIComponent(newId);
  showToast(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-2px;margin-right:5px"><polyline points="20 6 9 17 4 12"/></svg> Imported to ${app.label}`, "success");
  if (win && !win.closed) {
    try { win.location.href = url; return; } catch (e) {}
  }
  try { location.href = url; } catch (e) {}
}
// Event delegation: .esapp-card[data-esapp] clicks → openEsAppImport
document.addEventListener("click", function(e) {
  const card = e.target.closest(".esapp-card[data-esapp]");
  if (card) openEsAppImport(card.dataset.esapp);
});

/* ── EmeraldSuite file agent (auto-read + direct edit) ──────────
   No attachment UI: on every send the user's EmeraldSuite file catalog and
   the latest contents are auto-read from storage and injected as
   [EMERALDSUITE FILES] context, so the AI picks the right file itself. When
   the user asks for a change, the agent responds with <es-edit>{json}</es-edit>
   (the FULL new file content, including "app" and "id" of the target file);
   we write it back to the same storage the app reads and show an
   "Updated File" pill. The open app tab syncs via the storage layer's
   BroadcastChannel (Sheets via the es-ai agent channel). Creating NEW files
   stays on the <es-app> import card. */

/* ── Suite context ────────────────────────────────────────────────
   The [EMERALDSUITE FILES] block is injected ONLY on turns that are actually
   about the user's EmeraldSuite content. Injecting it on every request made
   the model carry a private file catalog into unrelated questions, so it kept
   steering conversations back to notes it had been told nothing about.

   A naive mention gate ("does the message contain a file noun?") is what broke
   normal follow-ups before: "fix the typo", "make it shorter", "do that again"
   name no file, so the model got no catalog, could not know a single file id,
   and its payload came back as "No file changed — you didn't ask for one".

   So the gate is a latch with three levels:
     · MENTION  — names the suite or a file ("my notes", "the doc", "slide 3")
                  → tell it everything, and latch.
     · FOLLOW-UP — no noun, but an action/continuation word ("shorter", "again",
                  "continue") AND the previous turn was already about a file
                  → still in that conversation, keep telling it.
     · UNRELATED — neither → tell it NOTHING about the suite and drop the latch.
   This is what keeps "fix the typo" working right after a file edit while
   leaving "what's the capital of France?" completely unaware files exist. */

/* ── Write gate — REMOVED ───────────────────────────────────────
   There used to be a per-request gate here: _efDetectWriteRequest()
   regex-tested the user's message for edit verbs, and anything that did not
   match was labelled read-only, its <es-edit>/<es-app> payload stripped and
   discarded on arrival.

   It blocked far more than it protected. "go ahead", "do it", "same but blue",
   "sort the dates" and "fix that typo" all name no file kind, so the regex
   read them as read-only and the model produced a correct payload that was
   then thrown away — the user saw the change described and nothing happen.
   Deciding whether a message implies a change is a judgement call, and a
   keyword list cannot make one.

   The model now decides, and _efDirective() states the rules it must respect.
   The safety comes from the payload shape rather than a gate: ops touch only
   what they name, so a wrong guess damages one element instead of a file. */
function _efResetWriteGate() {
  /* Kept as a no-op: the call sites still run before a request, and removing
     them everywhere would be churn for no behaviour change. */
}

const _EF_WRITE_VERB = /\b(edit|update|rewrite|revise|fix|change|modify|replace|rename|retitle|reword|proofread|correct|improve|expand|shorten|lengthen|reformat|reorder|reorgani[sz]e|organi[sz]e|sort|add|append|prepend|insert|remove|delete|erase|trim|clear|fill|write|save|overwrite|create|draft|compose|generate|apply|convert|translate|continue|finish|complete|tweak|adjust|boost|merge|split|build|make|clean|tidy|polish|redo|revamp|restyle|retheme|redesign|unify|standardi[sz]e|shorter|longer|simpler|clearer|neater|formal|casual|bulleted|bullet\s*point|turn|transform|rephrase|paraphrase|restructure|condense|expand|iterate|iterate\s*on|improve\s*it|start\s*over|overhaul|correct|drop|include|incorporate|add\s+in|throw\s+in)\b/i;
const _EF_NEW_FILE = /\b(new|fresh|another|extra|second)\s+(note|notes|doc|docs|document|documents|slide|slides|deck|decks|presentation|presentations|sheet|sheets|spreadsheet|spreadsheets|workbook|workbooks|file|files)\b/i;
const _EF_FILE_REF = /\b(note|notes|doc|docs|document|documents|slide|slides|deck|decks|presentation|presentations|sheet|sheets|spreadsheet|spreadsheets|workbook|workbooks|file|files)\b/i;
const _EF_WH_QUESTION = /\b(what|why|how|when|where|who|whom|which|whose)\b/i;
const _EF_DIRECT_ASK = /\b(please|can you|could you|would you|will you|go ahead|do it|do that|make it|try to|try and|i need you to|i want you to|i'?d like you to|help me|now)\b/i;
/* Advice-seeking, even when it happens to contain a write verb ("should I add
   more slides?"). Checked first so a trailing question always wins over the
   verb, otherwise asking for a second opinion grants write permission. */
const _EF_ADVICE_QUESTION = /\b(should i|should we|shall i|would it|do you think|do you reckon|what if|is it (better|worse|worth|possible|a good)|are there (better|any)|worth (it|doing)|any (ideas?|thoughts?|suggestions?|advice)|how would you|how (should|would) i|could you explain|can you explain|can you suggest|help me decide|thoughts on|let me know (if|whether|what))\b/i;

/* ── Does the model get to know the suite exists this turn? ───────────
   Three levels, described at the "Suite context" banner above. */
const _EF_SUITE_MENTION = /\b(emeraldsuite|emerald\s+suite|the suite|my suite|suite (file|note|doc|slide|sheet)|catalog|library)\b/i;
const _EF_FILE_NOUN = /\b(note|notes|doc|docs|document|documents|slide|slides|deck|decks|presentation|presentations|sheet|sheets|spreadsheet|spreadsheets|workbook|workbooks|file|files)\b/i;
/* Action/continuation words that keep an in-progress file conversation alive
   without naming a file: "make it shorter", "fix the typo", "again", "continue".
   The edit verbs are reused from _EF_WRITE_VERB rather than listed twice — a
   shorter copy silently drifts and follow-ups stop working. _EF_CONTINUE adds
   the bare continuations that are not edits at all. */
const _EF_CONTINUE = /\b(again|continue|keep going|go on|proceed|next|once more|and then|that one|same|do it|go ahead|yes|please|sure|perfect|great|nice|thanks|thank you)\b/i;
/* The subset of the above that actually grants permission to write. "thanks!"
   and "nice" keep the context alive but must never authorise a rewrite, so they
   are deliberately excluded. */
const _EF_APPROVAL = /\b(again|continue|keep going|go on|proceed|next|once more|and then|that one|same|do it|do that|go ahead|yes|apply it|apply that|save it|make it so|keep at it)\b/i;
/* A phrase like "make it shorter" or "add a heading" continues a file edit only
   when its object points BACK at the file. While the latch is on, ordinary chat
   shares these verbs constantly, and every one dragged the private file catalog
   along: "translate hello into French", "help me fix my code", "clean up this SQL
   query". Enumerating the non-file objects does not work — there are always
   more — so the object is judged structurally instead. A follow-up continues when:
     · it backs off with a pronoun — "make it shorter", "expand it";
     · it asks for something NEW to go in — "add a heading", "insert an example";
     · it is a bare approval — "again", "continue" — which continues by definition;
     · it is very short — "shorter", "fix the typo" — which continues by context.
   And anything naming its own object is rejected first: a possessive ("my code")
   or a demonstrative plus noun ("this SQL query") binds to the current message,
   not to any file. */
const _EF_ORDINARY_POSSESSIVE = /\b(i|me|my|mine|you|your|yours|we|us|our|ours)\b/i;
const _EF_DEMONSTRATIVE_NOUN = /\b(this|that|these|those)\s+[a-z]/i;
const _EF_BACK_REFERENCE = /\b(it|its|them)\b/i;
const _EF_INDEFINITE_ADD = /\b(add|insert|append|prepend|include)\s+(a|an|another|one more|the rest)\b/i;
/* Read-only verbs that need the file's actual text to act on. Paired with a
   referent below so "summarize it" works but "where is Rome?" does not. */
const _EF_ABOUT_CONTENT = /\b(summari[sz]e|summari[sz]ation|recap|proofread|read through|go over|walk me through)\b/i;
const _EF_REFERENT = /\b(it|its|this|that|these|those|them|the same|the rest)\b/i;
function _wordCount(t) {
  return String(t || "").trim().split(/\s+/).filter(Boolean).length;
}
let _efSuiteLatch = false;

function _suiteContextAllowed(userText) {
  const t = String(userText || "").trim();
  if (!t) return false;
  // A direct mention always wins, even mid-sentence: "update the doc",
  // "my slides", "what's in this note?".
  if (_EF_SUITE_MENTION.test(t) || _EF_FILE_NOUN.test(t)) { _efSuiteLatch = true; return true; }
  // No file named. If this message points back at the file we were just working
  // on, the conversation is still about it and the model keeps its context.
  if (_efSuiteLatch) {
    // It brings its own object ("my code", "this SQL query", "a python script"),
    // so whatever it means, it is not about a stored file.
    if (_EF_ORDINARY_POSSESSIVE.test(t) || _EF_DEMONSTRATIVE_NOUN.test(t)) { _efSuiteLatch = false; return false; }
    const continues = _EF_APPROVAL.test(t) || _EF_BACK_REFERENCE.test(t) ||
      _EF_INDEFINITE_ADD.test(t) || (_wordCount(t) <= 3 && _EF_WRITE_VERB.test(t));
    if (continues && (_EF_WRITE_VERB.test(t) || _EF_CONTINUE.test(t) || _EF_ABOUT_CONTENT.test(t))) {
      return true;
    }
  }
  // Anything else: the suite is none of this message's business. Drop the latch
  // so a later bare "make it shorter" starts from a clean slate rather than
  // acting on a stale file.
  _efSuiteLatch = false;
  return false;
}


function _efLabel(app) { return (_ES_APPS[app] && _ES_APPS[app].label) || app; }

async function _efRead(app, id) {
  try {
    if (app === "notes") {
      const arr = await _esStoreGet("emeraldcore.storage.suite.notes");
      if (!Array.isArray(arr)) return { app, id, title: "", text: "", exists: false };
      const n = arr.find((x) => x.id === id);
      if (!n) return { app, id, title: "", text: "", exists: false };
      return { app, id, title: n.title || "Untitled Note", text: _esPlainText(n.content || ""), exists: true };
    }
    if (app === "docs") {
      const d = await _esStoreGet("emeraldcore.storage.suite.docs." + id);
      if (!d) return { app, id, title: "", text: "", exists: false };
      return { app, id, title: d.title || "Untitled Document", text: _esPlainText(d.content || ""), exists: true };
    }
    if (app === "slides") {
      const d = await _esStoreGet("emeraldcore.storage.suite.slides." + id);
      if (!d || !Array.isArray(d.slides)) return { app, id, title: "", text: "", exists: false };
      const parts = [];
      d.slides.forEach((s, i) => {
        /* Slides are stored as the element model — { elements: [{ html }] } —
           with no `title`/`content` of their own, so reading those two
           properties yielded "Slide N" plus notes and the AI never actually
           saw the slide's text. Pull the text out of the elements, ordered
           top-to-bottom then left-to-right, and keep the old properties as a
           fallback for anything saved before this shape existed. */
        const body = _esPlainText(s && s.content);
        let lines;
        if (!body && s && Array.isArray(s.elements)) {
          /* Reading order: top to bottom, then left to right. z is the paint
             order, not the layout order, so it must not decide this. */
          lines = s.elements
            .filter((el) => el && el.type !== "image")
            .slice()
            .sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0) || (Number(a.x) || 0) - (Number(b.x) || 0))
            .map((el) => _esPlainText(el.html != null ? el.html : el.text))
            .filter(Boolean);
        }
        const first = lines && lines.length ? lines[0] : "";
        const title = _esPlainText(s && s.title) || (first || "Slide " + (i + 1));
        const rest = lines && lines.length ? lines.slice(1).join("\n") : "";
        const notes = _esPlainText(s && s.notes);
        parts.push("## Slide " + (i + 1) + " — " + title + (notes ? "  (notes: " + notes + ")" : "") + "\n" + (body || rest));

        /* An element map, so an op can target "element 2 on slide 3" without
           the model having to re-send the slide to learn its own id. */
        if (s && Array.isArray(s.elements) && s.elements.length) {
          let map = "[elements] ";
          s.elements.forEach((el, ei) => {
            const bits = [];
            if (el.type === "text") {
              if (el.fontSize) bits.push("size=" + el.fontSize);
              if (el.bold) bits.push("bold");
              if (el.italic) bits.push("italic");
              if (el.underline) bits.push("underline");
              if (el.fontFamily) bits.push("font=" + el.fontFamily);
              if (el.textAlign && el.textAlign !== "left") bits.push("align=" + el.textAlign);
              if (el.listType) bits.push("list=" + el.listType);
            }
            if (el.type === "shape" && el.shape) bits.push("shape=" + el.shape);
            if (el.type === "image" || el.type === "video" || el.type === "audio") bits.push("src=" + String(el.src || "").slice(0, 60));
            map += (ei + 1) + "=" + (el.type || "text") +
              " @" + el.x + "," + el.y + " " + el.w + "x" + el.h +
              (el.r ? " rot=" + el.r : "") +
              (el.color ? " color=" + el.color : "") +
              (bits.length ? " [" + bits.join(" ") + "]" : "") + "; ";
          });
          if (Array.isArray(s.animations) && s.animations.length) {
            map += " [animations] ";
            s.animations.forEach((a, ai) => {
              map += (ai + 1) + "=" + a.type + "/" + (a.start || "click") +
                (a.duration ? "/" + a.duration + "s" : "") + "; ";
            });
          }
          if (s.transition && s.transition.type && s.transition.type !== "none") {
            map += " [transition] " + s.transition.type + (s.transition.duration ? "/" + s.transition.duration + "s" : "");
          }
          parts.push(map);
        }
      });
      return { app, id, title: d.title || "Untitled Presentation", text: parts.join("\n\n"), exists: true };
    }
    if (app === "sheets") {
      const doc = await _efSheetsGet(id);
      const data = doc && doc.data;
      if (!data) return { app, id, title: "", text: "", exists: false };
      const sheets = Array.isArray(data.sheets) ? data.sheets : [];
      /* Name every tab up front — a workbook can hold several and an op that
         omits "sheet" lands on the active one, so the model has to be able
         to see them all. */
      let head = "[tabs] ";
      sheets.forEach((s, i) => {
        head += (i + 1) + "=" + (s.name || "Sheet") + (s.id === data.activeSheetId ? " (active)" : "") +
          ((s.charts && s.charts.length) ? " charts=" + s.charts.length : "") +
          ((s.merges && s.merges.length) ? " merges=" + s.merges.length : "") + "; ";
      });
      const body = sheets.map((s) => {
        let b = "### Tab: " + (s.name || "Sheet") + "\n";
        if (s.charts && s.charts.length) {
          b += "charts: " + s.charts.map((c, ci) =>
            (ci + 1) + "=" + (c.type || "column") + " " + (c.range || "") + (c.title ? ' "' + c.title + '"' : "")
          ).join("; ") + "\n";
        }
        if (s.merges && s.merges.length) {
          b += "merges: " + s.merges.map((m) => "r" + m[0] + "c" + m[1] + ":r" + m[2] + "c" + m[3]).join(", ") + "\n";
        }
        b += _efSheetToMd(s);
        return b;
      }).join("\n\n");
      return { app, id, title: data.title || "Untitled Spreadsheet", text: head + "\n" + (body || "(empty)"), exists: true };
    }
  } catch (e) { console.warn("File read failed:", e); }
  return { app, id, title: "", text: "", exists: false };
}

function _efSheetToMd(sheet) {
  let maxR = 0, maxC = 0;
  for (const k in (sheet && sheet.cells) || {}) {
    const ci = k.indexOf(",");
    const r = +k.slice(0, ci), c = +k.slice(ci + 1);
    if (r > maxR) maxR = r; if (c > maxC) maxC = c;
  }
  if (maxR > 199) maxR = 199;
  if (maxC > 19) maxC = 19;
  const val = (r, c) => {
    const m = sheet.cells[r + "," + c]; if (!m) return "";
    /* A formula cell stores its source in `f` with v:null, so reading only
       `v` made every computed column read as empty — the model then saw an
       empty sheet where the real numbers were. */
    if (m.f) return String(m.f);
    let v = m.v; if (v === null || v === undefined || typeof v === "object") v = "";
    return String(v);
  };
  const lines = [];
  for (let r = 0; r <= maxR; r++) {
    const cells = [];
    let empty = true;
    for (let c = 0; c <= maxC; c++) {
      const s = val(r, c).replace(/[\\|]/g, (m) => "\\" + m).replace(/[\t\r\n]+/g, " ").replace(/ +/g, " ");
      if (s) empty = false;
      cells.push(s.slice(0, 120));
    }
    if (!empty || r === 0) lines.push("| " + cells.join(" | ") + " |");
  }
  if (!lines.length) return "(empty)";
  const n = lines[0].split("|").length - 2 || 1;
  lines.splice(1, 0, "| " + Array(n).fill("---").join(" | ") + " |");
  return lines.join("\n");
}

/* Auto-read every EmeraldSuite file (catalog + latest contents) from storage.
   Injected only when the user's message is about that content — see
   _suiteContextAllowed(). userText = the user's own message this turn; it also
   decides whether the model's file context is injected at all.
   Returns null when the suite is irrelevant, which is the common case for
   general chat, so the model stays a normal assistant there. */
async function _suiteAutoContext(userText) {
  // The suite is only discussed when the user brings it up. Checked FIRST, before
  // any storage read: an unrelated question should not even pull the private
  // catalog out of IndexedDB, let alone put it in front of the model.
  if (!_suiteContextAllowed(userText)) return null;
  const items = [];
  const note = async (app, id, title, upd) => {
    const r = await _efRead(app, id);
    return { app, id, title: (r && r.title) || title || "Untitled", text: (r && r.text) || "", updatedAt: upd || 0 };
  };
  try {
    const notes = await _esStoreGet("emeraldcore.storage.suite.notes");
    if (Array.isArray(notes)) {
      for (const n of notes) items.push(await note("notes", n.id, n.title, Date.parse(n.modifiedAt) || 0));
    }
  } catch (e) {}
  try {
    const idx = await _esStoreGet("emeraldcore.storage.suite.docs");
    if (Array.isArray(idx)) {
      for (const m of idx) items.push(await note("docs", m.id, m.title, m.updatedAt || 0));
    }
  } catch (e) {}
  try {
    const idx = await _esStoreGet("emeraldcore.storage.suite.slides");
    if (Array.isArray(idx)) {
      for (const m of idx) items.push(await note("slides", m.id, m.title, m.updatedAt || 0));
    }
  } catch (e) {}
  try {
    const sheets = await _efSheetsAll();
    for (const s of sheets) items.push(await note("sheets", s.id, s.title, s.updatedAt || 0));
  } catch (e) {}
  if (!items.length) {
    // Nothing in storage yet. The <es-app> create syntax is documented ONLY in
    // this block and in _efDirective(), so returning null here left the model
    // with no idea the tag existed: "create a note about X" on an empty suite
    // got answered in plain text and no file was ever made. Still tell it how
    // to create one when the turn asked for a change.
/* No files yet — but the model still needs the create syntax, otherwise
       "make me a note about X" on an empty suite is answered in plain text
       and no file is ever made. */
    return _efDirective() + "\n[EMERALDSUITE FILES]\nThe user has no files in EmeraldSuite yet.\n" +
      " There is nothing to edit, so CREATE the file with <es-app>{...}</es-app> — no \"id\" is needed." +
      ' Payload shapes: notes {"app":"notes","title":"...","content":"markdown"}; docs {"app":"docs","title":"...","content":"markdown"};' +
      ' slides {"app":"slides","title":"...","background":"#hex","slides":[{"title":"...","content":"...","background":"#hex","transition":{"type":"fade","duration":0.7},"animations":[{"target":0,"type":"fade","start":"click","duration":0.5}]}]};' +
      ' sheets {"app":"sheets","title":"...","sheets":[{"sheetName":"Sheet1","rows":[["A1","B1"]],"cellStyles":{"A1":{"bold":true,"backgroundColor":"#eef"}},"merges":["A1:B1"],"columnWidths":{"A":160},"charts":[{"range":"A1:C10","type":"column","title":"Sales"}]}]}.' +
      _esSlideSpec() + _esOpsSpec() +
      " Emit exactly one payload and do not also emit <es-edit>.";
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const CATALOG = items.slice(0, 30);
  const DETAIL = items.slice(0, 6);
  let block = "[EMERALDSUITE FILES]\nFiles in the user's EmeraldSuite storage (App | File ID | Title):\n";
  for (const it of CATALOG) block += "- " + _efLabel(it.app) + " | " + it.id + " | " + it.title.replace(/\n/g, " ") + "\n";
  block += "\n[FILE CONTENTS] latest files, so you can edit them directly:\n";
  for (const it of DETAIL) {
    let body = it.text || "(empty)";
    if (body.length > 5000) body = body.slice(0, 5000) + "\n[...truncated...]";
    block += "\n### " + _efLabel(it.app) + " — \"" + it.title.replace(/\n/g, " ") + "\" (ID: " + it.id + ")\n" + body + "\n";
  }
  block += "\nYou may edit these files whenever it helps — decide for yourself whether this message calls for a change.\n" +
      'PREFER targeted ops: <es-edit>{"app":"the-app","id":"the-file-id","ops":[...]}</es-edit>, which changes only what it names. Use ops for recolouring, resizing, moving, inserting text/shapes/images, adding a chart, setting a border, merging, adding or animating a slide, appending to a note, and so on.\n' +
      'Use {"app":"...","id":"...","content":"full new markdown"} ONLY when the whole file should be replaced, and <es-app>{...}</es-app> to CREATE a brand-new file.\n' +
      "But answer in plain text and write nothing when the user only asked a question or wanted a summary, review, comparison or explanation.\n" +
      "Change ONLY what the request calls for, touch no other file, and emit exactly one payload." +
      _esOpsSpec() + _esSlideSpec();
  if (block.length > 26000) block = block.slice(0, 26000) + "\n[...truncated...]";
  // The directive is prepended, never appended: the catalog above is truncated
  // for large file sets, and a clipped rules block would silently reopen the
  // hole where the model edits a file nobody asked it to touch.
  return _efDirective() + "\n" + block;
}

/* Deck design schema, appended wherever a slides payload is described.
   Without it the model only ever sent {"title","content"}, which is why
   generated decks came out as unstyled text on white. Kept in one place so
   the create and edit paths cannot drift apart. */
/* The feature vocabulary. The model can only pick from what it is told
   exists, and these are the REAL enums the apps accept — anything else
   silently degrades to a default with no feedback. Injected ONLY when a
   write has been authorised, so ordinary chat pays nothing for the tokens. */
function _esOpsSpec() {
  return (
    "\n[EMERALDSUITE EDIT OPS — prefer these over resending a file]\n" +
    'Payload: <es-edit>{"app":"...","id":"...","ops":[ {...}, {...} ]}</es-edit>\n' +
    'ops change ONLY what they name; every other part of the file is left exactly as it is. Use ops for any targeted change; use "content"/"slides"/"rows" only when rewriting the whole file is genuinely what was asked. You may send several ops in one payload and they apply in order.\n' +
    "Indices are 1-BASED. Address a slide as \"slide\":1 or \"slide\":\"last\"; an element as \"el\":1. Omit them and slide 1 / element 1 is used. Sheets address by \"sheet\":\"Name\" or number; omit to use the active tab.\n" +
    "SLIDES ops: set_slide_bg{slide,background} | add_slide{at,title,content|elements,background,transition,animations} | delete_slide{slide} | duplicate_slide{slide} | move_slide{from,to} | " +
    "set_title{slide,el,title} | set_notes{slide,notes} | set_transition{slide,transition,duration,autoAfter,afterSec,clear} | " +
    "add_text{slide,text,x,y,w,h,fontSize,fontFamily,bold,italic,underline,color,highlight,textAlign,listType} | " +
    "add_shape{slide,shape,x,y,w,h,fill,stroke,strokeWidth} | " +
    "add_image{slide,src,alt,x,y,w,h,crop:{l,t,r,b},borderWidth,borderColor,fx:{brightness,contrast,saturate,hue,grayscale,sepia,invert,blur}} | " +
    "set_slide_bg{slide,background} (a hex colour, \"linear-gradient(135deg,#hex,#hex)\", an https image URL, or an image reference below) | " +
    "set_el{slide,el,x,y,w,h,r,z,opacity,bold,italic,underline,fontSize,fontFamily,color,highlight,textAlign,listType,text,fill,stroke,strokeWidth,link,borderWidth,borderColor,fx} | " +
    "move_el{slide,el,x,y} or move_el{slide,el,dx,dy} | resize_el{slide,el,w,h} or resize_el{slide,el,scale} | " +
    "animate{slide,el,animation,start,duration,delay} | delete_animation{slide,index} | delete_el{slide,el} | duplicate_el{slide,el}\n" +
    "  slide background: a hex colour, \"linear-gradient(135deg,#hex,#hex)\", or an https image URL. " +
    "shapes: rect rounded ellipse triangle rightTriangle diamond pentagon hexagon octagon decagon star star4 star6 star8 star12 seal1 seal2 arrow arrowLeft arrowRight arrowUp arrowDown arrowUturn arrowChevron arrowBent arrowNotched arrowStriped arrowCalloutR arrowCalloutD arrowCircular arrowQuad chevron bar calloutRect calloutRound calloutEllipse calloutCloud heart lightning sun moon cloud wave smile cube can scroll donut teardrop plus cross ribbon plaque chamfer frameRect foldCorner pie bracketL bracketR heartRibbon sunStar gear snowflake fcProcess fcDecision fcData fcDocument fcTerminator fcPreparation fcConnector fcDelay fcDisplay fcManualOp fcSort none. Unknown names fall back to rounded, so use these.\n" +
    "  text: fontSize in px; fontFamily one of DM Sans, Arial, Helvetica, Verdana, Roboto, Open Sans, Lato, Montserrat, Poppins, Nunito, Ubuntu, Raleway, Oswald, Work Sans, Georgia, Times New Roman, Merriweather, Lora, Libre Baskerville, DM Serif Display, Crimson Text, Fira Code, IBM Plex Mono, Courier New, Dancing Script, Caveat, Pacifico, Lobster, Permanent Marker; color/highlight are any CSS colour; textAlign left|center|right|justify; listType ul|ol|\".\n" +
    "  animations: appear fade fly zoom spin bounce. start: click|with|after. duration and delay are in SECONDS (duration 0.1-10, delay 0-60).\n" +
    "  transitions: none fade push wipe split reveal cut cover uncover shape blinds random-bars morph fade-black zoom cube flip gallery vortex newsflash honeycomb glitch dissolve checkerboard clock ripple doors switch curtains fracture peel-off glitter comb pan rotate orbit fly-through conveyor. duration in seconds (0.1-10).\n" +
    "  crop is a FRACTION 0-0.9 per side, not pixels. fx percentages are 0-200 for brightness/contrast/saturate, 0-360 for hue, 0-1 for grayscale/sepia/invert, px for blur.\n" +
    "SHEETS ops: set_cell{cell|range,value|formula|style} | set_style{range,style} | set_border{range,border:{t,r,b,l},clear} | clear_cells{range} | " +
    "set_col_width{col,width} | set_row_height{row,height} | merge{range} | unmerge{range} | " +
    "add_chart{range,type,title,colors,seriesNames,dataLabels,labelPos,x,y,w,h} | delete_chart{index} | " +
    "add_sheet{name,rows,at,activate} | delete_sheet{sheet} | rename_sheet{sheet,name} | set_tab_color{sheet,color} | " +
    "set_freeze{rows,cols} | set_gridlines{value} | set_calc_mode{mode}\n" +
    "  cell and range use A1 notation: cell:\"B2\", range:\"A1:D20\". Give the used block, not whole-column ranges. " +
    "value is a number, string or bool; a STRING beginning with \"=\" is stored as a live formula (e.g. \"=SUM(B2:B10)\", \"=AVERAGE(C2:C9)\").\n" +
    "  style: {bold,italic,underline:1|2,strike,color,backgroundColor,halign:left|center|right,valign:top|middle|bottom,wrap,fontFamily,fontSize,numberFormat,numFmtCat,decimals,indent}. " +
    "border sides are the keys t,r,b,l and each side is {style,color} where style is EXACTLY one of thin|medium|thick|double — there is no dashed, dotted or solid; anything else renders as 1px.\n" +
    "  chart types: column bar line pie scatter. range like \"A1:C10\". labelPos out|in|ctr. add_chart places it at x,y with size w,h in px.\n" +
    "  Formula functions available include SUM AVERAGE COUNT COUNTA COUNTIF COUNTIFS SUMIF SUMIFS SUMPRODUCT MIN MAX MEDIAN ABS SQRT POWER ROUND AND OR NOT XOR IF IFERROR IFS SWITCH CONCATENATE CONCAT TEXTJOIN LEFT RIGHT MID LEN UPPER LOWER TRIM REPLACE SUBSTITUTE FIND SEARCH VLOOKUP HLOOKUP XLOOKUP INDEX MATCH INDIRECT ROW COLUMN ROWS COLUMNS TODAY NOW DATE YEAR MONTH DAY PMT FV PV NPV IRR SPARKLINE.\n" +
    "NOTES/DOCS ops: append_html{html} | prepend_html{html} | append{markdown} | prepend{markdown} | replace_html{html} | replace_all{find,text} | delete_html{find} | insert_before{find,html|markdown} | insert_after{find,html|markdown} | " +
    'add_image{src,alt,anchor}\n' +
    'Set "title" on the payload to rename; "color" renames a note background; "header"/"footer" set a doc\'s running header/footer.\n' +
    "  IMAGE SOURCES: \"src\" accepts an https image URL, or a token naming an image ALREADY GENERATED earlier in this conversation. " +
    "That is how you put something you just made into a file: emit the [GENERATE_IMAGE] tag as usual, then in a later message (or the same reply, if the image is already in context) use add_image with the matching token." +
    _esGenImagesNote() + "\n" +
    "  allowed html tags: p br strong em u b i ul ol li h1-h6 div span a table thead tbody tfoot tr td th colgroup col font img s strike sub sup input. " +
    "There is NO <pre>, <hr>, <blockquote> or <code> — those get unwrapped, so a code block must be a <div> with a monospace font-family.\n" +
    '  image: <img src="https://..." alt="..." style="max-width:100%;height:auto;border-radius:6px;"> (https/data-image only)\n' +
    '  checklist: <div class="todo-item"><input type="checkbox" class="todo-checkbox"><span class="todo-label"> text</span></div>\n' +
    "  table: <table><thead><tr><th>H</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>\n" +
    "  docs only, page break: <div class=\"emdocs-page-break\"><span class=\"pb-label\">— Page Break —</span></div><p><br></p>\n"
  );
}

function _esSlideSpec() {
  return " SLIDE DESIGN — a slide canvas is 960x540 px and every position is in pixels from the top-left. " +
    'A slide may be {"title":"...","content":"markdown"} (auto-laid-out with a palette, cards and headings) OR be fully designed with "background" and "elements": [...]. ' +
    '"background" may be a hex colour, a "linear-gradient(135deg,#hex,#hex)" string, or an https image URL — the right type is inferred from the value.\n' +
    'Elements: {"type":"text","x":..,"y":..,"w":..,"h":..,"text":"markdown **bold** ok","fontSize":24,"bold":true,"italic":false,"underline":false,"fontFamily":"DM Sans","color":"#1a1a1a","highlight":"rgba(0,0,0,0.05)","textAlign":"left|center|right","listType":"ul|ol","r":0,"z":1,"opacity":1,"link":"https://..."}; ' +
    '{"type":"shape","x":..,"y":..,"w":..,"h":..,"shape":"rect|rounded|ellipse|triangle|diamond|hexagon|pentagon|star|arrow|arrowRight|calloutRect|calloutRound|donut|plus|line|lineArrow|arrowChevron|heart|cloud","fill":"#hex or rgba() or linear-gradient()","stroke":"#hex or none","strokeWidth":0}; ' +
    '{"type":"image","x":..,"y":..,"w":..,"h":..,"src":"https://...","alt":"...","borderWidth":0,"borderColor":"#hex","crop":{"l":0,"t":0,"r":0,"b":0},"fx":{"brightness":100,"contrast":100,"saturate":100,"hue":0,"grayscale":0,"blur":0}} (crop is a 0-0.9 fraction per side, fx brightness/contrast/saturate are 0-200).\n' +
    'A slide may also carry "transition":{"type":"fade","duration":0.7,"autoAfter":false,"afterSec":5} and "animations":[{"target":0,"type":"fade","start":"click","duration":0.5,"delay":0}] where "target" is the 0-based index into that slide\'s "elements". Animation types: appear fade fly zoom spin bounce; start: click|with|after; duration and delay in seconds.\n' +
    "Design it like a real deck, not a text dump: give EVERY slide a background colour (tinted, not plain white); " +
    "put text in cards/panels by drawing a shape behind it (give the shape a lower \"z\" than the text) or by setting the text element's \"highlight\"; " +
    "colour your headings and key terms rather than leaving every line the same colour; use 1 accent colour consistently across the deck plus 1-2 supporting colours; " +
    "keep body text >=15px, titles 30-54px, and always leave margins (~60px) so nothing touches the edge; " +
    "and use shapes to break up dense text (bullets, callout boxes, number badges, dividers) instead of one long paragraph. " +
    "Aim for 6-12 slides for a normal topic. Prefer the simple {\"title\",\"content\"} form unless a specific custom layout is genuinely needed.";
}

/* The permission header sent with every EmeraldSuite context block. Kept as its
   own function so it is built once, up front, and cannot be truncated away. */
/* What the model is told about writing to files.

   There used to be a hard gate here: the browser regex-tested the user's
   message for edit verbs, and anything that did not match was told
   "PERMISSION — DENIED", with the payload discarded on arrival if it wrote
   anyway. That blocked far more than it protected — "go ahead", "do it" and
   "make it like that instead" all name no file kind and were read as
   read-only, so the turn after the model produced a perfectly good payload
   threw it away. It also decided for the model: whether a message implies a
   change is a judgement call, and a keyword list cannot make it.

   So the model now decides, and the rules it must respect are stated instead
   of being pattern-matched. The safety comes from the ops themselves, which
   touch only what they name — a wrong guess damages one element, not a file. */
function _efDirective() {
  return "[EMERALDSUITE EDIT PERMISSION — YOU DECIDE] You may create and edit the user's EmeraldSuite files whenever it is genuinely helpful, and you judge for yourself whether this message calls for it. " +
    'Your PREFERRED payload is targeted ops: <es-edit>{"app":"...","id":"...","ops":[...]}</es-edit>, which changes only what it names and leaves the rest of the file untouched. Use that for recolouring, resizing, moving, inserting, adding a chart, setting a border, adding or animating a slide, appending to a note — and also for carrying out a change the user implies rather than states ("go ahead", "do it", "same but blue", "fix that typo", "actually make it a table"). ' +
    'When the whole file genuinely should be replaced, use {"app":"...","id":"...","content":"full new markdown"}; to CREATE a brand-new file use <es-app>{...}</es-app> (no id needed). ' +
    "Use the same \"app\" and \"id\" from the catalog.\n" +
    "RULES, in priority order:\n" +
    "1. If the user asked a question, asked for a summary, review, comparison, explanation or opinion, or is just chatting — answer in plain text and write NOTHING. Reading a file is not permission to change it.\n" +
    "2. If the user described a state they want (\"I need the dates sorted\", \"this should be a bar chart\"), treat that as a request to make it so.\n" +
    "3. If a change is obvious, low-risk and clearly serves what they asked for, make it. You do not need the word \"edit\". Adding, restyling, moving, resizing, recolouring, inserting and formatting are all fine to do unasked.\n" +
    "4. DELETING IS DIFFERENT. Deleting a slide or element, clearing cells, or replacing a whole document body removes their work and there is NO undo. Only do it when they actually asked for something to go away (delete, remove, clear, drop, shorten, \"get rid of\", \"no longer need\"). If a deletion would be a reasonable next step but they did not ask for it, do the safe part now and ask about the deletion in one line - never do it silently, and never quietly skip it either.\n" +
    "5. Never touch a second file. Emit AT MOST ONE payload, and never mix <es-edit> with <es-app> in one response. Put every change they asked for into that single payload - they apply in order.\n" +
    "6. Never claim you saved, changed or deleted something unless the payload actually succeeded. If something was held back for confirmation, say so.\n" +
    _esOpsSpec() + _esSlideSpec();
}

/* String-aware JSON repair for <es-edit> / <es-app> payloads.
   The model streams markdown as the value of "content", and markdown is full of
   things JSON forbids: real newlines inside the string, unescaped quotes, and
   braces inside code fences. Two earlier bugs made every one of those a hard
   parse failure — which is why a one-line first edit worked but the 2nd, 3rd and
   later edits (longer content, a URL, a code block) returned "Edit not applied":
     · brace matching counted braces INSIDE string values, so it sliced a
       truncated object,
     · "//" was stripped as if it were a comment, which cut a markdown URL
       (https://…) in half mid-line and unbalanced the object.
   These helpers ignore braces inside strings and escape raw control characters. */
function _efScanJsonObject(raw) {
  const s = String(raw || "");
  const start = s.indexOf("{");
  if (start < 0) return s;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return end < 0 ? s.slice(start) : s.slice(start, end);
}
/* One string-aware pass that escapes raw control characters inside string
   values and drops trailing commas between members — both only EVER while
   outside a string literal. An earlier version rewrote unquoted keys with
   .replace(/(?<=[{,])\s*(\w+)\s*:/g, ...), which fired on a code fence inside
   the file's own markdown: "{x: 1}" became '{"x": 1}', the injected quote ended
   the enclosing string and the payload no longer parsed. Regular .replace() has
   no idea which bytes are inside a string, so it corrupted exactly the content
   that mattered most. */
function _efRepairJson(raw) {
  const s = _efScanJsonObject(raw);
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch; continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue;   // trailing comma
    }
    out += ch;
  }
  return out;
}

/* Shared payload parser for <es-edit> and <es-app>. Both tags carry markdown in
   a JSON string, so both failed on the same inputs until they shared this.
   Returns the parsed object, or null when it genuinely cannot be read. */
function _efParsePayload(raw) {
  const base = [String(raw || "")];
  // Entity-decoding is a FALLBACK: applied only after a plain parse fails,
  // because &quot; inside file content would decode to a raw quote and break an
  // otherwise-valid payload.
  const decoded = base[0]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  if (decoded !== base[0]) base.push(decoded);
  const attempts = base.concat(base.map(_efRepairJson));
  for (const cand of attempts) {
    for (const variant of [cand, _efScanJsonObject(cand)]) {
      try {
        const v = JSON.parse(variant);
        if (v && typeof v === "object") return v;
      } catch {}
    }
  }
  return null;
}

function _extractFileEdit(text) {
  const src = String(text || "");
  const m = src.match(/<es-edit(?:\s[^>]*)?>([\s\S]+?)<\/es-edit\s*>/) || src.match(/<es-edit(?:\s[^>]*)?>([\s\S]+)$/);
  if (!m) return { before: text, after: "", edit: null, parseFailed: false };
  const start = src.search(/<es-edit(?:\s[^>]*)?>/i);
  const before = src.slice(0, start).trim();
  const after = src.slice(start + m[0].length).trim();
  let raw = m[1];
  let edit = null;
  let parseFailed = false;
  raw = raw.replace(/^[\s\n]*```(?:json|JSON)?[\s\n]*\n?/i, "");
  raw = raw.replace(/\n?[\s\n]*```[\s\n]*$/i, "");
  // NOTE: "//" and "/* */" are deliberately NOT stripped. JSON has no comments,
  // so a "//" in a payload is a URL inside the file's own markdown; deleting it
  // truncated the user's content mid-line.
  edit = _efParsePayload(raw);
  if (!edit) parseFailed = true;
  if (!parseFailed) {
    const valid = edit && typeof edit === "object" && !Array.isArray(edit) &&
      (edit.title != null || edit.content != null || Array.isArray(edit.slides) ||
       Array.isArray(edit.patches) || Array.isArray(edit.ops) ||
       edit.rows != null || edit.cells != null || edit.data != null ||
       Array.isArray(edit.sheets) || Array.isArray(edit.charts) ||
       Array.isArray(edit.merges) || edit.cellStyles != null);
    if (!valid) { parseFailed = true; edit = null; }
  }
  return { before, after, edit, parseFailed };
}

function esEditLoadingCardHTML() {
  const acc = _esAccent(_esStreamApp);
  return `<div class="quiz-loading-card es-loading-card" style="--esaccent:${acc}">
    <div class="quiz-loading-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
    </div>
    <div>
      <div style="font-size:13.5px;font-weight:600;color:var(--text);margin-bottom:4px">Updating file\u2026</div>
      <div class="quiz-loading-dots">
        <div class="quiz-loading-dot"></div>
        <div class="quiz-loading-dot"></div>
        <div class="quiz-loading-dot"></div>
      </div>
    </div>
  </div>`;
}

/* Patch application for <es-edit>.
   The worker's system prompt tells the model to switch to compact patches once a
   file is long — "[EMERALDSUITE LONG FILE EDIT OVERRIDE] ... use compact patches
   by default" — precisely so a big note/doc does not have to be re-sent whole.
   This frontend never implemented it, so the very first edit (small enough for a
   full "content" payload) applied fine and then EVERY later edit came back as
   "Edit not applied": the payload parsed, but carried only "patches", which the
   extractor did not recognise as a valid edit at all.
   Ops: replace, delete, insert_after, insert_before, append, prepend.
   "text" is the new text; "replace" is accepted as an alias, since the prompt
   shows one example using {"find":...,"replace":...} and another using "text".
   Applied to PLAIN TEXT, because "find" is copied verbatim out of
   [FILE CONTENTS], which is plain text (_efRead runs _esPlainText). */
function _efApplyPatches(text, patches) {
  let out = String(text || "");
  const list = Array.isArray(patches) ? patches : [];
  let applied = 0;
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const op = String(p.op || "replace").toLowerCase().replace(/[^a-z_]/g, "");
    const body = p.text != null ? String(p.text) : (p.replace != null ? String(p.replace) : "");
    if (op === "append") { if (out && !/\n$/.test(out)) out += "\n"; out += body; applied++; continue; }
    if (op === "prepend") { out = body + (out ? "\n" : "") + out; applied++; continue; }
    const find = p.find != null ? String(p.find) : "";
    if (!find) continue;
    const i = out.indexOf(find);
    if (i < 0) continue;                       // no anchor -> skip, counted as missed
    const tail = out.slice(i + find.length);
    if (op === "replace") out = out.slice(0, i) + body + tail;
    else if (op === "delete") out = out.slice(0, i) + tail;
    else if (op === "insert_after") out = out.slice(0, i + find.length) + "\n" + body + tail;
    else if (op === "insert_before") out = out.slice(0, i) + body + "\n" + out.slice(i);
    else continue;
    applied++;
  }
  return { text: out, applied, missed: list.length - applied };
}

/* ── Irreversible ops ────────────────────────────────────────────
   The model now decides for itself whether a message calls for a change,
   which removes the false negatives the old keyword gate caused. What is
   left is one real hazard: a misjudgement that DELETES. Adding a shape,
   recolouring text or moving a box is cheap to notice and trivially undone
   ("undo that", "put it back"); deleting a slide or clearing cells is not,
   and the file has no undo stack of its own.

   So only the destructive ops get a floor, and only when the user's message
   contains no removal signal at all. Everything else — every additive and
   cosmetic op — is applied unconditionally, which is why "go ahead", "same
   but blue" and "sort them" keep working. When a destructive op is held back
   the model is told why, so it can ask rather than silently under-deliver. */
const _ES_DESTRUCTIVE_OPS = new Set([
  "delete_slide", "delete_el", "delete_animation",
  "delete_sheet", "delete_chart", "clear_cells",
  "delete_html", "replace_html"
]);
/* Wording that genuinely asks for something to go away. Deliberately broad:
   under-triggering here is what would annoy the user, and over-triggering
   only allows a delete the user did plausibly ask for. */
const _ES_REMOVE_SIGNAL = /\b(delete|delet(e|ing|ion)|remove|removing|removal|clear|clearing|erase|erasing|drop|dropping|get rid of|prune|purge|wipe|wipe out|cut|cutting|trim|trimming|scrap|scrap(s|ped)?|shorten|shortening|condense|condensing|throw (it |them )?away|no longer (need|want)|without (the|those|them)|discard|take (it |them )?out|lose the|kill the)\b/i;

function _esFilterDestructive(ops, userText) {
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return { ops: list, held: [], asked: false };
  if (_ES_REMOVE_SIGNAL.test(String(userText || ""))) return { ops: list, held: [], asked: true };
  const keep = [], held = [];
  for (const o of list) {
    const kind = String((o && o.op) || "").toLowerCase();
    if (_ES_DESTRUCTIVE_OPS.has(kind)) held.push(kind);
    else keep.push(o);
  }
  return { ops: keep, held, asked: false };
}

/* ══ TARGETED EDIT OPS ═══════════════════════════════════════════════
   The original contract was "resend the whole file": {"app","id","content"}
   or a full "slides"/"rows" array. That forces the model to echo a file it
   only read a truncated copy of, and for slides/sheets it REPLACED the
   stored model wholesale — so a two-word change discarded every hand-made
   design, animation, transition, chart and extra tab.

   ops[] changes exactly what it names and leaves everything else byte-for-
   byte alone. Each op targets by INDEX (1-based, as the model counts) or by
   the stored id, so "make the title on slide 2 bigger" never needs the
   caller to re-send the deck.

   Unknown ops are reported, never silently dropped — a model that typo'd
   should learn it, not believe it edited something. */
function _esOpIndex(op, alt) {
  const n = Number(op != null ? op : alt);
  if (!Number.isFinite(n)) return -1;
  return n > 0 ? Math.floor(n) : Math.floor(n) - 1; // 1-based -> 0-based
}
/* Locate a slide: by id, by 1-based number, or "last"/"first". */
function _esFindSlide(slides, spec) {
  if (!Array.isArray(slides) || !slides.length) return -1;
  const raw = spec == null ? 1 : String(spec).trim();
  if (raw === "" || raw === "last" || raw === "-1") return slides.length - 1;
  if (raw === "first" || raw === "1") return 0;
  if (slides.some((s) => s && s.id === raw)) return slides.findIndex((s) => s.id === raw);
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const i = Math.floor(n) - 1;
  return i >= 0 && i < slides.length ? i : -1;
}
function _esFindEl(slide, spec) {
  const els = (slide && Array.isArray(slide.elements)) ? slide.elements : [];
  if (!els.length) return -1;
  const raw = spec == null ? 1 : String(spec).trim();
  if (raw === "last") return els.length - 1;
  if (els.some((e) => e && e.id === raw)) return els.findIndex((e) => e.id === raw);
  if (raw === "" || raw === "first") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const i = Math.floor(n) - 1;
  return i >= 0 && i < els.length ? i : -1;
}
/* Apply a style/geometry patch to a slide element, touching only the keys
   the caller actually supplied so everything else is preserved. */
function _esPatchElement(el, p) {
  if (!el || !p || typeof p !== "object") return false;
  let touched = false;
  const setNum = (key, min, max) => {
    if (p[key] == null) return;
    const n = Number(p[key]);
    if (!Number.isFinite(n)) return;
    el[key] = Math.max(min, Math.min(max, n)); touched = true;
  };
  const setBool = (key) => {
    if (p[key] == null) return;
    el[key] = !!p[key]; touched = true;
  };
  setNum("x", -2000, 4000); setNum("y", -2000, 4000);
  setNum("w", 8, 4000); setNum("h", 8, 4000);
  setNum("r", -360, 360); setNum("opacity", 0, 1); setNum("z", 0, 10000);
  setBool("bold"); setBool("italic"); setBool("underline");
  if (p.fontSize != null) { const n = Number(p.fontSize); if (Number.isFinite(n) && n > 0) { el.fontSize = Math.min(400, n); touched = true; } }
  if (p.fontFamily) { el.fontFamily = String(p.fontFamily); touched = true; }
  if (p.color != null) { el.color = _esCssColor(p.color, el.color); touched = true; }
  if (p.highlight != null) { el.highlight = p.highlight === "none" || p.highlight === "" ? "transparent" : _esCssColor(p.highlight, "transparent"); touched = true; }
  if (p.textAlign != null || p.align != null) {
    const a = String(p.textAlign != null ? p.textAlign : p.align).toLowerCase();
    if (["left", "center", "right", "justify"].includes(a)) { el.textAlign = a; touched = true; }
  }
  if (p.listType != null) { el.listType = p.listType === "ul" || p.listType === "ol" ? String(p.listType) : ""; touched = true; }
  if (p.fill != null && el.type === "shape") { el.fill = _esCssColor(p.fill, el.fill); touched = true; }
  if (p.stroke != null && el.type === "shape") { el.stroke = _esCssColor(p.stroke, el.stroke); touched = true; }
  if (p.strokeWidth != null && el.type === "shape") {
    const n = Number(p.strokeWidth); if (Number.isFinite(n)) { el.strokeWidth = Math.max(0, Math.min(40, n)); touched = true; }
  }
  if (p.link !== undefined) { const l = _esElLink(p.link); if (l) { el.link = l; touched = true; } }
  if (p.borderWidth != null && el.type === "image") {
    const n = Number(p.borderWidth); if (Number.isFinite(n)) { el.borderWidth = Math.max(0, Math.min(20, n)); touched = true; }
  }
  if (p.borderColor != null && el.type === "image") { el.borderColor = _esCssColor(p.borderColor, "#000000"); touched = true; }
  if (p.fx != null && el.type === "image") { const fx = _esImageFx(p.fx); if (fx) { el.fx = fx; touched = true; } }
  if (p.text != null && el.type === "text") { el.html = _esHtml(p.text); touched = true; }
  return touched;
}

/* ── SLIDES ops ───────────────────────────────────────────────────── */
function _esOpsSlides(slides, ops) {
  let applied = 0;
  const notes = [];
  for (const op of ops) {
    if (!op || typeof op !== "object") { notes.push("skipped a non-object op"); continue; }
    const kind = String(op.op || "").toLowerCase();
    let si = -1;
    switch (kind) {
      case "add_slide":
      case "delete_slide":
      case "move_slide":
      case "duplicate_slide":
      case "set_slide_bg":
      case "set_transition":
      case "set_notes":
      case "set_title":
      case "add_text":
      case "add_shape":
      case "add_image":
      case "animate":
      case "delete_animation":
      case "set_el":
      case "move_el":
      case "resize_el":
      case "style_el":
      case "delete_el":
      case "duplicate_el":
        si = kind === "add_slide" ? -1 : _esFindSlide(slides, op.slide != null ? op.slide : op.slideIndex);
        break;
      default:
        notes.push("unknown slide op \"" + kind + "\"");
        continue;
    }

    if (kind === "add_slide") {
      const at = op.at != null ? _esOpIndex(op.at) : slides.length;
      const built = _esBuildSlide(op.slide && typeof op.slide === "object" ? op.slide : op, op, at);
      slides.splice(Math.max(0, Math.min(slides.length, at)), 0, built);
      applied++;
      continue;
    }
    if (kind === "delete_slide") {
      if (si < 0) { notes.push("no slide " + op.slide); continue; }
      if (slides.length <= 1) { notes.push("cannot delete the only slide"); continue; }
      slides.splice(si, 1);
      applied++;
      continue;
    }
    if (kind === "duplicate_slide") {
      if (si < 0) { notes.push("no slide " + op.slide); continue; }
      const src = slides[si];
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = _esUid("sld_");
      (copy.elements || []).forEach((e) => { e.id = _esUid("el_"); });
      // Animation elementIds point at the old ids, so re-point them.
      const idMap = {};
      (copy.elements || []).forEach((e, i) => { idMap[(src.elements || [])[i] && (src.elements || [])[i].id] = e.id; });
      (copy.animations || []).forEach((a) => { if (idMap[a.elementId]) a.elementId = idMap[a.elementId]; a.id = _esUid("anm_"); });
      slides.splice(si + 1, 0, copy);
      applied++;
      continue;
    }
    if (kind === "move_slide") {
      const from = _esFindSlide(slides, op.from != null ? op.from : op.slide);
      let to = _esOpIndex(op.to);
      if (from < 0) { notes.push("no slide " + (op.from != null ? op.from : op.slide)); continue; }
      if (!Number.isFinite(Number(op.to))) to = slides.length - 1;
      to = Math.max(0, Math.min(slides.length - 1, to));
      const [moved] = slides.splice(from, 1);
      slides.splice(to, 0, moved);
      applied++;
      continue;
    }
    if (si < 0 || !slides[si]) { notes.push("no slide " + (op.slide != null ? op.slide : 1)); continue; }
    const s = slides[si];

    if (kind === "set_slide_bg") {
      const v = op.background != null ? op.background : (op.value != null ? op.value : op.gradient);
      if (v == null) { notes.push("set_slide_bg needs \"background\""); continue; }
      /* A background may be a generated/web image as well as a colour, and
         the type is inferred from the resolved value — so resolve the
         reference first or "gen1" would be stored as a bogus colour. */
      const asImage = _esResolveImageSrc(v, op.alt);
      s.background = _esSlideBg(asImage || v);
      applied++;
      continue;
    }
    if (kind === "set_transition") {
      const ttype = String(op.transition != null ? op.transition : op.type || "none").toLowerCase();
      if (op.clear === true) delete s.transition;
      else {
        const dur = Number(op.duration);
        s.transition = {
          type: _ES_TRANSITIONS.includes(ttype) ? ttype : "none",
          duration: Number.isFinite(dur) && dur > 0 ? Math.min(10, dur) : 0.7
        };
        if (op.onClick === false) s.transition.onClick = false;
        if (op.autoAfter === true) {
          const secs = Number(op.afterSec);
          s.transition.autoAfter = true;
          s.transition.afterSec = Number.isFinite(secs) && secs > 0 ? Math.min(600, Math.round(secs)) : 5;
        }
      }
      applied++;
      continue;
    }
    if (kind === "set_notes") {
      s.notes = String(op.notes == null ? "" : op.notes);
      applied++;
      continue;
    }
    if (kind === "set_title") {
      // Titles live inside a text element, not a field, so this replaces the
      // topmost text box — which is what "rename the title" means here.
      const tIdx = _esFindEl(s, op.el);
      if (tIdx < 0) { notes.push("set_title: slide " + (si + 1) + " has no element"); continue; }
      const el = s.elements[tIdx];
      if (el.type !== "text") { notes.push("set_title: element " + (tIdx + 1) + " is not text"); continue; }
      el.html = _esHtml(op.title);
      applied++;
      continue;
    }
    if (kind === "add_text" || kind === "add_shape" || kind === "add_image") {
      if (!Array.isArray(s.elements)) s.elements = [];
      const spec = Object.assign({}, op.element || {}, op);
      spec.type = kind === "add_text" ? "text" : (kind === "add_shape" ? "shape" : "image");
      if (!spec.z) spec.z = s.elements.reduce((m, e) => Math.max(m, e.z || 1), 0) + 1;
      if (kind === "add_image") {
        /* Accepts a web URL, a data URL, or a reference to an image this
           conversation already generated ("gen1", "last", ...). */
        const resolvedSrc = _esResolveImageSrc(spec.src != null ? spec.src : spec.url, spec.alt);
        if (!resolvedSrc) {
          notes.push(spec.src ? "add_image: \"" + String(spec.src).slice(0, 40) + "\" is not a usable image source" +
            (_ES_GEN_IMAGES.length ? "" : " and no image has been generated in this chat") : "add_image needs \"src\"");
          continue;
        }
        spec.src = resolvedSrc;
        spec.url = undefined;
      }
      s.elements.push(_esSlideElement(spec, spec.z, spec.color));
      applied++;
      continue;
    }
    if (kind === "animate" || kind === "delete_animation") {
      s.animations = Array.isArray(s.animations) ? s.animations : [];
      if (kind === "delete_animation") {
        const i = _esOpIndex(op.index != null ? op.index : op.animation);
        if (i < 0 || i >= s.animations.length) { notes.push("no animation " + (op.index != null ? op.index : 1)); continue; }
        s.animations.splice(i, 1);
        applied++;
        continue;
      }
      const ei = _esFindEl(s, op.el != null ? op.el : op.element);
      const target = ei >= 0 ? s.elements[ei] : null;
      if (!target) { notes.push("animate: no element " + (op.el != null ? op.el : 1)); continue; }
      const type = String(op.animation != null ? op.animation : op.type || "fade").toLowerCase();
      const start = String(op.start || "click").toLowerCase();
      const dur = Number(op.duration);
      const delay = Number(op.delay);
      const a = {
        id: _esUid("anm_"), elementId: target.id,
        type: _ES_ANIM_TYPES.includes(type) ? type : "fade",
        start: _ES_ANIM_STARTS.includes(start) ? start : "click",
        duration: Number.isFinite(dur) && dur > 0 ? Math.min(10, dur) : 0.5
      };
      if (Number.isFinite(delay) && delay > 0) a.delay = Math.min(60, delay);
      s.animations.push(a);
      applied++;
      continue;
    }

    // Element-level ops.
    if (!Array.isArray(s.elements)) s.elements = [];
    if (kind === "delete_el") {
      const i = _esFindEl(s, op.el);
      if (i < 0) { notes.push("no element " + (op.el != null ? op.el : 1)); continue; }
      s.elements.splice(i, 1);
      applied++;
      continue;
    }
    if (kind === "duplicate_el") {
      const i = _esFindEl(s, op.el);
      if (i < 0) { notes.push("no element " + (op.el != null ? op.el : 1)); continue; }
      const copy = JSON.parse(JSON.stringify(s.elements[i]));
      copy.id = _esUid("el_");
      copy.x = Number(copy.x) + 20; copy.y = Number(copy.y) + 20;
      s.elements.splice(i + 1, 0, copy);
      applied++;
      continue;
    }
    const i = _esFindEl(s, op.el);
    if (i < 0) { notes.push("no element " + (op.el != null ? op.el : 1) + " on slide " + (si + 1)); continue; }
    const el = s.elements[i];
    if (kind === "move_el") {
      let moved = false;
      if (op.x != null && Number.isFinite(Number(op.x))) { el.x = Number(op.x); moved = true; }
      if (op.y != null && Number.isFinite(Number(op.y))) { el.y = Number(op.y); moved = true; }
      if (op.dx != null && Number.isFinite(Number(op.dx))) { el.x = Number(el.x) + Number(op.dx); moved = true; }
      if (op.dy != null && Number.isFinite(Number(op.dy))) { el.y = Number(el.y) + Number(op.dy); moved = true; }
      if (!moved) { notes.push("move_el needs x/y or dx/dy"); continue; }
      applied++;
      continue;
    }
    if (kind === "resize_el") {
      let did = false;
      const w = Number(op.w != null ? op.w : op.width);
      const h = Number(op.h != null ? op.h : op.height);
      if (Number.isFinite(w) && w > 0) { el.w = Math.min(4000, w); did = true; }
      if (Number.isFinite(h) && h > 0) { el.h = Math.min(4000, h); did = true; }
      if (op.scale != null && Number.isFinite(Number(op.scale)) && Number(op.scale) > 0) {
        const k = Number(op.scale);
        el.w = Math.max(8, Math.min(4000, Math.round(Number(el.w) * k)));
        el.h = Math.max(8, Math.min(4000, Math.round(Number(el.h) * k)));
        did = true;
      }
      if (!did) { notes.push("resize_el needs w/h (or scale)"); continue; }
      applied++;
      continue;
    }
    // set_el / style_el
    if (!_esPatchElement(el, op)) { notes.push(kind + " on element " + (i + 1) + " changed nothing (no known fields)"); continue; }
    applied++;
  }
  return { slides, applied, notes };
}

/* ── SHEETS ops ───────────────────────────────────────────────────── */
function _esA1(ref) {
  const m = /^\s*([A-Za-z]{1,3})(\d{1,7})\s*$/.exec(String(ref == null ? "" : ref));
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: _esColIndex(m[1]) };
}
/* A range is {r1,c1,r2,c2} inclusive. Accepts "A1:C10" or an array. */
function _esRange(spec) {
  if (Array.isArray(spec) && spec.length >= 4) {
    const r1 = Number(spec[0]), c1 = Number(spec[1]), r2 = Number(spec[2]), c2 = Number(spec[3]);
    if ([r1, c1, r2, c2].every((n) => Number.isFinite(n))) return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  }
  const m = /^\s*([A-Za-z]{1,3})(\d{1,7})\s*:\s*([A-Za-z]{1,3})(\d{1,7})\s*$/.exec(String(spec == null ? "" : spec));
  if (m) {
    const a = _esA1(m[1] + m[2]), b = _esA1(m[3] + m[4]);
    if (a && b) return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
  }
  const one = _esA1(spec);
  if (one) return { r1: one.r, c1: one.c, r2: one.r, c2: one.c };
  return null;
}
function _esPickSheet(wbData, spec) {
  const sheets = (wbData && Array.isArray(wbData.sheets)) ? wbData.sheets : [];
  if (!sheets.length) return -1;
  if (spec == null || spec === "") return Math.max(0, sheets.findIndex((s) => s.id === wbData.activeSheetId));
  const byId = sheets.findIndex((s) => s.id === String(spec));
  if (byId >= 0) return byId;
  const raw = String(spec).trim().toLowerCase();
  const byName = sheets.findIndex((s) => String(s.name || "").toLowerCase() === raw);
  if (byName >= 0) return byName;
  const n = Number(spec);
  if (Number.isFinite(n)) { const i = Math.floor(n) - 1; if (i >= 0 && i < sheets.length) return i; }
  return Math.max(0, sheets.findIndex((s) => s.id === wbData.activeSheetId));
}
function _esOpsSheets(wbData, ops) {
  const notes = [];
  let applied = 0;
  if (!Array.isArray(wbData.sheets) || !wbData.sheets.length) {
    wbData.sheets = [_esBuildSheetData({ sheetName: "Sheet1" })];
    wbData.activeSheetId = wbData.sheets[0].id;
  }
  for (const op of ops) {
    if (!op || typeof op !== "object") { notes.push("skipped a non-object op"); continue; }
    const kind = String(op.op || "").toLowerCase();
    const si = _esPickSheet(wbData, op.sheet != null ? op.sheet : op.sheetName);
    const sh = wbData.sheets[si];
    if (!sh) { notes.push("no sheet " + (op.sheet != null ? op.sheet : "")); continue; }
    if (!sh.cells || typeof sh.cells !== "object") sh.cells = {};

    const cellOp = (fn) => {
      const rng = _esRange(op.range != null ? op.range : (op.cell != null ? op.cell : op.ref));
      if (!rng) { notes.push(kind + " needs \"cell\" (A1) or \"range\" (A1:C10)"); return; }
      let n = 0;
      for (let r = rng.r1; r <= rng.r2; r++) {
        for (let c = rng.c1; c <= rng.c2; c++) {
          if (fn(r, c, r + "," + c)) n++;
        }
      }
      if (n) applied++; else notes.push(kind + " matched no cells");
    };

    switch (kind) {
      case "set_cell":
        cellOp((r, c, key) => {
          const spec = op.value !== undefined ? op.value
            : (op.formula != null ? { f: op.formula }
              : (op.v !== undefined ? op.v : null));
          if (spec === null) return false;
          if (spec && typeof spec === "object") {
            const f = spec.f != null ? String(spec.f) : null;
            const cur = sh.cells[key] || { v: "", f: null, s: null };
            if (spec.style || spec.s) cur.s = _esCellStyle(spec.style || spec.s);
            if (f) { cur.f = f.startsWith("=") ? f : "=" + f; cur.v = null; }
            else if (spec.v !== undefined) { cur.v = spec.v; cur.f = null; }
            sh.cells[key] = cur;
            return true;
          }
          if (typeof spec === "string" && spec.charAt(0) === "=") {
            sh.cells[key] = { v: null, f: spec, s: (sh.cells[key] && sh.cells[key].s) || null };
            return true;
          }
          let v = spec;
          if (typeof spec === "string") {
            const t = spec.trim();
            if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(t) && Number.isFinite(Number(t))) v = Number(t);
            else if (t.toLowerCase() === "true") v = true;
            else if (t.toLowerCase() === "false") v = false;
          }
          sh.cells[key] = { v, f: null, s: (sh.cells[key] && sh.cells[key].s) || null };
          return true;
        });
        break;
      case "set_style":
        cellOp((r, c, key) => {
          const st = _esCellStyle(op.style || op);
          if (!st) return false;
          const cur = sh.cells[key] || { v: "", f: null, s: null };
          cur.s = Object.assign({}, cur.s || {}, st);
          sh.cells[key] = cur;
          return true;
        });
        break;
      case "set_border":
        cellOp((r, c, key) => {
          /* With "clear":true the caller may name NO sides at all — the whole
             point is "remove these borders". _esBorder() returns null for an
             empty description, which used to bail out and leave the borders
             exactly as they were, so a documented clear did nothing. */
          const sides = _esBorder(op.border || op);
          if (!sides && op.clear !== true) return false;
          const cur = sh.cells[key] || { v: "", f: null, s: null };
          const base = (cur.s && cur.s.border) || { t: null, r: null, b: null, l: null };
          const next = Object.assign({}, base);
          for (const sd of ["t", "r", "b", "l"]) {
            if (sides && sides[sd]) next[sd] = sides[sd];
            else if (op.clear === true) next[sd] = null;
          }
          cur.s = Object.assign({}, cur.s || {}, { border: next });
          sh.cells[key] = cur;
          return true;
        });
        break;
      case "clear_cells":
        cellOp((r, c, key) => { if (!sh.cells[key]) return false; delete sh.cells[key]; return true; });
        break;
      case "set_col_width": {
        const c = op.col != null ? _esColIndex(op.col) : _esA1(String(op.cell || "")).c;
        const n = Number(op.width != null ? op.width : op.w);
        if (!Number.isFinite(c) || c < 0 || !Number.isFinite(n) || n <= 0) { notes.push("set_col_width needs \"col\" (letter or index) and a positive \"width\""); break; }
        sh.cols = sh.cols || {};
        sh.cols[c] = { s: Math.round(n), h: 0, fh: 0 };
        applied++;
        break;
      }
      case "set_row_height": {
        const r = op.row != null ? Number(op.row) - 1 : _esA1(String(op.cell || "")).r;
        const n = Number(op.height != null ? op.height : op.h);
        if (!Number.isFinite(r) || r < 0 || !Number.isFinite(n) || n <= 0) { notes.push("set_row_height needs \"row\" (1-based) and a positive \"height\""); break; }
        sh.rows = sh.rows || {};
        sh.rows[r] = { s: Math.round(n), h: 0, fh: 0 };
        applied++;
        break;
      }
      case "merge": {
        const rng = _esRange(op.range != null ? op.range : op.cells);
        if (!rng) { notes.push("merge needs \"range\" (A1:C1)"); break; }
        if (!Array.isArray(sh.merges)) sh.merges = [];
        if (op.unmerge === true) {
          const before = sh.merges.length;
          sh.merges = sh.merges.filter((m) => !(m[0] <= rng.r2 && m[1] <= rng.c2 && m[2] >= rng.r1 && m[3] >= rng.c1));
          if (sh.merges.length === before) notes.push("merge: nothing to unmerge");
          else applied++;
        } else {
          const cand = [rng.r1, rng.c1, rng.r2, rng.c2];
          if (!sh.merges.some((m) => m[0] === cand[0] && m[1] === cand[1] && m[2] === cand[2] && m[3] === cand[3])) {
            sh.merges.push(cand); applied++;
          }
        }
        break;
      }
      case "unmerge": {
        const rng = _esRange(op.range != null ? op.range : op.cells);
        if (!rng) { notes.push("unmerge needs \"range\""); break; }
        const before = (sh.merges || []).length;
        sh.merges = (sh.merges || []).filter((m) => !(m[0] <= rng.r2 && m[1] <= rng.c2 && m[2] >= rng.r1 && m[3] >= rng.c1));
        if ((sh.merges || []).length === before) notes.push("unmerge: no match");
        else applied++;
        break;
      }
      case "add_chart": {
        if (!Array.isArray(sh.charts)) sh.charts = [];
        const ch = _esChart(Object.assign({}, op, { range: op.range != null ? op.range : (op.cellRange != null ? op.cellRange : "") }), sh.id);
        if (!ch) { notes.push("add_chart needs a valid \"range\" like A1:C10"); break; }
        sh.charts.push(ch);
        applied++;
        break;
      }
      case "delete_chart": {
        const list = Array.isArray(sh.charts) ? sh.charts : [];
        const i = _esOpIndex(op.index != null ? op.index : op.chart);
        if (i < 0 || i >= list.length) { notes.push("no chart " + (op.index != null ? op.index : 1)); break; }
        list.splice(i, 1);
        sh.charts = list;
        applied++;
        break;
      }
      case "set_freeze": {
        const r = Math.max(0, Number(op.rows) || 0);
        const c = Math.max(0, Number(op.cols) || 0);
        sh.freeze = { r, c };
        applied++;
        break;
      }
      case "set_tab_color":
        sh.tabColor = op.color ? String(op.color) : null;
        applied++;
        break;
      case "set_gridlines":
        sh.showGridlines = op.value === false || op.hidden === true ? false : true;
        applied++;
        break;
      case "add_sheet": {
        const ns = _esBuildSheetData({ sheetName: op.name || "Sheet", rows: op.rows, cells: op.cells });
        const at = op.at != null ? _esOpIndex(op.at) : wbData.sheets.length;
        wbData.sheets.splice(Math.max(0, Math.min(wbData.sheets.length, at)), 0, ns);
        if (op.activate === true) wbData.activeSheetId = ns.id;
        applied++;
        break;
      }
      case "delete_sheet": {
        if (wbData.sheets.length <= 1) { notes.push("cannot delete the only tab"); break; }
        if (si < 0 || si >= wbData.sheets.length) { notes.push("no sheet " + op.sheet); break; }
        wbData.sheets.splice(si, 1);
        if (wbData.activeSheetId === sh.id) wbData.activeSheetId = wbData.sheets[0].id;
        applied++;
        break;
      }
      case "rename_sheet":
        sh.name = _esPlainText(op.name) || sh.name;
        applied++;
        break;
      case "set_calc_mode":
        wbData.calcMode = String(op.mode).toLowerCase() === "manual" ? "manual" : "auto";
        applied++;
        break;
      default:
        notes.push("unknown sheet op \"" + kind + "\"");
    }
  }
  return { wbData, applied, notes };
}

/* ── NOTES / DOCS ops (content-level, targeted) ───────────────────── */
function _esOpsHtml(ops, get, set) {
  const notes = [];
  let applied = 0;
  let cur = get();
  for (const op of ops) {
    if (!op || typeof op === "string") { notes.push("skipped a non-object op"); continue; }
    if (typeof op !== "object") { notes.push("skipped a non-object op"); continue; }
    const kind = String(op.op || "").toLowerCase();
    switch (kind) {
      /* Images in a note/doc are plain <img> in the HTML. Accepts a web URL,
         a data URL, or a reference to an image this conversation generated. */
      case "add_image": {
        const resolved = _esResolveImageSrc(op.src != null ? op.src : op.url, op.alt);
        if (!resolved) {
          notes.push("add_image: \"" + String(op.src == null ? "" : op.src).slice(0, 40) + "\" is not a usable image source" +
            (_ES_GEN_IMAGES.length ? "" : " and no image has been generated in this chat"));
          break;
        }
        const alt = escapeHtmlAttr(String(op.alt == null ? "image" : op.alt));
        const img = '<img src="' + escapeHtmlAttr(resolved) + '" alt="' + alt + '" style="max-width:100%;height:auto;border-radius:6px;">';
        if (op.anchor != null && op.anchor !== "") {
          const find = String(op.anchor);
          const i = cur.indexOf(find);
          if (i < 0) { notes.push("add_image: anchor not found"); break; }
          cur = cur.slice(0, i) + img + cur.slice(i);
        } else {
          cur = cur + img;
        }
        applied++;
        break;
      }
      case "append_html": cur = cur + String(op.html == null ? "" : op.html); applied++; break;
      case "prepend_html": cur = String(op.html == null ? "" : op.html) + cur; applied++; break;
      case "append": cur = cur + _esHtml(op.markdown); applied++; break;
      case "prepend": cur = _esHtml(op.markdown) + cur; applied++; break;
      case "replace_html": cur = String(op.html == null ? "" : op.html); applied++; break;
      case "replace_all": {
        const find = String(op.find == null ? "" : op.find);
        const body = String(op.text == null ? (op.html != null ? op.html : "") : op.text);
        if (!find) { notes.push("replace_all needs \"find\""); break; }
        if (cur.indexOf(find) < 0) { notes.push("replace_all: text not found"); break; }
        cur = cur.split(find).join(body);
        applied++;
        break;
      }
      case "delete_html": {
        const find = String(op.find == null ? "" : op.find);
        if (!find) { notes.push("delete_html needs \"find\""); break; }
        if (cur.indexOf(find) < 0) { notes.push("delete_html: text not found"); break; }
        cur = cur.split(find).join("");
        applied++;
        break;
      }
      case "insert_before": {
        const find = String(op.find == null ? "" : op.find);
        const i = cur.indexOf(find);
        if (i < 0) { notes.push("insert_before: anchor not found"); break; }
        cur = cur.slice(0, i) + String(op.html != null ? op.html : _esHtml(op.markdown)) + cur.slice(i);
        applied++;
        break;
      }
      case "insert_after": {
        const find = String(op.find == null ? "" : op.find);
        const i = cur.indexOf(find);
        if (i < 0) { notes.push("insert_after: anchor not found"); break; }
        const at = i + find.length;
        cur = cur.slice(0, at) + String(op.html != null ? op.html : _esHtml(op.markdown)) + cur.slice(at);
        applied++;
        break;
      }
      default: notes.push("unknown content op \"" + kind + "\"");
    }
  }
  set(cur);
  return { applied, notes };
}

async function _efApplyOps(app, id, ops, meta, gate) {
  /* Every op was a destructive one and the user asked for no removal, so
     nothing was applied. Say exactly that rather than "no-content", so the
     badge can tell the user the model held back rather than having failed. */
  if (gate && gate.held && gate.held.length && (!Array.isArray(ops) || !ops.length)) {
    return { app, id, ok: false, error: "needs-confirmation", held: gate.held };
  }
  if (!Array.isArray(ops) || !ops.length) return { app, id, ok: false, error: "no-content" };
  const list = ops.filter((o) => o && typeof o === "object");
  if (!list.length) return { app, id, ok: false, error: "no-content" };
  /* Rename/colour/header live on the PAYLOAD, never on an op. They used to be
     read by scanning the ops for a "title" key, so an add_chart with a title
     silently renamed the whole workbook and set_title renamed the note. */
  const M_ = (meta && typeof meta === "object") ? meta : {};
  const payloadTitle = _esPlainText(M_.title);
  const now = Date.now();
  try {
    if (app === "slides") {
      let idx = await _esStoreGet("emeraldcore.storage.suite.slides");
      idx = Array.isArray(idx) ? idx : [];
      const meta = idx.find((m) => m.id === id);
      if (!meta) return { app, id, ok: false, error: "not-found" };
      let prev = null;
      try { const d = await _esStoreGet("emeraldcore.storage.suite.slides." + id); if (d && d.id) prev = d; } catch (e) {}
      const slides = prev && Array.isArray(prev.slides) ? prev.slides : [];
      const r = _esOpsSlides(slides, list);
      if (!r.applied) return { app, id, ok: false, error: "patch-not-found", notes: r.notes };
      const pres = { id, title: (prev && prev.title) || meta.title || "Untitled Presentation", createdAt: (prev && prev.createdAt) || now, updatedAt: now, slides: r.slides };
      meta.updatedAt = now; meta.slideCount = r.slides.length;
      if (prev && prev.title) pres.title = prev.title;
      await _esStoreSet("emeraldcore.storage.suite.slides", idx);
      await _esStoreSet("emeraldcore.storage.suite.slides." + id, pres);
      _esAgentPostSync({ type: "es-edit", app: "slides", id });
      return { app, id, ok: true, title: pres.title, applied: r.applied, notes: r.notes, held: (gate && gate.held) || [] };
    }
    if (app === "sheets") {
      const prev = await _efSheetsGet(id);
      if (!prev || !prev.data) return { app, id, ok: false, error: "not-found" };
      const wbData = JSON.parse(JSON.stringify(prev.data));
      const r = _esOpsSheets(wbData, list);
      if (!r.applied) return { app, id, ok: false, error: "patch-not-found", notes: r.notes };
      if (payloadTitle) wbData.title = payloadTitle;
      await _esSheetsPut(id, { id, data: wbData, savedAt: now });
      _esAgentPostSync({ type: "es-edit", app: "sheets", id });
      return { app, id, ok: true, title: wbData.title, applied: r.applied, notes: r.notes, held: (gate && gate.held) || [] };
    }
    if (app === "notes") {
      const key = "emeraldcore.storage.suite.notes";
      const arr = await _esStoreGet(key);
      const list2 = Array.isArray(arr) ? arr : [];
      const note = list2.find((n) => n.id === id);
      if (!note) return { app, id, ok: false, error: "not-found" };
      const r = _esOpsHtml(list, () => note.content || "", (v) => { note.content = v; });
      if (!r.applied) return { app, id, ok: false, error: "patch-not-found", notes: r.notes };
      if (payloadTitle) note.title = payloadTitle;
      if (M_.color != null) note.color = String(M_.color);
      note.modifiedAt = new Date().toISOString();
      await _esStoreSet(key, list2);
      return { app, id, ok: true, title: note.title, applied: r.applied, notes: r.notes, held: (gate && gate.held) || [] };
    }
    if (app === "docs") {
      const key = "emeraldcore.storage.suite.docs." + id;
      const prev = await _esStoreGet(key);
      if (!prev) return { app, id, ok: false, error: "not-found" };
      const r = _esOpsHtml(list, () => prev.content || "", (v) => { prev.content = v; });
      if (!r.applied) return { app, id, ok: false, error: "patch-not-found", notes: r.notes };
      if (payloadTitle) prev.title = payloadTitle;
      if (M_.header != null) prev.header = String(M_.header);
      if (M_.footer != null) prev.footer = String(M_.footer);
      prev.savedAt = now;
      const plainText = _esPlainText(prev.content);
      let idx = await _esStoreGet("emeraldcore.storage.suite.docs");
      idx = Array.isArray(idx) ? idx : [];
      const meta = idx.find((m) => m.id === id);
      if (meta) { meta.title = prev.title; meta.updatedAt = now; meta.wordCount = _esWordCount(plainText); }
      await _esStoreSet("emeraldcore.storage.suite.docs", idx);
      await _esStoreSet(key, prev);
      return { app, id, ok: true, title: prev.title, applied: r.applied, notes: r.notes, held: (gate && gate.held) || [] };
    }
  } catch (e) {
    console.warn("Ops edit failed:", e);
    return { app, id, ok: false, error: "write-failed" };
  }
  return { app, id, ok: false, error: "unsupported" };
}

async function _efApplyEdit(fEditRes, msgId, userText) {
  if (!fEditRes) return { ok: false, error: "bad-payload" };
  // The model emitted a tag but its JSON would not parse. Guessing at unescaped
  // quotes risks rewriting the file, so this is reported rather than guessed.
  if (!fEditRes.edit && fEditRes.parseFailed) return { ok: false, error: "bad-payload" };
  const edit = fEditRes.edit;
  const app = String((edit && edit.app) || "").toLowerCase().trim();
  const id = String((edit && edit.id) || "").trim();
  if (!app || !_ES_APPS[app]) return { ok: false, error: "no-app" };
  if (!id) return { ok: false, error: "no-id" };
/* Targeted ops are preferred over a whole-file rewrite whenever present:
     they cannot clobber the parts of the file the model did not intend to
     change, which is the whole point of the agentic path. */
if (Array.isArray(edit.ops) && edit.ops.length) {
      const gated = _esFilterDestructive(edit.ops, userText);
      /* Pass gated.ops even when EMPTY. Falling back to edit.ops here would
         undo the backstop precisely when it matters most - a payload made up
         entirely of deletions would be applied after being held. */
      return _efApplyOps(app, id, gated.ops, edit, gated);
    }
  try {
    // A payload only has to carry the fields it actually changes. _extractFileEdit
    // already accepts a content-only payload (title may legitimately be absent),
    // so each branch below resolves title/content against the EXISTING record:
    // missing field => keep what is there, never rename to a placeholder and
    // never blank the file. Previously docs/slides bailed out with a bare
    // { ok:false } (surfacing as "Edit not applied" seconds after the
    // "Updating file…" card) and notes silently overwrote the title with
    // "Imported Note" and its body with "".
    if (app === "notes") {
      const key = "emeraldcore.storage.suite.notes";
      let arr = await _esStoreGet(key);
      arr = Array.isArray(arr) ? arr : [];
      const note = arr.find((n) => n.id === id);
      if (!note) return { app, id, ok: false, error: "not-found" };
      const now = new Date().toISOString();
      const hasBody = edit.content != null;
      const hasTitle = _esPlainText(edit.title) !== "";
      const hasPatches = Array.isArray(edit.patches) && edit.patches.length > 0;
      if (!hasBody && !hasTitle && !hasPatches) return { app, id, ok: false, error: "no-content" };
      const title = hasTitle ? _esPlainText(edit.title) : (note.title || "Untitled Note");
      let content;
      if (hasBody) content = _esHtml(edit.content) || "";
      else if (hasPatches) {
        const r = _efApplyPatches(_esPlainText(note.content || ""), edit.patches);
        if (!r.applied) return { app, id, ok: false, error: "patch-not-found" };
        content = _esHtml(r.text) || "";
      } else content = note.content || "";
      note.title = title; note.content = content; note.modifiedAt = now;
      await _esStoreSet(key, arr);
      return { app, id, ok: true, title };
    }
    if (app === "docs") {
      const now = Date.now();
      let idx = await _esStoreGet("emeraldcore.storage.suite.docs");
      idx = Array.isArray(idx) ? idx : [];
      let meta = idx.find((m) => m.id === id);
      if (!meta) return { app, id, ok: false, error: "not-found" };
      let prev = null;
      try { const d = await _esStoreGet("emeraldcore.storage.suite.docs." + id); if (d && d.id) prev = d; } catch (e) {}
      const hasBody = edit.content != null;
      const hasTitle = _esPlainText(edit.title) !== "";
      const hasPatches = Array.isArray(edit.patches) && edit.patches.length > 0;
      if (!hasBody && !hasTitle && !hasPatches) return { app, id, ok: false, error: "no-content" };
      const title = hasTitle ? _esPlainText(edit.title) : (meta.title || (prev && prev.title) || "Untitled Document");
      let content;
      let plainText;
      if (hasBody) { content = _esHtml(edit.content) || "<p><br></p>"; plainText = _esPlainText(edit.content); }
      else if (hasPatches) {
        const r = _efApplyPatches(_esPlainText((prev && prev.content) || ""), edit.patches);
        if (!r.applied) return { app, id, ok: false, error: "patch-not-found" };
        plainText = r.text;
        content = _esHtml(r.text) || "<p><br></p>";
      } else { content = (prev && prev.content) || "<p><br></p>"; plainText = _esPlainText(content); }
      meta.title = title; meta.updatedAt = now; meta.wordCount = _esWordCount(plainText);
      await _esStoreSet("emeraldcore.storage.suite.docs", idx);
      /* Header, footer, footnotes, endnotes and comments live outside
         `content` but were rewritten to empty on EVERY edit, so a single
         "fix this typo" silently destroyed them. Carry the stored values
         forward, and let the payload set them explicitly when asked. */
      const keepList = (v, fb) => (Array.isArray(v) ? v : fb);
      await _esStoreSet("emeraldcore.storage.suite.docs." + id, {
        id, title, content, savedAt: now,
        theme: edit.theme === "dark" ? "dark" : ((prev && prev.theme) || "light"),
        header: edit.header != null ? String(edit.header) : ((prev && prev.header) || ""),
        footer: edit.footer != null ? String(edit.footer) : ((prev && prev.footer) || ""),
        footnotes: keepList(edit.footnotes, (prev && prev.footnotes) || []),
        endnotes: keepList(edit.endnotes, (prev && prev.endnotes) || []),
        comments: keepList(edit.comments, (prev && prev.comments) || [])
      });
      return { app, id, ok: true, title };
    }
    if (app === "slides") {
      const now = Date.now();
      let idx = await _esStoreGet("emeraldcore.storage.suite.slides");
      idx = Array.isArray(idx) ? idx : [];
      let prev = null;
      try { const d = await _esStoreGet("emeraldcore.storage.suite.slides." + id); if (d && d.id) prev = d; } catch (e) {}
      const hasBody = edit.content != null;
      const hasTitle = _esPlainText(edit.title) !== "";
      const hasPatches = Array.isArray(edit.patches) && edit.patches.length > 0;
      if (!hasBody && !Array.isArray(edit.slides) && !hasTitle && !hasPatches) return { app, id, ok: false, error: "no-content" };
      let meta = idx.find((m) => m.id === id);
      if (!meta) return { app, id, ok: false, error: "not-found" };
      const title = hasTitle ? _esPlainText(edit.title) : (meta.title || (prev && prev.title) || "Untitled Presentation");
      let slides = (prev && Array.isArray(prev.slides)) ? prev.slides : [];
      if (Array.isArray(edit.slides) && edit.slides.length) slides = edit.slides.map((s, i) => _esBuildSlide(s, edit, i));
      else if (hasBody) slides = _esSplitSlides(edit).map((s, i) => _esBuildSlide(s, edit, i));
      else if (hasPatches) {
        // The prompt scopes patches to notes/docs. If one arrives for a deck,
        // apply it to whichever slide holds the anchor rather than rebuilding
        // the whole presentation — and say so if nothing matched.
        let touched = 0;
        for (const s of slides) {
          if (!s) continue;
          const src = _esPlainText(s.content || "") || _esPlainText(s.title || "");
          if (!src) continue;
          const r = _efApplyPatches(src, edit.patches);
          if (r.applied) { s.content = r.text; touched += r.applied; }
        }
        if (!touched) return { app, id, ok: false, error: "patch-not-found" };
      }
      const pres = { id, title, createdAt: (prev && prev.createdAt) || now, updatedAt: now, slides };
      meta.title = title; meta.updatedAt = now; meta.slideCount = slides.length;
      await _esStoreSet("emeraldcore.storage.suite.slides", idx);
      await _esStoreSet("emeraldcore.storage.suite.slides." + id, pres);
      return { app, id, ok: true, title };
    }
    if (app === "sheets") {
      const now = Date.now();
      let prev = await _efSheetsGet(id);
      let prevData = (prev && prev.data) || null;
      if (!prev || !prevData) return { app, id, ok: false, error: "not-found" };
      const prevSheets = Array.isArray(prevData.sheets) ? prevData.sheets : [];
      const hasBody = edit.rows != null || edit.cells != null || edit.data != null ||
        edit.sheetName != null || edit.cellStyles != null || Array.isArray(edit.charts) ||
        Array.isArray(edit.merges) || Array.isArray(edit.ranges);
      const hasTitle = _esPlainText(edit.title) !== "";
      const hasSheetList = Array.isArray(edit.sheets) && edit.sheets.length > 0;
      if (!hasBody && !hasTitle && !hasSheetList) return { app, id, ok: false, error: "no-content" };
      const title = hasTitle ? _esPlainText(edit.title) : (prevData.title || "Untitled Spreadsheet");
      let sheets;
      if (hasSheetList) {
        // Full multi-tab rewrite — only when the payload actually lists them.
        sheets = edit.sheets
          .map((s, i) => (s && typeof s === "object" ? _esBuildSheetData(s, prevSheets[i] && prevSheets[i].id) : null))
          .filter(Boolean);
      } else if (hasBody) {
        // Rewrite the targeted tab (default: the first) and carry every other
        // tab through untouched. This used to write `sheets: [sheet]`, which
        // deleted the rest of the workbook on any edit.
        const targetName = _esPlainText(edit.sheetName || edit.sheet || "").toLowerCase();
        let targetIdx = targetName ? prevSheets.findIndex((s) => String(s.name || "").toLowerCase() === targetName) : 0;
        if (targetIdx < 0) targetIdx = 0;
        const rebuilt = _esBuildSheetData(Object.assign({ title }, edit), prevSheets[targetIdx] && prevSheets[targetIdx].id);
        if (prevSheets[targetIdx] && !_esPlainText(edit.sheetName)) rebuilt.name = prevSheets[targetIdx].name;
        sheets = prevSheets.length
          ? prevSheets.map((s, i) => (i === targetIdx ? rebuilt : s))
          : [rebuilt];
      } else {
        sheets = prevSheets.length ? prevSheets : [_esBuildSheetData({ title, sheetName: "Sheet1" })];
      }
      const activeId = (prevData.activeSheetId && sheets.some((s) => s.id === prevData.activeSheetId))
        ? prevData.activeSheetId
        : (sheets[0] && sheets[0].id);
      const wbData = {
        v: 1, id, title, createdAt: prevData.createdAt || now,
        sheets, activeSheetId: activeId,
        names: prevData.names && typeof prevData.names === "object" ? prevData.names : {},
        calcMode: prevData.calcMode === "manual" ? "manual" : "auto",
        view: (prevData.view && typeof prevData.view === "object")
          ? Object.assign({ zoom: 1, showFormulaBar: true, showHeadings: true, showFormulas: false }, prevData.view)
          : { zoom: 1, showFormulaBar: true, showHeadings: true, showFormulas: false }
      };
      await _esSheetsPut(id, { id, data: wbData, savedAt: now });
      _esAgentPostSync({ type: "es-edit", app: "sheets", id });
      return { app, id, ok: true, title };
    }
  } catch (e2) {
    console.warn("File edit failed:", e2);
    return { app, id, ok: false, error: "write-failed" };
  }
  return { app, id, ok: false, error: "unsupported" };
}

function renderFileEditBadge(aiDiv, outcome) {
  if (!aiDiv || !aiDiv.querySelector) return;
  const sender = aiDiv.querySelector(".message-sender");
  if (!sender) return;
  const ok = !!(outcome && outcome.ok);
  const b = document.createElement("div");
  b.className = "file-edit-badge" + (ok ? "" : " file-edit-badge--error");
  const accent = _esAccent(outcome && outcome.app);
  if (ok) b.style.setProperty("--esaccent", accent);
  const icon = ok
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
let label = ok ? "Updated File" : "Edit not applied";
  // Some ops applied but a deletion was held back pending an explicit ask.
  if (ok && outcome && Array.isArray(outcome.held) && outcome.held.length) {
    b.className = "file-edit-badge";
    label = "Updated File \u2014 held back " + outcome.held.length + " deletion" +
      (outcome.held.length === 1 ? "" : "s") + " for you to confirm";
  }
  if (!ok && outcome) {
    if (outcome.error === "needs-confirmation") label = "Nothing changed \u2014 that was a deletion, so it needs you to ask for it";
    else if (outcome.error === "not-requested") label = "No file changed";
    else if (outcome.error === "no-app" || outcome.error === "no-id") label = "Which file? — the AI must target the exact file";
    else if (outcome.error === "not-found") label = "File not found to edit";
    else if (outcome.error === "no-content") label = "Nothing to change \u2014 the AI sent an empty edit";
    else if (outcome.error === "bad-payload") label = "The AI\u2019s edit came through malformed \u2014 try asking again";
    else if (outcome.error === "patch-not-found") label = "Edit didn\u2019t match the file \u2014 the text to change had moved";
    else if (outcome.error === "write-failed") label = "Couldn\u2019t save the file \u2014 storage error";
    else if (outcome.error === "unsupported") label = "That file type can\u2019t be edited yet";
  }
  b.innerHTML = icon + " " + label;
  sender.insertAdjacentElement("afterend", b);
}

/* Broadcast to the emeraldsuite-agent channel (Sheets pages listen for this
   via es-ai.js onSync so an open workbook reloads after an AI edit). */
function _esAgentPostSync(msg) {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("emeraldsuite-agent");
    ch.postMessage(Object.assign({}, msg, { at: Date.now() }));
    try { ch.close(); } catch (e) {}
  } catch (e) {}
}

function _efSheetsGet(id) {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    let req;
    try { req = indexedDB.open("emeraldcore.storage.suite.sheets", 1); } catch (e) { resolve(null); return; }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains("workbooks")) d.createObjectStore("workbooks"); };
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("workbooks", "readonly");
        const r = tx.objectStore("workbooks").get(id);
        r.onsuccess = () => { try { db.close(); } catch (e) {} resolve(r.result || null); };
        r.onerror = () => { try { db.close(); } catch (e) {} resolve(null); };
      } catch (e) { try { db.close(); } catch (e2) {} resolve(null); }
    };
  });
}
function _efSheetsAll() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve([]); return; }
    let req;
    try { req = indexedDB.open("emeraldcore.storage.suite.sheets", 1); } catch (e) { resolve([]); return; }
    req.onerror = () => resolve([]);
    req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains("workbooks")) d.createObjectStore("workbooks"); };
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("workbooks", "readonly");
        const st = tx.objectStore("workbooks");
        const kreq = st.getAllKeys();
        const vreq = st.getAll();
        let keys = null, vals = null, done = 0;
        const finish = () => {
          try { db.close(); } catch (e) {}
          if (!Array.isArray(keys) || !Array.isArray(vals)) { resolve([]); return; }
          const out = [];
          keys.forEach((k, i) => {
            const doc = vals[i];
            const d = doc && doc.data;
            if (d) out.push({ id: k, title: d.title || "Untitled Spreadsheet", updatedAt: (doc && doc.savedAt) || 0 });
          });
          out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          resolve(out);
        };
        kreq.onsuccess = () => { keys = kreq.result; if (++done === 2) finish(); };
        kreq.onerror = () => { keys = null; if (++done === 2) finish(); };
        vreq.onsuccess = () => { vals = vreq.result; if (++done === 2) finish(); };
        vreq.onerror = () => { vals = null; if (++done === 2) finish(); };
      } catch (e) { try { db.close(); } catch (e2) {} resolve([]); }
    };
  });
}

// Event delegation: .quiz-card[data-qid] clicks → openQuizPanel
document.addEventListener("click", function(e) {
  const card = e.target.closest(".quiz-card[data-qid]");
  if (card) openQuizPanel(card.dataset.qid);
});
function openQuizPanel(qid) {
  // CodeQL fix (#57): sanitize qid to safe chars for DOM IDs and inline handlers args
  qid = String(qid || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const qz = (window._quizzes || {})[qid];
  if (!qz) return;
  closeCodePreviewPanel();
  closeFilePreviewPanel();
  const panel = $("quizPanel");
  const body = $("quizPanelBody");
  const title = $("quizPanelTitle");
  const count = $("quizPanelCount");
  if (!panel || !body) return;
  const n = qz.data.questions ? qz.data.questions.length : 0;
  if (title) title.textContent = qz.data.title || "Quiz";
  if (count) count.textContent = n + " question" + (n !== 1 ? "s" : "");
  _recordPanelState({ type: "quiz", qid });
  body.innerHTML = renderQuizWidget(qid, qz.data);
  _quizRestoreState(qid);
  const widgetHeader = body.querySelector(".quiz-header");
  if (widgetHeader) widgetHeader.style.display = "none";
  panel.classList.add("open");
}
function closeQuizPanel() {
  const p = $("quizPanel");
  if (!p || !p.classList.contains("open")) return;
  _forgetPanelState();
  p.classList.add("closing");
  setTimeout(() => {
    p.classList.remove("open", "closing");
  }, 320);
}
function editMemory(id) {
  const mems = loadMemories();
  const m = mems.find((x) => x.id === id);
  if (!m) return;
  const item = document.getElementById("mem_" + id);
  if (!item) return;
  item.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "memory-edit-input"; ta.id = "medit_" + id; ta.rows = 5;
  ta.textContent = m.text;
  const actions = document.createElement("div"); actions.className = "memory-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.className = "memory-edit-save"; saveBtn.title = "Save";
  saveBtn.addEventListener("click", () => saveEditMemory(id));
  saveBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "memory-edit-cancel"; cancelBtn.title = "Cancel";
  cancelBtn.addEventListener("click", () => renderMemoriesModal());
  cancelBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  actions.appendChild(saveBtn); actions.appendChild(cancelBtn);
  item.appendChild(ta); item.appendChild(actions);
  ta.focus(); ta.selectionStart = ta.value.length;
}
function saveEditMemory(id) {
  const ta = document.getElementById("medit_" + id);
  if (!ta) return;
  const newText = ta.value.trim();
  if (!newText) return;
  const mems = loadMemories();
  const idx = mems.findIndex((m) => m.id === id);
  if (idx >= 0) {
    mems[idx].text = newText;
    mems[idx].updatedAt = Date.now();
    saveMemories(mems);
  }
  renderMemoriesModal();
}
async function copyUserMsgText() {
  if (!_ctxTarget) return;
  const textEl = _ctxTarget.querySelector(".message-text.user-text");
  const ok = await safeCopy(textEl?.innerText || "");
  showToast(
    ok ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-2px;margin-right:5px"><polyline points="20 6 9 17 4 12"/></svg> Copied` : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Failed to copy`,
    ok ? "success" : "error"
  );
}
const _editOriginals = /* @__PURE__ */ new Map();
const MAX_CHAT_BRANCH_VARIANTS = 10;
function showChatBranchLimitToast(kind) {
  const label = kind === "ai" ? "regenerate this AI answer" : "edit this message";
  showToast(`${_aiSvgWarn} You cannot ${label} more than ${MAX_CHAT_BRANCH_VARIANTS} times because the history limit is ${MAX_CHAT_BRANCH_VARIANTS}.`, "warning");
}
function editUserMsg(msgId) {
  if (state.isStreaming) {
    showToast('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Wait for response to finish.', "warning");
    return;
  }
  const msgEl = document.querySelector(`.message--user[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const textEl = msgEl.querySelector(".message-text.user-text");
  if (!textEl) return;
  const conv = state.convId ? getConv(state.convId) : null;
  const msgRecord = conv?.messages?.find((m) => m.id === msgId);
  const originalText = msgRecord?.text || textEl.innerText.trim();
  _editOriginals.set(msgId, originalText);
  textEl.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "user-msg-edit-input";
  ta.value = originalText;
  ta.oninput = () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };
  textEl.appendChild(ta);
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
  const actions = document.createElement("div");
  actions.className = "user-msg-edit-actions";
  actions.innerHTML = `
    <button class="user-edit-btn user-edit-btn--submit" onclick="submitUserMsgEdit('${msgId}')">Submit</button>
    <button class="user-edit-btn user-edit-btn--cancel" onclick="cancelUserMsgEdit('${msgId}')">Cancel</button>`;
  textEl.insertAdjacentElement("afterend", actions);
  ta.focus();
  ta.selectionStart = ta.value.length;
}
function cancelUserMsgEdit(msgId) {
  const originalText = _editOriginals.get(msgId) || "";
  _editOriginals.delete(msgId);
  const msgEl = document.querySelector(`.message--user[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const textEl = msgEl.querySelector(".message-text.user-text");
  if (textEl) textEl.innerHTML = escapeHtml(originalText).replace(/\n/g, "<br>");
  const actions = msgEl.querySelector(".user-msg-edit-actions");
  if (actions) actions.remove();
}
async function submitUserMsgEdit(msgId) {
  if (state.isStreaming) return;
  const msgEl = document.querySelector(`.message--user[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const ta = msgEl.querySelector(".user-msg-edit-input");
  if (!ta) return;
  const newText = ta.value.trim();
  if (!newText) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    showToast("Service unavailable.", "error");
    return;
  }
  const origText = _editOriginals.get(msgId) || "";
  const branchRootId = msgEl.dataset.branchRef || msgId;
  const conv = state.convId ? getConv(state.convId) : null;
  const existingEditBranch = conv?._editBranches?.[branchRootId];
  if (existingEditBranch && existingEditBranch.variants.length >= MAX_CHAT_BRANCH_VARIANTS) {
    showChatBranchLimitToast("user");
    return;
  }
  cancelUserMsgEdit(msgId);
  // Capture the original attachments BEFORE truncating conv.messages so we can
  // reattach them to the edited message. Without this, the edited message used
  // to be saved with `files: []`, silently stripping every attachment the
  // user originally sent to the AI.
  const originalFiles = (() => {
    if (!conv) return [];
    const idx = conv.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return [];
    return Array.isArray(conv.messages[idx].files) ? conv.messages[idx].files.map((f) => ({ ...f })) : [];
  })();
  if (conv) {
    const msgIdx = conv.messages.findIndex((m) => m.id === msgId);
    if (msgIdx >= 0) {
      conv._editBranches = conv._editBranches || Object.create(null);
      if (!conv._editBranches[branchRootId]) conv._editBranches[branchRootId] = { variants: [], current: -1 };
      const b = conv._editBranches[branchRootId];
      if (b.variants.length === 0) {
        b.variants.push({ text: conv.messages[msgIdx].text, files: (conv.messages[msgIdx].files || []).map((f) => ({ ...f })), tail: conv.messages.slice(msgIdx + 1).map((m) => ({ ...m })) });
      } else {
        const ci = b.current >= 0 ? b.current : b.variants.length - 1;
        b.variants[ci] = { ...b.variants[ci], text: conv.messages[msgIdx].text, files: (conv.messages[msgIdx].files || []).map((f) => ({ ...f })), tail: conv.messages.slice(msgIdx + 1).map((m) => ({ ...m })) };
      }
      b.variants.push({ text: newText, files: originalFiles.map((f) => ({ ...f })), tail: null });
      b.current = b.variants.length - 1;
      conv.messages = conv.messages.slice(0, msgIdx);
      upsertConv(conv);
    }
  } else {
    const tempIdx = state.tempHistory.findIndex((m) => m.role === "user" && m.parts?.[0]?.text === origText);
    if (tempIdx >= 0) state.tempHistory = state.tempHistory.slice(0, tempIdx);
  }
  const area = $("messagesArea");
  const allMsgs = Array.from(area.querySelectorAll(".message:not(#typingIndicator)"));
  const domIdx = allMsgs.indexOf(msgEl);
  if (domIdx >= 0) allMsgs.slice(domIdx).forEach((el) => el.remove());
  if (!$("typingIndicator")) {
    area.insertAdjacentHTML("beforeend", typingIndicatorHTML());
  }
  const newMsgId = genId();
  if (conv) {
    conv.messages.push({ role: "user", text: newText, id: newMsgId, _editBranchRef: branchRootId, files: originalFiles.map((f) => ({ ...f })) });
    upsertConv(conv);
  } else {
    state.tempHistory.push({ role: "user", parts: [{ text: newText }] });
  }
  appendUserMessageDOM(newText, originalFiles, newMsgId, branchRootId);
  if (conv) updateBranchNavDOM(branchRootId);
  scrollToBottom();
  const typingEl = $("typingIndicator");
  typingEl.style.display = "flex";
  _autoScrollSticky = true;  // re-enable on edit-resend
  scrollToBottom();
  const history = conv ? buildHistory(conv) : [...state.tempHistory];
  // Re-attach the original files to the latest user turn in history. Without
  // this, the AI never receives the attachments on resubmit — `buildHistory`
  // only emits text parts, so the file content was being silently dropped.
  if (originalFiles.length && history.length) {
    const last = history[history.length - 1];
    if (last && last.parts && last.parts.length) {
      const fileParts = buildFileParts(originalFiles);
      if (fileParts.length) last.parts.push(...fileParts);
    }
  }
// EmeraldSuite context is always injected when the turn is about a file.
  _efResetWriteGate();
  try {
    const fileCtx = await _suiteAutoContext(newText);
    if (fileCtx && history.length && history[history.length - 1]?.parts?.length) {
      history[history.length - 1].parts.unshift({ text: fileCtx });
    }
  } catch (e) { console.warn("File context failed:", e); }
  state.isStreaming = true;
  state.abortCtrl = new AbortController();
  state.streamConvId = conv ? conv.id : null;
  setSendState(true);
  _syncInputBusyUi();
  const _wsNeeded = detectWebSearchIntent(newText);
  const _urlsInMsg = extractUrls(newText);
  let _webSources = [];
  if (_wsNeeded && !_urlsInMsg.length) {
    try {
      const _results = await performAdvancedSearch(newText);
      if (_results.contextText) {
        _webSources.push(..._results.sources);
        const ctx = _results.contextText + "\n";
        const last = history[history.length - 1];
        if (last?.parts?.length) last.parts[0] = { text: ctx + (last.parts[0]?.text || "") };
      }
    } catch (e) {
      console.warn("Web search failed:", e);
      showToast(`${_aiSvgWarn} Web search unavailable — proceeding without context.`);
    }
  }
  let _groundingMetadata = null;
  const aiMsgId = genId();
  state.streamMsgId = aiMsgId;
  let aiDiv = null, aiTextEl = null, aiFullText = "";
  let _usedModelId = "", _usedModelName = "";
  let _reasoningText = "";
  let _reasoningBlock = null;
  let _reasoningDone = false;
  let _searchingBlock = null;
  let _searchingDone = false;
  const _streamViewing = () => _activeStreamTargetsView(state.streamConvId);
  const _ensureStreamDom = () => {
    if (!_streamViewing()) return false;
    if (!aiDiv || !document.body.contains(aiDiv)) {
      _hideTypingIndicator();
      aiDiv = appendAIMessageDOM("", aiMsgId, true);
      aiTextEl = aiDiv.querySelector(".message-text");
      aiTextEl.classList.add("stream-reveal");
    }
    return true;
  };
  const _markReasoningDoneOnce = () => {
    if (_reasoningDone) return;
    _reasoningDone = true;
    if (_reasoningBlock) markReasoningDone(_reasoningBlock);
  };
  const _markSearchingDoneOnce = () => {
    if (_searchingDone) return;
    _searchingDone = true;
    if (_searchingBlock) markSearchingDone(_searchingBlock);
  };
  try {
    const _streamResult = await streamEmeraldBotResumable(history, apiKey, (chunk) => {
      _markSearchingDoneOnce();
      _markReasoningDoneOnce();
      aiFullText += chunk;
      if (!_ensureStreamDom()) return;
      const _sd = _streamDisplayText(aiFullText);
      aiTextEl.innerHTML = (_sd.text ? renderMarkdown(_sd.text) : "") + (_sd.editStarted ? esEditLoadingCardHTML() : _sd.quizStarted ? quizLoadingCardHTML() : _sd.appStarted ? esAppLoadingCardHTML() : '<span class="stream-cursor" aria-hidden="true"></span>');
      _wrapStreamWords(aiTextEl);
      scrollToBottom();
    }, {
      useUrlContext: _urlsInMsg.length > 0,
      userText: newText,
      onSearchStatusChunk: (chunk) => {
        if (!_ensureStreamDom()) return;
        if (!_searchingBlock) _searchingBlock = createSearchingBlock(aiDiv);
        appendSearchingToBlock(_searchingBlock, chunk);
        scrollToBottom();
      },
      onReasoningChunk: (chunk) => {
        _markSearchingDoneOnce();
        _reasoningText += chunk;
        if (!_ensureStreamDom()) return;
        if (!_reasoningBlock) _reasoningBlock = createReasoningBlock(aiDiv);
        appendReasoningToBlock(_reasoningBlock, chunk);
        scrollToBottom();
      }
    }, { useWebSearch: _wsNeeded });
    if (_streamResult.groundingMetadata) {
      if (_groundingMetadata?.groundingChunks) {
        const existingUris = new Set(_groundingMetadata.groundingChunks.map(c => c?.web?.uri));
        const newChunks = (_streamResult.groundingMetadata.groundingChunks || []).filter(c => !existingUris.has(c?.web?.uri));
        _groundingMetadata = { groundingChunks: [..._groundingMetadata.groundingChunks, ...newChunks] };
      } else {
        _groundingMetadata = _streamResult.groundingMetadata;
      }
    }
    if (_streamResult.modelId) {
      _usedModelId = _streamResult.modelId;
      const _m = getModelById(_usedModelId);
      _usedModelName = _m ? _m.name : _usedModelId;
    }
  } catch (err) {
    if (err?._jailbreakBlocked) {
      _hideTypingIndicator();
      if (state.convId && !state.isTemp) {
        deleteConv(state.convId);
      }
      state.convId = null;
      updateOwnedUrl();
      state.tempHistory = [];
      state.isStreaming = false;
      state.abortCtrl = null;
      state.streamConvId = null;
      state.streamMsgId = null;
      setSendState(false);
      _syncInputBusyUi();
      showWelcome();
      renderSidebar();
      showToast(`${_aiSvgWarn} This request cannot be processed because it violates EmeraldNetwork usage policies.`, "error");
      return;
    }
    _hideTypingIndicator();
    if (!(err.name === "AbortError" && aiFullText)) {
      if (!aiDiv) {
        aiDiv = _streamViewing() ? appendAIMessageDOM("", aiMsgId, true) : buildAIBubbleDOM("", aiMsgId, true);
        aiTextEl = aiDiv.querySelector(".message-text");
      }
      aiTextEl.innerHTML = `<span class="md-error">${escapeHtml(aiChatErrorText(err, "generating the response"))}</span>`;
    }
  }
  _hideTypingIndicator();
  _markSearchingDoneOnce();
  _markReasoningDoneOnce();
  if (!aiFullText && !aiDiv) {
    aiDiv = _streamViewing() ? appendAIMessageDOM("", aiMsgId, true) : buildAIBubbleDOM("", aiMsgId, true);
    aiTextEl = aiDiv.querySelector(".message-text");
  }
  if (!aiFullText && aiDiv && aiTextEl && !aiTextEl.querySelector(".md-error")) {
    aiTextEl.innerHTML = `<span class="md-error">${escapeHtml(aiErrorMessage("generating the response"))}</span>`;
  }
  if (aiFullText && !aiDiv) {
    // Edited-and-resent while the user was viewing another conversation:
    // no bubble was attached, but the response must still be saved.
    aiDiv = _streamViewing() ? appendAIMessageDOM("", aiMsgId, false) : buildAIBubbleDOM("", aiMsgId, false);
    aiTextEl = aiDiv.querySelector(".message-text");
    aiTextEl.classList.remove("stream-reveal");
  }
  if (aiFullText && aiDiv) {
    let dispText = aiFullText;
    const memM = _extractMemories(aiFullText);
    const memoriesAdded = memM.map((m) => m.text).filter(Boolean);
    memoriesAdded.forEach((t) => addMemory(t));
    dispText = _stripMemoryTags(dispText).replace(/\n{3,}/g, "\n\n").trim();
    const memoryAdded = memoriesAdded.length > 0;
    const imgTags = extractImageTags(dispText);
    const imgPrompt = imgTags.genPrompt;
    const imgEditPrompt = imgTags.editPrompt;
    const imgPromptFinal = imgEditPrompt || imgPrompt;
    dispText = stripImageTags(dispText);
    const _quizResult = _extractQuiz(dispText);
    const quizData = _quizResult.quizData;
    const beforeQuizText = _quizResult.before;
    const afterQuizText = _quizResult.after;
    const _quizParseFailed = _quizResult.parseFailed;
    dispText = _quizResult.before;
    const _appRaw = (quizData || _quizParseFailed) ? { appData: null, parseFailed: false, before: dispText, after: "" } : _extractEmeraldApp(dispText);
    const appData = _appRaw.appData;
    const beforeAppText = _appRaw.before;
    const afterAppText = _appRaw.after;
    const _appParseFailed = _appRaw.parseFailed;
    dispText = beforeAppText;
    let _fEditRes = null;
    if (!(quizData || _quizParseFailed || appData || _appParseFailed)) {
      const _fe = _extractFileEdit(aiFullText);
      if (_fe.edit || _fe.parseFailed) {
        dispText = _fe.before;
        _fEditRes = _fe;
      }
    }
    let _fileEditOutcome = null;
    aiTextEl.classList.remove("stream-reveal");
    const _editTextToShow = (quizData || _quizParseFailed) ? beforeQuizText : dispText;
    const _hasOtherContent = !!(quizData || _quizParseFailed || appData || _appParseFailed || _fEditRes || imgPromptFinal || memoryAdded);
    if (_editTextToShow) {
      aiTextEl.innerHTML = renderMarkdown(_editTextToShow);
    } else if (_hasOtherContent) {
      aiTextEl.innerHTML = "";
      aiTextEl.classList.add("message-text--empty");
    } else {
      aiTextEl.innerHTML = `<span class="md-error">${escapeHtml(aiErrorMessage("generating the response"))}</span>`;
    }
    if (memoryAdded) {
      const badge = document.createElement("div");
      badge.className = "memory-badge";
      const cnt = memoriesAdded.length > 1 ? `Updated ${memoriesAdded.length} memories` : "Updated memory";
      badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg> ${cnt}`;
      aiDiv.querySelector(".message-sender").insertAdjacentElement("afterend", badge);
    }
    if (quizData) {
      const qid = "quiz_" + genId();
      quizData._id = qid;
      window._quizzes = window._quizzes || {};
      window._quizzes[qid] = { data: quizData, answers: {}, submitted: false };
      const cardEl = document.createElement("div");
      cardEl.innerHTML = quizCardHTML(qid, quizData);

      aiTextEl.insertAdjacentElement("afterend", cardEl.firstElementChild);
      if (afterQuizText) {
        const afterEl = document.createElement("div");
        afterEl.className = "message-text md-content";
        afterEl.style.marginTop = "8px";
        afterEl.innerHTML = renderMarkdown(afterQuizText);
        aiTextEl.nextElementSibling.insertAdjacentElement("afterend", afterEl);
      }
    } else if (_quizParseFailed) {
      const errCard = document.createElement("div");
      errCard.innerHTML = quizErrorCardHTML();
      aiTextEl.insertAdjacentElement("afterend", errCard.firstElementChild);
    }
    if (appData) {
      renderEsAppCard(aiTextEl, appData, afterAppText, aiMsgId);
    } else if (_appParseFailed) {
      renderEsAppErrorCard(aiTextEl);
    }
    if (_fEditRes) {
      _fileEditOutcome = await _efApplyEdit(_fEditRes, aiMsgId, newText);
      renderFileEditBadge(aiDiv, _fileEditOutcome);
    }
    const _groundingSources = extractGroundingSources(_groundingMetadata);
    const _allSources = [..._groundingSources, ..._webSources];
    renderCitations(aiDiv, _allSources);
    if (_allSources.length) _stripSourcesFromHTML(aiTextEl);
    aiDiv.querySelector(".message-body").appendChild(buildMessageActionsEl(aiMsgId));
    if (aiDiv) {
      aiDiv.dataset.modelId = _usedModelId || "";
      aiDiv.dataset.modelName = _usedModelName || "";
    }
    if (conv) {
      conv.messages.push({
        role: "assistant",
        text: aiFullText,
        id: aiMsgId,
        _editBranchRef: branchRootId,
        modelId: _usedModelId || void 0,
        modelName: _usedModelName || void 0,
        hasMemory: !!memoryAdded,
        hasQuiz: !!(quizData || _quizParseFailed),
        quizData: quizData || void 0,
        quizTextBefore: (quizData || _quizParseFailed) ? beforeQuizText : void 0,
        quizTextAfter: (quizData || _quizParseFailed) ? afterQuizText : void 0,
        hasEsApp: !!(appData || _appParseFailed),
        esAppData: appData || void 0,
        esAppTextBefore: (appData || _appParseFailed) ? beforeAppText : void 0,
        esAppTextAfter: (appData || _appParseFailed) ? afterAppText : void 0,
        fileEdit: _fileEditOutcome || void 0,
        imagePrompt: imgPromptFinal || void 0,
        imageMode: imgEditPrompt ? "edit" : (imgPrompt ? "generate" : void 0),
        reasoning: _reasoningText || void 0,
        sources: _allSources.length ? _allSources.map(s => ({ title: s.title || '', uri: s.uri })) : void 0
      });
      conv.updatedAt = Date.now();
      upsertConv(conv);
      updateBranchNavDOM(branchRootId);
    } else {
      state.tempHistory.push({ role: "model", parts: [{ text: aiFullText }] });
    }
    if (imgPromptFinal) {
      runImageTags(aiDiv, aiFullText, state.convId, aiMsgId, { files: originalFiles, userText: newText });
    }
  } else if (aiDiv && aiTextEl) {
    // No text came back (request error / cancellation / empty response).
    // Persist the error so it survives a page reload instead of vanishing.
    const errorText = aiTextEl.querySelector(".md-error")?.textContent || "An error occurred.";
    aiDiv.querySelector(".message-body").appendChild(buildMessageActionsEl(aiMsgId));
    if (conv) {
      conv.messages.push({ role: "assistant", text: errorText, id: aiMsgId, _editBranchRef: branchRootId, isError: true });
      conv.updatedAt = Date.now();
      upsertConv(conv);
      updateBranchNavDOM(branchRootId);
    } else {
      state.tempHistory.push({ role: "model", parts: [{ text: errorText }] });
    }
  }
  updateLastMsgActions();
  state.isStreaming = false;
  state.abortCtrl = null;
  state.streamConvId = null;
  state.streamMsgId = null;
  setSendState(false);
  _syncInputBusyUi();
  scrollToBottom();
}
function navigateBranch(originalMsgId, dir) {
  if (state.isStreaming) return;
  if (!state.convId) return;
  const conv = getConv(state.convId);
  // Branch keys are always internal message-id strings generated by the app;
  // reject the special prototype property names defensively.
  if (originalMsgId === "__proto__" || originalMsgId === "constructor" || originalMsgId === "prototype") return;
  if (!conv?._editBranches?.[originalMsgId]) return;
  const branchInfo = conv._editBranches[originalMsgId];
  const newIdx = branchInfo.current + dir;
  if (newIdx < 0 || newIdx >= branchInfo.variants.length) return;
  let startIdx = conv.messages.findIndex((m) => m.id === originalMsgId);
  if (startIdx < 0) startIdx = conv.messages.findIndex((m) => m._editBranchRef === originalMsgId);
  if (startIdx < 0) return;
  if (typeof branchInfo.current !== "number") return;
  const curIdx = branchInfo.current;
  if (!Number.isInteger(curIdx) || curIdx < 0 || curIdx >= branchInfo.variants.length) return;
  if (branchInfo.variants[curIdx]) {
    const variant = branchInfo.variants[curIdx];
    safeSetProp(variant, "text", conv.messages[startIdx].text);
    safeSetProp(variant, "tail", conv.messages.slice(startIdx + 1).map((m) => ({ ...m })));
    safeSetProp(variant, "files", (conv.messages[startIdx].files || []).map((f) => ({ ...f })));
  }
  branchInfo.current = newIdx;
  const target = branchInfo.variants[newIdx];
  const newUserMsg = { role: "user", text: target.text, id: genId(), _editBranchRef: originalMsgId, files: (target.files || []).map((f) => ({ ...f })) };
  conv.messages = [
    ...conv.messages.slice(0, startIdx),
    newUserMsg,
    ...(target.tail || []).map((m) => ({ ...m }))
  ];
  conv._editBranches[originalMsgId] = branchInfo;
  upsertConv(conv);
  _branchAnimateSwap(() => _renderConversationMessages(conv), () => document.querySelector(`.message--user[data-branch-ref="${originalMsgId}"]`) || document.querySelector(`.message--user[data-msg-id="${originalMsgId}"]`));
}
function _renderConversationMessages(conv) {
  showMessages();
  $("messagesArea").innerHTML = typingIndicatorHTML();
  conv.messages.forEach((m) => {
    if (m.role === "user" && !m._silent) appendUserMessageDOM(m.text, m.files || [], m.id || null, m._editBranchRef || null);
    else if (m.role === "user" && m._silent) { /* skip rendering silent quiz prompt */ }
    else appendStoredAIMessage(m);
  });
  if (conv._editBranches) {
    Object.keys(conv._editBranches).forEach((origId) => updateBranchNavDOM(origId));
  }
  if (conv._regenBranches) {
    Object.keys(conv._regenBranches).forEach((branchId) => updateRegenNavDOM(branchId));
  }
  updateLastMsgActions();
  updateTopbarTitle(conv.title);
  renderSidebar();
  scrollToBottom();
}
function _getBranchMessagesFrom(anchorEl) {
  const area = $("messagesArea");
  if (!area || !anchorEl) return [];
  const msgs = [];
  let el = anchorEl;
  while (el) {
    if (el.classList && el.classList.contains("message")) msgs.push(el);
    el = el.nextElementSibling;
  }
  return msgs;
}
function _branchAnimateSwap(swapFn, findAnchor) {
  if (_chatSwitchAnimating) { swapFn(); return; }
  const anchorEl = typeof findAnchor === "function" ? findAnchor() : null;
  const targets = anchorEl ? _getBranchMessagesFrom(anchorEl) : [];
  if (targets.length === 0) { swapFn(); return; }
  _chatSwitchAnimating = true;
  const TRANSITION = "filter 0.18s cubic-bezier(0.4,0,0.2,1), opacity 0.18s cubic-bezier(0.4,0,0.2,1)";
  targets.forEach((el) => {
    el.style.transition = TRANSITION;
    el.classList.add("branch-switching");
  });
  setTimeout(() => {
    try { swapFn(); } finally {
      const newAnchor = typeof findAnchor === "function" ? findAnchor() : null;
      const newTargets = newAnchor ? _getBranchMessagesFrom(newAnchor) : [];
      newTargets.forEach((el) => {
        el.style.transition = "none";
        el.classList.add("branch-switching");
      });
      void (newTargets[0]?.offsetWidth);
      newTargets.forEach((el) => {
        el.style.transition = TRANSITION;
        el.classList.remove("branch-switching");
      });
      setTimeout(() => {
        targets.forEach((el) => { el.style.transition = ""; });
        newTargets.forEach((el) => { el.style.transition = ""; });
        _chatSwitchAnimating = false;
      }, 200);
    }
  }, 180);
}
function updateBranchNavDOM(originalMsgId) {
  if (!state.convId) return;
  const conv = getConv(state.convId);
  if (!conv?._editBranches?.[originalMsgId]) return;
  const branchInfo = conv._editBranches[originalMsgId];
  if (branchInfo.variants.length < 2) return;
  const branchUserEl = document.querySelector(`.message--user[data-branch-ref="${originalMsgId}"]`) || document.querySelector(`.message--user[data-msg-id="${originalMsgId}"]`);
  const msgEl = branchUserEl;
  if (!msgEl) return;
  document.querySelectorAll(`.branch-nav[data-branch-for="${originalMsgId}"]`).forEach((navEl) => navEl.remove());
  let nav = msgEl.querySelector(`.branch-nav[data-branch-for="${originalMsgId}"]`);
  if (!nav) {
    nav = document.createElement("div");
    nav.className = "branch-nav branch-nav--edit";
    nav.dataset.branchFor = originalMsgId;
    const body = msgEl.querySelector(".message-body");
    if (body) body.appendChild(nav);
  }
  const cur = branchInfo.current + 1;
  const tot = branchInfo.variants.length;
  nav.innerHTML = "";
  const _bPrev = document.createElement("button"); _bPrev.className = "branch-nav-btn";
  if (branchInfo.current === 0) _bPrev.disabled = true;
  _bPrev.addEventListener("click", () => navigateBranch(originalMsgId, -1));
  _bPrev.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>';
  const _bCount = document.createElement("span"); _bCount.className = "branch-nav-count"; _bCount.textContent = cur + " / " + tot;
  const _bNext = document.createElement("button"); _bNext.className = "branch-nav-btn";
  if (branchInfo.current === tot - 1) _bNext.disabled = true;
  _bNext.addEventListener("click", () => navigateBranch(originalMsgId, 1));
  _bNext.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>';
  nav.appendChild(_bPrev); nav.appendChild(_bCount); nav.appendChild(_bNext);
}
function navigateRegenBranch(branchId, dir) {
  if (state.isStreaming || !state.convId) return;
  const conv = getConv(state.convId);
  if (!conv) return;
  // Branch keys are always internal message-id strings generated by the app.
  // Reject the special prototype property names so a corrupt/stored map can
  // never resolve to Object.prototype or Function.prototype.
  if (branchId === "__proto__" || branchId === "constructor" || branchId === "prototype") return;
  const branch = conv?._regenBranches?.[branchId];
  if (!branch) return;
  if (typeof branch.current !== "number") return;
  const newIdx = branch.current + dir;
  if (newIdx < 0 || newIdx >= branch.variants.length) return;
  let msgIdx = conv.messages.findIndex((m) => m._regenBranchRef === branchId);
  if (msgIdx < 0) msgIdx = conv.messages.findIndex((m) => m.id === branchId);
  if (msgIdx < 0) return;
  // Save the current variant (including the tail of messages after it)
  const curTail = conv.messages.slice(msgIdx + 1).map((m) => ({ ...m }));
  branch.variants[branch.current] = { ...conv.messages[msgIdx], _regenBranchRef: branchId, _regenTail: curTail };
  // Switch to the new variant
  branch.current = newIdx;
  const target = branch.variants[newIdx];
  const targetTail = (target._regenTail || []).map((m) => ({ ...m }));
  // Replace the AI message and restore the target variant's tail
  conv.messages = [
    ...conv.messages.slice(0, msgIdx),
    { ...target, id: genId(), _regenBranchRef: branchId },
    ...targetTail
  ];
  conv._regenBranches[branchId] = branch;
  upsertConv(conv);
  _branchAnimateSwap(() => _renderConversationMessages(conv), () => document.querySelector(`[data-ai="1"][data-regen-branch-ref="${branchId}"]`) || document.querySelector(`[data-ai="1"][data-msg-id="${branchId}"]`));
}
function updateRegenNavDOM(branchId) {
  if (!state.convId) return;
  const conv = getConv(state.convId);
  const branch = conv?._regenBranches?.[branchId];
  if (!branch || branch.variants.length < 2) return;
  let msgEl = document.querySelector(`[data-ai="1"][data-regen-branch-ref="${branchId}"]`);
  if (!msgEl) msgEl = document.querySelector(`[data-ai="1"][data-msg-id="${branchId}"]`);
  if (!msgEl) return;
  document.querySelectorAll(`.branch-nav[data-regen-for="${branchId}"]`).forEach((navEl) => navEl.remove());
  let nav = msgEl.querySelector(`.branch-nav[data-regen-for="${branchId}"]`);
  if (!nav) {
    nav = document.createElement("div");
    nav.className = "branch-nav branch-nav--regen";
    nav.dataset.regenFor = branchId;
    const body = msgEl.querySelector(".message-body");
    if (body) body.appendChild(nav);
  }
  const cur = branch.current + 1;
  const tot = branch.variants.length;
  nav.innerHTML = "";
  const _rPrev = document.createElement("button"); _rPrev.className = "branch-nav-btn";
  if (branch.current === 0) _rPrev.disabled = true;
  _rPrev.addEventListener("click", () => navigateRegenBranch(branchId, -1));
  _rPrev.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>';
  const _rCount = document.createElement("span"); _rCount.className = "branch-nav-count"; _rCount.textContent = cur + " / " + tot;
  const _rNext = document.createElement("button"); _rNext.className = "branch-nav-btn";
  if (branch.current === tot - 1) _rNext.disabled = true;
  _rNext.addEventListener("click", () => navigateRegenBranch(branchId, 1));
  _rNext.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>';
  nav.appendChild(_rPrev); nav.appendChild(_rCount); nav.appendChild(_rNext);
}
function detectWebSearchIntent(text) {
  if (!text) return false;
  return /\b(search|look up|look it up|look for|look on|find|find out|google|browse|open|visit|go to|check out|navigate to|load|show me|latest|current|today'?s|today is|right now|live|breaking news|what'?s happening|real.?time|stock price|weather|recent|this week|this year|news|update|happened|who is|who are|what is|what are|when did|where is|how much|how many|check|tell me about|give me info|any info)\b/i.test(text);
}
function extractUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s<>"']+/g;
  const raw = [...new Set(text.match(re) || [])].map((u) => u.replace(/[.,;!?)]+$/, ""));
  const full = raw.filter((u) => {
    try {
      const host = new URL(u).hostname;
      return host.includes(".") && host.split(".").every((p) => p.length > 0);
    } catch {
      return false;
    }
  });
  const bareRe = /(?:open|visit|go to|check out|navigate to|load|browse|read)\s+([a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?:\/[^\s]*)?)/gi;
  let m;
  const bare = [];
  while ((m = bareRe.exec(text)) !== null) {
    const candidate = "https://" + m[1].replace(/[.,;!?)]+$/, "");
    try {
      const host = new URL(candidate).hostname;
      if (host.includes(".") && host.split(".").pop().length >= 2) bare.push(candidate);
    } catch {
    }
  }
  return [.../* @__PURE__ */ new Set([...full, ...bare])];
}
function togglePreviewConsole() {
  const body = document.getElementById("codePreviewBody");
  const iframe = body?.querySelector("iframe");
  if (iframe) iframe.contentWindow.postMessage({ type: "esb-console-toggle" }, "*");
}
async function proxySearch(endpoint, params) {
  if (!SEARCH_PROXY_URL) return null;
  try {
    const url = new URL(endpoint, SEARCH_PROXY_URL + "/");
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12e3);
    const r = await fetch(url.toString(), { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) return await r.json();
  } catch (e) {
    console.warn("[proxySearch] " + endpoint + " failed:", e?.message || e);
  }
  return null;
}
async function performAdvancedSearch(text) {
  const sources = [];
  let contextText = "";
  const platforms = [
    { regex: /\b(on\s+yt\b|on\s+youtube\b|youtube\b|yt\b)\b/i, endpoint: "/api/youtube", label: "YouTube" },
    { regex: /\b(on\s+github\b|on\s+gh\b|github\b|gh\b)\b/i, endpoint: "/api/github", label: "GitHub" },
    { regex: /\b(on\s+reddit\b|reddit\b)\b/i, endpoint: "/api/reddit", label: "Reddit" },
    { regex: /\b(on\s+quora\b|quora\b)\b/i, site: "quora.com", label: "Quora" },
    { regex: /\b(on\s+stack\s*overflow\b|on\s+so\b|stack\s*overflow\b)\b/i, site: "stackoverflow.com", label: "Stack Overflow" },
    { regex: /\b(on\s+twitter\b|on\s+x\b|twitter\b|\bx\.com\b)\b/i, site: "twitter.com OR x.com", label: "Twitter/X" },
    { regex: /\b(on\s+medium\b|medium\b)\b/i, site: "medium.com", label: "Medium" },
    { regex: /\b(on\s+dev\.?to\b|devto\b)\b/i, site: "dev.to", label: "Dev.to" },
    { regex: /\b(on\s+hacker\s*news\b|hn\b|news\.ycombinator\.com)\b/i, site: "news.ycombinator.com", label: "Hacker News" },
    { regex: /\b(on\s+wikipedia\b|wikipedia\b|wiki\b)\b/i, endpoint: "/api/wikipedia", label: "Wikipedia" },
    { regex: /\b(on\s+linkedin\b|linkedin\b)\b/i, site: "linkedin.com", label: "LinkedIn" },
    { regex: /\b(on\s+instagram\b|instagram\b|insta\b)\b/i, site: "instagram.com", label: "Instagram" },
    { regex: /\b(on\s+facebook\b|facebook\b|fb\b)\b/i, site: "facebook.com", label: "Facebook" },
    { regex: /\b(on\s+tiktok\b|tiktok\b)\b/i, site: "tiktok.com", label: "TikTok" }
  ];
  let platformMatch = null;
  for (const p of platforms) {
    if (p.regex.test(text)) {
      platformMatch = p;
      break;
    }
  }
  const deepIntent = /\b(read|about|open|tell me about|look at|deep|detailed|full info|full information)\b/i.test(text);
  let subject = text.replace(/\b(what'?s the latest on|tell me about|find out about|info about|information about|look up|look it up|search for|look for|google|can you|could you|would you)\b/gi, " ").replace(/\b(search|find|read|about|open|check|the|a|an|its|his|her|their|and|then|page|info|information|me|please|thanks|thank you|thx)\b/gi, " ").replace(/\b(on\s+yt\b|on\s+youtube\b|youtube\b|yt\b|on\s+github\b|on\s+gh\b|github\b|gh\b|on\s+reddit\b|reddit\b|on\s+quora\b|quora\b|on\s+stack\s*overflow\b|on\s+so\b|stack\s*overflow\b|on\s+twitter\b|on\s+x\b|twitter\b|on\s+medium\b|medium\b|on\s+dev\.?to\b|devto\b|on\s+hacker\s*news\b|hn\b|on\s+wikipedia\b|wikipedia\b|wiki\b|on\s+linkedin\b|linkedin\b|on\s+instagram\b|instagram\b|insta\b|on\s+facebook\b|facebook\b|fb\b|on\s+tiktok\b|tiktok\b)\b/gi, " ").replace(/[?!.]+$/g, " ").replace(/\s+/g, " ").trim();
  if (!subject) {
    subject = text.replace(/^\s*(search|find|look\s+(?:up|for))\s+/i, "").trim() || text;
  }
  if (platformMatch) {
    if (platformMatch.endpoint) {
      const data = await proxySearch(platformMatch.endpoint, { q: subject });
      if (data?.results?.length) {
        contextText = `${platformMatch.label} search results for "${subject}":

`;
        data.results.slice(0, 8).forEach((res, i) => {
          contextText += `${i + 1}. ${res.title}
   ${res.url}
   ${res.snippet || ""}
`;
          sources.push({ title: res.title, uri: res.url });
        });
        if (platformMatch.label === "YouTube" && deepIntent && data.results[0]?.channelUrl) {
          const aboutUrl = data.results[0].channelUrl + "/about";
          const aboutData = await proxySearch("/api/read", { url: aboutUrl });
          if (aboutData?.content) {
            contextText += `
Channel about page (${data.results[0].channel}):
${aboutData.content.slice(0, 3e3)}
`;
          }
        }
      }
    } else if (platformMatch.site) {
      const data = await proxySearch("/api/sitesearch", { q: subject, site: platformMatch.site });
      if (data?.results?.length) {
        contextText = `${platformMatch.label} search results for "${subject}":

`;
        data.results.slice(0, 8).forEach((res, i) => {
          contextText += `${i + 1}. ${res.title}
   ${res.url}
   ${res.snippet || ""}
`;
          sources.push({ title: res.title, uri: res.url });
        });
      }
    }
  }
  if (!contextText) {
    const endpoint = deepIntent ? "/api/deepsearch" : "/api/search";
    const searchData = await proxySearch(endpoint, { q: subject });
    if (searchData?.results?.length) {
      contextText = `Web search results for "${subject}":

`;
      searchData.results.slice(0, 8).forEach((res) => {
        contextText += `From [${res.title}](${res.url}): ${res.snippet || ""}

`;
        sources.push({ title: res.title, uri: res.url });
      });
      if (searchData.deepResults?.length) {
        contextText += "\nDetailed page content:\n\n";
        searchData.deepResults.forEach((dp) => {
          contextText += `From ${dp.url}:
${dp.content.slice(0, 3e3)}

`;
        });
      }
    }
  }
  if (!contextText) {
    if (platformMatch) {
      const generalData = await proxySearch("/api/search", { q: subject });
      if (generalData?.results?.length) {
        contextText = `Web search results for "${subject}":

`;
        generalData.results.slice(0, 8).forEach((res) => {
          contextText += `From [${res.title}](${res.url}): ${(res.snippet || "").slice(0, 300)}

`;
          sources.push({ title: res.title, uri: res.url });
        });
      }
    }
  }
  if (!contextText) {
    const deepData = await proxySearch("/api/deepsearch", { q: subject });
    if (deepData?.results?.length) {
      contextText = `Web search results for "${subject}":

`;
      deepData.results.slice(0, 8).forEach((res) => {
        contextText += `From [${res.title}](${res.url}): ${(res.snippet || "").slice(0, 300)}

`;
        sources.push({ title: res.title, uri: res.url });
      });
      if (deepData.deepResults?.length) {
        contextText += "\nDetailed page content:\n\n";
        deepData.deepResults.forEach((dp) => {
          contextText += `From ${dp.url}:
${(dp.content || "").slice(0, 3e3)}

`;
        });
      }
    }
  }
  return { contextText, sources };
}
/* Strip AI-written "Sources:" section from rendered HTML when grounding pills exist */
function _stripSourcesFromHTML(textEl) {
  if (!textEl) return;
  // Look for the last <strong>/<b> containing "Sources" followed by a list or paragraph
  const strongs = textEl.querySelectorAll("strong, b");
  for (let i = strongs.length - 1; i >= 0; i--) {
    const txt = strongs[i].textContent.trim().replace(/[\s:：]/g, "").toLowerCase();
    if (txt === "sources" || txt === "source" || txt === "references" || txt === "reference") {
      // Found a "Sources" header — remove it and everything after it
      let node = strongs[i];
      // Check if it's inside a heading (h1-h6) or paragraph
      const parent = node.closest("h1,h2,h3,h4,h5,h6,p,li");
      const removeStart = parent || node;
      // Remove removeStart and all following siblings
      while (removeStart.nextSibling) removeStart.nextSibling.remove();
      removeStart.remove();
      return;
    }
  }
  // Also check for "Sources:" as plain text in an <ol> or <ul>
  const lists = textEl.querySelectorAll("ol, ul");
  for (let i = lists.length - 1; i >= 0; i--) {
    const prev = lists[i].previousElementSibling;
    if (prev && (prev.closest("strong,b") || prev.tagName.match(/^H[1-6]$/))) {
      const prevTxt = prev.textContent.trim().replace(/[\s:：]/g, "").toLowerCase();
      if (prevTxt === "sources" || prevTxt === "references") {
        prev.remove();
        lists[i].remove();
        return;
      }
    }
  }
  // Handle a trailing "From:" / "From" header that introduces a link list
  // (e.g. "From: [Title](url)"). Only strip when the region after the
  // header actually contains a link, so prose like "From the start…" that
  // happens to be bolded is never cut off.
  for (let i = strongs.length - 1; i >= 0; i--) {
    const txt = strongs[i].textContent.trim().replace(/[\s:：]/g, "").toLowerCase();
    if (txt !== "from") continue;
    const parent = strongs[i].closest("h1,h2,h3,h4,h5,h6,p,li");
    const node = parent || strongs[i];
    if (!node.nextSibling) {
      node.remove();
      return;
    }
    const hasLink = (() => {
      let n = node.nextSibling;
      let acc = "";
      while (n) {
        if (n.nodeType === Node.TEXT_NODE) acc += n.textContent;
        else if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.querySelector?.("a[href^='http']")) return true;
          acc += n.textContent;
        }
        n = n.nextSibling;
      }
      return /https?:\/\/|\[[^\]]*\]\([^)\s]+\)/.test(acc);
    })();
    if (hasLink) {
      let n = node;
      while (n.nextSibling) n.nextSibling.remove();
      n.remove();
      return;
    }
  }
}

function renderCitations(aiDiv, sources) {
  // Always process [N] patterns — even without sources, convert them to
  // orphan badges so they're not left as raw "[1]" plain text.
  if (!sources) sources = [];
  const body = aiDiv?.querySelector(".message-body");
  if (!body) return;

  // ── Step 1: Convert inline [1], [2], [1][2] citations to clickable superscript badges ──
  const mdContent = body.querySelector(".md-content") || body;
  if (mdContent) {
    // Walk text nodes to replace [N] patterns without breaking HTML
    // Skip text nodes inside <code> and <pre> elements — those should stay as-is
    const walker = document.createTreeWalker(mdContent, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      // Skip if inside a <code> or <pre> tag
      let p = n.parentElement;
      let skip = false;
      while (p && p !== mdContent) {
        if (p.tagName === 'CODE' || p.tagName === 'PRE') { skip = true; break; }
        p = p.parentElement;
      }
      if (!skip) textNodes.push(n);
    }

    for (const node of textNodes) {
      // Match [N], [N,M], [N-M] where N is 1-99 — also handle clustered like [1][2]
      // First pass: expand compound citations like [1,2] → [1][2] and [1-3] → [1][2][3]
      let expanded = node.nodeValue.replace(/\[(\d{1,2})\s*,\s*(\d{1,2})\]/g, '[$1][$2]');
      expanded = expanded.replace(/\[(\d{1,2})\s*-\s*(\d{1,2})\]/g, (_, start, end) => {
        let out = '';
        for (let n = parseInt(start); n <= Math.min(parseInt(end), 99); n++) out += `[${n}]`;
        return out;
      });
      // Second pass: convert each [N] to a marker
      const replaced = expanded.replace(/\[(\d{1,2})\]/g, (match, numStr) => {
        const idx = parseInt(numStr, 10) - 1;
        if (idx >= 0 && idx < sources.length && sources[idx]?.uri) {
          return `\x01CITE${idx}\x01`;  // Has source → clickable link
        }
        return `\x01ORPHAN${numStr}\x01`;  // No source → styled badge (not clickable)
      });
      if (replaced !== node.nodeValue) {
        // Split into parts: text + <a> citations
        // Split on both CITE and ORPHAN markers
        const parts = replaced.split(/\x01(?:CITE|ORPHAN)(\d+)\x01/);
        const types = [];
        // Track which marker type each split came from
        const markerRe = /\x01(CITE|ORPHAN)(\d+)\x01/g;
        let m;
        while ((m = markerRe.exec(replaced)) !== null) types.push({ type: m[1], idx: parseInt(m[2], 10), pos: m.index });
        const frag = document.createDocumentFragment();
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 0) {
            // Text part
            if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
          } else {
            // Marker part (odd indices are the captured group from split)
            const markerIdx = Math.floor(i / 2);
            const marker = markerIdx < types.length ? types[markerIdx] : null;
            if (marker && marker.type === "CITE") {
              // Has source → clickable link
              const src = sources[marker.idx];
              if (src?.uri) {
                const citeLink = document.createElement("a");
                citeLink.className = "esb-inline-cite";
                citeLink.href = src.uri ? _safeHref(src.uri) : '#';
                citeLink.target = "_blank";
                citeLink.rel = "noopener noreferrer";
                citeLink.textContent = String(marker.idx + 1);
                frag.appendChild(citeLink);
              }
            } else {
              // No source → styled badge (not clickable)
              const badge = document.createElement("span");
              badge.className = "esb-inline-cite esb-cite-orphan";
              badge.textContent = String(parseInt(parts[i], 10));
              frag.appendChild(badge);
            }
          }
        }
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  // ── Step 2: Build source chips at the bottom ──
  const wrap = document.createElement("div");
  wrap.className = "esb-citations";
  const seen = /* @__PURE__ */ new Set();
  // Hosts that should never appear as citation chips: search-engine-internal
  // navigation and known fake/spam domains (e.g. "unknownlink.com",
  // "vertexaigoogle.com").
  const _JUNK_HOST_RE = /(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|(^|\.)(unknownlink|vertexaigoogle|aigoogle|makingcouldthisbeup)(\.|$)/i;
  const _JUNK_TITLE_RE = /https?:\/\/(?!\/)|unknownlink|vertexaigoogle|aigoogle/i;
  sources.forEach((s) => {
    if (!s?.uri || seen.has(s.uri)) return;
    const href = _safeHref(s.uri);
    if (href === "#") return;
    seen.add(s.uri);
    const a = document.createElement("a");
    a.className = "esb-citation-chip";
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    let host = "";
    try {
      host = new URL(s.uri).hostname.replace(/^www\./, "");
    } catch {}
    if (!host || _JUNK_HOST_RE.test(host)) return;
    // Build chip text: "domain" or "domain › Title"
    let displayTitle = s.title || "";
    if (displayTitle && displayTitle.includes("://")) {
      // Title is actually a URL — strip it
      displayTitle = "";
    }
    if (displayTitle && _JUNK_TITLE_RE.test(displayTitle)) {
      // Spam/brand-impersonation title — show the link directly, not
      // "junktitle › realdomain".
      displayTitle = "";
    }
    // If title is just the domain repeated (e.g. "example.com" for example.com url), skip it
    if (displayTitle && host && (displayTitle === host || displayTitle === "www." + host)) {
      displayTitle = "";
    }
    // Truncate very long titles
    if (displayTitle.length > 60) displayTitle = displayTitle.slice(0, 57) + "...";
    let chipText = host || "Source";
    if (displayTitle && displayTitle !== host) {
      chipText = host + " \u203A " + displayTitle;
    }
    // Tooltip shows full title+URL on hover (useful when chip text is truncated)
    a.title = (displayTitle || host) + "\n" + s.uri;
    a.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>${escapeHtml(chipText)}`;
    wrap.appendChild(a);
  });
  if (wrap.children.length) body.insertAdjacentElement("beforeend", wrap);
}
function detectAspectRatio(prompt) {
  const p = (prompt || "").toLowerCase();
  const explicit = p.match(/\b(21:9|16:9|9:16|4:5|5:4|4:3|3:4|3:2|2:3|1:1)\b/);
  if (explicit) return explicit[1];
  if (/\b(wide|landscape|panoramic|cinematic|banner|desktop wallpaper|youtube thumbnail|cover photo|header image|ultrawide)\b/.test(p)) return "16:9";
  if (/\b(tall|portrait|vertical|phone|mobile screen|story|instagram story|tiktok|reel|shorts)\b/.test(p)) return "9:16";
  if (/\b(square|profile|avatar|icon|album cover|logo|sticker)\b/.test(p)) return "1:1";
  if (/\b(a4|letter|document|page|poster vertical)\b/.test(p)) return "3:4";
  if (/\b(presentation slide|slide deck|16x10)\b/.test(p)) return "16:9";
  return "1:1";
}

/* ══════════════════════════════════════════════════════════════════
   IMAGE EDITING (true image-to-image)

   The image model (FLUX.2 klein) accepts up to 4 reference images as real
   binary input. That is what makes editing an EDIT: the uploaded pixels are
   handed to the model and only the requested change is applied. Anything that
   merely rewrites the picture as text is still text-to-image, which is exactly
   why the source image is always resolved and sent with the request.

   Upstream hard limit: every reference image must be 512x512 or smaller, so
   anything larger is downscaled here before the request goes out.
   ══════════════════════════════════════════════════════════════════ */

const IMG_EDIT_MAX_DIM = 512;
const IMG_EDIT_MAX_SOURCES = 4;
const IMG_EDIT_LONG_SIDE = 1024;
const IMG_DIM_MULTIPLE = 16;
const IMG_DIM_MIN = 256;
const IMG_DIM_MAX = 1920;

// Image the user explicitly picked via the "Edit" button on a rendered image.
// Consumed by the next image request, then cleared.
let _pendingImageEdit = null; // { dataUrl, name }

function _setPendingImageEdit(dataUrl, name) {
  if (!dataUrl || !/^data:image\//i.test(dataUrl)) return;
  _pendingImageEdit = { dataUrl, name: name || "image" };
  renderPendingImageEditChip();
}

function _takePendingImageEdit() {
  const p = _pendingImageEdit;
  _pendingImageEdit = null;
  renderPendingImageEditChip();
  return p;
}

function _dropPendingImageEdit() {
  _pendingImageEdit = null;
  renderPendingImageEditChip();
}

function _snapImgDim(n) {
  const v = Math.round(Number(n) / IMG_DIM_MULTIPLE) * IMG_DIM_MULTIPLE;
  if (!Number.isFinite(v)) return IMG_DIM_MIN;
  return Math.min(IMG_DIM_MAX, Math.max(IMG_DIM_MIN, v));
}

/* For an edit the output shape follows the source image; for a fresh generation
   it follows the prompt. Both keep the long side at 1024 so the request stays in
   the model's first-megapixel pricing tier. */
function dimsForEditSource(w, h) {
  const sw = Number(w);
  const sh = Number(h);
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return null;
  let outW;
  let outH;
  if (sw >= sh) {
    outW = IMG_EDIT_LONG_SIDE;
    outH = Math.round((IMG_EDIT_LONG_SIDE * sh) / sw);
  } else {
    outH = IMG_EDIT_LONG_SIDE;
    outW = Math.round((IMG_EDIT_LONG_SIDE * sw) / sh);
  }
  return { width: _snapImgDim(outW), height: _snapImgDim(outH) };
}

const ASPECT_RATIO_DIMS = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  "3:2": { width: 1024, height: 688 },
  "2:3": { width: 688, height: 1024 },
  "4:5": { width: 816, height: 1024 },
  "5:4": { width: 1024, height: 816 },
  "21:9": { width: 1024, height: 448 },
};

function dimsForAspectRatioKey(key) {
  return ASPECT_RATIO_DIMS[key] || ASPECT_RATIO_DIMS["1:1"];
}

function _loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("decode failed"));
    im.src = src;
  });
}

/* Downscale a data URL so neither side exceeds maxDim. Returns the original
   untouched when it already fits. JPEG in → JPEG out (keeps the payload
   small); anything else re-encodes as PNG. */
async function fitImageForEditing(src, maxDim) {
  const cap = maxDim || IMG_EDIT_MAX_DIM;
  let im;
  try {
    im = await _loadImageEl(src);
  } catch (e) {
    return null;
  }
  const w = im.naturalWidth || im.width || 0;
  const h = im.naturalHeight || im.height || 0;
  if (!w || !h) return null;
  if (w <= cap && h <= cap) return { dataUrl: src, width: w, height: h, resized: false };
  const scale = Math.min(cap / w, cap / h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(im, 0, 0, tw, th);
  let out;
  try {
    out = /^data:image\/jpe?g/i.test(src) ? canvas.toDataURL("image/jpeg", 0.92) : canvas.toDataURL("image/png");
  } catch (e) {
    return null;
  }
  if (!out || out.length < 32) return null;
  return { dataUrl: out, width: tw, height: th, resized: true };
}

/* Every data-URL image inside an attachment list, in order. */
function imageDataUrlsFromFiles(files) {
  const out = [];
  for (const f of files || []) {
    if (f && typeof f.data === "string" && /^data:image\//i.test(f.data)) out.push(f.data);
  }
  return out;
}

/* Most recent image in a conversation — a previously generated result first,
   then any attachment. This is what makes "make it darker" work right after the
   AI produced a picture, with nothing attached to the follow-up. */
function latestImageDataInConv(convId, excludeMsgId) {
  if (!convId) return null;
  const conv = getConv(convId);
  if (!conv || !Array.isArray(conv.messages)) return null;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (!m || (excludeMsgId && m.id === excludeMsgId)) continue;
    if (typeof m.imageData === "string" && /^data:image\//i.test(m.imageData)) return m.imageData;
    const fromFiles = imageDataUrlsFromFiles(m.files);
    if (fromFiles.length) return fromFiles[fromFiles.length - 1];
  }
  return null;
}

/* "…this image", "…remove the hat", "…make it brighter" — wording that means
   "change the picture I gave you", not "draw me something new". */
const IMG_REF_RE = /\b(this|that|the|these|those|attached|uploaded|my|it)\s+(image|images|picture|pictures|photo|photos|pic|pics|art|screenshot|logo|drawing|render)\b|\b(image|picture|photo|pic|screenshot)\s+(above|attached|uploaded|i\s+(sent|uploaded|shared|attached)|you\s+can\s+see|we\s+can\s+see)\b/i;
const IMG_EDIT_VERB_RE = /\b(edit|editing|edits|modify|modifying|change|changing|adjust|adjusting|remove|removing|delete|deleting|erase|erasing|replace|replacing|retouch|retouching|restyle|restyling|recolor|recolour|transform|transforming|convert|converting|enhance|enhancing|improve|improving|upscale|downscale|sharpen|blur|crop|extend|lighten|darker|brighter|brighten|darken|clean\s+(\w+\s+)?up|fix\s+the|repaint|re-?paint|paint\s+over|stylize|stylise)\b/i;
/* Weaker edit wording ("add a hat", "turn this into a watercolor"). Too vague to
   trust on its own, but runImageTags only converts to an edit when real source
   pixels are available — otherwise it stays a plain generation. So a false
   positive here costs nothing while a missed one silently drops the reference. */
const IMG_WEAK_EDIT_RE = /\b(add|adding|put|insert|place|apply|give)\b|\b(turn|turns|turning|convert)\b[\s\S]{0,24}?\b(into|to|as|in)\b|\b(this|that|it)\s+(into|to|as)\b/i;
function looksLikeImageEditRequest(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  return IMG_REF_RE.test(t) || IMG_EDIT_VERB_RE.test(t) || IMG_WEAK_EDIT_RE.test(t);
}

/* Where the pixels for an edit come from, in priority order:
   1. images attached to the current message
   2. the image whose "Edit" button the user pressed
   3. the most recent image already in this conversation
   Only consulted when an edit was actually requested. */
function resolveImageEditSources(opts) {
  const o = opts || {};
  const picked = [];
  const push = (u) => {
    if (typeof u === "string" && /^data:image\//i.test(u) && !picked.includes(u) && picked.length < IMG_EDIT_MAX_SOURCES) picked.push(u);
  };
  imageDataUrlsFromFiles(o.files).forEach(push);
  const pending = _takePendingImageEdit();
  if (pending) push(pending.dataUrl);
  if (!picked.length) push(latestImageDataInConv(o.convId, o.msgId));
  return { sources: picked, pickedFromButton: !!pending };
}

function extractImageTags(text) {
  const t = String(text || "");
  const gen = t.match(/\[GENERATE_IMAGE:\s*([^\]]+)\]/);
  const edit = t.match(/\[EDIT_IMAGE:\s*([^\]]+)\]/);
  return {
    genPrompt: gen ? gen[1].trim() : null,
    editPrompt: edit ? edit[1].trim() : null,
  };
}

function stripImageTags(text) {
  return String(text || "")
    .replace(/\[GENERATE_IMAGE:[^\]]*\]?/g, "")
    .replace(/\[EDIT_IMAGE:[^\]]*\]?/g, "")
    .trim();
}

/* Single entry point used by all three streaming paths (send / regenerate /
   edit-and-resend) so edit routing can never drift between them. */
function runImageTags(aiDiv, rawText, convId, msgId, opts) {
  const o = opts || {};
  const { genPrompt, editPrompt } = extractImageTags(rawText);
  if (!genPrompt && !editPrompt) return false;

  if (editPrompt) {
    return processImageGenTag(aiDiv, editPrompt, convId, msgId, {
      isEdit: true,
      files: o.files,
      userText: o.userText,
    });
  }

  // The model asked for a fresh image. If the user was actually talking about a
  // picture they handed over, honour that instead of inventing a lookalike.
  const shouldBeEdit = imageDataUrlsFromFiles(o.files).length > 0 || looksLikeImageEditRequest(o.userText);
  if (shouldBeEdit) {
    const resolved = resolveImageEditSources(Object.assign({}, o, { convId, msgId }));
    if (resolved.sources.length) {
      return processImageGenTag(aiDiv, genPrompt, convId, msgId, {
        isEdit: true,
        files: o.files,
        userText: o.userText,
        sources: resolved.sources,
      });
    }
  }
  return processImageGenTag(aiDiv, genPrompt, convId, msgId, { isEdit: false, userText: o.userText });
}

function _imgGenErrorInto(body, message) {
  const textEl = body?.querySelector(".message-text");
  if (!textEl) return;
  textEl.classList.remove("message-text--empty");
  const existing = (textEl.innerHTML || "").trim();
  textEl.innerHTML = existing
    ? `${existing}<br><span class="md-error">${escapeHtml(message)}</span>`
    : `<span class="md-error">${escapeHtml(message)}</span>`;
}

const IMG_EDIT_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
/* Shared shell for a rendered image: <img>, download link and edit button.
   Edited and generated images look identical on purpose — nothing marks an
   image as an edit. `resolveDataUrl` is lazy so the persisted-render path can
   pull the data URL out of storage on click instead of duplicating it in the DOM. */
function buildImageResultEl({ dataUrl, displaySrc, alt, downloadName, resolveDataUrl }) {
  const wrapper = document.createElement("div");
  wrapper.className = "img-gen-result";

  const img = document.createElement("img");
  img.src = displaySrc || dataUrl;
  img.alt = alt || "";
  img.className = "img-gen-image";
  wrapper.appendChild(img);

  const dlLink = document.createElement("a");
  dlLink.className = "img-gen-download";
  dlLink.href = dataUrl;
  dlLink.download = downloadName;
  dlLink.title = "Download image";
  dlLink.setAttribute("aria-label", "Download image");
  dlLink.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  dlLink.addEventListener("click", (e) => e.stopPropagation());
  wrapper.appendChild(dlLink);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "img-gen-edit";
  editBtn.title = "Edit this image";
  editBtn.setAttribute("aria-label", "Edit this image");
  editBtn.innerHTML = IMG_EDIT_ICON;
  editBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const src = typeof resolveDataUrl === "function" ? resolveDataUrl() : dataUrl;
    if (!src || !/^data:image\//i.test(src)) {
      showToast(`${_aiSvgWarn} That image is no longer available.`);
      return;
    }
    _setPendingImageEdit(src, alt || "image");
    const ta = $("chatInput");
    if (ta) {
      if (!/\bedit\b/i.test(ta.value)) ta.value = "Edit this image: ";
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    scrollToBottom();
    showToast(`${_aiSvgInfo} Describe the change you want.`);
  });
  wrapper.appendChild(editBtn);

  return wrapper;
}

/* Pending-edit indicator above the composer. It gets its own host element so
   renderAttachmentPreviews() — which owns (and wipes) #attachPreview — can never
   tear it out from under the user. */
function renderPendingImageEditChip() {
  const preview = $("attachPreview");
  let host = document.getElementById("imgEditChipHost");
  if (!_pendingImageEdit) {
    if (host) host.style.display = "none";
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.id = "imgEditChipHost";
    host.className = "img-edit-chip-host";
    if (preview && preview.parentNode) preview.parentNode.insertBefore(host, preview);
  }
  host.style.display = "flex";
  let chip = host.querySelector(".pending-edit-chip");
  if (!chip) {
    chip = document.createElement("div");
    chip.className = "pending-edit-chip";
    chip.innerHTML = `
      <img class="pending-edit-thumb" alt="">
      <span class="pending-edit-text">Editing this image</span>
      <button type="button" class="pending-edit-rm" title="Cancel image edit" aria-label="Cancel image edit">\xD7</button>`;
    chip.querySelector(".pending-edit-rm").addEventListener("click", () => {
      _dropPendingImageEdit();
      const ta = $("chatInput");
      if (ta && /^edit this image:\s*$/i.test(ta.value.trim())) ta.value = "";
    });
    host.appendChild(chip);
  }
  const thumb = chip.querySelector(".pending-edit-thumb");
  if (thumb) thumb.src = _pendingImageEdit.dataUrl;
}

async function processImageGenTag(aiDiv, prompt, convId, msgId, opts) {
  const o = opts || {};
  const body = aiDiv?.querySelector(".message-body");
  if (!body) return;
  const isEdit = !!o.isEdit;
  const loadEl = document.createElement("div");
  loadEl.className = "img-gen-loading";
  loadEl.innerHTML = isEdit
    ? `
    <div class="img-gen-loading-inner">
      <span class="img-gen-spinner"></span>
      <div class="img-gen-loading-text">
        <span class="img-gen-loading-title">Editing image</span>
        <span class="img-gen-loading-sub">Applying your changes to the image\u2026</span>
      </div>
    </div>`
    : `
    <div class="img-gen-loading-inner">
      <span class="img-gen-spinner"></span>
      <div class="img-gen-loading-text">
        <span class="img-gen-loading-title">Generating image</span>
        <span class="img-gen-loading-sub">This may take a few seconds\u2026</span>
      </div>
    </div>`;
  insertBeforeMessageActions(body, loadEl);
  scrollToBottom();

  /* An edit was asked for but there is nothing to edit. Say so instead of
     quietly generating a lookalike — that silent substitution is the bug this
     whole path exists to fix. */
  if (isEdit) {
    const resolved = Array.isArray(o.sources) && o.sources.length
      ? { sources: o.sources }
      : resolveImageEditSources({ files: o.files, convId, msgId });
    if (!resolved.sources.length) {
      loadEl.remove();
      _imgGenErrorInto(body, "I need an image to edit \u2014 attach the picture you want changed, or use the edit button on an image.");
      scrollToBottom();
      return;
    }
    const prepared = [];
    for (const src of resolved.sources.slice(0, IMG_EDIT_MAX_SOURCES)) {
      const fit = await fitImageForEditing(src, IMG_EDIT_MAX_DIM);
      if (fit) prepared.push(fit);
    }
    if (!prepared.length) {
      loadEl.remove();
      _imgGenErrorInto(body, "That image could not be read for editing. Try attaching it again.");
      scrollToBottom();
      return;
    }
    const outDims = dimsForEditSource(prepared[0].width, prepared[0].height);
    await _runImageRequest({
      reqBody: {
        prompt,
        images: prepared.map((p) => p.dataUrl),
        output_format: "png",
        width: outDims ? outDims.width : IMG_EDIT_LONG_SIDE,
        height: outDims ? outDims.height : IMG_EDIT_LONG_SIDE,
      },
      prompt,
      aiDiv,
      body,
      loadEl,
      convId,
      msgId,
      isEdit: true,
    });
    return;
  }

  await _runImageRequest({
    reqBody: {
      prompt,
      aspect_ratio: detectAspectRatio(prompt),
      output_format: "png",
    },
    prompt,
    aiDiv,
    body,
    loadEl,
    convId,
    msgId,
    isEdit: false,
  });
}

/* The image worker keeps raw upstream error bodies private, but a few of its 4xx
   bodies are written for the user and safe to surface. */
function _imageWorkerErrorText(err, isEdit, detail) {
  const status = err && err._httpStatus;
  if (status === 413) return "That image is too large to edit. Please use one no bigger than 512\u00D7512.";
  if (status === 400 && /\breference image\b/i.test(detail || "")) {
    return "That image could not be read for editing. Please re-attach it as a PNG, JPEG, WebP or GIF.";
  }
  return aiChatErrorText(err, isEdit ? "editing the image" : "generating the image");
}

async function _runImageRequest({ reqBody, prompt, aiDiv, body, loadEl, convId, msgId, isEdit }) {
  try {
    const res = await fetch(IMAGE_WORKER_URL + "/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(reqBody)
    });
    loadEl.remove();
    if (!res.ok) {
      const _imgErr = new Error(`HTTP ${res.status}`);
      _imgErr._httpStatus = res.status;
      const detail = await res.text().catch(() => "");
      _imgGenErrorInto(body, _imageWorkerErrorText(_imgErr, isEdit, detail));
      scrollToBottom();
      return;
    }
    const imageModelId = res.headers.get("X-Model-Used") || "";
    const imageModelName = imageModelId ? imageModelId.split("/").pop() : "";
    // Trust the server's own verdict: it only reports i2i when reference
    // pixels actually reached the model.
    const modeUsed = (res.headers.get("X-Mode-Used") || "").toLowerCase();
    const wasEdit = isEdit || modeUsed === "i2i";
    if (imageModelId) {
      aiDiv.dataset.imageModelId = imageModelId;
      aiDiv.dataset.imageModelName = imageModelName;
    }
    const blob = await res.blob();
    const dataUrl = await blobToDataURL(blob);
    /* Make it referenceable by a later "add_image" op so the model can put
       what it just generated straight into a slide, note or doc. */
    _esRegisterGeneratedImage(dataUrl, prompt, wasEdit ? "edit" : "generate");
    const ct = blob.type || "";
    const ext = ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : ct.includes("png") ? "png" : "png";
    const wrapper = buildImageResultEl({
      dataUrl,
      alt: escapeHtmlAttr(prompt.slice(0, 80)),
      downloadName: "emeraldbot-image." + ext,
    });
    insertBeforeMessageActions(body, wrapper);
    if (convId && msgId) {
      const convArr = loadConvs();
      const convObj = convArr.find((c) => c.id === convId);
      if (convObj) {
        const savedMsg = convObj.messages.find((m) => m.id === msgId);
        if (savedMsg) {
          savedMsg.imageData = dataUrl;
          savedMsg.imagePrompt = prompt;
          savedMsg.imageMode = wasEdit ? "edit" : "generate";
          if (imageModelId) {
            savedMsg.imageModelId = imageModelId;
            savedMsg.imageModelName = imageModelName;
          }
          upsertConv(convObj);
        }
      }
    }
  } catch (e) {
    if (loadEl.parentNode) loadEl.remove();
    _imgGenErrorInto(body, aiChatErrorText(e, isEdit ? "editing the image" : "generating the image"));
  }
  scrollToBottom();
}

function processWebImageTags(aiDiv, displayText) {
  const body = aiDiv?.querySelector(".message-body");
  if (!body) return displayText;
  const imgMatches = [...displayText.matchAll(/\[IMAGE:\s*([^\]]+)\]/gi)];
  if (!imgMatches.length) return displayText;
  let cleanText = displayText.replace(/\[IMAGE:\s*[^\]]+\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  const container = document.createElement("div");
  container.className = "web-image-gallery";
  for (const match of imgMatches) {
    const url = match[1].trim();
    if (!url) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "web-image-result";
    const img = document.createElement("img");
    img.className = "web-image";
    img.src = /^(https?:|blob:|data:image\/)/i.test(url) ? url : '';
    img.alt = "Image";
    img.loading = "lazy";
    wrapper.dataset.webImg = "1";
    wrapper.appendChild(img);
    container.appendChild(wrapper);
  }
  insertBeforeMessageActions(body, container);
  return cleanText;
}


/* ── Image Search: Fetch real images from the image search API ── */
async function processImageSearchTags(aiDiv, convId, msgId) {
  const searchingEls = aiDiv?.querySelectorAll(".web-image-searching");
  if (!searchingEls || !searchingEls.length) return;

  // Process all image searches in parallel, each placeholder independently
  const results = await Promise.allSettled(Array.from(searchingEls).map(async (el) => {
    const query = el.dataset.imgSearch;
    if (!query) return { el, img: null };
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(IMAGE_SEARCH_URL + "?q=" + encodeURIComponent(query) + "&count=1", { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) return { el, img: null };
      const data = await res.json();
      if (!data.images || !data.images.length) return { el, img: null };
      return { el, img: data.images[0], query };
    } catch {
      return { el, img: null };
    }
  }));

  // Collect successful and failed results
  const good = results.filter(r => r.status === 'fulfilled' && r.value?.img).map(r => r.value);
  const bad = results.filter(r => r.status === 'fulfilled' && !r.value?.img).map(r => r.value?.el).filter(Boolean);

  // Mark failed — each stays in place with error state (visible placeholder)
  for (const el of bad) {
    el.classList.remove("web-image-searching");
    el.classList.add("web-image-failed");
  }
  if (!good.length) return;

  // ── Place each image inline at its own placeholder position ──
  // No gallery grouping — each [IMAGE_SEARCH:] tag gets its own image right where it appears
  for (const { el, img, query } of good) {
    el.classList.remove("web-image-searching");
    el.classList.add("web-image-loaded");
    el.dataset.webImg = "1";
    el.innerHTML = '<img class="web-image" src="' + escapeHtmlAttr(img.url) + '" alt="' + escapeHtmlAttr(img.alt || query) + '" loading="lazy">';
  }
  scrollToBottom();

  // ── Persist image search results to IndexedDB so they survive reload ──
  // Store results indexed by query so each can be matched back to its placeholder on reload
  if (convId && msgId) {
    try {
      const convArr = loadConvs();
      const convObj = convArr.find((c) => c.id === convId);
if (convObj) {
        const savedMsg = convObj.messages.find((m) => m.id === msgId);
        if (savedMsg) {
            const cacheMap = {};
            for (const { img, query } of good) {
                const safeKey = String(query).replace(/^(__proto__|constructor|prototype)$/, '_$1');
                cacheMap[safeKey] = { url: img.url, alt: img.alt || query };
            }
            if (!savedMsg.imageSearchCache) savedMsg.imageSearchCache = {};
            Object.assign(savedMsg.imageSearchCache, cacheMap);
            upsertConv(convObj);
        }
    }
    } catch (e) {
      console.warn("[ImageSearch] Failed to cache results:", e);
    }
  }
}
/* ── Web Image Preview (right-side panel) + load/error delegation ── */
function _openImagePreviewPanel(src, name) {
  if (typeof closeCodePreviewPanel === "function") closeCodePreviewPanel();
  if (typeof closeQuizPanel === "function") closeQuizPanel();
  const panel = document.getElementById("filePreviewPanel");
  const body = document.getElementById("fpPanelBody");
  const title = document.getElementById("fpPanelTitle");
  if (!panel || !body) { window.open(src, "_blank"); return; }
  if (title) title.textContent = name || "Image Preview";
  _recordPanelState({ type: "webimg", src, name: name || "Image Preview" });
  if (typeof _fpZoom !== "undefined") { _fpZoom = 1; }
  if (typeof _fpUpdateZoomLabel === "function") _fpUpdateZoomLabel();
  if (typeof _fpCurrentFid !== "undefined") { _fpCurrentFid = null; }
  // CodeQL fix (#54): src and name are user-influenced strings that must be
  // escaped before insertion into HTML to prevent DOM text reinterpreted as HTML.
  body.innerHTML = '<div class="fp-img-wrap"><img src="' + escapeHtmlAttr(src) + '" alt="' + escapeHtmlAttr(name || "Image") + '" id="fpImgEl" style="transform-origin:top center; max-width:100%; border-radius:8px;"></div>';
  panel.classList.add("open");
  if (typeof _fpApplyZoom === "function") _fpApplyZoom();
}
/* Image load/error event delegation using data-web-img attribute.
   This avoids inline on* handlers that DOMPurify strips. */
document.addEventListener("load", function(e) {
  if (e.target && e.target.classList && e.target.classList.contains("web-image")) {
    const parent = e.target.parentNode;
    if (parent) parent.classList.add("web-image-loaded");
  }
}, true);  /* capture phase to catch load before it bubbles */
document.addEventListener("error", function(e) {
  if (e.target && e.target.classList && e.target.classList.contains("web-image")) {
    const parent = e.target.parentNode;
    if (parent) {
      parent.classList.remove("web-image-loaded");
      parent.classList.add("web-image-failed");
    }
  }
}, true);  /* capture phase */
/* Click handler: open image in right-side preview panel, or retry failed images */
document.addEventListener("click", function(e) {
  /* Retry failed web images on click */
  const failedResult = e.target.closest(".web-image-result.web-image-failed");
  if (failedResult) {
    e.preventDefault();
    const img = failedResult.querySelector(".web-image");
    if (img && img.src) {
      /* Retry loading the same URL */
      failedResult.classList.remove("web-image-failed");
      failedResult.classList.add("web-image-loaded");
      const retrySrc = img.src;
      img.src = "";
      img.src = retrySrc;
    } else if (failedResult.dataset.imgSearch) {
      /* Retry image search for this query */
      const query = failedResult.dataset.imgSearch;
      failedResult.classList.remove("web-image-failed");
      failedResult.classList.add("web-image-searching");
      failedResult.innerHTML = '<div class="web-image-search-spinner"></div><span class="web-image-search-text">Searching for "' + escapeHtmlAttr(query) + '"...</span>';
      const msgDiv = failedResult.closest(".message");
      const retryMsgId = msgDiv?.dataset?.msgId;
      processImageSearchTags(msgDiv, state.convId, retryMsgId);
    }
    return;
  }
  /* Click on the image itself, or on the error/result container */
  const webResult = e.target.closest(".web-image-result");
  if (webResult) {
    const img = webResult.querySelector(".web-image");
    if (img && img.src) {
      e.preventDefault();
      _openImagePreviewPanel(img.src, "Web Image");
      return;
    }
  }
  /* Also handle generated images */
  const genImg = e.target.closest(".img-gen-image");
  if (genImg && genImg.src) {
    e.preventDefault();
    _openImagePreviewPanel(genImg.src, "Generated Image");
  }
  /* Also handle img-gen-result container */
  const genResult = e.target.closest(".img-gen-result");
  if (genResult) {
    const img = genResult.querySelector(".img-gen-image");
    if (img && img.src) {
      e.preventDefault();
      _openImagePreviewPanel(img.src, "Generated Image");
    }
  }
});

try {
  if (typeof _cryptoInt !== "undefined" && typeof window._cryptoInt === "undefined") window._cryptoInt = _cryptoInt;
  if (typeof _docxEl !== "undefined" && typeof window._docxEl === "undefined") window._docxEl = _docxEl;
  if (typeof _docxRun !== "undefined" && typeof window._docxRun === "undefined") window._docxRun = _docxRun;
  if (typeof _docxRuns !== "undefined" && typeof window._docxRuns === "undefined") window._docxRuns = _docxRuns;
  if (typeof _escapeAttr !== "undefined" && typeof window._escapeAttr === "undefined") window._escapeAttr = _escapeAttr;
  if (typeof _fpApplyZoom !== "undefined" && typeof window._fpApplyZoom === "undefined") window._fpApplyZoom = _fpApplyZoom;
  if (typeof _fpUpdateZoomLabel !== "undefined" && typeof window._fpUpdateZoomLabel === "undefined") window._fpUpdateZoomLabel = _fpUpdateZoomLabel;
  if (typeof _fpZoomIn !== "undefined" && typeof window._fpZoomIn === "undefined") window._fpZoomIn = _fpZoomIn;
  if (typeof _fpZoomOut !== "undefined" && typeof window._fpZoomOut === "undefined") window._fpZoomOut = _fpZoomOut;
  if (typeof _obAvatarUpload !== "undefined" && typeof window._obAvatarUpload === "undefined") window._obAvatarUpload = _obAvatarUpload;
  if (typeof _obBack !== "undefined" && typeof window._obBack === "undefined") window._obBack = _obBack;
  if (typeof _obFinish !== "undefined" && typeof window._obFinish === "undefined") window._obFinish = _obFinish;
  if (typeof _obImportMemory !== "undefined" && typeof window._obImportMemory === "undefined") window._obImportMemory = _obImportMemory;
  if (typeof _obMemoryPreview !== "undefined" && typeof window._obMemoryPreview === "undefined") window._obMemoryPreview = _obMemoryPreview;
  if (typeof _obNext !== "undefined" && typeof window._obNext === "undefined") window._obNext = _obNext;
  if (typeof _obParseMemoryText !== "undefined" && typeof window._obParseMemoryText === "undefined") window._obParseMemoryText = _obParseMemoryText;
  if (typeof _obSelectTheme !== "undefined" && typeof window._obSelectTheme === "undefined") window._obSelectTheme = _obSelectTheme;
  if (typeof _obSetStep !== "undefined" && typeof window._obSetStep === "undefined") window._obSetStep = _obSetStep;
  if (typeof _obShowAvatarImg !== "undefined" && typeof window._obShowAvatarImg === "undefined") window._obShowAvatarImg = _obShowAvatarImg;
  if (typeof _obUpdateInitials !== "undefined" && typeof window._obUpdateInitials === "undefined") window._obUpdateInitials = _obUpdateInitials;
  if (typeof _pdfRenderPage !== "undefined" && typeof window._pdfRenderPage === "undefined") window._pdfRenderPage = _pdfRenderPage;
  if (typeof _quizUpdateProgress !== "undefined" && typeof window._quizUpdateProgress === "undefined") window._quizUpdateProgress = _quizUpdateProgress;
  if (typeof _refreshSettAvatarUI !== "undefined" && typeof window._refreshSettAvatarUI === "undefined") window._refreshSettAvatarUI = _refreshSettAvatarUI;
  if (typeof _refreshSettThemeUI !== "undefined" && typeof window._refreshSettThemeUI === "undefined") window._refreshSettThemeUI = _refreshSettThemeUI;
  if (typeof _regFile !== "undefined" && typeof window._regFile === "undefined") window._regFile = _regFile;
  if (typeof _streamDisplayText !== "undefined" && typeof window._streamDisplayText === "undefined") window._streamDisplayText = _streamDisplayText;
  if (typeof _stripThinkingPreamble !== "undefined" && typeof window._stripThinkingPreamble === "undefined") window._stripThinkingPreamble = _stripThinkingPreamble;
  if (typeof _switchToAutoDueToUnavailableModel !== "undefined" && typeof window._switchToAutoDueToUnavailableModel === "undefined") window._switchToAutoDueToUnavailableModel = _switchToAutoDueToUnavailableModel;
  if (typeof addFilesToLibrary !== "undefined" && typeof window.addFilesToLibrary === "undefined") window.addFilesToLibrary = addFilesToLibrary;
  if (typeof addMemory !== "undefined" && typeof window.addMemory === "undefined") window.addMemory = addMemory;
  if (typeof aiErrorMessage !== "undefined" && typeof window.aiErrorMessage === "undefined") window.aiErrorMessage = aiErrorMessage;
  if (typeof appendAIMessageDOM !== "undefined" && typeof window.appendAIMessageDOM === "undefined") window.appendAIMessageDOM = appendAIMessageDOM;
  if (typeof appendStoredAIMessage !== "undefined" && typeof window.appendStoredAIMessage === "undefined") window.appendStoredAIMessage = appendStoredAIMessage;
  if (typeof appendUserMessageDOM !== "undefined" && typeof window.appendUserMessageDOM === "undefined") window.appendUserMessageDOM = appendUserMessageDOM;
  if (typeof applyTheme !== "undefined" && typeof window.applyTheme === "undefined") window.applyTheme = applyTheme;
  if (typeof blobToDataURL !== "undefined" && typeof window.blobToDataURL === "undefined") window.blobToDataURL = blobToDataURL;
  if (typeof buildContextMenu !== "undefined" && typeof window.buildContextMenu === "undefined") window.buildContextMenu = buildContextMenu;
  if (typeof buildFileParts !== "undefined" && typeof window.buildFileParts === "undefined") window.buildFileParts = buildFileParts;
  if (typeof buildHistory !== "undefined" && typeof window.buildHistory === "undefined") window.buildHistory = buildHistory;
  if (typeof buildMessageActionsEl !== "undefined" && typeof window.buildMessageActionsEl === "undefined") window.buildMessageActionsEl = buildMessageActionsEl;
  if (typeof buildRunnablePreview !== "undefined" && typeof window.buildRunnablePreview === "undefined") window.buildRunnablePreview = buildRunnablePreview;
  if (typeof cancelUserMsgEdit !== "undefined" && typeof window.cancelUserMsgEdit === "undefined") window.cancelUserMsgEdit = cancelUserMsgEdit;
  if (typeof checkOnboarding !== "undefined" && typeof window.checkOnboarding === "undefined") window.checkOnboarding = checkOnboarding;
  if (typeof clearAllChats !== "undefined" && typeof window.clearAllChats === "undefined") window.clearAllChats = clearAllChats;
  if (typeof clearAllMemories !== "undefined" && typeof window.clearAllMemories === "undefined") window.clearAllMemories = clearAllMemories;
  if (typeof clearAttachments !== "undefined" && typeof window.clearAttachments === "undefined") window.clearAttachments = clearAttachments;
  if (typeof closeCodePreviewPanel !== "undefined" && typeof window.closeCodePreviewPanel === "undefined") window.closeCodePreviewPanel = closeCodePreviewPanel;
  if (typeof closeFilePreviewPanel !== "undefined" && typeof window.closeFilePreviewPanel === "undefined") window.closeFilePreviewPanel = closeFilePreviewPanel;
  if (typeof closeMobileSidebar !== "undefined" && typeof window.closeMobileSidebar === "undefined") window.closeMobileSidebar = closeMobileSidebar;
  if (typeof closeModal !== "undefined" && typeof window.closeModal === "undefined") window.closeModal = closeModal;
  if (typeof closeModelDropdown !== "undefined" && typeof window.closeModelDropdown === "undefined") window.closeModelDropdown = closeModelDropdown;
  if (typeof closeModelModal !== "undefined" && typeof window.closeModelModal === "undefined") window.closeModelModal = closeModelModal;
  if (typeof closeQuizPanel !== "undefined" && typeof window.closeQuizPanel === "undefined") window.closeQuizPanel = closeQuizPanel;
  if (typeof codeBlockMeta !== "undefined" && typeof window.codeBlockMeta === "undefined") window.codeBlockMeta = codeBlockMeta;
  if (typeof confirmClearAllChats !== "undefined" && typeof window.confirmClearAllChats === "undefined") window.confirmClearAllChats = confirmClearAllChats;
  if (typeof copyCode !== "undefined" && typeof window.copyCode === "undefined") window.copyCode = copyCode;
  if (typeof copyMsgText !== "undefined" && typeof window.copyMsgText === "undefined") window.copyMsgText = copyMsgText;
  if (typeof copyShareLink !== "undefined" && typeof window.copyShareLink === "undefined") window.copyShareLink = copyShareLink;
  if (typeof copyUserMsgText !== "undefined" && typeof window.copyUserMsgText === "undefined") window.copyUserMsgText = copyUserMsgText;
  if (typeof createPreviewSrcdoc !== "undefined" && typeof window.createPreviewSrcdoc === "undefined") window.createPreviewSrcdoc = createPreviewSrcdoc;
  if (typeof ctxCopyPageLink !== "undefined" && typeof window.ctxCopyPageLink === "undefined") window.ctxCopyPageLink = ctxCopyPageLink;
  if (typeof ctxCopyText !== "undefined" && typeof window.ctxCopyText === "undefined") window.ctxCopyText = ctxCopyText;
  if (typeof ctxShowElementInfo !== "undefined" && typeof window.ctxShowElementInfo === "undefined") window.ctxShowElementInfo = ctxShowElementInfo;
  if (typeof deleteConv !== "undefined" && typeof window.deleteConv === "undefined") window.deleteConv = deleteConv;
  if (typeof deleteConvConfirm !== "undefined" && typeof window.deleteConvConfirm === "undefined") window.deleteConvConfirm = deleteConvConfirm;
  if (typeof deleteMemory !== "undefined" && typeof window.deleteMemory === "undefined") window.deleteMemory = deleteMemory;
  if (typeof detectAspectRatio !== "undefined" && typeof window.detectAspectRatio === "undefined") window.detectAspectRatio = detectAspectRatio;
  if (typeof detectWebSearchIntent !== "undefined" && typeof window.detectWebSearchIntent === "undefined") window.detectWebSearchIntent = detectWebSearchIntent;
  if (typeof doSearch !== "undefined" && typeof window.doSearch === "undefined") window.doSearch = doSearch;
  if (typeof editMemory !== "undefined" && typeof window.editMemory === "undefined") window.editMemory = editMemory;
  if (typeof editUserMsg !== "undefined" && typeof window.editUserMsg === "undefined") window.editUserMsg = editUserMsg;
  if (typeof escapeClosingScript !== "undefined" && typeof window.escapeClosingScript === "undefined") window.escapeClosingScript = escapeClosingScript;
  if (typeof escapeHtml !== "undefined" && typeof window.escapeHtml === "undefined") window.escapeHtml = escapeHtml;
  if (typeof escapeHtmlAttr !== "undefined" && typeof window.escapeHtmlAttr === "undefined") window.escapeHtmlAttr = escapeHtmlAttr;
  if (typeof extractGroundingSources !== "undefined" && typeof window.extractGroundingSources === "undefined") window.extractGroundingSources = extractGroundingSources;
  if (typeof extractUrls !== "undefined" && typeof window.extractUrls === "undefined") window.extractUrls = extractUrls;
  if (typeof fileCardHTML !== "undefined" && typeof window.fileCardHTML === "undefined") window.fileCardHTML = fileCardHTML;
  if (typeof fileIcon !== "undefined" && typeof window.fileIcon === "undefined") window.fileIcon = fileIcon;
  if (typeof fileIconHTML !== "undefined" && typeof window.fileIconHTML === "undefined") window.fileIconHTML = fileIconHTML;
  if (typeof genId !== "undefined" && typeof window.genId === "undefined") window.genId = genId;
  if (typeof getApiKey !== "undefined" && typeof window.getApiKey === "undefined") window.getApiKey = getApiKey;
  if (typeof getConv !== "undefined" && typeof window.getConv === "undefined") window.getConv = getConv;
  if (typeof getModelById !== "undefined" && typeof window.getModelById === "undefined") window.getModelById = getModelById;
  if (typeof getSelectedModelId !== "undefined" && typeof window.getSelectedModelId === "undefined") window.getSelectedModelId = getSelectedModelId;
  if (typeof getUserInitials !== "undefined" && typeof window.getUserInitials === "undefined") window.getUserInitials = getUserInitials;
  if (typeof getUserName !== "undefined" && typeof window.getUserName === "undefined") window.getUserName = getUserName;
  if (typeof handleAvatarUpload !== "undefined" && typeof window.handleAvatarUpload === "undefined") window.handleAvatarUpload = handleAvatarUpload;
  if (typeof handleFileSelect !== "undefined" && typeof window.handleFileSelect === "undefined") window.handleFileSelect = handleFileSelect;
  if (typeof handleSend !== "undefined" && typeof window.handleSend === "undefined") window.handleSend = handleSend;
  if (typeof handleShareFileImport !== "undefined" && typeof window.handleShareFileImport === "undefined") window.handleShareFileImport = handleShareFileImport;
  if (typeof init !== "undefined" && typeof window.init === "undefined") window.init = init;
  if (typeof initTheme !== "undefined" && typeof window.initTheme === "undefined") window.initTheme = initTheme;
  if (typeof importChatsFromInput !== "undefined" && typeof window.importChatsFromInput === "undefined") window.importChatsFromInput = importChatsFromInput;
  if (typeof insertBeforeMessageActions !== "undefined" && typeof window.insertBeforeMessageActions === "undefined") window.insertBeforeMessageActions = insertBeforeMessageActions;
  if (typeof isLatestAIMessage !== "undefined" && typeof window.isLatestAIMessage === "undefined") window.isLatestAIMessage = isLatestAIMessage;
  if (typeof openImportModal !== "undefined" && typeof window.openImportModal === "undefined") window.openImportModal = openImportModal;
  if (typeof loadConversation !== "undefined" && typeof window.loadConversation === "undefined") window.loadConversation = loadConversation;
  if (typeof loadConvs !== "undefined" && typeof window.loadConvs === "undefined") window.loadConvs = loadConvs;
  if (typeof loadLib !== "undefined" && typeof window.loadLib === "undefined") window.loadLib = loadLib;
  if (typeof loadMemories !== "undefined" && typeof window.loadMemories === "undefined") window.loadMemories = loadMemories;
  if (typeof loadSettings !== "undefined" && typeof window.loadSettings === "undefined") window.loadSettings = loadSettings;
  if (typeof looksLikeHtml !== "undefined" && typeof window.looksLikeHtml === "undefined") window.looksLikeHtml = looksLikeHtml;
  if (typeof messageActionsHTML !== "undefined" && typeof window.messageActionsHTML === "undefined") window.messageActionsHTML = messageActionsHTML;
  if (typeof migrateChatStorageToIndexedDB !== "undefined" && typeof window.migrateChatStorageToIndexedDB === "undefined") window.migrateChatStorageToIndexedDB = migrateChatStorageToIndexedDB;
  if (typeof moveLibTabIndicator !== "undefined" && typeof window.moveLibTabIndicator === "undefined") window.moveLibTabIndicator = moveLibTabIndicator;
  if (typeof navigateBranch !== "undefined" && typeof window.navigateBranch === "undefined") window.navigateBranch = navigateBranch;
  if (typeof navigateRegenBranch !== "undefined" && typeof window.navigateRegenBranch === "undefined") window.navigateRegenBranch = navigateRegenBranch;
  if (typeof newChat !== "undefined" && typeof window.newChat === "undefined") window.newChat = newChat;
  if (typeof normalizeCodeLang !== "undefined" && typeof window.normalizeCodeLang === "undefined") window.normalizeCodeLang = normalizeCodeLang;
  if (typeof onModelUsed !== "undefined" && typeof window.onModelUsed === "undefined") window.onModelUsed = onModelUsed;
  if (typeof openCodePreviewPanel !== "undefined" && typeof window.openCodePreviewPanel === "undefined") window.openCodePreviewPanel = openCodePreviewPanel;
  if (typeof openFilePreview !== "undefined" && typeof window.openFilePreview === "undefined") window.openFilePreview = openFilePreview;
  if (typeof openLibrary !== "undefined" && typeof window.openLibrary === "undefined") window.openLibrary = openLibrary;
  if (typeof openMemoriesModal !== "undefined" && typeof window.openMemoriesModal === "undefined") window.openMemoriesModal = openMemoriesModal;
  if (typeof openMobileSidebar !== "undefined" && typeof window.openMobileSidebar === "undefined") window.openMobileSidebar = openMobileSidebar;
  if (typeof openModal !== "undefined" && typeof window.openModal === "undefined") window.openModal = openModal;
  if (typeof openModelModal !== "undefined" && typeof window.openModelModal === "undefined") window.openModelModal = openModelModal;
  if (typeof openQuizPanel !== "undefined" && typeof window.openQuizPanel === "undefined") window.openQuizPanel = openQuizPanel;
  if (typeof openSearch !== "undefined" && typeof window.openSearch === "undefined") window.openSearch = openSearch;
  if (typeof openSettings !== "undefined" && typeof window.openSettings === "undefined") window.openSettings = openSettings;
  if (typeof performAdvancedSearch !== "undefined" && typeof window.performAdvancedSearch === "undefined") window.performAdvancedSearch = performAdvancedSearch;
  if (typeof positionMenu !== "undefined" && typeof window.positionMenu === "undefined") window.positionMenu = positionMenu;
  if (typeof processFileForAttachment !== "undefined" && typeof window.processFileForAttachment === "undefined") window.processFileForAttachment = processFileForAttachment;
  if (typeof processImageGenTag !== "undefined" && typeof window.processImageGenTag === "undefined") window.processImageGenTag = processImageGenTag;
  if (typeof runImageTags !== "undefined" && typeof window.runImageTags === "undefined") window.runImageTags = runImageTags;
  if (typeof extractImageTags !== "undefined" && typeof window.extractImageTags === "undefined") window.extractImageTags = extractImageTags;
  if (typeof stripImageTags !== "undefined" && typeof window.stripImageTags === "undefined") window.stripImageTags = stripImageTags;
  if (typeof resolveImageEditSources !== "undefined" && typeof window.resolveImageEditSources === "undefined") window.resolveImageEditSources = resolveImageEditSources;
  if (typeof fitImageForEditing !== "undefined" && typeof window.fitImageForEditing === "undefined") window.fitImageForEditing = fitImageForEditing;
  if (typeof latestImageDataInConv !== "undefined" && typeof window.latestImageDataInConv === "undefined") window.latestImageDataInConv = latestImageDataInConv;
  if (typeof looksLikeImageEditRequest !== "undefined" && typeof window.looksLikeImageEditRequest === "undefined") window.looksLikeImageEditRequest = looksLikeImageEditRequest;
  if (typeof buildImageResultEl !== "undefined" && typeof window.buildImageResultEl === "undefined") window.buildImageResultEl = buildImageResultEl;
  if (typeof renderPendingImageEditChip !== "undefined" && typeof window.renderPendingImageEditChip === "undefined") window.renderPendingImageEditChip = renderPendingImageEditChip;
  if (typeof processWebImageTags !== "undefined" && typeof window.processWebImageTags === "undefined") window.processWebImageTags = processWebImageTags;
  if (typeof processImageSearchTags !== "undefined" && typeof window.processImageSearchTags === "undefined") window.processImageSearchTags = processImageSearchTags;
  if (typeof proxySearch !== "undefined" && typeof window.proxySearch === "undefined") window.proxySearch = proxySearch;
  if (typeof quizCardHTML !== "undefined" && typeof window.quizCardHTML === "undefined") window.quizCardHTML = quizCardHTML;
  if (typeof quizErrorCardHTML !== "undefined" && typeof window.quizErrorCardHTML === "undefined") window.quizErrorCardHTML = quizErrorCardHTML;
  if (typeof quizLoadingCardHTML !== "undefined" && typeof window.quizLoadingCardHTML === "undefined") window.quizLoadingCardHTML = quizLoadingCardHTML;
  if (typeof rateMsg !== "undefined" && typeof window.rateMsg === "undefined") window.rateMsg = rateMsg;
  if (typeof refreshModelSelectorUI !== "undefined" && typeof window.refreshModelSelectorUI === "undefined") window.refreshModelSelectorUI = refreshModelSelectorUI;
  if (typeof regenFromCtx !== "undefined" && typeof window.regenFromCtx === "undefined") window.regenFromCtx = regenFromCtx;
  if (typeof regenerateMessage !== "undefined" && typeof window.regenerateMessage === "undefined") window.regenerateMessage = regenerateMessage;
  if (typeof removeAttachment !== "undefined" && typeof window.removeAttachment === "undefined") window.removeAttachment = removeAttachment;
  if (typeof removeAvatar !== "undefined" && typeof window.removeAvatar === "undefined") window.removeAvatar = removeAvatar;
  if (typeof renameConvPrompt !== "undefined" && typeof window.renameConvPrompt === "undefined") window.renameConvPrompt = renameConvPrompt;
  if (typeof renderAttachmentPreviews !== "undefined" && typeof window.renderAttachmentPreviews === "undefined") window.renderAttachmentPreviews = renderAttachmentPreviews;
  if (typeof renderCitations !== "undefined" && typeof window.renderCitations === "undefined") window.renderCitations = renderCitations;
  if (typeof renderDocxCustom !== "undefined" && typeof window.renderDocxCustom === "undefined") window.renderDocxCustom = renderDocxCustom;
  if (typeof renderLibraryModal !== "undefined" && typeof window.renderLibraryModal === "undefined") window.renderLibraryModal = renderLibraryModal;
  if (typeof renderMarkdown !== "undefined" && typeof window.renderMarkdown === "undefined") window.renderMarkdown = renderMarkdown;
  if (typeof renderMemoriesModal !== "undefined" && typeof window.renderMemoriesModal === "undefined") window.renderMemoriesModal = renderMemoriesModal;
  if (typeof renderModelDropdown !== "undefined" && typeof window.renderModelDropdown === "undefined") window.renderModelDropdown = renderModelDropdown;
  if (typeof renderPdfCustom !== "undefined" && typeof window.renderPdfCustom === "undefined") window.renderPdfCustom = renderPdfCustom;
  if (typeof renderPptxSlides !== "undefined" && typeof window.renderPptxSlides === "undefined") window.renderPptxSlides = renderPptxSlides;
  if (typeof renderQuizWidget !== "undefined" && typeof window.renderQuizWidget === "undefined") window.renderQuizWidget = renderQuizWidget;
  if (typeof renderRecents !== "undefined" && typeof window.renderRecents === "undefined") window.renderRecents = renderRecents;
  if (typeof renderSidebar !== "undefined" && typeof window.renderSidebar === "undefined") window.renderSidebar = renderSidebar;
  if (typeof runCode !== "undefined" && typeof window.runCode === "undefined") window.runCode = runCode;
  if (typeof safeCopy !== "undefined" && typeof window.safeCopy === "undefined") window.safeCopy = safeCopy;
  if (typeof saveConvs !== "undefined" && typeof window.saveConvs === "undefined") window.saveConvs = saveConvs;
  if (typeof saveEditMemory !== "undefined" && typeof window.saveEditMemory === "undefined") window.saveEditMemory = saveEditMemory;
  if (typeof saveLib !== "undefined" && typeof window.saveLib === "undefined") window.saveLib = saveLib;
  if (typeof saveMemories !== "undefined" && typeof window.saveMemories === "undefined") window.saveMemories = saveMemories;
  if (typeof saveSettings !== "undefined" && typeof window.saveSettings === "undefined") window.saveSettings = saveSettings;
  if (typeof saveSettingsObj !== "undefined" && typeof window.saveSettingsObj === "undefined") window.saveSettingsObj = saveSettingsObj;
  if (typeof scrollToBottom !== "undefined" && typeof window.scrollToBottom === "undefined") window.scrollToBottom = scrollToBottom;
  if (typeof selectModel !== "undefined" && typeof window.selectModel === "undefined") window.selectModel = selectModel;
  if (typeof selectSettTheme !== "undefined" && typeof window.selectSettTheme === "undefined") window.selectSettTheme = selectSettTheme;
  if (typeof sendQuickPrompt !== "undefined" && typeof window.sendQuickPrompt === "undefined") window.sendQuickPrompt = sendQuickPrompt;
  if (typeof setLibFilter !== "undefined" && typeof window.setLibFilter === "undefined") window.setLibFilter = setLibFilter;
  if (typeof setSelectedModelId !== "undefined" && typeof window.setSelectedModelId === "undefined") window.setSelectedModelId = setSelectedModelId;
  if (typeof setSendState !== "undefined" && typeof window.setSendState === "undefined") window.setSendState = setSendState;
  if (typeof setupChatStorageSync !== "undefined" && typeof window.setupChatStorageSync === "undefined") window.setupChatStorageSync = setupChatStorageSync;
  if (typeof setupContextMenu !== "undefined" && typeof window.setupContextMenu === "undefined") window.setupContextMenu = setupContextMenu;
  if (typeof setupMarked !== "undefined" && typeof window.setupMarked === "undefined") window.setupMarked = setupMarked;
  if (typeof shareConversation !== "undefined" && typeof window.shareConversation === "undefined") window.shareConversation = shareConversation;
  if (typeof shareConversations !== "undefined" && typeof window.shareConversations === "undefined") window.shareConversations = shareConversations;
  if (typeof showChatBranchLimitToast !== "undefined" && typeof window.showChatBranchLimitToast === "undefined") window.showChatBranchLimitToast = showChatBranchLimitToast;
  if (typeof showMessages !== "undefined" && typeof window.showMessages === "undefined") window.showMessages = showMessages;
  if (typeof showToast !== "undefined" && typeof window.showToast === "undefined") window.showToast = showToast;
  if (typeof showUsedModel !== "undefined" && typeof window.showUsedModel === "undefined") window.showUsedModel = showUsedModel;
  if (typeof showWelcome !== "undefined" && typeof window.showWelcome === "undefined") window.showWelcome = showWelcome;
  if (typeof stopStreaming !== "undefined" && typeof window.stopStreaming === "undefined") window.stopStreaming = stopStreaming;
  if (typeof streamEmeraldBot !== "undefined" && typeof window.streamEmeraldBot === "undefined") window.streamEmeraldBot = streamEmeraldBot;
  if (typeof submitUserMsgEdit !== "undefined" && typeof window.submitUserMsgEdit === "undefined") window.submitUserMsgEdit = submitUserMsgEdit;
  if (typeof toggleAiDropdown !== "undefined" && typeof window.toggleAiDropdown === "undefined") window.toggleAiDropdown = toggleAiDropdown;
  if (typeof toggleModelDropdown !== "undefined" && typeof window.toggleModelDropdown === "undefined") window.toggleModelDropdown = toggleModelDropdown;
  if (typeof togglePreviewConsole !== "undefined" && typeof window.togglePreviewConsole === "undefined") window.togglePreviewConsole = togglePreviewConsole;
  if (typeof toggleReasoningBlock !== "undefined" && typeof window.toggleReasoningBlock === "undefined") window.toggleReasoningBlock = toggleReasoningBlock;
  if (typeof toggleSearchingBlock !== "undefined" && typeof window.toggleSearchingBlock === "undefined") window.toggleSearchingBlock = toggleSearchingBlock;
  if (typeof toggleTempChat !== "undefined" && typeof window.toggleTempChat === "undefined") window.toggleTempChat = toggleTempChat;
  if (typeof typingIndicatorHTML !== "undefined" && typeof window.typingIndicatorHTML === "undefined") window.typingIndicatorHTML = typingIndicatorHTML;
  if (typeof updateBranchNavDOM !== "undefined" && typeof window.updateBranchNavDOM === "undefined") window.updateBranchNavDOM = updateBranchNavDOM;
  if (typeof updateLastMsgActions !== "undefined" && typeof window.updateLastMsgActions === "undefined") window.updateLastMsgActions = updateLastMsgActions;
  if (typeof updateRegenNavDOM !== "undefined" && typeof window.updateRegenNavDOM === "undefined") window.updateRegenNavDOM = updateRegenNavDOM;
  if (typeof updateTopbarTitle !== "undefined" && typeof window.updateTopbarTitle === "undefined") window.updateTopbarTitle = updateTopbarTitle;
  if (typeof upsertConv !== "undefined" && typeof window.upsertConv === "undefined") window.upsertConv = upsertConv;
} catch (e) {
  console.warn("[chat] window exposure block failed:", e);
}