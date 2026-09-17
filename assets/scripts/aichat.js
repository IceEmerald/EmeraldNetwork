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
  { id: "astra",     name: "EmeraldCore Astra",     short: "Astra",     tier: "v4.2", desc: "Frontier flagship â€” ultra-deep reasoning, autonomous multi-step tasks, cross-domain synthesis." },
  { id: "ruby",      name: "EmeraldCore Ruby",      short: "Ruby",      tier: "v4.2", desc: "Multimodal precision â€” vision, data science, scientific analysis, structured output." },
  { id: "gamma",     name: "EmeraldCore Gamma",     short: "Gamma",     tier: "v4.1", desc: "Deepest reasoning â€” math, code, hard logic." },
  { id: "diamond",   name: "EmeraldCore Diamond",   short: "Diamond",   tier: "v4",   desc: "Creative strategy, planning, long-form writing." },
  { id: "gold",      name: "EmeraldCore Gold",      short: "Gold",      tier: "v4",   desc: "Research, fact-checking, in-depth analysis." },
  { id: "kappa",     name: "EmeraldCore Kappa",     short: "Kappa",     tier: "v3.5", desc: "Versatile â€” web, roleplay, basic math." },
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
/* â”€â”€ Reasoning mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  btn.title = on ? "Reasoning mode is ON â€” slower, deeper answers." : "Turn on reasoning mode";
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
    // Migration failure shouldn't crash init â€” log so it's not invisible.
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
    if (isOffice && f.extractedText) {
      try {
        const txt = `[File: ${f.name}]
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
      parts.push({ inlineData: { mimeType: type, data: b64 } });
    } else if (isTextExt) {
      parts.push({ inlineData: { mimeType: "text/plain", data: b64 } });
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
    // `escHtml` / `truncate` were never defined in this codebase â€” use the
    // real `escapeHtml` helper and inline the truncation.
    const preview = escapeHtml(selectedText.length > 100 ? selectedText.slice(0, 100) + "â€¦" : selectedText);
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
          return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(inline, { ADD_ATTR: ["target", "loading", "referrerpolicy", "onerror", "onload", "data-web-img"] }) : inline;
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
      // marked v18: token.tokens contains parsed child tokens â€” render recursively
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
//   (A) \color{X}{Y}      â€” TWO-ARG, INVALID LaTeX. The model treats \color
//                           as if it were \textcolor. NOT standard LaTeX
//                           (in real LaTeX, \color{X} sets the color for the
//                           rest of the group; the following {Y} is a
//                           separate group). KaTeX accepts this but it is
//                           brittle. We convert it to \textcolor{X}{Y}.
//
//   (B) \color{X}content  â€” ONE-ARG SWITCH (the real LaTeX form). Sets color
//                           for the rest of the current group. We find the
//                           enclosing {...} group and wrap its content in
//                           \textcolor{X}{...}.
//                           e.g.  e^{\color{red}i\pi}  â†’  e^{\textcolor{red}{i\pi}}
//
//   (C) \textcolor{X}{Y}  â€” already correct. Leave alone.
//
// Pass 1 handles (A). Pass 2 handles (B). Existing \textcolor is untouched.
function _preprocessLatexColor(src) {
  if (!src || src.indexOf('\\color{') === -1) return src;
  let result = src;

  // â”€â”€ Pass 1: \color{X}{Y} (two-arg malformed) â†’ \textcolor{X}{Y}
  // Match \color{X} immediately followed by { (with optional whitespace).
  // Replace only the \color{X} part â€” leave the {Y} part intact so the
  // closing brace of Y stays balanced. Effect: \color{X}{Y} â†’ \textcolor{X}{Y}.
  // We must NOT touch \textcolor{X}{Y} (already correct). The regex below
  // only matches \color{ (not \textcolor{) because of the negative lookbehind
  // for "text" before the backslash.
  result = result.replace(/(?<!\\text)\\color\{([^}]+)\}(\s*)\{/g,
    (full, color, ws) => '\\textcolor{' + color + '}' + ws + '{');

  // â”€â”€ Pass 2: \color{X}content (one-arg switch) â†’ \textcolor{X}{content}
  // Now any remaining \color{X} is the switch form (NOT immediately followed
  // by a { group of its own). Find the enclosing {...} group and wrap its
  // content in \textcolor{X}{...}.
  //   e.g.  e^{\color{red}i\pi}  â†’  e^{\textcolor{red}{i\pi}}
  //   e.g.  {\color{blue}a + b}  â†’  {\textcolor{blue}{a + b}}
  const re = /\\color\{([^}]+)\}/g;
  let match;
  const replacements = [];
  while ((match = re.exec(result)) !== null) {
    const start = match.index;
    const afterColor = start + match[0].length;
    const color = match[1];
    // Skip if immediately followed by { â€” that was Pass 1's job.
    // (Pass 1 already converted those, but be defensive in case the regex
    // missed something â€” e.g. whitespace edge cases.)
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
// full word on the following line â€” when the collapsed word exactly prefixes
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

function renderMarkdown(raw) {
  if (typeof marked === "undefined") return escapeHtml(raw);
  let text = raw;
  text = text.replace(/<quiz>[\s\S]*?<\/quiz>/g, "");
  text = text.replace(/<quiz>[\s\S]*$/g, "");
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
  // and with throwOnError:false it falls back to raw markup â€” the
  // "raw LaTeX" / "mashed words" bug.
  //
  // Fix: use an exec-based loop with content validation. When a match is
  // rejected (not valid math), we advance past only the opening $, so the
  // closing $ can serve as the opening $ of the next potential math block.
  // This correctly handles "$currency. Math is $e^{i\pi}$." â€” the first
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
      // The 's' flag lets math span newlines â€” the model frequently wraps
      // multi-line expressions in $...$ (and hallucinates single-char line
      // runs), which previously leaked as literal "$...$" text.
      const _hasLaTeX = /\\[a-zA-Z]/.test(_inner);
      const _isCurrency = !_hasLaTeX && (
        /(?:^|\D)\d{1,3}(?:,\d{3})+(?:\.\d+)?/.test(_inner) ||
        /\d\.\d/.test(_inner) ||
        (/^[^\d]*\d[\d,]*$/.test(_inner) && _inner.replace(/[,\s]/g, "").length >= 5)
      );
      // Char-by-char hallucination: >=3 single-character lines inside a
      // $...$ span means the model broke a sentence apart (e.g. "R\nu\nm\nu\n
      // s\n:\n"). Real math never has that, so reject EVEN IF LaTeX commands
      // are present â€” the span is contaminated prose, not a formula.
      const _soloChars = _inner.split("\n").filter((l) => l.trim().length === 1 && /\S/.test(l)).length;
      const _isProse = /["â€œâ€]/.test(_inner) || _soloChars >= 3 || (!_hasLaTeX && (_inner.match(/[a-zA-Z]{2,}/g) || []).length >= 3);
      if (/\.\s/.test(_inner) || /\n\s*\n/.test(_inner) || _isCurrency || _isProse) {
        // Not valid math â€” keep the opening $ and content as literal text,
        // but let the closing $ be re-scanned as a potential opening $
        _result += text.slice(_lastEnd, _fullStart + 1 + _inner.length);
        _lastEnd = _fullStart + 1 + _inner.length; // position of closing $
        _mathRe.lastIndex = _lastEnd;
      } else {
        // Valid math â€” replace with placeholder (consume both $ signs)
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
  // (e.g. \(e^{i\pi}\)) â€” the old regex [^\\\n]+? stopped at the first \.
  text = text.replace(/\\\(((?:(?!\\\))[\s\S])+?)\\\)/g, (_, m) => {
    const i = mathBlocks.push({ type: "inline", src: m }) - 1;
    return `MATHINLINE${i}MATHINLINE`;
  });
  text = _collapseCharByCharRuns(text);
  text = text.replace(/\x02CODEBLOCK(\d+)\x02/g, (_, i) => codeBlocks[+i]);
  let html = marked.parse(text);
  if (typeof DOMPurify !== "undefined") {
    html = DOMPurify.sanitize(html, { ADD_ATTR: ["target", "loading", "referrerpolicy", "onerror", "onload", "data-web-img"] });
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
function _extractMemories(text) {
  const out = [];
  const s = String(text || "");
  for (const bm of s.matchAll(/\[MEMORY\]([\s\S]*?)\[\/MEMORY\]/g)) {
    const t = bm[1].trim();
    if (t) out.push({ tag: bm[0], text: t });
  }
  const cleaned = s.replace(/\[MEMORY\]([\s\S]*?)\[\/MEMORY\]/g, " ");
  for (const im of cleaned.matchAll(/\[MEMORY:\s*([^\]]+)\]/g)) {
    const t = im[1].trim();
    if (t) out.push({ tag: im[0], text: t });
  }
  return out;
}
function _stripMemoryTags(text) {
  return String(text || "")
    .replace(/\[MEMORY\]([\s\S]*?)\[\/MEMORY\]/g, " ")
    .replace(/\[MEMORY:[^\]]*\]?/g, " ")
    .replace(/\s*\[MEMORY(?:\]|:)[^]*$/, " ");
}
function _streamDisplayText(raw) {
  let t = String(raw || "");
  t = _stripMemoryTags(t);
  t = t.replace(/\[GENERATE_IMAGE:[^\]]*\]?/g, "");
  t = t.replace(/\[IMAGE:\s*[^\]]+\]/g, "");
  t = t.replace(/\[IMAGE_SEARCH:\s*[^\]]+\]/g, "");
  t = _stripThinkingPreamble(t);
  const quizIdx = t.indexOf("<quiz>");
  if (quizIdx >= 0) {
    return { text: t.slice(0, quizIdx), quizStarted: true };
  }
  const tag = "<quiz";
  for (let i = tag.length; i >= 1; i--) {
    if (t.endsWith(tag.slice(0, i))) {
      t = t.slice(0, -i);
      break;
    }
  }
  return { text: t, quizStarted: false };
}
/* â”€â”€ Per-word streaming reveal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Wraps each whitespace-separated token in the streaming message
   text in a <span class="stream-word">. Words that are NEW since
   the last call (index >= previously-wrapped count, tracked on
   textEl.dataset.streamWords) get the `is-new` modifier, which
   triggers a blur-in animation DIRECTLY on insertion: the word
   starts hidden (opacity 0, blurred) and animates to sharp â€” no
   showâ†’hideâ†’animate flash. Words that were already shown are
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
    if (/^\s*\[[A-Z][A-Z\sâ€”-]*(STRICT|ABSOLUTE|NEVER VIOLATE|CRITICAL)[^\]]*\]\s*/i.test(t)) {
      t = t.replace(/^\s*\[[A-Z][A-Z\sâ€”-]*(?:STRICT|ABSOLUTE|NEVER VIOLATE|CRITICAL)[^\]]*\]\s*\n?/i, "");
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
// runs the onclick is gone â€” so clicking Copy / Run does nothing.
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
  body.innerHTML = `<iframe class="code-preview-frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe>`;
  const frame = body.querySelector("iframe");
  frame.srcdoc = srcdoc;
  panel.classList.add("open");
  showToast(`${_aiSvgPlay} Preview opened`);
}
function closeCodePreviewPanel() {
  const panel = $("codePreviewPanel");
  if (!panel || !panel.classList.contains("open")) return;
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
/* â”€â”€ Chat-switch animation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   When the user switches conversations (or returns to the welcome
   screen), we blur + slide the chat content down + fade it out, swap
   the inner content while invisible, then unblur + slide it back up.
   This makes conversation switches feel smooth instead of jarring.

   Guards:
   - If streaming is in progress, skip the animation (the user is
     mid-message and a fade would interrupt the stream).
   - If a switch is already in flight, the second call swaps immediately
     (no double-animation).
   - The animation duration is 180ms each way (out â†’ swap â†’ in), so the
     total perceived switch is ~360ms â€” fast enough to feel snappy.
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
    // A switch is already animating â€” store the latest swap and apply it
    // when the current animation reaches the swap point.  This prevents
    // the repeated blurâ†’unblurâ†’blurâ†’unblur cycle when rapidly clicking
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
    // one â€” otherwise each PPTX preview stacks a new observer with stale
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
/* â”€â”€ Reasoning panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   When reasoning mode is enabled, the worker streams Gemini's
   `thought: true` parts separately (see streamEmeraldBot). We render
   them inside a collapsible "Reasoning" block above the answer text â€”
   the same UX Claude / o1 use: a header row with a spinner while
   thinking, flipping to a checkmark + "Done" once the final answer
   begins streaming; the body expands during reasoning and auto-
   collapses when done (user can re-expand by clicking the header).

   The block is created lazily (only when the first reasoning chunk
   arrives) so messages without reasoning show no empty panel. */
const _REASONING_EXPAND_MS = 250; // smooth height transition
// Per-block interval timers for the "Thinking for Xsâ€¦" live label.
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
  // has completed reasoning â€” label says "Thought for a moment" since
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
  // Live-tick the "Thinking for Xsâ€¦" label once per second.
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
  // produces HTML â€” concatenating innerHTML would re-parse partial HTML
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

// â”€â”€ Searching panel (same design as Reasoning, separate UI block) â”€â”€â”€â”€â”€â”€
const _searchingTimers = new WeakMap();

function _setSearchingLabel(block, verb) {
  if (!block) return;
  const label = block.querySelector(".searching-label");
  if (!label) return;
  const start = Number(block.dataset.startedAt || 0);
  if (!start) {
    label.textContent = verb === "Searched" ? "Searched" : "Searching";
    return;
  }
  const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
  label.textContent = `${verb} for ${_fmtReasoningElapsed(sec)}`;
}

function searchingBlockHTML(isDone) {
  return `<div class="searching-block${isDone ? " is-done" : ""}" data-state="${isDone ? "done" : "searching"}">
    <div class="searching-header" role="button" tabindex="0" aria-expanded="${isDone ? "false" : "true"}" onclick="toggleSearchingBlock(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSearchingBlock(this);}">
      <div class="searching-title">
        <span class="searching-label">${isDone ? "Searched" : "Searching"}</span>
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
  _setSearchingLabel(block, "Searching");
  const timer = setInterval(() => {
    if (!block.classList.contains("is-done")) _setSearchingLabel(block, "Searching");
  }, 1000);
  _searchingTimers.set(block, timer);
  return block;
}

function appendSearchingToBlock(block, chunk) {
  if (!block || !chunk) return;
  const textEl = block.querySelector(".searching-text");
  if (!textEl) return;
  let acc = block.dataset.searchingRaw || "";
  acc += chunk;
  block.dataset.searchingRaw = acc;
  textEl.innerHTML = renderMarkdown(acc);
  const body = block.querySelector(".searching-body");
  if (body && _autoScrollSticky) body.scrollTop = body.scrollHeight;
}

function markSearchingDone(block) {
  if (!block) return;
  block.classList.add("is-done");
  block.dataset.state = "done";
  const timer = _searchingTimers.get(block);
  if (timer) { clearInterval(timer); _searchingTimers.delete(block); }
  _setSearchingLabel(block, "Searched");
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
// stale reference would leave the "Second bubble â€” just animation" stuck.
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
    if (_silent) showToast(`${_aiSvgWarn} Please wait â€” the AI is still responding.`);
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
              // atob returns a byte-string, not a UTF-8 string â€” non-ASCII
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
        showToast(`${_aiSvgWarn} Web search unavailable â€” proceeding without context.`);
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
    // indicator hides) and the reasoning panel â€” same UX Claude / o1 use
    // where the "Thinkingâ€¦" block appears before any answer text streams.
    _reasoningText += chunk;
    if (!_ensureStreamDom()) return;
    if (!_reasoningBlock) _reasoningBlock = createReasoningBlock(aiDiv);
    appendReasoningToBlock(_reasoningBlock, chunk);
    scrollToBottom();
  };
  const _doStream = async (h) => streamEmeraldBot(h, apiKey, (chunk) => {
    // First non-thought chunk means reasoning phase is over â†’ flip the
    // reasoning block to "Done" (auto-collapses shortly after).
    _markSearchingDoneOnce();
    _markReasoningDoneOnce();
    fullText += chunk;
    if (!_ensureStreamDom()) return;
    const _sd = _streamDisplayText(fullText);
    textEl.innerHTML = (_sd.text ? renderMarkdown(_sd.text) : "") + (_sd.quizStarted ? quizLoadingCardHTML() : '<span class="stream-cursor" aria-hidden="true"></span>');
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
      // conversation entirely â€” delete it from storage, return the user
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
  // Stream ended â€” flip the reasoning panel to "Done" (if one exists).
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
    const _imgGenMatch = displayText.match(/\[GENERATE_IMAGE:\s*([^\]]+)\]/);
    const _imgPrompt = _imgGenMatch ? _imgGenMatch[1].trim() : null;
    displayText = displayText.replace(/\[GENERATE_IMAGE:[^\]]*\]?/g, "").trim();
    const _quizResult = _extractQuiz(displayText);
    const quizData = _quizResult.quizData;
    const beforeQuizText = _quizResult.before;
    const afterQuizText = _quizResult.after;
    const _quizParseFailed = _quizResult.parseFailed;
    displayText = _quizResult.before;
    textEl.classList.remove("stream-reveal");
    const _textToShow = (quizData || _quizParseFailed) ? beforeQuizText : displayText;
    const _hasOtherContent = !!(quizData || _quizParseFailed || _imgPrompt || memoryAdded);
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
        imagePrompt: _imgPrompt || void 0,
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
      if (quizData) state.tempHistory.push({ role: "user", parts: [{ text: "[User started a quiz â€” no text message]" }] });
    }
    if (_imgPrompt) {
      processImageGenTag(aiDiv, _imgPrompt, state.convId, msgId);
    }
    // Always process [IMAGE_SEARCH:] tags regardless of [GENERATE_IMAGE:]
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
      text = text.replace(/<quiz>[\s\S]*?<\/quiz>/g, "[A quiz was provided here]");
      text = _stripMemoryTags(text).replace(/\[GENERATE_IMAGE:\s*[^\]]+\]/g, "").replace(/\[IMAGE:\s*[^\]]+\]/g, "").replace(/\[IMAGE_SEARCH:\s*[^\]]+\]/g, "").trim();
      if (m.imagePrompt) {
        text += `
[An image was generated and shown to the user for this prompt: "${m.imagePrompt}"]`;
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
                chosenPairs.push(`"${qq.left[li]} â†’ ${chRight == null || chRight === "" ? "skipped" : chRight}"`);
                correctPairs.push(`"${qq.left[li]} â†’ ${coRight || ""}"`);
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
              correctTxt = "(essay â€” no fixed answer)";
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
    // regenBranch.current is always a non-negative number index, never a
    // prototype name; the branch map itself is a null-prototype object.
    regenBranch.variants[regenBranch.current]._regenTail = regenTail;
  }
  const history = buildHistory(conv);
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
      showToast(`${_aiSvgWarn} Web search unavailable â€” proceeding without context.`);
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
      textEl.innerHTML = (_sd.text ? renderMarkdown(_sd.text) : "") + (_sd.quizStarted ? quizLoadingCardHTML() : '<span class="stream-cursor" aria-hidden="true"></span>');
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
    const imgGenMatch = displayText.match(/\[GENERATE_IMAGE:\s*([^\]]+)\]/);
    const imgPrompt = imgGenMatch ? imgGenMatch[1].trim() : null;
    displayText = displayText.replace(/\[GENERATE_IMAGE:[^\]]*\]?/g, "").trim();
    const _quizResult = _extractQuiz(displayText);
    const quizData = _quizResult.quizData;
    const beforeQuizText = _quizResult.before;
    const afterQuizText = _quizResult.after;
    const _quizParseFailed = _quizResult.parseFailed;
    displayText = _quizResult.before;
    textEl.classList.remove("stream-reveal");
    const _regenTextToShow = (quizData || _quizParseFailed) ? beforeQuizText : displayText;
    const _hasOtherContent = !!(quizData || _quizParseFailed || imgPrompt || memoryAdded);
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
      imagePrompt: imgPrompt || void 0,
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
    if (imgPrompt) {
      processImageGenTag(aiDiv, imgPrompt, state.convId, newId);
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
    const errText = await res.text().catch(() => "");
    let errMsg = "";
    try {
      const j = JSON.parse(errText);
      if (j?.error?.message) errMsg = j.error.message;
    } catch {
    }
    const e = new Error(errMsg);
    e._modelError = true;
    e._httpStatus = res.status;
    throw e;
  }
  // Jailbreak detection: when the worker flags a request as blocked
  // (X-Safety-Status: blocked), it sends an EMPTY SSE stream with no
  // refusal text. We must NOT stream anything to the user â€” instead we
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
  // 30s was too aggressive for low-bandwidth / congested connections â€” a
  // client stream regularily stalls mid-answer and got killed, which users
  // experience as "the AI randomly stops generating". 60s gives slow links
  // room to catch up, and the STREAM_INTERRUPTED recovery below resumes the
  // response whenever a connection is genuinely cut.
  const STREAM_IDLE_TIMEOUT = 6e4;
  let timedOut = false;
  let streamedChars = 0;
  let streamDone = false;
  // Resume only when streamed text is meaningful. A connection that drops or
  // idles out almost immediately (a few chars) will likely do so again â€” a
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
        // read() reject instead of resolving â€” break out so the recovery logic
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
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
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
      // idle timer, but the partial text we already have is valid â€” resume
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
    // is valid â€” flag it so the caller resumes with "continue" up to a few
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
        // Gemini didn't provide a real title â€” try to extract a readable one from the URL
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
            // No path segments â€” try hostname as fallback (stripped of www. and TLD)
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.attachments.push({ name: f.name, type: f.type, size: f.size, data: e.target.result });
      renderAttachmentPreviews();
      resolve();
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.onabort = () => reject(new Error("FileReader aborted"));
    reader.readAsDataURL(f);
  });
}
async function handleFileSelect(input) {
  await Promise.all(Array.from(input.files).map((f) => processFileForAttachment(f)));
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
  } catch { /* estimate() unsupported/throttled â€” fall back to app key sizes */ }
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
    ? `${_fmtBytes(usage)} of ${_fmtBytes(quota)} used Â· ${pct.toFixed(1)}%`
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
      } catch (_) { /* invalid data URL â€” leave image hidden */ }
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
    // Guarantee cleanup even if decoding threw â€” prevents object-URL leak.
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
  updateOwnedUrl();
  showWelcome();
  updateTopbarTitle("");
  renderSidebar();
}
/* â”€â”€ Smart auto-scroll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   _autoScrollSticky tracks whether the chat should auto-scroll to
   bottom during streaming.  It starts true.  If the user scrolls UP
   (away from bottom), it flips to false and scrollToBottom() becomes
   a no-op.  If the user scrolls back to the very bottom, it flips
   back to true and auto-scroll resumes.  This gives the user full
   control: scroll up to read earlier text without being forced down,
   scroll back to bottom to re-lock onto the latest output. */
let _autoScrollSticky = true;
/* Threshold in px â€” if the user is within this distance of the
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
    if (!_userScrolling) return;  // programmatic scroll â€” ignore
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
     (avoids visible micro-scrolls for 1â€“2 px differences). */
  const distance = cc.scrollHeight - cc.scrollTop - cc.clientHeight;
  if (distance <= 2) return;  // already there, no-op
  if (distance < 80) {
    cc.scrollTop = cc.scrollHeight;
  } else {
    cc.scrollTo({ top: cc.scrollHeight, behavior: 'smooth' });
  }
}
/* Force-scroll to bottom (ignores sticky flag).  Used when the user
   sends a new message â€” we always want to jump to bottom then. */
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

function selectModel(id) {
  const valid = id === "auto" || MODELS.some((m) => m.id === id);
  if (!valid) return;
  setSelectedModelId(id);
  closeModelDropdown();
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
  if (e.key === "Escape") closeModelDropdown();
});
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeHtmlAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// â”€â”€ URL sanitizers (CodeQL js/xss WriteUrlSink) â”€â”€
// Every value handed back to an <img src> / <a href> sink passes through
// _uriClean(), whose encodeURIComponent() call is a recognized XSS sanitizer
// node (CodeQL js/xss and js/xss-through-dom). decodeURIComponent() then
// restores the original bytes, so no URL is altered â€” but no storage- or
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
//   - _httpStatus / _serverBlocked -> the server refused or blocked the request
//   - anything else                -> generic "An error occurred while <x>."
// Backend detail stays in the developer console, not the UI -- except when the
// server itself provides a user-friendly explanation (err.message), which IS
// surfaced so blocks / rate limits tell the user what actually happened.
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
  if (err?._httpStatus || err?._serverBlocked) {
    const known = (err?.message || "").trim();
    if (known) return known;
    const status = err?._httpStatus;
    if (status === 401 || status === 403) return `The server blocked this request.`;
    if (status === 429) return "Too many requests right now \u2014 please wait a moment and try again.";
    if (status >= 500) return "The server is having trouble right now \u2014 please try again in a moment.";
    return status ? `The server blocked this request (HTTP ${status}).` : "The server blocked this request.";
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
    // Guarantee cleanup even if decoding threw â€” prevents object-URL leak.
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
  // `countEl` was referenced but never declared â€” would throw ReferenceError
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
      let joined = parts.map((p, i) => (p ? _mdInline(renderMarkdown(p)) : "") + (i < parts.length - 1 ? inlineInput : "")).join("");
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
};
window._quizMatchOpen = function(qid, qi, li, evt) {
  evt && evt.stopPropagation();
  const wrapper = document.getElementById(`${qid}_q${qi}_dd${li}`);
  if (!wrapper || wrapper.classList.contains("locked")) return;
  const wasOpen = wrapper.classList.contains("open");
  document.querySelectorAll(".quiz-match-dd.open").forEach((w) => w.classList.remove("open"));
  if (!wasOpen) wrapper.classList.add("open");
};
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
  _quizUpdateProgress(qid);
};
document.addEventListener("click", (e) => {
  document.querySelectorAll(".quiz-match-dd.open").forEach((w) => {
    if (!w.contains(e.target)) w.classList.remove("open");
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".quiz-match-dd.open").forEach((w) => w.classList.remove("open"));
});
window._quizFillInput = function(qid, qi, value) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  if (value.trim()) qz.answers[qi] = value;
  else delete qz.answers[qi];
  _quizUpdateProgress(qid);
};
window._quizEssayInput = function(qid, qi, value) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  if (value.trim()) qz.answers[qi] = value;
  else delete qz.answers[qi];
  _quizUpdateProgress(qid);
};
window._quizSubmit = function(qid) {
  const qz = (window._quizzes || {})[qid];
  if (!qz || qz.submitted) return;
  qz.submitted = true;
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
};
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
  prompt += "\n\n[IMPORTANT: Only provide explanations and essay feedback for the above. Do NOT generate a new quiz. Do NOT generate an image. No <quiz> tags. No [GENERATE_IMAGE:...] tags. Just a plain helpful response.]";
  // Send silently â€” no user message bubble, no input box text.
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
  state.convId = null;
  state.isTemp = false;
  state.tempHistory = [];
  state.attachments = [];
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
/* â”€â”€ Render cached image search results (from IndexedDB) without re-fetching â”€â”€ */
function _renderCachedImageSearchResults(aiDiv, cacheMap) {
  if (!cacheMap || typeof cacheMap !== 'object') return;
  // For each [IMAGE_SEARCH:] placeholder, look up its cached result by query
  const placeholders = aiDiv.querySelectorAll(".web-image-searching");
  placeholders.forEach(el => {
    const query = el.dataset.imgSearch;
    if (query && cacheMap[query]) {
      const { url, alt } = cacheMap[query];
      el.classList.remove("web-image-searching");
      el.classList.add("web-image-loaded");
      el.dataset.webImg = "1";
      el.innerHTML = '<img class="web-image" src="' + escapeHtmlAttr(url) + '" alt="' + escapeHtmlAttr(alt || "Image") + '" loading="lazy">';
    }
  });
}
function appendStoredAIMessage(m) {
  const rawText = m.text || "";
  let displayText = _stripMemoryTags(rawText).replace(/\[GENERATE_IMAGE:\s*[^\]]+\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
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
  const _initText = (quizData || quizParseFailed) ? beforeQuiz : displayText;
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
  // Re-render persisted reasoning (collapsed by default â€” the model has
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
    // CodeQL fix (#52/#56): sanitize qid to safe chars only â€” prevents
    // injection via quizData._id or m.id which are user-influenced.
    const _rawQid = quizData._id || "quiz_" + (m.id || genId());
    const qid = _rawQid.replace(/[^a-zA-Z0-9_-]/g, "_");
    quizData._id = qid;
    window._quizzes = window._quizzes || {};
    if (!window._quizzes[qid]) {
      window._quizzes[qid] = { data: quizData, answers: {}, submitted: false };
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
  div.querySelector(".message-body").appendChild(buildMessageActionsEl(m.id || genId()));
  const _imgDataSafe = m.imageData ? _safeMediaSrc(m.imageData, "image") : '';
  if (m.imageData && _imgDataSafe) {
    const wrapper = document.createElement("div");
    wrapper.className = "img-gen-result";
    const img = document.createElement("img");
    img.src = _imgDataSafe;
    img.alt = m.imagePrompt ? escapeHtmlAttr(m.imagePrompt.slice(0, 80)) : "";
    img.className = "img-gen-image";
    const dlLink = document.createElement("a");
    dlLink.className = "img-gen-download";
    dlLink.href = _imgDataSafe;
    dlLink.download = "emeraldbot-image.png";
    dlLink.title = "Download image";
    dlLink.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    wrapper.appendChild(img);
    wrapper.appendChild(dlLink);
    insertBeforeMessageActions(div.querySelector(".message-body"), wrapper);
  }
  const typingEl = $("typingIndicator");
  $("messagesArea").insertBefore(div, typingEl);
  // â”€â”€ Render image search results: use cached results if available (stable on reload) â”€â”€
  if (m.imageSearchCache && Object.keys(m.imageSearchCache).length) {
    _renderCachedImageSearchResults(div, m.imageSearchCache);
  } else {
    // First time or no cached results â†’ fetch from API and cache
    processImageSearchTags(div, state.convId, m.id);
  }
  // â”€â”€ Restore citations from persisted sources â”€â”€
  if (m.sources && Array.isArray(m.sources) && m.sources.length) {
    renderCitations(div, m.sources);
  }
  return div;
}
function _extractQuiz(text) {
  const quizMatch = text.match(/<quiz>([\s\S]+?)<\/quiz>/) || text.match(/<quiz>([\s\S]+)$/);
  if (!quizMatch) return { before: text, after: "", quizData: null, parseFailed: false };
  const qStart = text.indexOf("<quiz>");
  const before = text.slice(0, qStart).trim();
  const after = text.slice(qStart + quizMatch[0].length).trim();
  let quizData = null;
  let parseFailed = false;
  let raw = quizMatch[1];

  // â”€â”€ Pre-extraction cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Strip markdown code fences the AI might wrap around the JSON
  raw = raw.replace(/^[\s\n]*```(?:json|JSON)?[\s\n]*\n?/i, "");
  raw = raw.replace(/\n?[\s\n]*```[\s\n]*$/i, "");
  // Strip HTML entities the AI might emit (e.g. &quot; â†’ ")
  // CodeQL fix (#53): Decode HTML entities the AI might emit (e.g. &quot; â†’ ")
  // CRITICAL: &amp; MUST be decoded LAST to prevent double-decode (e.g. &amp;lt; â†’ <).
  // Original code decoded &amp; before &lt; causing double-escaping vulnerability.
  raw = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  // Strip JS/JSON comments (// and /* */)
  raw = raw.replace(/\/\/[^\n]*/g, "");
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip leading/trailing commentary the AI might add around the JSON
  // Find the first { and last } â€” everything between is the JSON candidate
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  // â”€â”€ Parse attempt 1: as-is â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  try {
    quizData = JSON.parse(raw);
  } catch (e1) {
    // â”€â”€ Parse attempt 2: fix common AI mistakes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    try {
      let fixed = raw
        .replace(/,\s*([}\]])/g, "$1")                // trailing commas before } or ]
        .replace(/'/g, '"')                             // single â†’ double quotes
        .replace(/(?<=[{,])\s*(\w+)\s*:/g, '"$1":')   // unquoted keys after { or , â†’ quoted
        .replace(/:\s*undefined/g, ':null')            // undefined â†’ null
        .replace(/:\s*NaN/g, ':0')                     // NaN â†’ 0
        .replace(/\\(?!["\\/bfnrtu])/g, '\\\\');      // escape stray backslashes
      quizData = JSON.parse(fixed);
    } catch (e2) {
      // â”€â”€ Parse attempt 3: aggressive â€” walk the string character by
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

  // â”€â”€ Normalize: ensure questions array exists and each question has expected shape â”€â”€
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
      } else if (norm.type === "fill" || norm.type === "essay") {
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

// Event delegation: .quiz-card[data-qid] clicks â†’ openQuizPanel
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
  body.innerHTML = renderQuizWidget(qid, qz.data);
  const widgetHeader = body.querySelector(".quiz-header");
  if (widgetHeader) widgetHeader.style.display = "none";
  panel.classList.add("open");
}
function closeQuizPanel() {
  const p = $("quizPanel");
  if (!p || !p.classList.contains("open")) return;
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
  // this, the AI never receives the attachments on resubmit â€” `buildHistory`
  // only emits text parts, so the file content was being silently dropped.
  if (originalFiles.length && history.length) {
    const last = history[history.length - 1];
    if (last && last.parts && last.parts.length) {
      const fileParts = buildFileParts(originalFiles);
      if (fileParts.length) last.parts.push(...fileParts);
    }
  }
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
      showToast(`${_aiSvgWarn} Web search unavailable â€” proceeding without context.`);
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
      aiTextEl.innerHTML = (_sd.text ? renderMarkdown(_sd.text) : "") + (_sd.quizStarted ? quizLoadingCardHTML() : '<span class="stream-cursor" aria-hidden="true"></span>');
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
    const imgM = dispText.match(/\[GENERATE_IMAGE:\s*([^\]]+)\]/);
    const imgPrompt = imgM ? imgM[1].trim() : null;
    dispText = dispText.replace(/\[GENERATE_IMAGE:[^\]]*\]?/g, "").trim();
    const _quizResult = _extractQuiz(dispText);
    const quizData = _quizResult.quizData;
    const beforeQuizText = _quizResult.before;
    const afterQuizText = _quizResult.after;
    const _quizParseFailed = _quizResult.parseFailed;
    dispText = _quizResult.before;
    aiTextEl.classList.remove("stream-reveal");
    const _editTextToShow = (quizData || _quizParseFailed) ? beforeQuizText : dispText;
    const _hasOtherContent = !!(quizData || _quizParseFailed || imgPrompt || memoryAdded);
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
    const _groundingSources = extractGroundingSources(_groundingMetadata);
    const _allSources = [..._groundingSources, ..._webSources];
    renderCitations(aiDiv, _allSources);
    if (_allSources.length) _stripSourcesFromHTML(textEl);
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
        imagePrompt: imgPrompt || void 0,
        reasoning: _reasoningText || void 0,
        sources: _allSources.length ? _allSources.map(s => ({ title: s.title || '', uri: s.uri })) : void 0
      });
      conv.updatedAt = Date.now();
      upsertConv(conv);
      updateBranchNavDOM(branchRootId);
    } else {
      state.tempHistory.push({ role: "model", parts: [{ text: aiFullText }] });
    }
    if (imgPrompt) {
      processImageGenTag(aiDiv, imgPrompt, state.convId, aiMsgId);
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
  if (branchInfo.variants[branchInfo.current]) {
    // branchInfo.current is a numeric index into the variants array; it can
    // never be a prototype name, and the branch map is null-prototype.
    branchInfo.variants[branchInfo.current].text = conv.messages[startIdx].text;
    branchInfo.variants[branchInfo.current].tail = conv.messages.slice(startIdx + 1).map((m) => ({ ...m }));
    branchInfo.variants[branchInfo.current].files = (conv.messages[startIdx].files || []).map((f) => ({ ...f }));
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
    const txt = strongs[i].textContent.trim().replace(/[\s:ï¼š]/g, "").toLowerCase();
    if (txt === "sources" || txt === "source" || txt === "references" || txt === "reference") {
      // Found a "Sources" header â€” remove it and everything after it
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
      const prevTxt = prev.textContent.trim().replace(/[\s:ï¼š]/g, "").toLowerCase();
      if (prevTxt === "sources" || prevTxt === "references") {
        prev.remove();
        lists[i].remove();
        return;
      }
    }
  }
}

function renderCitations(aiDiv, sources) {
  // Always process [N] patterns â€” even without sources, convert them to
  // orphan badges so they're not left as raw "[1]" plain text.
  if (!sources) sources = [];
  const body = aiDiv?.querySelector(".message-body");
  if (!body) return;

  // â”€â”€ Step 1: Convert inline [1], [2], [1][2] citations to clickable superscript badges â”€â”€
  const mdContent = body.querySelector(".md-content") || body;
  if (mdContent) {
    // Walk text nodes to replace [N] patterns without breaking HTML
    // Skip text nodes inside <code> and <pre> elements â€” those should stay as-is
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
      // Match [N], [N,M], [N-M] where N is 1-99 â€” also handle clustered like [1][2]
      // First pass: expand compound citations like [1,2] â†’ [1][2] and [1-3] â†’ [1][2][3]
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
          return `\x01CITE${idx}\x01`;  // Has source â†’ clickable link
        }
        return `\x01ORPHAN${numStr}\x01`;  // No source â†’ styled badge (not clickable)
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
              // Has source â†’ clickable link
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
              // No source â†’ styled badge (not clickable)
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

  // â”€â”€ Step 2: Build source chips at the bottom â”€â”€
  const wrap = document.createElement("div");
  wrap.className = "esb-citations";
  const seen = /* @__PURE__ */ new Set();
  sources.forEach((s) => {
    if (!s?.uri || seen.has(s.uri)) return;
    seen.add(s.uri);
    const a = document.createElement("a");
    a.className = "esb-citation-chip";
    a.href = _safeHref(s.uri);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    let host = "";
    try {
      host = new URL(s.uri).hostname.replace(/^www\./, "");
    } catch {}
    // Build chip text: "domain" or "domain â€º Title"
    let displayTitle = s.title || "";
    if (displayTitle && displayTitle.includes("://")) {
      // Title is actually a URL â€” strip it
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
      chipText = host + " â€º " + displayTitle;
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
async function processImageGenTag(aiDiv, prompt, convId, msgId) {
  const body = aiDiv?.querySelector(".message-body");
  if (!body) return;
  const loadEl = document.createElement("div");
  loadEl.className = "img-gen-loading";
  loadEl.innerHTML = `
    <div class="img-gen-loading-inner">
      <span class="img-gen-spinner"></span>
      <div class="img-gen-loading-text">
        <span class="img-gen-loading-title">Generating image</span>
        <span class="img-gen-loading-sub">This may take a few seconds\u2026</span>
      </div>
    </div>`;
  insertBeforeMessageActions(body, loadEl);
  scrollToBottom();
  try {
    const reqBody = {
      prompt,
      aspect_ratio: detectAspectRatio(prompt),
      output_format: "png"
    };
    const res = await fetch(IMAGE_WORKER_URL + "/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(reqBody)
    });
    loadEl.remove();
    if (!res.ok) {
      const _imgErr = new Error("");
      _imgErr._httpStatus = res.status;
      try {
        const _t = await res.text();
        const _j = JSON.parse(_t);
        if (_j?.error?.message) _imgErr.message = _j.error.message;
      } catch {
      }
      const _errMsg = aiChatErrorText(_imgErr, "generating the image");
      const textEl = body?.querySelector(".message-text");
      if (textEl) {
        textEl.classList.remove("message-text--empty");
        const _existing = (textEl.innerHTML || "").trim();
        textEl.innerHTML = _existing ? `${_existing}<br><span class="md-error">${escapeHtml(_errMsg)}</span>` : `<span class="md-error">${escapeHtml(_errMsg)}</span>`;
      }
      scrollToBottom();
      return;
    }
    const imageModelId = res.headers.get("X-Model-Used") || "";
    const imageModelName = imageModelId ? imageModelId.split("/").pop() : "";
    if (imageModelId) {
      aiDiv.dataset.imageModelId = imageModelId;
      aiDiv.dataset.imageModelName = imageModelName;
    }
    const blob = await res.blob();
    const dataUrl = await blobToDataURL(blob);
    const ct = blob.type || "";
    const ext = ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : ct.includes("png") ? "png" : "png";
    const wrapper = document.createElement("div");
    wrapper.className = "img-gen-result";
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = escapeHtmlAttr(prompt.slice(0, 80));
    img.className = "img-gen-image";
    const dlLink = document.createElement("a");
    dlLink.className = "img-gen-download";
    dlLink.href = dataUrl;
    dlLink.download = "emeraldbot-image." + ext;
    dlLink.title = "Download image";
    dlLink.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    wrapper.appendChild(img);
    wrapper.appendChild(dlLink);
    insertBeforeMessageActions(body, wrapper);
    if (convId && msgId) {
      const convArr = loadConvs();
      const convObj = convArr.find((c) => c.id === convId);
      if (convObj) {
        const savedMsg = convObj.messages.find((m) => m.id === msgId);
        if (savedMsg) {
          savedMsg.imageData = dataUrl;
          savedMsg.imagePrompt = prompt;
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
    const textEl = body?.querySelector(".message-text");
    if (textEl) {
      textEl.classList.remove("message-text--empty");
      const _existing = (textEl.innerHTML || "").trim();
      const _catchMsg = escapeHtml(aiChatErrorText(e, "generating the image"));
      textEl.innerHTML = _existing ? `${_existing}<br><span class="md-error">${_catchMsg}</span>` : `<span class="md-error">${_catchMsg}</span>`;
    }
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


/* â”€â”€ Image Search: Fetch real images from the image search API â”€â”€ */
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

  // Mark failed â€” each stays in place with error state (visible placeholder)
  for (const el of bad) {
    el.classList.remove("web-image-searching");
    el.classList.add("web-image-failed");
  }
  if (!good.length) return;

  // â”€â”€ Place each image inline at its own placeholder position â”€â”€
  // No gallery grouping â€” each [IMAGE_SEARCH:] tag gets its own image right where it appears
  for (const { el, img, query } of good) {
    el.classList.remove("web-image-searching");
    el.classList.add("web-image-loaded");
    el.dataset.webImg = "1";
    el.innerHTML = '<img class="web-image" src="' + escapeHtmlAttr(img.url) + '" alt="' + escapeHtmlAttr(img.alt || query) + '" loading="lazy">';
  }
  scrollToBottom();

  // â”€â”€ Persist image search results to IndexedDB so they survive reload â”€â”€
  // Store results indexed by query so each can be matched back to its placeholder on reload
  if (convId && msgId) {
    try {
      const convArr = loadConvs();
      const convObj = convArr.find((c) => c.id === convId);
      if (convObj) {
        const savedMsg = convObj.messages.find((m) => m.id === msgId);
        if (savedMsg) {
          // Build a map: query â†’ {url, alt} so each placeholder can find its cached result
          const cacheMap = {};
          for (const { img, query } of good) {
            cacheMap[query] = { url: img.url, alt: img.alt || query };
          }
          // Merge with any existing cached results (preserve results from other placeholders)
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
/* â”€â”€ Web Image Preview (right-side panel) + load/error delegation â”€â”€ */
function _openImagePreviewPanel(src, name) {
  if (typeof closeCodePreviewPanel === "function") closeCodePreviewPanel();
  if (typeof closeQuizPanel === "function") closeQuizPanel();
  const panel = document.getElementById("filePreviewPanel");
  const body = document.getElementById("fpPanelBody");
  const title = document.getElementById("fpPanelTitle");
  if (!panel || !body) { window.open(src, "_blank"); return; }
  if (title) title.textContent = name || "Image Preview";
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
  if (typeof closeQuizPanel !== "undefined" && typeof window.closeQuizPanel === "undefined") window.closeQuizPanel = closeQuizPanel;
  if (typeof codeBlockMeta !== "undefined" && typeof window.codeBlockMeta === "undefined") window.codeBlockMeta = codeBlockMeta;
  if (typeof confirmClearAllChats !== "undefined" && typeof window.confirmClearAllChats === "undefined") window.confirmClearAllChats = confirmClearAllChats;
  if (typeof copyCode !== "undefined" && typeof window.copyCode === "undefined") window.copyCode = copyCode;
  if (typeof copyMsgText !== "undefined" && typeof window.copyMsgText === "undefined") window.copyMsgText = copyMsgText;
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
  if (typeof init !== "undefined" && typeof window.init === "undefined") window.init = init;
  if (typeof initTheme !== "undefined" && typeof window.initTheme === "undefined") window.initTheme = initTheme;
  if (typeof insertBeforeMessageActions !== "undefined" && typeof window.insertBeforeMessageActions === "undefined") window.insertBeforeMessageActions = insertBeforeMessageActions;
  if (typeof isLatestAIMessage !== "undefined" && typeof window.isLatestAIMessage === "undefined") window.isLatestAIMessage = isLatestAIMessage;
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
  if (typeof openQuizPanel !== "undefined" && typeof window.openQuizPanel === "undefined") window.openQuizPanel = openQuizPanel;
  if (typeof openSearch !== "undefined" && typeof window.openSearch === "undefined") window.openSearch = openSearch;
  if (typeof openSettings !== "undefined" && typeof window.openSettings === "undefined") window.openSettings = openSettings;
  if (typeof performAdvancedSearch !== "undefined" && typeof window.performAdvancedSearch === "undefined") window.performAdvancedSearch = performAdvancedSearch;
  if (typeof positionMenu !== "undefined" && typeof window.positionMenu === "undefined") window.positionMenu = positionMenu;
  if (typeof processFileForAttachment !== "undefined" && typeof window.processFileForAttachment === "undefined") window.processFileForAttachment = processFileForAttachment;
  if (typeof processImageGenTag !== "undefined" && typeof window.processImageGenTag === "undefined") window.processImageGenTag = processImageGenTag;
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
  if (typeof showChatBranchLimitToast !== "undefined" && typeof window.showChatBranchLimitToast === "undefined") window.showChatBranchLimitToast = showChatBranchLimitToast;
  if (typeof showMessages !== "undefined" && typeof window.showMessages === "undefined") window.showMessages = showMessages;
  if (typeof showToast !== "undefined" && typeof window.showToast === "undefined") window.showToast = showToast;
  if (typeof showUsedModel !== "undefined" && typeof window.showUsedModel === "undefined") window.showUsedModel = showUsedModel;
  if (typeof showWelcome !== "undefined" && typeof window.showWelcome === "undefined") window.showWelcome = showWelcome;
  if (typeof stopStreaming !== "undefined" && typeof window.stopStreaming === "undefined") window.stopStreaming = stopStreaming;
  if (typeof streamEmeraldBot !== "undefined" && typeof window.streamEmeraldBot === "undefined") window.streamEmeraldBot = streamEmeraldBot;
  if (typeof submitUserMsgEdit !== "undefined" && typeof window.submitUserMsgEdit === "undefined") window.submitUserMsgEdit = submitUserMsgEdit;
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