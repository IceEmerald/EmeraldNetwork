const contextMenu = document.getElementById("custom-context-menu");
let clickedElement = null;
let selectedText = "";

window.addEventListener("contextmenu", function (e) {
  e.preventDefault();
  clickedElement = e.target;
  const sel = window.getSelection();
  selectedText = sel ? sel.toString().trim() : "";
  contextMenu.style.top = "-9999px";
  contextMenu.style.left = "-9999px";
  contextMenu.style.display = "block";
  const menuWidth = contextMenu.offsetWidth || 260;
  const menuHeight = contextMenu.offsetHeight || 160;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let left = e.clientX;
  let top = e.clientY;
  if (left + menuWidth > viewportWidth) left = viewportWidth - menuWidth - 8;
  if (left < 8) left = 8;
  if (top + menuHeight > viewportHeight) top = viewportHeight - menuHeight - 8;
  if (top < 8) top = 8;
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
});

window.addEventListener("click", () => {
  contextMenu.style.display = "none";
});

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(message) {
  const toast = document.getElementById("custom-toast");
  let html = String(message);
  if (!/^\\s*<svg\\b/i.test(html)) {
    html = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.85"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>' + html;
  }
  toast.innerHTML = html;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 5000);
}

const _svgTag = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
const _svgId = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
const _svgClass = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`;
const _svgText = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>`;
const _svgLink = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const _svgImg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
const _svgTitle = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>`;
const _svgEdit = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const _svgFile = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
const _svgName = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`;
const _svgFor = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
const _svgLabel = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
const _svgInfo = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;
const _svgRole = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>`;
const _svgData = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
const _svgSize = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M21 3H3v18h18V3zM12 3v4m0 14v-4M3 12h4m14 0h-4m-8-4l2 2m4 4l2 2m-8 0l2-2m4-4l2-2"/></svg>`;
const _svgChild = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;
const _svgStyle = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`;
const _svgCopy = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const _svgWarn = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const _svgPage = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

function copyPageLink() {
  navigator.clipboard.writeText(location.href);
  showToast(`${_svgPage} Page link copied!`);
}

function truncate(str, maxLength = 100) {
  return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
}

function copyTextContent() {
  if (selectedText) {
    navigator.clipboard.writeText(selectedText);
    const preview = escHtml(truncate(selectedText.trim(), 100));
    showToast(`${_svgCopy} Copied: "${preview}"`);
  } else {
    showToast(`${_svgWarn} No text selected.`);
  }
}

function showElementInfo() {
  if (!clickedElement) {
    showToast(`${_svgWarn} No element selected.`);
    return;
  }
  const tag = escHtml(clickedElement.tagName);
  const id = clickedElement.id ? `#${escHtml(truncate(clickedElement.id, 100))}` : null;
  const classList = clickedElement.className
    ? clickedElement.className
        .split(" ")
        .filter(cls => cls)
        .map(cls => `.${escHtml(truncate(cls, 100))}`)
        .join(" ")
    : null;
  const rawText = clickedElement.textContent || "";
  const cleanText = rawText.trim().replace(/\s+/g, " ");
  const text = cleanText ? `"${escHtml(truncate(cleanText, 100))}"` : null;
  const attr = (name) => escHtml(truncate(clickedElement.getAttribute(name) || "", 100));
  const attributes = {
    href: attr("href"),
    src: attr("src"),
    alt: attr("alt"),
    title: attr("title"),
    placeholder: attr("placeholder"),
    value: attr("value"),
    role: attr("role"),
    name: attr("name"),
    for: attr("for"),
    label: clickedElement.labels
      ? escHtml(truncate(Array.from(clickedElement.labels).map(label => label.textContent.trim()).join(", "), 100))
      : null,
    ariaLabel: attr("aria-label")
  };
  const dataset = Object.entries(clickedElement.dataset || {})
    .map(([k, v]) => `data-${escHtml(k)}="${escHtml(truncate(v, 100))}"`)
    .join(", ");
  const truncatedDataset = dataset ? escHtml(truncate(dataset, 100)) : null;
  const rect = clickedElement.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const size = (width && height) ? `${width}×${height}px` : null;
  const childIndex = Array.from(clickedElement.parentNode?.children || []).indexOf(clickedElement);
  const inlineStyle = escHtml(truncate(clickedElement.getAttribute("style") || "", 100));
  const infoLines = [
    `${_svgTag} <strong>Tag:</strong> ${tag}`,
    id ? `${_svgId} <strong>ID:</strong> ${id}` : null,
    classList ? `${_svgClass} <strong>Class:</strong> ${classList}` : null,
    text ? `${_svgText} <strong>Text:</strong> ${text}` : null,
    attributes.href ? `${_svgLink} <strong>Href:</strong> ${attributes.href}` : null,
    attributes.src ? `${_svgImg} <strong>Src:</strong> ${attributes.src}` : null,
    attributes.alt ? `${_svgImg} <strong>Alt:</strong> ${attributes.alt}` : null,
    attributes.title ? `${_svgTitle} <strong>Title:</strong> ${attributes.title}` : null,
    attributes.placeholder ? `${_svgEdit} <strong>Placeholder:</strong> ${attributes.placeholder}` : null,
    attributes.value ? `${_svgFile} <strong>Value:</strong> ${attributes.value}` : null,
    attributes.name ? `${_svgName} <strong>Name:</strong> ${attributes.name}` : null,
    attributes.for ? `${_svgFor} <strong>For:</strong> ${attributes.for}` : null,
    attributes.label ? `${_svgLabel} <strong>Labels:</strong> ${attributes.label}` : null,
    attributes.ariaLabel ? `${_svgInfo} <strong>ARIA Label:</strong> ${attributes.ariaLabel}` : null,
    attributes.role ? `${_svgRole} <strong>Role:</strong> ${attributes.role}` : null,
    truncatedDataset ? `${_svgData} <strong>Data Attributes:</strong> ${truncatedDataset}` : null,
    size ? `${_svgSize} <strong>Size:</strong> ${size}` : null,
    `${_svgChild} <strong>Child Index:</strong> ${childIndex}`,
    inlineStyle ? `${_svgStyle} <strong>Inline Style:</strong> ${inlineStyle}` : null
  ].filter(Boolean);
  showToast(infoLines.join("<br>"));
}