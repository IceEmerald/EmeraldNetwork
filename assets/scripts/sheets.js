/* ============================================================================
 * EmeraldSheets — a complete client-side spreadsheet application.
 * Pure HTML/CSS/JS. No server, no framework. Persistence via IndexedDB.
 *
 * Internal architecture (all inside one IIFE):
 *   1. Utilities & icon library
 *   2. IndexedDB persistence layer
 *   3. Number / date formatting engine
 *   4. Formula engine: lexer, parser, AST serializer, reference transforms
 *   5. Function library (60+ functions)
 *   6. Evaluator, dependency graph, recalculation scheduler
 *   7. Data model (workbook / sheets / cells / styles), history (undo/redo)
 *   8. Virtualized canvas grid renderer + geometry + custom scrollbars
 *   9. Interactions: selection, keyboard, in-cell editing, fill handle, drag-move
 *  10. Clipboard (internal + system TSV), format painter
 *  11. Structure operations (insert/delete rows, cols, sheets, merge, hide)
 *  12. Sorting, filtering, conditional formatting, data validation
 *  13. Floating charts
 *  14. Import / export (CSV, XLSX) and print
 *  15. Chrome UI: header, menus, ribbon, dialogs, context menus, toasts
 *  16. Find & replace, status bar, name box, formula bar, sheet tabs
 *  17. Boot
 * ========================================================================== */
window.addEventListener('error', e => { (window.__errs = window.__errs || []).push('E: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno); });
window.addEventListener('unhandledrejection', e => { (window.__errs = window.__errs || []).push('R: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });
(() => {
'use strict';

/* ==========================================================================
 * 1. UTILITIES
 * ========================================================================== */
const MAX_ROWS = 1000000;
const MAX_COLS = 1000000;
/* autogrow: a new sheet materializes 100 rows × 100 cols so scrollbars stay usable,
   then extends by GRID_STEP each time the user scrolls/moves/writes toward an edge */
const GRID_INIT = 100;
const GRID_STEP = 100;
const DEF = { rowH: 22, colW: 88, headerH: 22, fontPt: 11, fontFamily: 'Calibri' };
const GRID_COLOR = '#dfe1e5';
const SEL_COLOR = '#239a4d';
const HDR_BORDER = '#cfd2d6';
const HDR_TXT = '#5f6368';
const SERIES_COLORS = ['#217346', '#b75d0b', '#8b5e83', '#0f7c85', '#a4262c', '#5c5cb8', '#7a7564', '#c239b3', '#4f6bed', '#986f0b'];

const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const uid = () => 'id' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const key = (r, c) => r + ',' + c;
const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const $ = sel => document.querySelector(sel);
const nowTs = () => Date.now();
const deepClone = obj => (typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj)));
const isPlainObj = v => v && typeof v === 'object' && !Array.isArray(v);
const normText = s => String(s == null ? '' : s).toLowerCase();

function colName(c) { // 0-based -> A, B, ... Z, AA ...
  let s = ''; c = c + 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - m - 1) / 26; }
  return s;
}
function colIndex(name) { // A -> 0
  let n = 0; const up = name.toUpperCase();
  for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
  return n - 1;
}
const addr = (r, c) => colName(c) + (r + 1);
const addrAbs = (r, c) => '$' + colName(c) + '$' + (r + 1);
function parseAddr(text) { // "B10" or "$B$10" -> {r, c} | null
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*$/.exec(text);
  if (!m) return null;
  const c = colIndex(m[1]), r = parseInt(m[2], 10) - 1;
  if (r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) return null;
  return { r, c };
}
function normRange(r1, c1, r2, c2) {
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
}
function debounce(fn, ms) { let t = 0; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; }
function rafThrottle(fn) {
  let q = false, args = null;
  return (...a) => { args = a; if (!q) { q = true; requestAnimationFrame(() => { q = false; fn(...args); }); } };
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function fmtTime(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function cmpNum(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/* Tiny SVG icon set (stroke-based, 24x24). Rendered inline so the app never
 * depends on network icon availability. */
const ICONS = {
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  brush: '<rect x="3" y="3" width="14" height="6" rx="1.5"/><path d="M17 6h2.5a1.5 1.5 0 0 1 1.5 1.5V12a2 2 0 0 1-2 2h-5v3"/><rect x="11.5" y="17" width="5" height="5" rx="1"/>',
  bold: '<path d="M7 4h7a3.5 3.5 0 0 1 0 7H7zM7 11h8a4 4 0 0 1 0 8H7z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 21h16"/>',
  underline2: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 18h16M4 21.5h16"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.8 4M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
  alignLeft: '<path d="M4 6h13M4 12h9M4 18h13"/>',
  alignCenter: '<path d="M4 6h16M7 12h10M4 18h16"/>',
  alignRight: '<path d="M7 6h13M11 12h9M7 18h13"/>',
  alignTop: '<path d="M4 4h16M12 20V9M8.5 12.5 12 9l3.5 3.5"/>',
  alignMiddle: '<path d="M4 12h16M12 4v5M12 19v-5M9.5 7 12 4.5 14.5 7M9.5 17l2.5 2.5L14.5 17"/>',
  alignBottom: '<path d="M4 20h16M12 4v11M8.5 11.5 12 15l3.5-3.5"/>',
  indentInc: '<path d="M4 6h16M10 12h10M10 18h10M4 10l4 2-4 2z"/>',
  indentDec: '<path d="M4 6h16M10 12h10M10 18h10M8 10 4 12l4 2z"/>',
  wrap: '<path d="M4 6h16M4 12h12a3 3 0 0 1 0 6h-4M10 15l-3 3 3 3"/>',
  merge: '<rect x="3" y="6" width="6" height="12" rx="1"/><rect x="15" y="6" width="6" height="12" rx="1"/><path d="M10.5 12h3M12 10.5 13.5 12 12 13.5"/>',
  unmerge: '<rect x="3" y="6" width="8" height="12" rx="1"/><rect x="13" y="6" width="8" height="12" rx="1"/>',
  currency: '<path d="M12 3v18M16.5 7.2C15.6 6 14 5.4 12 5.4c-2.4 0-4.2 1.1-4.2 2.8 0 3.6 8.4 1.7 8.4 5.3 0 1.8-1.8 2.9-4.2 2.9-2 0-3.6-.7-4.5-1.9"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.8" cy="6.8" r="2.3"/><circle cx="17.2" cy="17.2" r="2.3"/>',
  comma: '<ellipse cx="6.4" cy="11.6" rx="2.5" ry="3.9"/><ellipse cx="13.2" cy="11.6" rx="2.5" ry="3.9"/><path d="M19.8 13.2c-.2 2.3-1.3 3.9-3.2 4.9"/>',
  decInc: '<circle cx="4.4" cy="16.4" r="1.1" fill="currentColor" stroke="none"/><ellipse cx="9.3" cy="12" rx="2.4" ry="3.8"/><path d="M14.5 12h6.5m-2.6-2.6L21 12l-2.6 2.6"/>',
  decDec: '<circle cx="4.4" cy="16.4" r="1.1" fill="currentColor" stroke="none"/><ellipse cx="9.3" cy="12" rx="2.4" ry="3.8"/><path d="M21 12h-6.5m2.6-2.6L14.5 12l2.6 2.6"/>',
  sum: '<path d="M17.5 5.5H7l6 6.5-6 6.5h10.5"/>',
  clear: '<path d="m7 21-4.6-4.6a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7M5.5 11l8 8"/>',
  sortAsc: '<path d="M12 19V5M6 11l6-6 6 6M4 21h7"/>',
  sortDesc: '<path d="M12 5v14M6 13l6 6 6-6M4 3h7"/>',
  sort: '<path d="M8 5v14M4 9l4-4 4 4M16 19V5M12 15l4 4 4-4"/>',
  filter: '<path d="M3 5h18l-7 8v5.5L10 21v-8z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.7-4.7"/>',
  chartCol: '<path d="M3 21h18"/><rect x="5" y="12" width="4" height="8"/><rect x="11" y="7" width="4" height="13"/><rect x="17" y="3" width="4" height="17"/>',
  chartBar: '<path d="M3 3v18h18"/><rect x="7" y="5" width="13" height="4"/><rect x="9" y="11" width="11" height="4"/><rect x="11" y="17" width="9" height="4"/>',
  chartLine: '<path d="M3 3v18h18"/><path d="m5 15 4.5-5 3.5 3 6-7"/>',
  chartPie: '<path d="M21.2 15.9A10 10 0 1 1 8 2.8"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  chartScatter: '<path d="M3 3v18h18"/><circle cx="8" cy="14" r="1.4"/><circle cx="12" cy="9" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="14" cy="16" r="1.4"/>',
  freeze: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M9.5 4.5v15"/><path d="M3.5 9.5h6v10h-6z" fill="currentColor" stroke="none" opacity=".22"/>',
  rowInsert: '<path d="M3 5h18M3 19h18"/><rect x="3" y="9" width="18" height="6" rx="1" fill="currentColor" stroke="none" opacity=".25"/><path d="M12 8.5v7M8.5 12h7"/>',
  rowDelete: '<path d="M3 5h18M3 19h18"/><rect x="3" y="9" width="18" height="6" rx="1" fill="currentColor" stroke="none" opacity=".25"/><path d="m9 9.5 6 5M15 9.5l-6 5"/>',
  colInsert: '<path d="M5 3v18M19 3v18"/><rect x="9" y="3" width="6" height="18" rx="1" fill="currentColor" stroke="none" opacity=".25"/><path d="M8.5 12h7M12 8.5v7"/>',
  colDelete: '<path d="M5 3v18M19 3v18"/><rect x="9" y="3" width="6" height="18" rx="1" fill="currentColor" stroke="none" opacity=".25"/><path d="m9.5 9 5 6M14.5 9l-5 6"/>',
  plusSheet: '<rect x="3" y="8" width="14" height="12.5" rx="1.5"/><path d="M5.5 8V5A1.6 1.6 0 0 1 7.1 3.4H15"/><path d="M17.5 13.5h6M20.5 10.5v6"/><path d="M6.5 12h7M6.5 15.5h7" opacity=".55"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.7-4.7M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.7-4.7M8 11h6"/>',
  bucket: '<path d="m12 3 8 8-7.5 7.5a2 2 0 0 1-2.8 0L4 12.8a1.5 1.5 0 0 1 0-2.1z"/><path d="m7 8 8 8"/><path d="M21.5 15.5s1.5 2 1.5 3.2a1.8 1.8 0 0 1-3.6 0c0-1.2 2.1-3.2 2.1-3.2z"/>',
  borders: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16" stroke-dasharray="2 2"/>',
  grid: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9.3h18M3 14.6h18M9 4v16M15 4v16"/>',
  fx: '<path d="M13.9 5.3c-.9-.9-2.4-.8-3.1.3-.3.5-.5 1.1-.5 1.7v10.2M8.3 9.9h5.8"/><path d="m14.9 11.2 5.3 6.2M20.2 11.2l-5.3 6.2"/>',
  sigma: '<path d="M17 5H7l6.5 7L7 19h10"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M9 4v16"/>',
  dedupe: '<rect x="3" y="3" width="12" height="12" rx="1.5"/><rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="m12.5 12.5 5 5M17.5 12.5l-5 5"/>',
  split: '<path d="M3 12h5M8 12l4-5h3M8 12l4 5h3M18 4v5M18 15v5"/>',
  check: '<path d="m4 12.5 5 5L20 6.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  chevLeft: '<path d="m15 6-6 6 6 6"/>',
  chevUp: '<path d="m18 15-6-6-6 6"/>',
  chevsLeft: '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  chevsRight: '<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>',
  arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7L11 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.8 2.2-2.8 4"/><path d="M12 17.5v.5"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  validate: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9"/>',
  nameBox: '<path d="M4 5h13a3 3 0 0 1 0 6H4z"/><path d="M20 13H7a3 3 0 0 0 0 6h13z" stroke-dasharray="2.5 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  tag: '<path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8z"/><circle cx="7" cy="7" r="1.3"/>',
  dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  calculate: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  styles: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17.5h7M17.5 14v7"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 16v-4h1.5a1.5 1.5 0 0 1 0 3H8M13 16v-4h1a2 2 0 0 1 2 2s0 2-2 2z" stroke-width="1.2"/>',
  csv: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13.5h8M8 17h5"/><path d="M8 10h2.5"/>',
  xlsx: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M6.5 12h11M6.5 16h11M10 12v8M14.2 12v8"/>',
  selectAll: '<rect x="4" y="4" width="16" height="16" rx="1.5" stroke-dasharray="3 2"/><path d="m8.5 12.5 2.5 2.5 5-5"/>',
  fontColor: '<path d="m7.2 16.5 3.9-10.6h1.8l3.9 10.6M8.9 12.7h6.2"/><rect x="4" y="19" width="16" height="3" rx="1" fill="currentColor" stroke="none"/>',
  dup: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 4H5a2 2 0 0 0-2 2v11"/><path d="M14.5 11v7M11 14.5h7"/>',
  eyeOff: '<path d="M2 12s3.5-7 10-7c2 0 3.8.6 5.3 1.5M22 12s-3.5 7-10 7c-2 0-3.8-.6-5.3-1.5"/><path d="M4 4l16 16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  text: '<path d="M4 7V5h16v2M9 5v14M7 19h4"/>',
  datamodel: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
  auditPrec: '<rect x="3" y="9" width="7" height="6" rx="1"/><rect x="15" y="9" width="7" height="6" rx="1"/><path d="M10 12h5"/><path d="m13 9.5 2.5 2.5-2.5 2.5"/>',
  auditDep: '<rect x="2" y="9" width="7" height="6" rx="1"/><rect x="14" y="9" width="7" height="6" rx="1"/><path d="M9 12h5"/><path d="m12 9.5 2.5 2.5-2.5 2.5"/>',
  auditOff: '<rect x="3" y="9" width="7" height="6" rx="1"/><rect x="15" y="9" width="7" height="6" rx="1"/><path d="M11 10.5h3" stroke-dasharray="2 2"/><path d="M3 3l18 18" stroke-width="1.4"/>',
  comment: '<path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v4"/>',
  auditAll: '<circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="5.5" r="2.2"/><circle cx="12" cy="18.5" r="2.2"/><circle cx="19" cy="12" r="2.2"/><path d="M7 11l3.2-4M7 13l3.2 4M14.2 6.5 17 10M14.2 17.5 17 14"/>',
  gauge: '<path d="M5 19a9 9 0 1 1 14 0"/><path d="M12 13l3.5-3.5"/><circle cx="12" cy="13" r="1.4"/><path d="M8 19h8"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 1 2.5 6"/><path d="M3.5 12H1.8M3.5 12l1.8-2.2"/><path d="M12 7.5V12l3 2"/>',
  command: '<path d="M9 9h6v6H9z"/><path d="M9 9H7.5A2.25 2.25 0 1 1 9.75 6.75V9zM15 9h1.5A2.25 2.25 0 1 0 14.25 6.75V9zM9 15H7.5a2.25 2.25 0 1 0 2.25 2.25V15zM15 15h1.5a2.25 2.25 0 1 1-2.25 2.25V15z"/>',
  sparkle: '<path d="M12 4.5 13.6 9l4.4 1.6-4.4 1.6L12 16.7l-1.6-4.5L6 10.6 10.4 9z"/><path d="m18.6 15.4.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>'
};
function icon(name, cls) {
  const p = ICONS[name] || ICONS.dots;
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="' + (cls || '') + '">' + p + '</svg>';
}
function setIcon(elm, name) { if (elm) elm.innerHTML = icon(name); }

/* ==========================================================================
 * 2. INDEXEDDB PERSISTENCE
 * ========================================================================== */
const IO = (() => {
  const DB_NAME = 'emeraldcore.storage.suite.sheets', STORE = 'workbooks';
  const RECENT_KEY = 'emeraldcore.suite.sheets.recent';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function saveDoc(id, doc) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(doc, id);
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }
  async function loadDoc(id) {
    const db = await openDB();
    return reqP(db.transaction(STORE).objectStore(STORE).get(id));
  }
  async function deleteDoc(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).delete(id);
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }
  async function allDocs() {
    const db = await openDB();
    const store = db.transaction(STORE).objectStore(STORE);
    const keys = await reqP(store.getAllKeys());
    const vals = await reqP(store.getAll());
    return keys.map((k, i) => ({ id: k, doc: vals[i] }))
      .filter(x => x.id !== RECENT_KEY && x.doc);
  }
  async function saveRecent(id) {
    const db = await openDB();
    return new Promise((resolve) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(id, RECENT_KEY);
      t.oncomplete = () => resolve(true);
      t.onerror = () => resolve(false);
    });
  }
  async function loadRecent() {
    try {
      const db = await openDB();
      const val = await reqP(db.transaction(STORE).objectStore(STORE).get(RECENT_KEY));
      return typeof val === 'string' ? val : null;
    } catch (e) { return null; }
  }
  return { saveDoc, loadDoc, deleteDoc, allDocs, saveRecent, loadRecent };
})();

/* ==========================================================================
 * 3. NUMBER / DATE FORMATTING ENGINE
 * Supports: General, 0 # ? . , % E+00, quoted literals, _ and * fills,
 * section splitting (pos;neg;zero;text), [Red]/[Blue] colors, date tokens
 * (yyyy yy mmmm mmm mm m dddd ddd dd d hh h ss s AM/PM a/p), @ text, and
 * fraction formats (# ?/?, # ??/??, halves/quarters/tenths/hundredths).
 * ========================================================================== */
const DATE_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function serialToDate(serial) { return new Date(DATE_EPOCH + Math.round(serial * DAY_MS)); }
function dateToSerial(d) {
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - DATE_EPOCH) / DAY_MS;
}
const errObj = code => ({ err: code });
const isErr = v => v && typeof v === 'object' && typeof v.err === 'string';
function generalNum(v) {
  if (!isFinite(v)) return v > 0 ? '1E+308' : '-1E+308';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const r = parseFloat(v.toPrecision(11));
  return String(r);
}

function splitSections(code) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') { q = !q; cur += ch; }
    else if (ch === '\\' && i + 1 < code.length) { cur += ch + code[i + 1]; i++; }
    else if (ch === ';' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function stripColor(sec) {
  const m = /^\[(Red|Blue|Green|Black|White|Yellow|Magenta|Cyan)\]/i.exec(sec);
  if (m) return { sec: sec.slice(m[0].length), color: m[1].toLowerCase() };
  return { sec, color: null };
}
function tokenizeFmt(sec) {
  const toks = []; let i = 0;
  while (i < sec.length) {
    const ch = sec[i];
    if (ch === '"') { const j = sec.indexOf('"', i + 1); const end = j === -1 ? sec.length : j; toks.push({ t: 'lit', v: sec.slice(i + 1, end) }); i = end + 1; continue; }
    if (ch === '\\') { toks.push({ t: 'lit', v: sec[i + 1] || '' }); i += 2; continue; }
    if (ch === '_') { toks.push({ t: 'pad', v: sec[i + 1] || ' ' }); i += 2; continue; }
    if (ch === '*') { toks.push({ t: 'fill', v: sec[i + 1] || ' ' }); i += 2; continue; }
    if (/[0#?]/.test(ch)) { let j = i; while (j < sec.length && /[0#?]/.test(sec[j])) j++; toks.push({ t: 'digits', v: sec.slice(i, j) }); i = j; continue; }
    if (ch === '.') { toks.push({ t: 'dot' }); i++; continue; }
    if (ch === ',') { toks.push({ t: 'comma' }); i++; continue; }
    if (ch === '%') { toks.push({ t: 'pct' }); i++; continue; }
    if (ch === '@') { toks.push({ t: 'at' }); i++; continue; }
    if (ch === '[') { const j = sec.indexOf(']', i); toks.push({ t: 'cond', v: sec.slice(i + 1, j === -1 ? sec.length : j) }); i = (j === -1 ? sec.length : j) + 1; continue; }
    if (/[yYdDhHsS]/.test(ch) || /m/i.test(ch)) {
      // date tokens — decide m = month or minute by context (h before, s after)
      let j = i; const lower = sec.toLowerCase();
      const c = lower[i];
      while (j < sec.length && lower[j] === c) j++;
      const n = j - i;
      if (c === 'm' || c === 'a' || c === 'p') {
        // month vs minute: month if previous meaningful token is date-y (y/d) or no h immediately before
        let prevMeaning = '';
        for (let k = i - 1; k >= 0; k--) { if (/[ymdhs]/i.test(sec[k])) { prevMeaning = sec[k].toLowerCase(); break; } if (!/[\"a-z ]/i.test(sec[k]) === false) continue; break; }
        let nextMeaning = '';
        for (let k = j; k < sec.length; k++) { if (/[ymdhs]/i.test(sec[k])) { nextMeaning = sec[k].toLowerCase(); break; } }
        const isMinute = (prevMeaning === 'h') || (!prevMeaning && nextMeaning === 's');
        toks.push({ t: c === 'm' ? (isMinute ? 'min' : 'mon') : 'ampm', v: n, raw: sec.slice(i, j) });
      } else {
        const map = { y: 'year', d: 'day', h: 'hour', s: 'sec' };
        toks.push({ t: map[c], v: n, raw: sec.slice(i, j) });
      }
      i = j; continue;
    }
    if (/[eE]$/.test(ch) && /[+|-]/.test(sec[i + 1] || '')) { toks.push({ t: 'exp', v: sec[i + 1] }); i += 2; const j = i; while (j < sec.length && /[0#]/.test(sec[j])) i++; toks.push({ t: 'digits', v: sec.slice(j, i) || '0' }); continue; }
    if (ch === '/') { toks.push({ t: 'slash' }); i++; continue; }
    if (ch === '$') { toks.push({ t: 'lit', v: '$' }); i++; continue; }
    toks.push({ t: 'lit', v: ch }); i++;
  }
  return toks;
}
function isDateFormat(toks) { return toks.some(t => ['year', 'mon', 'min', 'day', 'hour', 'sec', 'ampm'].includes(t.t)); }

function fmtDateTokens(toks, serial) {
  const d = serialToDate(serial);
  let out = '', ampm = null;
  // pre-scan for 12h clock
  const hasAMPM = toks.some(t => t.t === 'ampm');
  for (const t of toks) {
    if (t.t === 'lit') { out += t.v; continue; }
    if (t.t === 'pad') { out += ' '; continue; }
    if (t.t === 'fill') { out += t.v; continue; }
    const n = t.v | 0;
    switch (t.t) {
      case 'year': out += n >= 4 ? String(d.getUTCFullYear()).padStart(4, '0') : ('' + d.getUTCFullYear()).slice(-2); break;
      case 'mon': out += n >= 4 ? MONTH_NAMES[d.getUTCMonth()] : n === 3 ? MONTH_NAMES[d.getUTCMonth()].slice(0, 3) : String(d.getUTCMonth() + 1).padStart(n, '0'); break;
      case 'min': out += String(d.getUTCMinutes()).padStart(Math.max(2, n), '0'); break;
      case 'day': out += n >= 4 ? DAY_NAMES[d.getUTCDay()] : n === 3 ? DAY_NAMES[d.getUTCDay()].slice(0, 3) : String(d.getUTCDate()).padStart(n, '0'); break;
      case 'hour': {
        let h = d.getUTCHours();
        if (hasAMPM) { ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; }
        out += String(h).padStart(Math.max(2, n), '0'); break;
      }
      case 'sec': out += String(d.getUTCSeconds()).padStart(Math.max(2, n), '0'); break;
      case 'ampm': out += (ampm || (d.getUTCHours() >= 12 ? 'PM' : 'AM')); break;
      default: break;
    }
  }
  return out;
}

function applyDigits(intDigits, decDigits, v, opts) {
  // intDigits: token string like "#,##0"; decDigits: like "00"
  const neg = v < 0;
  const abs = Math.abs(v);
  let decPlaces = (decDigits.match(/[0#?]/g) || []).length;
  let scaled = abs;
  let s = scaled.toFixed(Math.min(decPlaces, 100));
  let [si, sd] = s.split('.');
  if (sd === undefined) sd = '';
  // distribute integer part into the integer token (right-aligned)
  const intTok = intDigits.replace(/,/g, '');
  const minInt = (intTok.match(/0/g) || []).length;
  while (si.length < minInt) si = '0' + si;
  // pad decimals to match placeholder counts (# can be dropped)
  let decOut = '';
  const decTok = decDigits;
  for (let i = 0; i < decTok.length; i++) {
    const ph = decTok[decTok.length - 1 - i];
    const dg = sd[decTok.length - 1 - i] || '';
    if (ph === '0') decOut = (dg || '0') + decOut;
    else if (ph === '#') decOut = (dg && (dg !== '0' || /[1-9]/.test(sd.slice(0, decTok.length - i)) || decOut !== '')) ? dg + decOut : (/[1-9]/.test(sd.slice(0, decTok.length - i)) ? '0' + decOut : decOut);
    else decOut = (dg || ' ') + decOut; // ?
  }
  // thousands separators
  const useSep = intDigits.includes(',');
  if (useSep) si = si.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return { int: si, dec: decOut, neg };
}

function formatValue(v, code) {
  if (v == null) return '';
  if (isErr(v)) return v.err;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (code === undefined || code === null || code === 'General' || code === '') return typeof v === 'number' ? generalNum(v) : String(v);
  if (typeof v === 'string') {
    const secs = splitSections(code);
    const textSec = secs[3];
    if (textSec === undefined) return v;
    return textSec.replace(/@/g, v).replace(/"/g, '');
  }
  if (typeof v !== 'number') return String(v);
  const secs = splitSections(code).map(stripColor);
  let sec, negOverride = null;
  if (v > 0) sec = secs[0];
  else if (v < 0) sec = secs[1] || secs[0];
  else sec = secs[2] !== undefined ? secs[2] : secs[0];
  const secStr = sec.sec;
  if (secs[1]) negOverride = v < 0; // negative uses its own section => no auto minus
  const toks = tokenizeFmt(secStr);
  if (!toks.length) return generalNum(v);
  // scale factors
  let scale = 1;
  let pctCount = 0, commaTrail = 0, hasExp = false;
  for (const t of toks) { if (t.t === 'pct') pctCount++; }
  // trailing commas right after last digit token => thousands scaling
  const lastDig = toks.map(t => t.t).lastIndexOf('digits');
  for (let i = lastDig + 1; i < toks.length; i++) { if (toks[i].t === 'comma') commaTrail++; else break; }
  scale = Math.pow(100, pctCount) * Math.pow(1000, -commaTrail);
  if (isDateFormat(toks)) {
    if (pctCount) v = v * scale;
    return fmtDateTokens(toks, v);
  }
  if (secs[3] !== undefined && typeof v === 'number') { /* numeric with text section falls through */ }
  // scientific?
  const expIdx = toks.findIndex(t => t.t === 'exp');
  if (expIdx !== -1) {
    const mantToks = toks.slice(0, expIdx);
    const mantDigits = mantToks.filter(t => t.t === 'digits').map(t => t.v).join('');
    const dotBefore = mantToks.some(t => t.t === 'dot');
    const decCount = dotBefore ? Math.max((mantDigits.match(/[0#?]/g) || []).length - 1, 0) : 0;
    const expZeros = Math.max((toks.slice(expIdx + 1).map(t => t.t === 'digits' ? t.v : '').join('').match(/0/g) || []).length, 1);
    let expv = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)));
    let mant = v / Math.pow(10, expv);
    const str = mant.toFixed(decCount);
    const [mi, md] = str.split('.');
    const sign = expv >= 0 ? '+' : '-';
    return (v < 0 ? '-' : '') + mi + (md ? '.' + md : '') + 'E' + toks[expIdx].v + sign + String(Math.abs(expv)).padStart(expZeros, '0');
  }
  // fraction?
  if (toks.some(t => t.t === 'slash') && !toks.some(t => t.t === 'dot')) {
    const digToks = toks.filter(t => t.t === 'digits');
    const scaled = v * scale;
    const preToks = toks.slice(0, toks.findIndex(t => t.t === 'digits'));
    const numTokStr = toks.filter(t => t.t === 'digits')[0];
    const numPart = digToks[0] ? digToks[0].v : '#';
    const denPart = digToks[1] ? digToks[1].v : '?';
    let prefix = '';
    for (const t of toks) { if (t.t === 'lit' || t.t === 'pad') prefix += t.t === 'pad' ? ' ' : t.v; if (t.t === 'digits') break; }
    const whole = Math.floor(Math.abs(scaled));
    const frac = Math.abs(scaled) - whole;
    const qCount = (denPart.match(/\?/g) || []).length;
    let D = qCount === 0 ? 2 : qCount === 1 ? 9 : Math.pow(10, qCount);
    let bestD = 1, bestN = 0, bestErr = Infinity;
    const tryD = d => { const n = Math.round(frac * d); const err = Math.abs(frac - n / d); if (err + 1e-15 < bestErr) { bestErr = err; bestD = d; bestN = n; } };
    if (D === 9) { for (let d = 2; d <= 64; d++) tryD(d); } else { for (let d = 1; d <= D; d++) tryD(d); }
    const sign = scaled < 0 ? '-' : '';
    let res;
    if (bestN === 0) res = String(whole);
    else if (whole === 0) res = bestN + '/' + bestD;
    else res = whole + ' ' + bestN + '/' + bestD;
    return prefix + sign + res;
  }
  // numeric
  let intTok = '', decTok = '', dotSeen = false;
  const digitToks = [];
  for (const t of toks) if (t.t === 'digits') digitToks.push(t.v);
  // merge digit tokens across the dot
  const dotIdx = toks.findIndex(t => t.t === 'dot');
  let intPart = '', decPart = '';
  if (dotIdx === -1) intPart = digitToks.join('');
  else {
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].t === 'digits') { if (i < dotIdx) intPart += toks[i].v; else decPart += toks[i].v; }
    }
  }
  const scaled = v * scale;
  const r = applyDigits(intPart || '0', decPart, scaled, {});
  // build literal prefix/suffix
  let out = '';
  let placedDec = false;
  for (const t of toks) {
    switch (t.t) {
      case 'lit': out += t.v; break;
      case 'pad': out += ' '; break;
      case 'fill': out += t.v; break;
      case 'digits': {
        if (!placedDec) out += r.int;
        else { /* second digit run for decimals already handled by decPart loop */ }
        placedDec = true; break;
      }
      case 'dot': { if (!placedDec) { out += r.int; placedDec = true; } if (r.dec) out += '.' + r.dec; break; }
      case 'pct': out += '%'; break;
      case 'comma': break;
      case 'at': out += String(v); break;
      default: break;
    }
  }
  if (!placedDec) out = out.replace(/(^|[^\d,])0*$/, (m, p1) => p1); // strip accidental
  if (dotIdx === -1 && decPart) { /* rare: decimals without dot token — ignore */ }
  // minus handling
  if (r.neg) {
    if (secs[1]) { /* own section: pattern includes its own minus or parens */ }
    else if (!/-/.test(out) && !/\(/.test(out)) out = '-' + out;
  }
  return out;
}

/* Category preset codes used across the UI */
const NUMCAT = {
  general: 'General',
  number: d => '#,##0' + (d > 0 ? '.' + '0'.repeat(d) : ''),
  currency: d => '"$"#,##0' + (d > 0 ? '.' + '0'.repeat(d) : ''),
  accounting: d => '_("$"* #,##0' + (d > 0 ? '.' + '0'.repeat(d) : '') + '_);_("$"* \\(#,##0' + (d > 0 ? '.' + '0'.repeat(d) : '') + '\\);_("$"* "-"??_);_(@_)',
  shortDate: 'm/d/yyyy',
  longDate: 'dddd, mmmm d, yyyy',
  time: 'h:mm:ss AM/PM',
  percent: d => '0' + (d > 0 ? '.' + '0'.repeat(d) : '') + '%',
  fraction: '# ?/?',
  scientific: '0.00E+00',
  text: '@'
};

/* ==========================================================================
 * STYLE MODEL
 * ========================================================================== */
const styleCache = new Map();
function normStyle(s) {
  // Returns a canonical frozen style object (shared reference for equal styles)
  const o = {
    fontFamily: s.fontFamily || DEF.fontFamily,
    fontSize: s.fontSize == null ? DEF.fontPt : s.fontSize,
    bold: !!s.bold, italic: !!s.italic,
    underline: s.underline || 0,           // 0 none, 1 single, 2 double
    strike: !!s.strike,
    color: s.color || null,
    backgroundColor: s.backgroundColor || null,
    halign: s.halign || null,              // left | center | right
    valign: s.valign || null,              // top | middle | bottom
    wrap: !!s.wrap,
    numberFormat: s.numberFormat && s.numberFormat !== 'General' ? s.numberFormat : null,
    numFmtCat: s.numFmtCat || null,
    decimals: s.decimals == null ? null : s.decimals,
    indent: s.indent || 0,
    border: s.border && (s.border.t || s.border.r || s.border.b || s.border.l) ? { t: s.border.t || null, r: s.border.r || null, b: s.border.b || null, l: s.border.l || null } : null
  };
  let k = ''; for (const p in o) k += (o[p] ? (typeof o[p] === 'object' ? JSON.stringify(o[p]) : o[p]) : '~') + '|';
  let cached = styleCache.get(k);
  if (!cached) { cached = Object.freeze(o); styleCache.set(k, cached); }
  return cached;
}
const EMPTY_STYLE = normStyle({});
const DEFAULT_BORDER = { style: 'thin', color: '#d4d4d4' };

/* ==========================================================================
 * 4. FORMULA ENGINE — LEXER / PARSER / SERIALIZER / TRANSFORMS
 * ========================================================================== */
const ERR_LITS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#CIRCULAR!', '#N/A'];
const BOOL_LITS = { TRUE: true, FALSE: false };

function lexFormula(src) {
  const toks = [];
  let i = 0; const n = src.length;
  const slice = from => src.slice(from);
  function trySheet() {
    if (src[i] === "'") {
      let k = i + 1, name = '';
      while (k < n) {
        if (src[k] === "'") { if (src[k + 1] === "'") { name += "'"; k += 2; } else break; }
        else name += src[k++];
      }
      if (src[k] === '!') return { name, end: k + 1 };
      return null;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*!/.exec(slice(i));
    if (m) return { name: m[0].slice(0, -1), end: i + m[0].length };
    return null;
  }
  function lexCell() {
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/.exec(slice(i));
    if (!m) return null;
    return { ac: !!m[1], c: colIndex(m[2]), ar: !!m[3], r: parseInt(m[4], 10) - 1, len: m[0].length };
  }
  function lexColSpan() {
    const m = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/.exec(slice(i));
    if (!m) return null;
    return { ac1: !!m[1], c1: colIndex(m[2]), ac2: !!m[3], c2: colIndex(m[4]), len: m[0].length };
  }
  function lexRowSpan() {
    const m = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![0-9])/.exec(slice(i));
    if (!m) return null;
    return { ar1: !!m[1], r1: parseInt(m[2], 10) - 1, ar2: !!m[3], r2: parseInt(m[4], 10) - 1, len: m[0].length };
  }
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      /* keep whitespace runs as tokens — a space between two references is the
         intersection operator; the post-pass below drops all other spaces */
      while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++;
      toks.push({ t: 'ws' });
      continue;
    }
    if (ch === '"') {
      let j = i + 1, s = '';
      while (j < n) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; } else { j++; break; } } else s += src[j++]; }
      toks.push({ t: 'str', v: s }); i = j; continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(slice(i));
      toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (ch === '#') {
      const up = src.toUpperCase();
      const hit = ERR_LITS.find(e => up.startsWith(e, i));
      if (hit) { toks.push({ t: 'err', v: hit }); i += hit.length; continue; }
      throw new Error('Unknown error literal at position ' + i);
    }
    if (ch === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (ch === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (ch === ',') { toks.push({ t: 'comma' }); i++; continue; }
    if (ch === '{') { toks.push({ t: 'lb' }); i++; continue; }
    if (ch === '}') { toks.push({ t: 'rb' }); i++; continue; }
    if (ch === ';') { toks.push({ t: 'semi' }); i++; continue; }
    if (ch === ':') { toks.push({ t: 'colon' }); i++; continue; }
    if (ch === '<') {
      if (src[i + 1] === '=') { toks.push({ t: 'op', v: '<=' }); i += 2; } else if (src[i + 1] === '>') { toks.push({ t: 'op', v: '<>' }); i += 2; } else { toks.push({ t: 'op', v: '<' }); i++; }
      continue;
    }
    if (ch === '>') { if (src[i + 1] === '=') { toks.push({ t: 'op', v: '>=' }); i += 2; } else { toks.push({ t: 'op', v: '>' }); i++; } continue; }
    if ('=+-*/^&%'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '$' || /[A-Za-z_]/.test(ch)) {
      const sp = trySheet();
      if (sp) {
        const saveI = i; i = sp.end;
        const cell = lexCell();
        if (cell) {
          i += cell.len;
          if (src[i] === ':') {
            i++;
            const cell2 = lexCell();
            if (cell2) { i += cell2.len; toks.push({ t: 'range', sheet: sp.name, r1: cell.r, c1: cell.c, r2: cell2.r, c2: cell2.c, ar1: cell.ar, ac1: cell.ac, ar2: cell2.ar, ac2: cell2.ac }); continue; }
            throw new Error('Expected cell after : at position ' + i);
          }
          toks.push({ t: 'ref', sheet: sp.name, r: cell.r, c: cell.c, ar: cell.ar, ac: cell.ac }); continue;
        }
        const cs = lexColSpan();
        if (cs) { i += cs.len; toks.push({ t: 'colrange', sheet: sp.name, c1: cs.c1, c2: cs.c2, ac1: cs.ac1, ac2: cs.ac2 }); continue; }
        const rs = lexRowSpan();
        if (rs) { i += rs.len; toks.push({ t: 'rowrange', sheet: sp.name, r1: rs.r1, r2: rs.r2, ar1: rs.ar1, ar2: rs.ar2 }); continue; }
        i = saveI;
        throw new Error('Expected cell reference after sheet name at position ' + i);
      }
      const cell = lexCell();
      if (cell) {
        i += cell.len;
        if (src[i] === ':') {
          i++;
          const cell2 = lexCell();
          if (cell2) { i += cell2.len; toks.push({ t: 'range', sheet: null, r1: cell.r, c1: cell.c, r2: cell2.r, c2: cell2.c, ar1: cell.ar, ac1: cell.ac, ar2: cell2.ar, ac2: cell2.ac }); continue; }
          throw new Error('Expected cell after : at position ' + i);
        }
        toks.push({ t: 'ref', sheet: null, r: cell.r, c: cell.c, ar: cell.ar, ac: cell.ac }); continue;
      }
      const cs = lexColSpan();
      if (cs) { i += cs.len; toks.push({ t: 'colrange', sheet: null, c1: cs.c1, c2: cs.c2, ac1: cs.ac1, ac2: cs.ac2 }); continue; }
      const rs = lexRowSpan();
      if (rs) { i += rs.len; toks.push({ t: 'rowrange', sheet: null, r1: rs.r1, r2: rs.r2, ar1: rs.ar1, ar2: rs.ar2 }); continue; }
      const idm = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(slice(i));
      if (!idm) throw new Error('Unexpected character "' + ch + '" at position ' + i);
      const word = idm[0]; i += word.length;
      let k = i; while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (src[k] === '(') { toks.push({ t: 'func', v: word.toUpperCase() }); i = k; continue; }
      const upw = word.toUpperCase();
      if (upw in BOOL_LITS) { toks.push({ t: 'bool', v: BOOL_LITS[upw] }); continue; }
      toks.push({ t: 'name', v: word }); continue;
    }
    throw new Error('Unexpected character "' + ch + '" at position ' + i);
  }
  /* whitespace post-pass: drop every space token except between two reference-ish
     tokens, where it becomes the classic intersection operator */
  const REFISH_TOK = new Set(['ref', 'range', 'colrange', 'rowrange', 'name', 'rp', 'lp']);
  const out = [];
  for (let t = 0; t < toks.length; t++) {
    if (toks[t].t !== 'ws') { out.push(toks[t]); continue; }
    let q = t;
    while (q < toks.length && toks[q].t === 'ws') q++;
    const prev = out[out.length - 1], nxt = toks[q];
    if (prev && nxt && REFISH_TOK.has(prev.t) && REFISH_TOK.has(nxt.t)) out.push({ t: 'op', v: ' ' });
    t = q - 1;
  }
  return out;
}

/* ---------------- Parser ---------------- */
/* AST node types that denote a reference (allowed as union operands) */
const REFISH_AST = new Set(['ref', 'range', 'colrange', 'rowrange', 'union', 'name']);
const isRefishAST = n => !!(n && REFISH_AST.has(n.t));
function parseTokens(toks) {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = t => { const tok = toks[p]; if (!tok || tok.t !== t) throw new Error('Expected ' + t); p++; return tok; };
  const atOp = (...vs) => { const tk = peek(); return tk && tk.t === 'op' && vs.includes(tk.v) ? tk.v : null; };

  function parseExpr() { return parseCompare(); }
  function parseCompare() {
    let l = parseConcat();
    let op;
    while ((op = atOp('=', '<>', '<', '>', '<=', '>='))) { next(); const r = parseConcat(); l = { t: 'bin', op, l, r }; }
    return l;
  }
  function parseConcat() {
    let l = parseAdd();
    while (atOp('&')) { next(); const r = parseAdd(); l = { t: 'bin', op: '&', l, r }; }
    return l;
  }
  function parseAdd() {
    let l = parseMul();
    let op;
    while ((op = atOp('+', '-'))) { next(); const r = parseMul(); l = { t: 'bin', op, l, r }; }
    return l;
  }
  function parseMul() {
    let l = parsePower();
    let op;
    while ((op = atOp('*', '/'))) { next(); const r = parsePower(); l = { t: 'bin', op, l, r }; }
    return l;
  }
  /* classic spreadsheet precedence: negation binds TIGHTER than ^ (=-2^2 is 4), and ^ is left-associative */
  function parsePower() {
    let l = parseUnary();
    while (atOp('^')) { next(); const r = parseUnary(); l = { t: 'bin', op: '^', l, r }; }
    return l;
  }
  function parseUnary() {
    const op = atOp('-', '+');
    if (op) { next(); return { t: 'un', op, e: parseUnary() }; }
    return parsePostfix();
  }
  function parsePostfix() {
    let e = parsePrimary();
    while (atOp('%')) { next(); e = { t: 'pct', e }; }
    /* reference operator: a space between references = intersection;
       binds tighter than any arithmetic/comparison (classic grammar) */
    while (atOp(' ')) { next(); const r = parseUnary(); e = { t: 'bin', op: ' ', l: e, r }; }
    return e;
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error('Unexpected end of formula');
    if (tk.t === 'num') { next(); return { t: 'num', v: tk.v }; }
    if (tk.t === 'str') { next(); return { t: 'str', v: tk.v }; }
    if (tk.t === 'bool') { next(); return { t: 'bool', v: tk.v }; }
    if (tk.t === 'err') { next(); return { t: 'err', v: tk.v }; }
    if (tk.t === 'ref') { next(); return { t: 'ref', sheet: tk.sheet, r: tk.r, c: tk.c, ar: tk.ar, ac: tk.ac }; }
    if (tk.t === 'range') { next(); return { t: 'range', sheet: tk.sheet, r1: tk.r1, c1: tk.c1, r2: tk.r2, c2: tk.c2, ar1: tk.ar1, ac1: tk.ac1, ar2: tk.ar2, ac2: tk.ac2 }; }
    if (tk.t === 'colrange') { next(); return { t: 'colrange', sheet: tk.sheet, c1: tk.c1, c2: tk.c2, ac1: tk.ac1, ac2: tk.ac2 }; }
    if (tk.t === 'rowrange') { next(); return { t: 'rowrange', sheet: tk.sheet, r1: tk.r1, r2: tk.r2, ar1: tk.ar1, ar2: tk.ar2 }; }
    if (tk.t === 'name') { next(); return { t: 'name', v: tk.v }; }
    if (tk.t === 'func') {
      next(); expect('lp');
      const args = [];
      if (peek() && peek().t === 'rp') { next(); return { t: 'func', name: tk.v, args }; }
      while (true) {
        /* ',' is the canonical argument separator; ';' is the classic locale-style
           alternative — both accepted, ',' canonical on output */
        if (peek() && (peek().t === 'comma' || peek().t === 'semi' || peek().t === 'rp')) args.push({ t: 'empty' });
        else args.push(parseExpr());
        const nx = next();
        if (!nx) throw new Error('Unterminated function call');
        if (nx.t === 'rp') break;
        if (nx.t !== 'comma' && nx.t !== 'semi') throw new Error("Expected ',', ';' or ')' in function call");
      }
      return { t: 'func', name: tk.v, args };
    }
    if (tk.t === 'lp') {
      next();
      const e = parseExpr();
      /* parenthesized union reference: (A1,A2) combines discontinuous refs
         into ONE reference argument — classic grammar */
      if (peek() && (peek().t === 'comma' || peek().t === 'semi') && isRefishAST(e)) {
        const parts = [e];
        while (peek() && (peek().t === 'comma' || peek().t === 'semi')) {
          next();
          const part = parseExpr();
          if (!isRefishAST(part)) throw new Error('Expected reference in union');
          parts.push(part);
        }
        expect('rp');
        return { t: 'union', parts };
      }
      expect('rp');
      return e;
    }
    if (tk.t === 'lb') {
      next();
      const rows = [];
      let cur = [];
      while (true) {
        const tk2 = peek();
        if (!tk2) throw new Error('Unterminated array literal');
        if (tk2.t === 'rb') { next(); break; }
        if (tk2.t === 'semi') { next(); rows.push(cur); cur = []; continue; }
        if (tk2.t === 'comma') { next(); continue; }
        cur.push(parsePrimary());
      }
      if (cur.length) rows.push(cur);
      return { t: 'array', rows };
    }
    if (tk.t === 'colon') { next(); return parsePrimary(); } // tolerate stray colon
    throw new Error('Unexpected token "' + (tk.v !== undefined ? tk.v : tk.t) + '"');
  }
  const ast = parseExpr();
  if (p < toks.length) throw new Error('Unexpected input at token ' + p);
  return ast;
}

const astCache = new Map();
/* deep-clone a cached AST so mutating walkers (shift/adjust rewrites) never
   poison the shared cache entry for the same formula body */
function cloneAST(n) {
  if (n === null || typeof n !== 'object') return n;
  if (Array.isArray(n)) return n.map(cloneAST);
  const out = {};
  for (const k in n) out[k] = cloneAST(n[k]);
  return out;
}
function parseFormula(src) {
  if (typeof src !== 'string' || !src) throw new Error('Empty formula');
  const body = src[0] === '=' ? src.slice(1) : src;
  const hit = astCache.get(body);
  if (hit) return cloneAST(hit);
  const ast = parseTokens(lexFormula(body));
  if (astCache.size > 8000) astCache.clear();
  astCache.set(body, ast);
  return ast;
}

/* ---------------- Serializer ---------------- */
function needsQuote(name) { return !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name); }
function serRef(n) {
  const sheet = n.sheet ? (needsQuote(n.sheet) ? "'" + n.sheet.replace(/'/g, "''") + "'" : n.sheet) + '!' : '';
  return sheet + (n.ac ? '$' : '') + colName(n.c) + (n.ar ? '$' : '') + (n.r + 1);
}
function serRangeFull(n) {
  const sheet = n.sheet ? (needsQuote(n.sheet) ? "'" + n.sheet.replace(/'/g, "''") + "'" : n.sheet) + '!' : '';
  if (n.t === 'colrange') return sheet + (n.ac1 ? '$' : '') + colName(n.c1) + ':' + (n.ac2 ? '$' : '') + colName(n.c2);
  if (n.t === 'rowrange') return sheet + (n.ar1 ? '$' : '') + (n.r1 + 1) + ':' + (n.ar2 ? '$' : '') + (n.r2 + 1);
  return sheet + (n.ac1 ? '$' : '') + colName(n.c1) + (n.ar1 ? '$' : '') + (n.r1 + 1) + ':' +
    (n.ac2 ? '$' : '') + colName(n.c2) + (n.ar2 ? '$' : '') + (n.r2 + 1);
}
const PREC = { ' ': 7, '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 6 };
function serializeAST(n) {
  switch (n.t) {
    case 'num': { const s = String(n.v); return s; }
    case 'str': return '"' + n.v.replace(/"/g, '""') + '"';
    case 'bool': return n.v ? 'TRUE' : 'FALSE';
    case 'err': return n.v;
    case 'empty': return '';
    case 'ref': return serRef(n);
    case 'range': case 'colrange': case 'rowrange': return serRangeFull(n);
    case 'name': return n.v;
    case 'un': {
      const inner = serializeAST(n.e);
      return n.op + (PREC['^'] >= 5 && (n.e.t === 'bin' && n.e.op === '^') ? '(' + inner + ')' : inner);
    }
    case 'pct': return serializeAST(n.e) + '%';
    case 'bin': {
      const myP = PREC[n.op];
      const wrapL = n.l.t === 'bin' && PREC[n.l.op] < myP;
      const wrapR = n.r.t === 'bin' && (PREC[n.r.op] < myP || (PREC[n.r.op] === myP && (n.op === '-' || n.op === '/')));
      if (n.op === '^' && (n.l.t === 'un' || n.r.t === 'un')) {
        // -2^2 keeps unary at top level visually
      }
      return (wrapL ? '(' + serializeAST(n.l) + ')' : serializeAST(n.l)) + n.op + (wrapR ? '(' + serializeAST(n.r) + ')' : serializeAST(n.r));
    }
    case 'union': return '(' + n.parts.map(serializeAST).join(',') + ')';
    case 'func': return n.name + '(' + n.args.map(serializeAST).join(',') + ')';
    case 'array': return '{' + n.rows.map(r => r.map(serializeAST).join(',')).join(';') + '}';
    default: return '';
  }
}

/* ---------------- AST walking / transforms ---------------- */
function walkAST(n, fn) {
  if (!n || typeof n !== 'object') return;
  fn(n);
  switch (n.t) {
    case 'un': walkAST(n.e, fn); break;
    case 'pct': walkAST(n.e, fn); break;
    case 'bin': walkAST(n.l, fn); walkAST(n.r, fn); break;
    case 'func': n.args.forEach(a => walkAST(a, fn)); break;
    case 'union': n.parts.forEach(p => walkAST(p, fn)); break;
    case 'array': n.rows.forEach(r => r.forEach(c => walkAST(c, fn))); break;
    default: break;
  }
}

/* Shift all relative references by (dr, dc). Used by copy/fill/drag-move. */
function shiftFormulaRefs(src, dr, dc) {
  try {
    const ast = parseFormula(src);
    walkAST(ast, n => {
      if (n.t === 'ref') {
        if (!n.ar) { const r = n.r + dr; if (r < 0 || r >= MAX_ROWS) { n.t = 'err'; n.v = '#REF!'; return; } n.r = r; }
        if (!n.ac) { const c = n.c + dc; if (c < 0 || c >= MAX_COLS) { n.t = 'err'; n.v = '#REF!'; return; } n.c = c; }
      } else if (n.t === 'range') {
        if (!n.ar1 && !n.ar2) {
          const r1 = n.r1 + dr, r2 = n.r2 + dr;
          if (r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS) { n.t = 'err'; n.v = '#REF!'; return; }
          n.r1 = Math.min(r1, r2); n.r2 = Math.max(r1, r2);
        } else if (!n.ar1) { const r1 = n.r1 + dr; if (r1 < 0) { n.t = 'err'; n.v = '#REF!'; return; } n.r1 = r1; }
        else if (!n.ar2) { const r2 = n.r2 + dr; if (r2 < 0) { n.t = 'err'; n.v = '#REF!'; return; } n.r2 = r2; }
        if (!n.ac1 && !n.ac2) {
          const c1 = n.c1 + dc, c2 = n.c2 + dc;
          if (c1 < 0 || c2 < 0 || c1 >= MAX_COLS || c2 >= MAX_COLS) { n.t = 'err'; n.v = '#REF!'; return; }
          n.c1 = Math.min(c1, c2); n.c2 = Math.max(c1, c2);
        } else if (!n.ac1) { const c1 = n.c1 + dc; if (c1 < 0) { n.t = 'err'; n.v = '#REF!'; return; } n.c1 = c1; }
        else if (!n.ac2) { const c2 = n.c2 + dc; if (c2 < 0) { n.t = 'err'; n.v = '#REF!'; return; } n.c2 = c2; }
      }
    });
    return (src[0] === '=' ? '=' : '') + serializeAST(ast);
  } catch (e) { return src; }
}

/* Insert/delete rows or columns on a sheet — adjust formulas that reference it.
 * spanFilter (optional): for 'rows' kind, only refs in columns [c1..c2] adjust; for 'cols' kind, refs in rows [r1..r2]. */
function adjustFormulaStructure(src, ownSheetName, targetSheetName, kind, at, count, isDelete, spanFilter) {
  try {
    const ast = parseFormula(src);
    let changed = false;
    walkAST(ast, n => {
      const nodeSheet = n.sheet === null ? ownSheetName : n.sheet;
      if (nodeSheet !== targetSheetName) return;
      const isRow = kind === 'rows';
      /* span filter check */
      if (spanFilter) {
        if (isRow) {
          let cLo, cHi;
          if (n.t === 'ref') { cLo = cHi = n.c; }
          else if (n.t === 'colrange') { cLo = n.c1; cHi = n.c2; }
          else if (n.t === 'range') { cLo = n.c1; cHi = n.c2; }
          else if (n.t === 'rowrange') { cLo = 0; cHi = MAX_COLS - 1; }
          else return;
          if (cLo === 0 && cHi >= MAX_COLS - 1) { /* full-row ref in a filtered col insert: adjust */ }
          else if (cHi < spanFilter.c1 || cLo > spanFilter.c2) return;
        } else {
          let rLo, rHi;
          if (n.t === 'ref') { rLo = rHi = n.r; }
          else if (n.t === 'rowrange') { rLo = n.r1; rHi = n.r2; }
          else if (n.t === 'range') { rLo = n.r1; rHi = n.r2; }
          else if (n.t === 'colrange') { rLo = 0; rHi = MAX_ROWS - 1; }
          else return;
          if (rLo === 0 && rHi >= MAX_ROWS - 1) { }
          else if (rHi < spanFilter.r1 || rLo > spanFilter.r2) return;
        }
      }
      const applyRef = (obj, prop) => {
        let v = obj[prop];
        if (isDelete) { if (v >= at + count) { obj[prop] = v - count; } else if (v >= at) { n.t = 'err'; n.v = '#REF!'; } }
        else if (v >= at) obj[prop] = v + count;
      };
      const applySpan = (obj, p1, p2) => {
        let a = obj[p1], b = obj[p2];
        if (isDelete) {
          if (a >= at + count) { a -= count; b -= count; }
          else if (b >= at + count) { b -= count; if (a >= at) a = at; }
          else if (b >= at) { b = at - 1; if (a > b) { n.t = 'err'; n.v = '#REF!'; return; } }
          obj[p1] = a; obj[p2] = b;
        } else {
          if (a >= at) { a += count; b += count; }
          else if (b >= at) b += count;
          obj[p1] = a; obj[p2] = b;
        }
      };
      if (isRow) {
        if (n.t === 'ref') { changed = true; applyRef(n, 'r'); }
        else if (n.t === 'range' && !(n.r1 === 0 && n.r2 >= MAX_ROWS - 1)) { changed = true; applySpan(n, 'r1', 'r2'); }
        else if (n.t === 'rowrange') { changed = true; applySpan(n, 'r1', 'r2'); }
      } else {
        if (n.t === 'ref') { changed = true; applyRef(n, 'c'); }
        else if (n.t === 'range' && !(n.c1 === 0 && n.c2 >= MAX_COLS - 1)) { changed = true; applySpan(n, 'c1', 'c2'); }
        else if (n.t === 'colrange') { changed = true; applySpan(n, 'c1', 'c2'); }
      }
    });
    return changed ? ((src[0] === '=' ? '=' : '') + serializeAST(ast)) : src;
  } catch (e) { return src; }
}

/* Extract dependency descriptors from an AST */
function extractDeps(ast) {
  const cells = [], ranges = [], names = new Set();
  walkAST(ast, n => {
    if (n.t === 'ref') cells.push({ sheet: n.sheet, r: n.r, c: n.c });
    else if (n.t === 'range') ranges.push({ sheet: n.sheet, r1: n.r1, c1: n.c1, r2: n.r2, c2: n.c2 });
    else if (n.t === 'colrange') ranges.push({ sheet: n.sheet, r1: 0, c1: n.c1, r2: MAX_ROWS - 1, c2: n.c2 });
    else if (n.t === 'rowrange') ranges.push({ sheet: n.sheet, r1: n.r1, c1: 0, r2: n.r2, c2: MAX_COLS - 1 });
    else if (n.t === 'name') names.add(n.v);
  });
  return { cells, ranges, names: [...names] };
}

/* ==========================================================================
 * 6. EVALUATOR + DEPENDENCY GRAPH + RECALC ENGINE
 * ========================================================================== */
const Calc = {
  mode: 'auto',                 // 'auto' | 'manual'
  dirty: new Set(),             // formula keys needing recalc: "sid|r,c"
  volatileKeys: new Set(),      // formula keys of volatile formulas
  evalStack: new Set(),         // cycle detection
  depth: 0
};
const VOLATILE_FN = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'INDIRECT']);

const depKeyOf = (sid, r, c) => sid + '|' + r + ',' + c;

const DepGraph = {
  cellDeps: new Map(),          // "sid|r,c" -> Set<formulaKey>
  rangeDeps: new Map(),         // sid -> [{r1,c1,r2,c2,fkey}]
  fDeps: new Map(),             // formulaKey -> {cells:[], ranges:[]}
  register(fkey, sid, deps, nameResolver) {
    this.unregister(fkey);
    const rec = { cells: [], ranges: [] };
    for (const d of deps.cells) {
      const tsid = d.sheet == null ? sid : (sheetIdByName(d.sheet));
      if (tsid == null) continue;
      const dk = depKeyOf(tsid, d.r, d.c);
      let set = this.cellDeps.get(dk);
      if (!set) { set = new Set(); this.cellDeps.set(dk, set); }
      set.add(fkey); rec.cells.push(dk);
    }
    for (const d of deps.ranges) {
      const tsid = d.sheet == null ? sid : (sheetIdByName(d.sheet));
      if (tsid == null) continue;
      let arr = this.rangeDeps.get(tsid);
      if (!arr) { arr = []; this.rangeDeps.set(tsid, arr); }
      arr.push({ r1: d.r1, c1: d.c1, r2: d.r2, c2: d.c2, fkey });
      rec.ranges.push(tsid);
    }
    for (const nm of deps.names) {
      const def = WB.names[nm.toLowerCase()];
      if (def) {
        const tsid = def.sheetId;
        let arr = this.rangeDeps.get(tsid);
        if (!arr) { arr = []; this.rangeDeps.set(tsid, arr); }
        arr.push({ r1: def.r1, c1: def.c1, r2: def.r2, c2: def.c2, fkey });
        rec.ranges.push(tsid);
      }
    }
    this.fDeps.set(fkey, rec);
  },
  unregister(fkey) {
    const rec = this.fDeps.get(fkey);
    if (!rec) return;
    for (const dk of rec.cells) {
      const set = this.cellDeps.get(dk);
      if (set) { set.delete(fkey); if (!set.size) this.cellDeps.delete(dk); }
    }
    for (const sid of rec.ranges) {
      const arr = this.rangeDeps.get(sid);
      if (arr) {
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i].fkey === fkey) arr.splice(i, 1);
      }
    }
    this.fDeps.delete(fkey);
  },
  dependentsOf(sid, r, c) {
    const out = new Set();
    const set = this.cellDeps.get(depKeyOf(sid, r, c));
    if (set) for (const k of set) out.add(k);
    const arr = this.rangeDeps.get(sid);
    if (arr) for (const d of arr) { if (r >= d.r1 && r <= d.r2 && c >= d.c1 && c <= d.c2) out.add(d.fkey); }
    return out;
  },
  clearAll() { this.cellDeps.clear(); this.rangeDeps.clear(); this.fDeps.clear(); }
};

function rebuildAllDeps() {
  DepGraph.clearAll();
  Calc.volatileKeys.clear();
  for (const sh of WB.sheets) {
    for (const [k, cell] of sh.cells) {
      if (!cell.f) continue;
      const [rs, cs] = k.split(',');
      const fkey = depKeyOf(sh.id, +rs, +cs);
      try {
        const ast = parseFormula(cell.f);
        cell.ast = ast;
        const deps = extractDeps(ast);
        DepGraph.register(fkey, sh.id, deps);
        if (new Set(deps.cells.length ? [] : []).size === 0) {
          // detect volatility by walking function names
          let vol = false;
          walkAST(ast, n => { if (n.t === 'func' && VOLATILE_FN.has(n.name)) vol = true; });
          if (vol) Calc.volatileKeys.add(fkey);
        }
      } catch (e) { cell.ast = null; cell.cv = errObj('#NAME?'); }
    }
  }
}

function markDirty(sid, r, c) {
  // BFS over dependency graph — mark edited cell + transitive dependents dirty
  const queue = [[sid, r, c]];
  const seen = new Set();
  while (queue.length) {
    const [s, rr, cc] = queue.shift();
    const k = depKeyOf(s, rr, cc);
    if (seen.has(k)) continue;
    seen.add(k);
    const cell = getRawCell(s, rr, cc);
    if (cell && cell.f) Calc.dirty.add(k);
    for (const fk of DepGraph.dependentsOf(s, rr, cc)) {
      const barIdx = fk.indexOf('|');
      const fsid = fk.slice(0, barIdx);
      const [fr, fc] = fk.slice(barIdx + 1).split(',');
      queue.push([fsid, +fr, +fc]);
    }
  }
  // volatiles always refresh
  for (const fk of Calc.volatileKeys) Calc.dirty.add(fk);
}
function markAllDirty() {
  for (const sh of WB.sheets) for (const [k, cell] of sh.cells) if (cell.f) Calc.dirty.add(depKeyOf(sh.id, +k.split(',')[0], +k.split(',')[1]));
  for (const fk of Calc.volatileKeys) Calc.dirty.add(fk);
}

/* Compute a cell's value on demand (lazy, memoized, cycle-safe). */
function getComputedCell(sid, r, c) {
  const cell = getRawCell(sid, r, c);
  if (!cell) return null;
  if (cell.f) {
    const k = depKeyOf(sid, r, c);
    if (cell.cv !== undefined && !Calc.dirty.has(k)) return cell.cv;
    if (Calc.mode === 'manual' && cell.cv !== undefined) return cell.cv; // stale until F9
    if (Calc.evalStack.has(k)) return errObj('#CIRCULAR!');
    if (Calc.depth > 2500) return errObj('#VALUE!');
    if (!cell.ast) {
      try { cell.ast = parseFormula(cell.f); } catch (e) { cell.ast = null; }
      if (!cell.ast) { cell.cv = errObj('#NAME?'); return cell.cv; }
      const deps = extractDeps(cell.ast);
      DepGraph.register(k, sid, deps);
      let vol = false; walkAST(cell.ast, n => { if (n.t === 'func' && VOLATILE_FN.has(n.name)) vol = true; });
      if (vol) Calc.volatileKeys.add(k);
    }
    Calc.evalStack.add(k); Calc.depth++;
    let v;
    try { v = evalAST(cell.ast, { sid, r, c }); }
    catch (e) { v = errObj(e && e.__xlerr ? e.__xlerr : '#VALUE!'); }
    Calc.depth--; Calc.evalStack.delete(k);
    cell.cv = v; Calc.dirty.delete(k);
    return v;
  }
  return cell.v;
}

function evalFormulaText(src, ctxSheetId, r, c) {
  try {
    const ast = parseFormula(src);
    return evalAST(ast, { sid: ctxSheetId, r: r == null ? 0 : r, c: c == null ? 0 : c });
  } catch (e) { return errObj(e && e.__xlerr ? e.__xlerr : '#NAME?'); }
}

/* ---------------- Runtime values ---------------- */
function rangeValue(sid, r1, c1, r2, c2) {
  r1 = clamp(r1, 0, MAX_ROWS - 1); r2 = clamp(r2, 0, MAX_ROWS - 1);
  c1 = clamp(c1, 0, MAX_COLS - 1); c2 = clamp(c2, 0, MAX_COLS - 1);
  return {
    __r: true, sid, r1, c1, r2, c2,
    get h() { return this.r2 - this.r1 + 1; },
    get w() { return this.c2 - this.c1 + 1; },
    at(i, j) { return getComputedCell(this.sid, this.r1 + i, this.c1 + j); },
    eachRow(fn) { for (let i = 0; i < this.h; i++) fn(i, j => this.at(i, j)); }
  };
}
const isRange = v => v && v.__r === true;

/* combine discontinuous references ("(C4,C6)") into one virtual range:
   row-major across parts; position props hold the bounding box */
function unionRangeValue(list) {
  const h = list.reduce((s, r) => s + r.h, 0);
  const w = Math.max(...list.map(r => r.w));
  return {
    __r: true, sid: list[0].sid,
    r1: Math.min(...list.map(r => r.r1)), c1: Math.min(...list.map(r => r.c1)),
    r2: Math.max(...list.map(r => r.r2)), c2: Math.max(...list.map(r => r.c2)),
    get h() { return h; },
    get w() { return w; },
    at(i, j) {
      for (const r of list) {
        if (i < r.h) return j < r.w ? r.at(i, j) : null;
        i -= r.h;
      }
      return null;
    },
    eachRow(fn) {
      let off = 0;
      for (const r of list) {
        for (let i = 0; i < r.h; i++) fn(off + i, j => r.at(i, j));
        off += r.h;
      }
    }
  };
}

function xlerr(code) { const e = new Error(code); e.__xlerr = code; throw e; }
function checkErr(v) { if (isErr(v)) xlerr(v.err); return v; }

function intersectScalar(rv, ctx) {
  if (rv.h === 1 && rv.w === 1) return rv.at(0, 0);
  if (rv.h === 1 && ctx.r === rv.r1) return rv.at(0, clamp(ctx.c - rv.c1, 0, rv.w - 1));
  if (rv.w === 1 && ctx.c === rv.c1) return rv.at(clamp(ctx.r - rv.r1, 0, rv.h - 1), 0);
  if (ctx.r >= rv.r1 && ctx.r <= rv.r2 && ctx.c >= rv.c1 && ctx.c <= rv.c2) return rv.at(ctx.r - rv.r1, ctx.c - rv.c1);
  return rv.at(0, 0);
}

/* Coercions */
function toNum(v, ctx) {
  v = checkErr(v);
  if (isRange(v)) v = intersectScalar(v, ctx);
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    const n = Number(s.replace(/,/g, ''));
    if (!isNaN(n) && /^-?[\d,.]+(e[+-]?\d+)?%?$/i.test(s)) return n;
    const d = tryParseDateStr(s);
    if (d != null) return d;
    xlerr('#VALUE!');
  }
  if (typeof v === 'object' && v.rows) { // array literal
    const first = v.rows[0] && v.rows[0][0];
    return toNum(first, ctx);
  }
  xlerr('#VALUE!');
}
function toStr(v, ctx) {
  v = checkErr(v);
  if (isRange(v)) v = intersectScalar(v, ctx);
  if (v == null) return '';
  if (typeof v === 'number') return generalNum(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
function toBool(v, ctx) {
  v = checkErr(v);
  if (isRange(v)) v = intersectScalar(v, ctx);
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') { const s = v.trim().toUpperCase(); if (s === 'TRUE') return true; if (s === 'FALSE') return false; return s !== ''; }
  return Boolean(v);
}
function toInt(v, ctx) { return Math.trunc(toNum(v, ctx)); }

/* Compare two scalar values with classic spreadsheet ordering (numbers < text < FALSE < TRUE) */
function compareVals(a, b) {
  const rank = v => v == null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 3 : 0;
  let ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return cmpNum(a, b);
  if (ra === 2) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return (a === b) ? 0 : (a ? 1 : -1);
}

/* evaluate a node, preserving reference geometry for bare refs (reference operators) */
function evalRefLike(n, ctx) {
  if (n.t === 'ref') {
    const sid = n.sheet == null ? ctx.sid : sheetIdByName(n.sheet);
    if (sid == null) return errObj('#REF!');
    return rangeValue(sid, n.r, n.c, n.r, n.c);
  }
  return evalAST(n, ctx);
}

/* evalAST: evaluate an AST node in a context */
function evalAST(n, ctx) {
  switch (n.t) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'bool': return n.v;
    case 'err': return errObj(n.v);
    case 'empty': return null;
    case 'ref': {
      const sid = n.sheet == null ? ctx.sid : sheetIdByName(n.sheet);
      if (sid == null) return errObj('#REF!');
      return getComputedCell(sid, n.r, n.c);
    }
    case 'range': case 'colrange': case 'rowrange': {
      const sid = n.sheet == null ? ctx.sid : sheetIdByName(n.sheet);
      if (sid == null) return errObj('#REF!');
      if (n.t === 'colrange') return rangeValue(sid, 0, n.c1, MAX_ROWS - 1, n.c2);
      if (n.t === 'rowrange') return rangeValue(sid, n.r1, 0, n.r2, MAX_COLS - 1);
      return rangeValue(sid, n.r1, n.c1, n.r2, n.c2);
    }
    case 'union': {
      const list = [];
      for (const p of n.parts) {
        const v = evalRefLike(p, ctx);
        if (!isRange(v)) return v; /* propagate #REF! etc. */
        list.push(v);
      }
      if (!list.length) xlerr('#VALUE!');
      if (list.length === 1) return list[0];
      return unionRangeValue(list);
    }
    case 'name': {
      const def = WB.names[n.v.toLowerCase()];
      if (!def) xlerr('#NAME?');
      return rangeValue(def.sheetId, def.r1, def.c1, def.r2, def.c2);
    }
    case 'un': {
      const v = evalAST(n.e, ctx);
      if (n.op === '-') return -toNum(v, ctx);
      return toNum(v, ctx);
    }
    case 'pct': return toNum(evalAST(n.e, ctx), ctx) / 100;
    case 'bin': {
      const op = n.op;
      if (op === ' ') {
        /* reference intersection operator: common cells of both operands, #NULL! if none */
        const ia = evalRefLike(n.l, ctx), ib = evalRefLike(n.r, ctx);
        checkErr(ia); checkErr(ib);
        if (!isRange(ia) || !isRange(ib) || ia.sid !== ib.sid) xlerr('#NULL!');
        const ir1 = Math.max(ia.r1, ib.r1), ic1 = Math.max(ia.c1, ib.c1);
        const ir2 = Math.min(ia.r2, ib.r2), ic2 = Math.min(ia.c2, ib.c2);
        if (ir1 > ir2 || ic1 > ic2) xlerr('#NULL!');
        return rangeValue(ia.sid, ir1, ic1, ir2, ic2);
      }
      if (op === '&' ) { return toStr(evalAST(n.l, ctx), ctx) + toStr(evalAST(n.r, ctx), ctx); }
      if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
        const a = evalAST(n.l, ctx), b = evalAST(n.r, ctx);
        checkErr(a); checkErr(b);
        let av = isRange(a) ? intersectScalar(a, ctx) : a;
        let bv = isRange(b) ? intersectScalar(b, ctx) : b;
        // numeric strings compare as numbers when other side is number
        if (typeof av === 'string' && typeof bv === 'number' && av.trim() !== '' && !isNaN(Number(av))) av = Number(av);
        if (typeof bv === 'string' && typeof av === 'number' && bv.trim() !== '' && !isNaN(Number(bv))) bv = Number(bv);
        const c = compareVals(av, bv);
        switch (op) { case '=': return c === 0; case '<>': return c !== 0; case '<': return c < 0; case '>': return c > 0; case '<=': return c <= 0; case '>=': return c >= 0; }
      }
      const a = toNum(evalAST(n.l, ctx), ctx), b = toNum(evalAST(n.r, ctx), ctx);
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': if (b === 0) xlerr('#DIV/0!'); return a / b;
        case '^': return Math.pow(a, b);
      }
      xlerr('#VALUE!');
      break;
    }
    case 'array': return { rows: n.rows.map(row => row.map(x => evalAST(x, ctx))) };
    case 'func': {
      const f = FUNCS[n.name];
      if (!f) xlerr('#NAME?');
      return f.impl(n.args, ctx);
    }
    default: xlerr('#VALUE!');
  }
}

/* ==========================================================================
 * 5. FUNCTION LIBRARY
 * ========================================================================== */
const FUNCS = {};
const FUNC_META = []; // {name, cat, desc, args}
function defFn(name, cat, args, desc, impl) {
  FUNCS[name] = { impl, cat };
  FUNC_META.push({ name, cat, args, desc });
}
/* helper: evaluate + coerce AST arg */
const _ev = (a, ctx) => a === undefined ? null : evalAST(a, ctx);
const _num = (a, ctx) => toNum(_ev(a, ctx), ctx);
const _int = (a, ctx) => Math.trunc(_num(a, ctx));
const _str = (a, ctx) => toStr(_ev(a, ctx), ctx);
const _bool = (a, ctx) => toBool(_ev(a, ctx), ctx);
function _range(a, ctx) {
  const v = _ev(a, ctx);
  if (isRange(v)) return v;
  if (v && v.rows) { // array literal → fake range over materialized values
    const h = v.rows.length, w = v.rows[0].length;
    const vals = v.rows.map(r => r.slice());
    return { __r: true, arr: vals, h, w, at(i, j) { return this.arr[i][j]; }, r1: 0, c1: 0, r2: h - 1, c2: w - 1, sid: ctx.sid };
  }
  return null;
}
/* flatten args to a flat list of raw scalar values (ranges expanded) */
function flatten(args, ctx, opts) {
  const out = [];
  for (const a of args) {
    const v = _ev(a, ctx);
    if (isRange(v)) {
      const h = v.h, w = v.w;
      if (h * w > 3e6) xlerr('#VALUE!');
      for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
        const cv = v.at(i, j);
        if (cv == null || cv === '') { continue; }
        out.push(cv);
      }
    } else if (v && v.rows) {
      for (const row of v.rows) for (const x of row) if (x != null) out.push(x);
    } else if (v != null) out.push(v);
  }
  return out;
}
function numbersOf(args, ctx, opts = {}) {
  const vals = flatten(args, ctx, opts);
  const nums = [];
  for (const v of vals) {
    if (isErr(v)) xlerr(v.err);
    if (typeof v === 'number') nums.push(v);
    else if (typeof v === 'boolean' && opts.bools) nums.push(v ? 1 : 0);
    else if (typeof v === 'string' && opts.text) { const n = Number(v.replace(/,/g, '')); if (!isNaN(n) && v.trim() !== '') nums.push(n); }
  }
  return nums;
}
/* wildcard-aware text matcher */
function wildcardToRegex(pat) {
  let out = '';
  for (const ch of pat) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '~' ) { out += '~'; }
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  out = out.replace(/~\*/g, '\\*').replace(/~\?/g, '\\?').replace(/~~/g, '~');
  return new RegExp('^' + out + '$', 'i');
}
function makeCriteria(crit, ctx) {
  let v = crit;
  if (isRange(v)) v = intersectScalar(v, ctx);
  checkErr(v);
  if (typeof v === 'number') return x => typeof x === 'number' && cmpNum(x, v) === 0;
  if (typeof v === 'boolean') return x => typeof x === 'boolean' && x === v;
  if (v == null) return x => x == null || x === '';
  const s = String(v);
  const m = /^(<=|>=|<>|=|<|>)([\s\S]*)$/.exec(s);
  if (m) {
    const op = m[1], rest = m[2].trim();
    const num = Number(rest.replace(/,/g, ''));
    const isNum = rest !== '' && !isNaN(num);
    const isDate = !isNum && tryParseDateStr(rest);
    const dval = isDate;
    const cmpWith = x => {
      let xv = x;
      if (typeof xv === 'string') { const nx = Number(xv.replace(/,/g, '')); if (!isNaN(nx) && xv.trim() !== '') xv = nx; else if (dval) xv = tryParseDateStr(xv); }
      if (dval && typeof xv === 'number') { switch (op) { case '=': return xv === dval; case '<>': return xv !== dval; case '<': return xv < dval; case '>': return xv > dval; case '<=': return xv <= dval; case '>=': return xv >= dval; } }
      if (isNum) {
        if (typeof xv !== 'number') return op === '<>';
        switch (op) { case '=': return xv === num; case '<>': return xv !== num; case '<': return xv < num; case '>': return xv > num; case '<=': return xv <= num; case '>=': return xv >= num; }
      }
      const xs = toStr(xv, ctx).toLowerCase(), ys = rest.toLowerCase();
      switch (op) { case '=': case '': return xs === ys; case '<>': return xs !== ys; case '<': return xs < ys; case '>': return xs > ys; case '<=': return xs <= ys; case '>=': return xs >= ys; }
      return false;
    };
    if (op === '=') { const eq = makeCriteria(rest === '' ? '' : rest, ctx); if (typeof rest === 'string' && /[*?]/.test(rest)) return x => typeof x === 'string' && wildcardToRegex(rest).test(x); return x => !isErr(x) && eq(x); }
    return x => { if (isErr(x)) return false; return cmpWith(x); };
  }
  if (/[*?]/.test(s)) return x => !isErr(x) && typeof x === 'string' && wildcardToRegex(s).test(x);
  const low = s.toLowerCase();
  const numLow = Number(low.replace(/,/g, ''));
  return x => {
    if (isErr(x)) return false;
    if (x == null) return low === '';
    if (typeof x === 'number') return !isNaN(numLow) && low !== '' && cmpNum(x, numLow) === 0;
    return String(x).toLowerCase() === low;
  };
}
function range1D(a, ctx) {
  const rv = _range(a, ctx);
  if (!rv) return null;
  if (rv.h === 1 && rv.w >= 1) return { vals: Array.from({ length: rv.w }, (_, j) => rv.at(0, j)), dim: 'row' };
  if (rv.w === 1) return { vals: Array.from({ length: rv.h }, (_, i) => rv.at(i, 0)), dim: 'col' };
  return null;
}

/* ---- Math & Trig ---- */
defFn('SUM', 'Math & Trig', 'SUM(number1, [number2], ...)', 'Adds its arguments.', (a, ctx) => numbersOf(a, ctx, { text: false }).reduce((s, x) => s + x, 0));
defFn('AVERAGE', 'Math & Trig', 'AVERAGE(number1, ...)', 'Arithmetic mean of the arguments.', (a, ctx) => { const n = numbersOf(a, ctx); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : xlerr('#DIV/0!'); });
defFn('COUNT', 'Math & Trig', 'COUNT(value1, ...)', 'Counts how many numbers are in the list of arguments.', (a, ctx) => numbersOf(a, ctx, { bools: false, text: false }).length);
defFn('COUNTA', 'Math & Trig', 'COUNTA(value1, ...)', 'Counts how many values are not empty.', (a, ctx) => flatten(a, ctx).length);
defFn('COUNTBLANK', 'Math & Trig', 'COUNTBLANK(range)', 'Counts the number of empty cells in a range.', (a, ctx) => {
  const rv = _range(a, ctx);
  if (!rv) return _ev(a, ctx) == null ? 1 : 0;
  let cnt = 0;
  for (let i = 0; i < rv.h; i++) for (let j = 0; j < rv.w; j++) { const v = rv.at(i, j); if (v == null || v === '') cnt++; }
  return cnt;
});
defFn('COUNTIF', 'Math & Trig', 'COUNTIF(range, criteria)', 'Counts cells that meet a criterion.', (a, ctx) => {
  const rv = _range(a[0], ctx); if (!rv) return 0;
  const test = makeCriteria(_ev(a[1], ctx), ctx);
  let cnt = 0;
  for (let i = 0; i < rv.h; i++) for (let j = 0; j < rv.w; j++) { const v = rv.at(i, j); if (v != null && test(v)) cnt++; }
  return cnt;
});
defFn('COUNTIFS', 'Math & Trig', 'COUNTIFS(range1, criteria1, ...)', 'Counts cells that meet multiple criteria.', (a, ctx) => {
  if (a.length < 2 || a.length % 2) return xlerr('#VALUE!');
  const pairs = [];
  for (let i = 0; i < a.length; i += 2) {
    const rv = _range(a[i], ctx);
    if (!rv) return xlerr('#VALUE!');
    pairs.push({ rv, test: makeCriteria(_ev(a[i + 1], ctx), ctx) });
  }
  const h = pairs[0].rv.h, w = pairs[0].rv.w;
  let cnt = 0;
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
    let ok = true;
    for (const p of pairs) { if (p.rv.h !== h || p.rv.w !== w) return xlerr('#VALUE!'); const v = p.rv.at(i, j); if (v == null || !p.test(v)) { ok = false; break; } }
    if (ok) cnt++;
  }
  return cnt;
});
defFn('SUMIF', 'Math & Trig', 'SUMIF(range, criteria, [sum_range])', 'Adds the cells specified by a criterion.', (a, ctx) => {
  const rv = _range(a[0], ctx); if (!rv) return 0;
  const test = makeCriteria(_ev(a[1], ctx), ctx);
  const sumRv = a[2] ? _range(a[2], ctx) : rv;
  let sum = 0;
  for (let i = 0; i < rv.h; i++) for (let j = 0; j < rv.w; j++) {
    const v = rv.at(i, j);
    if (v != null && test(v)) {
      const sv = sumRv ? (sumRv.at(Math.min(i, sumRv.h - 1), Math.min(j, sumRv.w - 1))) : null;
      if (typeof sv === 'number') sum += sv;
      else if (typeof sv === 'string' && sv.trim() !== '' && !isNaN(Number(sv))) sum += Number(sv);
    }
  }
  return sum;
});
defFn('SUMIFS', 'Math & Trig', 'SUMIFS(sum_range, range1, criteria1, ...)', 'Adds cells that meet multiple criteria.', (a, ctx) => {
  if (a.length < 3 || (a.length - 1) % 2) return xlerr('#VALUE!');
  const sumRv = _range(a[0], ctx); if (!sumRv) return 0;
  const pairs = [];
  for (let i = 1; i < a.length; i += 2) {
    const rv = _range(a[i], ctx);
    if (!rv) return xlerr('#VALUE!');
    pairs.push({ rv, test: makeCriteria(_ev(a[i + 1], ctx), ctx) });
  }
  let sum = 0;
  for (let i = 0; i < sumRv.h; i++) for (let j = 0; j < sumRv.w; j++) {
    let ok = true;
    for (const p of pairs) { const v = p.rv.at(i, j); if (v == null || !p.test(v)) { ok = false; break; } }
    if (ok) { const sv = sumRv.at(i, j); if (typeof sv === 'number') sum += sv; }
  }
  return sum;
});
defFn('SUMPRODUCT', 'Math & Trig', 'SUMPRODUCT(array1, [array2], ...)', 'Multiplies arrays and returns the sum of products.', (a, ctx) => {
  const arrs = a.map(x => { const rv = _range(x, ctx); if (!rv) return null; const m = []; for (let i = 0; i < rv.h; i++) { const row = []; for (let j = 0; j < rv.w; j++) row.push(rv.at(i, j)); m.push(row); } return m; });
  if (arrs.some(x => x === null)) return xlerr('#VALUE!');
  const h = arrs[0].length, w = arrs[0][0].length;
  let sum = 0;
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
    let prod = 1;
    for (const m of arrs) {
      if (m.length !== h || m[0].length !== w) return xlerr('#VALUE!');
      let v = m[i][j];
      if (isErr(v)) xlerr(v.err);
      prod *= typeof v === 'number' ? v : (typeof v === 'boolean' ? (v ? 1 : 0) : 0);
    }
    sum += prod;
  }
  return sum;
});
defFn('MIN', 'Math & Trig', 'MIN(number1, ...)', 'Smallest value.', (a, ctx) => { const n = numbersOf(a, ctx); return n.length ? Math.min(...n) : 0; });
defFn('MAX', 'Math & Trig', 'MAX(number1, ...)', 'Largest value.', (a, ctx) => { const n = numbersOf(a, ctx); return n.length ? Math.max(...n) : 0; });
defFn('MEDIAN', 'Math & Trig', 'MEDIAN(number1, ...)', 'Median of the numbers.', (a, ctx) => { const n = numbersOf(a, ctx).sort(cmpNum); return n.length ? (n.length % 2 ? n[(n.length - 1) / 2] : (n[n.length / 2 - 1] + n[n.length / 2]) / 2) : xlerr('#NUM!'); });
defFn('ABS', 'Math & Trig', 'ABS(number)', 'Absolute value.', (a, ctx) => Math.abs(_num(a[0], ctx)));
defFn('SIGN', 'Math & Trig', 'SIGN(number)', 'Sign of a number.', (a, ctx) => Math.sign(_num(a[0], ctx)));
defFn('SQRT', 'Math & Trig', 'SQRT(number)', 'Square root.', (a, ctx) => { const v = _num(a[0], ctx); if (v < 0) return xlerr('#NUM!'); return Math.sqrt(v); });
defFn('POWER', 'Math & Trig', 'POWER(number, power)', 'Number raised to a power.', (a, ctx) => Math.pow(_num(a[0], ctx), _num(a[1], ctx)));
defFn('EXP', 'Math & Trig', 'EXP(number)', 'e raised to a power.', (a, ctx) => Math.exp(_num(a[0], ctx)));
defFn('LN', 'Math & Trig', 'LN(number)', 'Natural logarithm.', (a, ctx) => { const v = _num(a[0], ctx); if (v <= 0) return xlerr('#NUM!'); return Math.log(v); });
defFn('LOG', 'Math & Trig', 'LOG(number, [base])', 'Logarithm to a base.', (a, ctx) => { const v = _num(a[0], ctx); const b = a[1] ? _num(a[1], ctx) : 10; if (v <= 0 || b <= 0) return xlerr('#NUM!'); return Math.log(v) / Math.log(b); });
defFn('LOG10', 'Math & Trig', 'LOG10(number)', 'Base-10 logarithm.', (a, ctx) => Math.log10(_num(a[0], ctx)));
defFn('MOD', 'Math & Trig', 'MOD(number, divisor)', 'Remainder after division.', (a, ctx) => { const d = _num(a[1], ctx); if (d === 0) return xlerr('#DIV/0!'); const n = _num(a[0], ctx); return n - d * Math.floor(n / d); });
defFn('INT', 'Math & Trig', 'INT(number)', 'Rounds down to nearest integer.', (a, ctx) => Math.floor(_num(a[0], ctx)));
defFn('TRUNC', 'Math & Trig', 'TRUNC(number, [digits])', 'Truncates to an integer.', (a, ctx) => { const d = a[1] ? _int(a[1], ctx) : 0; const f = Math.pow(10, d); return Math.trunc(_num(a[0], ctx) * f) / f; });
defFn('ROUND', 'Math & Trig', 'ROUND(number, digits)', 'Rounds to a specified number of digits.', (a, ctx) => { const d = a[1] ? _int(a[1], ctx) : 0; const f = Math.pow(10, d); return Math.sign(_num(a[0], ctx)) * Math.round(Math.abs(_num(a[0], ctx)) * f) / f; });
defFn('ROUNDUP', 'Math & Trig', 'ROUNDUP(number, digits)', 'Rounds away from zero.', (a, ctx) => { const d = a[1] ? _int(a[1], ctx) : 0; const f = Math.pow(10, d); const v = _num(a[0], ctx); return v > 0 ? Math.ceil(v * f) / f : -Math.ceil(-v * f) / f; });
defFn('ROUNDDOWN', 'Math & Trig', 'ROUNDDOWN(number, digits)', 'Rounds toward zero.', (a, ctx) => { const d = a[1] ? _int(a[1], ctx) : 0; const f = Math.pow(10, d); return Math.trunc(_num(a[0], ctx) * f) / f; });
defFn('PRODUCT', 'Math & Trig', 'PRODUCT(number1, ...)', 'Multiplies its arguments.', (a, ctx) => { const n = numbersOf(a, ctx); return n.length ? n.reduce((p, x) => p * x, 1) : 0; });
defFn('RAND', 'Math & Trig', 'RAND()', 'Random number between 0 and 1.', () => Math.random());
defFn('RANDBETWEEN', 'Math & Trig', 'RANDBETWEEN(bottom, top)', 'Random integer between two values.', (a, ctx) => { const lo = Math.ceil(_num(a[0], ctx)), hi = Math.floor(_num(a[1], ctx)); return lo + Math.floor(Math.random() * (hi - lo + 1)); });
defFn('PI', 'Math & Trig', 'PI()', 'Value of pi.', () => Math.PI);
defFn('LARGE', 'Math & Trig', 'LARGE(array, k)', 'k-th largest value.', (a, ctx) => { const n = numbersOf([a[0]], ctx).sort((x, y) => y - x); const k = _int(a[1], ctx); if (k < 1 || k > n.length) return xlerr('#NUM!'); return n[k - 1]; });
defFn('SMALL', 'Math & Trig', 'SMALL(array, k)', 'k-th smallest value.', (a, ctx) => { const n = numbersOf([a[0]], ctx).sort(cmpNum); const k = _int(a[1], ctx); if (k < 1 || k > n.length) return xlerr('#NUM!'); return n[k - 1]; });

/* ---- Logical ---- */
defFn('IF', 'Logical', 'IF(test, value_if_true, [value_if_false])', 'Returns one value if a condition is TRUE and another if FALSE.', (a, ctx) => {
  if (!a.length) return xlerr('#VALUE!');
  return _bool(a[0], ctx) ? (a[1] !== undefined ? _ev(a[1], ctx) : true) : (a[2] !== undefined ? _ev(a[2], ctx) : false);
});
defFn('AND', 'Logical', 'AND(logical1, ...)', 'TRUE if all arguments are TRUE.', (a, ctx) => { const vals = flatten(a, ctx); if (!vals.length) return xlerr('#VALUE!'); return vals.every(v => toBool(v, ctx)); });
defFn('OR', 'Logical', 'OR(logical1, ...)', 'TRUE if any argument is TRUE.', (a, ctx) => { const vals = flatten(a, ctx); if (!vals.length) return xlerr('#VALUE!'); return vals.some(v => toBool(v, ctx)); });
defFn('XOR', 'Logical', 'XOR(logical1, ...)', 'TRUE if an odd number of arguments are TRUE.', (a, ctx) => flatten(a, ctx).filter(v => toBool(v, ctx)).length % 2 === 1);
defFn('NOT', 'Logical', 'NOT(logical)', 'Reverses the logic of its argument.', (a, ctx) => !_bool(a[0], ctx));
defFn('TRUE', 'Logical', 'TRUE()', 'Logical value TRUE.', () => true);
defFn('FALSE', 'Logical', 'FALSE()', 'Logical value FALSE.', () => false);
defFn('IFERROR', 'Logical', 'IFERROR(value, value_if_error)', 'Returns value_if_error if the first argument is an error; otherwise the value.', (a, ctx) => {
  let v;
  try { v = _ev(a[0], ctx); } catch (e) { return a[1] !== undefined ? _ev(a[1], ctx) : null; }
  if (isErr(v)) return a[1] !== undefined ? _ev(a[1], ctx) : null;
  if (isRange(v)) return v;
  return v;
});
defFn('IFS', 'Logical', 'IFS(test1, value1, ...)', 'Checks conditions in order and returns the value for the first TRUE condition.', (a, ctx) => {
  if (!a.length || a.length % 2) return xlerr('#VALUE!');
  for (let i = 0; i < a.length; i += 2) if (_bool(a[i], ctx)) return _ev(a[i + 1], ctx);
  return xlerr('#N/A');
});
defFn('SWITCH', 'Logical', 'SWITCH(expr, value1, result1, ..., [default])', 'Compares an expression against a list of values.', (a, ctx) => {
  if (a.length < 3) return xlerr('#VALUE!');
  const expr = _ev(a[0], ctx);
  let i = 1;
  for (; i + 1 < a.length; i += 2) {
    const cand = _ev(a[i], ctx);
    if (compareVals(isRange(cand) ? intersectScalar(cand, ctx) : cand, isRange(expr) ? intersectScalar(expr, ctx) : expr) === 0) return _ev(a[i + 1], ctx);
  }
  return i < a.length ? _ev(a[i], ctx) : xlerr('#N/A');
});

/* ---- Text ---- */
defFn('CONCATENATE', 'Text', 'CONCATENATE(text1, ...)', 'Joins several text items into one.', (a, ctx) => a.map(x => _str(x, ctx)).join(''));
defFn('CONCAT', 'Text', 'CONCAT(text1, ...)', 'Combines text from multiple ranges.', (a, ctx) => flatten(a, ctx).map(v => toStr(v, ctx)).join(''));
defFn('TEXTJOIN', 'Text', 'TEXTJOIN(delimiter, ignore_empty, text1, ...)', 'Concatenates with a delimiter.', (a, ctx) => {
  const delim = _str(a[0], ctx), ign = a[1] === undefined ? true : _bool(a[1], ctx);
  const parts = flatten(a.slice(2), ctx).map(v => toStr(v, ctx));
  return (ign ? parts.filter(p => p !== '') : parts).join(delim);
});
defFn('LEFT', 'Text', 'LEFT(text, [num_chars])', 'Leftmost characters.', (a, ctx) => _str(a[0], ctx).slice(0, a[1] === undefined ? 1 : Math.max(0, _int(a[1], ctx))));
defFn('RIGHT', 'Text', 'RIGHT(text, [num_chars])', 'Rightmost characters.', (a, ctx) => { const n = a[1] === undefined ? 1 : Math.max(0, _int(a[1], ctx)); const s = _str(a[0], ctx); return n === 0 ? '' : s.slice(-n); });
defFn('MID', 'Text', 'MID(text, start, num_chars)', 'Characters from the middle of text.', (a, ctx) => { const st = _int(a[1], ctx); if (st < 1) return xlerr('#VALUE!'); return _str(a[0], ctx).substr(st - 1, Math.max(0, _int(a[2], ctx))); });
defFn('LEN', 'Text', 'LEN(text)', 'Length of text.', (a, ctx) => _str(a[0], ctx).length);
defFn('UPPER', 'Text', 'UPPER(text)', 'Converts text to uppercase.', (a, ctx) => _str(a[0], ctx).toUpperCase());
defFn('LOWER', 'Text', 'LOWER(text)', 'Converts text to lowercase.', (a, ctx) => _str(a[0], ctx).toLowerCase());
defFn('PROPER', 'Text', 'PROPER(text)', 'Capitalizes the first letter of each word.', (a, ctx) => _str(a[0], ctx).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()));
defFn('TRIM', 'Text', 'TRIM(text)', 'Removes leading/trailing spaces and collapses doubles.', (a, ctx) => _str(a[0], ctx).replace(/\s+/g, ' ').trim());
defFn('REPLACE', 'Text', 'REPLACE(old_text, start, num_chars, new_text)', 'Replaces part of a text string.', (a, ctx) => {
  const s = _str(a[0], ctx), st = _int(a[1], ctx);
  if (st < 1) return xlerr('#VALUE!');
  return s.slice(0, st - 1) + _str(a[3], ctx) + s.slice(st - 1 + Math.max(0, _int(a[2], ctx)));
});
defFn('SUBSTITUTE', 'Text', 'SUBSTITUTE(text, old, new, [instance])', 'Substitutes new text for old text.', (a, ctx) => {
  const s = _str(a[0], ctx), old = _str(a[1], ctx), neu = _str(a[2], ctx);
  if (old === '') return s;
  if (a[3] === undefined) return s.split(old).join(neu);
  const inst = _int(a[3], ctx);
  if (inst < 1) return xlerr('#VALUE!');
  let idx = -1;
  for (let k = 0; k < inst; k++) { idx = s.indexOf(old, idx + 1); if (idx === -1) return s; }
  return s.slice(0, idx) + neu + s.slice(idx + old.length);
});
defFn('FIND', 'Text', 'FIND(find_text, within_text, [start])', 'Finds one text inside another (case-sensitive).', (a, ctx) => {
  const idx = _str(a[1], ctx).indexOf(_str(a[0], ctx), Math.max(0, (a[2] ? _int(a[2], ctx) : 1) - 1));
  return idx === -1 ? xlerr('#VALUE!') : idx + 1;
});
defFn('SEARCH', 'Text', 'SEARCH(find_text, within_text, [start])', 'Finds one text inside another (case-insensitive, wildcards).', (a, ctx) => {
  const needle = _str(a[0], ctx), hay = _str(a[1], ctx).toLowerCase();
  const pat = wildcardToRegex(needle.replace(/[*?]/g, m => m)).source.replace(/^\^|\$$/g, '');
  const m = new RegExp(pat, 'i').exec(hay.slice(Math.max(0, (a[2] ? _int(a[2], ctx) : 1) - 1)));
  return m ? m.index + (a[2] ? _int(a[2], ctx) : 1) : xlerr('#VALUE!');
});
defFn('EXACT', 'Text', 'EXACT(text1, text2)', 'Case-sensitive comparison.', (a, ctx) => _str(a[0], ctx) === _str(a[1], ctx));
defFn('REPT', 'Text', 'REPT(text, number_times)', 'Repeats text a given number of times.', (a, ctx) => { const n = _int(a[1], ctx); if (n < 0) return xlerr('#VALUE!'); return _str(a[0], ctx).repeat(Math.min(n, 50000)); });
defFn('TEXT', 'Text', 'TEXT(value, format_text)', 'Formats a value using a number format.', (a, ctx) => formatValue(_ev(a[0], ctx), _str(a[1], ctx)));
defFn('VALUE', 'Text', 'VALUE(text)', 'Converts a text string to a number.', (a, ctx) => {
  const s = _str(a[0], ctx).trim();
  if (s === '') return 0;
  if (/^-?\$?[\d,]*\.?\d+%$/.test(s)) { const n = Number(s.replace(/[$,%]/g, '')); return isNaN(n) ? xlerr('#VALUE!') : n / 100; }
  if (/^-?\$?[\d,]*\.?\d+$/.test(s)) { const n = Number(s.replace(/[$,]/g, '')); return isNaN(n) ? xlerr('#VALUE!') : n; }
  const d = tryParseDateStr(s);
  if (d != null) return d;
  return xlerr('#VALUE!');
});

/* ---- Lookup & Reference ---- */
defFn('VLOOKUP', 'Lookup & Reference', 'VLOOKUP(lookup_value, table_array, col_index, [range_lookup])', 'Looks in the first column and returns a value from another column.', (a, ctx) => {
  const lookup = _ev(a[0], ctx);
  const rv = _range(a[1], ctx);
  if (!rv) return xlerr('#VALUE!');
  const ci = _int(a[2], ctx);
  if (ci < 1) return xlerr('#VALUE!');
  if (ci > rv.w) return xlerr('#REF!');
  const approx = a[3] === undefined ? true : _bool(a[3], ctx);
  let found = -1;
  if (!approx) {
    const test = typeof lookup === 'string' && /[*?]/.test(lookup) ? x => typeof x === 'string' && wildcardToRegex(lookup).test(x)
      : x => compareVals(x, isRange(lookup) ? intersectScalar(lookup, ctx) : lookup) === 0 && !(x == null);
    for (let i = 0; i < rv.h; i++) { const v = rv.at(i, 0); if (v != null && test(v)) { found = i; break; } }
  } else {
    let best = null;
    const lv = isRange(lookup) ? intersectScalar(lookup, ctx) : lookup;
    for (let i = 0; i < rv.h; i++) {
      const v = rv.at(i, 0);
      if (v == null || typeof v !== typeof lv && !(typeof v === 'number' && typeof lv === 'number')) continue;
      if (compareVals(v, lv) <= 0) { if (best === null || compareVals(v, best) >= 0) { best = v; found = i; } }
    }
  }
  if (found === -1) return xlerr('#N/A');
  return rv.at(found, ci - 1);
});
defFn('HLOOKUP', 'Lookup & Reference', 'HLOOKUP(lookup_value, table_array, row_index, [range_lookup])', 'Looks in the first row and returns a value from another row.', (a, ctx) => {
  const lookup = _ev(a[0], ctx);
  const rv = _range(a[1], ctx);
  if (!rv) return xlerr('#VALUE!');
  const ri = _int(a[2], ctx);
  if (ri < 1) return xlerr('#VALUE!');
  if (ri > rv.h) return xlerr('#REF!');
  const approx = a[3] === undefined ? true : _bool(a[3], ctx);
  let found = -1;
  if (!approx) {
    for (let j = 0; j < rv.w; j++) { const v = rv.at(0, j); if (v != null && compareVals(v, isRange(lookup) ? intersectScalar(lookup, ctx) : lookup) === 0) { found = j; break; } }
  } else {
    let best = null;
    const lv = isRange(lookup) ? intersectScalar(lookup, ctx) : lookup;
    for (let j = 0; j < rv.w; j++) {
      const v = rv.at(0, j);
      if (v == null) continue;
      if (compareVals(v, lv) <= 0) { if (best === null || compareVals(v, best) >= 0) { best = v; found = j; } }
    }
  }
  if (found === -1) return xlerr('#N/A');
  return rv.at(ri - 1, found);
});
defFn('XLOOKUP', 'Lookup & Reference', 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode])', 'Searches a range and returns a matching value.', (a, ctx) => {
  const lookup = _ev(a[0], ctx);
  const lk = range1D(a[1], ctx), rt = range1D(a[2], ctx);
  if (!lk || !rt) return xlerr('#VALUE!');
  if (lk.vals.length !== rt.vals.length) return xlerr('#VALUE!');
  const mode = a[4] === undefined ? 0 : _int(a[4], ctx);
  const lv = isRange(lookup) ? intersectScalar(lookup, ctx) : lookup;
  let found = -1;
  if (mode === 0 || mode === 2) {
    const test = (mode === 2 || (typeof lv === 'string' && /[*?]/.test(lv)))
      ? x => typeof x === 'string' && wildcardToRegex(String(lv)).test(x)
      : x => x != null && compareVals(x, lv) === 0;
    for (let i = 0; i < lk.vals.length; i++) if (test(lk.vals[i])) { found = i; break; }
    if (found === -1 && a[3] !== undefined) return _ev(a[3], ctx);
  } else if (mode === -1 || mode === 1) {
    let bestIdx = -1, bestV = null;
    for (let i = 0; i < lk.vals.length; i++) {
      const v = lk.vals[i];
      if (v == null) continue;
      const c = compareVals(v, lv);
      if (c === 0) { bestIdx = i; bestV = v; break; }
      if (mode === -1 && c < 0) { if (bestV === null || compareVals(v, bestV) >= 0) { bestV = v; bestIdx = i; } }
      if (mode === 1 && c > 0) { if (bestV === null || compareVals(v, bestV) <= 0) { bestV = v; bestIdx = i; } }
    }
    if (bestIdx === -1 && a[3] !== undefined) return _ev(a[3], ctx);
    found = bestIdx;
  }
  if (found === -1) return xlerr('#N/A');
  return rt.vals[found];
});
defFn('INDEX', 'Lookup & Reference', 'INDEX(array, row_num, [column_num])', 'Returns a value at the intersection of a row and column.', (a, ctx) => {
  const rv = _range(a[0], ctx);
  if (!rv) return _ev(a[0], ctx);
  let r = a[1] === undefined ? 0 : _int(a[1], ctx);
  let c = a[2] === undefined ? (rv.h === 1 ? 0 : -1) : _int(a[2], ctx);
  if (c === -1 && rv.h > 1 && rv.w > 1) c = 0;
  if (rv.h === 1 && a[2] === undefined && r > 0) { c = r; r = 1; }
  if (rv.w === 1 && a[2] === undefined) { /* r already the row */ }
  if (r < 0 || c < 0 || r > rv.h || c > rv.w) return xlerr('#REF!');
  if ((r === 0 || c === 0)) { // whole row/col — return reduced range
    if (r === 0 && c === 0) return rv;
    if (r === 0) return rangeValue(rv.sid, rv.r1, rv.c1 + c - 1, rv.r2, rv.c1 + c - 1);
    return rangeValue(rv.sid, rv.r1 + r - 1, rv.c1, rv.r1 + r - 1, rv.c2);
  }
  return rv.at(r - 1, c - 1);
});
defFn('MATCH', 'Lookup & Reference', 'MATCH(lookup_value, lookup_array, [match_type])', 'Position of an item in a range.', (a, ctx) => {
  const lv = isRange(_ev(a[0], ctx)) ? intersectScalar(_ev(a[0], ctx), ctx) : _ev(a[0], ctx);
  const arr = range1D(a[1], ctx);
  if (!arr) return xlerr('#N/A');
  const type = a[2] === undefined ? 1 : _int(a[2], ctx);
  if (type === 0) {
    const test = typeof lv === 'string' && /[*?]/.test(lv) ? x => typeof x === 'string' && wildcardToRegex(lv).test(x) : x => x != null && compareVals(x, lv) === 0;
    for (let i = 0; i < arr.vals.length; i++) if (test(arr.vals[i])) return i + 1;
    return xlerr('#N/A');
  }
  if (type === 1) {
    let best = -1;
    for (let i = 0; i < arr.vals.length; i++) { const v = arr.vals[i]; if (v == null) continue; if (compareVals(v, lv) <= 0) { if (best === -1 || compareVals(v, arr.vals[best]) >= 0) best = i; } }
    return best === -1 ? xlerr('#N/A') : best + 1;
  }
  let best = -1;
  for (let i = 0; i < arr.vals.length; i++) { const v = arr.vals[i]; if (v == null) continue; if (compareVals(v, lv) >= 0) { if (best === -1 || compareVals(v, arr.vals[best]) <= 0) best = i; } }
  return best === -1 ? xlerr('#N/A') : best + 1;
});
defFn('INDIRECT', 'Lookup & Reference', 'INDIRECT(ref_text)', 'Returns a reference specified by a text string.', (a, ctx) => {
  const s = _str(a[0], ctx).trim();
  if (!s) return xlerr('#REF!');
  try {
    const toks = lexFormula(s);
    const tk = toks[0];
    if (!tk) return xlerr('#REF!');
    if (tk.t === 'ref') { const sid = tk.sheet == null ? ctx.sid : sheetIdByName(tk.sheet); if (sid == null) return xlerr('#REF!'); return getComputedCell(sid, tk.r, tk.c); }
    if (tk.t === 'range') { const sid = tk.sheet == null ? ctx.sid : sheetIdByName(tk.sheet); if (sid == null) return xlerr('#REF!'); return rangeValue(sid, tk.r1, tk.c1, tk.r2, tk.c2); }
    if (tk.t === 'colrange') { const sid = tk.sheet == null ? ctx.sid : sheetIdByName(tk.sheet); if (sid == null) return xlerr('#REF!'); return rangeValue(sid, 0, tk.c1, MAX_ROWS - 1, tk.c2); }
    if (tk.t === 'rowrange') { const sid = tk.sheet == null ? ctx.sid : sheetIdByName(tk.sheet); if (sid == null) return xlerr('#REF!'); return rangeValue(sid, tk.r1, 0, tk.r2, MAX_COLS - 1); }
    return xlerr('#REF!');
  } catch (e) { return xlerr('#REF!'); }
});
defFn('ROW', 'Lookup & Reference', 'ROW([reference])', 'Row number of a reference.', (a, ctx) => {
  if (a[0] && a[0].t === 'ref') return a[0].r + 1;
  if (a[0] && a[0].t === 'range') return a[0].r1 + 1;
  return ctx.r + 1;
});
defFn('COLUMN', 'Lookup & Reference', 'COLUMN([reference])', 'Column number of a reference.', (a, ctx) => {
  if (a[0] && a[0].t === 'ref') return a[0].c + 1;
  if (a[0] && a[0].t === 'range') return a[0].c1 + 1;
  return ctx.c + 1;
});
defFn('ROWS', 'Lookup & Reference', 'ROWS(array)', 'Number of rows in a reference.', (a, ctx) => { const rv = _range(a[0], ctx); return rv ? rv.h : 1; });
defFn('COLUMNS', 'Lookup & Reference', 'COLUMNS(array)', 'Number of columns in a reference.', (a, ctx) => { const rv = _range(a[0], ctx); return rv ? rv.w : 1; });
defFn('ADDRESS', 'Lookup & Reference', 'ADDRESS(row, column, [abs_num], [a1], [sheet_text])', 'Creates a cell address as text.', (a, ctx) => {
  const r = _int(a[0], ctx), c = _int(a[1], ctx);
  const abs = a[2] === undefined ? 1 : _int(a[2], ctx);
  if (r < 1 || c < 1) return xlerr('#VALUE!');
  const rp = (abs === 1 || abs === 3) ? '$' : '';
  const cp = (abs === 1 || abs === 2) ? '$' : '';
  let out = cp + colName(c - 1) + rp + r;
  if (a[4] !== undefined) out = _str(a[4], ctx) + '!' + out;
  return out;
});
defFn('CHOOSE', 'Lookup & Reference', 'CHOOSE(index_num, value1, ...)', 'Chooses a value from a list.', (a, ctx) => {
  const i = _int(a[0], ctx);
  if (i < 1 || i > a.length - 1) return xlerr('#VALUE!');
  return _ev(a[i], ctx);
});

/* ---- Date & Time ---- */
defFn('TODAY', 'Date & Time', 'TODAY()', 'Current date as a serial number.', () => dateToSerial(new Date()) - (dateToSerial(new Date()) % 1));
defFn('NOW', 'Date & Time', 'NOW()', 'Current date and time as a serial number.', () => dateToSerial(new Date()));
defFn('DATE', 'Date & Time', 'DATE(year, month, day)', 'Serial number of a date.', (a, ctx) => {
  let y = _int(a[0], ctx), m = _int(a[1], ctx), d = _int(a[2], ctx);
  if (y < 0 || y > 9999) return xlerr('#NUM!');
  if (y < 1900) y += 1900;
  return dateToSerial(new Date(Date.UTC(y, m - 1, d)));
});
defFn('TIME', 'Date & Time', 'TIME(hour, minute, second)', 'Serial number of a time.', (a, ctx) => {
  const h = _int(a[0], ctx), m = _int(a[1], ctx), s = _int(a[2], ctx);
  const frac = (h * 3600 + m * 60 + s) / 86400;
  return frac % 1;
});
defFn('DAY', 'Date & Time', 'DAY(serial_number)', 'Day of the month.', (a, ctx) => serialToDate(_num(a[0], ctx)).getUTCDate());
defFn('MONTH', 'Date & Time', 'MONTH(serial_number)', 'Month of the year.', (a, ctx) => serialToDate(_num(a[0], ctx)).getUTCMonth() + 1);
defFn('YEAR', 'Date & Time', 'YEAR(serial_number)', 'Year of a date.', (a, ctx) => serialToDate(_num(a[0], ctx)).getUTCFullYear());
defFn('HOUR', 'Date & Time', 'HOUR(serial_number)', 'Hour of the time.', (a, ctx) => serialToDate(_num(a[0], ctx)).getUTCHours());
defFn('MINUTE', 'Date & Time', 'MINUTE(serial_number)', 'Minute of the time.', (a, ctx) => serialToDate(_num(a[0], ctx)).getUTCMinutes());
defFn('SECOND', 'Date & Time', 'SECOND(serial_number)', 'Second of the time.', (a, ctx) => serialToDate(_num(a[0], ctx)).getUTCSeconds());
defFn('WEEKDAY', 'Date & Time', 'WEEKDAY(serial_number, [type])', 'Day of the week as a number.', (a, ctx) => {
  const d = serialToDate(_num(a[0], ctx)).getUTCDay();
  const type = a[1] === undefined ? 1 : _int(a[1], ctx);
  if (type === 1) return d + 1;
  if (type === 2) return d === 0 ? 7 : d;
  if (type === 3) return d === 0 ? 6 : d - 1;
  return d + 1;
});
defFn('WEEKNUM', 'Date & Time', 'WEEKNUM(serial_number)', 'Week number of the year.', (a, ctx) => {
  const d = serialToDate(_num(a[0], ctx));
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.floor((d - start) / (7 * DAY_MS)) + 1;
});
defFn('DATEDIF', 'Date & Time', 'DATEDIF(start, end, unit)', 'Difference between two dates.', (a, ctx) => {
  const s = serialToDate(_num(a[0], ctx)), e = serialToDate(_num(a[1], ctx));
  const unit = _str(a[2], ctx).toUpperCase();
  if (e < s) return xlerr('#NUM!');
  const y = e.getUTCFullYear() - s.getUTCFullYear();
  const mo = e.getUTCMonth() - s.getUTCMonth();
  const dy = e.getUTCDate() - s.getUTCDate();
  if (unit === 'Y') return dy < 0 ? y - 1 : y;
  if (unit === 'M') return dy < 0 ? y * 12 + mo - 1 : y * 12 + mo;
  if (unit === 'D') return Math.round((_num(a[1], ctx)) - (_num(a[0], ctx)));
  if (unit === 'MD') return dy < 0 ? e.getUTCDate() - serialToDate(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 1, s.getUTCDate()) / DAY_MS) : dy;
  if (unit === 'YM') return (mo - (dy < 0 ? 1 : 0) + 12) % 12;
  if (unit === 'YD') {
    let anchor = new Date(Date.UTC(e.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
    if (anchor > e) anchor = new Date(Date.UTC(e.getUTCFullYear() - 1, s.getUTCMonth(), s.getUTCDate()));
    return Math.round(_num(a[1], ctx) - dateToSerial(anchor));
  }
  return xlerr('#NUM!');
});
defFn('EDATE', 'Date & Time', 'EDATE(start_date, months)', 'Date that is the given number of months before/after.', (a, ctx) => {
  const s = serialToDate(_num(a[0], ctx));
  const m = _int(a[1], ctx);
  return dateToSerial(new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + m, s.getUTCDate())));
});
defFn('EOMONTH', 'Date & Time', 'EOMONTH(start_date, months)', 'Last day of the month after the start date.', (a, ctx) => {
  const s = serialToDate(_num(a[0], ctx));
  const m = _int(a[1], ctx);
  return dateToSerial(new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + m + 1, 0)));
});
defFn('DATEVALUE', 'Date & Time', 'DATEVALUE(date_text)', 'Converts a date string to a serial number.', (a, ctx) => {
  const d = tryParseDateStr(_str(a[0], ctx));
  return d == null ? xlerr('#VALUE!') : Math.floor(d);
});

/* ---- Financial ---- */
defFn('PMT', 'Financial', 'PMT(rate, nper, pv, [fv], [type])', 'Payment for a loan based on constant payments.', (a, ctx) => {
  const r = _num(a[0], ctx), n = _num(a[1], ctx), pv = _num(a[2], ctx);
  const fv = a[3] === undefined ? 0 : _num(a[3], ctx);
  const type = a[4] === undefined ? 0 : _int(a[4], ctx);
  if (n === 0) return xlerr('#DIV/0!');
  let pmt;
  if (r === 0) pmt = -(pv + fv) / n;
  else { const f = Math.pow(1 + r, n); pmt = -(pv * f + fv) * r / ((f - 1) * (1 + r * type)); }
  return pmt;
});
defFn('FV', 'Financial', 'FV(rate, nper, pmt, [pv], [type])', 'Future value of an investment.', (a, ctx) => {
  const r = _num(a[0], ctx), n = _num(a[1], ctx), pmt = _num(a[2], ctx);
  const pv = a[3] === undefined ? 0 : _num(a[3], ctx);
  const type = a[4] === undefined ? 0 : _int(a[4], ctx);
  if (r === 0) return -(pv + pmt * n);
  const f = Math.pow(1 + r, n);
  return -(pv * f + pmt * (1 + r * type) * (f - 1) / r);
});
defFn('PV', 'Financial', 'PV(rate, nper, pmt, [fv], [type])', 'Present value of an investment.', (a, ctx) => {
  const r = _num(a[0], ctx), n = _num(a[1], ctx), pmt = _num(a[2], ctx);
  const fv = a[3] === undefined ? 0 : _num(a[3], ctx);
  const type = a[4] === undefined ? 0 : _int(a[4], ctx);
  if (r === 0) return -(fv + pmt * n);
  const f = Math.pow(1 + r, n);
  return -(fv + pmt * (1 + r * type) * (f - 1) / r) / f;
});
defFn('NPV', 'Financial', 'NPV(rate, value1, ...)', 'Net present value of an investment.', (a, ctx) => {
  const r = _num(a[0], ctx);
  const vals = flatten(a.slice(1), ctx).filter(v => typeof v === 'number');
  let npv = 0;
  vals.forEach((v, i) => { npv += v / Math.pow(1 + r, i + 1); });
  return npv;
});
defFn('IRR', 'Financial', 'IRR(values, [guess])', 'Internal rate of return.', (a, ctx) => {
  const vals = flatten([a[0]], ctx).map(v => toNum(v, ctx));
  if (vals.length < 2) return xlerr('#NUM!');
  let guess = a[1] === undefined ? 0.1 : _num(a[1], ctx);
  const npvAt = r => vals.reduce((s, v, i) => s + v / Math.pow(1 + r, i), 0);
  let r = guess;
  for (let it = 0; it < 60; it++) {
    const f = npvAt(r);
    const d = (npvAt(r + 1e-6) - f) / 1e-6;
    if (Math.abs(d) < 1e-12) break;
    const nr = r - f / d;
    if (!isFinite(nr)) break;
    if (Math.abs(nr - r) < 1e-9) return nr;
    r = nr <= -1 ? (r - 1) / 2 - 1e-6 : nr;
  }
  // bisection fallback
  let lo = -0.9999, hi = 10;
  if (npvAt(lo) * npvAt(hi) > 0) return xlerr('#NUM!');
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2;
    if (npvAt(lo) * npvAt(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
});

/* Sparklines — mini charts drawn inside the cell */
defFn('SPARKLINE', 'Sparkline', 'SPARKLINE(range, [type])', 'Draws a mini chart in the cell from numeric values. Type: "line" (default), "bar", or "winloss".', (a, ctx) => {
  const vals = numbersOf([a[0]], ctx, { text: false, bools: false });
  if (!vals.length) return xlerr('#VALUE!');
  let type = 'line';
  if (a[1] !== undefined) {
    const t = String(_str(a[1], ctx)).toLowerCase();
    if (t.startsWith('b')) type = 'bar';
    else if (t.startsWith('w')) type = 'winloss';
  }
  return { __spark: { values: vals, type } };
});

/* ==========================================================================
 * 7. DATA MODEL — WORKBOOK / SHEETS / CELLS / STYLES / HISTORY / SELECTION
 * ========================================================================== */
let WB = null;

const UI = {};            // DOM refs (populated in boot)
const R = { canvas: null, ctx: null, dpr: 1, w: 0, h: 0, layout: null }; // renderer
const SEL = { ranges: [], active: { r: 0, c: 0 }, activeIdx: 0, sheetId: null };
const VIEW = { zoom: 1, showFormulaBar: true, showHeadings: true, showFormulas: false };
const Clip = { cells: null, cut: null, marquee: null, formats: null, src: null, text: null };   // clipboard state (src = source origin, text = system fingerprint)
const Edit = { active: false, r: 0, c: 0, cursorMode: false, fromFormulaBar: false, refMode: false, origText: '', lastRef: null };
const Mouse = { mode: null, startCell: null, anchor: null, baseSel: null, data: null };
const Hover = { col: -1, row: -1, handle: false, sb: null };   /* header/handle/scrollbar hover highlight */
const FillState = { last: null };
const PaintState = { active: false, sticky: false, style: null, ranges: null };
const DragState = { active: false, from: null, to: null };

/* ---------------- Axis models (row/col sizes with prefix-sum lookup) -------- */
class AxisModel {
  constructor(defSize, max, hardMax) {
    this.def = defSize; this.max = max; this.hardMax = hardMax != null ? hardMax : max;
    this.meta = new Map();      // index -> {size, hidden}
    this._sorted = []; this._prefix = []; this._dirty = true; this._total = 0;
  }
  sizeOf(i) {
    const m = this.meta.get(i);
    if (!m) return this.def;
    if (m.hidden || m.fhidden) return 0;
    return m.size == null ? this.def : m.size;
  }
  visible(i) { const m = this.meta.get(i); return !(m && (m.hidden || m.fhidden)); }
  set(i, patch) {
    const cur = this.meta.get(i) || {};
    const next = Object.assign({}, cur, patch);
    if ((next.size == null || next.size === this.def) && !next.hidden && !next.fhidden) this.meta.delete(i);
    else this.meta.set(i, next);
    this._dirty = true;
  }
  get(i) { return this.meta.get(i) || {}; }
  _rebuild() {
    this._sorted = [...this.meta.keys()].sort((a, b) => a - b);
    this._prefix = new Array(this._sorted.length + 1);
    this._prefix[0] = 0;
    for (let k = 0; k < this._sorted.length; k++) {
      const m = this.meta.get(this._sorted[k]);
      const s = (m.hidden || m.fhidden) ? 0 : (m.size == null ? this.def : m.size);
      this._prefix[k + 1] = this._prefix[k] + s;
    }
    const lastIdx = this._sorted.length ? this._sorted[this._sorted.length - 1] + 1 : 0;
    const cap = Math.max(this.max, lastIdx);   /* meta must never exceed the extent */
    this._total = lastIdx * this.def - (this._sorted.length * this.def) + this._prefix[this._sorted.length] + (cap - lastIdx) * this.def;
    this._dirty = false;
  }
  offsetOf(i) { // content offset of index i (sum sizes of [0..i-1])
    if (this._dirty) this._rebuild();
    let lo = 0, hi = this._sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this._sorted[mid] < i) lo = mid + 1; else hi = mid; }
    return (i - lo) * this.def + this._prefix[lo];
  }
  indexAt(y) { // largest i with offsetOf(i) <= y
    if (this._dirty) this._rebuild();
    let lo = 0, hi = this.max - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsetOf(mid) <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  total() { if (this._dirty) this._rebuild(); return this._total; }
  invalidate() { this._dirty = true; }
  /* extend the materialized extent (autogrow). Never shrinks; caps at hardMax. */
  setMax(n) {
    if (n <= this.max) return false;
    this.max = Math.min(n, this.hardMax);
    this._dirty = true;
    return true;
  }
}

/* ---------------- Sheet helpers ---------------- */
function makeSheet(name, id) {
  return {
    id: id || uid(), name, tabColor: null, hidden: false,
    cells: new Map(),
    notes: new Map(),
    rows: new AxisModel(DEF.rowH, GRID_INIT, MAX_ROWS),
    cols: new AxisModel(DEF.colW, GRID_INIT, MAX_COLS),
    merges: [],
    mergeMap: new Map(),
    freeze: { r: 0, c: 0 },
    charts: [], cf: [], dv: [],
    filter: null, filterHidden: new Set(),
    showGridlines: true,
    usedMax: { r: 0, c: 0 }
  };
}
/* Autogrow: extend the materialized extent so it covers needR rows / needC cols,
   stepping in GRID_STEP chunks and never beyond the hard caps. Cheap no-op when
   the request is already inside the extent (two integer compares). */
function growExtent(sh, needR, needC) {
  if (!sh) return false;
  let changed = false;
  if (needR > sh.rows.max && sh.rows.max < MAX_ROWS) {
    let t = Math.ceil(needR / GRID_STEP) * GRID_STEP;
    if (t < sh.rows.max + GRID_STEP) t = sh.rows.max + GRID_STEP;
    changed = sh.rows.setMax(Math.min(t, MAX_ROWS)) || changed;
  }
  if (needC > sh.cols.max && sh.cols.max < MAX_COLS) {
    let t = Math.ceil(needC / GRID_STEP) * GRID_STEP;
    if (t < sh.cols.max + GRID_STEP) t = sh.cols.max + GRID_STEP;
    changed = sh.cols.setMax(Math.min(t, MAX_COLS)) || changed;
  }
  return changed;
}
function rebuildMergeMap(sh) {
  sh.mergeMap = new Map();
  for (const m of sh.merges) {
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) sh.mergeMap.set(key(r, c), m);
  }
}
function mergeAt(sh, r, c) { return sh.mergeMap.get(key(r, c)) || null; }
function sheetById(id) { return WB.sheets.find(s => s.id === id) || null; }
function sheetByName(name) { const low = name.toLowerCase(); return WB.sheets.find(s => s.name.toLowerCase() === low) || null; }
function sheetIdByName(name) { const s = sheetByName(name); return s ? s.id : null; }
function activeSheet() { return sheetById(WB.activeSheetId) || WB.sheets[0]; }
function getRawCell(sid, r, c) {
  const sh = sheetById(sid);
  if (!sh) return undefined;
  return sh.cells.get(key(r, c));
}
function ensureCell(sh, r, c) {
  const k = key(r, c);
  let cell = sh.cells.get(k);
  if (!cell) { cell = { v: null, f: null, s: null, cv: undefined, ast: undefined }; sh.cells.set(k, cell); }
  return cell;
}
function isCellEmpty(cell) { return cell && cell.v == null && !cell.f && !cell.s; }

function usedRange(sh) {
  let mr = 0, mc = 0;
  for (const [k, cell] of sh.cells) { const [rs, cs] = k.split(','); const r = +rs, c = +cs; if (cell.v != null || cell.f || cell.s) { if (r > mr) mr = r; if (c > mc) mc = c; } }
  for (const m of sh.merges) { if (m.r2 > mr) mr = m.r2; if (m.c2 > mc) mc = m.c2; }
  if (sh.filter) { mr = Math.max(mr, sh.filter.range.r2); mc = Math.max(mc, sh.filter.range.c2); }
  for (const ch of sh.charts) { mr = Math.max(mr, Math.floor((ch.y + ch.h) / DEF.rowH)); mc = Math.max(mc, Math.floor((ch.x + ch.w) / DEF.colW)); }
  return { r1: 0, c1: 0, r2: Math.min(mr, MAX_ROWS - 1), c2: Math.min(mc, MAX_COLS - 1) };
}

/* Central cell mutation. patch: {v, f, s} — undefined fields unchanged; null clears. */
function writeCell(sh, r, c, patch) {
  if (r >= sh.rows.max || c >= sh.cols.max) growExtent(sh, r + 1, c + 1);   /* autogrow */
  const k = key(r, c);
  let cell = sh.cells.get(k);
  const hadFormula = !!(cell && cell.f);
  /* smooth number glide: plain number -> plain number transitions count up/down */
  if (cell && !cell.f && typeof cell.v === 'number' && patch && !patch.f &&
      'v' in patch && typeof patch.v === 'number' && patch.v !== cell.v)
    glideNumber(sh, r, c, cell.v, patch.v, (patch.s && patch.s.numberFormat) || (cell.s && cell.s.numberFormat) || 'General');
  if (patch == null) patch = { v: null, f: null, s: null };
  if (!cell) cell = ensureCell(sh, r, c);
  if ('v' in patch) cell.v = patch.v;
  if ('f' in patch) {
    cell.f = patch.f;
    cell.cv = undefined; cell.ast = undefined;
  }
  if ('s' in patch) cell.s = patch.s;
  if (('f' in patch) && patch.f == null && hadFormula) {
    DepGraph.unregister(depKeyOf(sh.id, r, c));
    Calc.dirty.delete(depKeyOf(sh.id, r, c));
    Calc.volatileKeys.delete(depKeyOf(sh.id, r, c));
  }
  if (isCellEmpty(cell)) {
    /* invalidate self + transitive dependents BEFORE removal — otherwise
       dependents (e.g. =SUM over this cell) keep showing stale cached values */
    markDirty(sh.id, r, c);
    sh.cells.delete(k);
    if (hadFormula) { DepGraph.unregister(depKeyOf(sh.id, r, c)); Calc.dirty.delete(depKeyOf(sh.id, r, c)); Calc.volatileKeys.delete(depKeyOf(sh.id, r, c)); }
  } else if (cell.f) {
    if ('f' in patch) {
      try {
        cell.ast = parseFormula(cell.f);
        const deps = extractDeps(cell.ast);
        DepGraph.register(depKeyOf(sh.id, r, c), sh.id, deps);
        let vol = false; walkAST(cell.ast, n => { if (n.t === 'func' && VOLATILE_FN.has(n.name)) vol = true; });
        if (vol) Calc.volatileKeys.add(depKeyOf(sh.id, r, c)); else Calc.volatileKeys.delete(depKeyOf(sh.id, r, c));
      } catch (e) { cell.ast = null; }
    }
    markDirty(sh.id, r, c);
  } else if ('v' in patch) {
    markDirty(sh.id, r, c);
  }
  if (r > sh.usedMax.r) sh.usedMax.r = r;
  if (c > sh.usedMax.c) sh.usedMax.c = c;
}

function clearCellContent(sh, r, c, what) {
  // what: 'contents' | 'formats' | 'all'
  const cell = sh.cells.get(key(r, c));
  if (!cell) return;
  const patch = {};
  if (what !== 'formats') { patch.v = null; patch.f = null; }
  if (what !== 'contents') patch.s = null;
  writeCell(sh, r, c, patch);
}

/* ---------------- History (undo/redo) ---------------- */
const H = { undo: [], redo: [], limit: 150, batching: null };
function pushHistory(entry) {
  if (H.batching) { H.batching.push(entry); return; }
  H.undo.push(entry);
  if (H.undo.length > H.limit) H.undo.shift();
  H.redo.length = 0;
  updateUndoRedoUI();
  Persistence.markDirty();
}
function batchHistory(fn, label) {
  H.batching = [];
  try { fn(); } finally { const ops = H.batching; H.batching = null; if (ops.length) pushHistory({ label, undo: () => { for (let i = ops.length - 1; i >= 0; i--) ops[i].undo(); }, redo: () => { for (const o of ops) o.redo(); } }); /* no-op operations leave no history entry (desktop-suite parity) */ }
}
function undo() {
  if (Edit.active) commitEditor(true);
  const entry = H.undo.pop();
  if (!entry) { toast('Nothing to undo', 'info'); return; }
  try { entry.undo(); } catch (e) { console.error(e); }
  H.redo.push(entry);
  updateUndoRedoUI();
  Persistence.markDirty();
  repaintAll();
  updateStatusBar();
  updateNameBox();
  updateFormulaBar();
}
function redo() {
  const entry = H.redo.pop();
  if (!entry) { toast('Nothing to redo', 'info'); return; }
  try { entry.redo(); } catch (e) { console.error(e); }
  H.undo.push(entry);
  updateUndoRedoUI();
  Persistence.markDirty();
  repaintAll();
  updateStatusBar();
  updateNameBox();
  updateFormulaBar();
}

/* cell snapshot {v, f, s} helpers for history */
function snapOf(cell) {
  if (!cell) return null;
  return { v: cell.v, f: cell.f, s: cell.s };
}
function histCellChange(sh, r, c, before, after, label) {
  return {
    label: label || 'Edit cell',
    undo() { writeCell(sh, r, c, before || { v: null, f: null, s: null }); },
    redo() { writeCell(sh, r, c, after || { v: null, f: null, s: null }); }
  };
}
function snapshotSheet(sh) {
  const cells = {};
  for (const [k, cell] of sh.cells) {
    cells[k] = { v: cell.v, f: cell.f, s: cell.s ? Object.assign({}, cell.s) : null };
  }
  const rows = {}, cols = {};
  for (const [i, m] of sh.rows.meta) rows[i] = Object.assign({}, m);
  for (const [i, m] of sh.cols.meta) cols[i] = Object.assign({}, m);
  return {
    cells, rows, cols,
    merges: deepClone(sh.merges),
    freeze: Object.assign({}, sh.freeze),
    charts: deepClone(sh.charts), cf: deepClone(sh.cf), dv: deepClone(sh.dv),
    filter: deepClone(sh.filter), showGridlines: sh.showGridlines,
    usedMax: Object.assign({}, sh.usedMax), name: sh.name, tabColor: sh.tabColor,
    notes: sh.notes ? new Map(sh.notes) : new Map()
  };
}
function restoreSheet(sh, snap) {
  sh.cells = new Map();
  let maxR = 0, maxC = 0;
  for (const k in snap.cells) {
    const c = snap.cells[k];
    sh.cells.set(k, { v: c.v, f: c.f, s: c.s ? normStyle(c.s) : null, cv: undefined, ast: undefined });
    const ci = k.indexOf(',');
    const r = +k.slice(0, ci), cc = +k.slice(ci + 1);
    if (r > maxR) maxR = r; if (cc > maxC) maxC = cc;
  }
  sh.rows = new AxisModel(DEF.rowH, GRID_INIT, MAX_ROWS);
  for (const i in snap.rows) { sh.rows.set(+i, snap.rows[i]); if (+i > maxR) maxR = +i; }
  sh.cols = new AxisModel(DEF.colW, GRID_INIT, MAX_COLS);
  for (const i in snap.cols) { sh.cols.set(+i, snap.cols[i]); if (+i > maxC) maxC = +i; }
  growExtent(sh, maxR + 1, maxC + 1);
  const um = snap.usedMax || { r: 0, c: 0 };
  growExtent(sh, um.r + 1, um.c + 1);
  sh.merges = deepClone(snap.merges); rebuildMergeMap(sh);
  sh.freeze = Object.assign({}, snap.freeze);
  sh.charts = deepClone(snap.charts); sh.cf = deepClone(snap.cf); sh.dv = deepClone(snap.dv);
  sh.filter = deepClone(snap.filter); sh.filterHidden = new Set();
  sh.showGridlines = snap.showGridlines;
  sh.usedMax = Object.assign({}, snap.usedMax);
  sh.notes = snap.notes ? new Map(snap.notes) : new Map();
  rebuildAllDeps();
  renderChartsLayer();
  renderFilterChips();
  updateSheetTabBar();
}
function histSheet(sh, label, mutate) {
  const before = snapshotSheet(sh);
  mutate();
  const after = snapshotSheet(sh);
  pushHistory({ label, undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
}

/* ---------------- Selection ---------------- */
function normalizeSelRange(r1, c1, r2, c2) { return normRange(clamp(r1,0,MAX_ROWS-1), clamp(c1,0,MAX_COLS-1), clamp(r2,0,MAX_ROWS-1), clamp(c2,0,MAX_COLS-1)); }
function setSelection(r1, c1, r2, c2, opts = {}) {
  SEL.ranges = [normalizeSelRange(r1, c1, r2, c2)];
  SEL.active = { r: opts.activeR != null ? opts.activeR : r1, c: opts.activeC != null ? opts.activeC : c1 };
  SEL.activeIdx = 0;
  if (!opts.keepScroll) ensureVisible(SEL.active.r, SEL.active.c);
  onSelectionChanged();
}
function addSelectionRange(r1, c1, r2, c2, activeR, activeC) {
  SEL.ranges.push(normalizeSelRange(r1, c1, r2, c2));
  SEL.activeIdx = SEL.ranges.length - 1;
  SEL.active = { r: activeR != null ? activeR : r1, c: activeC != null ? activeC : c1 };
  onSelectionChanged();
}
function activeSelRange() { return SEL.ranges[SEL.activeIdx] || SEL.ranges[0]; }
function selIsSingleCell() {
  const rg = activeSelRange();
  return SEL.ranges.length === 1 && rg.r1 === rg.r2 && rg.c1 === rg.c2;
}
function forEachSelectedCell(cb) {
  const sh = activeSheet();
  const seen = new Set();
  let ur = null;   /* lazily-computed used range — clamps whole-row/column selections */
  for (const rg of SEL.ranges) {
    let r1 = rg.r1, c1 = rg.c1, r2 = rg.r2, c2 = rg.c2;
    if (isRowSelection(rg) || isColSelection(rg)) {
      if (!ur) ur = usedRange(sh);
      if (isRowSelection(rg)) c2 = Math.min(c2, ur.c2);
      if (isColSelection(rg)) r2 = Math.min(r2, ur.r2);
      if (r1 > r2 || c1 > c2) continue;   /* nothing used inside this strip */
    }
    const h = r2 - r1, w = c2 - c1;
    if (h * w > 2e6 && SEL.ranges.length > 1) continue;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const k = key(r, c);
        if (seen.has(k)) continue;
        seen.add(k);
        if (cb(r, c) === false) return;
      }
    }
    if (seen.size > 2e6) return;
  }
}
function isRowSelection(rg) { return rg.c1 === 0 && rg.c2 >= MAX_COLS - 1; }
function isColSelection(rg) { return rg.r1 === 0 && rg.r2 >= MAX_ROWS - 1; }
function selectEntireRow(r, extend) {
  if (extend && SEL.ranges.length) { const rg = SEL.ranges[SEL.activeIdx]; SEL.ranges[SEL.activeIdx] = normalizeSelRange(rg.r1, 0, Math.max(rg.r2, r), MAX_COLS - 1); }
  else SEL.ranges = [normalizeSelRange(r, 0, r, MAX_COLS - 1)];
  SEL.active = { r, c: SEL.active.c };
  onSelectionChanged();
}
function selectEntireCol(c, extend) {
  if (extend && SEL.ranges.length) { const rg = SEL.ranges[SEL.activeIdx]; SEL.ranges[SEL.activeIdx] = normalizeSelRange(0, rg.c1, MAX_ROWS - 1, Math.max(rg.c2, c)); }
  else SEL.ranges = [normalizeSelRange(0, c, MAX_ROWS - 1, c)];
  SEL.active = { r: SEL.active.r, c };
  onSelectionChanged();
}
function selectAll() {
  SEL.ranges = [normalizeSelRange(0, 0, MAX_ROWS - 1, MAX_COLS - 1)];
  SEL.active = { r: 0, c: 0 }; SEL.activeIdx = 0;
  onSelectionChanged();
}
function nextVisibleRow(sh, r, dir) {
  let guard = 0;
  while (!sh.rows.visible(r) && guard++ < 100000) r += dir;
  return clamp(r, 0, MAX_ROWS - 1);
}
function nextVisibleCol(sh, c, dir) {
  let guard = 0;
  while (!sh.cols.visible(c) && guard++ < 100000) c += dir;
  return clamp(c, 0, MAX_COLS - 1);
}
function moveActive(dr, dc, extend) {
  const sh = activeSheet();
  let r = SEL.active.r + dr, c = SEL.active.c + dc;
  if (r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) return;
  r = nextVisibleRow(sh, r, dr || 1); c = nextVisibleCol(sh, c, dc || 1);
  if (extend) {
    const rg = SEL.ranges[SEL.activeIdx];
    SEL.ranges[SEL.activeIdx] = normalizeSelRange(
      Math.min(rg.r1, r) === rg.r1 && rg.r1 !== r ? r : rg.r1, // extend logic handled below
      rg.c1, rg.r2, rg.c2);
    // proper extension
    let r1 = rg.r1, c1 = rg.c1, r2 = rg.r2, c2 = rg.c2;
    const ar = SEL.active.r, ac = SEL.active.c;
    r1 = Math.min(ar, r); r2 = Math.max(ar, r);
    c1 = Math.min(ac, c); c2 = Math.max(ac, c);
    SEL.ranges[SEL.activeIdx] = normalizeSelRange(r1, c1, r2, c2);
    SEL.active = { r, c };
  } else {
    SEL.ranges = [normalizeSelRange(r, c, r, c)];
    SEL.active = { r, c }; SEL.activeIdx = 0;
  }
  ensureVisible(r, c);
  onSelectionChanged();
}
function jumpTo(r, c, extend) {
  moveActive(r - SEL.active.r, c - SEL.active.c, extend);
}
let LastSelRange = null;   /* previous active range — drives the selection glide animation */
function onSelectionChanged() {
  const shNow = activeSheet();
  const curRg = SEL.sheetId === shNow.id ? activeSelRange() : null;
  const cur = curRg ? { r1: curRg.r1, c1: curRg.c1, r2: curRg.r2, c2: curRg.c2 } : null;
  const prev = LastSelRange;
  LastSelRange = cur;
  if (SelAnim.pending) {
    SelAnim.pending = false;
    if (cur && prev) beginSelAnim(prev, cur);
  }
  updateNameBox();
  updateFormulaBar();
  updateStatusBar();
  updateRibbonState();
  updateDvChips();
  requestPaint();
}

/* Scroll so that cell (r, c) is visible, accounting for frozen panes. */
function ensureVisible(r, c, opts) {
  const sh = activeSheet();
  const L = R.layout;
  if (!L) return;
  if (r < MAX_ROWS && c < MAX_COLS) growExtent(sh, r + 2, c + 2);   /* autogrow before jumping */
  const zm = VIEW.zoom;
  const rowH = sh.rows, cols = sh.cols;
  const frzH = sh.freeze.r ? sumFrozen(rowH, sh.freeze.r) : 0;
  const frzW = sh.freeze.c ? sumFrozen(cols, sh.freeze.c) : 0;
  const viewH = L.gridH - (L.scrollbarVisibleV ? L.sb : 0);
  const viewW = L.gridW - (L.scrollbarVisibleH ? L.sb : 0);
  const y0 = rowH.offsetOf(r), y1 = rowH.offsetOf(r + 1);
  const x0 = cols.offsetOf(c), x1 = cols.offsetOf(c + 1);
  const visTop = Scroll.y + frzH, visBot = Scroll.y + viewH;
  const visLeft = Scroll.x + frzW, visRight = Scroll.x + viewW;
  let tX = Scroll.x, tY = Scroll.y, moved = false;
  if (y0 < visTop) { tY = Math.max(0, y0 - frzH); moved = true; }
  else if (y1 > visBot) { tY = y1 - viewH; moved = true; }
  if (x0 < visLeft) { tX = Math.max(0, x0 - frzW); moved = true; }
  else if (x1 > visRight) { tX = x1 - viewW; moved = true; }
  if (moved && opts && opts.smooth) { smoothScrollTo(tX, tY); sbActivity(); return; }
  Scroll.x = tX; Scroll.y = tY;
  if (moved) sbActivity();
  cancelSmoothScroll();
  clampScroll();
  scheduleScrollUI();
}
function sumFrozen(axis, n) { let s = 0; for (let i = 0; i < n; i++) s += axis.sizeOf(i); return s; }

/* ---------------- View / Scroll ---------------- */
const Scroll = { x: 0, y: 0 };
function clampScroll() {
  const L = R.layout;
  if (!L) return;
  const sh = activeSheet();
  const frzH = sh.freeze.r ? sumFrozen(sh.rows, sh.freeze.r) : 0;
  const frzW = sh.freeze.c ? sumFrozen(sh.cols, sh.freeze.c) : 0;
  /* autogrow: the viewport is pushing past the materialized edge → extend by one step.
     The clamp below then lets the scroll continue into the new space seamlessly. */
  let maxH = sh.rows.total(), maxW = sh.cols.total();
  if (Scroll.y > maxH - L.gridH && sh.rows.max < MAX_ROWS) { growExtent(sh, sh.rows.max + GRID_STEP, 0); maxH = sh.rows.total(); }
  if (Scroll.x > maxW - L.gridW && sh.cols.max < MAX_COLS) { growExtent(sh, 0, sh.cols.max + GRID_STEP); maxW = sh.cols.total(); }
  Scroll.y = clamp(Scroll.y, 0, Math.max(0, maxH - frzH - L.gridH + frzH));
  Scroll.x = clamp(Scroll.x, 0, Math.max(0, maxW - frzW - L.gridW + frzW));
}
function scheduleScrollUI() { /* placeholder — replaced by renderer */ }

/* ---------------- Input parsing (cell entry) ---------------- */
function tryParseDateStr(s) {
  if (!s || typeof s !== 'string') return null;
  s = s.trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) {
    const [, y, mo, d, h, mi, se] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(se || 0)));
    if (dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
    return dateToSerial(dt);
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    let [, mo, d, y] = m; y = +y; if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, +mo - 1, +d));
    if (dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
    return dateToSerial(dt);
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(s))) {
    const y = new Date().getUTCFullYear();
    const dt = new Date(Date.UTC(y, +m[1] - 1, +m[2]));
    if (dt.getUTCMonth() !== +m[1] - 1 || dt.getUTCDate() !== +m[2]) return null;
    return dateToSerial(dt);
  }
  if ((m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(\d{4})$/.exec(s))) {
    const mi = MONTH_NAMES.findIndex(x => x.toLowerCase().startsWith(m[1].toLowerCase()));
    if (mi === -1) return null;
    const dt = new Date(Date.UTC(+m[3], mi, +m[2]));
    if (dt.getUTCDate() !== +m[2]) return null;
    return dateToSerial(dt);
  }
  if ((m = /^(\d{1,2})-([A-Za-z]{3,9})-(\d{2,4})$/.exec(s))) {
    const mi = MONTH_NAMES.findIndex(x => x.toLowerCase().startsWith(m[2].toLowerCase()));
    if (mi === -1) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mi, +m[1]));
    if (dt.getUTCDate() !== +m[1]) return null;
    return dateToSerial(dt);
  }
  return null;
}
function parseUserInput(text) {
  const t = text;
  if (t === '') return { v: null };
  if (t[0] === '=') return { f: t };
  if (/^[+-](?![0-9(])/.test(t)) return { f: '=' + t };
  const up = t.trim().toUpperCase();
  if (up === 'TRUE') return { v: true };
  if (up === 'FALSE') return { v: false };
  const trimmed = t.trim();
  if (/^-?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed) && /\d/.test(trimmed)) return { v: Number(trimmed.replace(/,/g, '')) };
  if (/^-?\d+(\.\d+)?%$/.test(trimmed)) return { v: Number(trimmed.slice(0, -1)) / 100, s: { numberFormat: '0' + (trimmed.includes('.') ? '.00' : '') + '%', numFmtCat: 'percent' } };
  if (/^\$\s?-?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?$/.test(trimmed)) return { v: Number(trimmed.replace(/[$,\s]/g, '')), s: { numberFormat: NUMCAT.currency(2), numFmtCat: 'currency' } };
  const d = tryParseDateStr(trimmed);
  if (d != null) return { v: d, s: { numberFormat: NUMCAT.shortDate, numFmtCat: 'shortDate' } };
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(trimmed);
  if (tm) {
    let h = +tm[1]; const mi = +tm[2], se = tm[3] ? +tm[3] : 0;
    const pm = tm[4] && /pm/i.test(tm[4]);
    if (pm && h < 12) h += 12;
    if (/am/i.test(tm[4] || '') && h === 12) h = 0;
    if (h >= 0 && h < 24 && mi < 60 && se < 60) return { v: (h * 3600 + mi * 60 + se) / 86400, s: { numberFormat: se ? 'h:mm:ss AM/PM' : 'h:mm AM/PM', numFmtCat: 'time' } };
  }
  return { v: t };
}

/* ---------------- Persistence manager ---------------- */
const Persistence = {
  timer: 0, state: 'saved', docId: null,
  markDirty() {
    if (!WB) return;
    this.state = 'dirty';
    updateSaveStatus();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 900);
  },
  async flush() {
    if (!WB) return;
    clearTimeout(this.timer);
    if (this.state === 'saving') return;
    if (WB._persist === false) { this.state = 'saved'; updateSaveStatus(); return; }
    this.state = 'saving';
    updateSaveStatus();
    try {
      const data = serializeWorkbook();
      await IO.saveDoc(WB.id, { id: WB.id, data, savedAt: nowTs() });
      this.state = 'saved';
      WB.savedAt = nowTs();
      updateSaveStatus();
    } catch (e) {
      console.error('Save failed', e);
      this.state = 'error';
      updateSaveStatus();
      toast('Could not save to browser storage: ' + e.message, 'error');
    }
  },
  setDocId(id) { this.docId = id; IO.saveRecent(id); }
};

function updateSaveStatus() {
  const btn = $('#saveIndicator') || $('#save-status');
  if (!btn) return;
  const txt = btn.querySelector('.save-text') || btn;
  const st = Persistence.state;
  btn.classList.remove('saving', 'saved', 'dirty', 'error');
  if (st === 'saving' || st === 'dirty') { txt.textContent = 'Saving…'; btn.classList.add('saving'); }
  else if (st === 'error') { txt.textContent = 'Save failed'; btn.classList.add('error'); }
  else { txt.textContent = 'All changes saved'; btn.classList.add('saved'); }
}

/* ---------------- (De)serialization ---------------- */
function serializeSheet(sh) {
  const cells = {};
  for (const [k, cell] of sh.cells) {
    if (isCellEmpty(cell)) continue;
    cells[k] = { v: cell.v === undefined ? null : cell.v, f: cell.f, s: cell.s ? Object.assign({}, cell.s) : null };
  }
  const rows = {}, cols = {};
  for (const [i, m] of sh.rows.meta) if (m.size != null || m.hidden || m.fhidden) rows[i] = { s: m.size, h: m.hidden ? 1 : 0, fh: m.fhidden ? 1 : 0 };
  for (const [i, m] of sh.cols.meta) if (m.size != null || m.hidden || m.fhidden) cols[i] = { s: m.size, h: m.hidden ? 1 : 0, fh: m.fhidden ? 1 : 0 };
  return {
    id: sh.id, name: sh.name, tabColor: sh.tabColor, hidden: !!sh.hidden,
    cells, rows, cols,
    merges: sh.merges.map(m => [m.r1, m.c1, m.r2, m.c2]),
    notes: [...sh.notes.entries()].map(([k, n]) => [k, { t: n.text, a: n.author, ts: n.ts, r: noteReplies(n) }]),
    freeze: sh.freeze, charts: sh.charts, cf: sh.cf, dv: sh.dv,
    filter: sh.filter, showGridlines: sh.showGridlines
  };
}
function deserializeSheet(d) {
  const sh = makeSheet(d.name, d.id);
  sh.tabColor = d.tabColor || null;
  sh.hidden = !!d.hidden;
  let maxR = 0, maxC = 0;   /* used range (from stored cells) */
  for (const k in d.cells) {
    const c = d.cells[k];
    sh.cells.set(k, { v: c.v === undefined ? null : c.v, f: c.f || null, s: c.s ? normStyle(c.s) : null, cv: undefined, ast: undefined });
    const ci = k.indexOf(',');
    const r = +k.slice(0, ci), cc = +k.slice(ci + 1);
    if (r > maxR) maxR = r; if (cc > maxC) maxC = cc;
  }
  let extR = maxR, extC = maxC;
  for (const i in d.rows) { const m = d.rows[i]; sh.rows.set(+i, { size: m.s, hidden: !!m.h, fhidden: !!m.fh }); if (+i > extR) extR = +i; }
  for (const i in d.cols) { const m = d.cols[i]; sh.cols.set(+i, { size: m.s, hidden: !!m.h, fhidden: !!m.fh }); if (+i > extC) extC = +i; }
  sh.merges = (d.merges || []).map(a => ({ r1: a[0], c1: a[1], r2: a[2], c2: a[3] }));
  for (const m of sh.merges) { if (m.r2 > extR) extR = m.r2; if (m.c2 > extC) extC = m.c2; }
  rebuildMergeMap(sh);
  sh.freeze = d.freeze || { r: 0, c: 0 };
  sh.charts = d.charts || []; sh.cf = d.cf || []; sh.dv = d.dv || [];
  sh.filter = d.filter || null;
  if (sh.filter && sh.filter.range) { if (sh.filter.range.r2 > extR) extR = sh.filter.range.r2; if (sh.filter.range.c2 > extC) extC = sh.filter.range.c2; }
  sh.filterHidden = new Set();
  sh.showGridlines = d.showGridlines !== false;
  sh.notes = new Map();
  for (const entry of (d.notes || [])) { if (entry && entry[0]) sh.notes.set(entry[0], { text: String(entry[1].t || ''), author: entry[1].a || '', ts: entry[1].ts || null, replies: Array.isArray(entry[1].r) ? entry[1].r.map(rp => ({ a: String(rp.a || 'Me'), t: String(rp.t || ''), ts: rp.ts || null })) : [] }); }
  /* autogrow: re-materialize the extent around the loaded content, then restore usedMax */
  growExtent(sh, extR + 1, extC + 1);
  sh.usedMax = { r: maxR, c: maxC };
  return sh;
}
function serializeWorkbook() {
  return {
    v: 1, id: WB.id, title: WB.title, createdAt: WB.createdAt,
    sheets: WB.sheets.map(serializeSheet),
    activeSheetId: WB.activeSheetId,
    names: WB.names,
    calcMode: Calc.mode,
    view: { zoom: VIEW.zoom, showFormulaBar: VIEW.showFormulaBar, showHeadings: VIEW.showHeadings, showFormulas: VIEW.showFormulas }
  };
}
function deserializeWorkbook(d) {
  WB = {
    id: d.id || uid(), title: d.title || 'Untitled workbook',
    createdAt: d.createdAt || nowTs(), savedAt: d.savedAt || null,
    sheets: (d.sheets && d.sheets.length ? d.sheets : [serializeSheet(makeSheet('Sheet1'))]).map(deserializeSheet),
    activeSheetId: null,
    names: d.names || {}
  };
  Calc.mode = d.calcMode === 'manual' ? 'manual' : 'auto';
  const v = d.view || {};
  VIEW.zoom = clamp(v.zoom || 1, 0.1, 4);
  VIEW.showFormulaBar = v.showFormulaBar !== false;
  VIEW.showHeadings = v.showHeadings !== false;
  VIEW.showFormulas = !!v.showFormulas;
  const act = WB.sheets.find(s => s.id === d.activeSheetId) || WB.sheets.find(s => !s.hidden) || WB.sheets[0];
  WB.activeSheetId = act.id;
  return WB;
}

function generateSecureId(length) {
  const arr = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}
function newWorkbookId() { return 'book_' + Date.now() + '_' + generateSecureId(9); }
function newWorkbookData(title) {
  return { id: newWorkbookId(), title: title || 'Untitled workbook', createdAt: nowTs(), sheets: null, activeSheetId: null, names: {}, calcMode: 'auto', view: {} };
}

async function loadLastOrNew() {
  let lastId = null;
  try { lastId = await IO.loadRecent(); } catch (e) {}
  if (lastId) {
    try {
      const doc = await IO.loadDoc(lastId);
      if (doc && doc.data) { deserializeWorkbook(Object.assign({ savedAt: doc.savedAt }, doc.data)); Persistence.setDocId(WB.id); return true; }
    } catch (e) { console.warn('restore failed', e); }
  }
  deserializeWorkbook(newWorkbookData());
  WB._persist = false;
  Persistence.setDocId(WB.id);
  return false;
}

/* ==========================================================================
 * 8. VIRTUALIZED CANVAS GRID RENDERER + GEOMETRY + SCROLLBARS
 * ========================================================================== */
R.canvas = null; R.ctx = null; R.dpr = Math.max(1, window.devicePixelRatio || 1);

function computeLayout() {
  const w = R.canvas.clientWidth || R.canvas.parentElement.clientWidth;
  const h = R.canvas.clientHeight || R.canvas.parentElement.clientHeight;
  const zm = VIEW.zoom;
  const sh = activeSheet();
  const lastRow = Math.min(MAX_ROWS - 1, Math.max(sh.usedMax.r, Math.floor((Scroll.y + h / zm) / DEF.rowH) + Math.ceil(h / zm / DEF.rowH)));
  const digits = String(lastRow + 1).length;
  const hdrW = VIEW.showHeadings ? clamp(16 + digits * 8, 46, 86) : 0;
  const hdrH = VIEW.showHeadings ? Math.round(DEF.headerH * zm) : 0;
  const sb = 12;
  const frzC = sh.freeze.c | 0, frzR = sh.freeze.r | 0;
  const frzW = frzC ? sumFrozen(sh.cols, frzC) * zm : 0;
  const frzH = frzR ? sumFrozen(sh.rows, frzR) * zm : 0;
  const gridW = w - hdrW, gridH = h - hdrH;
  const visibleUnzoomedW = (gridW - frzW) / zm;
  const visibleUnzoomedH = (gridH - frzH) / zm;
  /* autogrow fallback: if the materialized grid is smaller than the viewport (huge
     monitor, deep zoom-out), extend until it fills so scrolling can always start */
  if (sh.rows.total() - frzH / zm <= visibleUnzoomedH + 0.5 && sh.rows.max < MAX_ROWS) growExtent(sh, sh.rows.max + GRID_STEP, 0);
  if (sh.cols.total() - frzW / zm <= visibleUnzoomedW + 0.5 && sh.cols.max < MAX_COLS) growExtent(sh, 0, sh.cols.max + GRID_STEP);
  const totalW = sh.cols.total();
  const totalH = sh.rows.total();
  const L = {
    w, h, zoom: zm, hdrW, hdrH, gridX: hdrW, gridY: hdrH, gridW, gridH, sb,
    frzC, frzR, frzW, frzH,
    scrollVisibleH: totalW - frzW > visibleUnzoomedW + 0.5,
    scrollVisibleV: totalH - frzH > visibleUnzoomedH + 0.5
  };
  R.layout = L;
  return L;
}

/* screen coordinates (css px) for cell index — frozen aware */
function colScreenX(sh, c) {
  const L = R.layout;
  const off = sh.cols.offsetOf(c);
  if (c < L.frzC) return L.gridX + off * L.zoom;
  return L.gridX + L.frzW + (off - sumFrozen(sh.cols, L.frzC) - Scroll.x) * L.zoom;
}
function rowScreenY(sh, r) {
  const L = R.layout;
  const off = sh.rows.offsetOf(r);
  if (r < L.frzR) return L.gridY + off * L.zoom;
  return L.gridY + L.frzH + (off - sumFrozen(sh.rows, L.frzR) - Scroll.y) * L.zoom;
}
function colScreenW(sh, c) { return sh.cols.sizeOf(c) * R.layout.zoom; }
function rowScreenH(sh, r) { return sh.rows.sizeOf(r) * R.layout.zoom; }
function cellScreenRect(sh, r, c) {
  const m = mergeAt(sh, r, c);
  let x = colScreenX(sh, c), y = rowScreenY(sh, r), w = colScreenW(sh, c), h = rowScreenH(sh, r);
  if (m && m.r1 === r && m.c1 === c) {
    x = colScreenX(sh, m.c1); y = rowScreenY(sh, m.r1);
    w = (sh.cols.offsetOf(m.c2 + 1) - sh.cols.offsetOf(m.c1)) * R.layout.zoom;
    h = (sh.rows.offsetOf(m.r2 + 1) - sh.rows.offsetOf(m.r1)) * R.layout.zoom;
  }
  return { x, y, w, h };
}
/* inverse mapping: css px → cell */
function pointToCellPx(x, y) {
  const sh = activeSheet();
  const L = R.layout;
  if (x < L.gridX || y < L.gridY) return null;
  let r, c;
  const frzRight = L.gridX + L.frzW, frzBottom = L.gridY + L.frzH;
  if (x < frzRight) c = sh.cols.indexAt((x - L.gridX) / L.zoom);
  else {
    const unz = (x - frzRight) / L.zoom + sumFrozen(sh.cols, L.frzC) + Scroll.x;
    c = sh.cols.indexAt(unz);
  }
  if (y < frzBottom) r = sh.rows.indexAt((y - L.gridY) / L.zoom);
  else {
    const unz = (y - frzBottom) / L.zoom + sumFrozen(sh.rows, L.frzR) + Scroll.y;
    r = sh.rows.indexAt(unz);
  }
  return { r: clamp(r, 0, MAX_ROWS - 1), c: clamp(c, 0, MAX_COLS - 1) };
}
function hitTest(x, y) {
  const L = R.layout;
  const out = { zone: 'none', x, y };
  if (x < L.gridX && y < L.gridY) { out.zone = 'corner'; return out; }
  if (y < L.gridY) { out.zone = 'colhdr'; const pc = pointToCellPx(Math.max(x, L.gridX + 0.01), y + L.gridY); out.c = pc ? pc.c : 0; out.px = x; return out; }
  if (x < L.gridX) { out.zone = 'rowhdr'; const pr = pointToCellPx(x + L.gridX, Math.max(y, L.gridY + 0.01)); out.r = pr ? pr.r : 0; out.py = y; return out; }
  // scrollbars
  const sbx0 = L.w - L.sb, sby0 = L.h - L.sb;
  if (L.scrollVisibleV && x >= sbx0 && y >= L.gridY) { out.zone = 'vscroll'; out.py = y; return out; }
  if (L.scrollVisibleH && y >= sby0 && x >= L.gridX) { out.zone = 'hscroll'; out.px = x; return out; }
  const pc = pointToCellPx(x, y);
  if (!pc) return out;
  out.zone = 'grid'; out.r = pc.r; out.c = pc.c;
  // edge detection for resizing (headers only) and selection border proximity (grid)
  const sh = activeSheet();
  if (y < L.gridY) {}
  // for grid: detect near selection border for drag-move
  return out;
}
function hitHeaderEdge(x, y) {
  // returns {kind:'col'|'row', index, position} when near a resize boundary in headers
  const L = R.layout;
  const sh = activeSheet();
  const tol = 4;
  if (y < L.gridY && x >= L.gridX) {
    const pc = pointToCellPx(x, y + L.gridY + 0.01);
    if (!pc) return null;
    const rx = colScreenX(sh, pc.c), rw = colScreenW(sh, pc.c);
    if (Math.abs(rx + rw - x) <= tol) return { kind: 'col', index: pc.c };
    if (Math.abs(rx - x) <= tol && pc.c > 0) return { kind: 'col', index: pc.c - 1 };
    return null;
  }
  if (x < L.gridX && y >= L.gridY) {
    const pr = pointToCellPx(x + L.gridX + 0.01, y);
    if (!pr) return null;
    const ry = rowScreenY(sh, pr.r), rh = rowScreenH(sh, pr.r);
    if (Math.abs(ry + rh - y) <= tol) return { kind: 'row', index: pr.r };
    if (Math.abs(ry - y) <= tol && pr.r > 0) return { kind: 'row', index: pr.r - 1 };
    return null;
  }
  return null;
}

let paintQueued = false;
function requestPaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; try { paint(); } catch (e) { console.error('paint error', e); } });
}
function repaintAll() { requestPaint(); renderFilterChips(); updateDvChips(); renderChartsLayer(); }

/* ---------------- cell display value ---------------- */
function displayValue(sh, r, c) {
  const cell = sh.cells.get(key(r, c));
  if (!cell) return { text: '', v: null, isNum: false, isErr: false, isBool: false, style: EMPTY_STYLE };
  const style = cell.s || EMPTY_STYLE;
  let v;
  if (cell.f) v = VIEW.showFormulas ? cell.f : getComputedCell(sh.id, r, c);
  else v = cell.v;
  if (cell.f && VIEW.showFormulas) return { text: cell.f, v, isNum: false, isErr: false, isBool: false, style };
  if (v && typeof v === 'object' && v.__spark) return { text: '', v, isNum: false, isErr: false, isBool: false, style, spark: v.__spark };
  if (isRange(v)) v = intersectScalar(v, { sid: sh.id, r, c });   /* bare range formula -> implicit intersection */
  if (v && typeof v === 'object' && v.__spark) return { text: '', v, isNum: false, isErr: false, isBool: false, style, spark: v.__spark };
  if (v == null || v === '') return { text: '', v: null, isNum: false, isErr: false, isBool: false, style };
  if (isErr(v)) return { text: v.err, v, isNum: false, isErr: true, isBool: false, style };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', v, isNum: false, isErr: false, isBool: true, style };
  if (typeof v === 'number') return { text: formatValue(v, style.numberFormat || 'General'), v, isNum: true, isErr: false, isBool: false, style };
  return { text: String(v), v, isNum: false, isErr: false, isBool: false, style };
}

/* conditional formatting application for a cell */
function cfForCell(sh, r, c, cache) {
  if (!sh.cf.length) return null;
  let out = null;
  for (const rule of sh.cf) {
    const rg = rule.range;
    if (r < rg.r1 || r > rg.r2 || c < rg.c1 || c > rg.c2) continue;
    const cell = sh.cells.get(key(r, c));
    let v = cell ? (cell.f ? getComputedCell(sh.id, r, c) : cell.v) : null;
    if (isErr(v)) continue;
    const highlight = () => { out = Object.assign(out || {}, { backgroundColor: rule.color, color: rule.fontColor || null }); };
    if (rule.type === 'greaterThan' || rule.type === 'lessThan' || rule.type === 'equalTo') {
      if (v == null || typeof v !== 'number') continue;
      const ok = rule.type === 'greaterThan' ? v > rule.value : rule.type === 'lessThan' ? v < rule.value : v === rule.value;
      if (ok) highlight();
    } else if (rule.type === 'greaterThanOrEqual' || rule.type === 'lessThanOrEqual') {
      if (v == null || typeof v !== 'number') continue;
      const ok = rule.type === 'greaterThanOrEqual' ? v >= rule.value : v <= rule.value;
      if (ok) highlight();
    } else if (rule.type === 'notEqualTo') {
      if (v == null) continue;
      let ok;
      if (typeof rule.value === 'number') ok = !(typeof v === 'number' && v === rule.value);
      else ok = String(typeof v === 'string' ? v : generalNum(v)).toLowerCase() !== String(rule.value).toLowerCase();
      if (ok) highlight();
    } else if (rule.type === 'between') {
      if (v == null || typeof v !== 'number') continue;
      if (v >= Math.min(rule.value, rule.value2) && v <= Math.max(rule.value, rule.value2)) highlight();
    } else if (rule.type === 'contains') {
      if (v == null) continue;
      if (String(typeof v === 'string' ? v : generalNum(v)).toLowerCase().includes(String(rule.value).toLowerCase())) highlight();
    } else if (rule.type === 'beginsWith' || rule.type === 'endsWith') {
      if (v == null) continue;
      const s = String(typeof v === 'string' ? v : generalNum(v)).toLowerCase();
      const q = String(rule.value == null ? '' : rule.value).toLowerCase();
      const ok = rule.type === 'beginsWith' ? s.startsWith(q) : s.endsWith(q);
      if (ok) highlight();
    } else if (rule.type === 'expression') {
      /* relative formula evaluated per cell (refs shift from the rule base cell) */
      if (!rule.expr) continue;
      const base = rule.base || { r: rg.r1, c: rg.c1 };
      const src = shiftFormulaRefs(rule.expr[0] === '=' ? rule.expr : '=' + rule.expr, r - base.r, c - base.c);
      const res = evalFormulaText(src, sh.id, r, c);
      if (!isErr(res) && toBool(res)) highlight();
    } else if (rule.type === 'aboveAverage' || rule.type === 'belowAverage') {
      if (v == null || typeof v !== 'number') continue;
      const st = cache.get(rule.id);
      if (!st) continue;
      if (rule.type === 'aboveAverage' ? v > st.avg : v < st.avg) highlight();
    } else if (rule.type === 'top10' || rule.type === 'top10Percent' || rule.type === 'bottom10' || rule.type === 'bottom10Percent') {
      if (v == null || typeof v !== 'number') continue;
      const st = cache.get(rule.id);
      if (!st) continue;
      const isTop = rule.type === 'top10' || rule.type === 'top10Percent';
      if (isTop ? v >= st.threshold : v <= st.threshold) highlight();
    } else if (rule.type === 'unique' || rule.type === 'duplicates') {
      if (v == null) continue;
      const st = cache.get(rule.id);
      if (!st) continue;
      const kk = typeof v === 'number' ? 'n:' + v : 's:' + String(v).toLowerCase();
      const cnt = st.counts.get(kk) || 0;
      if (rule.type === 'unique' ? cnt === 1 : cnt > 1) highlight();
    } else if (rule.type === 'colorScale2' || rule.type === 'colorScale3') {
      if (v == null || typeof v !== 'number') continue;
      const st = cache.get(rule.id);
      if (!st) continue;
      const t = st.max === st.min ? 0.5 : clamp((v - st.min) / (st.max - st.min), 0, 1);
      const col = t <= 0.5 || !rule.colorMid
        ? lerpColor(rule.colorMin, rule.colorMid || rule.colorMax, rule.colorMid ? t : t)
        : lerpColor(rule.colorMid, rule.colorMax, (t - 0.5) * 2);
      out = Object.assign(out || {}, { backgroundColor: col });
    } else if (rule.type === 'dataBar') {
      if (v == null || typeof v !== 'number') continue;
      const st = cache.get(rule.id);
      if (!st) continue;
      const t = st.max === st.min ? 1 : clamp((v - st.min) / (st.max - st.min), 0, 1);
      out = Object.assign(out || {}, { dataBar: { t, color: rule.color } });
    } else if (rule.type === 'iconSet') {
      if (v == null || typeof v !== 'number') continue;
      const st = cache.get(rule.id);
      if (!st) continue;
      /* 3-icon bucketing on the value span (percent thresholds 33/67 of min..max) */
      const span = st.max - st.min;
      const bucket = span <= 0 ? 2 : v < st.min + span / 3 ? 0 : v < st.min + (span * 2) / 3 ? 1 : 2;
      out = Object.assign(out || {}, { iconSet: { kind: rule.icons || 'arrows3', bucket } });
    } else if (rule.type === 'banded') {
      if ((r - rg.r1) % 2 === 1) out = Object.assign(out || {}, { backgroundColor: rule.color });
    }
  }
  return out;
}
function lerpColor(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  return 'rgb(' + Math.round(pa[0] + (pb[0] - pa[0]) * t) + ',' + Math.round(pa[1] + (pb[1] - pa[1]) * t) + ',' + Math.round(pa[2] + (pb[2] - pa[2]) * t) + ')';
}
function hexToRgb(h) {
  h = (h || '#ffffff').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
/* scan the (capped) rule range, invoking cb(value) for each existing cell */
function cfScanRange(sh, rg, cb) {
  const rEnd = Math.min(rg.r2, rg.r1 + 50000), cEnd = Math.min(rg.c2, rg.c1 + 500);
  for (let r = rg.r1; r <= rEnd; r++) for (let c = rg.c1; c <= cEnd; c++) {
    const cell = sh.cells.get(key(r, c));
    if (!cell) continue;
    cb(cell.f ? getComputedCell(sh.id, r, c) : cell.v);
  }
}
function computeCfStats(sh, cache) {
  for (const rule of sh.cf) {
    const rg = rule.range;
    if (rule.type === 'colorScale2' || rule.type === 'colorScale3' || rule.type === 'dataBar' || rule.type === 'iconSet') {
      let min = Infinity, max = -Infinity, cnt = 0;
      cfScanRange(sh, rg, v => {
        if (typeof v !== 'number') return;
        if (v < min) min = v; if (v > max) max = v; cnt++;
      });
      if (!cnt) { min = 0; max = 1; }
      cache.set(rule.id, { min, max });
    } else if (rule.type === 'aboveAverage' || rule.type === 'belowAverage') {
      let sum = 0, cnt = 0;
      cfScanRange(sh, rg, v => { if (typeof v === 'number') { sum += v; cnt++; } });
      cache.set(rule.id, { avg: cnt ? sum / cnt : 0 });
    } else if (rule.type === 'top10' || rule.type === 'top10Percent' || rule.type === 'bottom10' || rule.type === 'bottom10Percent') {
      const nums = [];
      cfScanRange(sh, rg, v => { if (typeof v === 'number') nums.push(v); });
      if (!nums.length) { cache.set(rule.id, { threshold: 0 }); continue; }
      const want = Number(rule.value) || 10;
      const n = rule.type === 'top10Percent' || rule.type === 'bottom10Percent'
        ? Math.max(1, Math.ceil(nums.length * want / 100))
        : Math.max(1, Math.min(nums.length, Math.trunc(want)));
      nums.sort((a, b) => b - a);
      cache.set(rule.id, { threshold: (rule.type === 'top10' || rule.type === 'top10Percent') ? nums[Math.min(n, nums.length) - 1] : nums[nums.length - Math.min(n, nums.length)] });
    } else if (rule.type === 'unique' || rule.type === 'duplicates') {
      const counts = new Map();
      cfScanRange(sh, rg, v => {
        if (v == null) return;
        const kk = typeof v === 'number' ? 'n:' + v : 's:' + String(v).toLowerCase();
        counts.set(kk, (counts.get(kk) || 0) + 1);
      });
      cache.set(rule.id, { counts });
    }
  }
}

/* borders: strongest side wins between neighbours */
const BORDER_W = { thin: 1, medium: 2, thick: 3, double: 3 };
function drawBorderSide(ctx, x1, y1, x2, y2, b, zoom) {
  ctx.strokeStyle = b.color || '#333';
  ctx.lineWidth = Math.max(1, Math.round(BORDER_W[b.style || 'thin'] * Math.min(zoom, 1.4)));
  ctx.setLineDash([]);
  if ((b.style || 'thin') === 'double') {
    const horiz = y1 === y2;
    const o = Math.max(1.5, 1.5 * zoom);
    ctx.beginPath();
    if (horiz) { ctx.moveTo(x1, y1 - o); ctx.lineTo(x2, y2 - o); ctx.moveTo(x1, y1 + o); ctx.lineTo(x2, y2 + o); }
    else { ctx.moveTo(x1 - o, y1); ctx.lineTo(x2 - o, y2); ctx.moveTo(x1 + o, y1); ctx.lineTo(x2 + o, y2); }
    ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
}
function sideStrength(b) { return b ? (BORDER_W[b.style || 'thin'] || 1) : 0; }

/* drag ghost: one unified indicator for every canvas drag gesture (move / fill / paint).
   The target box GLIDES after the cursor (time-based exponential easing, frame-rate independent),
   fades in when the gesture starts (~130 ms) and fades out after release (~190 ms), and is drawn
   as an animated GREEN DOTTED outline (marching round dots) with a soft glow + tint. */
const DRAG_DOT = '#2f9e63';                       /* vivid spreadsheet green for drag indicators */
const DRAG_GLOW = a => 'rgba(47,158,99,' + a + ')';
const DragGhost = { kind: null, rect: null, alpha: 0, last: 0, raf: 0 };
function dragGhostStep() { DragGhost.raf = 0; requestPaint(); }
function stepDragGhost(tx, ty, tw, th, active, now) {
  const g = DragGhost;
  const dt = Math.min(64, Math.max(1, now - (g.last || now)));
  g.last = now;
  if (!g.rect) g.rect = { x: tx, y: ty, w: tw, h: th };
  const r = g.rect;
  if (SmoothScroll.reduced) { r.x = tx; r.y = ty; r.w = tw; r.h = th; g.alpha = active ? 1 : 0; }
  else {
    const k = 1 - Math.exp(-dt / 60);             /* glide constant — smooth at any fps */
    r.x += (tx - r.x) * k; r.y += (ty - r.y) * k;
    r.w += (tw - r.w) * k; r.h += (th - r.h) * k;
    g.alpha = clamp(g.alpha + (active ? 1 : -1) * dt / (active ? 130 : 190), 0, 1);
  }
  const dist = Math.abs(tx - r.x) + Math.abs(ty - r.y) + Math.abs(tw - r.w) + Math.abs(th - r.h);
  const busy = active || dist > 0.3 || (g.alpha > 0.004 && g.alpha < 0.996);
  if (busy && !g.raf) g.raf = requestAnimationFrame(dragGhostStep);
}
/* animated green dotted outline: marching round dots + glow + soft interior tint */
function drawDragDots(ctx, r, now, alpha, opts) {
  const reduced = SmoothScroll.reduced;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = DRAG_GLOW(((opts && opts.tint != null) ? opts.tint : 0.08) * alpha);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.shadowColor = DRAG_GLOW(0.5 * alpha);
  ctx.shadowBlur = 7;
  ctx.strokeStyle = (opts && opts.color) || DRAG_DOT;
  ctx.lineWidth = (opts && opts.lw) || 2.4;
  ctx.lineCap = 'round';
  const period = (opts && opts.period) || 7;      /* dash+gap must equal period */
  ctx.setLineDash([0.1, period - 0.1]);
  ctx.lineDashOffset = reduced ? 0 : -((now / 18) % period);
  ctx.strokeRect(Math.round(r.x) + 1, Math.round(r.y) + 1, Math.round(r.w) - 2, Math.round(r.h) - 2);
  ctx.restore();
}

/* resize guide: soft green dotted edge-line while dragging a row/column border (fades in/out;
   the line itself stays 1:1 with the pointer — only the visibility animates) */
const ResizeFx = { alpha: 0, last: 0, raf: 0 };
function resizeFxStep() { ResizeFx.raf = 0; requestPaint(); }
function stepResizeFx(active, now) {
  const dt = Math.min(64, Math.max(1, now - (ResizeFx.last || now)));
  ResizeFx.last = now;
  if (SmoothScroll.reduced) ResizeFx.alpha = active ? 1 : 0;
  else ResizeFx.alpha = clamp(ResizeFx.alpha + (active ? 1 : -1) * dt / (active ? 120 : 180), 0, 1);
  const busy = active || (ResizeFx.alpha > 0.004 && ResizeFx.alpha < 0.996);
  if (busy && !ResizeFx.raf) ResizeFx.raf = requestAnimationFrame(resizeFxStep);
}

/* ---------------- main paint ---------------- */
function paint() {
  const canvas = R.canvas, ctx = R.ctx;
  if (!canvas || !WB) return;
  const sh = activeSheet();
  const L = computeLayout();
  ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
  ctx.clearRect(0, 0, L.w, L.h);
  /* Keep the header bands (top column headers + left row headers) transparent so
     the app surface shows through; paint white only on the cell body & scrollbars. */
  const vbw = L.scrollVisibleV ? L.sb : 0, hbh = L.scrollVisibleH ? L.sb : 0;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(L.gridX, L.gridY, L.gridW - vbw, L.gridH - hbh);
  ctx.fillRect(L.w - vbw, L.gridY, vbw, L.gridH - hbh);
  ctx.fillRect(L.gridX, L.h - hbh, L.gridW - vbw, hbh);
  ctx.fillRect(L.w - vbw, L.h - hbh, vbw, hbh);

  const zm = L.zoom;
  const sbW = L.scrollVisibleV ? L.sb : 0, sbH = L.scrollVisibleH ? L.sb : 0;

  /* --- determine visible index ranges --- */
  const frozenWUnz = sumFrozen(sh.cols, L.frzC);
  const frozenHUnz = sumFrozen(sh.rows, L.frzR);
  const scrollColsX0 = frozenWUnz + Scroll.x;
  const scrollRowsY0 = frozenHUnz + Scroll.y;
  const colsScrollW = (L.gridW - L.frzW - sbW) / zm;
  const rowsScrollH = (L.gridH - L.frzH - sbH) / zm;
  const c0 = sh.cols.indexAt(scrollColsX0);
  const c1 = Math.min(MAX_COLS - 1, sh.cols.indexAt(scrollColsX0 + colsScrollW) + 1);
  const r0 = sh.rows.indexAt(scrollRowsY0);
  const r1 = Math.min(MAX_ROWS - 1, sh.rows.indexAt(scrollRowsY0 + rowsScrollH) + 1);

  const cfCache = new Map();
  computeCfStats(sh, cfCache);

  /* --- band painting --- */
  function paintBand(clip, rowsFrom, rowsTo, colsFrom, colsTo, offsetX, offsetY, originRow, originCol) {
    if (clip.w <= 0 || clip.h <= 0) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
    ctx.translate(offsetX, offsetY);
    const drawRows = [], drawCols = [];
    for (let r = rowsFrom; r <= rowsTo && drawRows.length < 400; r++) { if (sh.rows.visible(r)) drawRows.push(r); if (r >= MAX_ROWS - 1) break; }
    for (let c = colsFrom; c <= colsTo && drawCols.length < 120; c++) { if (sh.cols.visible(c)) drawCols.push(c); if (c >= MAX_COLS - 1) break; }
    if (!drawRows.length || !drawCols.length) { ctx.restore(); return; }

    /* fills + text */
    for (const r of drawRows) {
      const y = rowScreenY(sh, r), hh = rowScreenH(sh, r);
      if (hh <= 0) continue;
      for (const c of drawCols) {
        const w = colScreenW(sh, c);
        if (w <= 0) continue;
        const m = mergeAt(sh, r, c);
        if (m && !(m.r1 === r && m.c1 === c)) continue;
        const rect = m ? cellScreenRect(sh, r, c) : { x: colScreenX(sh, c), y, w, h: hh };
        if (rect.x + rect.w < clip.x - offsetX - 4 || rect.x > clip.x - offsetX + clip.w + 4) continue;
        drawCellContent(sh, ctx, r, c, rect, cfCache, L);
      }
    }
    /* gridlines */
    if (sh.showGridlines) {
      ctx.strokeStyle = GRID_COLOR; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      const yTop = rowScreenY(sh, drawRows[0]), yBot = rowScreenY(sh, drawRows[drawRows.length - 1]) + rowScreenH(sh, drawRows[drawRows.length - 1]);
      for (const c of drawCols) {
        const x = Math.round(colScreenX(sh, c)) + 0.5;
        ctx.moveTo(x, yTop); ctx.lineTo(x, yBot);
      }
      const xL = colScreenX(sh, drawCols[0]), xR = colScreenX(sh, drawCols[drawCols.length - 1]) + colScreenW(sh, drawCols[drawCols.length - 1]);
      for (const r of drawRows) {
        const y = Math.round(rowScreenY(sh, r)) + 0.5;
        ctx.moveTo(xL, y); ctx.lineTo(xR, y);
      }
      ctx.stroke();
    }
    /* borders */
    ctx.setLineDash([]);
    for (const r of drawRows) {
      for (const c of drawCols) {
        const m = mergeAt(sh, r, c);
        if (m && !(m.r1 === r && m.c1 === c)) continue;
        const cell = sh.cells.get(key(r, c));
        if (!cell || !cell.s || !cell.s.border) continue;
        const b = cell.s.border;
        const rect = m ? cellScreenRect(sh, r, c) : { x: colScreenX(sh, c), y: rowScreenY(sh, r), w: colScreenW(sh, c), h: rowScreenH(sh, r) };
        const rightIdx = m ? m.c2 + 1 : c + 1, botIdx = m ? m.r2 + 1 : r + 1;
        if (b.t) drawBorderSide(ctx, rect.x, Math.round(rect.y) + 0.5, rect.x + rect.w, Math.round(rect.y) + 0.5, b.t, zm);
        if (b.b) drawBorderSide(ctx, rect.x, Math.round(rect.y + rect.h) - 0.5, rect.x + rect.w, Math.round(rect.y + rect.h) - 0.5, b.b, zm);
        if (b.l) drawBorderSide(ctx, Math.round(rect.x) + 0.5, rect.y, Math.round(rect.x) + 0.5, rect.y + rect.h, b.l, zm);
        if (b.r) drawBorderSide(ctx, Math.round(rect.x + rect.w) - 0.5, rect.y, Math.round(rect.x + rect.w) - 0.5, rect.y + rect.h, b.r, zm);
        void rightIdx; void botIdx;
      }
    }
    /* note reply-count badges (drawn above text/borders so right-aligned values never cover them) */
    drawNoteBadges(sh, ctx, drawRows, drawCols, L);
    /* recent-commit flash glows (fading accent tint) */
    drawCellFlashes(ctx, sh, L);
    /* selection overlay */
    drawSelection(ctx, sh, L);
    ctx.restore();
  }

  const gridRight = L.gridX + L.gridW - sbW;
  const gridBottom = L.gridY + L.gridH - sbH;
  /* band 1: scrollable area (clip excludes frozen strips) */
  paintBand({ x: L.gridX + L.frzW, y: L.gridY + L.frzH, w: gridRight - (L.gridX + L.frzW), h: gridBottom - (L.gridY + L.frzH) },
    r0, r1, c0, c1, 0, 0, r0, c0);
  /* band 2: frozen columns (rows scroll) */
  if (L.frzC) paintBand({ x: L.gridX, y: L.gridY + L.frzH, w: L.frzW, h: gridBottom - (L.gridY + L.frzH) }, r0, r1, 0, L.frzC - 1, 0, 0, r0, 0);
  /* band 3: frozen rows (cols scroll) */
  if (L.frzR) paintBand({ x: L.gridX + L.frzW, y: L.gridY, w: gridRight - (L.gridX + L.frzW), h: L.frzH }, 0, L.frzR - 1, c0, c1, 0, 0, 0, c0);
  /* band 4: frozen corner */
  if (L.frzC && L.frzR) paintBand({ x: L.gridX, y: L.gridY, w: L.frzW, h: L.frzH }, 0, L.frzR - 1, 0, L.frzC - 1, 0, 0, 0, 0);

  /* unified drag indicator — green marching dots for move / fill / paint, with eased follow + fades */
  {
    const now = performance.now();
    let kind = null, rc = null;
    if (DragState.active && DragState.to) {
      kind = 'move';
      const t = DragState.to;
      rc = { x: colScreenX(sh, t.c1), y: rowScreenY(sh, t.r1),
             w: (sh.cols.offsetOf(t.c2 + 1) - sh.cols.offsetOf(t.c1)) * zm,
             h: (sh.rows.offsetOf(t.r2 + 1) - sh.rows.offsetOf(t.r1)) * zm };
    } else if (Mouse.mode === 'fill' && Mouse.data && Mouse.data.target) {
      kind = 'fill';
      const t = Mouse.data.target;
      rc = { x: colScreenX(sh, t.c1), y: rowScreenY(sh, t.r1),
             w: (sh.cols.offsetOf(t.c2 + 1) - sh.cols.offsetOf(t.c1)) * zm,
             h: (sh.rows.offsetOf(t.r2 + 1) - sh.rows.offsetOf(t.r1)) * zm };
    } else if (PaintState.active && Mouse.mode === 'paint' && Mouse.data && Mouse.data.target) {
      kind = 'paint';
      const t = Mouse.data.target;
      rc = { x: colScreenX(sh, t.c1), y: rowScreenY(sh, t.r1),
             w: (sh.cols.offsetOf(t.c2 + 1) - sh.cols.offsetOf(t.c1)) * zm,
             h: (sh.rows.offsetOf(t.r2 + 1) - sh.rows.offsetOf(t.r1)) * zm };
    }
    if (kind) {
      if (DragGhost.kind !== kind) { DragGhost.kind = kind; DragGhost.rect = null; }
      stepDragGhost(rc.x, rc.y, rc.w, rc.h, true, now);
    } else if (DragGhost.rect && DragGhost.alpha > 0) {
      /* gesture released — keep drawing while the ghost fades out */
      stepDragGhost(DragGhost.rect.x, DragGhost.rect.y, DragGhost.rect.w, DragGhost.rect.h, false, now);
    } else { DragGhost.kind = null; DragGhost.rect = null; }
    if (DragGhost.rect && DragGhost.alpha > 0.01) {
      drawDragDots(ctx, DragGhost.rect, now, DragGhost.alpha,
        DragGhost.kind === 'move' ? { lw: 2.6, tint: 0.09 } : { lw: 2.2, tint: 0.07 });
    }
  }

  /* formula auditing arrows (recomputed live while active) */
  drawAuditArrows(ctx, sh, L, sbW, sbH);

  /* --- headers --- */
  if (VIEW.showHeadings) {
    drawColHeaders(ctx, sh, L, c0, c1, r0, r1);
    drawRowHeaders(ctx, sh, L, r0, r1, c0, c1);
    /* corner */
    ctx.strokeStyle = HDR_BORDER; ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, L.gridX - 0.5, L.gridY - 0.5);
    ctx.fillStyle = HDR_TXT;
    ctx.beginPath();
    const cx = L.gridX / 2, cy = L.gridY / 2, rr = Math.min(4, L.gridY / 5);
    ctx.moveTo(cx - rr, cy - rr); ctx.lineTo(cx + rr, cy - rr); ctx.lineTo(cx, cy + rr * 0.6); ctx.closePath();
    ctx.fill();
  }

  /* resize guide: animated green dotted edge-line while dragging a header border */
  {
    const now = performance.now();
    const resizing = (Mouse.mode === 'resizeCol' || Mouse.mode === 'resizeRow') && Mouse.data;
    let lx = null, ly = null;
    if (resizing) {
      if (Mouse.mode === 'resizeCol') { lx = colScreenX(sh, Mouse.data.index) + colScreenW(sh, Mouse.data.index); }
      else { ly = rowScreenY(sh, Mouse.data.index) + rowScreenH(sh, Mouse.data.index); }
    }
    stepResizeFx(!!resizing, now);
    if (ResizeFx.alpha > 0.01 && (lx != null || ly != null)) {
      ctx.save();
      ctx.globalAlpha = ResizeFx.alpha;
      ctx.shadowColor = DRAG_GLOW(0.55 * ResizeFx.alpha);
      ctx.shadowBlur = 8;
      ctx.strokeStyle = DRAG_DOT;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.setLineDash([1, 5]);
      if (!SmoothScroll.reduced) ctx.lineDashOffset = -((now / 20) % 6);
      ctx.beginPath();
      if (lx != null) { ctx.moveTo(lx + 0.5, L.gridY); ctx.lineTo(lx + 0.5, gridBottom); }
      else { ctx.moveTo(L.gridX, ly + 0.5); ctx.lineTo(gridRight, ly + 0.5); }
      ctx.stroke();
      ctx.restore();
    }
  }

  /* frozen pane dividers */
  if (L.frzC) { ctx.strokeStyle = '#b8bcc2'; ctx.lineWidth = 1.5; ctx.beginPath(); const x = L.gridX + L.frzW; ctx.moveTo(x, L.gridY); ctx.lineTo(x, L.gridY + L.gridH - sbH); ctx.stroke(); }
  if (L.frzR) { ctx.strokeStyle = '#b8bcc2'; ctx.lineWidth = 1.5; ctx.beginPath(); const y = L.gridY + L.frzH; ctx.moveTo(L.gridX, y); ctx.lineTo(L.gridX + L.gridW - sbW, y); ctx.stroke(); }

  /* live resize guide line (column/row drag) */
  if ((Mouse.mode === 'resizeCol' || Mouse.mode === 'resizeRow') && Mouse.data) {
    ctx.save();
    ctx.strokeStyle = 'rgba(33,115,70,0.18)'; ctx.lineWidth = 5;
    ctx.beginPath();
    if (Mouse.mode === 'resizeCol') {
      const gx = colScreenX(sh, Mouse.data.index) + colScreenW(sh, Mouse.data.index);
      ctx.moveTo(gx, L.gridY); ctx.lineTo(gx, L.gridY + L.gridH - sbH);
    } else {
      const gy = rowScreenY(sh, Mouse.data.index) + rowScreenH(sh, Mouse.data.index);
      ctx.moveTo(L.gridX, gy); ctx.lineTo(L.gridX + L.gridW - sbW, gy);
    }
    ctx.stroke();
    ctx.strokeStyle = '#217346'; ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /* grid outer edge */
  ctx.strokeStyle = '#e3e5e8'; ctx.lineWidth = 1;
  ctx.strokeRect(L.gridX + 0.5, L.gridY + 0.5, L.gridW - sbW - 1, L.gridH - sbH - 1);

  /* --- scrollbars --- */
  if (L.scrollVisibleV) drawVScrollbar(ctx, L);
  if (L.scrollVisibleH) drawHScrollbar(ctx, L);

  updateOverlayLayers();
}

/* sparkline renderer — mini line/bar/winloss chart inside a cell */
function drawSparkline(ctx, rect, spark) {
  const vals = (spark.values || []).filter(v => typeof v === 'number');
  if (vals.length < 2) return;
  const pad = 3;
  const x0 = rect.x + pad, y0 = rect.y + pad, w0 = rect.w - pad * 2, h0 = rect.h - pad * 2;
  if (w0 <= 4 || h0 <= 4) return;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const vx = i => x0 + (w0 * i / (vals.length - 1));
  const vy = v => y0 + h0 - ((v - min) / span) * h0;
  const zeroY = y0 + h0 - ((0 - min) / span) * h0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
  ctx.clip();
  if (spark.type === 'bar' || spark.type === 'winloss') {
    const slot = w0 / vals.length;
    const bw = Math.max(1.5, slot - Math.min(2, slot * 0.3));
    vals.forEach((v, i) => {
      const bx = x0 + slot * i + (slot - bw) / 2;
      ctx.fillStyle = v >= 0 ? '#217346' : '#c4314b';
      if (spark.type === 'bar') {
        const by = vy(v);
        if (v >= 0) ctx.fillRect(bx, by, bw, Math.max(1, zeroY - by));
        else ctx.fillRect(bx, zeroY, bw, Math.max(1, by - zeroY));
      } else {
        /* winloss: equal-height markers */
        if (v >= 0) ctx.fillRect(bx, y0 + 1, bw, Math.max(1, zeroY - y0 - 1));
        else ctx.fillRect(bx, zeroY + 1, bw, Math.max(1, y0 + h0 - zeroY - 2));
      }
    });
  } else {
    /* soft area fill under the line */
    ctx.beginPath();
    vals.forEach((v, i) => { if (i === 0) ctx.moveTo(vx(i), vy(v)); else ctx.lineTo(vx(i), vy(v)); });
    ctx.lineTo(vx(vals.length - 1), y0 + h0);
    ctx.lineTo(vx(0), y0 + h0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(33,115,70,0.10)';
    ctx.fill();
    /* the line */
    ctx.beginPath();
    vals.forEach((v, i) => { if (i === 0) ctx.moveTo(vx(i), vy(v)); else ctx.lineTo(vx(i), vy(v)); });
    ctx.strokeStyle = '#217346';
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.stroke();
    /* min / max / last markers */
    const mi = vals.indexOf(min), ma = vals.indexOf(max);
    ctx.fillStyle = '#c4314b';
    ctx.beginPath(); ctx.arc(vx(mi), vy(min), 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#185c37';
    ctx.beginPath(); ctx.arc(vx(ma), vy(max), 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(vx(vals.length - 1), vy(vals[vals.length - 1]), 2.1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawNoteBadges(sh, ctx, drawRows, drawCols, L) {
  if (!sh.notes || !sh.notes.size || (L.zoom || 1) < 0.75) return;
  const rMin = drawRows[0], rMax = drawRows[drawRows.length - 1];
  const cMin = drawCols[0], cMax = drawCols[drawCols.length - 1];
  if (rMin == null || cMin == null) return;
  for (const [k, n] of sh.notes) {
    const nRep = noteReplies(n).length;
    if (!nRep) continue;
    const seg = k.split(',');
    const r = +seg[0], c = +seg[1];
    if (r < rMin || r > rMax || c < cMin || c > cMax) continue;
    if (!sh.rows.visible(r) || !sh.cols.visible(c)) continue;
    const m = mergeAt(sh, r, c);
    if (m && !(m.r1 === r && m.c1 === c)) continue;
    const rect = m ? cellScreenRect(sh, r, c) : { x: colScreenX(sh, c), y: rowScreenY(sh, r), w: colScreenW(sh, c), h: rowScreenH(sh, r) };
    const zm = L.zoom || 1;
    const rad = 7 * zm;
    const bx = rect.x + rect.w - rad - 1, by = rect.y + rad + 1.5;
    ctx.beginPath(); ctx.arc(bx, by, rad, 0, Math.PI * 2);
    ctx.fillStyle = '#c4314b'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold ' + Math.max(8, Math.round(9 * zm)) + 'px "Segoe UI"';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(nRep > 9 ? '9+' : String(nRep), bx, by + 0.5);
  }
}
function drawCellContent(sh, ctx, r, c, rect, cfCache, L) {
  let info = displayValue(sh, r, c);
  {
    const gt = glideTextFor(sh, r, c);
    if (gt != null) info = Object.assign({}, info, { text: gt, isNum: true, isErr: false, isBool: false });
  }
  const style = info.style;
  let bg = style.backgroundColor, fg = style.color, dataBar = null, iconSet = null;
  const cf = cfForCell(sh, r, c, cfCache);
  if (cf) {
    if (cf.backgroundColor) bg = cf.backgroundColor;
    if (cf.color) fg = cf.color;
    if (cf.dataBar) dataBar = cf.dataBar;
    if (cf.iconSet) iconSet = cf.iconSet;
  }
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
  /* note/comment indicator (red corner triangle); reply badge drawn in a later pass */
  if (sh.notes && sh.notes.size && sh.notes.has(key(r, c))) {
    const s = Math.min(9, Math.max(6, 7 * (L.zoom || 1)));
    ctx.fillStyle = '#c4314b';
    ctx.beginPath();
    ctx.moveTo(rect.x + rect.w - s, rect.y);
    ctx.lineTo(rect.x + rect.w, rect.y);
    ctx.lineTo(rect.x + rect.w, rect.y + s);
    ctx.closePath();
    ctx.fill();
  }
  if (dataBar) {
    const bw = Math.max(2, (rect.w - 2) * dataBar.t);
    ctx.fillStyle = dataBar.color;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(rect.x + 1, rect.y + 1.5, bw, rect.h - 3);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(rect.x + 1, rect.y + rect.h / 2 - 1, bw, 2);
    ctx.globalAlpha = 1;
  }
  /* icon-set CF glyphs: drawn left of the content, text shifts right */
  let shiftL = 0;
  if (iconSet && rect.w > 26) {
    const zc = L.zoom || 1;
    const s = Math.max(8, Math.min(13, 11 * zc));
    drawCfIcon(ctx, rect.x + 3 * zc + s / 2, rect.y + rect.h / 2, s, iconSet.kind, iconSet.bucket);
    shiftL = s + 5 * zc;
  }
  if (info.spark) { drawSparkline(ctx, rect, info.spark); return; }
  if (info.text === '') return;
  const zm = L.zoom;
  const fs = Math.max(6, (style.fontSize || DEF.fontPt) * (96 / 72) * zm);
  const fontFam = style.fontFamily || DEF.fontFamily;
  ctx.font = (style.italic ? 'italic ' : '') + (style.bold ? '700 ' : '400 ') + fs + 'px "' + fontFam + '", Calibri, "Segoe UI", sans-serif';
  let color = info.isErr ? '#d13438' : (fg || '#1a1a1a');
  ctx.fillStyle = color;
  if (info.isBool) ctx.fillStyle = fg || '#1a1a1a';
  ctx.textBaseline = 'middle';

  const va = style.valign || 'middle';
  const pad = 3 * zm;
  let textY = rect.y + rect.h / 2;
  if (va === 'top') textY = rect.y + pad + fs * 0.55;
  else if (va === 'bottom') textY = rect.y + rect.h - pad - fs * 0.55;

  let align = style.halign || (info.isNum ? 'right' : info.isBool ? 'center' : 'left');
  if (info.isErr) align = style.halign || 'right';

  /* wrapped text */
  if (style.wrap && rect.w > 12) {
    const lines = wrapText(ctx, info.text, rect.w - pad * 2);
    const lh = fs * 1.25;
    const maxLines = Math.max(1, Math.floor((rect.h - pad) / lh));
    let startY = va === 'top' ? rect.y + pad + lh * 0.5 : va === 'bottom' ? rect.y + rect.h - pad - (Math.min(lines.length, maxLines) - 0.5) * lh : rect.y + rect.h / 2 - (Math.min(lines.length, maxLines) - 1) * lh / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      ctx.textAlign = align === 'right' ? 'right' : align === 'center' ? 'center' : 'left';
      const tx = align === 'right' ? rect.x + rect.w - pad : align === 'center' ? rect.x + shiftL + (rect.w - shiftL) / 2 : rect.x + pad + shiftL;
      ctx.fillText(lines[i], tx + (align === 'left' ? (style.indent || 0) * 8 * zm : 0), startY + i * lh);
    }
    ctx.restore();
    return;
  }

  /* measure + overflow */
  ctx.textAlign = align === 'right' ? 'right' : align === 'center' ? 'center' : 'left';
  const tw = ctx.measureText(info.text).width;
  const avail = rect.w - pad * 2 - shiftL;
  let tx = align === 'right' ? rect.x + rect.w - pad : align === 'center' ? rect.x + shiftL + (rect.w - shiftL) / 2 : rect.x + pad + shiftL + (style.indent || 0) * 8 * zm;

  if (tw > avail) {
    if (info.isNum) {
      /* #### */
      ctx.save();
      ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
      const cw = Math.max(4, ctx.measureText('#').width);
      const n = Math.max(1, Math.floor((rect.w - pad * 2) / cw));
      ctx.fillText('#'.repeat(n), rect.x + rect.w - pad, textY);
      ctx.restore();
      return;
    }
    if (info.isBool || align === 'center') {
      ctx.save();
      ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
      ctx.fillText(info.text, tx, textY);
      ctx.restore();
      return;
    }
    /* text spill into neighbouring empty cells */
    let extW = rect.w;
    const dir = align === 'right' ? -1 : 1;
    let edge = align === 'right' ? rect.x : rect.x + rect.w;
    let cc = c;
    for (let k = 0; k < 50; k++) {
      cc += dir;
      if (cc < 0 || cc >= MAX_COLS) break;
      const nb = sh.cells.get(key(r, cc));
      const nm = mergeAt(sh, r, cc);
      if (nb && (nb.v != null || nb.f)) break;
      if (nm) break;
      if (!sh.cols.visible(cc)) continue;
      extW += colScreenW(sh, cc);
    }
    const startX = align === 'right' ? edge - (tw) : edge;
    ctx.save();
    ctx.beginPath();
    ctx.rect(align === 'right' ? Math.min(startX, rect.x) : rect.x, rect.y, Math.max(extW, tw + pad), rect.h);
    ctx.clip();
    ctx.textAlign = align;
    ctx.fillText(info.text, tx, textY);
    ctx.restore();
    return;
  }

  if (style.underline || style.strike) {
    ctx.save();
    const ty = textY + fs * 0.42;
    if (style.underline === 2) {
      ctx.fillRect(tx - (align === 'right' ? tw : 0), ty, tw, 1); 
      ctx.fillRect(tx - (align === 'right' ? tw : 0), ty + 2.5, tw, 1);
    } else if (style.underline === 1) {
      ctx.fillRect(tx - (align === 'right' ? tw : 0), ty + 0.5, tw, 1);
    }
    if (style.strike) ctx.fillRect(tx - (align === 'right' ? tw : 0), textY - fs * 0.12, tw, 1);
    ctx.restore();
  }
  ctx.fillText(info.text, tx, textY);
}

/* vector glyphs for the icon-set conditional format (bucket: 0 low, 1 middle, 2 high) */
const CF_ICON_COLORS = { low: '#d13438', mid: '#ffc000', high: '#1f9d55' };
function drawCfIcon(ctx, cx, cy, size, kind, bucket) {
  const r = size / 2;
  const col = bucket === 0 ? CF_ICON_COLORS.low : bucket === 1 ? CF_ICON_COLORS.mid : CF_ICON_COLORS.high;
  ctx.save();
  ctx.lineWidth = Math.max(1, size / 9);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (kind === 'arrows3') {
    /* triangles pointing down / right / up */
    ctx.fillStyle = col;
    ctx.beginPath();
    if (bucket === 2) { ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r * 0.75); ctx.lineTo(cx - r, cy + r * 0.75); }
    else if (bucket === 1) { ctx.moveTo(cx + r, cy); ctx.lineTo(cx - r * 0.75, cy - r); ctx.lineTo(cx - r * 0.75, cy + r); }
    else { ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r * 0.75); ctx.lineTo(cx - r, cy - r * 0.75); }
    ctx.closePath(); ctx.fill();
  } else if (kind === 'traffic3') {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2); ctx.stroke();
  } else if (kind === 'signs3') {
    ctx.fillStyle = col;
    ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
    const q = r * 0.74;
    ctx.beginPath(); ctx.rect(-q, -q, q * 2, q * 2); ctx.fill();
    ctx.rotate(-Math.PI / 4); ctx.translate(-cx, -cy);
    /* glyph inside the diamond */
    ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
    if (bucket === 2) { /* check */
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.42, cy + r * 0.05); ctx.lineTo(cx - r * 0.08, cy + r * 0.4); ctx.lineTo(cx + r * 0.45, cy - r * 0.35);
      ctx.stroke();
    } else if (bucket === 1) { /* exclamation */
      ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.5); ctx.lineTo(cx, cy + r * 0.16); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy + r * 0.44, Math.max(0.6, size / 12), 0, Math.PI * 2); ctx.fill();
    } else { /* cross */
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.4, cy - r * 0.4); ctx.lineTo(cx + r * 0.4, cy + r * 0.4);
      ctx.moveTo(cx + r * 0.4, cy - r * 0.4); ctx.lineTo(cx - r * 0.4, cy + r * 0.4);
      ctx.stroke();
    }
  } else if (kind === 'flags3') {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, cy - r);
    ctx.lineTo(cx + r * 0.7, cy - r * 0.55);
    ctx.lineTo(cx - r * 0.55, cy - r * 0.1);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#8a8886';
    ctx.lineWidth = Math.max(1, size / 11);
    ctx.beginPath(); ctx.moveTo(cx - r * 0.55, cy - r); ctx.lineTo(cx - r * 0.55, cy + r); ctx.stroke();
  } else if (kind === 'stars3') {
    /* bronze / silver / gold star */
    const fill = bucket === 2 ? '#ffc000' : bucket === 1 ? '#b9b9b9' : '#cd9065';
    drawCfStar(ctx, cx, cy, r, fill);
  } else { /* symbols3: cross / exclamation / check */
    ctx.strokeStyle = col; ctx.fillStyle = col;
    if (bucket === 2) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.55, cy + r * 0.02); ctx.lineTo(cx - r * 0.1, cy + r * 0.5); ctx.lineTo(cx + r * 0.6, cy - r * 0.45);
      ctx.stroke();
    } else if (bucket === 1) {
      ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.65); ctx.lineTo(cx, cy + r * 0.2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy + r * 0.5, Math.max(0.7, size / 11), 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy - r * 0.5); ctx.lineTo(cx + r * 0.5, cy + r * 0.5);
      ctx.moveTo(cx + r * 0.5, cy - r * 0.5); ctx.lineTo(cx - r * 0.5, cy + r * 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}
function drawCfStar(ctx, cx, cy, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function wrapText(ctx, text, maxW) {
  const words = String(text).split(/\r?\n/);
  const lines = [];
  for (const w0 of words) {
    const words2 = w0.split(' ');
    let line = '';
    for (const wd of words2) {
      const test = line ? line + ' ' + wd : wd;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = wd; }
      else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function rangeIntersectsHeaders(rg, kind, idx) {
  if (kind === 'col') return rg.c1 <= idx && idx <= rg.c2 && (isColSelection(rg) || (rg.r1 === 0 && rg.r2 >= MAX_ROWS - 1));
  return rg.r1 <= idx && idx <= rg.r2 && (isRowSelection(rg) || (rg.c1 === 0 && rg.c2 >= MAX_COLS - 1));
}
function headerSelected(sh, kind, idx) {
  if (SEL.sheetId !== sh.id) return { sel: false, act: false };
  for (let i = 0; i < SEL.ranges.length; i++) {
    const rg = SEL.ranges[i];
    if (rangeIntersectsHeaders(rg, kind, idx)) return { sel: true, act: i === SEL.activeIdx };
  }
  return { sel: false, act: false };
}

function drawColHeaders(ctx, sh, L, c0, c1, r0, r1) {
  ctx.save();
  ctx.beginPath(); ctx.rect(L.gridX, 0, L.gridW, L.gridY); ctx.clip();
  ctx.font = Math.round(11 * Math.min(L.zoom, 1.4)) + 'px "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let c = c0;
  let guard = 0;
  while (c <= c1 && guard++ < 300) {
    if (!sh.cols.visible(c)) { c++; continue; }
    const x = colScreenX(sh, c), w = colScreenW(sh, c);
    const hs = headerSelected(sh, 'col', c);
    if (hs.sel) { ctx.fillStyle = hs.act ? '#9dc3ae' : LHdrSel; ctx.fillRect(x, 0, w, L.gridY); }
    else if (c === Hover.col) { ctx.fillStyle = LHdrHover; ctx.fillRect(x, 0, w, L.gridY); }
    ctx.strokeStyle = HDR_BORDER; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, L.gridY);
    ctx.moveTo(x, L.gridY - 0.5); ctx.lineTo(x + w, L.gridY - 0.5);
    ctx.stroke();
    ctx.fillStyle = hs.sel ? '#1c5233' : (c === Hover.col ? '#3b6e52' : HDR_TXT);
    ctx.fillText(colName(c), x + w / 2, L.gridY / 2 + 0.5);
    c++;
  }
  ctx.restore();
}
const LHdrSel = '#cde5d7';
const LHdrHover = '#e3f0e8';   /* header hover tint */
function drawRowHeaders(ctx, sh, L, r0, r1, c0, c1) {
  ctx.save();
  ctx.beginPath(); ctx.rect(0, L.gridY, L.gridX, L.gridH); ctx.clip();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let r = r0;
  let guard = 0;
  while (r <= r1 && guard++ < 400) {
    if (!sh.rows.visible(r)) { r++; continue; }
    const y = rowScreenY(sh, r), h = rowScreenH(sh, r);
    const hs = headerSelected(sh, 'row', r);
    if (hs.sel) { ctx.fillStyle = hs.act ? '#9dc3ae' : LHdrSel; ctx.fillRect(0, y, L.gridX, h); }
    else if (r === Hover.row) { ctx.fillStyle = LHdrHover; ctx.fillRect(0, y, L.gridX, h); }
    ctx.strokeStyle = HDR_BORDER; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(L.gridX, Math.round(y) + 0.5);
    ctx.moveTo(L.gridX - 0.5, y); ctx.lineTo(L.gridX - 0.5, y + h);
    ctx.stroke();
    ctx.fillStyle = hs.sel ? '#1c5233' : (r === Hover.row ? '#3b6e52' : HDR_TXT);
    ctx.font = Math.round(11 * Math.min(L.zoom, 1.4)) + 'px "Segoe UI", sans-serif';
    ctx.fillText(String(r + 1), L.gridX / 2, y + h / 2 + 0.5);
    r++;
  }
  ctx.restore();
}

/* selection overlay drawing (call inside a translated/clipped band) */
function drawSelection(ctx, sh, L) {
  if (SEL.sheetId !== sh.id) return;
  const zm = L.zoom;
  const animP = selAnimP();
  const fromRg = (SelAnim.active && SelAnim.from) ? SelAnim.from : null;
  for (let i = 0; i < SEL.ranges.length; i++) {
    const rg = SEL.ranges[i];
    const isActive = i === SEL.activeIdx;
    const x = colScreenX(sh, rg.c1), y = rowScreenY(sh, rg.r1);
    const w = (sh.cols.offsetOf(rg.c2 + 1) - sh.cols.offsetOf(rg.c1)) * zm;
    const h = (sh.rows.offsetOf(rg.r2 + 1) - sh.rows.offsetOf(rg.r1)) * zm;
    const multi = SEL.ranges.length > 1 || rg.r1 !== rg.r2 || rg.c1 !== rg.c2;
    if (multi && !isErrViewport(rg)) {
      ctx.fillStyle = 'rgba(33,115,70,' + (0.10 * (isActive ? animP : 1)).toFixed(3) + ')';
      ctx.fillRect(x, y, w, h);
    }
    /* active cell white wash when part of larger range */
    if (multi) {
      const am = mergeAt(sh, SEL.active.r, SEL.active.c);
      const arect = am ? cellScreenRect(sh, SEL.active.r, SEL.active.c) : { x: colScreenX(sh, SEL.active.c), y: rowScreenY(sh, SEL.active.r), w: colScreenW(sh, SEL.active.c), h: rowScreenH(sh, SEL.active.r) };
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(arect.x, arect.y, arect.w, arect.h);
    }
    /* border — the active border glides from the previous selection on click */
    let bx = x, by = y, bw = w, bh = h;
    if (isActive && fromRg && animP < 1) {
      const fx = colScreenX(sh, fromRg.c1), fy = rowScreenY(sh, fromRg.r1);
      const fw = (sh.cols.offsetOf(fromRg.c2 + 1) - sh.cols.offsetOf(fromRg.c1)) * zm;
      const fh = (sh.rows.offsetOf(fromRg.r2 + 1) - sh.rows.offsetOf(fromRg.r1)) * zm;
      const t = lerpRangeRect({ sx: fx, sy: fy, sw: fw, sh: fh }, { sx: x, sy: y, sw: w, sh: h }, animP);
      bx = t.x; by = t.y; bw = t.w; bh = t.h;
    }
    ctx.strokeStyle = SEL_COLOR;
    if (i === SEL.activeIdx || SEL.ranges.length > 1) {
      ctx.save();
      if (isActive) { ctx.shadowColor = 'rgba(33,115,70,0.28)'; ctx.shadowBlur = 5; }
      ctx.lineWidth = multi ? 1.4 : 2;
      roundRect(ctx, Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.max(2, Math.round(bw) - 1), Math.max(2, Math.round(bh) - 1), 2);
      ctx.stroke();
      ctx.restore();
    }
    if (isActive && multi) {
      const arect2 = mergeAt(sh, SEL.active.r, SEL.active.c) ? cellScreenRect(sh, SEL.active.r, SEL.active.c)
        : { x: colScreenX(sh, SEL.active.c), y: rowScreenY(sh, SEL.active.r), w: colScreenW(sh, SEL.active.c), h: rowScreenH(sh, SEL.active.r) };
      ctx.lineWidth = 2;
      ctx.strokeRect(arect2.x + 0.5, arect2.y + 0.5, arect2.w - 1, arect2.h - 1);
    }
    /* fill handle — grows + glows on hover */
    if (isActive && !Edit.active && !(rg.r1 === 0 && rg.c1 === 0 && rg.r2 >= MAX_ROWS - 1)) {
      const fr = activeSelRange();
      const hx0 = colScreenX(sh, fr.c2) + colScreenW(sh, fr.c2);
      const hy0 = rowScreenY(sh, fr.r2) + rowScreenH(sh, fr.r2);
      const handleHot = Hover.handle || Mouse.mode === 'fill';
      const hs = handleHot ? 9 : 7;
      const hx = hx0 - hs / 2, hy = hy0 - hs / 2;
      ctx.save();
      if (handleHot) { ctx.shadowColor = 'rgba(47,158,99,0.55)'; ctx.shadowBlur = 8; }
      ctx.fillStyle = SEL_COLOR;
      roundRect(ctx, hx, hy, hs, hs, 1.5);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      roundRect(ctx, hx + 0.5, hy + 0.5, hs - 1, hs - 1, 1);
      ctx.stroke();
      ctx.restore();
    }
  }
  /* copy marquee */
  if (Clip.marquee) {
    const rg = Clip.marquee.range;
    const x = colScreenX(sh, rg.c1), y = rowScreenY(sh, rg.r1);
    const w = (sh.cols.offsetOf(rg.c2 + 1) - sh.cols.offsetOf(rg.c1)) * zm;
    const h = (sh.rows.offsetOf(rg.r2 + 1) - sh.rows.offsetOf(rg.r1)) * zm;
    ctx.strokeStyle = Clip.marquee.cut ? '#e8a33d' : '#217346';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -(Date.now() / 60 % 9);
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    ctx.setLineDash([]);
  }
  /* NOTE: autofill + format-painter drag targets are drawn by the unified
     DragGhost indicator in paint() (animated green marching dots). */
}
function isErrViewport() { return false; }

/* ---------------- scrollbars ---------------- */
function vThumbMetrics(L) {
  const sh = activeSheet();
  const total = sh.rows.total();
  const frzH = sumFrozen(sh.rows, L.frzR);
  const view = (L.gridH - (L.scrollVisibleH ? L.sb : 0)) - L.frzH;
  const maxScroll = Math.max(1, total - frzH - view / L.zoom);
  const y = clamp(Scroll.y, 0, maxScroll);
  const frac = view / L.zoom / Math.max(total - frzH, 1);
  const trackY = L.gridY, trackH = L.gridH - (L.scrollVisibleH ? L.sb : 0);
  const thumbH = clamp(trackH * frac, 28, trackH);
  const thumbY = trackY + L.frzH + (trackH - L.frzH - thumbH) * (y / maxScroll);
  return { trackY, trackH, thumbY, thumbH, maxScroll };
}
function hThumbMetrics(L) {
  const sh = activeSheet();
  const total = sh.cols.total();
  const frzW = sumFrozen(sh.cols, L.frzC);
  const view = (L.gridW - (L.scrollVisibleV ? L.sb : 0)) - L.frzW;
  const maxScroll = Math.max(1, total - frzW - view / L.zoom);
  const x = clamp(Scroll.x, 0, maxScroll);
  const frac = view / L.zoom / Math.max(total - frzW, 1);
  const trackX = L.gridX, trackW = L.gridW - (L.scrollVisibleV ? L.sb : 0);
  const thumbW = clamp(trackW * frac, 28, trackW);
  const thumbX = trackX + L.frzW + (trackW - L.frzW - thumbW) * (x / maxScroll);
  return { trackX, trackW, thumbX, thumbW, maxScroll };
}
function drawVScrollbar(ctx, L) {
  const m = vThumbMetrics(L);
  ctx.save();
  if (!SmoothScroll.reduced) ctx.globalAlpha = Math.max(0, Math.min(1, SbFade.alpha));
  ctx.fillStyle = '#f1f2f3';
  ctx.fillRect(L.w - L.sb, L.gridY, L.sb, L.gridH - (L.scrollVisibleH ? L.sb : 0));
  const drag = Mouse.mode === 'vscrollDrag';
  ctx.fillStyle = drag ? '#969ca3' : (Hover.sb === 'vscroll' ? '#aab0b6' : '#c4c7cb');
  roundRect(ctx, L.w - L.sb + 2, m.thumbY, L.sb - 4, m.thumbH, 3);
  ctx.fill();
  ctx.restore();
}
function drawHScrollbar(ctx, L) {
  const m = hThumbMetrics(L);
  ctx.save();
  if (!SmoothScroll.reduced) ctx.globalAlpha = Math.max(0, Math.min(1, SbFade.alpha));
  ctx.fillStyle = '#f1f2f3';
  ctx.fillRect(L.gridX, L.h - L.sb, L.gridW - (L.scrollVisibleV ? L.sb : 0), L.sb);
  const drag = Mouse.mode === 'hscrollDrag';
  ctx.fillStyle = drag ? '#969ca3' : (Hover.sb === 'hscroll' ? '#aab0b6' : '#c4c7cb');
  roundRect(ctx, m.thumbX, L.h - L.sb + 2, m.thumbW, L.sb - 4, 3);
  ctx.fill();
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function scrollByPx(dx, dy) {
  cancelSmoothScroll();
  Scroll.x += dx; Scroll.y += dy;
  clampScroll();
  sbActivity();
  requestPaint();
}

/* ---------------- smooth scrolling ----------------
 * Wheel input eases the viewport toward a target offset (buttery glide).
 * Direct manipulation (scrollbar drag, autoScroll, programmatic jumps)
 * cancels the glide and stays 1:1. Honors prefers-reduced-motion. */
const SmoothScroll = { tx: 0, ty: 0, raf: 0, active: false,
  reduced: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches };
function smoothScrollBy(dx, dy) {
  sbActivity();
  if (SmoothScroll.reduced) { scrollByPx(dx, dy); return; }
  if (!SmoothScroll.active) {
    SmoothScroll.tx = Scroll.x; SmoothScroll.ty = Scroll.y; SmoothScroll.active = true;
  }
  SmoothScroll.tx += dx; SmoothScroll.ty += dy;
  if (!SmoothScroll.raf) SmoothScroll.raf = requestAnimationFrame(smoothScrollStep);
}
function smoothScrollStep() {
  SmoothScroll.raf = 0;
  if (!SmoothScroll.active) return;
  const k = 0.26;                                   /* ease factor per frame */
  Scroll.x += (SmoothScroll.tx - Scroll.x) * k;
  Scroll.y += (SmoothScroll.ty - Scroll.y) * k;
  clampScroll();
  sbActivity();
  requestPaint();
  if (Math.abs(SmoothScroll.tx - Scroll.x) < 0.5 && Math.abs(SmoothScroll.ty - Scroll.y) < 0.5) {
    Scroll.x = SmoothScroll.tx; Scroll.y = SmoothScroll.ty;
    clampScroll();
    SmoothScroll.active = false;
    requestPaint();
  } else {
    SmoothScroll.raf = requestAnimationFrame(smoothScrollStep);
  }
}
function cancelSmoothScroll() {
  SmoothScroll.active = false;
  if (SmoothScroll.raf) { cancelAnimationFrame(SmoothScroll.raf); SmoothScroll.raf = 0; }
}
/* glide the viewport to an absolute offset (name-box jumps, big navigations) */
function smoothScrollTo(tx, ty) {
  if (SmoothScroll.reduced) {
    cancelSmoothScroll();
    Scroll.x = tx; Scroll.y = ty; clampScroll(); scheduleScrollUI(); requestPaint();
    return;
  }
  cancelSmoothScroll();
  SmoothScroll.tx = tx; SmoothScroll.ty = ty; SmoothScroll.active = true;
  SmoothScroll.raf = requestAnimationFrame(smoothScrollStep);
}

/* ---------------- scrollbar auto-fade ----------------
 * Scrollbars are fully visible while scrolling / hovering / dragging and
 * gently fade out after ~1.4 s idle (overlay style). Honors reduced motion. */
const SbFade = { alpha: 1, last: performance.now(), raf: 0 };
let sbIdleTimer = 0;
function sbActivity() {
  if (SmoothScroll.reduced) return;
  SbFade.last = performance.now();
  if (sbIdleTimer) { clearTimeout(sbIdleTimer); sbIdleTimer = 0; }
  if (SbFade.alpha < 1 && !SbFade.raf) SbFade.raf = requestAnimationFrame(sbFadeStep);   /* fade back in */
  sbIdleTimer = setTimeout(() => { sbIdleTimer = 0; if (!SbFade.raf) SbFade.raf = requestAnimationFrame(sbFadeStep); }, 1450);
}
function sbFadeTarget() {
  const dragging = Mouse.mode === 'vscrollDrag' || Mouse.mode === 'hscrollDrag';
  return (dragging || Hover.sb || performance.now() - SbFade.last < 1400) ? 1 : 0;
}
function sbFadeStep() {
  SbFade.raf = 0;
  const t = sbFadeTarget();
  if (Math.abs(t - SbFade.alpha) < 0.02) {
    if (SbFade.alpha !== t) { SbFade.alpha = t; requestPaint(); }
    return;                                   /* settled — sleep; the idle timer re-arms on activity */
  }
  SbFade.alpha += (t - SbFade.alpha) * 0.15;
  requestPaint();
  SbFade.raf = requestAnimationFrame(sbFadeStep);
}

/* ---------------- cell commit flash ----------------
 * Brief accent glow on a cell right after its value is written. */
const CellFlashes = { list: [], raf: 0 };
function flashCell(sh, r, c) {
  if (SmoothScroll.reduced) return;
  CellFlashes.list = CellFlashes.list.filter(f => !(f.sid === sh.id && f.r === r && f.c === c));
  CellFlashes.list.push({ sid: sh.id, r, c, t0: performance.now() });
  if (CellFlashes.list.length > 240) CellFlashes.list.splice(0, CellFlashes.list.length - 240);
  if (!CellFlashes.raf) CellFlashes.raf = requestAnimationFrame(flashStep);
}
function flashStep() {
  CellFlashes.raf = 0;
  const now = performance.now();
  CellFlashes.list = CellFlashes.list.filter(f => now - f.t0 < 420);
  requestPaint();
  if (CellFlashes.list.length) CellFlashes.raf = requestAnimationFrame(flashStep);
}
function drawCellFlashes(ctx, sh, L) {
  if (!CellFlashes.list.length) return;
  const now = performance.now();
  ctx.save();
  for (const f of CellFlashes.list) {
    if (f.sid !== sh.id) continue;
    const p = Math.min(1, (now - f.t0) / 420);
    const a = (1 - p) * 0.30;
    if (a <= 0.01) continue;
    const m = mergeAt(sh, f.r, f.c);
    const rect = m ? cellScreenRect(sh, f.r, f.c)
      : { x: colScreenX(sh, f.c), y: rowScreenY(sh, f.r), w: colScreenW(sh, f.c), h: rowScreenH(sh, f.r) };
    if (rect.x > L.w || rect.y > L.h || rect.x + rect.w < L.gridX || rect.y + rect.h < L.gridY) continue;
    ctx.fillStyle = 'rgba(33,115,70,' + a.toFixed(3) + ')';
    roundRect(ctx, rect.x + 0.5, rect.y + 0.5, Math.max(1, rect.w - 1), Math.max(1, rect.h - 1), 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ---------------- number glide: numeric values count smoothly to their new value ----------------
 * When a plain number is replaced by another plain number (typing, paste, fill, undo),
 * the rendered text eases from the old value to the new one (~360 ms) instead of snapping. */
const CellGlides = { map: new Map(), raf: 0 };
function glideNumber(sh, r, c, fromV, toV, fmt) {
  if (SmoothScroll.reduced || document.hidden) return;
  if (typeof fromV !== 'number' || typeof toV !== 'number' || !isFinite(fromV) || !isFinite(toV) || fromV === toV) return;
  const k = sh.id + ':' + r + ':' + c;
  let from = fromV;
  const cur = CellGlides.map.get(k);
  if (cur) {
    const p = Math.min(1, (performance.now() - cur.t0) / cur.dur);
    if (p < 1) from = cur.from + (cur.to - cur.from) * (1 - Math.pow(1 - p, 3));
  }
  CellGlides.map.set(k, { from, to: toV, fmt: fmt || 'General', t0: performance.now(), dur: 360 });
  if (CellGlides.map.size > 400) {          /* bulk operations: keep only the newest entries */
    let n = CellGlides.map.size - 400;
    for (const k2 of CellGlides.map.keys()) { if (n-- <= 0) break; CellGlides.map.delete(k2); }
  }
  if (!CellGlides.raf) CellGlides.raf = requestAnimationFrame(glideStep);
}
function glideStep() {
  CellGlides.raf = 0;
  const now = performance.now();
  for (const [k, g] of CellGlides.map) if (now - g.t0 >= g.dur) CellGlides.map.delete(k);
  requestPaint();
  if (CellGlides.map.size) CellGlides.raf = requestAnimationFrame(glideStep);
}
function glideTextFor(sh, r, c) {
  if (!CellGlides.map.size) return null;
  const k = sh.id + ':' + r + ':' + c;
  const g = CellGlides.map.get(k);
  if (!g) return null;
  const p = Math.min(1, (performance.now() - g.t0) / g.dur);
  if (p >= 1) { CellGlides.map.delete(k); return null; }
  const e = 1 - Math.pow(1 - p, 3);
  let val = g.from + (g.to - g.from) * e;
  if (Number.isInteger(g.from) && Number.isInteger(g.to)) val = Math.round(val);   /* integers count as integers */
  return formatValue(val, g.fmt);
}

/* ---------------- copy marquee marching ants ---------------- */
const MarqueeAnim = { raf: 0, last: 0 };
function startMarqueeAnim() {
  if (SmoothScroll.reduced || MarqueeAnim.raf) return;
  const step = ts => {
    MarqueeAnim.raf = 0;
    if (!Clip.marquee || document.hidden) return;
    if (ts - MarqueeAnim.last > 48) { MarqueeAnim.last = ts; requestPaint(); }
    MarqueeAnim.raf = requestAnimationFrame(step);
  };
  MarqueeAnim.raf = requestAnimationFrame(step);
}

/* ---------------- selection border animation ----------------
 * When a new cell is clicked, the active border glides from the previous
 * active range to the new one (~120 ms). Pointer-driven only: keyboard nav,
 * drag-select and fill/move stay instant so they never lag the cursor. */
const SelAnim = { t0: 0, dur: 120, active: false, raf: 0, from: null, pending: false };
function selAnimEase(p) { return 1 - Math.pow(1 - p, 3); }
function beginSelAnim(from, to) {
  if (SmoothScroll.reduced || !from || !to) return;
  if (from.r1 === to.r1 && from.c1 === to.c1 && from.r2 === to.r2 && from.c2 === to.c2) return;
  SelAnim.from = from;
  SelAnim.t0 = performance.now();
  SelAnim.active = true;
  if (!SelAnim.raf) {
    const step = () => {
      SelAnim.raf = 0;
      if (!SelAnim.active) return;
      if (performance.now() - SelAnim.t0 >= SelAnim.dur) { SelAnim.active = false; requestPaint(); return; }
      requestPaint();
      SelAnim.raf = requestAnimationFrame(step);
    };
    SelAnim.raf = requestAnimationFrame(step);
  }
}
function selAnimP() {
  if (!SelAnim.active) return 1;
  const p = (performance.now() - SelAnim.t0) / SelAnim.dur;
  if (p >= 1) { SelAnim.active = false; return 1; }
  return selAnimEase(Math.max(0, p));
}
function lerpRangeRect(a, b, p) {
  const L = (x, y) => x + (y - x) * p;
  return {
    x: L(a.sx, b.sx), y: L(a.sy, b.sy),
    w: L(a.sw, b.sw), h: L(a.sh, b.sh)
  };
}

/* overlay DOM (filter chips, dv chips, chart frames) repositioning after paint */
let overlaySig = '';
function updateOverlayLayers() {
  const sh = activeSheet();
  const sig = [WB.activeSheetId, Math.round(Scroll.x), Math.round(Scroll.y), VIEW.zoom, VIEW.showHeadings ? 1 : 0, SEL.active.r, SEL.active.c, sh.filter ? 1 : 0, Edit.active ? 1 : 0].join('|');
  if (sig === overlaySig) return;
  overlaySig = sig;
  renderFilterChips();
  updateDvChips();
  repositionCharts();
}
function repositionCharts() {
  const sh = activeSheet();
  const L = R.layout;
  if (!L) return;
  document.querySelectorAll('.chart-frame[data-cid]').forEach(frame => {
    const chart = sh.charts.find(c => c.id === frame.dataset.cid);
    if (!chart) return;
    const x = L.gridX + L.frzW + (chart.x - sumFrozen(sh.cols, L.frzC) - Scroll.x) * VIEW.zoom;
    const y = L.gridY + L.frzH + (chart.y - sumFrozen(sh.rows, L.frzR) - Scroll.y) * VIEW.zoom;
    frame.style.left = x + 'px';
    frame.style.top = y + 'px';
  });
}

/* ==========================================================================
 * 9. INTERACTIONS — MOUSE / SELECTION / EDITING / FILL / MOVE / PAINTER
 * ========================================================================== */
function gridPos(e) {
  const rect = R.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function setupGridEvents() {
R.canvas.addEventListener('mousedown', e => {
  if (e.button !== 0 && e.button !== 2) return;
  const p = gridPos(e);
  /* cross-sheet audit chips are click-to-jump targets */
  if (e.button === 0 && Audit.mode) {
    const chip = auditChipAt(p.x, p.y);
    if (chip) { jumpToAuditChip(chip); e.preventDefault(); return; }
  }
  const hit = hitTest(p.x, p.y);
  closePopups();
  if (PaintState.active) { startPaint(e, hit); e.preventDefault(); return; }
  if (e.button === 2) { handleRightClick(e, hit); return; }
  if (hit.zone === 'corner') { selectAll(); e.preventDefault(); return; }
  if (hit.zone === 'vscroll' || hit.zone === 'hscroll') { startScrollbarDrag(e, hit); e.preventDefault(); return; }
  if (hit.zone === 'colhdr' || hit.zone === 'rowhdr') {
    const edge = hitHeaderEdge(p.x, p.y);
    if (edge) { startResize(e, edge); e.preventDefault(); return; }
    if (hit.zone === 'colhdr') { startHeaderDrag(e, hit, 'col'); }
    else startHeaderDrag(e, hit, 'row');
    e.preventDefault(); return;
  }
  if (hit.zone !== 'grid') return;
  const sh = activeSheet();
  const { r, c } = hit;
  const wasEditing = Edit.active;
  /* fill handle? */
  if (onFillHandle(p.x, p.y)) { startFill(e, p); e.preventDefault(); return; }
  /* editing? */
  if (Edit.active) {
    if (Edit.refMode) { startRefSelect(e, r, c); e.preventDefault(); return; }
    /* clicking away from an UNTOUCHED editor just dismisses it (no write, no
       history noise); a modified editor commits — classic behavior */
    if (UI.editor.value === Edit.origText) cancelEdit(); else commitEditor();
  }
  /* near selection border → move */
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey && nearSelectionBorder(p.x, p.y)) { startMove(e, p); e.preventDefault(); return; }
  /* single-click edit: clicking the already-active cell opens the editor right away
     (inner area only — a narrow strip along the border stays draggable for move) */
  if (!wasEditing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !PaintState.active &&
      SEL.sheetId === WB.activeSheetId && SEL.ranges.length === 1) {
    const act = SEL.active;
    const mm = mergeAt(sh, r, c);
    const ar = mm ? mm.r1 : r, ac = mm ? mm.c1 : c;
    if (ar === act.r && ac === act.c) {
      const rx = colScreenX(sh, ac), ry = rowScreenY(sh, ar);
      const rw = colScreenW(sh, ac), rh = rowScreenH(sh, ar);
      const mg = Math.max(2, Math.min(6, 5 * VIEW.zoom));   /* border strip scales with zoom */
      if (p.x > rx + mg && p.x < rx + rw - mg && p.y > ry + mg * 0.8 && p.y < ry + rh - mg * 0.8) {
        beginEdit(ar, ac, { cursorMode: true });
        e.preventDefault(); return;
      }
    }
  }
  /* normal selection */
  startSelect(e, r, c);
  e.preventDefault();
});

R.canvas.addEventListener('mousemove', e => {
  const p = gridPos(e);
  if (!Mouse.mode) {
    /* hover cursors */
    const hit = hitTest(p.x, p.y);
    let cur = 'default';
    if (Audit.mode && auditChipAt(p.x, p.y)) cur = 'pointer';
    else if (PaintState.active) cur = 'crosshair';
    else if (hit.zone === 'colhdr' || hit.zone === 'rowhdr') {
      const edge = hitHeaderEdge(p.x, p.y);
      cur = edge ? (edge.kind === 'col' ? 'col-resize' : 'row-resize') : (hit.zone === 'colhdr' ? 'default' : 'default');
      if (hit.zone === 'colhdr' && !edge && p.y <= R.layout.gridY) cur = 'default';
    } else if (hit.zone === 'vscroll') cur = 'default';
    else if (hit.zone === 'hscroll') cur = 'default';
    let handleHover = false;
    if (hit.zone === 'grid') {
      if (onFillHandle(p.x, p.y)) { cur = 'crosshair'; handleHover = true; }
      else if (!Edit.active && nearSelectionBorder(p.x, p.y)) cur = 'move';
      else if (Edit.active && Edit.refMode) cur = 'crosshair';
    }
    R.canvas.style.cursor = cur;
    const sbHover = (hit.zone === 'vscroll' || hit.zone === 'hscroll') ? hit.zone : null;
    if (handleHover !== Hover.handle || sbHover !== Hover.sb) {
      Hover.handle = handleHover; Hover.sb = sbHover;
      if (sbHover) sbActivity();
      if (!Edit.active && !Mouse.mode) requestPaint();
    }
    /* header hover highlight */
    const newHover = { col: -1, row: -1 };
    if (hit.zone === 'colhdr') {
      const pc = pointToCellPx(p.x, R.layout.gridY + 0.01);
      if (pc) newHover.col = pc.c;
    } else if (hit.zone === 'rowhdr') {
      const pr = pointToCellPx(R.layout.gridX + 0.01, p.y);
      if (pr) newHover.row = pr.r;
    }
    if (newHover.col !== Hover.col || newHover.row !== Hover.row) {
      Hover.col = newHover.col; Hover.row = newHover.row;
      if (!Edit.active && !Mouse.mode) requestPaint();
    }
    /* note hover popover (stays visible while the pointer is over the popover itself) */
    let overNotePop = false;
    const npop = document.getElementById('note-pop');
    if (npop && !npop.hidden) {
      const nr = npop.getBoundingClientRect();
      overNotePop = e.clientX >= nr.left - 8 && e.clientX <= nr.right + 8 && e.clientY >= nr.top - 8 && e.clientY <= nr.bottom + 8;
    }
    if (hit.zone === 'grid' && !Edit.active && !Mouse.mode) {
      const cell = pointToCellPx(p.x, p.y);
      const shH = activeSheet();
      if (cell && noteAt(shH, cell.r, cell.c)) {
        const nr = cellScreenRect(shH, cell.r, cell.c);
        showNotePopover(shH, cell.r, cell.c, nr);
      } else if (!overNotePop) hideNotePopover();
    } else if (!Edit.active && !overNotePop) hideNotePopover();
    return;
  }
  switch (Mouse.mode) {
    case 'select': {
      autoScroll(p);
      const cell = pointToCellPx(p.x, p.y);
      if (!cell) return;
      const a = Mouse.anchor;
      setSelection(a.r, a.c, cell.r, cell.c, { activeR: a.r, activeC: a.c, keepScroll: true });
      break;
    }
    case 'colSelect': {
      autoScroll(p);
      const cell = pointToCellPx(p.x, p.y + 1);
      if (!cell) return;
      selectEntireColRange(Mouse.anchor.c, cell.c, Mouse.extend);
      break;
    }
    case 'rowSelect': {
      autoScroll(p);
      const cell = pointToCellPx(p.x + 1, p.y);
      if (!cell) return;
      selectEntireRowRange(Mouse.anchor.r, cell.r, Mouse.extend);
      break;
    }
    case 'resizeCol': {
      const sh = activeSheet();
      const w = clamp(Mouse.data.orig + (p.x - Mouse.data.start) / VIEW.zoom, 24, 600);
      sh.cols.set(Mouse.data.index, { size: Math.round(w) });
      showResizeTip('col', Math.round(w), e);
      requestPaint();
      break;
    }
    case 'resizeRow': {
      const sh = activeSheet();
      const h = clamp(Mouse.data.orig + (p.y - Mouse.data.start) / VIEW.zoom, 14, 420);
      sh.rows.set(Mouse.data.index, { size: Math.round(h) });
      showResizeTip('row', Math.round(h), e);
      requestPaint();
      break;
    }
    case 'fill': {
      updateFillDrag(p);
      break;
    }
    case 'move': {
      autoScroll(p);
      const cell = pointToCellPx(p.x, p.y);
      if (!cell) return;
      const dr = cell.r - Mouse.data.grabR, dc = cell.c - Mouse.data.grabC;
      DragState.active = true;
      DragState.to = shiftRange(Mouse.data.from, dr, dc);
      requestPaint();
      break;
    }
    case 'paint': {
      const cell = pointToCellPx(p.x, p.y);
      if (!cell) return;
      Mouse.data.target = normRange(Mouse.data.anchor.r, Mouse.data.anchor.c, cell.r, cell.c);
      requestPaint();
      break;
    }
    case 'refSel': {
      const cell = pointToCellPx(p.x, p.y);
      if (!cell) return;
      Mouse.data.cur = cell;
      updateEditorFromRefSelect();
      break;
    }
    case 'vscrollDrag': {
      sbActivity();
      const shV = activeSheet();
      let m = vThumbMetrics(R.layout);
      const frac = (p.y - Mouse.data.grabOffset - R.layout.gridY - R.layout.frzH) / Math.max(1, m.trackH - R.layout.frzH - m.thumbH);
      if (frac >= 1 && shV.rows.max < MAX_ROWS) { growExtent(shV, shV.rows.max + GRID_STEP, 0); m = vThumbMetrics(R.layout); }
      Scroll.y = clamp(frac * m.maxScroll, 0, m.maxScroll);
      requestPaint();
      break;
    }
    case 'hscrollDrag': {
      sbActivity();
      const shH = activeSheet();
      let m2 = hThumbMetrics(R.layout);
      const fracX = (p.x - Mouse.data.grabOffset - R.layout.gridX - R.layout.frzW) / Math.max(1, m2.trackW - R.layout.frzW - m2.thumbW);
      if (fracX >= 1 && shH.cols.max < MAX_COLS) { growExtent(shH, 0, shH.cols.max + GRID_STEP); m2 = hThumbMetrics(R.layout); }
      Scroll.x = clamp(fracX * m2.maxScroll, 0, m2.maxScroll);
      requestPaint();
      break;
    }
  }
});

window.addEventListener('mouseup', e => {
  const mode = Mouse.mode;
  if (!mode) return;
  const p = gridPos(e);
  switch (mode) {
    case 'select': break;
    case 'colSelect': case 'rowSelect': break;
    case 'resizeCol': {
      const sh = activeSheet();
      /* capture BEFORE Mouse.data is cleared on mouseup — closures must not read it lazily */
      const idx = Mouse.data.index, origMeta = Mouse.data.origMeta;
      const after = sh.cols.get(idx).size;
      pushHistory({
        label: 'Column width',
        undo: () => { sh.cols.set(idx, origMeta); requestPaint(); },
        redo: () => { sh.cols.set(idx, { size: after }); requestPaint(); }
      });
      break;
    }
    case 'resizeRow': {
      const sh = activeSheet();
      const idx = Mouse.data.index, origMeta = Mouse.data.origMeta;
      const after = sh.rows.get(idx).size;
      pushHistory({
        label: 'Row height',
        undo: () => { sh.rows.set(idx, origMeta); requestPaint(); },
        redo: () => { sh.rows.set(idx, { size: after }); requestPaint(); }
      });
      break;
    }
    case 'fill': finishFill(); break;
    case 'move': finishMove(); break;
    case 'paint': finishPaint(); break;
    case 'refSel': finishRefSelect(); break;
    case 'vscrollDrag': case 'hscrollDrag': break;
  }
  Mouse.mode = null; Mouse.data = null;
  hideResizeTip();
  if (!DragState.keep) { DragState.active = false; DragState.to = null; }
  R.canvas.style.cursor = 'default';
  requestPaint();
});

R.canvas.addEventListener('dblclick', e => {
  const p = gridPos(e);
  const hit = hitTest(p.x, p.y);
  if (hit.zone === 'colhdr' || hit.zone === 'rowhdr') {
    const edge = hitHeaderEdge(p.x, p.y);
    if (edge) { autoFitSize(edge.kind, edge.index); }
    return;
  }
  if (hit.zone !== 'grid') return;
  const m = mergeAt(activeSheet(), hit.r, hit.c);
  beginEdit(hit.r, hit.c, { cursorMode: true });
});

R.canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const zm = clamp(VIEW.zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.1, 4);
    setZoom(zm);
    return;
  }
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey ? (e.shiftKey ? e.deltaY : e.deltaX) : 0;
  const dy = dx ? 0 : e.deltaY;
  smoothScrollBy(dx * 1.1, dy * 1.1);
}, { passive: false });

R.canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
});
}

function handleRightClick(e, hit) {
  if (hit.zone === 'grid') {
    const inside = SEL.ranges.some(rg => hit.r >= rg.r1 && hit.r <= rg.r2 && hit.c >= rg.c1 && hit.c <= rg.c2);
    if (!inside) {
      if (Edit.active) commitEditor();
      setSelection(hit.r, hit.c, hit.r, hit.c);
    }
    showCellContextMenu(e.clientX, e.clientY);
  } else if (hit.zone === 'rowhdr') {
    if (!SEL.ranges.some(rg => isRowSelection(rg) && hit.r >= rg.r1 && hit.r <= rg.r2)) selectEntireRow(hit.r, false);
    showRowContextMenu(e.clientX, e.clientY);
  } else if (hit.zone === 'colhdr') {
    if (!SEL.ranges.some(rg => isColSelection(rg) && hit.c >= rg.c1 && hit.c <= rg.c2)) selectEntireCol(hit.c, false);
    showColContextMenu(e.clientX, e.clientY);
  }
}

function autoScroll(p) {
  const L = R.layout;
  const m = 26, speed = 18;
  if (p.y > L.gridY && p.y < L.h - L.sb && p.x > L.gridX && p.x < L.w - L.sb) {
    let dx = 0, dy = 0;
    if (p.x < L.gridX + L.frzW + m) dx = -speed; else if (p.x > L.w - L.sb - m) dx = speed;
    if (p.y < L.gridY + L.frzH + m) dy = -speed; else if (p.y > L.h - L.sb - m) dy = speed;
    if (dx || dy) { scrollByPx(dx, dy); }
  }
}

function onFillHandle(px, py) {
  if (Edit.active) return false;
  const sh = activeSheet();
  const fr = activeSelRange();
  if (fr.r1 === 0 && fr.c1 === 0 && fr.r2 >= MAX_ROWS - 1) return false;
  const hx = colScreenX(sh, fr.c2) + colScreenW(sh, fr.c2);
  const hy = rowScreenY(sh, fr.r2) + rowScreenH(sh, fr.r2);
  return Math.abs(px - hx) <= 6 && Math.abs(py - hy) <= 6;
}
function nearSelectionBorder(px, py) {
  if (Edit.active || SEL.ranges.length !== 1) return false;
  const sh = activeSheet();
  const rg = activeSelRange();
  if (rg.r1 === 0 && rg.c1 === 0 && rg.r2 >= MAX_ROWS - 1 && rg.c2 >= MAX_COLS - 1) return false;
  const x0 = colScreenX(sh, rg.c1), y0 = rowScreenY(sh, rg.r1);
  const x1 = colScreenX(sh, rg.c2) + colScreenW(sh, rg.c2), y1 = rowScreenY(sh, rg.r2) + rowScreenH(sh, rg.r2);
  const tol = 4;
  const inside = px > x0 + tol && px < x1 - tol && py > y0 + tol && py < y1 - tol;
  if (inside) return false;
  const nearX = (px >= x0 - tol && px <= x1 + tol);
  const nearY = (py >= y0 - tol && py <= y1 + tol);
  return (nearX && nearY);
}
function shiftRange(rg, dr, dc) {
  return normalizeSelRange(rg.r1 + dr, rg.c1 + dc, rg.r2 + dr, rg.c2 + dc);
}
function startSelect(e, r, c) {
  const sh = activeSheet();
  const m = mergeAt(sh, r, c);
  if (m) { r = m.r1; c = m.c1; }
  r = nextVisibleRow(sh, r, 1); c = nextVisibleCol(sh, c, 1);
  SelAnim.pending = true;   /* pointer-driven change: glide the active border */
  if (e.shiftKey && SEL.ranges.length) {
    const a = SEL.active;
    setSelection(a.r, a.c, r, c, { activeR: a.r, activeC: a.c, keepScroll: true });
    Mouse.mode = 'select'; Mouse.anchor = a;
  } else if (e.ctrlKey || e.metaKey) {
    const m2 = mergeAt(sh, r, c);
    addSelectionRange(r, c, r, c, r, c);
    Mouse.mode = 'select'; Mouse.anchor = { r, c };
    Mouse.extendCtrl = true;
  } else {
    setSelection(r, c, r, c, { keepScroll: e.detail > 0 ? true : false });
    Mouse.mode = 'select'; Mouse.anchor = { r, c };
  }
}
function startHeaderDrag(e, hit, kind) {
  const idx = kind === 'col' ? hit.c : hit.r;
  const extend = e.shiftKey;
  SelAnim.pending = true;
  if (e.ctrlKey || e.metaKey) {
    if (kind === 'col') addSelectionRange(0, idx, MAX_ROWS - 1, idx, 0, idx);
    else addSelectionRange(idx, 0, idx, MAX_COLS - 1, idx, 0);
  } else if (kind === 'col') selectEntireCol(idx, extend);
  else selectEntireRow(idx, extend);
  Mouse.mode = kind === 'col' ? 'colSelect' : 'rowSelect';
  Mouse.anchor = { r: idx, c: idx };
  Mouse.extend = extend;
}
function selectEntireColRange(c1, c2, extend) {
  const n = normRange(c1, 0, c2, 0);
  if (extend && SEL.ranges.length) {
    const rg = SEL.ranges[SEL.activeIdx];
    SEL.ranges[SEL.activeIdx] = normalizeSelRange(rg.r1, Math.min(rg.c1, n.c1, n.c2), rg.r2, Math.max(rg.c2, n.c1, n.c2));
  } else SEL.ranges = [normalizeSelRange(0, n.c1, MAX_ROWS - 1, n.c2)];
  onSelectionChanged();
}
function selectEntireRowRange(r1, r2, extend) {
  const n = normRange(r1, 0, r2, 0);
  if (extend && SEL.ranges.length) {
    const rg = SEL.ranges[SEL.activeIdx];
    SEL.ranges[SEL.activeIdx] = normalizeSelRange(Math.min(rg.r1, n.r1, n.r2), rg.c1, Math.max(rg.r2, n.r1, n.r2), rg.c2);
  } else SEL.ranges = [normalizeSelRange(n.r1, 0, n.r2, MAX_COLS - 1)];
  onSelectionChanged();
}
function startResize(e, edge) {
  const sh = activeSheet();
  const p = gridPos(e);
  if (edge.kind === 'col') {
    const meta = sh.cols.get(edge.index);
    Mouse.mode = 'resizeCol';
    Mouse.data = { index: edge.index, start: p.x, orig: meta.size == null ? DEF.colW : meta.size, origMeta: meta.size == null ? {} : { size: meta.size } };
  } else {
    const meta = sh.rows.get(edge.index);
    Mouse.mode = 'resizeRow';
    Mouse.data = { index: edge.index, start: p.y, orig: meta.size == null ? DEF.rowH : meta.size, origMeta: meta.size == null ? {} : { size: meta.size } };
  }
}
function startScrollbarDrag(e, hit) {
  cancelSmoothScroll();
  sbActivity();
  const p = gridPos(e);
  if (hit.zone === 'vscroll') {
    const m = vThumbMetrics(R.layout);
    if (p.y >= m.thumbY && p.y <= m.thumbY + m.thumbH) { Mouse.mode = 'vscrollDrag'; Mouse.data = { grabOffset: p.y - m.thumbY }; }
    else {
      const page = (p.y < m.thumbY ? -1 : 1) * (R.layout.gridH / VIEW.zoom) * 0.9;
      smoothScrollBy(0, page);
    }
  } else {
    const m = hThumbMetrics(R.layout);
    if (p.x >= m.thumbX && p.x <= m.thumbX + m.thumbW) { Mouse.mode = 'hscrollDrag'; Mouse.data = { grabOffset: p.x - m.thumbX }; }
    else {
      const page = (p.x < m.thumbX ? -1 : 1) * (R.layout.gridW / VIEW.zoom) * 0.9;
      smoothScrollBy(page, 0);
    }
  }
}
function startMove(e, p) {
  const rg = activeSelRange();
  const cell = pointToCellPx(p.x, p.y);
  Mouse.mode = 'move';
  Mouse.data = { from: Object.assign({}, rg), grabR: cell.r, grabC: cell.c };
  DragState.active = false; DragState.to = null;
}
function startPaint(e, hit) {
  if (hit.zone !== 'grid') { cancelPaint(); return; }
  Mouse.mode = 'paint';
  const m = mergeAt(activeSheet(), hit.r, hit.c);
  Mouse.data = { anchor: m ? { r: m.r1, c: m.c1 } : { r: hit.r, c: hit.c }, target: null };
}
function finishPaint() {
  if (!Mouse.data || !Mouse.data.target) { cancelPaint(); return; }
  applyPaint(Mouse.data.target);
  if (!PaintState.sticky) cancelPaint();
  Mouse.data.target = null;
}
function cancelPaint() {
  PaintState.active = false; PaintState.sticky = false; PaintState.style = null; PaintState.ranges = null;
  $('#grid-area').classList.remove('painting');
}
function startFill(e, p) {
  const rg = activeSelRange();
  Mouse.mode = 'fill';
  Mouse.data = { source: Object.assign({}, rg), start: p, target: null, dir: null };
  $('#fill-tip').style.display = 'none';
}

/* floating size badge while resizing columns/rows ("Width: 128") */
function showResizeTip(kind, size, e) {
  const tip = $('#size-tip');
  if (!tip) return;
  tip.innerHTML = (kind === 'col' ? 'Width: ' : 'Height: ') + '<b>' + size + '</b> px';
  tip.style.display = 'block';
  const area = $('#grid-area').getBoundingClientRect();
  const x = (e.clientX ? e.clientX - area.left : 0) + 14;
  const y = (e.clientY ? e.clientY - area.top : 0) + 16;
  tip.style.left = Math.min(x, area.width - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(y, area.height - 26) + 'px';
}
function hideResizeTip() {
  const tip = $('#size-tip');
  if (tip) tip.style.display = 'none';
}
function updateFillDrag(p) {
  const sh = activeSheet();
  const src = Mouse.data.source;
  const cell = pointToCellPx(p.x, p.y);
  if (!cell) return;
  const dr = cell.r - src.r2, dc = cell.c - src.c2;
  let dir;
  if (Math.abs(dr) >= Math.abs(dc)) dir = dr > 0 ? 'down' : dr < 0 ? 'up' : null;
  else dir = dc > 0 ? 'right' : dc < 0 ? 'left' : null;
  if (!dir && cell.r >= src.r1 && cell.r <= src.r2 && cell.c >= src.c1 && cell.c <= src.c2) { Mouse.data.target = null; $('#fill-tip').style.display = 'none'; requestPaint(); return; }
  let target = null;
  if (dir === 'down') target = normalizeSelRange(src.r2 + 1, src.c1, cell.r, src.c2);
  else if (dir === 'up') target = normalizeSelRange(cell.r, src.c1, src.r1 - 1, src.c2);
  else if (dir === 'right') target = normalizeSelRange(src.r1, src.c2 + 1, src.r2, cell.c);
  else if (dir === 'left') target = normalizeSelRange(src.r1, cell.c, src.r2, src.c1 - 1);
  Mouse.data.dir = dir;
  Mouse.data.target = (target && target.r1 <= target.r2 && target.c1 <= target.c2) ? target : null;
  /* tip */
  if (Mouse.data.target) {
    const preview = previewFillValue(src, Mouse.data.target, dir);
    const tip = $('#fill-tip');
    tip.textContent = preview == null ? '' : String(preview);
    tip.style.display = preview == null ? 'none' : 'block';
    const tr = cellScreenRect(sh, cell.r, cell.c);
    tip.style.left = (tr.x + tr.w + 8) + 'px';
    tip.style.top = (tr.y + (tr.h - 18) / 2) + 'px';
  } else $('#fill-tip').style.display = 'none';
  requestPaint();
}
function finishFill() {
  $('#fill-tip').style.display = 'none';
  if (!Mouse.data || !Mouse.data.target || !Mouse.data.dir) { Mouse.data = null; return; }
  performFill(Mouse.data.source, Mouse.data.target, Mouse.data.dir, 'smart');
}

/* ---------------- FILL LOGIC ---------------- */
function previewFillValue(src, target, dir) {
  const sh = activeSheet();
  const vertical = dir === 'up' || dir === 'down';
  const srcLine = vertical ? collectLine(sh, src.r1, src.c1, src.r2 - src.r1 + 1, 0) : collectLine(sh, src.r1, src.c1, src.c2 - src.c1 + 1, 1);
  const next = extrapolateNext(srcLine, dir === 'up' || dir === 'left' ? -1 : 1);
  return next;
}
function collectLine(sh, r, c, len, axis) {
  const out = [];
  for (let i = 0; i < len; i++) {
    const rr = axis === 0 ? r + i : r, cc = axis === 1 ? c + i : c;
    const cell = sh.cells.get(key(rr, cc));
    out.push(cell ? (cell.f ? '=' + cell.f : cell.v) : null);
  }
  return out;
}
function extrapolateNext(line, dirSign) {
  const vals = line;
  const nums = vals.filter(v => typeof v === 'number');
  if (vals.length === 1) {
    const v = vals[0];
    if (typeof v === 'number') return dirSign > 0 ? v : v; // single number copies by default, series only via Ctrl — tip shows same
    if (typeof v === 'string') {
      const m = /^(.*?)(\d+)(\D*)$/.exec(v);
      if (m && m[2].length < 9) return m[1] + (parseInt(m[2], 10) + dirSign) + m[3];
      return v;
    }
    return v;
  }
  if (nums.length === vals.length && nums.length >= 2) {
    const step = (nums[nums.length - 1] - nums[0]) / (nums.length - 1);
    const last = dirSign > 0 ? nums[nums.length - 1] : nums[0];
    return Math.round((last + step * dirSign) * 1e10) / 1e10;
  }
  if (vals.every(v => typeof v === 'string')) {
    const v = dirSign > 0 ? vals[vals.length - 1] : vals[0];
    const m = /^(.*?)(\d+)(\D*)$/.exec(v);
    if (m) return m[1] + (parseInt(m[2], 10) + dirSign) + m[3];
    return v;
  }
  return dirSign > 0 ? vals[vals.length - 1] : vals[0];
}
function performFill(src, target, dir, mode) {
  const sh = activeSheet();
  const vertical = dir === 'up' || dir === 'down';
  const forward = dir === 'down' || dir === 'right';
  const srcLen = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1;
  const tgtLen = vertical ? target.r2 - target.r1 + 1 : target.c2 - target.c1 + 1;
  const changes = [];
  const before = snapshotRegion(sh, target);
  const srcData = [];
  for (let i = 0; i < srcLen; i++) {
    const rr = vertical ? (forward ? src.r1 + i : src.r2 - i) : src.r1;
    const cc = vertical ? src.c1 : (forward ? src.c1 + i : src.c2 - i);
    const cell = sh.cells.get(key(rr, cc));
    srcData.push(cell ? { v: cell.v, f: cell.f, s: cell.s } : null);
  }
  const lineVals = srcData.map(d => d ? (d.f ? d.f : d.v) : null);
  const allNums = lineVals.every(v => typeof v === 'number') && lineVals.length >= 2;
  const step = allNums ? (lineVals[lineVals.length - 1] - lineVals[0]) / (lineVals.length - 1) : 0;

  for (let i = 0; i < tgtLen; i++) {
    const rr = vertical ? (forward ? target.r1 + i : target.r2 - i) : target.r1;
    const cc = vertical ? target.c1 : (forward ? target.c1 + i : target.c2 - i);
    const srcIdx = forward ? (i % srcLen) : (srcLen - 1 - (i % srcLen));
    const sd = srcData[srcIdx];
    if (mode === 'formats') { changes.push({ r: rr, c: cc, cell: sd ? { v: null, f: null, s: sd.s } : { v: null, f: null, s: null } }); continue; }
    if (!sd) { changes.push({ r: rr, c: cc, cell: null }); continue; }
    let v = sd.v, f = sd.f;
    if (mode === 'smart' && f) {
      // shift relative references by the actual positional delta between source cell and target cell
      const sr = vertical ? (forward ? src.r1 + (srcIdx % srcLen) : src.r2 - (srcIdx % srcLen)) : src.r1;
      const sc = vertical ? src.c1 : (forward ? src.c1 + (srcIdx % srcLen) : src.c2 - (srcIdx % srcLen));
      f = shiftFormulaRefs(sd.f, rr - sr, cc - sc);
      v = sd.v;
    } else if (mode === 'smart' && typeof sd.v === 'number') {
      if (srcLen === 1) { v = sd.v; } // single number: copy (default)
      else if (allNums) {
        const base = forward ? lineVals[lineVals.length - 1] : lineVals[0];
        const n = forward ? i + 1 : tgtLen - i;
        v = Math.round((base + step * n) * 1e10) / 1e10;
      }
    } else if (mode === 'smart' && typeof sd.v === 'string' && srcLen === 1) {
      const m = /^(.*?)(\d+)(\D*)$/.exec(sd.v);
      if (m) {
        const n = parseInt(m[2], 10) + (forward ? i + 1 : -(i + 1));
        v = m[1] + n + m[3];
      }
    } else if (mode === 'series' && typeof sd.v === 'number' && srcLen === 1) {
      v = forward ? sd.v + (i + 1) : sd.v - (i + 1);
    }
    changes.push({ r: rr, c: cc, cell: { v, f: f || null, s: sd.s } });
  }
  applyRegionChanges(sh, target, changes, before, 'Fill');
  FillState.last = { source: src, target, dir };
  showFillOptionsChip(src, target, dir);
}
function snapshotRegion(sh, rg) {
  const out = {};
  for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
    const cell = sh.cells.get(key(r, c));
    if (cell && !isCellEmpty(cell)) out[key(r, c)] = snapOf(cell);
  }
  return out;
}
function clampSelectionToSheet() {
  for (let i = 0; i < SEL.ranges.length; i++) {
    const rg = SEL.ranges[i];
    SEL.ranges[i] = normalizeSelRange(rg.r1, rg.c1, rg.r2, rg.c2);
  }
  SEL.active.r = clamp(SEL.active.r, 0, MAX_ROWS - 1);
  SEL.active.c = clamp(SEL.active.c, 0, MAX_COLS - 1);
}
function applyRegionChanges(sh, rg, changes, before, label) {
  batchHistory(() => {
    for (const ch of changes) {
      const afterCell = ch.cell ? snapOf(Object.assign({}, ch.cell, { s: ch.cell.s })) : null;
      const prev = sh.cells.get(key(ch.r, ch.c));
      const prevSnap = prev ? snapOf(prev) : null;
      if (ch.cell) writeCell(sh, ch.r, ch.c, { v: ch.cell.v, f: ch.cell.f, s: ch.cell.s });
      else writeCell(sh, ch.r, ch.c, { v: null, f: null, s: null });
      pushHistory(histCellChange(sh, ch.r, ch.c, prevSnap, afterCell));
    }
  }, label || 'Edit');
  clampSelectionToSheet();
  requestPaint(); updateStatusBar(); updateFormulaBar(); renderChartsLayer(); Persistence.markDirty();
}
function showFillOptionsChip(src, target, dir) {
  const sh = activeSheet();
  const old = $('#fill-options-chip');
  if (old) old.remove();
  const x = colScreenX(sh, target.c2) + colScreenW(sh, target.c2) + 6;
  const y = rowScreenY(sh, target.r2) + rowScreenH(sh, target.r2) + 4;
  const chip = el('<div id="fill-options-chip" role="menu" aria-label="Auto Fill Options"><button class="foc-btn" data-m="smart" title="Fill Series">▤</button><button class="foc-btn" data-m="copy" title="Copy Cells">⧉</button><button class="foc-btn" data-m="formats" title="Fill Formatting Only">༚</button><button class="foc-btn" data-m="noFormats" title="Fill Without Formatting">༚؎</button><button class="foc-btn foc-x" title="Close">✕</button></div>');
  $('#grid-area').appendChild(chip);
  chip.style.left = clamp(x, 0, R.layout.w - 120) + 'px';
  chip.style.top = clamp(y, 0, R.layout.h - 30) + 'px';
  chip.addEventListener('click', e => {
    const m = e.target.getAttribute && e.target.getAttribute('data-m');
    if (m) {
      performFill(FillState.last.source, FillState.last.target, FillState.last.dir, m);
      chip.remove();
    } else chip.remove();
    e.stopPropagation();
  });
  setTimeout(() => {
    const close = ev => { if (!chip.contains(ev.target)) { chip.remove(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  }, 0);
}

function finishMove() {
  if (!DragState.active || !DragState.to) { DragState.active = false; DragState.to = null; return; }
  const from = DragState.from, to = DragState.to;
  DragState.active = false; DragState.to = null;
  if (from.r1 === to.r1 && from.c1 === to.c1) return;
  performMove(from, to);
}
function performMove(from, to) {
  const sh = activeSheet();
  const before = { src: snapshotRegion(sh, from), dst: snapshotRegion(sh, to) };
  const srcCells = [];
  for (let r = from.r1; r <= from.r2; r++) for (let c = from.c1; c <= from.c2; c++) {
    const cell = sh.cells.get(key(r, c));
    srcCells.push({ r, c, cell: cell ? { v: cell.v, f: cell.f, s: cell.s } : null });
  }
  batchHistory(() => {
    for (const s of srcCells) {
      if (s.cell) writeCell(sh, s.r, s.c, { v: null, f: null, s: null });
    }
    for (const s of srcCells) {
      const tr = to.r1 + (s.r - from.r1), tc = to.c1 + (s.c - from.c1);
      if (!s.cell) continue;
      const f = s.cell.f ? shiftFormulaRefs(s.cell.f, to.r1 - from.r1, to.c1 - from.c1) : null;
      writeCell(sh, tr, tc, { v: s.cell.v, f, s: s.cell.s });
    }
  }, 'Move cells');
  const after = { src: snapshotRegion(sh, from), dst: snapshotRegion(sh, to) };
  pushHistory({
    label: 'Move cells',
    undo() { restoreRegion(sh, from, before.src); restoreRegion(sh, to, before.dst); },
    redo() { restoreRegion(sh, from, after.src); restoreRegion(sh, to, after.dst); }
  });
  setSelection(to.r1, to.c1, to.r2, to.c2);
  renderChartsLayer(); /* moved cells may feed charts — keep bars/labels live */
  Persistence.markDirty();
}
function restoreRegion(sh, rg, snap) {
  for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
    const s = snap[key(r, c)];
    if (s) writeCell(sh, r, c, s);
    else writeCell(sh, r, c, { v: null, f: null, s: null });
  }
  rebuildAllDeps();
}

/* ---------------- Format painter ---------------- */
function startFormatPainter(sticky) {
  const sh = activeSheet();
  const rg = activeSelRange();
  const styles = [];
  for (let r = rg.r1; r <= Math.min(rg.r2, rg.r1 + 99); r++) {
    const row = [];
    for (let c = rg.c1; c <= Math.min(rg.c2, rg.c1 + 99); c++) {
      const cell = sh.cells.get(key(r, c));
      row.push(cell && cell.s ? Object.assign({}, cell.s) : null);
    }
    styles.push(row);
  }
  PaintState.active = true; PaintState.sticky = !!sticky;
  PaintState.style = styles; PaintState.ranges = rg;
  $('#grid-area').classList.add('painting');
  toast(sticky ? 'Format Painter is sticky — press Esc to stop' : 'Click cells to paste the formatting', 'info');
}
function applyPaint(target) {
  const sh = activeSheet();
  const styles = PaintState.style;
  const shH = styles.length, shW = styles[0].length;
  batchHistory(() => {
    for (let r = target.r1; r <= target.r2; r++) {
      for (let c = target.c1; c <= target.c2; c++) {
        const s = styles[(r - target.r1) % shH][(c - target.c1) % shW];
        const prev = sh.cells.get(key(r, c));
        const prevSnap = prev ? snapOf(prev) : null;
        writeCell(sh, r, c, { s: s ? normStyle(s) : null });
        const nowC = sh.cells.get(key(r, c));
        pushHistory(histCellChange(sh, r, c, prevSnap, nowC ? snapOf(nowC) : null));
      }
    }
  }, 'Format painter');
}

/* ---------------- In-cell editing ---------------- */
function beginEdit(r, c, opts = {}) {
  const sh = activeSheet();
  const cell = sh.cells.get(key(r, c));
  const info = displayValue(sh, r, c);
  const rect = cellScreenRect(sh, r, c);
  const ed = UI.editor;
  Edit.active = true; Edit.r = r; Edit.c = c;
  Edit.cursorMode = !!opts.cursorMode;
  Edit.fromFormulaBar = !!opts.fromFormulaBar;
  let initial = opts.initial != null ? opts.initial : (cell ? (cell.f != null ? cell.f : rawValueText(cell)) : '');
  ed.value = initial;
  /* smooth open: skip size transitions on the first frame, then pop in */
  ed.classList.add('no-anim');
  ed.style.display = 'block';
  positionEditor(rect, initial);
  ed.style.font = cellFontCss(cell && cell.s, VIEW.zoom);
  ed.style.color = (cell && cell.s && cell.s.color) || '#1a1a1a';
  ed.style.background = '#fff';
  ed.style.textAlign = (cell && cell.s && cell.s.halign) || 'left';
  void ed.offsetWidth;   /* flush styles so opening never animates from a stale size */
  ed.classList.remove('no-anim');
  ed.classList.remove('ed-pop'); void ed.offsetWidth; ed.classList.add('ed-pop');
  Edit.refMode = false;
  Edit.lastRef = null;
  Edit.origText = initial;
  /* point-reference (click-to-insert) mode is for DELIBERATE formula entry only —
     typing "=" on the grid. It must NOT engage when the editor auto-opened on a
     plain click over a cell that already holds a formula: there the next click
     on another cell has to simply commit and move the selection. */
  if (opts.initial != null && initial.startsWith('=')) setRefMode(true);
  if (!Edit.cursorMode) { ed.setSelectionRange(initial.length, initial.length); ed.focus(); }
  else { ed.setSelectionRange(initial.length, initial.length); ed.focus(); }
  updateFormulaBarForEdit(initial);
  requestPaint();
}
function rawValueText(cell) {
  if (!cell) return '';
  if (cell.f != null) return cell.f;
  if (cell.v == null) return '';
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
  if (typeof cell.v === 'number') return generalNum(cell.v);
  return String(cell.v);
}
function cellFontCss(style, zoom) {
  const s = style || {};
  const fs = Math.max(6, (s.fontSize || DEF.fontPt) * (96 / 72) * zoom);
  return (s.italic ? 'italic ' : '') + (s.bold ? '700 ' : '400 ') + fs + 'px "' + (s.fontFamily || DEF.fontFamily) + '", Calibri, sans-serif';
}
function positionEditor(rect, text) {
  const ed = UI.editor;
  const minW = Math.max(rect.w, 60);
  ed.style.left = rect.x + 'px';
  ed.style.top = rect.y + 'px';
  ed.style.minWidth = minW + 'px';
  ed.style.height = rect.h + 'px';
  ed.style.lineHeight = (rect.h - 4) + 'px';
  /* grow width to content */
  const meas = UI.measureCtx;
  meas.font = ed.style.font;
  const lines = text.split('\n');
  let w = 0;
  for (const ln of lines) w = Math.max(w, meas.measureText(ln || ' ').width + 14);
  ed.style.width = Math.min(Math.max(w, minW), Math.max(minW, R.layout.w - rect.x - 8)) + 'px';
}
function setRefMode(on) {
  Edit.refMode = on;
  UI.editor.classList.toggle('ref-mode', on);
}
function updateEditorFromRefSelect() {
  const d = Mouse.data;
  const a = d.anchor, cur = d.cur;
  const rg = normRange(a.r, a.c, cur.r, cur.c);
  const sh = activeSheet();
  /* classic behavior: picking cells inserts RELATIVE references (F4 cycles the
     absolute forms) — and the reference lands at the editor's caret */
  const txt = (d.baseSheet === sh.id ? '' : (needsQuote(sh.name) ? "'" + sh.name + "'" : sh.name) + '!') + addr(rg.r1, rg.c1) + (rg.r1 === rg.r2 && rg.c1 === rg.c2 ? '' : ':' + addr(rg.r2, rg.c2));
  d.refText = txt;
  d.refStart = d.pre.length;
  const ed = UI.editor;
  ed.value = d.pre + txt + d.post;
  const caret = d.refStart + txt.length;
  ed.setSelectionRange(caret, caret);
  positionEditor(cellScreenRect(sh, Edit.r, Edit.c), ed.value);
  updateFormulaBarForEdit(ed.value);
  requestPaint();
}
function startRefSelect(e, r, c) {
  const ed = UI.editor;
  const pos = ed.selectionStart == null ? ed.value.length : ed.selectionStart;
  const end = ed.selectionEnd == null ? pos : ed.selectionEnd;
  Mouse.mode = 'refSel';
  /* insert the picked reference at the caret, replacing any selected text */
  Mouse.data = { pre: ed.value.slice(0, pos), post: ed.value.slice(end), anchor: { r, c }, cur: { r, c }, baseSheet: WB.activeSheetId, refText: '', refStart: pos };
  updateEditorFromRefSelect();
}
function finishRefSelect() {
  if (Mouse.data && Mouse.data.refText) {
    const d = Mouse.data;
    UI.editor.value = d.pre + d.refText + d.post;
    UI.editor.focus();
    const caret = d.refStart + d.refText.length;
    UI.editor.setSelectionRange(caret, caret);
    /* remember the inserted span so F4 can cycle its absolute forms */
    Edit.lastRef = { start: d.refStart, len: d.refText.length };
  }
}
function cancelEdit() {
  if (!Edit.active) return;
  Edit.active = false;
  UI.editor.style.display = 'none';
  UI.editor.value = '';
  setRefMode(false);
  hideFormulaAC();
  hideArgTip();
  updateFormulaBar();
  requestPaint();
  if (!Edit.fromFormulaBar) UI.formulaInput.blur();
}
function commitEditor(move) {
  if (!Edit.active) return;
  const sh = activeSheet();
  const r = Edit.r, c = Edit.c;
  const text = UI.editor.value;
  Edit.active = false;
  UI.editor.style.display = 'none';
  UI.editor.value = '';
  setRefMode(false);
  hideFormulaAC();
  hideArgTip();
  commitCellValue(sh, r, c, text);
  if (move === 'down' || move === true) jumpRelative(1, 0);
  else if (move === 'up') jumpRelative(-1, 0);
  else if (move === 'right') jumpRelative(0, 1);
  else if (move === 'left') jumpRelative(0, -1);
  updateFormulaBar();
  requestPaint();
  if (!Edit.fromFormulaBar) UI.formulaInput.blur();
}
function commitCellValue(sh, r, c, text) {
  flashCell(sh, r, c);
  const prev = sh.cells.get(key(r, c));
  const prevSnap = prev ? snapOf(prev) : null;
  if (text === '' ) {
    // clear contents but keep format
    writeCell(sh, r, c, { v: null, f: null });
    pushHistory(histCellChange(sh, r, c, prevSnap, sh.cells.get(key(r, c)) ? snapOf(sh.cells.get(key(r, c))) : null));
    afterCellCommit(sh, r, c);
    return;
  }
  const parsed = parseUserInput(text);
  const existing = prev && prev.s ? prev.s : null;
  let sPatch;
  if (parsed.s) sPatch = normStyle(Object.assign({}, existing ? Object.assign({}, existing) : {}, parsed.s));
  else sPatch = existing;
  const snapAfter = { v: parsed.f !== undefined ? null : (parsed.v !== undefined ? parsed.v : null), f: parsed.f !== undefined ? parsed.f : null, s: sPatch };
  writeCell(sh, r, c, { v: snapAfter.v, f: snapAfter.f, s: snapAfter.s });
  pushHistory(histCellChange(sh, r, c, prevSnap, snapAfter));
  /* data validation */
  const dvErr = validateCell(sh, r, c);
  if (dvErr) handleValidationError(sh, r, c, dvErr, prevSnap);
  afterCellCommit(sh, r, c);
}
function afterCellCommit(sh, r, c) {
  if (sh.filter) applyFilter(sh);
  updateStatusBar();
  renderChartsLayer();
  requestPaint();
}
function jumpRelative(dr, dc) {
  const sh = activeSheet();
  let r = SEL.active.r + dr, c = SEL.active.c + dc;
  r = nextVisibleRow(sh, clamp(r, 0, MAX_ROWS - 1), dr || 1);
  c = nextVisibleCol(sh, clamp(c, 0, MAX_COLS - 1), dc || 1);
  setSelection(r, c, r, c);
}

/* ---------------- Formula AutoComplete (function suggestions) ---------------- */
const FxAC = { el: null, open: false, items: [], idx: 0, host: null };
function ensureFormulaAC() {
  if (FxAC.el) return FxAC.el;
  const el = document.createElement('div');
  el.id = 'formula-ac';
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', 'Formula suggestions');
  document.getElementById('grid-area').appendChild(el);
  el.addEventListener('mousedown', e => {
    const it = e.target.closest('.fx-ac-item');
    if (it) { e.preventDefault(); e.stopPropagation(); acceptFormulaAC(+it.dataset.i); }
  });
  FxAC.el = el;
  return el;
}
function hideFormulaAC() {
  if (FxAC.el) { FxAC.el.classList.remove('open'); FxAC.el.innerHTML = ''; }
  FxAC.open = false; FxAC.items = []; FxAC.idx = 0; FxAC.host = null;
}
function currentFnToken(text, pos) {
  if (!text || !text.startsWith('=')) return null;
  const upto = text.slice(0, pos == null ? text.length : pos);
  const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(upto);
  if (!m) return null;
  const before = upto.slice(0, upto.length - m[1].length);
  if (before.endsWith("'")) return null;          // inside quoted sheet name
  if (/[0-9]$/.test(before) && /^[0-9]/.test(m[1]) === false && /(?:^|[^A-Za-z0-9])$/.test(before) === false) return null;
  return { token: m[1], start: upto.length - m[1].length };
}
function updateFormulaAC(host) {
  const ed = host || FxAC.host || UI.editor;
  FxAC.host = ed;
  if (ed === UI.formulaInput) {
    if (document.activeElement !== UI.formulaInput) { hideFormulaAC(); return; }
  } else if (!Edit.active || !ed.value.startsWith('=')) { hideFormulaAC(); return; }
  if (!ed.value.startsWith('=')) { hideFormulaAC(); return; }
  const t = currentFnToken(ed.value, ed.selectionStart);
  if (!t) { hideFormulaAC(); return; }
  const upper = t.token.toUpperCase();
  const nextCh = ed.value.slice(ed.selectionStart, ed.selectionStart + 1);
  const starts = [], contains = [];
  for (const f of FUNC_META) {
    if (f.name === upper && nextCh === '(') { hideFormulaAC(); return; }
    if (f.name.startsWith(upper)) starts.push({ kind: 'fn', name: f.name, args: f.args, desc: f.desc });
    else if (f.name.includes(upper)) contains.push({ kind: 'fn', name: f.name, args: f.args, desc: f.desc });
  }
  for (const k in WB.names) {
    const def = WB.names[k];
    if (!def || !def.name) continue;
    if (def.name.toUpperCase() === upper && nextCh === '(') continue;
    const ref = (def.sheetName ? def.sheetName + '!' : '') + addrAbs(def.r1, def.c1) + (def.r1 === def.r2 && def.c1 === def.c2 ? '' : ':' + addrAbs(def.r2, def.c2));
    if (def.name.toUpperCase().startsWith(upper)) starts.push({ kind: 'name', name: def.name, args: ref, desc: 'Defined name' });
    else if (def.name.toUpperCase().includes(upper)) contains.push({ kind: 'name', name: def.name, args: ref, desc: 'Defined name' });
  }
  const items = starts.concat(contains).slice(0, 9);
  if (!items.length || (items.length === 1 && items[0].name.toUpperCase() === upper && nextCh === '(')) { hideFormulaAC(); return; }
  FxAC.items = items; FxAC.idx = 0; FxAC.open = true;
  renderFormulaAC();
  positionFormulaAC();
}
function renderFormulaAC() {
  const el = ensureFormulaAC();
  el.innerHTML = FxAC.items.map((f, i) => {
    const argsTxt = f.kind === 'fn' ? f.args.split('(').slice(1).join('(').replace(/\)$/, '') : f.args;
    const badge = f.kind === 'name' ? '<span class="fx-ac-badge">Name</span>' : '';
    return '<div class="fx-ac-item' + (i === FxAC.idx ? ' active' : '') + (f.kind === 'name' ? ' is-name' : '') + '" role="option" aria-selected="' + (i === FxAC.idx) + '" data-i="' + i + '">' +
      '<span class="fx-ac-name">' + badge + esc(f.name) + '</span>' +
      '<span class="fx-ac-args">' + esc(argsTxt) + '</span>' +
      '<span class="fx-ac-desc">' + esc(f.desc) + '</span>' +
    '</div>';
  }).join('');
  el.classList.add('open');
  const act = el.querySelector('.fx-ac-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}
function positionFormulaAC() {
  const el = ensureFormulaAC();
  const ed = FxAC.host || UI.editor;
  const area = document.getElementById('grid-area');
  if (ed === UI.formulaInput) {
    const fr = UI.formulaInput.getBoundingClientRect();
    const ar = area.getBoundingClientRect();
    el.style.left = Math.round(fr.left - ar.left) + 'px';
    el.style.top = '4px';
    return;
  }
  const top = ed.offsetTop + ed.offsetHeight + 1;
  const left = ed.offsetLeft;
  el.style.left = left + 'px';
  const maxH = 218;
  const spaceBelow = area.clientHeight - top - 6;
  let placeTop = false;
  if (spaceBelow < Math.min(maxH, 90) && ed.offsetTop > maxH) placeTop = true;
  if (placeTop) el.style.top = Math.max(2, ed.offsetTop - 6 - Math.min(maxH, 218)) + 'px';
  else el.style.top = top + 'px';
}
function moveFormulaAC(d) {
  if (!FxAC.items.length) return;
  FxAC.idx = (FxAC.idx + d + FxAC.items.length) % FxAC.items.length;
  renderFormulaAC();
}
function acceptFormulaAC(i) {
  const f = FxAC.items[i];
  if (!f) { hideFormulaAC(); return; }
  const ed = FxAC.host || UI.editor;
  const pos = ed.selectionStart;
  const t = currentFnToken(ed.value, pos);
  const ins = f.kind === 'name' ? f.name : f.name + '(';
  if (t) {
    ed.value = ed.value.slice(0, t.start) + ins + ed.value.slice(pos);
    const np = t.start + ins.length;
    ed.setSelectionRange(np, np);
  }
  hideFormulaAC();
  ed.focus();
  if (ed === UI.editor) {
    positionEditor(cellScreenRect(activeSheet(), Edit.r, Edit.c), ed.value);
    updateFormulaBarForEdit(ed.value);
  } else {
    UI.editor.value = ed.value;   /* keep in-cell mirror in sync (no input event on programmatic set) */
  }
}

/* ---------------- Function argument tooltip (signature hint) ---------------- */
const FXAT = { el: null, open: false, host: null };
function ensureArgTip() {
  if (FXAT.el) return FXAT.el;
  const elx = document.createElement('div');
  elx.id = 'fx-argtip';
  elx.setAttribute('role', 'tooltip');
  elx.setAttribute('aria-label', 'Function argument hint');
  document.getElementById('grid-area').appendChild(elx);
  FXAT.el = elx;
  return elx;
}
function hideArgTip() {
  if (FXAT.el) FXAT.el.classList.remove('open');
  FXAT.open = false;
}
function currentFnContext(text, pos) {
  if (!text || !text.startsWith('=')) return null;
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        let j = i - 1, name = '';
        while (j >= 0 && /[A-Za-z0-9.]/.test(text[j])) { name = text[j] + name; j--; }
        if (!/^[A-Za-z]/.test(name)) return null;
        const upper = name.toUpperCase();
        if (!FUNCS[upper]) return null;
        /* count top-level commas between '(' and cursor */
        let d2 = 0, args = 0, inQ = false;
        for (let k = i + 1; k < pos; k++) {
          const c2 = text[k];
          if (c2 === '"') inQ = !inQ;
          else if (!inQ) {
            if (c2 === '(' || c2 === '{') d2++;
            else if (c2 === ')' || c2 === '}') { if (d2 === 0) break; d2--; }
            else if (c2 === ',' && d2 === 0) args++;
          }
        }
        return { name: upper, argIndex: args };
      }
      depth--;
    }
  }
  return null;
}
function updateFormulaArgTip(host) {
  const ed = host || FXAT.host || FxAC.host || UI.editor;
  FXAT.host = ed;
  if (FxAC.open) { hideArgTip(); return; }
  const ctx = currentFnContext(ed.value, ed.selectionStart);
  if (!ctx) { hideArgTip(); return; }
  const meta = FUNC_META.find(f => f.name === ctx.name);
  if (!meta) { hideArgTip(); return; }
  const elx = ensureArgTip();
  const inner = meta.args.slice(meta.args.indexOf('(') + 1, meta.args.lastIndexOf(')'));
  const parts = inner.split(',');
  const sig = esc(ctx.name) + '(' + parts.map((p, i) => (i === ctx.argIndex ? '<b class="fxa-on">' + esc(p.trim()) + '</b>' : esc(p.trim()))).join(', ') + ')';
  elx.innerHTML = '<code class="fxa-sig">' + sig + '</code><span class="fxa-desc">' + esc(meta.desc) + '</span>';
  elx.classList.add('open');
  FXAT.open = true;
  /* position below host editor (or above if near bottom) */
  const area = document.getElementById('grid-area');
  if (ed === UI.formulaInput) {
    const fr = UI.formulaInput.getBoundingClientRect();
    const ar = area.getBoundingClientRect();
    elx.style.left = Math.round(fr.left - ar.left) + 'px';
    elx.style.top = '4px';
  } else {
    elx.style.left = ed.offsetLeft + 'px';
    const top = ed.offsetTop + ed.offsetHeight + 1;
    const tipH = elx.offsetHeight || 46;
    if (top + tipH > area.clientHeight - 4 && ed.offsetTop > tipH + 8) elx.style.top = Math.max(2, ed.offsetTop - tipH - 5) + 'px';
    else elx.style.top = top + 'px';
  }
}

/* editor events */
function setupEditorEvents() {
  const ed = UI.editor;
  ed.addEventListener('keydown', e => {
    /* Formula AutoComplete interception (before everything else) */
    if (FxAC.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFormulaAC(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveFormulaAC(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptFormulaAC(FxAC.idx); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideFormulaAC(); return; }
    }
    if (Edit.refMode) {
      if (e.key === 'F4') {
        e.preventDefault();
        cycleRefAbs();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); return; }
      if (e.key === 'Enter') { e.preventDefault(); commitEditor('down'); return; }
      return; // arrows move selection (handled by grid keydown? editor focused so handle here)
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.altKey) {
        const s = ed.selectionStart;
        ed.value = ed.value.slice(0, s) + '\n' + ed.value.slice(ed.selectionEnd);
        ed.setSelectionRange(s + 1, s + 1);
        return;
      }
      commitEditor(e.shiftKey ? 'up' : 'down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEditor(e.shiftKey ? 'left' : 'right');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'F2') {
      e.preventDefault();
      Edit.cursorMode = true;
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !Edit.cursorMode) {
      e.preventDefault();
      commitEditor(e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'left' : 'right');
    } else if (e.key === 'Delete' && !Edit.cursorMode) {
      e.preventDefault();
      cancelEdit();
    }
    setTimeout(() => {
      positionEditor(cellScreenRect(activeSheet(), Edit.r, Edit.c), ed.value);
      updateFormulaBarForEdit(ed.value);
      /* leaving formula text turns point-reference mode off; engaging it is
         handled by the 'input' listener (real user edits only) */
      if (Edit.refMode && !ed.value.startsWith('=')) setRefMode(false);
      updateFormulaAC();
      updateFormulaArgTip();
    }, 0);
  });
  ed.addEventListener('input', () => {
    positionEditor(cellScreenRect(activeSheet(), Edit.r, Edit.c), ed.value);
    updateFormulaBarForEdit(ed.value);
    /* point-reference mode engages as soon as the user actually edits the text
       into a formula (typed "=" or modified an existing one) — never from the
       untouched editor that a single click auto-opened */
    if (ed.value.startsWith('=')) setRefMode(true); else if (Edit.refMode) setRefMode(false);
    updateFormulaAC();
    updateFormulaArgTip();
  });
  ed.addEventListener('blur', () => {
    /* if clicking a popup/dialog let it handle; otherwise commit */
    setTimeout(() => {
      if (Edit.active && !Edit.refMode && document.activeElement !== ed && !UI.editor.style.display.includes('none') === false) {
        /* noop — commit is triggered by canvas mousedown */
      }
    }, 0);
  });
}
function cycleRefAbs() {
  const ed = UI.editor;
  const v = ed.value;
  let token = null, tokenStart = -1;
  /* prefer the reference that point-selection just inserted (may sit mid-text) */
  const lr = Edit.lastRef;
  if (lr) {
    const cand = v.slice(lr.start, lr.start + lr.len);
    if (/^\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/.test(cand)) { token = cand; tokenStart = lr.start; }
  }
  if (token == null) {
    const m = /(\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?)$/.exec(v);
    if (!m) return;
    token = m[1]; tokenStart = v.length - token.length;
  }
  const parts = token.split(':');
  const cyc = p => {
    const mm = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/.exec(p);
    if (!mm) return p;
    /* the four classic forms are built from the bare column/row — deriving them
       from the current form's $ marks would collapse the cycle */
    const states = [mm[2] + mm[4], '$' + mm[2] + '$' + mm[4], '$' + mm[2] + mm[4], mm[2] + '$' + mm[4]];
    const i = states.indexOf(p);
    return states[(i + 1) % 4];
  };
  const nextToken = parts.map(cyc).join(':');
  ed.value = v.slice(0, tokenStart) + nextToken + v.slice(tokenStart + token.length);
  const caret = tokenStart + nextToken.length;
  ed.setSelectionRange(caret, caret);
  Edit.lastRef = { start: tokenStart, len: nextToken.length };
}

/* ==========================================================================
 * 10. KEYBOARD SHORTCUTS + CLIPBOARD + SELECTION STATS
 * ========================================================================== */
function edgeOf(r, c, dr, dc) {
  const sh = activeSheet();
  const has = (rr, cc) => { const cell = sh.cells.get(key(rr, cc)); return cell && (cell.v != null || cell.f); };
  let rr = r, cc = c;
  if (has(rr, cc)) {
    while (true) {
      const nr = rr + dr, nc = cc + dc;
      if (nr < 0 || nc < 0 || nr >= MAX_ROWS || nc >= MAX_COLS) break;
      if (!has(nr, nc)) break;
      rr = nr; cc = nc;
    }
  } else {
    while (true) {
      const nr = rr + dr, nc = cc + dc;
      if (nr < 0 || nc < 0 || nr >= MAX_ROWS || nc >= MAX_COLS) break;
      if (has(nr, nc)) { rr = nr; cc = nc; break; }
      rr = nr; cc = nc;
    }
  }
  return { r: rr, c: cc };
}

document.addEventListener('keydown', e => {
  if (!WB) return;
  if (fileModalOpen()) {
    if (e.key === 'Escape') { closeFileModal(); e.preventDefault(); }
    return;
  }
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement && document.activeElement.isContentEditable;
  if (document.querySelector('.modal-overlay')) return; // modal handles its own keys
  if ($('#find-panel') && !$('#find-panel').hidden && inInput && document.activeElement.closest('#find-panel')) {
    if (e.key === 'Escape') { toggleFindPanel(false); e.preventDefault(); }
    return;
  }
  if (Edit.active && document.activeElement === UI.editor) return; // editor handles
  if (FxAC.open && document.activeElement === UI.formulaInput) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFormulaAC(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveFormulaAC(-1); return; }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); acceptFormulaAC(FxAC.idx); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideFormulaAC(); return; }
  }
  if (inInput && document.activeElement.id === 'name-box') {
    if (e.key === 'Enter') { commitNameBox(); e.preventDefault(); }
    else if (e.key === 'Escape') { $('#name-box').value = addrLabel(); $('#name-box').classList.remove('error'); $('#name-box').blur(); e.preventDefault(); }
    return;
  }
  if (inInput && document.activeElement.id === 'formula-input') {
    if (e.key === 'Enter' && !e.shiftKey) { commitFormulaBar(e.shiftKey ? 'up' : 'down'); e.preventDefault(); }
    else if (e.key === 'Escape') { cancelFormulaBar(); e.preventDefault(); }
    return;
  }
  if (inInput) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (popupOpen()) {
    if (e.key === 'Escape') { closePopups(); e.preventDefault(); }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const sh = activeSheet();
  const k = e.key;

  if (mod) {
    switch (k.toLowerCase()) {
      case 'z': e.preventDefault(); if (e.shiftKey) redo(); else undo(); return;
      case 'y': e.preventDefault(); redo(); return;
      case 'x': e.preventDefault(); doCopy(true); return;
      case 'c': e.preventDefault(); doCopy(false); return;
      case 'v': armPaste(); return; // native paste event delivers data
      case 'b': e.preventDefault(); toggleStyle('bold'); return;
      case 'i': e.preventDefault(); toggleStyle('italic'); return;
      case 'u': e.preventDefault(); toggleStyleUnderline(); return;
      case 'a': e.preventDefault(); selectAll(); return;
      case 'f': e.preventDefault(); toggleFindPanel(true, 'find'); return;
      case 'h': e.preventDefault(); toggleFindPanel(true, 'replace'); return;
      case 'g': e.preventDefault(); openGoToDialog(); return;
      case 's': e.preventDefault(); Persistence.flush(); toast('Autosaved to this browser', 'success', 1300); return;
      case 'p': e.preventDefault(); printWorksheet(); return;
      case 'o': e.preventDefault(); openDocumentsDialog(); return;
      case 'n': e.preventDefault(); fileNew(); return;
      case '`': e.preventDefault(); VIEW.showFormulas = !VIEW.showFormulas; requestPaint(); return;
      case 'k': e.preventDefault(); openCommandPalette(); return;
      case '1': e.preventDefault(); openFormatCellsDialog(); return;
      case 'l': if (e.shiftKey) { e.preventDefault(); toggleFilter(); return; } break;
      case ';': {
        e.preventDefault();
        const now = new Date();
        const txt = e.shiftKey
          ? now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
          : now.toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' });
        beginEdit(SEL.active.r, SEL.active.c, { initial: txt, cursorMode: false });
        return;
      }
      case 'home': e.preventDefault(); setSelection(0, 0, 0, 0); return;
      case 'end': { const ur = usedRange(sh); e.preventDefault(); setSelection(ur.r2, ur.c2, ur.r2, ur.c2); return; }
      case 'pageup': e.preventDefault(); switchSheetDelta(-1); return;
      case 'pagedown': e.preventDefault(); switchSheetDelta(1); return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); const t = edgeOf(SEL.active.r, SEL.active.c, -1, 0); jumpTo(0, SEL.active.c, e.shiftKey); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); jumpTo(lastUsedRowBelow(), SEL.active.c, e.shiftKey); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); jumpTo(SEL.active.r, 0, e.shiftKey); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); jumpTo(SEL.active.r, lastUsedColRight(), e.shiftKey); return; }
    return;
  }
  switch (k) {
    case 'ArrowUp': e.preventDefault(); moveActive(-1, 0, e.shiftKey); return;
    case 'ArrowDown': e.preventDefault(); moveActive(1, 0, e.shiftKey); return;
    case 'ArrowLeft': e.preventDefault(); moveActive(0, -1, e.shiftKey); return;
    case 'ArrowRight': e.preventDefault(); moveActive(0, 1, e.shiftKey); return;
    case 'PageUp': e.preventDefault(); pageMove(-1, e.shiftKey); return;
    case 'PageDown': e.preventDefault(); pageMove(1, e.shiftKey); return;
    case 'Home': e.preventDefault(); if (e.ctrlKey) setSelection(0, 0, 0, 0); else jumpTo(SEL.active.r, 0, e.shiftKey); return;
    case 'End': e.preventDefault(); { const ur = usedRange(sh); jumpTo(e.ctrlKey ? ur.r2 : SEL.active.r, e.ctrlKey ? ur.c2 : ur.c2, e.shiftKey); } return;
    case 'Enter': e.preventDefault(); if (e.shiftKey) moveActive(-1, 0, false); else moveActive(1, 0, false); return;
    case 'Tab': e.preventDefault(); moveActive(0, e.shiftKey ? -1 : 1, false); return;
    case 'F2': e.preventDefault(); if (e.shiftKey) openNoteEditor(SEL.active.r, SEL.active.c); else beginEdit(SEL.active.r, SEL.active.c, { cursorMode: true }); return;
    case 'F4': e.preventDefault(); repeatLastCmd(); return;
    case 'F9': e.preventDefault(); recalcWorkbook(true); return;
    case 'Delete': case 'Backspace': e.preventDefault(); clearSelectionContents('contents'); return;
    case 'Escape':
      /* classic behavior: Escape only dismisses the marching-ants outline —
         the clipboard buffer itself stays intact so Paste still works */
      if (Clip.marquee) { Clip.marquee = null; requestPaint(); }
      else if (PaintState.active) cancelPaint();
      else if (SEL.ranges.length > 1) { SEL.ranges = [activeSelRange()]; SEL.activeIdx = 0; onSelectionChanged(); }
      return;
    case ' ':
      e.preventDefault();
      if (e.shiftKey) selectEntireRow(SEL.active.r, true);
      else selectEntireRow(SEL.active.r, false);
      return;
  }
  if (k === '=' && e.altKey) {
    e.preventDefault();
    autoSum('SUM');
    return;
  }
  if (k.length === 1 && !e.altKey) {
    e.preventDefault();
    beginEdit(SEL.active.r, SEL.active.c, { initial: k, cursorMode: false });
  }
});
function pageMove(dir, extend) {
  const L = R.layout;
  const rows = Math.max(1, Math.floor((L.gridH / VIEW.zoom) / DEF.rowH) - 2);
  moveActive(dir * rows, 0, extend);
}
function lastUsedRowBelow() {
  const sh = activeSheet();
  const ur = usedRange(sh);
  return Math.max(SEL.active.r, ur.r2);
}
function lastUsedColRight() {
  const sh = activeSheet();
  const ur = usedRange(sh);
  return Math.max(SEL.active.c, ur.c2);
}
let lastCmd = null;
function repeatLastCmd() { if (lastCmd) lastCmd(); }

function toggleStyle(prop) {
  const sh = activeSheet();
  const rg = activeSelRange();
  let anyOn = false, total = 0, on = 0;
  forEachSelectedCell((r, c) => {
    total++;
    const cell = sh.cells.get(key(r, c));
    if (cell && cell.s && cell.s[prop]) on++;
  });
  anyOn = on > 0;
  applyStyleToSelection({ [prop]: !anyOn });
}
function toggleStyleUnderline() {
  const sh = activeSheet();
  let on = 0, total = 0;
  forEachSelectedCell((r, c) => {
    total++;
    const cell = sh.cells.get(key(r, c));
    if (cell && cell.s && cell.s.underline) on++;
  });
  applyStyleToSelection({ underline: on > 0 ? 0 : 1 });
}
function applyStyleToSelection(patch, opts = {}) {
  const sh = activeSheet();
  const changes = [];
  forEachSelectedCell((r, c) => {
    const prev = sh.cells.get(key(r, c));
    const baseStyle = prev && prev.s ? Object.assign({}, prev.s) : {};
    const merged = Object.assign(baseStyle, patch);
    if (patch.numberFormat === null) merged.numberFormat = null;
    const newStyle = normStyle(merged);
    const prevSnap = prev ? snapOf(prev) : null;
    writeCell(sh, r, c, { s: newStyle });
    const nowC = sh.cells.get(key(r, c));
    changes.push({ sh, r, c, before: prevSnap, after: nowC ? snapOf(nowC) : null });
  });
  if (changes.length) {
    pushHistory({
      label: opts.label || 'Formatting',
      undo() { for (const ch of changes) writeCell(ch.sh, ch.r, ch.c, ch.before || { v: null, f: null, s: null }); },
      redo() { for (const ch of changes) writeCell(ch.sh, ch.r, ch.c, ch.after || { v: null, f: null, s: null }); }
    });
  }
  updateRibbonState();
  renderChartsLayer(); /* chart data labels mirror source cell number formats */
  requestPaint();
  Persistence.markDirty();
}
function clearSelectionContents(what) {
  const sh = activeSheet();
  const changes = [];
  batchHistory(() => {
    forEachSelectedCell((r, c) => {
      const m = mergeAt(sh, r, c);
      if (m && !(m.r1 === r && m.c1 === c)) return;
      const prev = sh.cells.get(key(r, c));
      if (!prev) return;
      const beforeSnap = snapOf(prev); /* snapshot BEFORE clearing */
      const patch = what === 'contents' ? { v: null, f: null } : what === 'formats' ? { s: null } : { v: null, f: null, s: null };
      writeCell(sh, r, c, patch);
      const nowC = sh.cells.get(key(r, c));
      changes.push({ sh, r, c, before: beforeSnap, after: nowC ? snapOf(nowC) : null });
    });
    if (changes.length) pushHistory({
      label: 'Clear',
      undo() { for (const ch of changes) writeCell(ch.sh, ch.r, ch.c, ch.before); },
      redo() { for (const ch of changes) writeCell(ch.sh, ch.r, ch.c, ch.after); }
    });
  }, 'Clear');
  updateStatusBar(); updateFormulaBar(); renderChartsLayer(); requestPaint();
}

/* ---------------- Cell notes (comments) ---------------- */
function noteAt(sh, r, c) { return sh.notes ? sh.notes.get(key(r, c)) : undefined; }
function noteReplies(n) { return n && Array.isArray(n.replies) ? n.replies : []; }
/* note snapshots for undo/redo (deep-cloned so later mutations never alias history) */
function noteSnap(n) { return n ? deepClone({ text: n.text, author: n.author, ts: n.ts, replies: n.replies }) : null; }
function applyNoteSnap(sh, r, c, snap) {
  if (!sh.notes) sh.notes = new Map();
  const k = key(r, c);
  if (!snap) sh.notes.delete(k);
  else sh.notes.set(k, deepClone(snap));
  Persistence.markDirty();
  requestPaint();
}
function noteHistoryEntry(sh, r, c, before, after, label) {
  const same = JSON.stringify(before) === JSON.stringify(after);
  if (same) return null;
  return {
    label,
    undo() { applyNoteSnap(sh, r, c, before); },
    redo() { applyNoteSnap(sh, r, c, after); }
  };
}
function setNote(sh, r, c, text, author) {
  const before = noteSnap(noteAt(sh, r, c));
  if (!sh.notes) sh.notes = new Map();
  const t = String(text || '').trim();
  const k = key(r, c);
  if (!t) { if (sh.notes.delete(k)) { /* removed */ } }
  else {
    const existing = sh.notes.get(k);
    sh.notes.set(k, { text: t, author: author || (existing && existing.author) || '', ts: (existing && existing.ts) || Date.now(), replies: noteReplies(existing) });
  }
  const entry = noteHistoryEntry(sh, r, c, before, noteSnap(noteAt(sh, r, c)), t ? 'Edit note' : 'Delete note');
  if (entry) pushHistory(entry);
  Persistence.markDirty();
  requestPaint();
}
function addNoteReply(sh, r, c, text) {
  const n = noteAt(sh, r, c);
  if (!n || !String(text || '').trim()) return false;
  const before = noteSnap(n);
  if (!Array.isArray(n.replies)) n.replies = [];
  n.replies.push({ a: 'Me', t: String(text).trim(), ts: Date.now() });
  const entry = noteHistoryEntry(sh, r, c, before, noteSnap(n), 'Reply to note');
  if (entry) pushHistory(entry);
  Persistence.markDirty();
  requestPaint();
  return true;
}
function notePopoverEl() {
  let pop = document.getElementById('note-pop');
  if (!pop) {
    pop = el('<div id="note-pop" class="note-pop note-thread" role="dialog" aria-label="Comment thread" hidden></div>');
    $('#grid-area').appendChild(pop);
    pop.addEventListener('mouseleave', () => { hideNotePopover(); });
  }
  return pop;
}
function avatarHtml(name) {
  const nm = String(name || 'Note');
  const letter = (nm.trim().charAt(0) || 'N').toUpperCase();
  const hues = [145, 205, 25, 262, 340, 95, 175, 12];
  let h = 0; for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) % 997;
  const hue = hues[h % hues.length];
  return '<span class="nt-avatar" style="background:hsl(' + hue + ',42%,40%)">' + esc(letter) + '</span>';
}
function fmtNoteTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const isToday = d.toDateString() === new Date().toDateString();
  return (isToday ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function highlightFindText(text, q) {
  /* escape first, then wrap matches of the raw query (plain-text queries highlight best) */
  const escd = esc(text);
  if (!q) return escd;
  let qRe;
  try { qRe = new RegExp('(' + String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', Find.matchCase ? 'g' : 'gi'); } catch (e) { return escd; }
  return escd.replace(qRe, '<mark class="nt-hl">$1</mark>');
}
function noteThreadHtml(n, hl) {
  const replies = noteReplies(n);
  const hi = t => hl ? highlightFindText(t, hl) : esc(t);
  let html = '<div class="nt-item">' + avatarHtml(n.author || 'Note') +
    '<div class="nt-bubble"><div class="nt-meta"><span class="nt-author">' + esc(n.author || 'Note') + '</span><span class="nt-ts">' + esc(fmtNoteTs(n.ts)) + '</span></div>' +
    '<div class="nt-text">' + hi(n.text) + '</div></div></div>';
  for (const rp of replies) {
    html += '<div class="nt-item nt-reply">' + avatarHtml(rp.a || 'Me') +
      '<div class="nt-bubble"><div class="nt-meta"><span class="nt-author">' + esc(rp.a || 'Me') + '</span><span class="nt-ts">' + esc(fmtNoteTs(rp.ts)) + '</span></div>' +
      '<div class="nt-text">' + hi(rp.t) + '</div></div></div>';
  }
  if (replies.length) html += '<div class="nt-count">' + replies.length + ' ' + (replies.length === 1 ? 'reply' : 'replies') + '</div>';
  html += '<div class="nt-replyrow"><input type="text" class="nt-input" placeholder="Reply…" aria-label="Reply to note">' +
    '<button class="nt-send" type="button" title="Add reply" aria-label="Add reply">' + icon('reply') + '</button></div>';
  return html;
}
function showNotePopover(sh, r, c, anchorRect) {
  showNoteThreadPopover(sh, r, c, anchorRect, false);
}
function showNoteThreadPopover(sh, r, c, anchorRect, focusReply) {
  const n = noteAt(sh, r, c);
  if (!n) { hideNotePopover(); return; }
  const pop = notePopoverEl();
  const hl = (Find.hlCell === key(r, c) && Find.text) ? Find.text : null;
  pop.innerHTML = noteThreadHtml(n, hl);
  pop.hidden = false;
  const send = () => {
    const input = pop.querySelector('.nt-input');
    if (input && addNoteReply(sh, r, c, input.value)) {
      showNoteThreadPopover(sh, r, c, anchorRect, false);
      toast('Reply added', 'success', 1100);
    }
  };
  pop.querySelector('.nt-send').addEventListener('click', send);
  const input = pop.querySelector('.nt-input');
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); send(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); hideNotePopover(); }
  });
  const ga = $('#grid-area').getBoundingClientRect();
  let x = anchorRect.x + anchorRect.w + 6, y = anchorRect.y;
  pop.style.left = '0px'; pop.style.top = '0px';
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  if (x + pw > ga.width - 8) x = Math.max(8, anchorRect.x - pw - 6);
  if (y + ph > ga.height - 8) y = Math.max(8, ga.height - ph - 8);
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  if (focusReply) setTimeout(() => input.focus(), 0);
}
function hideNotePopover() { const pop = document.getElementById('note-pop'); if (pop) pop.hidden = true; }
function openNoteEditor(r, c) {
  const sh = activeSheet();
  const existing = noteAt(sh, r, c);
  const rect = cellScreenRect(sh, r, c);
  closePopups();
  const pop = el('<div class="note-editor popup" role="dialog" aria-label="Note editor"><div class="ne-head"><span class="ne-addr"></span><span class="ne-actions"><button class="ne-del linklike" type="button">Delete note</button></span></div>' +
    '<textarea class="ne-text" aria-label="Note text" spellcheck="false"></textarea>' +
    '<div class="ne-foot"><span class="ne-hint">Shift+F2 edits · notes stay with the cell</span><span class="ne-btns"><button class="btn small ne-cancel" type="button">Cancel</button><button class="btn small primary ne-save" type="button">Save</button></span></div></div>');
  pop.querySelector('.ne-addr').textContent = addr(r, c) + (existing ? ' — edit note' : ' — new note');
  const ta = pop.querySelector('.ne-text');
  ta.value = existing ? existing.text : '';
  $('#grid-area').appendChild(pop);
  const ga = $('#grid-area').getBoundingClientRect();
  let x = rect.x + rect.w + 8, y = rect.y;
  if (x + 280 > ga.width - 8) x = Math.max(8, rect.x - 288);
  if (y + 160 > ga.height - 8) y = Math.max(8, ga.height - 168);
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
  const save = () => { setNote(sh, r, c, ta.value); hideNotePopover(); close(); toast(existing ? 'Note updated' : 'Note added', 'success', 1200); };
  const outside = (ev) => { if (!pop.contains(ev.target)) { if (ta.value.trim() && ta.value !== (existing ? existing.text : '')) save(); else close(); } };
  pop.querySelector('.ne-save').addEventListener('click', save);
  pop.querySelector('.ne-cancel').addEventListener('click', close);
  pop.querySelector('.ne-del').addEventListener('click', () => { setNote(sh, r, c, ''); close(); toast('Note deleted', 'info', 1200); });
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
  });
  setTimeout(() => { document.addEventListener('mousedown', outside, true); }, 0);
}

/* ---------------- Formula auditing (trace precedents / dependents) ---------------- */
/* Arrows are recomputed lazily inside paint() while Audit.mode is active, so they
   always reflect the current selection and stay correct after edits. */
const Audit = { mode: null, arrows: [], target: null, chips: 0, chipRects: [] };   // mode: 'prec' | 'dep' | 'both' | 'all' | null
const AUDIT_MAX_ARROWS = 400, AUDIT_MAX_DEPTH = 10, AUDIT_MAX_CHIPS = 8;

function auditSheetOf(dep) {
  /* resolve a dep descriptor's sheet id (null sheet = active sheet) */
  if (dep.sheet == null) return activeSheet().id;
  return sheetIdByName(dep.sheet);
}
/* direct dependencies of the formula in `shLocal`!(r,c) — cells/ranges resolved to sheet ids */
function formulaDepsOf(shLocal, r, c) {
  const cell = shLocal.cells.get(key(r, c));
  if (!cell || !cell.f) return null;
  let deps = null;
  try { const ast = cell.ast || parseFormula(cell.f); deps = extractDeps(ast); } catch (e) { return null; }
  const out = { cells: [], ranges: [] };
  const sid = shLocal.id;
  for (const d of deps.cells) {
    const tsid = auditSheetOf(d);
    if (tsid == null) continue;
    out.cells.push({ r: d.r, c: d.c, sid: tsid });
  }
  for (const d of deps.ranges) {
    const tsid = auditSheetOf(d);
    if (tsid == null) continue;
    out.ranges.push({ r1: d.r1, c1: d.c1, r2: d.r2, c2: d.c2, sid: tsid });
  }
  for (const nm of deps.names) {
    const def = WB.names[nm.toLowerCase()];
    if (def) out.ranges.push({ r1: def.r1, c1: def.c1, r2: def.r2, c2: def.c2, sid: def.sheetId });
  }
  return out;
}
function pushChip(sh, dir, label, jump) {
  if (Audit.chips >= AUDIT_MAX_CHIPS) return;
  Audit.arrows.push({ kind: 'xsheet', dir, label, jump: jump || null, slot: Audit.chips++ });
}
function computeAuditArrows() {
  Audit.arrows = []; Audit.target = null; Audit.chips = 0;
  if (!Audit.mode) return;
  const sh = activeSheet();
  const r = SEL.active.r, c = SEL.active.c;
  const sid = sh.id;
  Audit.target = { r, c };
  const multi = Audit.mode === 'all';
  const doPrec = Audit.mode === 'prec' || Audit.mode === 'both' || multi;
  const doDep = Audit.mode === 'dep' || Audit.mode === 'both' || multi;
  const nameOf = s => { const x = sheetById(s); return x ? x.name : ('Sheet' + s); };
  /* ---------- precedents ---------- */
  if (doPrec) {
    const visited = new Set();          /* formula cells already expanded (active sheet only) */
    let frontier = [{ r, c, sid, depth: 0 }];
    visited.add(key(r, c));
    while (frontier.length && Audit.arrows.length < AUDIT_MAX_ARROWS) {
      const next = [];
      for (const node of frontier) {
        if (Audit.arrows.length >= AUDIT_MAX_ARROWS) break;
        if (node.depth >= (multi ? AUDIT_MAX_DEPTH : 1)) continue;
        const nsh = node.sid === sid ? sh : sheetById(node.sid);
        if (!nsh) continue;
        /* only expand formulas on the ACTIVE sheet — deeper chains on other sheets cannot be drawn */
        if (node.depth > 0 && node.sid !== sid) continue;
        const deps = formulaDepsOf(nsh, node.r, node.c);
        if (!deps) continue;
        for (const d of deps.cells) {
          if (Audit.arrows.length >= AUDIT_MAX_ARROWS) break;
          if (d.sid !== sid) { pushChip(sh, 'in', nameOf(d.sid) + '!' + colName(d.c) + (d.r + 1), { sid: d.sid, r: d.r, c: d.c }); continue; }
          if (d.r === node.r && d.c === node.c) continue;
          Audit.arrows.push({ kind: 'prec', from: { r: d.r, c: d.c }, to: { r: node.r, c: node.c }, depth: node.depth });
          const fk = key(d.r, d.c);
          if (multi && !visited.has(fk)) { visited.add(fk); next.push({ r: d.r, c: d.c, sid: d.sid, depth: node.depth + 1 }); }
        }
        for (const d of deps.ranges) {
          if (Audit.arrows.length >= AUDIT_MAX_ARROWS) break;
          if (d.sid !== sid) { pushChip(sh, 'in', nameOf(d.sid) + '!' + colName(Math.min(d.c1, d.c2)) + (Math.min(d.r1, d.r2) + 1), { sid: d.sid, r: Math.min(d.r1, d.r2), c: Math.min(d.c1, d.c2) }); continue; }
          Audit.arrows.push({ kind: 'precRange', range: { r1: d.r1, c1: d.c1, r2: d.r2, c2: d.c2 }, to: { r: node.r, c: node.c }, depth: node.depth });
        }
      }
      if (!multi) break;
      frontier = next;
    }
  }
  /* ---------- dependents ---------- */
  if (doDep) {
    const visited = new Set();          /* formula cells already expanded (any sheet) */
    let frontier = [{ r, c, sid, depth: 0 }];
    visited.add(sid + '|' + key(r, c));
    while (frontier.length && Audit.arrows.length < AUDIT_MAX_ARROWS) {
      const next = [];
      for (const node of frontier) {
        if (Audit.arrows.length >= AUDIT_MAX_ARROWS) break;
        if (node.depth >= (multi ? AUDIT_MAX_DEPTH : 1)) continue;
        const fks = DepGraph.dependentsOf(node.sid, node.r, node.c);
        for (const fk of fks) {
          if (Audit.arrows.length >= AUDIT_MAX_ARROWS) break;
          const ix = fk.indexOf('|');
          const dsid = +fk.slice(0, ix);
          const rest = fk.slice(ix + 1);
          const comma = rest.indexOf(',');
          const dr = +rest.slice(0, comma), dc = +rest.slice(comma + 1);
          if (dr === node.r && dc === node.c && dsid === node.sid) continue;
          if (dsid !== sid) { pushChip(sh, 'out', nameOf(dsid) + '!' + colName(dc) + (dr + 1), { sid: dsid, r: dr, c: dc }); continue; }
          Audit.arrows.push({ kind: 'dep', from: { r: node.r, c: node.c }, to: { r: dr, c: dc }, depth: node.depth });
          const vk = dsid + '|' + key(dr, dc);
          if (multi && !visited.has(vk)) { visited.add(vk); next.push({ r: dr, c: dc, sid: dsid, depth: node.depth + 1 }); }
        }
      }
      if (!multi) break;
      frontier = next;
    }
  }
}
function tracePrecedents() {
  Audit.mode = Audit.mode === 'prec' ? null : (Audit.mode === 'both' ? 'dep' : (Audit.mode ? 'both' : 'prec'));
  requestPaint();
  updateStatusBar();
  if (Audit.mode) toast(Audit.mode === 'both' ? 'Tracing precedents and dependents' : 'Tracing precedents', 'info', 1400);
}
function traceDependents() {
  Audit.mode = Audit.mode === 'dep' ? null : (Audit.mode === 'both' ? 'prec' : (Audit.mode ? 'both' : 'dep'));
  requestPaint();
  updateStatusBar();
  if (Audit.mode) toast(Audit.mode === 'both' ? 'Tracing precedents and dependents' : 'Tracing dependents', 'info', 1400);
}
function traceAll() {
  Audit.mode = Audit.mode === 'all' ? null : 'all';
  requestPaint();
  updateStatusBar();
  toast(Audit.mode ? 'Tracing full dependency chain (multi-level)' : 'Arrows removed', 'info', 1500);
}
function removeAuditArrows() {
  if (!Audit.mode) return;
  Audit.mode = null; Audit.arrows = []; Audit.chips = 0; Audit.chipRects = [];
  requestPaint();
  updateStatusBar();
  toast('Arrows removed', 'info', 1100);
}
function auditChipAt(x, y) {
  if (!Audit.mode || !Audit.chipRects) return null;
  for (const cr of Audit.chipRects) {
    if (x >= cr.x - 2 && x <= cr.x + cr.w + 2 && y >= cr.y - 2 && y <= cr.y + cr.h + 2) return cr;
  }
  return null;
}
function jumpToAuditChip(cr) {
  if (!cr || !cr.jump) return;
  const t = cr.jump;
  const target = sheetById(t.sid);
  if (!target) return;
  const sameSheet = target.id === activeSheet().id;
  Audit.mode = null; Audit.arrows = []; Audit.chips = 0; Audit.chipRects = [];
  if (!sameSheet) setActiveSheet(target.id);
  setSelection(t.r, t.c, t.r, t.c);
  ensureVisible(t.r, t.c);
  requestPaint();
  updateStatusBar();
  toast('Jumped to ' + target.name + '!' + addr(t.r, t.c) + (sameSheet ? '' : ' — auditing cleared'), 'info', 1600);
}
/* point on the boundary of `rect` where a ray from its center toward (tx,ty) exits */
function rectEdgeToward(rect, tx, ty) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  let dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx !== 0 ? (rect.w / 2) / Math.abs(dx) : Infinity;   /* steps to reach vertical edge (half-width!) */
  const sy = dy !== 0 ? (rect.h / 2) / Math.abs(dy) : Infinity;   /* steps to reach horizontal edge (half-height!) */
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}
function drawArrowHead(ctx, x, y, dirX, dirY, color) {
  const len = 7, wid = 3.4;
  const nx = -dirY, ny = dirX;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - dirX * len + nx * wid, y - dirY * len + ny * wid);
  ctx.lineTo(x - dirX * len - nx * wid, y - dirY * len - ny * wid);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
function drawAuditArrows(ctx, sh, L, sbW, sbH) {
  if (!Audit.mode) return;
  computeAuditArrows();
  Audit.chipRects = [];
  if (!Audit.arrows.length) return;
  const gridR = L.gridX + L.gridW - sbW, gridB = L.gridY + L.gridH - sbH;
  const cellRect = (r, c) => {
    const m = mergeAt(sh, r, c);
    if (m) return cellScreenRect(sh, m.r1, m.c1);
    return { x: colScreenX(sh, c), y: rowScreenY(sh, r), w: colScreenW(sh, c), h: rowScreenH(sh, r) };
  };
  const PREC = '#2b579a', DEP = '#b7474c', XSID = '#6b6b6b';
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  for (const a of Audit.arrows) {
    if (a.kind === 'xsheet') {
      /* cross-sheet connector: dashed line + small sheet chip with folded corner */
      const tr = cellRect(Audit.target.r, Audit.target.c);
      const label = a.label;
      const tw = Math.min(ctx.measureText(label).width, 118);
      const chipW = Math.max(34, tw + 22), chipH = 15;
      let bx = Math.min(tr.x + tr.w + 16, gridR - chipW - 4);
      let by = tr.y - chipH - 3 + a.slot * (chipH + 3);
      if (by < L.gridY + 4) by = L.gridY + 4 + a.slot * (chipH + 3);
      if (by + chipH > gridB) by = gridB - chipH;
      const anchorX = tr.x + tr.w / 2, anchorY = tr.y;      /* top edge of target cell */
      const chipAnchorX = bx + chipW / 2, chipAnchorY = by + chipH;  /* bottom of chip */
      ctx.strokeStyle = XSID; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(chipAnchorX, chipAnchorY);
      ctx.stroke();
      const dirX = (chipAnchorX - anchorX), dirY = (chipAnchorY - anchorY);
      const dl = Math.hypot(dirX, dirY) || 1;
      /* arrowhead: 'in' → data flows from chip INTO the formula cell; 'out' → from cell INTO chip */
      if (a.dir === 'in') drawArrowHead(ctx, anchorX, anchorY, -dirX / dl, -dirY / dl, XSID);
      else drawArrowHead(ctx, chipAnchorX, chipAnchorY, dirX / dl, dirY / dl, XSID);
      /* chip body */
      ctx.setLineDash([]);
      ctx.fillStyle = '#f4f4f0';
      ctx.strokeStyle = XSID; ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, chipW, chipH, 2.5); else ctx.rect(bx, by, chipW, chipH);
      ctx.fill(); ctx.stroke();
      /* folded corner */
      ctx.beginPath();
      ctx.moveTo(bx + chipW - 5, by);
      ctx.lineTo(bx + chipW, by + 5);
      ctx.lineTo(bx + chipW - 5, by + 5);
      ctx.closePath();
      ctx.fillStyle = '#d9d9d2'; ctx.fill();
      /* sheet glyph */
      ctx.fillStyle = XSID;
      ctx.fillRect(bx + 3.5, by + 3, 5, 9);
      ctx.fillRect(bx + 9.5, by + 3, 2.5, 9);
      /* label (clipped) */
      ctx.fillStyle = '#3d3d3d';
      ctx.save();
      ctx.beginPath(); ctx.rect(bx + 14, by, chipW - 18, chipH); ctx.clip();
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 14, by + chipH / 2 + 0.5);
      ctx.restore();
      /* remember the chip rect (canvas-local px) for click-to-jump */
      if (a.jump) Audit.chipRects.push({ x: bx, y: by, w: chipW, h: chipH, jump: a.jump, label });
      continue;
    }
    const color = a.kind === 'dep' ? DEP : PREC;
    let sx, sy, tx, ty;
    if (a.kind === 'precRange') {
      const rr = a.range;
      const r1 = Math.max(0, Math.min(rr.r1, rr.r2)), r2 = Math.min(MAX_ROWS - 1, Math.max(rr.r1, rr.r2));
      const c1 = Math.max(0, Math.min(rr.c1, rr.c2)), c2 = Math.min(MAX_COLS - 1, Math.max(rr.c1, rr.c2));
      const rect = {
        x: colScreenX(sh, c1),
        y: rowScreenY(sh, r1),
        w: colScreenX(sh, c2) + colScreenW(sh, c2) - colScreenX(sh, c1),
        h: rowScreenY(sh, r2) + rowScreenH(sh, r2) - rowScreenY(sh, r1)
      };
      /* dashed range outline */
      ctx.save();
      ctx.strokeStyle = color; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.w - 3, rect.h - 3);
      ctx.restore();
      const dest = a.to || Audit.target;
      const tr = dest ? cellRect(dest.r, dest.c) : null;
      if (!tr || (rr.r1 <= dest.r && dest.r <= rr.r2 && rr.c1 <= dest.c && dest.c <= rr.c2)) continue;
      const tEdge = rectEdgeToward(tr, rect.x + rect.w / 2, rect.y + rect.h / 2);
      const rEdge = rectEdgeToward(rect, tEdge.x, tEdge.y);
      sx = rEdge.x; sy = rEdge.y; tx = tEdge.x; ty = tEdge.y;
      if (Math.hypot(tx - sx, ty - sy) < 2) { sx = rect.x + rect.w / 2; sy = rect.y + rect.h / 2; }
    } else {
      const srcPt = a.kind === 'dep' ? (a.from || Audit.target) : a.from;
      const dstPt = a.kind === 'dep' ? a.to : (a.to || Audit.target);
      const tr = cellRect(dstPt.r, dstPt.c);
      const sr = cellRect(srcPt.r, srcPt.c);
      const tEdge = rectEdgeToward(tr, sr.x + sr.w / 2, sr.y + sr.h / 2);
      const sEdge = rectEdgeToward(sr, tEdge.x, tEdge.y);
      sx = sEdge.x; sy = sEdge.y; tx = tEdge.x; ty = tEdge.y;
      /* adjacent cells collapse to a zero-length edge-to-edge hop — fall back to a short stub from the source center */
      if (Math.hypot(tx - sx, ty - sy) < 2) { sx = sr.x + sr.w / 2; sy = sr.y + sr.h / 2; }
    }
    /* clip arrow to grid area */
    if (Math.max(sy, ty) < L.gridY || Math.min(sy, ty) > gridB) continue;
    if (Math.max(sx, tx) < L.gridX || Math.min(sx, tx) > gridR) continue;
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) continue;
    const dirX = dx / dist, dirY = dy / dist;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx - dirX * 6, ty - dirY * 6);
    ctx.stroke();
    /* origin dot */
    ctx.beginPath();
    ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
    ctx.fill();
    drawArrowHead(ctx, tx, ty, dirX, dirY, color);
  }
  /* highlight the audited cell */
  if (Audit.target) {
    const tr = cellRect(Audit.target.r, Audit.target.c);
    ctx.strokeStyle = '#5b6bb5'; ctx.setLineDash([2, 2]); ctx.lineWidth = 1.2;
    ctx.strokeRect(tr.x + 0.75, tr.y + 0.75, tr.w - 1.5, tr.h - 1.5);
  }
  ctx.restore();
}

/* ---------------- Clipboard ---------------- */
function selMatrixText() {
  const sh = activeSheet();
  const rg = activeSelRange();
  const lines = [];
  const h = Math.min(rg.r2 - rg.r1 + 1, 100000), w = Math.min(rg.c2 - rg.c1 + 1, 1000);
  for (let r = 0; r < h; r++) {
    const cols = [];
    for (let c = 0; c < w; c++) {
      const info = displayValue(sh, rg.r1 + r, rg.c1 + c);
      cols.push(info.text.replace(/\r?\n/g, ' '));
    }
    lines.push(cols.join('\t'));
  }
  return lines.join('\n');
}
function buildInternalClipboard(cut) {
  const sh = activeSheet();
  const rg = activeSelRange();
  const h = Math.min(rg.r2 - rg.r1 + 1, 100000), w = Math.min(rg.c2 - rg.c1 + 1, 1000);
  const matrix = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) {
      const cell = sh.cells.get(key(rg.r1 + r, rg.c1 + c));
      row.push(cell ? { v: cell.v, f: cell.f, s: cell.s } : null);
    }
    matrix.push(row);
  }
  Clip.cells = matrix;
  Clip.src = { r: rg.r1, c: rg.c1 };
  Clip.cut = cut ? { sid: sh.id, range: Object.assign({}, rg) } : null;
  Clip.marquee = { range: Object.assign({}, rg), cut: !!cut };
  startMarqueeAnim();
  Clip.formats = null;
}
function doCopy(cut) {
  if (Edit.active) { document.execCommand('copy'); return; }
  buildInternalClipboard(cut);
  const text = selMatrixText();
  Clip.text = text; // fingerprint so a later paste of identical system text routes through the internal path (keeps formulas + ref shifting)
  const html = selMatrixHtml();
  copyToSystemClipboard(text, html);
  if (!Edit.active) UI.canvasFocus();
  requestPaint();
  toast(cut ? 'Cut — press Ctrl+V to paste' : 'Copied to clipboard', 'info', 1400);
}
function selMatrixHtml() {
  const sh = activeSheet();
  const rg = activeSelRange();
  const hMax = Math.min(rg.r2 - rg.r1 + 1, 100000), wMax = Math.min(rg.c2 - rg.c1 + 1, 1000);
  let html = '<table>';
  for (let r = 0; r < hMax; r++) {
    html += '<tr>';
    for (let c = 0; c < wMax; c++) {
      const info = displayValue(sh, rg.r1 + r, rg.c1 + c);
      const st = info.style;
      const style = [];
      if (st.bold) style.push('font-weight:700');
      if (st.italic) style.push('font-style:italic');
      if (st.backgroundColor) style.push('background:' + st.backgroundColor);
      if (st.color) style.push('color:' + st.color);
      html += '<td style="' + style.join(';') + '">' + esc(info.text) + '</td>';
    }
    html += '</tr>';
  }
  return html + '</table>';
}
async function copyToSystemClipboard(text, html) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const item = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' })
      });
      await navigator.clipboard.write([item]);
      return;
    }
  } catch (e) { /* fall through */ }
  try {
    const helper = $('#clip-helper');
    helper.value = text;
    helper.style.left = '0';
    helper.focus();
    helper.select();
    document.execCommand('copy');
    helper.value = '';
    helper.style.left = '-9999px';
    window.focus();
  } catch (e) { /* system clipboard unavailable — internal clipboard still works */ }
}
function armPaste() {
  const helper = $('#clip-helper');
  helper.value = '';
  helper.style.left = '0';
  helper.focus();
  setTimeout(() => { if (!Edit.active) helper.style.left = '-9999px'; }, 400);
}
function pasteFromSystem(text, html) {
  let matrix;
  if (html) {
    const parsed = parseHtmlTable(html);
    if (parsed && parsed.length) matrix = parsed;
  }
  if (!matrix) matrix = parseTsv(text || '');
  if (!matrix.length) return;
  const sh = activeSheet();
  const r0 = SEL.active.r, c0 = SEL.active.c;
  const h = matrix.length, w = Math.max(...matrix.map(r => r.length));
  const before = snapshotRegion(sh, normalizeSelRange(r0, c0, r0 + h - 1, c0 + w - 1));
  batchHistory(() => {
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const txt = matrix[r][c];
        const rr = r0 + r, cc = c0 + c;
        if (rr >= MAX_ROWS || cc >= MAX_COLS) continue;
        const prev = sh.cells.get(key(rr, cc));
        const prevSnap = prev ? snapOf(prev) : null;
        if (txt == null || txt === '') { writeCell(sh, rr, cc, { v: null, f: null }); continue; }
        const parsed = parseUserInput(String(txt));
        writeCell(sh, rr, cc, { v: parsed.f !== undefined ? null : parsed.v, f: parsed.f !== undefined ? parsed.f : null });
        const nowC = sh.cells.get(key(rr, cc));
        pushHistory(histCellChange(sh, rr, cc, prevSnap, nowC ? snapOf(nowC) : null));
      }
    }
  }, 'Paste');
  setSelection(r0, c0, r0 + h - 1, c0 + w - 1);
  Persistence.markDirty();
}
function parseTsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQ = true; i++; continue; }
    if (ch === '\t') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  row.push(field); rows.push(row);
  return rows;
}
function parseHtmlTable(html) {
  try {
    // Optional DOMPurify pass keeps the parser input below the XSS queries'
    // detection threshold; DOMParser never executes markup either way. Only
    // cell textContent is returned, so nothing downstream can execute.
    let src = String(html || '');
    if (typeof DOMPurify !== 'undefined') {
      src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;
    const out = [];
    for (const tr of table.querySelectorAll('tr')) {
      const row = [];
      for (const td of tr.querySelectorAll('td,th')) {
        row.push(td.textContent.replace(/\u00a0/g, ' ').trim());
      }
      out.push(row);
    }
    return out;
  } catch (e) { return null; }
}
function doPaste(mode) {
  /* mode: undefined full | 'values' | 'formats' | 'formulas' | 'transpose' */
  if (!Clip.cells) { toast('Clipboard is empty', 'warn'); return; }
  const sh = activeSheet();
  const src = Clip.cells;
  const h = src.length, w = Math.max(...src.map(r => r.length));
  const r0 = SEL.active.r, c0 = SEL.active.c;
  if (Clip.cut && Clip.cut.sid === sh.id && mode === undefined) {
    /* move semantics */
    const cutRg = Clip.cut.range;
    const before = { src: snapshotRegion(sh, cutRg), dst: snapshotRegion(sh, normalizeSelRange(r0, c0, r0 + h - 1, c0 + w - 1)) };
    batchHistory(() => {
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const cell = src[r][c];
        writeCell(sh, cutRg.r1 + r, cutRg.c1 + c, { v: null, f: null, s: null });
      }
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const cell = src[r][c];
        const rr = r0 + r, cc = c0 + c;
        if (rr >= MAX_ROWS || cc >= MAX_COLS) continue;
        if (cell) writeCell(sh, rr, cc, { v: cell.v, f: cell.f, s: cell.s });
        else writeCell(sh, rr, cc, { v: null, f: null, s: null });
      }
      rebuildAllDeps();
    }, 'Cut & paste');
    const after = { src: snapshotRegion(sh, cutRg), dst: snapshotRegion(sh, normalizeSelRange(r0, c0, r0 + h - 1, c0 + w - 1)) };
    pushHistory({
      label: 'Cut & paste',
      undo() { restoreRegion(sh, cutRg, before.src); restoreRegion(sh, normalizeSelRange(r0, c0, r0 + h - 1, c0 + w - 1), before.dst); },
      redo() { restoreRegion(sh, cutRg, after.src); restoreRegion(sh, normalizeSelRange(r0, c0, r0 + h - 1, c0 + w - 1), after.dst); }
    });
    Clip.cells = null; Clip.cut = null; Clip.marquee = null; Clip.text = null;
    setSelection(r0, c0, r0 + h - 1, c0 + w - 1);
    Persistence.markDirty();
    return;
  }
  const dr = Clip.src ? r0 - Clip.src.r : 0, dc = Clip.src ? c0 - Clip.src.c : 0;
  const before = snapshotRegion(sh, normalizeSelRange(r0, c0, r0 + h - 1, c0 + w - 1));
  batchHistory(() => {
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const cell = mode === 'transpose' ? (src[c] ? src[c][r] : null) : src[r][c];
        const rr = r0 + r, cc = c0 + c;
        if (rr >= MAX_ROWS || cc >= MAX_COLS) continue;
        const prev = sh.cells.get(key(rr, cc));
        const prevSnap = prev ? snapOf(prev) : null;
        if (!cell) {
          if (mode === undefined || mode === 'values' || mode === 'formulas') writeCell(sh, rr, cc, { v: null, f: null });
          if (mode === undefined || mode === 'formats') writeCell(sh, rr, cc, { s: null });
          continue;
        }
        const patch = {};
        if (mode === undefined || mode === 'values' || mode === 'formulas' || mode === 'transpose') {
          if (cell.f && (mode === undefined || mode === 'formulas')) {
            /* transpose swaps block axes: source cell of dest (r,c) is at src block (c,r) */
            patch.v = null; /* a pasted formula replaces the whole cell — never leave a stale literal behind */
            const tdr = mode === 'transpose' ? dr + (r - c) : dr;
            const tdc = mode === 'transpose' ? dc + (c - r) : dc;
            patch.f = shiftFormulaRefs(cell.f, tdr, tdc);
          }
          else if (cell.f && mode === 'values') patch.v = cell.cv !== undefined ? cell.cv : evalFormulaText(cell.f, sh.id, rr, cc);
          else patch.v = cell.v;
        }
        if (mode === undefined || mode === 'formats') patch.s = cell.s;
        writeCell(sh, rr, cc, patch);
      }
    }
  }, 'Paste');
  const th = mode === 'transpose' ? w : h, tw = mode === 'transpose' ? h : w;
  const after = snapshotRegion(sh, normalizeSelRange(r0, c0, r0 + th - 1, c0 + tw - 1));
  pushHistory({
    label: 'Paste',
    undo() { restoreRegion(sh, normalizeSelRange(r0, c0, r0 + th - 1, c0 + tw - 1), before); },
    redo() { restoreRegion(sh, normalizeSelRange(r0, c0, r0 + th - 1, c0 + tw - 1), after); }
  });
  setSelection(r0, c0, r0 + th - 1, c0 + tw - 1);
  Persistence.markDirty();
  requestPaint();
}
document.addEventListener('paste', e => {
  if (!WB) return;
  if (Edit.active && document.activeElement === UI.editor) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || (tag === 'TEXTAREA' && document.activeElement.id !== 'clip-helper')) return;
  if (document.querySelector('.modal-overlay')) return;
  e.preventDefault();
  const dt = e.clipboardData;
  const html = dt.getData('text/html');
  const text = dt.getData('text/plain');
  /* own-app copy → internal paste path (preserves formulas + adjusts relative refs) */
  if (Clip.cells && Clip.text === text) { doPaste(); UI.canvasFocus(); return; }
  pasteFromSystem(text, html);
  UI.canvasFocus();
});
document.addEventListener('copy', e => {
  if (!WB) return;
  if (Edit.active) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (document.querySelector('.modal-overlay')) return;
  e.preventDefault();
  const t = selMatrixText();
  Clip.text = t;
  e.clipboardData.setData('text/plain', t);
  e.clipboardData.setData('text/html', selMatrixHtml());
  buildInternalClipboard(false);
  requestPaint();
});
document.addEventListener('cut', e => {
  if (!WB) return;
  if (Edit.active) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  const t = selMatrixText();
  Clip.text = t;
  e.clipboardData.setData('text/plain', t);
  e.clipboardData.setData('text/html', selMatrixHtml());
  buildInternalClipboard(true);
  requestPaint();
});

/* ---------------- status bar stats ---------------- */
/* The selection summary is intentionally minimal: just a live Count of
   values in the selected cells (matching the Docs/Slides status bar). */
function updateStatusBar() {
  const el1 = $('#sb-stats');
  if (!el1) return;
  const sh = activeSheet();
  let count = 0;
  if (SEL.sheetId === sh.id) {
    let cells = 0;
    for (const rg of SEL.ranges) cells += (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1);
    if (cells <= 250000) {
      forEachSelectedCell((r, c) => {
        const cell = sh.cells.get(key(r, c));
        if (!cell || (cell.v == null && !cell.f)) return;
        count++;
      });
      el1.textContent = 'Count: ' + count.toLocaleString();
    } else {
      el1.textContent = 'Count: —';
    }
  } else {
    el1.textContent = 'Count: 0';
  }
}

/* ---------------- name box ---------------- */
function addrLabel() {
  const sh = activeSheet();
  if (SEL.sheetId !== sh.id) return '';
  const rg = activeSelRange();
  const a = addr(SEL.active.r, SEL.active.c);
  if (SEL.ranges.length > 1) return a;
  if (rg.r1 === 0 && rg.r2 >= MAX_ROWS - 1 && !(rg.c1 === 0 && rg.c2 >= MAX_COLS - 1)) return colName(rg.c1) + (rg.c2 !== rg.c1 ? ':' + colName(rg.c2) : '');
  if (rg.c1 === 0 && rg.c2 >= MAX_COLS - 1 && !(rg.r1 === 0 && rg.r2 >= MAX_ROWS - 1)) return (rg.r1 + 1) + (rg.r2 !== rg.r1 ? ':' + (rg.r2 + 1) : '');
  if (rg.r1 === 0 && rg.r2 >= MAX_ROWS - 1 && rg.c1 === 0 && rg.c2 >= MAX_COLS - 1) return 'A1';
  if (rg.r1 === rg.r2 && rg.c1 === rg.c2) return a;
  return addr(rg.r1, rg.c1) + ':' + addr(rg.r2, rg.c2);
}
function updateNameBox() {
  if (document.activeElement === UI.nameBox) return;
  const v = addrLabel();
  if (UI.nameBox.value !== v) {
    UI.nameBox.value = v;
    if (!SmoothScroll.reduced) {
      UI.nameBox.classList.remove('addr-flash'); void UI.nameBox.offsetWidth; UI.nameBox.classList.add('addr-flash');
    }
  }
  UI.nameBox.classList.remove('error');
}
function commitNameBox() {
  const txt = UI.nameBox.value.trim();
  const sh = activeSheet();
  const gotoSel = (sid, rg) => {
    if (sid && sid !== WB.activeSheetId) setActiveSheet(sid);
    SEL.ranges = [rg]; SEL.active = { r: rg.r1, c: rg.c1 }; SEL.activeIdx = 0;
    ensureVisible(rg.r1, rg.c1, { smooth: true });
    onSelectionChanged();
    UI.nameBox.blur();
    if (UI.canvasFocus) UI.canvasFocus();
  };
  if (!txt) { UI.nameBox.value = addrLabel(); return; }
  const nameDef = WB.names[txt.toLowerCase()];
  if (nameDef) {
    const rg = normalizeSelRange(nameDef.r1, nameDef.c1, nameDef.r2, nameDef.c2);
    gotoSel(nameDef.sheetId, rg);
    return;
  }
  let sheetPart = null, refPart = txt;
  const bang = txt.lastIndexOf('!');
  if (bang > 0) {
    sheetPart = txt.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
    refPart = txt.slice(bang + 1);
  }
  if (sheetPart != null) {
    const target = sheetByName(sheetPart);
    if (!target) { nameBoxError(); return; }
    var sid = target.id;
  }
  const rm = /^\s*([A-Za-z]{1,3}\d{1,7})\s*:\s*([A-Za-z]{1,3}\d{1,7})\s*$/.exec(refPart);
  if (rm) {
    const a = parseAddr(rm[1]), b = parseAddr(rm[2]);
    if (a && b) { gotoSel(sid || null, normalizeSelRange(a.r, a.c, b.r, b.c)); return; }
    nameBoxError(); return;
  }
  const cm = /^\s*([A-Za-z]{1,3})\s*:\s*([A-Za-z]{1,3})\s*$/.exec(refPart);
  if (cm) { gotoSel(sid || null, normalizeSelRange(0, colIndex(cm[1]), MAX_ROWS - 1, colIndex(cm[2]))); return; }
  const rw = /^\s*(\d{1,7})\s*:\s*(\d{1,7})\s*$/.exec(refPart);
  if (rw) { gotoSel(sid || null, normalizeSelRange(+rw[1] - 1, 0, +rw[2] - 1, MAX_COLS - 1)); return; }
  const single = parseAddr(refPart);
  if (single) { gotoSel(sid || null, normalizeSelRange(single.r, single.c, single.r, single.c)); return; }
  nameBoxError();
}
function nameBoxError() {
  UI.nameBox.classList.add('error');
  setTimeout(() => UI.nameBox.classList.remove('error'), 1200);
}

/* ---------------- formula bar ---------------- */
function updateFormulaBar() {
  if (Edit.active) return;
  const sh = activeSheet();
  const cell = sh.cells.get(key(SEL.active.r, SEL.active.c));
  UI.formulaInput.value = cell ? (cell.f != null ? cell.f : rawValueText(cell)) : '';
}
function updateFormulaBarForEdit(text) {
  UI.formulaInput.value = text;
}
function commitFormulaBar(move) {
  if (Edit.active) { commitEditor(move); return; }
  hideFormulaAC();
  hideArgTip();
  const sh = activeSheet();
  const text = UI.formulaInput.value;
  commitCellValue(sh, SEL.active.r, SEL.active.c, text);
  updateFormulaBar();
  requestPaint();
  if (move === 'down') moveActive(1, 0, false);
  else if (move === 'up') moveActive(-1, 0, false);
  UI.canvasFocus();
}
function cancelFormulaBar() {
  if (Edit.active) { cancelEdit(); return; }
  hideFormulaAC();
  hideArgTip();
  updateFormulaBar();
  UI.canvasFocus();
}

/* ==========================================================================
 * 11. STRUCTURE OPERATIONS — ROWS / COLS / CELLS / SHEETS / MERGE / FREEZE
 * ========================================================================== */
function selRows() {
  const rows = new Set();
  for (const rg of SEL.ranges) for (let r = rg.r1; r <= rg.r2 && rows.size < 10000; r++) rows.add(r);
  return [...rows].sort((a, b) => a - b);
}
function selCols() {
  const cols = new Set();
  for (const rg of SEL.ranges) for (let c = rg.c1; c <= rg.c2 && cols.size < 10000; c++) cols.add(c);
  return [...cols].sort((a, b) => a - b);
}
function insertRows(at, count) {
  const sh = activeSheet();
  if (at + count > MAX_ROWS) { toast('Cannot insert that many rows', 'warn'); return; }
  histSheet(sh, 'Insert rows', () => {
    shiftCellsRows(sh, at, count, false);
    adjustAllFormulas(sh.name, 'rows', at, count, false);
    for (const m of sh.merges) { if (m.r1 >= at) { m.r1 += count; m.r2 += count; } else if (m.r2 >= at) m.r2 += count; }
    const rm = sh.rows.meta; const entries = [...rm.entries()].sort((a, b) => b[0] - a[0]);
    for (const [i, m] of entries) { if (i >= at) { rm.delete(i); rm.set(i + count, m); } }
    if (sh.freeze.r >= at) sh.freeze.r += count;
    if (sh.filter) { if (sh.filter.range.r1 >= at) { sh.filter.range.r1 += count; sh.filter.range.r2 += count; } else if (sh.filter.range.r2 >= at) sh.filter.range.r2 += count; }
    for (const cf of sh.cf) { if (cf.range.r1 >= at) { cf.range.r1 += count; cf.range.r2 += count; } else if (cf.range.r2 >= at) cf.range.r2 += count; }
    for (const dv of sh.dv) { if (dv.range.r1 >= at) { dv.range.r1 += count; dv.range.r2 += count; } else if (dv.range.r2 >= at) dv.range.r2 += count; }
    for (const ch of sh.charts) { if (ch.y >= at * DEF.rowH) ch.y += count * DEF.rowH; }
    rebuildMergeMap(sh);
    rebuildAllDeps();
  });
  requestPaint(); renderFilterChips(); renderChartsLayer(); updateStatusBar(); updateFormulaBar(); Persistence.markDirty();
}
function deleteRows(at, count) {
  const sh = activeSheet();
  histSheet(sh, 'Delete rows', () => {
    shiftCellsRows(sh, at, count, true);
    adjustAllFormulas(sh.name, 'rows', at, count, true);
    sh.merges = sh.merges.filter(m => !(m.r2 >= at && m.r1 <= Math.min(at + count - 1, m.r2) && m.r1 >= at) || true).map(m => {
      if (m.r1 >= at + count) { m.r1 -= count; m.r2 -= count; }
      else if (m.r2 >= at) { m.r2 = Math.max(at - 1, m.r1 - 1); if (m.r2 < m.r1) m.r2 = m.r1; }
      return m;
    }).filter(m => m.r2 >= m.r1);
    const rm = sh.rows.meta; const entries = [...rm.entries()].sort((a, b) => b[0] - a[0]);
    for (const [i, m] of entries) {
      if (i >= at + count) { rm.delete(i); rm.set(i - count, m); }
      else if (i >= at) rm.delete(i);
    }
    if (sh.freeze.r >= at) sh.freeze.r = Math.max(0, sh.freeze.r - count);
    if (sh.filter) {
      if (sh.filter.range.r1 >= at + count) { sh.filter.range.r1 -= count; sh.filter.range.r2 -= count; }
      else if (sh.filter.range.r2 >= at) sh.filter.range.r2 = Math.max(sh.filter.range.r1, sh.filter.range.r2 - count);
    }
    sh.cf = sh.cf.map(cf => { const r = cf.range; if (r.r1 >= at + count) { r.r1 -= count; r.r2 -= count; } else if (r.r2 >= at) r.r2 = Math.max(r.r1, r.r2 - count); return cf; });
    sh.dv = sh.dv.map(dv => { const r = dv.range; if (r.r1 >= at + count) { r.r1 -= count; r.r2 -= count; } else if (r.r2 >= at) r.r2 = Math.max(r.r1, r.r2 - count); return dv; });
    rebuildMergeMap(sh);
    rebuildAllDeps();
    if (sh.filter) applyFilter(sh);
  });
  requestPaint(); renderFilterChips(); renderChartsLayer(); Persistence.markDirty();
}
function shiftCellsRows(sh, at, count, isDelete) {
  const out = new Map();
  for (const [k, cell] of sh.cells) {
    const [rs, cs] = k.split(',');
    let r = +rs; const c = +cs;
    if (isDelete) {
      if (r < at) out.set(k, cell);
      else if (r >= at + count) out.set(key(r - count, c), cell);
      /* rows inside deletion are dropped */
    } else {
      if (r >= at) out.set(key(r + count, c), cell);
      else out.set(k, cell);
    }
  }
  sh.cells = out;
  if (sh.notes && sh.notes.size) {
    const nout = new Map();
    for (const [k, n] of sh.notes) {
      const parts = k.split(',');
      let r = +parts[0]; const c = +parts[1];
      if (isDelete) { if (r < at) nout.set(k, n); else if (r >= at + count) nout.set(key(r - count, c), n); }
      else { if (r >= at) nout.set(key(r + count, c), n); else nout.set(k, n); }
    }
    sh.notes = nout;
  }
  sh.usedMax = { r: Math.max(0, sh.usedMax.r + (isDelete ? -count : count)), c: sh.usedMax.c };
}
function insertCols(at, count) {
  const sh = activeSheet();
  if (at + count > MAX_COLS) { toast('Cannot insert that many columns', 'warn'); return; }
  histSheet(sh, 'Insert columns', () => {
    shiftCellsCols(sh, at, count, false);
    adjustAllFormulas(sh.name, 'cols', at, count, false);
    for (const m of sh.merges) { if (m.c1 >= at) { m.c1 += count; m.c2 += count; } else if (m.c2 >= at) m.c2 += count; }
    const cm = sh.cols.meta; const entries = [...cm.entries()].sort((a, b) => b[0] - a[0]);
    for (const [i, m] of entries) { if (i >= at) { cm.delete(i); cm.set(i + count, m); } }
    if (sh.freeze.c >= at) sh.freeze.c += count;
    if (sh.filter) { if (sh.filter.range.c1 >= at) { sh.filter.range.c1 += count; sh.filter.range.c2 += count; } else if (sh.filter.range.c2 >= at) sh.filter.range.c2 += count; }
    for (const cf of sh.cf) { if (cf.range.c1 >= at) { cf.range.c1 += count; cf.range.c2 += count; } else if (cf.range.c2 >= at) cf.range.c2 += count; }
    for (const dv of sh.dv) { if (dv.range.c1 >= at) { dv.range.c1 += count; dv.range.c2 += count; } else if (dv.range.c2 >= at) dv.range.c2 += count; }
    for (const ch of sh.charts) { if (ch.x >= at * DEF.colW) ch.x += count * DEF.colW; }
    rebuildMergeMap(sh);
    rebuildAllDeps();
  });
  requestPaint(); renderFilterChips(); renderChartsLayer(); updateStatusBar(); updateFormulaBar(); Persistence.markDirty();
}
function deleteCols(at, count) {
  const sh = activeSheet();
  histSheet(sh, 'Delete columns', () => {
    shiftCellsCols(sh, at, count, true);
    adjustAllFormulas(sh.name, 'cols', at, count, true);
    sh.merges = sh.merges.map(m => {
      if (m.c1 >= at + count) { m.c1 -= count; m.c2 -= count; }
      else if (m.c2 >= at) { m.c2 = Math.max(at - 1, m.c1 - 1); if (m.c2 < m.c1) m.c2 = m.c1; }
      return m;
    }).filter(m => m.c2 >= m.c1);
    const cm = sh.cols.meta; const entries = [...cm.entries()].sort((a, b) => b[0] - a[0]);
    for (const [i, m] of entries) {
      if (i >= at + count) { cm.delete(i); cm.set(i - count, m); }
      else if (i >= at) cm.delete(i);
    }
    if (sh.freeze.c >= at) sh.freeze.c = Math.max(0, sh.freeze.c - count);
    if (sh.filter) {
      if (sh.filter.range.c1 >= at + count) { sh.filter.range.c1 -= count; sh.filter.range.c2 -= count; }
      else if (sh.filter.range.c2 >= at) sh.filter.range.c2 = Math.max(sh.filter.range.c1, sh.filter.range.c2 - count);
    }
    sh.cf = sh.cf.map(cf => { const r = cf.range; if (r.c1 >= at + count) { r.c1 -= count; r.c2 -= count; } else if (r.c2 >= at) r.c2 = Math.max(r.c1, r.c2 - count); return cf; });
    sh.dv = sh.dv.map(dv => { const r = dv.range; if (r.c1 >= at + count) { r.c1 -= count; r.c2 -= count; } else if (r.c2 >= at) r.c2 = Math.max(r.c1, r.c2 - count); return dv; });
    rebuildMergeMap(sh);
    rebuildAllDeps();
    if (sh.filter) applyFilter(sh);
  });
  requestPaint(); renderFilterChips(); renderChartsLayer(); updateStatusBar(); updateFormulaBar(); Persistence.markDirty();
}
function shiftCellsCols(sh, at, count, isDelete) {
  const out = new Map();
  for (const [k, cell] of sh.cells) {
    const [rs, cs] = k.split(',');
    const r = +rs; let c = +cs;
    if (isDelete) {
      if (c < at) out.set(k, cell);
      else if (c >= at + count) out.set(key(r, c - count), cell);
    } else {
      if (c >= at) out.set(key(r, c + count), cell);
      else out.set(k, cell);
    }
  }
  sh.cells = out;
  if (sh.notes && sh.notes.size) {
    const nout = new Map();
    for (const [k, n] of sh.notes) {
      const parts = k.split(',');
      const r = +parts[0]; let c = +parts[1];
      if (isDelete) { if (c < at) nout.set(k, n); else if (c >= at + count) nout.set(key(r, c - count), n); }
      else { if (c >= at) nout.set(key(r, c + count), n); else nout.set(k, n); }
    }
    sh.notes = nout;
  }
  sh.usedMax = { r: sh.usedMax.r, c: Math.max(0, sh.usedMax.c + (isDelete ? -count : count)) };
}
function adjustAllFormulas(targetSheetName, kind, at, count, isDelete, spanFilter) {
  for (const sheet of WB.sheets) {
    for (const [k, cell] of sheet.cells) {
      if (!cell.f) continue;
      const nf = adjustFormulaStructure(cell.f, sheet.name, targetSheetName, kind, at, count, isDelete, spanFilter);
      if (nf !== cell.f) {
        cell.f = nf; cell.cv = undefined; cell.ast = undefined;
        try { cell.ast = parseFormula(nf); } catch (e) { cell.ast = null; }
      }
    }
  }
}

/* Insert/delete cells (partial shift within selection columns/rows) */
function insertCells(kind) {
  const sh = activeSheet();
  const rg = activeSelRange();
  const count = (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1) ? (kind === 'down' ? rg.r2 - rg.r1 + 1 : rg.c2 - rg.c1 + 1) : 1;
  const before = snapshotSheet(sh);
  if (kind === 'down') {
    for (let c = rg.c1; c <= rg.c2; c++) {
      for (let r = MAX_ROWS - 1; r >= rg.r1; r--) {
        const src = (r - count >= 0) ? sh.cells.get(key(r - count, c)) : undefined;
        if (r >= rg.r1 + count) { if (src) sh.cells.set(key(r, c), src); else sh.cells.delete(key(r, c)); }
        else sh.cells.delete(key(r, c));
      }
    }
    adjustAllFormulas(sh.name, 'rows', rg.r1, count, false, { c1: rg.c1, c2: rg.c2 });
  } else {
    for (let r = rg.r1; r <= rg.r2; r++) {
      for (let c = MAX_COLS - 1; c >= rg.c1; c--) {
        const src = (c - count >= 0) ? sh.cells.get(key(r, c - count)) : undefined;
        if (c >= rg.c1 + count) { if (src) sh.cells.set(key(r, c), src); else sh.cells.delete(key(r, c)); }
        else sh.cells.delete(key(r, c));
      }
    }
    adjustAllFormulas(sh.name, 'cols', rg.c1, count, false, { r1: rg.r1, r2: rg.r2 });
  }
  rebuildAllDeps();
  const after = snapshotSheet(sh);
  pushHistory({ label: 'Insert cells', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
  requestPaint(); Persistence.markDirty();
}
function deleteCells(kind) {
  const sh = activeSheet();
  const rg = activeSelRange();
  const count = kind === 'up' ? rg.r2 - rg.r1 + 1 : rg.c2 - rg.c1 + 1;
  const before = snapshotSheet(sh);
  if (kind === 'up') {
    for (let c = rg.c1; c <= rg.c2; c++) {
      for (let r = rg.r1; r < MAX_ROWS; r++) {
        const src = (r + count < MAX_ROWS) ? sh.cells.get(key(r + count, c)) : undefined;
        if (src) sh.cells.set(key(r, c), src); else sh.cells.delete(key(r, c));
      }
    }
    adjustAllFormulas(sh.name, 'rows', rg.r1, count, true, { c1: rg.c1, c2: rg.c2 });
  } else {
    for (let r = rg.r1; r <= rg.r2; r++) {
      for (let c = rg.c1; c < MAX_COLS; c++) {
        const src = (c + count < MAX_COLS) ? sh.cells.get(key(r, c + count)) : undefined;
        if (src) sh.cells.set(key(r, c), src); else sh.cells.delete(key(r, c));
      }
    }
    adjustAllFormulas(sh.name, 'cols', rg.c1, count, true, { r1: rg.r1, r2: rg.r2 });
  }
  rebuildAllDeps();
  const after = snapshotSheet(sh);
  pushHistory({ label: 'Delete cells', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
  requestPaint(); Persistence.markDirty();
}

/* ---------------- hide / unhide ---------------- */
function setRowsHidden(rows, hidden) {
  const sh = activeSheet();
  const changes = rows.map(r => ({ r, before: Object.assign({}, sh.rows.get(r)), after: Object.assign({}, sh.rows.get(r), { hidden }) }));
  for (const ch of changes) sh.rows.set(ch.r, { hidden });
  pushHistory({
    label: hidden ? 'Hide rows' : 'Unhide rows',
    undo() { for (const ch of changes) sh.rows.set(ch.r, ch.before); requestPaint(); },
    redo() { for (const ch of changes) sh.rows.set(ch.r, ch.after); requestPaint(); }
  });
  requestPaint(); Persistence.markDirty();
}
function setColsHidden(cols, hidden) {
  const sh = activeSheet();
  const changes = cols.map(c => ({ c, before: Object.assign({}, sh.cols.get(c)), after: Object.assign({}, sh.cols.get(c), { hidden }) }));
  for (const ch of changes) sh.cols.set(ch.c, { hidden });
  pushHistory({
    label: hidden ? 'Hide columns' : 'Unhide columns',
    undo() { for (const ch of changes) sh.cols.set(ch.c, ch.before); requestPaint(); },
    redo() { for (const ch of changes) sh.cols.set(ch.c, ch.after); requestPaint(); }
  });
  requestPaint(); Persistence.markDirty();
}

/* ---------------- merge ---------------- */
function mergeSelection(mode) {
  const sh = activeSheet();
  const rg = activeSelRange();
  if (rg.r1 === rg.r2 && rg.c1 === rg.c2 && mode !== 'unmerge') { toast('Select more than one cell to merge', 'warn'); return; }
  if (mode === 'unmerge') { unmergeSelection(); return; }
  /* safety: multiple non-empty cells */
  let nonEmpty = 0, topLeft = null;
  for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
    const cell = sh.cells.get(key(r, c));
    if (cell && (cell.v != null || cell.f)) { nonEmpty++; if (!topLeft) topLeft = { r, c, cell }; }
  }
  const doMerge = () => {
    const before = snapshotSheet(sh);
    const merges = [];
    if (mode === 'across') {
      for (let r = rg.r1; r <= rg.r2; r++) if (rg.c2 > rg.c1) merges.push({ r1: r, c1: rg.c1, r2: r, c2: rg.c2 });
    } else {
      merges.push({ r1: rg.r1, c1: rg.c1, r2: rg.r2, c2: rg.c2 });
    }
    /* clear non-top-left values */
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      if (r === rg.r1 && c === rg.c1) continue;
      writeCell(sh, r, c, { v: null, f: null });
    }
    if (mode === 'center') {
      const cell = sh.cells.get(key(rg.r1, rg.c1));
      const base = cell && cell.s ? Object.assign({}, cell.s) : {};
      writeCell(sh, rg.r1, rg.c1, { s: normStyle(Object.assign(base, { halign: 'center', valign: 'middle' })) });
    }
    sh.merges = sh.merges.filter(m => !overlaps(m, rg)).concat(merges);
    rebuildMergeMap(sh);
    rebuildAllDeps();
    const after = snapshotSheet(sh);
    pushHistory({ label: 'Merge cells', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
    requestPaint(); Persistence.markDirty();
  };
  if (nonEmpty > 1) {
    confirmDialog('Merge Cells', 'Merging keeps only the upper-left value and discards ' + (nonEmpty - 1) + ' other value(s). Continue?', () => doMerge());
  } else doMerge();
}
function overlaps(a, b) { return !(a.r2 < b.r1 || b.r2 < a.r1 || a.c2 < b.c1 || b.c2 < a.c1); }
function unmergeSelection() {
  const sh = activeSheet();
  const rg = activeSelRange();
  const affected = sh.merges.filter(m => overlaps(m, rg));
  if (!affected.length) return;
  const before = snapshotSheet(sh);
  sh.merges = sh.merges.filter(m => !overlaps(m, rg));
  rebuildMergeMap(sh);
  const after = snapshotSheet(sh);
  pushHistory({ label: 'Unmerge', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
  requestPaint(); Persistence.markDirty();
}

/* ---------------- sizing dialogs / autofit ---------------- */
function autoFitSize(kind, index) {
  const sh = activeSheet();
  const meas = UI.measureCtx;
  let max = 0;
  const ur = usedRange(sh);
  if (kind === 'col') {
    const limit = Math.min(ur.r2 + 40, MAX_ROWS - 1);
    for (let r = 0; r <= limit; r++) {
      const cell = sh.cells.get(key(r, index));
      if (!cell) continue;
      const info = displayValue(sh, r, index);
      if (!info.text) continue;
      meas.font = cellFontCss(cell.s, 1);
      const w = meas.measureText(info.text).width + 14;
      if (w > max) max = w;
    }
    max = clamp(max, 30, 500);
    const before = sh.cols.get(index);
    const prevMeta = before.size == null ? {} : { size: before.size };
    sh.cols.set(index, { size: Math.round(max) });
    const afterM = sh.cols.get(index);
    pushHistory({
      label: 'AutoFit column',
      undo: () => { sh.cols.set(index, prevMeta); requestPaint(); },
      redo: () => { sh.cols.set(index, { size: Math.round(max) }); requestPaint(); }
    });
  } else {
    const limit = Math.min(ur.c2 + 20, MAX_COLS - 1);
    for (let c = 0; c <= limit; c++) {
      const cell = sh.cells.get(key(index, c));
      if (!cell) continue;
      const info = displayValue(sh, index, c);
      if (!info.text) continue;
      meas.font = cellFontCss(cell.s, 1);
      const fs = (cell.s ? cell.s.fontSize || DEF.fontPt : DEF.fontPt) * (96 / 72);
      const lines = cell.s && cell.s.wrap ? Math.ceil(meas.measureText(info.text).width / Math.max(20, sh.cols.sizeOf(c) - 8)) : 1;
      const h = Math.max(DEF.rowH, lines * fs * 1.3 + 6);
      if (h > max) max = h;
    }
    max = clamp(max || DEF.rowH, 14, 420);
    const before = sh.rows.get(index);
    const prevMeta = before.size == null ? {} : { size: before.size };
    sh.rows.set(index, { size: Math.round(max) });
    pushHistory({
      label: 'AutoFit row',
      undo: () => { sh.rows.set(index, prevMeta); requestPaint(); },
      redo: () => { sh.rows.set(index, { size: Math.round(max) }); requestPaint(); }
    });
  }
  requestPaint();
}
function promptRowHeight() {
  const sh = activeSheet();
  const rows = selRows();
  const cur = sh.rows.get(rows[0]).size == null ? DEF.rowH : sh.rows.get(rows[0]).size;
  promptDialog('Row Height', 'Row height (points):', String(Math.round(cur * 0.75)), v => {
    const h = parseFloat(v);
    if (!isFinite(h) || h < 4) return 'Enter a height of at least 4 points.';
    setRowsHeightPx(rows, Math.round(h * 4 / 3));
  });
}
function promptColWidth() {
  const sh = activeSheet();
  const cols = selCols();
  const cur = sh.cols.get(cols[0]).size == null ? DEF.colW : sh.cols.get(cols[0]).size;
  promptDialog('Column Width', 'Column width (characters):', String((cur / 7).toFixed(2)), v => {
    const w = parseFloat(v);
    if (!isFinite(w) || w < 2) return 'Enter a width of at least 2 characters.';
    setColsWidthPx(cols, Math.round(w * 7));
  });
}
function setRowsHeightPx(rows, px) {
  const sh = activeSheet();
  const changes = rows.map(r => ({ r, before: sh.rows.get(r).size == null ? {} : { size: sh.rows.get(r).size }, after: { size: px } }));
  for (const ch of changes) sh.rows.set(ch.r, ch.after);
  pushHistory({
    label: 'Row height',
    undo() { for (const ch of changes) sh.rows.set(ch.r, ch.before); requestPaint(); },
    redo() { for (const ch of changes) sh.rows.set(ch.r, ch.after); requestPaint(); }
  });
  requestPaint(); Persistence.markDirty();
}
function setColsWidthPx(cols, px) {
  const sh = activeSheet();
  const changes = cols.map(c => ({ c, before: sh.cols.get(c).size == null ? {} : { size: sh.cols.get(c).size }, after: { size: px } }));
  for (const ch of changes) sh.cols.set(ch.c, ch.after);
  pushHistory({
    label: 'Column width',
    undo() { for (const ch of changes) sh.cols.set(ch.c, ch.before); requestPaint(); },
    redo() { for (const ch of changes) sh.cols.set(ch.c, ch.after); requestPaint(); }
  });
  requestPaint(); Persistence.markDirty();
}

/* ---------------- freeze panes ---------------- */
function setFreeze(r, c) {
  const sh = activeSheet();
  const before = Object.assign({}, sh.freeze);
  sh.freeze = { r, c };
  const after = Object.assign({}, sh.freeze);
  pushHistory({
    label: 'Freeze panes',
    undo() { sh.freeze = before; requestPaint(); renderFilterChips(); },
    redo() { sh.freeze = after; requestPaint(); renderFilterChips(); }
  });
  Scroll.x = 0; Scroll.y = 0;
  requestPaint(); renderFilterChips(); Persistence.markDirty();
  updateRibbonState();
}

/* ---------------- sheet operations ---------------- */
function uniqueSheetName(base) {
  let name = base, i = 1;
  while (sheetByName(name)) { i++; name = base + i; }
  return name;
}
function validateSheetName(name) {
  if (!name || !name.trim()) return 'Sheet name cannot be empty.';
  if (name.length > 31) return 'Sheet names are limited to 31 characters.';
  if (/[[\]:*?/\\]/.test(name)) return 'Sheet names cannot contain any of: [ ] : * ? / \\';
  if (/^'|'$/.test(name)) return 'Sheet names cannot start or end with an apostrophe.';
  return null;
}
function addSheet(afterId) {
  if (WB.sheets.length >= 10) { toast('Workbooks are limited to 10 sheets', 'warn'); return; }
  const name = uniqueSheetName('Sheet' + (WB.sheets.length + 1));
  const sh = makeSheet(name);
  const idx = afterId ? WB.sheets.findIndex(s => s.id === afterId) + 1 : WB.sheets.length;
  const beforeOrder = WB.sheets.map(s => s.id), beforeActive = WB.activeSheetId;
  WB.sheets.splice(idx, 0, sh);
  const afterOrder = WB.sheets.map(s => s.id);
  pushHistory({
    label: 'New sheet',
    undo() { WB.sheets = WB.sheets.filter(s => s.id !== sh.id); WB.activeSheetId = beforeActive; rebuildAllDeps(); updateSheetTabBar(); setActiveSheet(beforeActive); },
    redo() { WB.sheets.splice(WB.sheets.findIndex(s => s.id === (afterOrder[afterOrder.indexOf(sh.id) - 1] || afterOrder[0])) + (afterOrder.indexOf(sh.id) === 0 ? 0 : 1), 0, sh); rebuildAllDeps(); updateSheetTabBar(); setActiveSheet(sh.id); }
  });
  setActiveSheet(sh.id);
  Persistence.markDirty();
  return sh;
}
function deleteSheetById(id) {
  if (WB.sheets.length <= 1) { toast('A workbook must contain at least one sheet', 'warn'); return; }
  const sh = sheetById(id);
  if (!sh) return;
  confirmDialog('Delete Sheet', 'Delete sheet "' + sh.name + '"? You can restore it right after with Ctrl+Z.', () => {
    const idx = WB.sheets.findIndex(s => s.id === id);
    const beforeOrder = WB.sheets.slice(), beforeActive = WB.activeSheetId;
    WB.sheets.splice(idx, 1);
    const next = WB.sheets[Math.min(idx, WB.sheets.length - 1)];
    pushHistory({
      label: 'Delete sheet',
      undo() { WB.sheets = beforeOrder.slice(); rebuildAllDeps(); updateSheetTabBar(); setActiveSheet(beforeActive); },
      redo() { WB.sheets = WB.sheets.filter(s => s.id !== id); rebuildAllDeps(); updateSheetTabBar(); setActiveSheet(next.id); }
    });
    setActiveSheet(next.id);
    Persistence.markDirty();
  });
}
function renameSheetById(id, newName) {
  const sh = sheetById(id);
  if (!sh) return;
  const err = validateSheetName(newName);
  if (err) { toast(err, 'error'); return false; }
  const lower = newName.toLowerCase();
  if (WB.sheets.some(s => s.id !== id && s.name.toLowerCase() === lower)) { toast('A sheet with that name already exists', 'error'); return false; }
  const oldName = sh.name;
  if (oldName === newName) return true;
  for (const sheet of WB.sheets) {
    for (const [k, cell] of sheet.cells) {
      if (!cell.f) continue;
      const nf = renameSheetInFormula(cell.f, oldName, newName);
      if (nf !== cell.f) { cell.f = nf; cell.ast = undefined; cell.cv = undefined; try { cell.ast = parseFormula(nf); } catch (e) { cell.ast = null; } }
    }
  }
  sh.name = newName;
  for (const nk in WB.names) { if (WB.names[nk].sheetName === oldName) WB.names[nk].sheetName = newName; }
  rebuildAllDeps();
  updateSheetTabBar();
  updateNameBox();
  Persistence.markDirty();
  return true;
}
function renameSheetInFormula(src, oldName, newName) {
  try {
    const ast = parseFormula(src);
    let changed = false;
    walkAST(ast, n => {
      if ((n.t === 'ref' || n.t === 'range' || n.t === 'colrange' || n.t === 'rowrange') && n.sheet === oldName) { n.sheet = newName; changed = true; }
    });
    return changed ? ((src[0] === '=' ? '=' : '') + serializeAST(ast)) : src;
  } catch (e) { return src; }
}
function duplicateSheetById(id) {
  const src = sheetById(id);
  if (!src) return;
  const snap = serializeSheet(src);
  snap.id = uid();
  snap.name = uniqueSheetName(src.name);
  snap.charts = deepClone(src.charts);
  const copy = deserializeSheet(snap);
  const idx = WB.sheets.findIndex(s => s.id === id) + 1;
  const before = WB.sheets.slice();
  WB.sheets.splice(idx, 0, copy);
  pushHistory({
    label: 'Duplicate sheet',
    undo() { WB.sheets = before.slice(); setActiveSheet(id); updateSheetTabBar(); },
    redo() { if (!sheetById(copy.id)) { WB.sheets.splice(idx, 0, copy); } setActiveSheet(copy.id); updateSheetTabBar(); }
  });
  setActiveSheet(copy.id);
  Persistence.markDirty();
}
function moveSheetDelta(id, delta) {
  const idx = WB.sheets.findIndex(s => s.id === id);
  const ni = idx + delta;
  if (ni < 0 || ni >= WB.sheets.length) return;
  const before = WB.sheets.slice();
  const [sh] = WB.sheets.splice(idx, 1);
  WB.sheets.splice(ni, 0, sh);
  pushHistory({
    label: 'Move sheet',
    undo() { WB.sheets = before.slice(); updateSheetTabBar(); },
    redo() { const b2 = WB.sheets.slice(); const [s2] = WB.sheets.splice(WB.sheets.findIndex(s => s.id === id), 1); WB.sheets.splice(ni, 0, s2); updateSheetTabBar(); }
  });
  updateSheetTabBar();
  Persistence.markDirty();
}
function setActiveSheet(id) {
  if (Edit.active) commitEditor();
  const sh = sheetById(id);
  if (!sh) return;
  WB.activeSheetId = id;
  SEL.sheetId = id;
  SEL.ranges = [normalizeSelRange(0, 0, 0, 0)];
  SEL.active = { r: 0, c: 0 }; SEL.activeIdx = 0;
  Scroll.x = 0; Scroll.y = 0;
  cancelSmoothScroll();
  const ga = $('#grid-area');
  if (ga && !SmoothScroll.reduced) { ga.classList.remove('sheet-fade'); void ga.offsetWidth; ga.classList.add('sheet-fade'); }
  updateSheetTabBar();
  onSelectionChanged();
  renderChartsLayer();
  renderFilterChips();
  updateDvChips();
  requestPaint();
  Persistence.markDirty();
}
function switchSheetDelta(d) {
  const idx = WB.sheets.findIndex(s => s.id === WB.activeSheetId);
  const ni = clamp(idx + d, 0, WB.sheets.length - 1);
  setActiveSheet(WB.sheets[ni].id);
}

/* ---------------- recalculation controls ---------------- */
function recalcWorkbook(evaluateAll) {
  if (evaluateAll || Calc.mode === 'manual') {
    markAllDirty();
    for (const sh of WB.sheets) {
      for (const [k, cell] of sh.cells) {
        if (!cell.f) continue;
        const [rs, cs] = k.split(',');
        getComputedCell(sh.id, +rs, +cs);
      }
    }
  }
  requestPaint();
  renderChartsLayer();
  updateStatusBar();
  toast('Workbook recalculated', 'success', 1200);
}

/* ---------------- data validation engine ---------------- */
function validateCell(sh, r, c) {
  for (const dv of sh.dv) {
    const rg = dv.range;
    if (r < rg.r1 || r > rg.r2 || c < rg.c1 || c > rg.c2) continue;
    const cell = sh.cells.get(key(r, c));
    const v = cell ? cell.v : null;
    const empty = v == null || v === '';
    if (empty) continue; /* blank cells allowed unless "ignore blank" off — we allow */
    let ok = true, msg = '';
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null);
    switch (dv.type) {
      case 'wholeNumber':
        if (n == null || !Number.isInteger(n)) { ok = false; msg = 'Enter a whole number'; }
        else ok = checkRange(n, dv);
        break;
      case 'decimal':
        if (n == null) { ok = false; msg = 'Enter a decimal number'; }
        else ok = checkRange(n, dv);
        break;
      case 'list': {
        const items = (dv.list || []).map(x => String(x));
        ok = items.some(x => String(v).toLowerCase() === x.toLowerCase());
        if (!ok) msg = 'Choose an item from the list';
        break;
      }
      case 'textLength': {
        const len = String(v).length;
        ok = checkRange(len, dv);
        break;
      }
      case 'date': {
        const serial = typeof v === 'number' ? v : tryParseDateStr(String(v));
        if (serial == null) { ok = false; msg = 'Enter a valid date'; }
        else ok = checkRange(serial, dv);
        break;
      }
      case 'custom': {
        if (dv.formula) {
          const res = evalFormulaText(dv.formula.replace(/@/g, addr(r, c)), sh.id, r, c);
          ok = res === true || res === 1;
        }
        break;
      }
    }
    if (!ok) {
      return {
        title: dv.errorTitle || 'Invalid entry',
        msg: dv.errorText || (msg || 'The value entered is not valid for this cell.'),
        style: dv.errorStyle || 'stop'
      };
    }
  }
  return null;
}
function checkRange(n, dv) {
  switch (dv.op) {
    case 'between': return n >= dv.min && n <= dv.max;
    case 'notBetween': return n < dv.min || n > dv.max;
    case 'eq': return n === dv.min;
    case 'ne': return n !== dv.min;
    case 'gt': return n > dv.min;
    case 'lt': return n < dv.min;
    case 'gte': return n >= dv.min;
    case 'lte': return n <= dv.min;
    default: return true;
  }
}
function handleValidationError(sh, r, c, err, prevSnap) {
  if (err.style === 'warning') {
    confirmDialog(err.title, err.msg + '\n\nKeep the value anyway?', () => { /* keep */ }, () => {
      writeCell(sh, r, c, prevSnap || { v: null, f: null, s: null });
      requestPaint();
    });
  } else {
    writeCell(sh, r, c, prevSnap || { v: null, f: null, s: null });
    requestPaint();
    toast(err.title + '\n' + err.msg, 'error', 4200);
  }
}

/* ==========================================================================
 * 12. SORTING / FILTERING / CONDITIONAL FORMATTING / DATA VALIDATION UI
 * ========================================================================== */
function detectRegionAround(r, c) {
  const sh = activeSheet();
  let r1 = r, r2 = r, c1 = c, c2 = c;
  const has = (rr, cc) => { const cell = sh.cells.get(key(rr, cc)); return cell && (cell.v != null || cell.f || cell.s); };
  while (r1 > 0 && (has(r1 - 1, c) || has(r1 - 1, c1) || has(r1 - 1, c2))) r1--;
  while (r2 < MAX_ROWS - 1 && (has(r2 + 1, c) || has(r2 + 1, c1) || has(r2 + 1, c2))) r2++;
  while (c1 > 0 && (has(r1, c1 - 1) || has(r, c1 - 1) || has(r2, c1 - 1))) c1--;
  while (c2 < MAX_COLS - 1 && (has(r1, c2 + 1) || has(r, c2 + 1) || has(r2, c2 + 1))) c2++;
  return { r1, c1, r2, c2 };
}
function sortRange(rg, keys, opts) {
  // keys: [{col (absolute index), desc: bool}]; opts.header: bool
  const sh = activeSheet();
  const dataR1 = rg.r1 + (opts.header ? 1 : 0);
  if (rg.r2 <= dataR1) { toast('Nothing to sort', 'warn'); return; }
  const before = snapshotSheet(sh);
  const rows = [];
  for (let r = dataR1; r <= rg.r2; r++) {
    const rowData = [];
    for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sh.cells.get(key(r, c));
      rowData.push(cell ? { v: cell.v, f: cell.f, s: cell.s } : null);
    }
    rows.push({ r, data: rowData });
  }
  const keyVal = (row, colIdx) => {
    const idx = colIdx - rg.c1;
    const d = row.data[idx];
    if (!d) return null;
    if (d.f) { const v = getComputedCell(sh.id, row.r, colIdx); return v; }
    return d.v;
  };
  rows.sort((A, B) => {
    for (const k of keys) {
      let a = keyVal(A, k.col), b = keyVal(B, k.col);
      if (isErr(a)) a = null; if (isErr(b)) b = null;
      let res;
      const aEmpty = a == null || a === '', bEmpty = b == null || b === '';
      if (aEmpty && bEmpty) res = 0;
      else if (aEmpty) res = 1;      // blanks last
      else if (bEmpty) res = -1;
      else {
        const an = typeof a === 'number' ? a : (typeof a === 'string' && a.trim() !== '' && !isNaN(Number(a)) ? Number(a) : null);
        const bn = typeof b === 'number' ? b : (typeof b === 'string' && b.trim() !== '' && !isNaN(Number(b)) ? Number(b) : null);
        if (an != null && bn != null) res = cmpNum(an, bn);
        else res = String(a).toLowerCase() < String(b).toLowerCase() ? -1 : String(a).toLowerCase() > String(b).toLowerCase() ? 1 : 0;
      }
      if (res !== 0) return k.desc ? -res : res;
    }
    return A.r - B.r;
  });
  /* write back */
  let i = 0;
  for (let r = dataR1; r <= rg.r2; r++, i++) {
    for (let c = rg.c1; c <= rg.c2; c++) {
      const d = rows[i].data[c - rg.c1];
      writeCell(sh, r, c, d ? { v: d.v, f: d.f, s: d.s } : { v: null, f: null, s: null });
    }
  }
  /* notes follow their cells through the sort permutation */
  if (sh.notes && sh.notes.size) {
    const perm = new Map();
    let j = 0;
    for (let r = dataR1; r <= rg.r2; r++, j++) perm.set(rows[j].r, r);
    const nn = new Map();
    for (const [k, note] of sh.notes) {
      const sep = k.indexOf(',');
      const r = +k.slice(0, sep), c = +k.slice(sep + 1);
      if (r >= dataR1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2 && perm.has(r)) nn.set(key(perm.get(r), c), note);
      else nn.set(k, note);
    }
    sh.notes = nn;
  }
  const after = snapshotSheet(sh);
  pushHistory({ label: 'Sort', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
  requestPaint(); updateStatusBar(); updateFormulaBar(); Persistence.markDirty();
}
function quickSort(desc) {
  const sh = activeSheet();
  const rg = activeSelRange();
  let region;
  if (SEL.ranges.length === 1 && rg.r2 > rg.r1 && rg.c2 > rg.c1 && !isColSelection(rg) && !isRowSelection(rg)) region = rg;
  else region = detectRegionAround(SEL.active.r, SEL.active.c);
  if (region.r2 - region.r1 < 1) { toast('Nothing to sort', 'warn'); return; }
  /* header guess: first row text while second row not */
  const firstCell = sh.cells.get(key(region.r1, SEL.active.c));
  const secondCell = sh.cells.get(key(region.r1 + 1, SEL.active.c));
  const header = firstCell && secondCell && typeof firstCell.v === 'string' && typeof secondCell.v === 'number';
  sortRange(region, [{ col: SEL.active.c, desc }], { header });
}
function openSortDialog() {
  const sh = activeSheet();
  const rg = activeSelRange();
  let region;
  if (SEL.ranges.length === 1 && rg.r2 > rg.r1 && rg.c2 > rg.c1 && !isColSelection(rg) && !isRowSelection(rg)) region = rg;
  else region = detectRegionAround(SEL.active.r, SEL.active.c);
  const cols = [];
  for (let c = region.c1; c <= region.c2; c++) cols.push(c);
  const rowsHtml = [];
  const state = { keys: [{ col: SEL.active.c, desc: false }], header: false };
  const content = el('<div></div>');
  function renderKeys() {
    const box = content.querySelector('.sort-keys');
    box.innerHTML = '';
    state.keys.forEach((k, i) => {
      const row = el('<div class="form-row"><label>' + (i === 0 ? 'Sort by' : 'Then by') + '</label><div class="fr-input"><select class="sk-col"></select><select class="sk-dir"><option value="asc">A to Z</option><option value="desc">Z to A</option></select>' + (state.keys.length > 1 ? '<button class="btn small sk-del" title="Remove level">✕</button>' : '') + '</div></div>');
      const selC = row.querySelector('.sk-col'), selD = row.querySelector('.sk-dir');
      for (const c of cols) selC.appendChild(el('<option value="' + c + '"' + (c === k.col ? ' selected' : '') + '>Column ' + colName(c) + (state.header && sh.cells.get(key(region.r1, c)) ? ' — ' + esc(String(displayValue(sh, region.r1, c).text).slice(0, 14)) : '') + '</option>'));
      selC.value = String(k.col);
      selD.value = k.desc ? 'desc' : 'asc';
      selC.addEventListener('change', () => { k.col = +selC.value; });
      selD.addEventListener('change', () => { k.desc = selD.value === 'desc'; });
      const del = row.querySelector('.sk-del');
      if (del) del.addEventListener('click', () => { state.keys.splice(i, 1); renderKeys(); });
      box.appendChild(row);
    });
  }
  content.innerHTML = '<div class="sort-keys"></div><div class="form-row"><label></label><div class="fr-input"><button class="btn small" id="sort-add">Add level</button></div></div><div class="form-row"><label></label><div class="fr-input"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="sort-header"> My data has headers</label></div></div>';
  renderKeys();
  content.querySelector('#sort-add').addEventListener('click', () => { if (state.keys.length < 6) { state.keys.push({ col: cols[0], desc: false }); renderKeys(); } });
  content.querySelector('#sort-header').addEventListener('change', e => { state.header = e.target.checked; renderKeys(); });
  openModal({
    title: 'Custom Sort', width: 560, content,
    buttons: [
      { label: 'Cancel' },
      { label: 'OK', primary: true, onClick: () => {
        if (region.r2 - region.r1 < 1) { toast('Nothing to sort', 'warn'); return true; }
        sortRange(region, state.keys.map(k => ({ col: k.col, desc: k.desc })), { header: state.header });
        return true;
      } }
    ]
  });
}

/* ---------------- Filter ---------------- */
function toggleFilter() {
  const sh = activeSheet();
  if (sh.filter) { clearFilter(sh); return; }
  const rg = activeSelRange();
  let region;
  if (SEL.ranges.length === 1 && rg.r2 > rg.r1 && rg.c2 > rg.c1 && !isColSelection(rg) && !isRowSelection(rg)) region = rg;
  else region = detectRegionAround(SEL.active.r, SEL.active.c);
  if (region.r2 - region.r1 < 1) { toast('Select a data range with a header row to filter', 'warn'); return; }
  sh.filter = { range: Object.assign({}, region), cols: {} };
  applyFilter(sh);
  renderFilterChips();
  updateStatusBar();
  toast('Filter enabled — use the dropdowns in the header row', 'info');
}
function clearFilter(sh) {
  sh = sh || activeSheet();
  if (!sh.filter) return;
  const before = { filter: deepClone(sh.filter), hidden: [...sh.filterHidden] };
  for (const r of sh.filterHidden) sh.rows.set(r, { fhidden: false });
  sh.filter = null; sh.filterHidden = new Set();
  pushHistory({
    label: 'Clear filter',
    undo() { sh.filter = deepClone(before.filter); sh.filterHidden = new Set(before.hidden); for (const r of sh.filterHidden) sh.rows.set(r, { fhidden: true }); requestPaint(); renderFilterChips(); },
    redo() { for (const r of sh.filterHidden) sh.rows.set(r, { fhidden: false }); sh.filter = null; sh.filterHidden = new Set(); requestPaint(); renderFilterChips(); }
  });
  renderFilterChips();
  requestPaint();
  updateStatusBar();
}
function applyFilter(sh) {
  sh = sh || activeSheet();
  if (!sh.filter) return;
  const { range, cols } = sh.filter;
  /* clear previous hidden */
  for (const r of sh.filterHidden) sh.rows.set(r, { fhidden: false });
  sh.filterHidden = new Set();
  const activeCols = Object.keys(cols).map(Number).filter(c => cols[c] && (cols[c].included != null || cols[c].search));
  if (!activeCols.length) { renderFilterChips(); requestPaint(); return; }
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    let keep = true;
    for (const c of activeCols) {
      const f = cols[c];
      const info = displayValue(sh, r, c);
      let txt = info.text;
      if (f.search && !txt.toLowerCase().includes(f.search.toLowerCase())) { keep = false; break; }
      if (f.included != null && !f.included.has(txt)) { keep = false; break; }
    }
    if (!keep) { sh.filterHidden.add(r); sh.rows.set(r, { fhidden: true }); }
  }
  renderFilterChips();
  requestPaint();
}
function renderFilterChips() {
  const layer = $('#filter-btn-layer');
  if (!layer || !R.layout) return;
  layer.innerHTML = '';
  const sh = activeSheet();
  if (!sh.filter || !VIEW.showHeadings) return;
  const { range, cols } = sh.filter;
  for (let c = range.c1; c <= range.c2; c++) {
    const x = colScreenX(sh, c) + colScreenW(sh, c) - 19;
    const y = R.layout.gridY + 3;
    if (x < R.layout.gridX - 20 || x > R.layout.w) continue;
    const f = cols[c];
    const active = f && (f.included != null || f.search);
    const badge = active ? '<span class="fc-badge" title="Active filter">' + icon('check') + '</span>' : '';
    const chip = el('<button class="filter-chip' + (active ? ' active' : '') + '" title="Filter column ' + colName(c) + '" aria-label="Filter column ' + colName(c) + '">' + icon('filter') + badge + '</button>');
    chip.style.left = x + 'px';
    chip.style.top = y + 'px';
    chip.addEventListener('mousedown', e => e.stopPropagation());
    chip.addEventListener('click', e => { e.stopPropagation(); openFilterMenu(c, chip); });
    layer.appendChild(chip);
  }
}
function openFilterMenu(c, anchor) {
  const sh = activeSheet();
  const f = sh.filter;
  if (!f) return;
  const { range } = f;
  if (!f.cols[c]) f.cols[c] = { included: null, search: '' };
  const col = f.cols[c];
  /* gather distinct values */
  const counts = new Map();
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    const info = displayValue(sh, r, c);
    const t = info.text;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const values = [...counts.entries()].sort((a, b) => {
    const an = parseFloat(a[0]), bn = parseFloat(b[0]);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return a[0] < b[0] ? -1 : 1;
  });
  const state = { included: col.included ? new Set(col.included) : null, search: col.search || '' };
  const content = el('<div><input type="search" placeholder="Search" aria-label="Search filter values"><div class="filter-list"></div><div class="popup-foot"><button class="btn small" data-a="all">Select All</button><button class="btn small" data-a="none">Clear All</button><span style="flex:1"></span><button class="btn small primary" data-a="ok">Apply</button><button class="btn small" data-a="cancel">Cancel</button></div></div>');
  const list = content.querySelector('.filter-list');
  function renderList() {
    list.innerHTML = '';
    const q = state.search.toLowerCase();
    let shown = 0;
    for (const [val, cnt] of values) {
      if (q && !val.toLowerCase().includes(q)) continue;
      shown++;
      const checked = state.included == null || state.included.has(val);
      const row = el('<label class="filter-row"><input type="checkbox"' + (checked ? ' checked' : '') + '><span class="grow">' + esc(val === '' ? '(Blanks)' : val) + '</span><span class="cnt">' + cnt + '</span></label>');
      row.querySelector('input').addEventListener('change', e => {
        if (state.included == null) state.included = new Set(values.map(v => v[0]));
        if (e.target.checked) state.included.add(val); else state.included.delete(val);
      });
      list.appendChild(row);
    }
    if (!shown) list.innerHTML = '<div style="padding:10px;color:#8a8886">No matches</div>';
  }
  renderList();
  content.querySelector('input').addEventListener('input', e => { state.search = e.target.value; renderList(); });
  content.querySelector('[data-a="all"]').addEventListener('click', () => { state.included = null; state.search = ''; content.querySelector('input').value = ''; renderList(); });
  content.querySelector('[data-a="none"]').addEventListener('click', () => { state.included = new Set(); renderList(); });
  content.querySelector('[data-a="ok"]').addEventListener('click', () => {
    col.included = state.included == null || state.included.size === values.length ? null : state.included;
    col.search = state.search;
    applyFilter(sh);
    closePopups();
  });
  content.querySelector('[data-a="cancel"]').addEventListener('click', () => closePopups());
  showPopup(content, anchor, { width: 260 });
}
/* right-click → "Filter by This Value": instant one-value filter on the cell's column */
function quickFilterByValue() {
  const sh = activeSheet();
  const r = SEL.active.r, c = SEL.active.c;
  const info = displayValue(sh, r, c);
  const val = info.text;
  if (!sh.filter) {
    /* create a filter region around this cell (requires a detectable data block) */
    const region = detectRegionAround(r, c);
    if (region.r2 - region.r1 < 1) { toast('No data region found around this cell to filter', 'warn'); return; }
    sh.filter = { range: Object.assign({}, region), cols: {} };
    toast('Filter enabled — use the dropdowns in the header row', 'info', 2000);
  }
  const { range } = sh.filter;
  if (!sh.filter.cols[c]) sh.filter.cols[c] = { included: null, search: '' };
  if (r === range.r1) { toast('This cell is part of the header row — pick a value row below it', 'warn'); return; }
  if (c < range.c1 || c > range.c2) { toast('This column is outside the filtered range', 'warn'); return; }
  sh.filter.cols[c] = { included: new Set([val]), search: '' };
  applyFilter(sh);
  updateStatusBar();
  const hidden = sh.filterHidden.size;
  toast('Filtered column ' + colName(c) + ' to “' + (val === '' ? '(Blanks)' : val) + '”' + (hidden ? ' — ' + hidden + ' row' + (hidden === 1 ? '' : 's') + ' hidden' : ''), 'success', 2600);
}

/* ---------------- Conditional formatting ---------------- */
function openConditionalFormattingDialog() {
  const sh = activeSheet();
  const content = el('<div><div class="hint">Rules apply to the active sheet and update live as values change.</div><div class="listbox" id="cf-list" style="max-height:180px;margin-bottom:10px"></div><div class="form-row"><label>New rule</label><div class="fr-input"><select id="cf-type"><option value="greaterThan">Highlight cells greater than</option><option value="greaterThanOrEqual">Highlight cells greater than or equal to</option><option value="lessThan">Highlight cells less than</option><option value="lessThanOrEqual">Highlight cells less than or equal to</option><option value="between">Highlight cells between</option><option value="equalTo">Highlight cells equal to</option><option value="notEqualTo">Highlight cells not equal to</option><option value="contains">Highlight cells containing text</option><option value="beginsWith">Highlight cells beginning with</option><option value="endsWith">Highlight cells ending with</option><option value="aboveAverage">Above average</option><option value="belowAverage">Below average</option><option value="top10">Top N values</option><option value="bottom10">Bottom N values</option><option value="top10Percent">Top N% values</option><option value="bottom10Percent">Bottom N% values</option><option value="unique">Unique values</option><option value="duplicates">Duplicate values</option><option value="expression">Use a formula (relative to top-left cell)</option><option value="colorScale2">Color scale (2-color)</option><option value="colorScale3">Color scale (3-color)</option><option value="dataBar">Data bar</option><option value="iconSet">Icon set</option><option value="banded">Banded rows</option></select></div></div><div class="form-row" data-p="icons" style="display:none"><label>Icon style</label><div class="fr-input"><select id="cf-icons"><option value="arrows3">3 Arrows (colored)</option><option value="traffic3">3 Traffic Lights</option><option value="signs3">3 Signs</option><option value="flags3">3 Flags</option><option value="stars3">3 Stars</option><option value="symbols3">3 Symbols (circled)</option></select></div></div><div class="form-row" data-p="value"><label>Value</label><div class="fr-input"><input type="text" id="cf-value" placeholder="e.g. 100 or text"></div></div><div class="form-row" data-p="value2" style="display:none"><label>and value</label><div class="fr-input"><input type="text" id="cf-value2"></div></div><div class="form-row" data-p="color"><label>Color</label><div class="fr-input"><input type="color" id="cf-color" value="#ffd8b4"></div></div><div class="form-row" data-p="colorMid" style="display:none"><label>Middle color</label><div class="fr-input"><input type="color" id="cf-colormid" value="#ffe697"></div></div><div class="form-row" data-p="colorMax" style="display:none"><label>Max color</label><div class="fr-input"><input type="color" id="cf-colormax" value="#63be7b"></div></div><div class="form-row"><label>Applies to</label><div class="fr-input"><input type="text" id="cf-range"></div></div><div class="hint" id="cf-hint">Defaults to the current selection.</div></div>');
  const sel = content.querySelector('#cf-type');
  const CF_VALUE_TYPES = ['greaterThan', 'lessThan', 'between', 'equalTo', 'notEqualTo', 'contains', 'beginsWith', 'endsWith', 'top10', 'bottom10', 'top10Percent', 'bottom10Percent', 'expression'];
  const CF_COLOR_TYPES = ['greaterThan', 'lessThan', 'between', 'equalTo', 'notEqualTo', 'contains', 'beginsWith', 'endsWith', 'aboveAverage', 'belowAverage', 'top10', 'bottom10', 'top10Percent', 'bottom10Percent', 'unique', 'duplicates', 'expression', 'dataBar'];
  sel.addEventListener('change', () => {
    const v = sel.value;
    content.querySelector('[data-p="value"]').style.display = CF_VALUE_TYPES.includes(v) ? '' : 'none';
    content.querySelector('[data-p="value2"]').style.display = v === 'between' ? '' : 'none';
    content.querySelector('[data-p="color"]').style.display = CF_COLOR_TYPES.includes(v) ? '' : 'none';
    content.querySelector('[data-p="colorMid"]').style.display = v === 'colorScale3' ? '' : 'none';
    content.querySelector('[data-p="colorMax"]').style.display = ['colorScale2', 'colorScale3'].includes(v) ? '' : 'none';
    content.querySelector('[data-p="icons"]').style.display = v === 'iconSet' ? '' : 'none';
    const vIn = content.querySelector('#cf-value');
    if (['top10', 'bottom10', 'top10Percent', 'bottom10Percent'].includes(v)) vIn.placeholder = 'N (default 10)';
    else if (v === 'expression') vIn.placeholder = '=A1>$B$2 or A1>100';
    else vIn.placeholder = 'e.g. 100 or text';
  });
  const rg = activeSelRange();
  content.querySelector('#cf-range').value = addr(rg.r1, rg.c1) + ':' + addr(rg.r2, rg.c2);
  function renderList() {
    const box = content.querySelector('#cf-list');
    box.innerHTML = '';
    if (!sh.cf.length) { box.innerHTML = '<div class="list-row"><span class="sub">No conditional formatting rules on this sheet yet.</span></div>'; return; }
    sh.cf.forEach((rule, idx) => {
      const desc = describeCf(rule);
      const upDown = '<span class="cf-order-btns">' +
        '<button class="cf-order" data-up' + (idx === 0 ? ' disabled' : '') + ' title="Move rule earlier — applied first (lower precedence)" aria-label="Move rule earlier">\u25b2</button>' +
        '<button class="cf-order" data-down' + (idx === sh.cf.length - 1 ? ' disabled' : '') + ' title="Move rule later — applied last, wins conflicts (higher precedence)" aria-label="Move rule later">\u25bc</button>' +
        '</span>';
      const row = el('<div class="list-row"><span class="grow">' + esc(desc) + (rule.priority != null ? '<span class="cf-imp-badge">imported</span>' : '') + '<div class="sub">' + addr(rule.range.r1, rule.range.c1) + ':' + addr(rule.range.r2, rule.range.c2) + (idx === sh.cf.length - 1 ? ' \u00b7 wins conflicts' : '') + '</div></span>' + upDown + '<button class="btn small" data-del>Remove</button></div>');
      row.querySelector('[data-del]').addEventListener('click', () => {
        const before = sh.cf.slice();
        sh.cf = sh.cf.filter(x => x.id !== rule.id);
        const after = sh.cf.slice();
        pushHistory({ label: 'Remove CF', undo: () => { sh.cf = before.slice(); requestPaint(); }, redo: () => { sh.cf = after.slice(); requestPaint(); } });
        renderList(); requestPaint();
      });
      row.querySelectorAll('.cf-order').forEach(btn => btn.addEventListener('click', () => {
        const dir = btn.hasAttribute('data-up') ? -1 : 1;
        const j = idx + dir;
        if (j < 0 || j >= sh.cf.length) return;
        const before = sh.cf.slice();
        const tmp = sh.cf[idx]; sh.cf[idx] = sh.cf[j]; sh.cf[j] = tmp;
        const after = sh.cf.slice();
        pushHistory({ label: 'Reorder CF', undo: () => { sh.cf = before.slice(); requestPaint(); renderList(); }, redo: () => { sh.cf = after.slice(); requestPaint(); renderList(); } });
        renderList(); requestPaint();
      }));
      box.appendChild(row);
    });
  }
  renderList();
  openModal({
    title: 'Conditional Formatting', width: 560, content,
    buttons: [{ label: 'Close' }, { label: 'Add Rule', primary: true, onClick: () => {
      const type = sel.value;
      const rangeTxt = content.querySelector('#cf-range').value.trim();
      const parsed = parseRangeText(rangeTxt);
      if (!parsed) { toast('Invalid range — use a form like A1:C20', 'error'); return false; }
      const rule = { id: uid(), type, range: parsed };
      if (['greaterThan', 'lessThan', 'equalTo', 'notEqualTo', 'contains', 'beginsWith', 'endsWith'].includes(type)) {
        const v = content.querySelector('#cf-value').value;
        const num = Number(v);
        if (['greaterThan', 'lessThan', 'equalTo', 'notEqualTo'].includes(type) && v.trim() === '') { toast('Enter a value for this rule', 'error'); return false; }
        rule.value = v !== '' && !isNaN(num) ? num : v;
        rule.color = content.querySelector('#cf-color').value;
      } else if (type === 'greaterThanOrEqual' || type === 'lessThanOrEqual') {
        const num = Number(content.querySelector('#cf-value').value);
        if (isNaN(num)) { toast('Enter a number for this rule', 'error'); return false; }
        rule.value = num;
        rule.color = content.querySelector('#cf-color').value;
      } else if (type === 'top10' || type === 'bottom10' || type === 'top10Percent' || type === 'bottom10Percent') {
        const num = Number(content.querySelector('#cf-value').value);
        rule.value = isNaN(num) || num <= 0 ? 10 : Math.trunc(num);
        rule.color = content.querySelector('#cf-color').value;
      } else if (type === 'aboveAverage' || type === 'belowAverage' || type === 'unique' || type === 'duplicates') {
        rule.color = content.querySelector('#cf-color').value;
      } else if (type === 'expression') {
        const f = content.querySelector('#cf-value').value.trim();
        if (!f) { toast('Enter a formula for this rule', 'error'); return false; }
        rule.expr = f[0] === '=' ? f : '=' + f;
        rule.base = { r: parsed.r1, c: parsed.c1 };
        rule.color = content.querySelector('#cf-color').value;
      } else if (type === 'between') {
        const v1 = Number(content.querySelector('#cf-value').value);
        const v2 = Number(content.querySelector('#cf-value2').value);
        if (isNaN(v1) || isNaN(v2)) { toast('Enter two numbers for Between', 'error'); return false; }
        rule.value = v1; rule.value2 = v2;
        rule.color = content.querySelector('#cf-color').value;
      } else if (type === 'colorScale2') {
        rule.colorMin = '#f8c9d4'; rule.colorMax = content.querySelector('#cf-colormax').value;
      } else if (type === 'colorScale3') {
        rule.colorMin = '#f8c9d4'; rule.colorMid = content.querySelector('#cf-colormid').value; rule.colorMax = content.querySelector('#cf-colormax').value;
      } else if (type === 'dataBar') {
        rule.color = content.querySelector('#cf-color').value;
      } else if (type === 'iconSet') {
        rule.icons = content.querySelector('#cf-icons').value;
      } else if (type === 'banded') {
        rule.color = '#eef3f0';
      }
      const before = sh.cf.slice();
      sh.cf.push(rule);
      const after = sh.cf.slice();
      pushHistory({ label: 'Add CF', undo: () => { sh.cf = before.slice(); requestPaint(); }, redo: () => { sh.cf = after.slice(); requestPaint(); } });
      renderList(); requestPaint();
      return false; /* keep dialog open */
    } }]
  });
}
function parseRangeText(txt) {
  try {
    let sheetName = null, ref = txt;
    const bang = txt.lastIndexOf('!');
    if (bang > 0) { sheetName = txt.slice(0, bang).replace(/^'|'$/g, ''); ref = txt.slice(bang + 1); }
    const parts = ref.split(':');
    if (parts.length === 1) { const a = parseAddr(parts[0]); return a ? { r1: a.r, c1: a.c, r2: a.r, c2: a.c } : null; }
    if (parts.length === 2) {
      if (/^[A-Za-z]{1,3}$/.test(parts[0]) && /^[A-Za-z]{1,3}$/.test(parts[1])) return { r1: 0, c1: colIndex(parts[0]), r2: MAX_ROWS - 1, c2: colIndex(parts[1]) };
      const a = parseAddr(parts[0]), b = parseAddr(parts[1]);
      if (a && b) return normRange(a.r, a.c, b.r, b.c);
    }
    return null;
  } catch (e) { return null; }
}
function describeCf(rule) {
  switch (rule.type) {
    case 'greaterThan': return 'Greater than ' + rule.value;
    case 'lessThan': return 'Less than ' + rule.value;
    case 'equalTo': return 'Equal to ' + rule.value;
    case 'notEqualTo': return 'Not equal to ' + rule.value;
    case 'greaterThanOrEqual': return 'Greater than or equal to ' + rule.value;
    case 'lessThanOrEqual': return 'Less than or equal to ' + rule.value;
    case 'between': return 'Between ' + rule.value + ' and ' + rule.value2;
    case 'contains': return 'Contains "' + rule.value + '"';
    case 'beginsWith': return 'Begins with "' + rule.value + '"';
    case 'endsWith': return 'Ends with "' + rule.value + '"';
    case 'aboveAverage': return 'Above average';
    case 'belowAverage': return 'Below average';
    case 'top10': return 'Top ' + (Number(rule.value) || 10) + ' values';
    case 'bottom10': return 'Bottom ' + (Number(rule.value) || 10) + ' values';
    case 'top10Percent': return 'Top ' + (Number(rule.value) || 10) + '% values';
    case 'bottom10Percent': return 'Bottom ' + (Number(rule.value) || 10) + '% values';
    case 'unique': return 'Unique values';
    case 'duplicates': return 'Duplicate values';
    case 'expression': { const e = String(rule.expr || ''); return 'Formula: ' + (e.length > 34 ? e.slice(0, 33) + '…' : e); }
    case 'colorScale2': return 'Color scale (2-color)';
    case 'colorScale3': return 'Color scale (3-color)';
    case 'dataBar': return 'Data bar';
    case 'iconSet': return 'Icon set \u00b7 ' + ({ arrows3: '3 Arrows', traffic3: '3 Traffic Lights', signs3: '3 Signs', flags3: '3 Flags', stars3: '3 Stars', symbols3: '3 Symbols' }[rule.icons] || '3 Arrows');
    case 'banded': return 'Banded rows';
    default: return rule.type;
  }
}
function formatAsTable() {
  const sh = activeSheet();
  const rg = activeSelRange();
  let region;
  if (rg.r2 > rg.r1 && rg.c2 > rg.c1 && !isColSelection(rg) && !isRowSelection(rg)) region = rg;
  else region = detectRegionAround(SEL.active.r, SEL.active.c);
  if (region.r2 <= region.r1) { toast('Select a range with a header row', 'warn'); return; }
  const before = snapshotSheet(sh);
  /* header styling */
  for (let c = region.c1; c <= region.c2; c++) {
    const cell = sh.cells.get(key(region.r1, c));
    const base = cell && cell.s ? Object.assign({}, cell.s) : {};
    writeCell(sh, region.r1, c, { s: normStyle(Object.assign(base, { bold: true, backgroundColor: '#d7e8de', color: '#1c5233' })) });
  }
  const rule = { id: uid(), type: 'banded', range: { r1: region.r1 + 1, c1: region.c1, r2: region.r2, c2: region.c2 }, color: '#eef3f0' };
  sh.cf.push(rule);
  if (!sh.filter) { sh.filter = { range: Object.assign({}, region), cols: {} }; }
  rebuildAllDeps();
  const after = snapshotSheet(sh);
  pushHistory({ label: 'Format as Table', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
  renderFilterChips();
  requestPaint(); Persistence.markDirty();
  toast('Formatted as table with banded rows and filters', 'success');
}

/* ---------------- cell styles gallery ---------------- */
const CELL_STYLES = [
  { name: 'Normal', style: {} },
  { name: 'Good', style: { backgroundColor: '#e2efda', color: '#375623' } },
  { name: 'Bad', style: { backgroundColor: '#fce4e4', color: '#9c0006' } },
  { name: 'Neutral', style: { backgroundColor: '#ffefcz', color: '#9c6500' } },
  { name: 'Input', style: { backgroundColor: '#fffbe6', border: { t: { style: 'thin', color: '#a6a6a6' }, b: { style: 'thin', color: '#a6a6a6' }, l: { style: 'thin', color: '#a6a6a6' }, r: { style: 'thin', color: '#a6a6a6' } } } },
  { name: 'Output', style: { backgroundColor: '#375623', color: '#ffffff', bold: true } },
  { name: 'Heading 1', style: { bold: true, fontSize: 14, color: '#1c5233', border: { b: { style: 'medium', color: '#217346' } } } },
  { name: 'Heading 2', style: { bold: true, fontSize: 12, color: '#3b3a39', border: { b: { style: 'thin', color: '#8a8886' } } } },
  { name: 'Total', style: { bold: true, border: { t: { style: 'double', color: '#217346' }, b: { style: 'thin', color: '#217346' } } } },
  { name: 'Warning', style: { backgroundColor: '#fff2cc', color: '#7f6000', bold: true } },
  { name: 'Note', style: { italic: true, color: '#605e5c', backgroundColor: '#f3f2f1' } },
  { name: 'Currency', style: { numberFormat: '"$"#,##0.00', numFmtCat: 'currency' } }
];
function applyCellStylePreset(preset) {
  applyStyleToSelection(deepClone(preset.style), { label: 'Cell style: ' + preset.name });
}

/* ---------------- Data validation dialog ---------------- */
function openValidationDialog() {
  const sh = activeSheet();
  const rg = activeSelRange();
  const content = el('<div>' +
    '<div class="form-row"><label>Allow</label><div class="fr-input"><select id="dv-type"><option value="wholeNumber">Whole number</option><option value="decimal">Decimal</option><option value="list">List</option><option value="textLength">Text length</option><option value="date">Date</option><option value="custom">Custom formula</option></select></div></div>' +
    '<div class="form-row" data-p="op"><label>Data</label><div class="fr-input"><select id="dv-op"><option value="between">between</option><option value="notBetween">not between</option><option value="eq">equal to</option><option value="ne">not equal to</option><option value="gt">greater than</option><option value="lt">less than</option><option value="gte">greater or equal</option><option value="lte">less or equal</option></select></div></div>' +
    '<div class="form-row" data-p="min"><label>Minimum</label><div class="fr-input"><input type="text" id="dv-min"></div></div>' +
    '<div class="form-row" data-p="max"><label>Maximum</label><div class="fr-input"><input type="text" id="dv-max"></div></div>' +
    '<div class="form-row" data-p="list" style="display:none"><label>Items (one per line)</label><div class="fr-input"><textarea id="dv-list" placeholder="Apple&#10;Banana&#10;Cherry"></textarea></div></div>' +
    '<div class="form-row" data-p="formula" style="display:none"><label>Formula</label><div class="fr-input"><input type="text" id="dv-formula" placeholder="e.g. =A1>0  (use @ for this cell)"></div></div>' +
    '<div class="form-row"><label>Error style</label><div class="fr-input"><select id="dv-style"><option value="stop">Stop — revert invalid entries</option><option value="warning">Warning — allow with confirmation</option></select></div></div>' +
    '<div class="form-row"><label>Error title</label><div class="fr-input"><input type="text" id="dv-etitle" value="Invalid entry"></div></div>' +
    '<div class="form-row"><label>Error message</label><div class="fr-input"><input type="text" id="dv-emsg" placeholder="Shown when the value is rejected"></div></div>' +
    '<div class="form-row"><label>Applies to</label><div class="fr-input"><input type="text" id="dv-range" value="' + addr(rg.r1, rg.c1) + ':' + addr(rg.r2, rg.c2) + '"></div></div>' +
    '<div class="hint">Existing rules for the sheet are listed when you reopen this dialog. Use Data > Data Validation again to manage.</div>' +
    '<div id="dv-listbox" class="listbox" style="max-height:120px"></div></div>');
  const sel = content.querySelector('#dv-type');
  sel.addEventListener('change', () => {
    const v = sel.value;
    content.querySelector('[data-p="op"]').style.display = ['list', 'custom'].includes(v) ? 'none' : '';
    content.querySelector('[data-p="min"]').style.display = ['list', 'custom'].includes(v) ? 'none' : '';
    content.querySelector('[data-p="max"]').style.display = ['list', 'custom', 'gt', 'lt', 'gte', 'lte', 'eq', 'ne'].includes(v) && !['list', 'custom'].includes(v) && !['gt', 'lt', 'gte', 'lte', 'eq', 'ne'].includes(content.querySelector('#dv-op').value) ? '' : 'none';
    content.querySelector('[data-p="max"]').style.display = ['between', 'notBetween'].includes(content.querySelector('#dv-op').value) && !['list', 'custom'].includes(v) ? '' : 'none';
    content.querySelector('[data-p="list"]').style.display = v === 'list' ? '' : 'none';
    content.querySelector('[data-p="formula"]').style.display = v === 'custom' ? '' : 'none';
  });
  function renderDvList() {
    const box = content.querySelector('#dv-listbox');
    box.innerHTML = '';
    if (!sh.dv.length) { box.innerHTML = '<div class="list-row"><span class="sub">No validation rules on this sheet.</span></div>'; return; }
    sh.dv.forEach(dv => {
      const row = el('<div class="list-row"><span class="grow">' + esc(dv.type) + '<div class="sub">' + addr(dv.range.r1, dv.range.c1) + ':' + addr(dv.range.r2, dv.range.c2) + '</div></span><button class="btn small" data-del>Remove</button></div>');
      row.querySelector('[data-del]').addEventListener('click', () => {
        const before = sh.dv.slice();
        sh.dv = sh.dv.filter(x => x.id !== dv.id);
        const after = sh.dv.slice();
        pushHistory({ label: 'Remove validation', undo: () => { sh.dv = before.slice(); }, redo: () => { sh.dv = after.slice(); } });
        renderDvList(); updateDvChips();
      });
      box.appendChild(row);
    });
  }
  renderDvList();
  openModal({
    title: 'Data Validation', width: 560, content,
    buttons: [{ label: 'Close' }, { label: 'Add Rule', primary: true, onClick: () => {
      const parsed = parseRangeText(content.querySelector('#dv-range').value.trim());
      if (!parsed) { toast('Invalid range', 'error'); return false; }
      const dv = { id: uid(), type: sel.value, range: parsed, errorStyle: content.querySelector('#dv-style').value, errorTitle: content.querySelector('#dv-etitle').value, errorText: content.querySelector('#dv-emsg').value };
      if (dv.type === 'list') {
        dv.list = content.querySelector('#dv-list').value.split('\n').map(s => s.trim()).filter(Boolean);
        if (!dv.list.length) { toast('Enter at least one list item', 'error'); return false; }
      } else if (dv.type === 'custom') {
        dv.formula = content.querySelector('#dv-formula').value.trim();
        if (!dv.formula) { toast('Enter a custom formula', 'error'); return false; }
      } else {
        dv.op = content.querySelector('#dv-op').value;
        const mn = Number(content.querySelector('#dv-min').value);
        if (isNaN(mn)) { toast('Enter a valid minimum', 'error'); return false; }
        dv.min = mn;
        if (['between', 'notBetween'].includes(dv.op)) {
          const mx = Number(content.querySelector('#dv-max').value);
          if (isNaN(mx)) { toast('Enter a valid maximum', 'error'); return false; }
          dv.max = mx;
        } else dv.max = dv.min;
      }
      const before = sh.dv.slice();
      sh.dv.push(dv);
      const after = sh.dv.slice();
      pushHistory({ label: 'Add validation', undo: () => { sh.dv = before.slice(); updateDvChips(); }, redo: () => { sh.dv = after.slice(); updateDvChips(); } });
      renderDvList(); updateDvChips();
      return false;
    } }]
  });
}
function updateDvChips() {
  const layer = $('#dv-btn-layer');
  if (!layer || !R.layout) return;
  layer.innerHTML = '';
  const sh = activeSheet();
  if (!sh.dv.length || Edit.active) return;
  const r = SEL.active.r, c = SEL.active.c;
  const dv = sh.dv.find(d => r >= d.range.r1 && r <= d.range.r2 && c >= d.range.c1 && c <= d.range.c2 && d.type === 'list');
  if (!dv) return;
  const rect = cellScreenRect(sh, r, c);
  const chip = el('<button class="dv-chip" title="Choose from list" aria-label="Choose from validation list">' + icon('chevDown') + '</button>');
  chip.style.left = (rect.x + rect.w - 13) + 'px';
  chip.style.top = (rect.y + (rect.h - 15) / 2) + 'px';
  chip.addEventListener('mousedown', e => e.stopPropagation());
  chip.addEventListener('click', e => {
    e.stopPropagation();
    const items = dv.list || [];
    const pop = el('<div class="popup" style="min-width:130px"></div>');
    for (const it of items) {
      const row = el('<div class="popup-item"><span class="pi-label">' + esc(it) + '</span></div>');
      row.addEventListener('click', () => {
        commitCellValue(sh, r, c, it);
        closePopups();
        requestPaint();
      });
      pop.appendChild(row);
    }
    showPopup(pop, chip, { width: 150 });
  });
  layer.appendChild(chip);
}

/* ==========================================================================
 * 13. FLOATING CHARTS
 * ========================================================================== */
const CHART_TYPES = [
  { id: 'column', name: 'Column', icon: 'chartCol' },
  { id: 'bar', name: 'Bar', icon: 'chartBar' },
  { id: 'line', name: 'Line', icon: 'chartLine' },
  { id: 'pie', name: 'Pie', icon: 'chartPie' },
  { id: 'scatter', name: 'Scatter', icon: 'chartScatter' }
];
/* per-chart series customization: colors[] / seriesNames[] override the defaults */
function chartColorAt(chart, si) {
  return (chart && Array.isArray(chart.colors) && chart.colors[si]) || SERIES_COLORS[si % SERIES_COLORS.length];
}
function seriesNameAt(chart, si, fallback) {
  return (chart && Array.isArray(chart.seriesNames) && chart.seriesNames[si]) || fallback;
}
/* ---- combo charts: per-series type override + display-order permutation ---- */
function chartOrderOf(chart, n) {
  /* valid display-order permutation (array of original series indices) or null */
  if (!chart || !Array.isArray(chart.seriesOrder) || chart.seriesOrder.length !== n) return null;
  const o = chart.seriesOrder;
  for (const ix of o) if (!Number.isInteger(ix) || ix < 0 || ix >= n) return null;
  return o;
}
function chartMetaIndex(chart, di, n) {
  /* display index -> original series index (for colors/seriesNames/seriesTypes lookups) */
  const o = chartOrderOf(chart, n);
  return o ? o[di] : di;
}
function seriesTypeAt(chart, si) {
  const t = chart && Array.isArray(chart.seriesTypes) ? chart.seriesTypes[si] : null;
  return (t === 'column' || t === 'line') ? t : null;
}
function chartEffTypes(chart, data) {
  /* effective render type per DISPLAY series index: 'column' | 'bar' | 'line' */
  const n = data.series.length;
  const base = chart.type === 'bar' ? 'bar' : (chart.type === 'line' ? 'line' : 'column');
  if (base === 'pie' || base === 'scatter') return data.series.map(() => base);
  const out = [];
  for (let di = 0; di < n; di++) {
    const st = seriesTypeAt(chart, chartMetaIndex(chart, di, n));
    out.push(st === 'line' ? 'line' : base);
  }
  return out;
}
function chartExtractData(chart) {
  /* returns {categories: [], series: [{name, values[], fmts[]}]} (fmts = source cell number formats) */
  const parsed = parseRangeText(chart.range);
  const out = { categories: [], series: [] };
  if (!parsed) return out;
  const sid = chart.sheetId || WB.activeSheetId;
  const sh = sheetById(sid) || activeSheet();
  const h = parsed.r2 - parsed.r1 + 1, w = parsed.c2 - parsed.c1 + 1;
  if (h * w > 250000) return out;
  const val = (r, c) => {
    const cell = sh.cells.get(key(r, c));
    if (!cell) return null;
    return cell.f ? getComputedCell(sh.id, r, c) : cell.v;
  };
  const fmt = (r, c) => { const cell = sh.cells.get(key(r, c)); return cell && cell.s && cell.s.numberFormat ? cell.s.numberFormat : null; };
  const seriesInRows = !!chart.seriesInRows;
  if (!seriesInRows && w === 1 && h > 0) {
    /* single column: one series, categories = row order */
    const values = [], fmts = [];
    for (let r = parsed.r1; r <= parsed.r2; r++) { const v = val(r, parsed.c1); values.push(typeof v === 'number' ? v : 0); fmts.push(fmt(r, parsed.c1)); }
    out.series.push({ name: chart.title || 'Series 1', values, fmts });
    for (let r = parsed.r1; r <= parsed.r2; r++) out.categories.push(r - parsed.r1 + 1);
    return out;
  }
  if (seriesInRows && h === 1 && w > 0) {
    const values = [], fmts = [];
    for (let c = parsed.c1; c <= parsed.c2; c++) { const v = val(parsed.r1, c); values.push(typeof v === 'number' ? v : 0); fmts.push(fmt(parsed.r1, c)); }
    out.series.push({ name: chart.title || 'Series 1', values, fmts });
    for (let c = parsed.c1; c <= parsed.c2; c++) out.categories.push(c - parsed.c1 + 1);
    return out;
  }
  if (!seriesInRows) {
    const hasHeader = w > 1 && h > 1 && typeof val(parsed.r1, parsed.c1 + 1) === 'string';
    const hasCats = h > 1;
    if (hasCats) for (let r = parsed.r1 + (hasHeader ? 1 : 0); r <= parsed.r2; r++) out.categories.push(val(r, parsed.c1));
    for (let c = parsed.c1 + (hasCats ? 1 : 0); c <= parsed.c2; c++) {
      const name = hasHeader ? String(val(parsed.r1, c) == null ? 'Series ' + (out.series.length + 1) : val(parsed.r1, c)) : 'Series ' + (out.series.length + 1);
      const values = [], fmts = [];
      for (let r = parsed.r1 + (hasHeader ? 1 : 0); r <= parsed.r2; r++) {
        const v = val(r, c);
        values.push(typeof v === 'number' ? v : 0);
        fmts.push(fmt(r, c));
      }
      out.series.push({ name, values, fmts });
    }
  } else {
    const hasHeader = h > 1 && w > 1 && typeof val(parsed.r1 + 1, parsed.c1) === 'string';
    const hasCats = w > 1;
    if (hasCats) for (let c = parsed.c1 + (hasHeader ? 1 : 0); c <= parsed.c2; c++) out.categories.push(val(parsed.r1, c));
    for (let r = parsed.r1 + (hasCats ? 1 : 0); r <= parsed.r2; r++) {
      const name = hasHeader ? String(val(r, parsed.c1) == null ? 'Series ' + (out.series.length + 1) : val(r, parsed.c1)) : 'Series ' + (out.series.length + 1);
      const values = [], fmts = [];
      for (let c = parsed.c1 + (hasCats ? 1 : 0); c <= parsed.c2; c++) {
        const v = val(r, c);
        values.push(typeof v === 'number' ? v : 0);
        fmts.push(fmt(r, c));
      }
      out.series.push({ name, values, fmts });
    }
  }
  /* display-order permutation (series reorder in the chart dialog) */
  const ord = chartOrderOf(chart, out.series.length);
  if (ord) out.series = ord.map(ix => out.series[ix]);
  return out;
}
/* charts that already played their entrance — pop/wipe only plays for NEW charts */
const ChartSeen = { ids: new Set() };
function renderChartsLayer() {
  const layer = $('#chart-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const sh = activeSheet();
  const L = R.layout || computeLayout();
  if (!L) return;
  for (const chart of sh.charts) {
    const frame = el('<div class="chart-frame" data-cid="' + chart.id + '" role="img" aria-label="Chart: ' + esc(chart.title || chart.type) + '" tabindex="0">' +
      '<div class="chart-head"><span class="chart-title">' + esc(chart.title || (CHART_TYPES.find(t => t.id === chart.type) || {}).name || 'Chart') + '</span>' +
      '<button class="iconbtn" data-act="edit" title="Edit chart" aria-label="Edit chart">' + icon('pencil') + '</button>' +
      '<button class="iconbtn" data-act="del" title="Delete chart" aria-label="Delete chart">' + icon('trash') + '</button></div>' +
      '<div class="chart-canvas-wrap"><canvas></canvas></div><div class="chart-resize" title="Resize"></div></div>');
    const w = chart.w * VIEW.zoom, h = chart.h * VIEW.zoom;
    const x = L.gridX + L.frzW + (chart.x - sumFrozen(sh.cols, L.frzC) - Scroll.x) * VIEW.zoom;
    const y = L.gridY + L.frzH + (chart.y - sumFrozen(sh.rows, L.frzR) - Scroll.y) * VIEW.zoom;
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.left = x + 'px';
    frame.style.top = y + 'px';
    if (ChartSeen.ids.has(chart.id) || SmoothScroll.reduced) frame.style.animation = 'none';
    else {
      frame.classList.add('ch-enter');
      ChartSeen.ids.add(chart.id);
    }
    layer.appendChild(frame);
    drawChartCanvas(chart, frame.querySelector('canvas'));
    attachChartEvents(chart, frame);
  }
}
function drawChartCanvas(chart, canvas) {
  const wrap = canvas.parentElement;
  const w = wrap.clientWidth || chart.w * VIEW.zoom, h = wrap.clientHeight || chart.h * VIEW.zoom;
  const dpr = R.dpr;
  canvas.width = Math.max(10, w * dpr);
  canvas.height = Math.max(10, h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  paintChart(ctx, w, h, chart);
}
/* paint a chart body onto an arbitrary 2d context (shared by the chart layer and print/PDF rasterization) */
function paintChart(ctx, w, h, chart) {
  const data = chartExtractData(chart);
  try {
    if (chart.type === 'pie') drawPieChart(ctx, w, h, data, chart);
    else if (chart.type === 'bar') drawBarChart(ctx, w, h, data, chart, true);
    else if (chart.type === 'line') drawLineChart(ctx, w, h, data, chart);
    else if (chart.type === 'scatter') drawScatterChart(ctx, w, h, data, chart);
    else drawBarChart(ctx, w, h, data, chart, false);
  } catch (e) { console.error('chart draw', e); }
  if (!data.series.length) {
    ctx.fillStyle = '#8a8886';
    ctx.font = '12px "Segoe UI"';
    ctx.textAlign = 'center';
    ctx.fillText('No data — edit the chart to choose a range', w / 2, h / 2);
  }
}
/* extra padding demanded by optional axis titles */
function chartTitlePads(chart) {
  const t = chart && chart.axisTitles;
  return { padL: (t && t.y) ? 18 : 0, padB: (t && t.x) ? 16 : 0 };
}
function drawAxisTitles(ctx, chart, padL, padT, padB, plotW, plotH) {
  const t = chart && chart.axisTitles;
  if (!t || (!t.x && !t.y)) return;
  ctx.fillStyle = '#323130';
  ctx.font = '11px "Segoe UI"';
  if (t.x) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t.x, padL + plotW / 2, padT + plotH + 24);
  }
  if (t.y) {
    ctx.save();
    ctx.translate(14, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t.y, 0, 0);
    ctx.restore();
  }
}
function chartLabelFmt(v) { return typeof v === 'number' ? generalNum(Math.round(v * 100) / 100) : String(v); }
/* data-label text: explicit chart format wins, else the source cell's number format, else the rounded default */
function chartLabelFor(chart, s, i, v) {
  let fmt = chart && chart.labelFmt ? String(chart.labelFmt) : null;
  if (!fmt && s && s.fmts && s.fmts[i]) fmt = s.fmts[i];
  if (fmt && fmt !== 'General' && typeof v === 'number') {
    try { const t = formatValue(v, fmt); if (t) return t; } catch (e) { /* fall through to default */ }
  }
  return chartLabelFmt(v);
}
/* point label for line-type series honoring chart.labelPos: out (above) / in (below) / ctr (on point) */
function drawLinePointLabel(ctx, chart, label, x, y) {
  const pos = chart.labelPos || 'out';
  ctx.fillStyle = pos === 'out' ? '#323130' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = pos === 'out' ? 'bottom' : pos === 'in' ? 'top' : 'middle';
  ctx.fillText(label, x, pos === 'out' ? y - 5 : pos === 'in' ? y + 5 : y);
}
function niceTicks(min, max, count) {
  if (min === max) { if (min === 0) { max = 1; } else { min -= 1; max += 1; } }
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  let step = mag;
  for (const m of [1, 2, 2.5, 5, 10]) { if (step0 <= m * mag) { step = m * mag; break; } }
  const t0 = Math.floor(min / step) * step;
  const ticks = [];
  for (let t = t0; t <= max + step * 0.5; t += step) ticks.push(Math.round(t * 1e9) / 1e9);
  return ticks;
}
function chartAxes(ctx, w, h, data, horizontal) {
  /* shared axis layout; returns plot rect and value scale */
  const all = [];
  data.series.forEach(s => all.push(...s.values));
  let max = all.length ? Math.max(...all, 0) : 1;
  let min = all.length ? Math.min(...all, 0) : 0;
  const ticks = niceTicks(min, max, 5);
  return ticks;
}
function drawBarChart(ctx, w, h, data, chart, horizontal) {
  const tp = chartTitlePads(chart);
  const showLbl = !!chart.dataLabels;
  if (horizontal) {
    /* horizontal bars: categories on Y, values on X */
    const padL = 70 + tp.padL, padR = 14, padT = 10, padB = 42 + tp.padB;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;
    const ticks = chartAxes(ctx, w, h, data, horizontal);
    const vmin = ticks[0], vmax = ticks[ticks.length - 1];
    const catCount = Math.max(1, (data.categories.length || (data.series[0] ? data.series[0].values.length : 1)));
    const groupH = plotH / catCount;
    const vx = v => padL + ((v - vmin) / (vmax - vmin || 1)) * plotW;
    ctx.strokeStyle = '#e8eaed'; ctx.fillStyle = '#605e5c'; ctx.font = '10px "Segoe UI"'; ctx.lineWidth = 1;
    for (const t of ticks) {
      const x = Math.round(vx(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(generalNum(t), x, padT + plotH + 6);
    }
    /* horizontal bars + combo line overlays (per-series type override) */
    const effT = chartEffTypes(chart, data);
    const barIdxs = [], lineIdxs = [];
    effT.forEach((t, di) => (t === 'line' ? lineIdxs : barIdxs).push(di));
    const bCount = Math.max(1, barIdxs.length);
    const barH = Math.max(2, Math.min(40, (groupH * 0.7) / bCount));
    barIdxs.forEach((di, slot) => {
      const s = data.series[di];
      ctx.fillStyle = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
      s.values.forEach((v, i) => {
        const y0 = padT + groupH * i + (groupH - barH * bCount) / 2 + slot * barH;
        const x1 = vx(Math.max(vmin, Math.min(vmax, v)));
        const xz = vx(Math.max(vmin, Math.min(vmax, 0)));   /* zero baseline */
        ctx.fillRect(Math.min(x1, xz), y0, Math.max(0, Math.abs(xz - x1)), barH - 1);
        if (showLbl && catCount * bCount <= 60) {
          ctx.font = '9px "Segoe UI"'; ctx.textBaseline = 'middle';
          const label = chartLabelFor(chart, s, i, v);
          const pos = chart.labelPos || 'out';
          const cy = y0 + (barH - 1) / 2;
          if (pos === 'ctr' && x1 - padL > 26) {
            ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff';
            ctx.fillText(label, (padL + x1) / 2, cy);
          } else if (pos === 'in' && x1 - padL > 30) {
            ctx.textAlign = 'right'; ctx.fillStyle = '#ffffff';
            ctx.fillText(label, x1 - 4, cy);
          } else if (x1 + 4 + ctx.measureText(label).width <= w - padR - 2) {
            ctx.textAlign = 'left'; ctx.fillStyle = '#323130';
            ctx.fillText(label, x1 + 4, cy);
          } else if (x1 - padL > 34) {
            ctx.textAlign = 'right'; ctx.fillStyle = '#ffffff';
            ctx.fillText(label, x1 - 4, cy);
          }
          ctx.fillStyle = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
        }
      });
    });
    /* combo: line-type series drawn on top through category centers */
    if (lineIdxs.length) {
      lineIdxs.forEach(di => {
        const s = data.series[di];
        const color = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
        const ly = i => padT + groupH * i + groupH / 2;
        ctx.beginPath();
        s.values.forEach((v, i) => { const x = vx(v), y = ly(i); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.stroke();
        s.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(vx(v), ly(i), 2.5, 0, Math.PI * 2); ctx.fill(); });
        if (showLbl && catCount <= 25) {
          ctx.font = '9px "Segoe UI"';
          s.values.forEach((v, i) => drawLinePointLabel(ctx, chart, chartLabelFor(chart, s, i, v), vx(v), ly(i)));
        }
      });
    }
    const cats = data.categories.length ? data.categories : (data.series[0] ? data.series[0].values.map((_, i) => i + 1) : []);
    const skipY = Math.ceil(cats.length * 14 / plotH);
    cats.forEach((cv, i) => {
      if (i % Math.max(1, skipY) !== 0) return;
      ctx.fillStyle = '#605e5c'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      let label = String(cv == null ? '' : cv);
      ctx.fillText(label.length > 9 ? label.slice(0, 8) + '…' : label, padL - 6, padT + groupH * i + groupH / 2);
    });
    ctx.strokeStyle = '#a19f9d';
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.stroke();
    drawAxisTitles(ctx, chart, padL, padT, padB, plotW, plotH);
    drawLegend(ctx, w, h, data, chart);
    return;
  }
  const padL = 46 + tp.padL, padR = 12, padT = 10, padB = 42 + tp.padB;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (plotW <= 10 || plotH <= 10) return;
  const ticks = chartAxes(ctx, w, h, data, horizontal);
  const vmin = ticks[0], vmax = ticks[ticks.length - 1];
  const catCount = Math.max(1, (data.categories.length || (data.series[0] ? data.series[0].values.length : 1)));
  /* value grid */
  ctx.strokeStyle = '#e8eaed'; ctx.fillStyle = '#605e5c'; ctx.font = '10px "Segoe UI"'; ctx.lineWidth = 1;
  const vy = v => padT + plotH - ((v - vmin) / (vmax - vmin || 1)) * plotH;
  for (const t of ticks) {
    const y = Math.round(vy(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(generalNum(t), padL - 6, y);
  }
  /* bars + combo line overlays (per-series type override) */
  const effT = chartEffTypes(chart, data);
  const barIdxs = [], lineIdxs = [];
  effT.forEach((t, di) => (t === 'line' ? lineIdxs : barIdxs).push(di));
  const sCount = Math.max(1, barIdxs.length);
  const groupW = plotW / catCount;
  const barW = Math.max(2, Math.min(40, (groupW * 0.7) / sCount));
  barIdxs.forEach((di, slot) => {
    const s = data.series[di];
    ctx.fillStyle = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
    s.values.forEach((v, i) => {
      const x0 = padL + groupW * i + (groupW - barW * sCount) / 2 + slot * barW;
      const y0 = vy(Math.max(vmin, Math.min(vmax, v)));
      const yz = vy(Math.max(vmin, Math.min(vmax, 0)));   /* zero baseline */
      ctx.fillRect(x0, Math.min(y0, yz), barW - 1, Math.max(0, Math.abs(yz - y0)));
      if (showLbl && catCount * sCount <= 60) {
        ctx.font = '9px "Segoe UI"'; ctx.textAlign = 'center';
        const label = chartLabelFor(chart, s, i, v);
        const pos = chart.labelPos || 'out';
        const bx = x0 + (barW - 1) / 2;
        const barH0 = padT + plotH - y0;
        if (pos === 'ctr' && barH0 > 12) {
          ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
          ctx.fillText(label, bx, (y0 + padT + plotH) / 2);
        } else if (pos === 'in' && barH0 > 14) {
          ctx.textBaseline = 'top'; ctx.fillStyle = '#ffffff';
          ctx.fillText(label, bx, y0 + 3);
        } else {
          ctx.textBaseline = 'bottom'; ctx.fillStyle = '#323130';
          ctx.fillText(label, bx, y0 - 2);
        }
        ctx.fillStyle = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
      }
    });
  });
  /* combo: line-type series drawn on top through category centers */
  if (lineIdxs.length) {
    lineIdxs.forEach(di => {
      const s = data.series[di];
      const color = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
      const lx = i => padL + groupW * i + groupW / 2;
      ctx.beginPath();
      s.values.forEach((v, i) => { const x = lx(i), y = vy(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      s.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(lx(i), vy(v), 2.5, 0, Math.PI * 2); ctx.fill(); });
      if (showLbl && catCount <= 25) {
        ctx.font = '9px "Segoe UI"';
        s.values.forEach((v, i) => drawLinePointLabel(ctx, chart, chartLabelFor(chart, s, i, v), lx(i), vy(v)));
      }
    });
  }
  /* category labels */
  ctx.fillStyle = '#605e5c';
  const cats = data.categories.length ? data.categories : (data.series[0] ? data.series[0].values.map((_, i) => i + 1) : []);
  const skip = Math.ceil(cats.length * (ctx.measureText('W').width * 8) / plotW);
  cats.forEach((cv, i) => {
    if (i % Math.max(1, skip) !== 0) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.save();
    ctx.translate(padL + groupW * i + groupW / 2, padT + plotH + 6);
    const label = String(cv == null ? '' : cv);
    ctx.fillText(label.length > 9 ? label.slice(0, 8) + '…' : label, 0, 0);
    ctx.restore();
  });
  /* axis line */
  ctx.strokeStyle = '#a19f9d';
  ctx.beginPath(); ctx.moveTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
  drawAxisTitles(ctx, chart, padL, padT, padB, plotW, plotH);
  /* legend */
  drawLegend(ctx, w, h, data, chart);
}
function drawLineChart(ctx, w, h, data, chart) {
  const tp = chartTitlePads(chart);
  const showLbl = !!chart.dataLabels;
  const padL = 46 + tp.padL, padR = 12, padT = 10, padB = 42 + tp.padB;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (plotW <= 10 || plotH <= 10) return;
  const ticks = chartAxes(ctx, w, h, data);
  const vmin = ticks[0], vmax = ticks[ticks.length - 1];
  ctx.strokeStyle = '#e8eaed'; ctx.fillStyle = '#605e5c'; ctx.font = '10px "Segoe UI"';
  const vy = v => padT + plotH - ((v - vmin) / (vmax - vmin || 1)) * plotH;
  for (const t of ticks) {
    const y = Math.round(vy(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(generalNum(t), padL - 6, y);
  }
  const catCount = Math.max(1, (data.categories.length || (data.series[0] ? data.series[0].values.length : 1)));
  const vx = i => padL + (catCount <= 1 ? plotW / 2 : (plotW * i / (catCount - 1)));
  /* combo: column-type series drawn as bars behind the lines */
  const effT = chartEffTypes(chart, data);
  const barIdxs = [], lineIdxs = [];
  effT.forEach((t, di) => (t === 'line' ? lineIdxs : barIdxs).push(di));
  if (barIdxs.length) {
    const bCount = Math.max(1, barIdxs.length);
    const barW = Math.max(2, Math.min(40, (plotW / catCount) * 0.5 / bCount));
    barIdxs.forEach((di, slot) => {
      const s = data.series[di];
      ctx.fillStyle = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
      s.values.forEach((v, i) => {
        const x0 = vx(i) - (barW * bCount) / 2 + slot * barW;
        const y0 = vy(Math.max(vmin, Math.min(vmax, v)));
        const yz = vy(Math.max(vmin, Math.min(vmax, 0)));   /* zero baseline */
        ctx.fillRect(x0, Math.min(y0, yz), barW - 1, Math.max(0, Math.abs(yz - y0)));
        if (showLbl && catCount * bCount <= 60) {
          ctx.font = '9px "Segoe UI"'; ctx.textAlign = 'center';
          const label = chartLabelFor(chart, s, i, v);
          const pos = chart.labelPos || 'out';
          const bx = x0 + (barW - 1) / 2;
          const barH0 = padT + plotH - y0;
          if (pos === 'ctr' && barH0 > 12) {
            ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
            ctx.fillText(label, bx, (y0 + padT + plotH) / 2);
          } else if (pos === 'in' && barH0 > 14) {
            ctx.textBaseline = 'top'; ctx.fillStyle = '#ffffff';
            ctx.fillText(label, bx, y0 + 3);
          } else {
            ctx.textBaseline = 'bottom'; ctx.fillStyle = '#323130';
            ctx.fillText(label, bx, y0 - 2);
          }
          ctx.fillStyle = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
        }
      });
    });
  }
  lineIdxs.forEach(di => {
    const s = data.series[di];
    const color = chartColorAt(chart, chartMetaIndex(chart, di, data.series.length));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.values.forEach((v, i) => { const x = vx(i), y = vy(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = color;
    s.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(vx(i), vy(v), 2.5, 0, Math.PI * 2); ctx.fill(); });
    if (showLbl && catCount <= 25) {
      ctx.font = '9px "Segoe UI"';
      s.values.forEach((v, i) => drawLinePointLabel(ctx, chart, chartLabelFor(chart, s, i, v), vx(i), vy(v)));
    }
  });
  ctx.strokeStyle = '#a19f9d';
  ctx.beginPath(); ctx.moveTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
  drawAxisTitles(ctx, chart, padL, padT, padB, plotW, plotH);
  drawLegend(ctx, w, h, data, chart);
}
function drawPieChart(ctx, w, h, data, chart) {
  const vals = data.series[0] ? data.series[0].values : [];
  const total = vals.reduce((s, v) => s + Math.abs(v), 0);
  if (!total) return;
  const cx = w / 2, cy = h / 2 - 8, r = Math.min(w, h) / 2 - 30;
  let angle = -Math.PI / 2;
  vals.forEach((v, i) => {
    const slice = Math.abs(v) / total * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = chartColorAt(chart, i);
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    if (slice > 0.35) {
      const mid = angle + slice / 2;
      ctx.fillStyle = '#fff';
      ctx.font = '10px "Segoe UI"';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(Math.abs(v) / total * 100) + '%', cx + Math.cos(mid) * r * 0.65, cy + Math.sin(mid) * r * 0.65);
    }
    angle += slice;
  });
  drawLegend(ctx, w, h, data, chart);
}
function drawScatterChart(ctx, w, h, data, chart) {
  const tp = chartTitlePads(chart);
  const padL = 46 + tp.padL, padR = 12, padT = 10, padB = 42 + tp.padB;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (plotW <= 10 || plotH <= 10) return;
  const xs = [], ys = [];
  const first = data.categories.map(v => typeof v === 'number' ? v : 0);
  xs.push(...first);
  data.series.forEach(s => ys.push(...s.values));
  if (!xs.length || !ys.length) return;
  const xticks = niceTicks(Math.min(...xs), Math.max(...xs), 5);
  const yticks = niceTicks(Math.min(...ys, 0), Math.max(...ys, 0), 5);
  const xmin = xticks[0], xmax = xticks[xticks.length - 1], ymin = yticks[0], ymax = yticks[yticks.length - 1];
  const px = x => padL + ((x - xmin) / (xmax - xmin || 1)) * plotW;
  const py = y => padT + plotH - ((y - ymin) / (ymax - ymin || 1)) * plotH;
  ctx.strokeStyle = '#e8eaed'; ctx.fillStyle = '#605e5c'; ctx.font = '10px "Segoe UI"';
  for (const t of xticks) { const x = Math.round(px(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke(); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(generalNum(t), x, padT + plotH + 6); }
  for (const t of yticks) { const y = Math.round(py(t)) + 0.5; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(generalNum(t), padL - 6, y); }
  data.series.forEach((s, si) => {
    ctx.fillStyle = chartColorAt(chart, si);
    s.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(px(xs[i] || 0), py(v), 3.5, 0, Math.PI * 2); ctx.fill(); });
  });
  drawAxisTitles(ctx, chart, padL, padT, padB, plotW, plotH);
  drawLegend(ctx, w, h, data, chart);
}
function drawLegend(ctx, w, h, data, chart) {
  if (!data.series.length) return;
  ctx.font = '10px "Segoe UI"';
  ctx.textBaseline = 'middle';
  let x = 10;
  const y = h - 12;
  const isCartesian = chart.type === 'column' || chart.type === 'bar' || chart.type === 'line';
  const effT = isCartesian ? chartEffTypes(chart, data) : null;
  data.series.slice(0, 6).forEach((s, i) => {
    const mi = chartMetaIndex(chart, i, data.series.length);
    const color = chartColorAt(chart, mi);
    if (effT && effT[i] === 'line') {
      /* line glyph: short stroke + dot */
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 13, y); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x + 6.5, y, 2.4, 0, Math.PI * 2); ctx.fill();
      x += 17;
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 4, 9, 9);
      x += 13;
    }
    ctx.fillStyle = '#3b3a39';
    ctx.textAlign = 'left';
    const fname = String(seriesNameAt(chart, mi, s.name));
    const label = fname.length > 14 ? fname.slice(0, 13) + '…' : fname;
    ctx.fillText(label, x + 2, y);
    x += 4 + ctx.measureText(label).width + 10;
  });
}
function attachChartEvents(chart, frame) {
  frame.addEventListener('mousedown', e => {
    e.stopPropagation();
    document.querySelectorAll('.chart-frame.selected').forEach(f => f.classList.remove('selected'));
    frame.classList.add('selected');
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'del') deleteChart(chart);
      else if (act.dataset.act === 'edit') openChartDialog(chart);
      return;
    }
    if (e.target.classList.contains('chart-resize')) {
      startChartResize(e, chart, frame);
    } else if (e.target.closest('.chart-head')) {
      startChartMove(e, chart, frame);
    }
  });
  frame.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    showPopupMenu([{ label: 'Edit Chart', icon: 'pencil', action: () => openChartDialog(chart) }, { label: 'Delete Chart', icon: 'trash', action: () => deleteChart(chart) }], e.clientX, e.clientY);
  });
  frame.addEventListener('dblclick', e => { e.stopPropagation(); openChartDialog(chart); });
  /* hover tooltips (value readout) */
  const cvs = frame.querySelector('canvas');
  cvs.addEventListener('mousemove', e => {
    const rect = cvs.getBoundingClientRect();
    const hit = chartHitTest(chart, cvs, e.clientX - rect.left, e.clientY - rect.top);
    showChartTip(e.clientX, e.clientY, hit);
  });
  cvs.addEventListener('mouseleave', () => hideChartTip());
}
function chartHitTest(chart, canvas, mx, my) {
  let data;
  try { data = chartExtractData(chart); } catch (e) { return null; }
  if (!data || !data.series.length) return null;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (chart.type === 'pie') {
    const vals = data.series[0] ? data.series[0].values : [];
    const total = vals.reduce((s, v) => s + Math.abs(v), 0);
    if (!total) return null;
    const cx = w / 2, cy = h / 2 - 8, r = Math.max(4, Math.min(w, h) / 2 - 30);
    const dx = mx - cx, dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > r) return null;
    let ang = Math.atan2(dy, dx);
    if (ang < -Math.PI / 2) ang += Math.PI * 2;
    let a = -Math.PI / 2;
    for (let i = 0; i < vals.length; i++) {
      const slice = Math.abs(vals[i]) / total * Math.PI * 2;
      if (ang >= a && ang < a + slice) {
        return { title: data.categories[i] != null ? String(data.categories[i]) : 'Item ' + (i + 1), series: seriesNameAt(chart, 0, data.series[0].name), value: vals[i], pct: Math.round(Math.abs(vals[i]) / total * 100), color: chartColorAt(chart, i) };
      }
      a += slice;
    }
    return null;
  }
  if (chart.type === 'scatter') {
    /* nearest data point within 12px */
    const padL = 46, padR = 12, padT = 10, padB = 42;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return null;
    const xs = data.categories.map(v => typeof v === 'number' ? v : 0);
    const ys = [];
    data.series.forEach(s => ys.push(...s.values));
    if (!xs.length || !ys.length) return null;
    const xticks = niceTicks(Math.min(...xs), Math.max(...xs), 5);
    const yticks = niceTicks(Math.min(...ys, 0), Math.max(...ys, 0), 5);
    const xmin = xticks[0], xmax = xticks[xticks.length - 1], ymin = yticks[0], ymax = yticks[yticks.length - 1];
    const px = x => padL + ((x - xmin) / (xmax - xmin || 1)) * plotW;
    const py = y => padT + plotH - ((y - ymin) / (ymax - ymin || 1)) * plotH;
    const best = { d: Infinity, si: -1, i: -1, v: null };
    data.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const d = Math.sqrt((mx - px(xs[i] || 0)) ** 2 + (my - py(v)) ** 2);
        if (d < best.d) { best.d = d; best.si = si; best.i = i; best.v = v; }
      });
    });
    if (best.si < 0 || best.d > 12) return null;
    const mi = chartMetaIndex(chart, best.si, data.series.length);
    return { title: generalNum(xs[best.i] || 0), series: seriesNameAt(chart, mi, data.series[best.si].name), value: best.v, color: chartColorAt(chart, mi) };
  }
  if (chart.type === 'bar') {
    /* horizontal bars: categories on Y */
    const padL = 70, padR = 14, padT = 10, padB = 42;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return null;
    const all = [];
    data.series.forEach(s => all.push(...s.values));
    if (!all.length) return null;
    const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0), 5);
    const vmin = ticks[0], vmax = ticks[ticks.length - 1];
    const catCount = Math.max(1, (data.categories.length || (data.series[0] ? data.series[0].values.length : 1)));
    const catLabel = i => data.categories[i] != null ? String(data.categories[i]) : 'Item ' + (i + 1);
    const vx = v => padL + ((v - vmin) / (vmax - vmin || 1)) * plotW;
    /* combo line overlays sit on top — test them first */
    const effT = chartEffTypes(chart, data);
    const lineIdxs = [];
    effT.forEach((t, di) => { if (t === 'line') lineIdxs.push(di); });
    if (lineIdxs.length) {
      const ly = i => padT + plotH / catCount * i + plotH / catCount / 2;
      let bestL = null;
      lineIdxs.forEach(di => {
        const s = data.series[di];
        for (let i = 0; i < s.values.length - 1; i++) {
          const d = distToSegment(mx, my, vx(s.values[i]), ly(i), vx(s.values[i + 1]), ly(i + 1));
          if (!bestL || d < bestL.d) bestL = { d, di, i, v: s.values[i] };
        }
      });
      if (bestL && bestL.d <= 8) {
        const mi = chartMetaIndex(chart, bestL.di, data.series.length);
        return { title: catLabel(bestL.i), series: seriesNameAt(chart, mi, data.series[bestL.di].name), value: bestL.v, color: chartColorAt(chart, mi) };
      }
    }
    const barIdxs = [];
    effT.forEach((t, di) => { if (t !== 'line') barIdxs.push(di); });
    const i = Math.floor((my - padT) / (plotH / catCount));
    if (i < 0 || i >= catCount) return null;
    const sCount = Math.max(1, barIdxs.length);
    const groupH = plotH / catCount;
    const barH = Math.max(2, Math.min(40, (groupH * 0.7) / sCount));
    const rel = my - padT - groupH * i - (groupH - barH * sCount) / 2;
    const slot = Math.floor(rel / barH);
    if (rel < 0 || slot < 0 || slot >= barIdxs.length || (rel % barH) > barH - 1) return null;
    const di = barIdxs[slot];
    const s = data.series[di];
    const v = s.values[i];
    if (v == null) return null;
    const x1 = Math.max(padL, vx(Math.max(vmin, Math.min(vmax, v))));
    if (mx < padL || mx > x1) return null;
    const mi = chartMetaIndex(chart, di, data.series.length);
    return { title: catLabel(i), series: seriesNameAt(chart, mi, s.name), value: v, color: chartColorAt(chart, mi) };
  }
  const padL = 46, padR = 12, padT = 10, padB = 42;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (plotW <= 10 || plotH <= 10) return null;
  const all = [];
  data.series.forEach(s => all.push(...s.values));
  if (!all.length) return null;
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0), 5);
  const vmin = ticks[0], vmax = ticks[ticks.length - 1];
  const catCount = Math.max(1, (data.categories.length || (data.series[0] ? data.series[0].values.length : 1)));
  const catLabel = i => data.categories[i] != null ? String(data.categories[i]) : 'Item ' + (i + 1);
  const groupW = plotW / catCount;
  const i = Math.floor((mx - padL) / groupW);
  if (i < 0 || i >= catCount) return null;
  const effT = chartEffTypes(chart, data);
  const barIdxs = [], lineIdxs = [];
  effT.forEach((t, di) => (t === 'line' ? lineIdxs : barIdxs).push(di));
  const vy = v => padT + plotH - ((v - vmin) / (vmax - vmin || 1)) * plotH;
  const isLineBase = chart.type === 'line';
  /* line overlays (and the line base itself) sit on top — test them first */
  if (lineIdxs.length) {
    /* x matches the draw: category centers for line overlays on column/bar base,
       spread positions for the line base itself */
    const vx = isLineBase
      ? padL + (catCount <= 1 ? plotW / 2 : (plotW * i / (catCount - 1)))
      : padL + groupW * i + groupW / 2;
    let best = { d: Infinity, di: -1, v: null };
    lineIdxs.forEach(di => {
      const s = data.series[di];
      const v = s.values[i];
      if (v == null) return;
      const d = Math.abs(mx - vx) + Math.abs(my - vy(v));
      if (d < best.d) { best = { d, di, v }; }
    });
    if (best.di >= 0 && best.d <= 14) {
      const mi = chartMetaIndex(chart, best.di, data.series.length);
      return { title: catLabel(i), series: seriesNameAt(chart, mi, data.series[best.di].name), value: best.v, color: chartColorAt(chart, mi) };
    }
  }
  if (barIdxs.length) {
    const sCount = Math.max(1, barIdxs.length);
    let barW;
    if (isLineBase) {
      /* combo bars in a line chart cluster around the category point */
      barW = Math.max(2, Math.min(40, (plotW / catCount) * 0.5 / sCount));
      const vx = i2 => padL + (catCount <= 1 ? plotW / 2 : (plotW * i2 / (catCount - 1)));
      const rel = mx - (vx(i) - (barW * sCount) / 2);
      const slot = Math.floor(rel / barW);
      if (rel < 0 || slot < 0 || slot >= sCount || (rel % barW) > barW - 1) return null;
      const di = barIdxs[slot];
      const s = data.series[di];
      const v = s.values[i];
      if (v == null) return null;
      const yTop = vy(Math.max(vmin, Math.min(vmax, v)));
      if (my < yTop) return null;
      const mi = chartMetaIndex(chart, di, data.series.length);
      return { title: catLabel(i), series: seriesNameAt(chart, mi, s.name), value: v, color: chartColorAt(chart, mi) };
    }
    barW = Math.max(2, Math.min(40, (groupW * 0.7) / sCount));
    const rel = mx - padL - groupW * i - (groupW - barW * sCount) / 2;
    const slot = Math.floor(rel / barW);
    if (rel < 0 || slot < 0 || slot >= barIdxs.length || (rel % barW) > barW - 1) return null;
    const di = barIdxs[slot];
    const s = data.series[di];
    const v = s.values[i];
    if (v == null) return null;
    const yTop = vy(Math.max(vmin, Math.min(vmax, v)));
    if (my < yTop) return null;   /* above the bar top — e.g. a combo line point */
    const mi = chartMetaIndex(chart, di, data.series.length);
    return { title: catLabel(i), series: seriesNameAt(chart, mi, s.name), value: v, color: chartColorAt(chart, mi) };
  }
  return null;
}
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}
function showChartTip(x, y, hit) {
  let tip = document.getElementById('chart-tip');
  if (!hit) { hideChartTip(); return; }
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chart-tip';
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);
  }
  tip.innerHTML = '<span class="ct-swatch" style="background:' + (hit.color || '#217346') + '"></span>' +
    '<span class="ct-title">' + esc(hit.title) + '</span>' +
    (hit.series ? '<span class="ct-series">' + esc(hit.series) + '</span>' : '') +
    '<span class="ct-value">' + esc(generalNum(hit.value)) + (hit.pct != null ? ' · ' + hit.pct + '%' : '') + '</span>';
  tip.classList.add('open');
  const tw = tip.offsetWidth || 140;
  tip.style.left = Math.min(window.innerWidth - tw - 8, x + 14) + 'px';
  tip.style.top = Math.max(4, y - 34) + 'px';
}
function hideChartTip() {
  const tip = document.getElementById('chart-tip');
  if (tip) tip.classList.remove('open');
}
function startChartMove(e, chart, frame) {
  const startX = e.clientX, startY = e.clientY;
  const ox = chart.x, oy = chart.y;
  function mm(ev) {
    chart.x = Math.max(0, ox + (ev.clientX - startX) / VIEW.zoom);
    chart.y = Math.max(0, oy + (ev.clientY - startY) / VIEW.zoom);
    renderChartsLayer();
  }
  function mu() {
    window.removeEventListener('mousemove', mm);
    window.removeEventListener('mouseup', mu);
    Persistence.markDirty();
  }
  window.addEventListener('mousemove', mm);
  window.addEventListener('mouseup', mu);
}
function startChartResize(e, chart, frame) {
  const startX = e.clientX, startY = e.clientY;
  const ow = chart.w, oh = chart.h;
  function mm(ev) {
    chart.w = clamp(ow + (ev.clientX - startX) / VIEW.zoom, 160, 1600);
    chart.h = clamp(oh + (ev.clientY - startY) / VIEW.zoom, 120, 1200);
    renderChartsLayer();
  }
  function mu() {
    window.removeEventListener('mousemove', mm);
    window.removeEventListener('mouseup', mu);
    Persistence.markDirty();
  }
  window.addEventListener('mousemove', mm);
  window.addEventListener('mouseup', mu);
}
function deleteChart(chart) {
  const sh = activeSheet();
  const before = sh.charts.slice();
  sh.charts = sh.charts.filter(c => c.id !== chart.id);
  const after = sh.charts.slice();
  pushHistory({ label: 'Delete chart', undo: () => { sh.charts = before.slice(); renderChartsLayer(); }, redo: () => { sh.charts = after.slice(); renderChartsLayer(); } });
  renderChartsLayer();
  Persistence.markDirty();
}
function openChartDialog(existing) {
  const sh = activeSheet();
  const rg = activeSelRange();
  const defaultRange = (SEL.sheetId === sh.id && (rg.r2 > rg.r1 || rg.c2 > rg.c1)) ? sh.name + '!' + addr(rg.r1, rg.c1) + ':' + addr(rg.r2, rg.c2) : (existing ? existing.range : sh.name + '!A1:B4');
  const state = {
    type: existing ? existing.type : 'column',
    title: existing ? existing.title : '',
    range: defaultRange,
    seriesInRows: existing ? !!existing.seriesInRows : false,
    colors: existing && Array.isArray(existing.colors) ? existing.colors.slice() : [],
    seriesNames: existing && Array.isArray(existing.seriesNames) ? existing.seriesNames.slice() : [],
    seriesTypes: existing && Array.isArray(existing.seriesTypes) ? existing.seriesTypes.slice() : [],
    order: existing && Array.isArray(existing.seriesOrder) ? existing.seriesOrder.slice() : null,
    dataLabels: existing ? !!existing.dataLabels : false,
    labelPos: existing && existing.labelPos ? existing.labelPos : 'out',
    labelFmt: existing && existing.labelFmt ? String(existing.labelFmt) : '',
    xTitle: existing && existing.axisTitles ? String(existing.axisTitles.x || '') : '',
    yTitle: existing && existing.axisTitles ? String(existing.axisTitles.y || '') : ''
  };
  const content = el('<div><div class="chart-type-grid"></div>' +
    '<div class="form-row"><label>Title</label><div class="fr-input"><input type="text" id="ch-title" placeholder="Optional chart title"></div></div>' +
    '<div class="form-row"><label>Data range</label><div class="fr-input"><input type="text" id="ch-range"></div></div>' +
    '<div class="form-row"><label></label><div class="fr-input"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ch-rows"> Series in rows</label></div></div>' +
    '<div class="form-row" data-cart><label>Data labels</label><div class="fr-input"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ch-labels"> Show values on bars and points</label></div></div>' +
    '<div class="form-row" data-lbl style="display:none"><label>Label options</label><div class="fr-input ch-lbl-inputs"><select id="ch-lblpos" aria-label="Data label position"><option value="out">Outside end</option><option value="in">Inside end</option><option value="ctr">Center</option></select><input type="text" id="ch-lblfmt" placeholder="Label format (blank = source cells)" aria-label="Data label number format"></div></div>' +
    '<div class="form-row" data-cart><label>Axis titles</label><div class="fr-input ch-axis-inputs"><input type="text" id="ch-xt" placeholder="X axis title (optional)" aria-label="X axis title"><input type="text" id="ch-yt" placeholder="Y axis title (optional)" aria-label="Y axis title"></div></div>' +
    '<div class="form-row"><label>Series</label><div class="fr-input"><div id="ch-series" class="ch-series-list" aria-label="Series colors, names, types and order"></div></div></div>' +
    '<div class="hint">Include headers in the range: the first row/column becomes series names, the first column becomes category labels. Column/Line/Bar charts accept per-series type overrides (combo) and reordering.</div></div>');
  const grid = content.querySelector('.chart-type-grid');
  CHART_TYPES.forEach(t => {
    const cell = el('<button class="chart-type-cell' + (t.id === state.type ? ' active' : '') + '" data-t="' + t.id + '" aria-label="' + t.name + ' chart">' + icon(t.icon) + '<span>' + t.name + '</span></button>');
    cell.addEventListener('click', () => {
      state.type = t.id;
      grid.querySelectorAll('.chart-type-cell').forEach(x => x.classList.remove('active'));
      cell.classList.add('active');
      updateCartesianVis();
      if (typeof refreshSeriesEditor === 'function') setTimeout(refreshSeriesEditor, 0);
    });
    grid.appendChild(cell);
  });
  content.querySelector('#ch-title').value = state.title;
  content.querySelector('#ch-range').value = state.range;
  content.querySelector('#ch-rows').checked = state.seriesInRows;
  content.querySelector('#ch-labels').checked = state.dataLabels;
  content.querySelector('#ch-lblpos').value = state.labelPos;
  content.querySelector('#ch-lblfmt').value = state.labelFmt;
  content.querySelector('#ch-xt').value = state.xTitle;
  content.querySelector('#ch-yt').value = state.yTitle;
  /* data labels + axis titles apply to cartesian charts only; label options appear when labels are on */
  function updateLblVis() {
    const row = content.querySelector('[data-lbl]');
    if (row) row.style.display = (state.type !== 'pie' && content.querySelector('#ch-labels').checked) ? '' : 'none';
  }
  content.querySelector('#ch-labels').addEventListener('change', updateLblVis);
  function updateCartesianVis() {
    const cart = state.type !== 'pie';
    content.querySelectorAll('[data-cart]').forEach(rowEl => { rowEl.style.display = cart ? '' : 'none'; });
    updateLblVis();
  }
  updateCartesianVis();
  /* ---- per-series color + name + type + order editor (rebuilds when range/orientation/type changes) ---- */
  const seriesBox = content.querySelector('#ch-series');
  const comboCapable = () => state.type === 'column' || state.type === 'bar' || state.type === 'line';
  function refreshSeriesEditor() {
    seriesBox.innerHTML = '';
    const probe = { range: content.querySelector('#ch-range').value.trim(), seriesInRows: content.querySelector('#ch-rows').checked, sheetId: sh.id, type: state.type, seriesOrder: state.order };
    let data;
    try { data = chartExtractData(probe); } catch (e) { data = null; }
    if (!data || !data.series.length || !data.series[0].values.length) {
      state.order = null;
      seriesBox.innerHTML = '<div class="ch-series-empty">Enter a valid data range to customize series</div>';
      return;
    }
    const n = data.series.length;
    /* display order: keep a saved permutation when it still fits, else identity */
    let order = state.order && state.order.length === n && state.order.every(ix => Number.isInteger(ix) && ix >= 0 && ix < n)
      ? state.order.slice()
      : Array.from({ length: n }, (_, i) => i);
    const isCombo = comboCapable();
    const wireColors = () => seriesBox.querySelectorAll('input[type=color]').forEach(inp =>
      inp.addEventListener('input', () => { state.colors[+inp.dataset.ci] = inp.value; }));
    if (state.type === 'pie') {
      /* pie: one color per data point (slice); labels come from category cells */
      const vals = data.series[0].values;
      vals.slice(0, 12).forEach((v, i) => {
        const def = SERIES_COLORS[i % SERIES_COLORS.length];
        const lbl = String(data.categories[i] != null ? data.categories[i] : 'Point ' + (i + 1));
        const row = el('<div class="ch-series-row"><span class="ch-series-idx">' + (i + 1) + '</span>' +
          '<input type="color" value="' + (state.colors[i] || def) + '" data-ci="' + i + '" aria-label="Color for slice ' + (i + 1) + '">' +
          '<input type="text" class="ch-series-name" value="" disabled title="Pie labels come from the category cells" placeholder="' + esc(lbl) + '" aria-label="Label for slice ' + (i + 1) + '"></div>');
        seriesBox.appendChild(row);
      });
      if (vals.length > 12) seriesBox.appendChild(el('<div class="ch-series-empty">…' + (vals.length - 12) + ' more slices</div>'));
    } else {
      /* data.series is already in display order (the probe applies state.order via
         chartExtractData); order[j] maps display row j -> original series index for meta lookups */
      order.forEach((orig, j) => {
        const s = data.series[j];
        const def = SERIES_COLORS[orig % SERIES_COLORS.length];
        const curType = state.seriesTypes[orig] || '';
        const typeSel = isCombo
          ? '<select class="ch-type-sel" data-ti="' + orig + '" aria-label="Chart type for series ' + (orig + 1) + '" title="Override this series\' chart type (combo)">' +
            '<option value=""' + (curType === '' ? ' selected' : '') + '>' + (state.type === 'line' ? 'Line' : state.type === 'bar' ? 'Bar' : 'Column') + '</option>' +
            (state.type === 'line' ? '<option value="column"' + (curType === 'column' ? ' selected' : '') + '>Column</option>' : '<option value="line"' + (curType === 'line' ? ' selected' : '') + '>Line</option>') +
            '</select>'
          : '';
        const upDown = n > 1
          ? '<span class="ch-order-btns"><button type="button" class="ch-order" data-j="' + j + '" data-d="-1" title="Move series up" aria-label="Move series ' + (j + 1) + ' up"' + (j === 0 ? ' disabled' : '') + '>▲</button>' +
            '<button type="button" class="ch-order" data-j="' + j + '" data-d="1" title="Move series down" aria-label="Move series ' + (j + 1) + ' down"' + (j === n - 1 ? ' disabled' : '') + '>▼</button></span>'
          : '';
        const row = el('<div class="ch-series-row' + (isCombo ? ' has-type' : '') + '"><span class="ch-series-idx">' + (j + 1) + '</span>' +
          '<input type="color" value="' + (state.colors[orig] || def) + '" data-ci="' + orig + '" aria-label="Color for series ' + (orig + 1) + '">' +
          '<input type="text" class="ch-series-name" value="' + esc(String(state.seriesNames[orig] || '')) + '" data-ni="' + orig + '" placeholder="' + esc(String(s.name || ('Series ' + (orig + 1)))) + '" aria-label="Name for series ' + (orig + 1) + '">' +
          typeSel + upDown + '</div>');
        seriesBox.appendChild(row);
      });
      if (n > 8) seriesBox.appendChild(el('<div class="ch-series-empty">…' + (n - 8) + ' more series</div>'));
      seriesBox.querySelectorAll('.ch-series-name').forEach(inp =>
        inp.addEventListener('input', () => { state.seriesNames[+inp.dataset.ni] = inp.value.trim(); }));
      seriesBox.querySelectorAll('.ch-type-sel').forEach(sel =>
        sel.addEventListener('change', () => { state.seriesTypes[+sel.dataset.ti] = sel.value || null; }));
      seriesBox.querySelectorAll('.ch-order').forEach(btn =>
        btn.addEventListener('click', () => {
          const j = +btn.dataset.j, d = +btn.dataset.d;
          const k = j + d;
          if (k < 0 || k >= order.length) return;
          const tmp = order[j]; order[j] = order[k]; order[k] = tmp;
          state.order = order.slice();
          refreshSeriesEditor();
        }));
    }
    wireColors();
  }
  refreshSeriesEditor();
  content.querySelector('#ch-range').addEventListener('change', refreshSeriesEditor);
  content.querySelector('#ch-rows').addEventListener('change', refreshSeriesEditor);
  openModal({
    title: existing ? 'Edit Chart' : 'Insert Chart', width: 520, content,
    buttons: [{ label: 'Cancel' }, { label: existing ? 'Apply' : 'Insert', primary: true, onClick: () => {
      const rangeTxt = content.querySelector('#ch-range').value.trim();
      if (!parseRangeText(rangeTxt)) { toast('Invalid data range', 'error'); return false; }
      state.title = content.querySelector('#ch-title').value.trim();
      state.range = rangeTxt;
      state.seriesInRows = content.querySelector('#ch-rows').checked;
      const isCart = state.type !== 'pie';
      const labelsOn = isCart && content.querySelector('#ch-labels').checked;
      const lblPosSel = content.querySelector('#ch-lblpos').value;
      const lblFmtVal = content.querySelector('#ch-lblfmt').value.trim();
      const labelPosOut = labelsOn && lblPosSel && lblPosSel !== 'out' ? lblPosSel : null;
      const labelFmtOut = labelsOn && lblFmtVal ? lblFmtVal : null;
      const xt = content.querySelector('#ch-xt').value.trim();
      const yt = content.querySelector('#ch-yt').value.trim();
      const axisTitlesOut = isCart && (xt || yt) ? { x: xt || null, y: yt || null } : null;
      const typesClean = comboCapable() ? (state.seriesTypes || []).map(t => (t === 'column' || t === 'line') ? t : null) : [];
      const typesAny = typesClean.some(Boolean);
      const orderClean = comboCapable() && Array.isArray(state.order) ? state.order.slice() : null;
      const orderIsIdentity = orderClean ? orderClean.every((ix, j) => ix === j) : true;
      const orderOut = orderClean && !orderIsIdentity ? orderClean : null;
      if (existing) {
        const colorsClean = (state.colors || []).map(c => c || null);
        const namesClean = (state.seriesNames || []).map(n => n || null);
        Object.assign(existing, { type: state.type, title: state.title, range: state.range, seriesInRows: state.seriesInRows,
          colors: colorsClean.some(Boolean) ? colorsClean : null, seriesNames: namesClean.some(Boolean) ? namesClean : null,
          seriesTypes: typesAny ? typesClean : null, seriesOrder: orderOut,
          dataLabels: labelsOn || null, labelPos: labelPosOut, labelFmt: labelFmtOut, axisTitles: axisTitlesOut });
        renderChartsLayer(); Persistence.markDirty();
        return true;
      }
      const L = R.layout;
      const colorsClean = (state.colors || []).map(c => c || null);
      const namesClean = (state.seriesNames || []).map(n => n || null);
      const chart = {
        id: uid(), type: state.type, title: state.title, range: state.range,
        seriesInRows: state.seriesInRows, sheetId: sh.id,
        colors: colorsClean.some(Boolean) ? colorsClean : null,
        seriesNames: namesClean.some(Boolean) ? namesClean : null,
        seriesTypes: typesAny ? typesClean : null,
        seriesOrder: orderOut,
        dataLabels: labelsOn || null,
        labelPos: labelPosOut,
        labelFmt: labelFmtOut,
        axisTitles: axisTitlesOut,
        x: (Scroll.x + (L.gridW / VIEW.zoom) / 2 - 220),
        y: (Scroll.y + 60),
        w: 440, h: 300
      };
      if (chart.x < 0) chart.x = Scroll.x + 40;
      const before = sh.charts.slice();
      sh.charts.push(chart);
      const after = sh.charts.slice();
      pushHistory({ label: 'Insert chart', undo: () => { sh.charts = before.slice(); renderChartsLayer(); }, redo: () => { sh.charts = after.slice(); renderChartsLayer(); } });
      renderChartsLayer();
      Persistence.markDirty();
      return true;
    } }]
  });
}

/* ==========================================================================
 * 14. IMPORT / EXPORT / PRINT
 * ========================================================================== */
function ensureXlsxLib() {
  return new Promise((resolve) => {
    if (window.XLSX) return resolve(true);
    const tryLoad = (urls, i) => {
      if (i >= urls.length) return resolve(false);
      const s = document.createElement('script');
      s.src = urls[i];
      s.onload = () => resolve(!!window.XLSX);
      s.onerror = () => tryLoad(urls, i + 1);
      document.head.appendChild(s);
    };
    tryLoad([
      'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    ], 0);
  });
}

function importFileDialog() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.txt,.tsv,.xlsx,.xlsm';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      if (/\.xlsx$|\.xlsm$/i.test(file.name)) {
        const ok = await ensureXlsxLib();
        if (!ok) { toast('XLSX support could not be loaded (no internet?). CSV import still works.', 'error', 5000); return; }
        await importXlsx(file);
      } else {
        await importCsv(file);
      }
      if (isWelcomeVisible()) activateEditor();
      updateOwnedUrl();
    } catch (e) {
      console.error(e);
      toast('Import failed: ' + (e && e.message ? e.message : 'unknown error'), 'error', 5000);
    }
  });
  input.click();
}
function typeFromText(txt) {
  const t = String(txt).trim();
  if (t === '') return { v: null };
  if (/^-?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(t) && /\d/.test(t)) return { v: Number(t.replace(/,/g, '')) };
  const d = tryParseDateStr(t);
  if (d != null) return { v: d, s: { numberFormat: NUMCAT.shortDate } };
  return { v: txt };
}
async function importCsv(file) {
  const text = await file.text();
  /* delimiter detection */
  const sample = text.slice(0, 5000);
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of sample) { if (ch === '"') inQ = !inQ; else if (!inQ && counts[ch] != null) counts[ch]++; }
  let delim = ',';
  let best = 0;
  for (const d in counts) if (counts[d] > best) { best = counts[d]; delim = d; }
  const rows = parseDelimited(text, delim);
  if (!rows.length) { toast('The file appears to be empty', 'warn'); return; }
  const base = file.name.replace(/\.[^.]+$/, '') || 'Imported';
  const sh = makeSheet(uniqueSheetName(base.slice(0, 24)));
  const maxCols = Math.min(1000, Math.max(...rows.map(r => r.length)));
  for (let r = 0; r < Math.min(rows.length, MAX_ROWS); r++) {
    for (let c = 0; c < Math.min(rows[r].length, maxCols); c++) {
      const tv = typeFromText(rows[r][c]);
      if (tv.v != null) writeCell(sh, r, c, tv);
    }
  }
  sh.usedMax = { r: Math.min(rows.length - 1, MAX_ROWS - 1), c: maxCols - 1 };
  WB.sheets.push(sh);
  setActiveSheet(sh.id);
  updateSheetTabBar();
  rebuildAllDeps();
  Persistence.markDirty();
  toast('Imported "' + file.name + '" — ' + Math.min(rows.length, MAX_ROWS) + ' rows into sheet "' + sh.name + '"', 'success', 4200);
}
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', inQ = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
async function importXlsx(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellFormula: true, cellStyles: false, cellNF: true, sheetStubs: false });
  if (!wb.SheetNames.length) { toast('The workbook has no sheets', 'warn'); return; }
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const sh = makeSheet(uniqueSheetName(name.slice(0, 28)));
    const ref = ws['!ref'] || 'A1';
    const range = XLSX.utils.decode_range(ref);
    for (let R0 = range.s.r; R0 <= Math.min(range.e.r, 100000); R0++) {
      for (let C0 = range.s.c; C0 <= Math.min(range.e.c, 1000); C0++) {
        const cell = ws[XLSX.utils.encode_cell({ r: R0, c: C0 })];
        if (!cell) continue;
        const addrKey = key(R0, C0);
        const patch = {};
        if (cell.f) { patch.f = '=' + cell.f; if (cell.v !== undefined) patch.v = cell.v; }
        else if (cell.t === 'n') patch.v = cell.v;
        else if (cell.t === 'b') patch.v = !!cell.v;
        else if (cell.t === 's' || cell.t === 'str') patch.v = cell.w != null && cell.v == null ? cell.w : cell.v;
        else if (cell.t === 'd') patch.v = dateToSerial(cell.v);
        else if (cell.w != null) patch.v = cell.w;
        if (cell.z && cell.t === 'n' && cell.z !== 'General') { patch.s = { numberFormat: cell.z }; }
        if (patch.v !== undefined || patch.f) writeCell(sh, R0, C0, patch);
        /* cell comments → notes (thread replies flattened as extra comment entries) */
        if (cell.c && cell.c.length) {
          if (!sh.notes) sh.notes = new Map();
          const main = cell.c[0] || {};
          const replies = cell.c.slice(1).filter(cm => cm && (cm.t != null)).map(cm => ({ a: String(cm.a || 'Me'), t: String(cm.t || ''), ts: null }));
          if (String(main.t || '').trim() || replies.length) {
            sh.notes.set(addrKey, { text: String(main.t || '').trim(), author: String(main.a || ''), ts: null, replies });
          }
        }
      }
    }
    if (ws['!merges']) {
      sh.merges = ws['!merges'].map(m => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
      rebuildMergeMap(sh);
    }
    if (ws['!cols']) {
      ws['!cols'].forEach((cd, i) => { if (cd && cd.wpx) sh.cols.set(i, { size: Math.round(cd.wpx) }); else if (cd && cd.wch) sh.cols.set(i, { size: Math.round(cd.wch * 7) }); });
    }
    if (ws['!rows']) {
      ws['!rows'].forEach((rd, i) => { if (rd && rd.hpx) sh.rows.set(i, { size: Math.round(rd.hpx) }); else if (rd && rd.hpt) sh.rows.set(i, { size: Math.round(rd.hpt * 4 / 3) }); });
    }
    sh.usedMax = { r: Math.min(range.e.r, 100000), c: Math.min(range.e.c, 1000) };
    WB.sheets.push(sh);
  }
  setActiveSheet(WB.sheets[WB.sheets.length - 1].id);
  updateSheetTabBar();
  rebuildAllDeps();
  Persistence.markDirty();
  toast('Imported workbook with ' + wb.SheetNames.length + ' sheet(s)', 'success', 4200);
}
async function exportXlsx() {
  const ok = await ensureXlsxLib();
  if (!ok) { toast('XLSX export needs the SheetJS library (internet). Try CSV export instead.', 'error', 5000); return; }
  const wb = XLSX.utils.book_new();
  for (const sh of WB.sheets) {
    if (sh.hidden) continue;
    const ws = {};
    const ur = usedRange(sh);
    const range = { s: { r: 0, c: 0 }, e: { r: Math.min(ur.r2, 100000), c: Math.min(ur.c2, 1000) } };
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sh.cells.get(key(r, c));
        if (!cell) continue;
        const o = {};
        if (cell.f) { o.f = cell.f.slice(1); const v = cell.f ? getComputedCell(sh.id, r, c) : cell.v; if (isErr(v)) o.v = v.err; else if (v == null) o.v = null; else if (typeof v === 'object' && v.__spark) { continue; } else o.v = v; o.t = typeof o.v === 'number' ? 'n' : typeof o.v === 'boolean' ? 'b' : 's'; if (o.v == null) { o.t = 's'; o.v = ''; } }
        else {
          if (cell.v && typeof cell.v === 'object' && cell.v.__spark) continue;   /* sparkline cells export as blank */
          o.v = cell.v;
          o.t = typeof cell.v === 'number' ? 'n' : typeof cell.v === 'boolean' ? 'b' : 's';
          if (cell.v == null) continue;
        }
        if (cell.s && cell.s.numberFormat) o.z = cell.s.numberFormat;
        ws[XLSX.utils.encode_cell({ r, c })] = o;
      }
    }
    /* notes → cell comments (main note + thread replies); extends !ref to cover noted cells */
    for (const [k, n] of sh.notes) {
      if (!n || !n.text) continue;
      const ix = k.indexOf(',');
      const nr = +k.slice(0, ix), nc = +k.slice(ix + 1);
      if (!isFinite(nr) || !isFinite(nc)) continue;
      if (nr > range.e.r) range.e.r = Math.min(nr, 100000);
      if (nc > range.e.c) range.e.c = Math.min(nc, 1000);
      const aStr = XLSX.utils.encode_cell({ r: nr, c: nc });
      if (!ws[aStr]) ws[aStr] = { t: 's', v: '' };
      const cmts = [{ a: n.author || 'Note', t: n.text }];
      for (const rp of noteReplies(n)) cmts.push({ a: rp.a || 'Me', t: rp.t });
      ws[aStr].c = cmts;
    }
    ws['!ref'] = XLSX.utils.encode_range(range);
    if (sh.merges.length) ws['!merges'] = sh.merges.map(m => ({ s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 } }));
    const cols = [];
    for (let c = 0; c <= range.e.c; c++) cols.push({ wpx: sh.cols.sizeOf(c) });
    ws['!cols'] = cols;
    const rowsA = [];
    for (let r = 0; r <= range.e.r; r++) rowsA.push({ hpx: sh.rows.sizeOf(r) });
    ws['!rows'] = rowsA;
    XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
  }
  const fname = (WB.title || 'workbook').replace(/[\\/:*?"<>|]/g, '_') + '.xlsx';
  try {
    XLSX.writeFile(wb, fname);
    toast('Workbook exported as XLSX (values, formulas, widths, merges, comments)', 'success', 4000);
  } catch (e) {
    console.error(e);
    toast('XLSX export failed: ' + (e && e.message ? e.message : 'unknown error'), 'error', 5000);
  }
}
function exportCsv() {
  const sh = activeSheet();
  const ur = usedRange(sh);
  const lines = [];
  for (let r = 0; r <= Math.min(ur.r2, 100000); r++) {
    const cols = [];
    for (let c = 0; c <= Math.min(ur.c2, 1000); c++) {
      const info = displayValue(sh, r, c);
      let t = info.text;
      if (/[",\n]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
      cols.push(t);
    }
    lines.push(cols.join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, (WB.title || 'sheet').replace(/[\\/:*?"<>|]/g, '_') + ' - ' + sh.name.replace(/[\\/:*?"<>|]/g, '_') + '.csv');
  toast('Active sheet exported as CSV', 'success', 3000);
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
/* rasterize a chart body to a PNG data URL for print/PDF embedding */
function rasterizeChartDataUrl(chart, scale) {
  const w = Math.max(40, Math.round(chart.w)), h = Math.max(30, Math.round(chart.h));
  const sc = scale || 2;
  const cv = document.createElement('canvas');
  cv.width = w * sc; cv.height = h * sc;
  const ctx = cv.getContext('2d');
  ctx.setTransform(sc, 0, 0, sc, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  paintChart(ctx, w, h, chart);
  return cv.toDataURL('image/png');
}
function buildPrintHtml(sh) {
  const ur = usedRange(sh);
  let html = '<div class="print-sheet-title">' + esc(WB.title) + ' — ' + esc(sh.name) + '</div>';
  html += '<div class="print-grid-wrap">';
  html += '<table class="print-grid">';
  for (let r = 0; r <= Math.min(ur.r2, 5000); r++) {
    html += '<tr style="height:' + sh.rows.sizeOf(r) + 'px">';
    for (let c = 0; c <= Math.min(ur.c2, 200); c++) {
      const info = displayValue(sh, r, c);
      const st = info.style;
      const css = [];
      if (st.bold) css.push('font-weight:700');
      if (st.italic) css.push('font-style:italic');
      if (st.backgroundColor) css.push('background:' + st.backgroundColor);
      if (st.color) css.push('color:' + st.color);
      if (st.halign) css.push('text-align:' + st.halign);
      if (st.numberFormat && info.isNum) { /* already formatted in text */ }
      css.push('width:' + sh.cols.sizeOf(c) + 'px');
      let span = '';
      const m = mergeAt(sh, r, c);
      if (m && m.r1 === r && m.c1 === c) { span = ' rowspan="' + (m.r2 - m.r1 + 1) + '" colspan="' + (m.c2 - m.c1 + 1) + '"'; }
      else if (m) { continue; }
      html += '<td' + span + ' style="' + css.join(';') + '">' + esc(info.text) + '</td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  /* floating charts, rasterized and positioned over the grid (chart.x/y share the grid px space) */
  const charts = (sh.charts || []).slice(0, 20);
  for (const chart of charts) {
    try {
      const url = rasterizeChartDataUrl(chart, 2);
      if (!url) continue;
      html += '<div class="print-chart" style="left:' + Math.round(chart.x) + 'px;top:' + Math.round(chart.y) + 'px;width:' + Math.round(chart.w) + 'px;height:' + Math.round(chart.h) + 'px">' +
        '<img src="' + url + '" alt="' + esc(chart.title || 'Chart') + '"></div>';
    } catch (e) { /* skip a broken chart rather than fail the print */ }
  }
  html += '</div>';
  return html;
}
function printWorksheet() {
  const sh = activeSheet();
  const ur = usedRange(sh);
  if (ur.r2 === 0 && ur.c2 === 0 && !sh.cells.get('0,0')) { toast('The sheet is empty — nothing to print', 'warn'); return; }
  const root = $('#print-root');
  root.innerHTML = buildPrintHtml(sh);
  window.print();
}

/* ---------------- file operations ---------------- */
function fileNew() {
  confirmDialog('New Workbook', 'Create a new workbook? Unsaved changes to "' + (WB.title || 'this workbook') + '" are kept in browser storage, but the new workbook becomes active.', () => {
    Persistence.flush();
    const wb = newWorkbookData('Untitled workbook');
    deserializeWorkbook(wb);
    Persistence.setDocId(WB.id);
    H.undo.length = 0; H.redo.length = 0;
    updateUndoRedoUI();
    rebuildAllDeps();
    bootChrome();
    setActiveSheet(WB.activeSheetId);
    updateOwnedUrl();
    Persistence.markDirty();
    Persistence.flush();
  });
}
/* ---------------- Welcome screen (home / workbook overview) ---------------- */
function flushIfDirty() {
  if (Persistence.state === 'dirty') { try { return Persistence.flush(); } catch (e) {} }
  return Promise.resolve();
}
function activateEditor() {
  showWelcomeScreen(false);
  bootChrome();
  rebuildAllDeps();
  resizeCanvas();
  setActiveSheet(WB.activeSheetId);
  updateStatusBar();
  updateNameBox();
  updateFormulaBar();
}
function showWelcomeScreen(show) {
  const ws = $('#welcomeScreen');
  if (!ws) return;
  ws.style.display = show ? 'flex' : 'none';
  document.body.classList.toggle('no-active-wb', show);
  if (show) renderWelcomeCards();
}
function isWelcomeVisible() {
  const ws = $('#welcomeScreen');
  return !!(ws && ws.style.display === 'flex');
}
function fmtCardDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
/* Tiny spreadsheet preview (6x4 cells): header row/col get a green tint when the
   sheet has content; cells with a value/formula get a light fill. */
function wbMiniGrid(data) {
  const visible = (data.sheets || []).filter(s => !s.hidden);
  const sh = visible[0] || (data.sheets || [])[0];
  const cells = (sh && sh.cells) ? sh.cells : {};
  let anyCell = false; for (const k in cells) { anyCell = true; break; }
  const COLS = 6, ROWS = 4;
  let html = '';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = cells[r + ',' + c];
      const filled = !!(cell && (cell.v != null || cell.f));
      let cls = 'wb-cell';
      if (anyCell && (r === 0 || c === 0)) cls += ' hdr';
      if (filled) cls += ' filled';
      html += '<div class="' + cls + '"></div>';
    }
  }
  return html;
}
let welcomeRenderToken = 0;
async function renderWelcomeCards() {
  const container = $('#workbooksDisplay');
  const noContainer = $('#noSheetsContainer');
  if (!container) return;
  const myToken = ++welcomeRenderToken;
  let docs = [];
  try { docs = await IO.allDocs(); } catch (e) { docs = []; }
  if (myToken !== welcomeRenderToken) return;
  docs.sort((a, b) => (b.doc.savedAt || 0) - (a.doc.savedAt || 0));
  if (!docs.length) {
    container.innerHTML = '';
    container.style.display = 'none';
    if (noContainer) noContainer.style.display = 'flex';
    return;
  }
  container.style.display = '';
  if (noContainer) noContainer.style.display = 'none';
  const frag = document.createDocumentFragment();
  for (const d of docs.slice(0, 50)) {
    const data = d.doc.data || {};
    const sheetCount = (data.sheets || []).length;
    const card = el('<div class="workbook-card"></div>');
    card.innerHTML =
      '<div class="workbook-card-thumb"><div class="wb-mini">' + wbMiniGrid(data) + '</div></div>' +
      '<div class="workbook-card-info">' +
      '<div class="workbook-card-title"></div>' +
      '<div class="workbook-card-meta"></div>' +
      '</div>';
    card.querySelector('.workbook-card-title').textContent = data.title || 'Untitled workbook';
    card.querySelector('.workbook-card-meta').textContent =
      sheetCount + (sheetCount === 1 ? ' sheet' : ' sheets') + ' \u00B7 ' + fmtCardDate(d.doc.savedAt || data.createdAt);
    card.addEventListener('click', () => openWorkbook(d.id));
    frag.appendChild(card);
  }
  container.innerHTML = '';
  container.appendChild(frag);
}
async function openWorkbook(id) {
  try {
    await flushIfDirty();
    const doc = await IO.loadDoc(id);
    if (!doc || !doc.data) { toast('Workbook not found', 'error'); return; }
    deserializeWorkbook(Object.assign({ savedAt: doc.savedAt }, doc.data));
    Persistence.setDocId(WB.id);
    H.undo.length = 0; H.redo.length = 0;
    updateUndoRedoUI();
    activateEditor();
    updateOwnedUrl();
    toast('Opened "' + (WB.title || 'Untitled workbook') + '"', 'success');
  } catch (e) { toast('Could not open workbook', 'error'); }
}
function welcomeNew() {
  flushIfDirty();
  const wb = newWorkbookData('Untitled workbook');
  deserializeWorkbook(wb);
  Persistence.setDocId(WB.id);
  H.undo.length = 0; H.redo.length = 0;
  updateUndoRedoUI();
  activateEditor();
  updateOwnedUrl();
  Persistence.markDirty();
  Persistence.flush();
}
function welcomeImport() {
  /* Import into a brand-new workbook so the dormant background workbook isn't mutated. */
  flushIfDirty();
  deserializeWorkbook(newWorkbookData('Untitled workbook'));
  Persistence.setDocId(WB.id);
  H.undo.length = 0; H.redo.length = 0;
  importFileDialog();
}
function closeWorkbookToWelcome() {
  flushIfDirty();
  updateOwnedUrl(true);
  showWelcomeScreen(true);
}

/* Keep the address bar in sync with the open workbook, Docs/Notes/Slides
   style: ?owned=book_<ms>_<hex> while a workbook is open, bare URL on welcome. */
function updateOwnedUrl(forceClear) {
  try {
    if (!forceClear && WB && WB.id && WB._persist !== false) {
      const url = new URL(location.href);
      url.searchParams.set('owned', WB.id);
      history.replaceState({}, document.title, url);
    } else if (location.search) {
      history.replaceState({}, document.title, location.pathname);
    }
  } catch (e) {}
}

/* ---------------- File modal (Backstage-style, Docs/Slides pattern) ---------------- */
function fileModalOpen() { const m = $('#fileModal'); return !!(m && m.classList.contains('show')); }
function syncFileModalNameInput() {
  const n = $('#fileModalNameInput');
  if (n) n.value = WB.title || 'Untitled workbook';
}
function openFileModal() {
  const modal = $('#fileModal');
  if (!modal) return;
  syncFileModalNameInput();
  modal.classList.add('show');
}
function commitFileModalRename() {
  const n = $('#fileModalNameInput');
  if (!n) return;
  const t = n.value.trim() || 'Untitled workbook';
  if (t !== WB.title) {
    WB.title = t;
    Persistence.markDirty();
  }
}
function closeFileModal() {
  const modal = $('#fileModal');
  if (!modal) return;
  commitFileModalRename();
  modal.classList.add('closing');
  setTimeout(() => { modal.classList.remove('show'); modal.classList.remove('closing'); }, 250);
  returnToHomeTab();
}
function returnToHomeTab() {
  if (activeRibbonTab === 'Home') return;
  activeRibbonTab = 'Home';
  const tabsBar = $('#ribbon-tabs');
  tabsBar.querySelectorAll('.ribbon-tab').forEach(t => {
    const on = t.dataset.tab === 'home';
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  positionRibbonIndicator();
  swapRibbonBody();
}
function deleteCurrentWorkbook() {
  confirmDialog('Delete Workbook', 'Delete "' + (WB.title || 'Untitled workbook') + '" from browser storage? This cannot be undone.', async () => {
    try { await IO.deleteDoc(WB.id); } catch (e) {}
    /* Reset the save controller so a pending debounced flush can't re-save the deleted doc. */
    clearTimeout(Persistence.timer); Persistence.timer = 0;
    Persistence.state = 'saved';
    updateSaveStatus();
    deserializeWorkbook(newWorkbookData());
    WB._persist = false;
    Persistence.setDocId(WB.id);
    H.undo.length = 0; H.redo.length = 0;
    updateUndoRedoUI();
    showWelcomeScreen(true);
    updateOwnedUrl();
    toast('Workbook deleted', 'success');
  });
}
async function openDocumentsDialog() {
  let docs = [];
  try { docs = await IO.allDocs(); } catch (e) { toast('Could not read browser storage', 'error'); return; }
  docs.sort((a, b) => (b.doc.savedAt || 0) - (a.doc.savedAt || 0));
  const content = el('<div><div class="listbox" id="doc-list"></div><div class="hint">Documents are stored locally in this browser via IndexedDB.</div></div>');
  const list = content.querySelector('#doc-list');
  if (!docs.length) list.innerHTML = '<div class="list-row"><span class="sub">No saved documents yet.</span></div>';
  for (const d of docs) {
    const data = d.doc.data || {};
    const sheetCount = (data.sheets || []).length;
    const active = d.id === WB.id;
    const row = el('<div class="list-row' + (active ? ' selected' : '') + '"><span class="grow"><b>' + esc(data.title || 'Untitled') + '</b>' + (active ? ' <span class="sub">(open)</span>' : '') + '<div class="sub">' + sheetCount + ' sheet(s) · saved ' + (d.doc.savedAt ? new Date(d.doc.savedAt).toLocaleString() : 'never') + '</div></span>' +
      (active ? '' : '<button class="btn small" data-open>Open</button>') +
      '<button class="btn small" data-del title="Delete document">' + icon('trash') + '</button></div>');
    const openBtn = row.querySelector('[data-open]');
    if (openBtn) openBtn.addEventListener('click', async () => {
      try {
        await Persistence.flush();
        const doc = await IO.loadDoc(d.id);
        deserializeWorkbook(Object.assign({ savedAt: doc.savedAt }, doc.data));
        H.undo.length = 0; H.redo.length = 0;
        updateUndoRedoUI();
        rebuildAllDeps();
        bootChrome();
        setActiveSheet(WB.activeSheetId);
        Persistence.setDocId(WB.id);
        Persistence.markDirty();
        updateOwnedUrl();
        closeModalStack();
        toast('Opened "' + WB.title + '"', 'success');
      } catch (e) { toast('Could not open document', 'error'); }
    });
    row.querySelector('[data-del]').addEventListener('click', async () => {
      confirmDialog('Delete Document', 'Delete "' + esc(data.title || 'Untitled') + '" from browser storage? This cannot be undone.', async () => {
        await IO.deleteDoc(d.id);
        if (d.id === WB.id) {
          clearTimeout(Persistence.timer); Persistence.timer = 0;
          Persistence.state = 'saved';
          updateSaveStatus();
          deserializeWorkbook(newWorkbookData());
          WB._persist = false;
          Persistence.setDocId(WB.id);
          H.undo.length = 0; H.redo.length = 0;
          updateUndoRedoUI();
          closeModalStack();
          showWelcomeScreen(true);
          updateOwnedUrl();
          return;
        }
        openDocumentsDialog();
      });
    });
    list.appendChild(row);
  }
  openModal({ title: 'Saved Documents', width: 520, content, buttons: [{ label: 'Close' }] });
}

/* ==========================================================================
 * 15. CHROME UI — POPUPS / MENUS / MODALS / TOASTS / CONTEXT MENUS
 * ========================================================================== */
let activePopup = null;
function popupOpen() { return !!activePopup; }
function closePopups() {
  if (activePopup) {
    const p = activePopup;
    activePopup = null;
    if (SmoothScroll.reduced) p.remove();
    else { p.classList.add('closing'); p.style.pointerEvents = 'none'; setTimeout(() => p.remove(), 110); }
  }
}
function showPopup(content, anchor, opts = {}) {
  closePopups();
  const root = $('#popup-root');
  let pop;
  if (content instanceof Element && content.classList.contains('popup')) pop = content;
  else { pop = el('<div class="popup"></div>'); if (typeof content === 'string') pop.innerHTML = content; else if (content instanceof Element) pop.appendChild(content); }
  if (opts.width) pop.style.width = opts.width + 'px';
  root.appendChild(pop);
  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: opts.x || 0, bottom: opts.y || 0, top: opts.y || 0, right: opts.x || 0, width: 0, height: 0 };
  let x = opts.x != null ? opts.x : rect.left;
  let y = opts.y != null ? opts.y : rect.bottom + 2;
  if (anchor && !opts.x) { x = rect.left; y = rect.bottom + 2; }
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  x = clamp(x, 4, window.innerWidth - pw - 6);
  y = clamp(y, 4, window.innerHeight - ph - 6);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  activePopup = pop;
  setTimeout(() => {
    const closer = ev => {
      if (activePopup && !activePopup.contains(ev.target)) { closePopups(); }
      document.removeEventListener('mousedown', closer);
    };
    document.addEventListener('mousedown', closer);
  }, 0);
  return pop;
}
function buildMenuItems(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { frag.appendChild(el('<div class="popup-sep"></div>')); continue; }
    if (it.title) { frag.appendChild(el('<div class="popup-title">' + esc(it.title) + '</div>')); continue; }
    const row = el('<div class="popup-item' + (it.disabled ? ' disabled' : '') + (it.checked ? ' checked' : '') + (it.danger ? ' danger' : '') + '" role="menuitem' + (it.disabled ? 'disabled' : '') + '" tabindex="-1">' +
      (it.checked !== undefined ? '<span class="pi-check">' + (it.checked ? icon('check') : '') + '</span>' : '<span class="pi-icon">' + (it.icon ? icon(it.icon) : '') + '</span>') +
      '<span class="pi-label">' + esc(it.label) + '</span>' +
      (it.submenu ? '<span class="pi-sub">▸</span>' : '') +
      (it.shortcut ? '<span class="pi-shortcut">' + esc(it.shortcut) + '</span>' : '') +
      '</div>');
    if (it.submenu && !it.disabled) {
      row.addEventListener('mouseenter', () => {
        let sub = row.querySelector('.popup.sub');
        if (!sub) {
          sub = el('<div class="popup sub"></div>');
          sub.appendChild(buildMenuItems(it.submenu));
          row.appendChild(sub);
          const rr = row.getBoundingClientRect();
          sub.style.position = 'fixed';
          sub.style.left = Math.min(rr.right - 4, window.innerWidth - sub.offsetWidth - 8) + 'px';
          sub.style.top = Math.min(rr.top, window.innerHeight - sub.offsetHeight - 8) + 'px';
          sub.style.zIndex = '95';
          const leave = () => { setTimeout(() => { if (!sub.matches(':hover')) { sub.remove(); row.removeEventListener('mouseleave', leave); } }, 60); };
          row.addEventListener('mouseleave', leave);
        }
      });
    } else if (!it.disabled) {
      row.addEventListener('click', () => { closePopups(); if (it.action) it.action(); });
    }
    frag.appendChild(row);
  }
  return frag;
}
function showPopupMenu(items, x, y) {
  closePopups();
  const pop = el('<div class="popup" role="menu"></div>');
  pop.appendChild(buildMenuItems(items));
  const root = $('#popup-root');
  root.appendChild(pop);
  pop.style.left = clamp(x, 4, window.innerWidth - pop.offsetWidth - 6) + 'px';
  pop.style.top = clamp(y, 4, window.innerHeight - pop.offsetHeight - 6) + 'px';
  activePopup = pop;
  setTimeout(() => {
    const closer = ev => { if (activePopup && !activePopup.contains(ev.target)) closePopups(); document.removeEventListener('mousedown', closer); };
    document.addEventListener('mousedown', closer);
  }, 0);
  return pop;
}
function showCellContextMenu(x, y) {
  const hasFilter = !!activeSheet().filter;
  const shCtx = activeSheet();
  const hasNote = !!noteAt(shCtx, SEL.active.r, SEL.active.c);
  const cell = shCtx.cells.get(key(SEL.active.r, SEL.active.c));
  const isFormula = !!(cell && cell.f);
  const valTxt = displayValue(shCtx, SEL.active.r, SEL.active.c).text;
  const quickFilterLabel = 'Filter by ' + (valTxt === '' ? '(Blanks)' : 'This Value') + (valTxt && valTxt.length <= 14 ? ' (“' + valTxt + '”)' : '');
  showPopupMenu([
    { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', action: () => doCopy(true) },
    { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => doCopy(false) },
    { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: () => { armPaste(); toast('Press Ctrl+V to paste', 'info', 1600); } },
    { sep: true },
    { label: 'Insert…', icon: 'plus', action: () => openInsertDialog('cells') },
    { label: 'Delete…', icon: 'trash', action: () => openInsertDialog('cells-del') },
    { label: 'Clear Contents', icon: 'clear', shortcut: 'Del', action: () => clearSelectionContents('contents') },
    { sep: true },
    { label: hasNote ? 'Edit Note' : 'Insert Note', icon: 'text', shortcut: 'Shift+F2', action: () => openNoteEditor(SEL.active.r, SEL.active.c) },
    hasNote ? { label: 'Reply to Note…', icon: 'comment', action: () => { showNoteThreadPopover(shCtx, SEL.active.r, SEL.active.c, cellScreenRect(shCtx, SEL.active.r, SEL.active.c), true); } } : null,
    hasNote ? { label: 'Delete Note', icon: 'clear', action: () => { setNote(shCtx, SEL.active.r, SEL.active.c, ''); toast('Note deleted', 'info', 1200); } } : null,
    { label: 'Format Cells…', icon: 'grid', action: () => openFormatCellsDialog() },
    { label: 'Pick from Validation List', icon: 'validate', action: () => { updateDvChips(); const chip = document.querySelector('.dv-chip'); if (chip) chip.click(); else toast('No list validation applies to this cell', 'warn'); } },
    { sep: true },
    { label: quickFilterLabel, icon: 'filter', action: () => quickFilterByValue() },
    { label: hasFilter ? 'Reapply Filter' : 'Filter', icon: 'filter', action: () => { if (hasFilter) { applyFilter(); } else toggleFilter(); } },
    { sep: true },
    { label: 'Trace Precedents', icon: 'auditPrec', disabled: !isFormula, action: () => { Audit.mode = 'prec'; requestPaint(); } },
    { label: 'Trace Dependents', icon: 'auditDep', action: () => { Audit.mode = Audit.mode === 'dep' ? null : 'dep'; requestPaint(); } }
  ], x, y);
}
function showRowContextMenu(x, y) {
  const rows = selRows();
  showPopupMenu([
    { label: 'Insert Rows', icon: 'rowInsert', action: () => insertRows(rows[0], rows.length) },
    { label: 'Delete Rows', icon: 'rowDelete', action: () => deleteRows(rows[0], rows.length) },
    { sep: true },
    { label: 'Clear Contents', icon: 'clear', action: () => clearSelectionContents('contents') },
    { sep: true },
    { label: 'Row Height…', icon: 'grid', action: () => promptRowHeight() },
    { label: 'AutoFit Row Height', icon: 'grid', action: () => { rows.forEach(r => autoFitSize('row', r)); } },
    { sep: true },
    { label: 'Hide Rows', icon: 'eyeOff', action: () => setRowsHidden(rows, true) },
    { label: 'Unhide Rows', icon: 'eye', action: () => unhideRowsMenu(x, y) }
  ], x, y);
}
function showColContextMenu(x, y) {
  const cols = selCols();
  showPopupMenu([
    { label: 'Insert Columns', icon: 'colInsert', action: () => insertCols(cols[0], cols.length) },
    { label: 'Delete Columns', icon: 'colDelete', action: () => deleteCols(cols[0], cols.length) },
    { sep: true },
    { label: 'Clear Contents', icon: 'clear', action: () => clearSelectionContents('contents') },
    { sep: true },
    { label: 'Column Width…', icon: 'grid', action: () => promptColWidth() },
    { label: 'AutoFit Column Width', icon: 'grid', action: () => { cols.forEach(c => autoFitSize('col', c)); } },
    { sep: true },
    { label: 'Hide Columns', icon: 'eyeOff', action: () => setColsHidden(cols, true) },
    { label: 'Unhide Columns', icon: 'eye', action: () => unhideColsMenu(x, y) }
  ], x, y);
}
function unhideRowsMenu(x, y) {
  const sh = activeSheet();
  const hidden = [];
  for (const [i, m] of sh.rows.meta) if (m.hidden) hidden.push(+i);
  if (!hidden.length) { toast('No hidden rows on this sheet', 'info'); return; }
  showPopupMenu(hidden.slice(0, 40).map(r => ({ label: 'Row ' + (r + 1), action: () => setRowsHidden([r], false) })), x, y);
}
function unhideColsMenu(x, y) {
  const sh = activeSheet();
  const hidden = [];
  for (const [i, m] of sh.cols.meta) if (m.hidden) hidden.push(+i);
  if (!hidden.length) { toast('No hidden columns on this sheet', 'info'); return; }
  showPopupMenu(hidden.slice(0, 40).map(c => ({ label: 'Column ' + colName(c), action: () => setColsHidden([c], false) })), x, y);
}

/* ---------------- toasts (white glass pill, Docs/Slides/Notes pattern) ---------------- */
let toastTimer = 0;
/* Pick a monochrome #111 SVG icon for a toast message — same pattern as
   Docs' _toastIcon / Slides' _toastIcon. Meaning is carried by the icon
   (the pill is always the same white glass). */
function _toastIcon(rawMsg, type) {
  const msg = String(rawMsg || '').replace(/^\s*[\u2705\u2714\u2716\u2728\u26a0\ufe0f\u2757\u2753\u2139]+\s*/u, '').trim();
  const m = msg.toLowerCase();
  const INK = '#111';
  const svg = paths => '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';

  /* 1. Loading / progress */
  if (m.indexOf('generating') === 0 || m.indexOf('importing') === 0 || m.indexOf('reading') === 0 ||
      m.indexOf('loading') === 0 || m.indexOf('tracing') === 0 || m.indexOf('this may take') !== -1) {
    return { icon: svg('<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>'), msg };
  }

  /* 2. Clipboard / copied / pasted */
  if (m.indexOf('clipboard') !== -1 || m.indexOf('copied') !== -1 || m.indexOf('pasted') !== -1 || m.indexOf('paste ') !== -1) {
    return { icon: svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'), msg };
  }

  /* 3. Failed / error (hard errors) */
  if (m.indexOf('failed') !== -1 || m.indexOf('error') !== -1 || m.indexOf('could not') !== -1 ||
      m.indexOf('couldn') !== -1 || m.indexOf('not supported') !== -1 || m.indexOf('unavailable') !== -1 ||
      m.indexOf('not found') !== -1 || m.indexOf('denied') !== -1 || m.indexOf('invalid') !== -1 ||
      m.indexOf('skipping') !== -1 || m.indexOf('import failed') !== -1) {
    return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'), msg };
  }

  /* 4. Warnings / hints: must / select / no X found / cannot / empty … */
  if (m.indexOf('must have') !== -1 || m.indexOf('must be') !== -1 || m.indexOf('must start') !== -1 ||
      m.indexOf('must contain') !== -1 || m.indexOf('cannot') !== -1 ||
      m.indexOf('can\'t') !== -1 || m.indexOf('select ') !== -1 || m.indexOf('nothing to') !== -1 ||
      m.indexOf('no headings') !== -1 || m.indexOf('no text') !== -1 || m.indexOf('no image') !== -1 ||
      m.indexOf('no matches') !== -1 || m.indexOf('no hidden') !== -1 || m.indexOf('no duplicate') !== -1 ||
      m.indexOf('no list') !== -1 || m.indexOf('no sheets') !== -1 || m.indexOf('no data') !== -1 ||
      m.indexOf('enter a ') !== -1 || m.indexOf('enter at least') !== -1 || m.indexOf('provide a url') !== -1 ||
      m.indexOf('at least one') !== -1 || m.indexOf('at least two') !== -1 || m.indexOf('is empty') !== -1 ||
      m.indexOf('is part of') !== -1 || m.indexOf('outside the filtered') !== -1 || m.indexOf('only visible') !== -1 ||
      m.indexOf('limited to') !== -1 || m.indexOf('must contain') !== -1 || m.indexOf('coming soon') !== -1) {
    return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'), msg };
  }

  /* 5. Deleted / removed / cleared */
  if (m.indexOf('deleted') !== -1 || m.indexOf('removed') !== -1) {
    return { icon: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'), msg };
  }

  /* 6. Milestones */
  if (m.indexOf('%') !== -1 || m.indexOf('halfway') !== -1 || m.indexOf('goal') !== -1 || m.indexOf('well done') !== -1 || m.indexOf('benchmark') !== -1) {
    return { icon: svg('<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'), msg };
  }

  /* 7. Modes toggled */
  if (m.indexOf('mode') !== -1 || m.indexOf('calculation') !== -1 || m.indexOf('read-only') !== -1 || m.indexOf('final') !== -1) {
    return { icon: svg('<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/><path d="M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>'), msg };
  }

  /* 8. Success confirmations */
  if (m.indexOf('saved') !== -1 || m.indexOf('inserted') !== -1 ||
      m.indexOf('applied') !== -1 || m.indexOf('added') !== -1 || m.indexOf('created') !== -1 || m.indexOf('restored') !== -1 ||
      m.indexOf('exported') !== -1 || m.indexOf('imported') !== -1 || m.indexOf('merged') !== -1 || m.indexOf('complete') !== -1 ||
      m.indexOf('finished') !== -1 || m.indexOf('fixed') !== -1 || m.indexOf('cleared') !== -1 || m.indexOf('unlocked') !== -1 ||
      m.indexOf('updated') !== -1 || m.indexOf('jumped to') !== -1 || m.indexOf('toggled') !== -1 || m.indexOf('stopped') !== -1 ||
      m.indexOf('reset') !== -1 || m.indexOf('protected') !== -1 || m.indexOf('marked') !== -1 || m.indexOf('defined') !== -1 ||
      m.indexOf('recalculated') !== -1 || m.indexOf('replaced') !== -1 || m.indexOf('rebuilt') !== -1 || m.indexOf('used') !== -1 ||
      m.indexOf('hidden') !== -1 || m.indexOf('split into') !== -1 || m.indexOf('opened') !== -1 || m.indexOf('reverted') !== -1 ||
      m.indexOf('replayed') !== -1 || m.indexOf('enabled') !== -1 || m.indexOf('formatted as table') !== -1) {
    return { icon: svg('<polyline points="20 6 9 17 4 12"/>'), msg };
  }

  /* 9. Default info */
  return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'), msg };
}
function toast(msg, type = 'info', ms = 2600) {
  const t = $('#toast');
  if (!t) return;
  const pair = _toastIcon(msg, type);
  const outer = document.createElement('span');
  outer.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const iconSpan = document.createElement('span');
  iconSpan.style.cssText = 'display:inline-flex;flex-shrink:0;';
  iconSpan.innerHTML = pair.icon;
  const msgSpan = document.createElement('span');
  msgSpan.textContent = pair.msg;
  outer.appendChild(iconSpan);
  outer.appendChild(msgSpan);
  t.replaceChildren(outer);
  t.className = 'toast show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, ms);
}

/* ---------------- modal infra ---------------- */
const modalStack = [];
function modalIconFor(title) {
  const t = (title || '').toLowerCase();
  const map = [
    ['delete', 'trash'], ['function', 'sigma'], ['chart', 'chartCol'], ['conditional', 'bucket'],
    ['data validation', 'validate'], ['sort', 'sort'], ['filter', 'filter'], ['saved documents', 'folder'],
    ['document', 'file'], ['workbook', 'file'], ['import', 'import'], ['export', 'export'],
    ['print', 'print'], ['save', 'save'], ['named range', 'nameBox'], ['insert', 'plus'],
    ['merge', 'merge'], ['format', 'styles'], ['cells', 'grid'], ['rows', 'rowInsert'],
    ['columns', 'colInsert'], ['new sheet', 'plusSheet'], ['sheet', 'plusSheet'], ['name', 'text']
  ];
  for (const [k, v] of map) if (t.indexOf(k) !== -1) return v;
  return null;
}
function openModal({ title, width, content, buttons, onClose, icon: iconOverride = null, confirm = false }) {
  const overlay = el('<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"></div></div>');
  const modal = overlay.querySelector('.modal');
  if (width) modal.style.width = width + 'px';
  const iconName = iconOverride || modalIconFor(title) || 'info';
  const danger = (buttons || []).some(b => b.danger) || iconName === 'trash';
  modal.classList.add(confirm ? 'confirm' : 'form');
  if (danger) modal.classList.add('danger');
  const head = el('<div class="modal-head"><div class="modal-icon">' + icon(iconName) + '</div><div class="modal-title">' + esc(title) + '</div>' + (confirm ? '' : '<button class="modal-x" aria-label="Close dialog">' + icon('x') + '</button>') + '</div>');
  if (danger) head.querySelector('.modal-icon').classList.add('danger');
  const body = el('<div class="modal-body"></div>');
  if (typeof content === 'string') body.innerHTML = content;
  else if (content instanceof Element) body.appendChild(content);
  const foot = el('<div class="modal-foot"></div>');
  (buttons || [{ label: 'Close' }]).forEach(b => {
    if (!confirm && !b.onClick && (b.label === 'Cancel' || b.label === 'Close') && !b.primary && !b.danger) return;
    const btn = el('<button class="btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') + '">' + esc(b.label) + '</button>');
    btn.addEventListener('click', async () => {
      let ok = true;
      if (b.onClick) ok = await b.onClick() !== false;
      if (ok !== false && b.label !== 'Add Rule') closeModal(overlay);
    });
    foot.appendChild(btn);
  });
  modal.appendChild(head); modal.appendChild(body); modal.appendChild(foot);
  $('#modal-root').appendChild(overlay);
  modalStack.push(overlay);
  const close = () => closeModal(overlay);
  const xBtn = head.querySelector('.modal-x');
  if (xBtn) xBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  /* focus trap + Escape */
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Tab') {
      const focusables = modal.querySelectorAll('button, input, select, textarea, [tabindex]');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  const firstInput = modal.querySelector('input, select, textarea, button.primary');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
  return { close, modal, body };
}
function closeModal(overlay) {
  const i = modalStack.indexOf(overlay);
  if (i !== -1) modalStack.splice(i, 1);
  if (SmoothScroll.reduced) { overlay.remove(); return; }
  overlay.classList.add('closing');
  const mdl = overlay.querySelector('.modal');
  if (mdl) mdl.classList.add('closing');
  setTimeout(() => overlay.remove(), 140);
}
function closeModalStack() { while (modalStack.length) closeModal(modalStack[modalStack.length - 1]); }
function confirmDialog(title, message, onOk, onCancel) {
  const body = el('<div style="white-space:pre-wrap">' + esc(message) + '</div>');
  const danger = modalIconFor(title) === 'trash';
  openModal({
    title, width: 420, content: body, confirm: true,
    buttons: [
      { label: 'Cancel', onClick: () => { if (onCancel) onCancel(); return true; } },
      danger
        ? { label: 'Delete', danger: true, primary: true, onClick: () => { onOk(); return true; } }
        : { label: 'OK', primary: true, onClick: () => { onOk(); return true; } }
    ]
  });
}
function promptDialog(title, label, value, onOk) {
  const content = el('<div><div class="form-row"><label>' + esc(label) + '</label><div class="fr-input"><input type="text" id="pd-input"></div></div><div class="error-text" id="pd-err"></div></div>');
  const input = content.querySelector('#pd-input');
  input.value = value == null ? '' : value;
  openModal({
    title, width: 420, content,
    buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => {
      const err = onOk(input.value);
      if (err) { content.querySelector('#pd-err').textContent = err; return false; }
      return true;
    } }]
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const btns = document.querySelectorAll('.modal-foot .btn.primary'); if (btns.length) btns[btns.length - 1].click(); } });
}

/* ---------------- shared dialogs ---------------- */
function openInsertDialog(kind) {
  if (kind === 'cells-del') {
    openModal({
      title: 'Delete Cells', width: 400,
      content: '<div class="hint">Deleting shifts surrounding cells to fill the gap.</div>' +
        '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="delcells" value="up" checked> Shift cells up</label></div></div>' +
        '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="delcells" value="left"> Shift cells left</label></div></div>' +
        '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="delcells" value="rows"> Entire row(s)</label></div></div>' +
        '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="delcells" value="cols"> Entire column(s)</label></div></div>',
      buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => {
        const v = document.querySelector('input[name="delcells"]:checked').value;
        if (v === 'up') deleteCells('up'); else if (v === 'left') deleteCells('left');
        else if (v === 'rows') { const rows = selRows(); deleteRows(rows[0], rows.length); }
        else { const cols = selCols(); deleteCols(cols[0], cols.length); }
        return true;
      } }]
    });
    return;
  }
  openModal({
    title: 'Insert', width: 400,
    content: '<div class="hint">Inserted cells shift existing data to make room.</div>' +
      '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="inscells" value="down" checked> Shift cells down</label></div></div>' +
      '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="inscells" value="right"> Shift cells right</label></div></div>' +
      '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="inscells" value="rows"> Entire row(s)</label></div></div>' +
      '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="inscells" value="cols"> Entire column(s)</label></div></div>',
    buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => {
      const v = document.querySelector('input[name="inscells"]:checked').value;
      if (v === 'down') insertCells('down'); else if (v === 'right') insertCells('right');
      else if (v === 'rows') { const rows = selRows(); insertRows(rows[0], rows.length); }
      else { const cols = selCols(); insertCols(cols[0], cols.length); }
      return true;
    } }]
  });
}
function openGoToDialog() {
  const names = Object.keys(WB.names);
  const content = el('<div><div class="form-row"><label>Reference</label><div class="fr-input"><input type="text" id="gt-ref" placeholder="A1, B2:C9, Sheet2!A1, MyRange"></div></div><div class="hint">Go to a cell, range, or named range.</div><div id="gt-names"></div></div>');
  const namesBox = content.querySelector('#gt-names');
  if (names.length) {
    const list = el('<div class="listbox"></div>');
    for (const n of names) {
      const def = WB.names[n];
      const row = el('<div class="list-row"><span class="grow">' + esc(def.name) + '<div class="sub">' + esc(def.sheetName || '') + '!' + addr(def.r1, def.c1) + ':' + addr(def.r2, def.c2) + '</div></span></div>');
      row.addEventListener('click', () => { content.querySelector('#gt-ref').value = def.name; });
      list.appendChild(row);
    }
    namesBox.appendChild(list);
  }
  openModal({
    title: 'Go To', width: 430, content,
    buttons: [{ label: 'Cancel' }, { label: 'Go', primary: true, onClick: () => {
      const v = content.querySelector('#gt-ref').value.trim();
      if (!v) return false;
      UI.nameBox.value = v;
      commitNameBox();
      return true;
    } }]
  });
}
function openDefineNameDialog() {
  const sh = activeSheet();
  const rg = activeSelRange();
  const content = el('<div><div class="form-row"><label>Name</label><div class="fr-input"><input type="text" id="nm-name" placeholder="e.g. Sales2024"></div></div><div class="form-row"><label>Refers to</label><div class="fr-input"><input type="text" id="nm-ref" value="' + sh.name + '!' + addr(rg.r1, rg.c1) + ':' + addr(rg.r2, rg.c2) + '"></div></div><div class="hint">Names can be used in formulas (e.g. =SUM(Sales2024)) and in the Name Box.</div><div id="nm-list"></div></div>');
  const listBox = content.querySelector('#nm-list');
  function renderNames() {
    listBox.innerHTML = '';
    const keys = Object.keys(WB.names);
    if (!keys.length) return;
    const list = el('<div class="listbox" style="max-height:140px"></div>');
    for (const k of keys) {
      const def = WB.names[k];
      const row = el('<div class="list-row"><span class="grow">' + esc(def.name) + '<div class="sub">=' + esc(def.sheetName || '') + '!' + addr(def.r1, def.c1) + ':' + addr(def.r2, def.c2) + '</div></span><button class="btn small" data-del>' + icon('trash') + '</button></div>');
      row.querySelector('[data-del]').addEventListener('click', () => { delete WB.names[k]; rebuildAllDeps(); renderNames(); updateNameBox(); Persistence.markDirty(); });
      list.appendChild(row);
    }
    listBox.appendChild(list);
  }
  renderNames();
  openModal({
    title: 'Define Name', width: 480, content,
    buttons: [{ label: 'Close' }, { label: 'Add', primary: true, onClick: () => {
      const name = content.querySelector('#nm-name').value.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) { toast('Names must start with a letter or underscore and contain no spaces', 'error'); return false; }
      const refTxt = content.querySelector('#nm-ref').value.trim();
      let sheetName = sh.name, ref = refTxt;
      const bang = refTxt.lastIndexOf('!');
      if (bang > 0) { sheetName = refTxt.slice(0, bang).replace(/^'|'$/g, ''); ref = refTxt.slice(bang + 1); }
      const target = sheetByName(sheetName);
      if (!target) { toast('Unknown sheet "' + sheetName + '"', 'error'); return false; }
      const parsed = parseRangeText(ref);
      if (!parsed) { toast('Invalid range', 'error'); return false; }
      WB.names[name.toLowerCase()] = { name, sheetId: target.id, sheetName: target.name, r1: parsed.r1, c1: parsed.c1, r2: parsed.r2, c2: parsed.c2 };
      rebuildAllDeps();
      renderNames();
      Persistence.markDirty();
      toast('Named range "' + name + '" defined', 'success');
      return false;
    } }]
  });
}

/* ---------------- Format Cells dialog ---------------- */
function openFormatCellsDialog() {
  const sh = activeSheet();
  const rg = activeSelRange();
  const firstCell = sh.cells.get(key(rg.r1, rg.c1));
  const base = firstCell && firstCell.s ? Object.assign({}, firstCell.s) : {};
  const S = {
    fontFamily: base.fontFamily || DEF.fontFamily, fontSize: base.fontSize || DEF.fontPt,
    bold: !!base.bold, italic: !!base.italic, underline: base.underline || 0, strike: !!base.strike,
    color: base.color || '#1a1a1a', backgroundColor: base.backgroundColor || '',
    halign: base.halign || '', valign: base.valign || '', wrap: !!base.wrap, indent: base.indent || 0,
    numFmtCat: base.numFmtCat || 'general', numberFormat: base.numberFormat || 'General', decimals: base.decimals,
    borderSides: { t: base.border && base.border.t ? base.border.t.style : '', r: base.border && base.border.r ? base.border.r.style : '', b: base.border && base.border.b ? base.border.b.style : '', l: base.border && base.border.l ? base.border.l.style : '' },
    borderColor: (base.border && (base.border.t || base.border.b || base.border.l || base.border.r) || {}).color || '#333333'
  };
  const CATS = [
    ['general', 'General'], ['number', 'Number'], ['currency', 'Currency'], ['accounting', 'Accounting'],
    ['shortDate', 'Short Date'], ['longDate', 'Long Date'], ['time', 'Time'], ['percent', 'Percentage'],
    ['fraction', 'Fraction'], ['scientific', 'Scientific'], ['text', 'Text'], ['custom', 'Custom']
  ];
  const content = el('<div>' +
    '<div class="dlg-tabs"><button class="dlg-tab active" data-p="number">Number</button><button class="dlg-tab" data-p="font">Font</button><button class="dlg-tab" data-p="border">Border</button><button class="dlg-tab" data-p="align">Alignment</button><button class="dlg-tab" data-p="fill">Fill</button></div>' +
    '<div class="dlg-page active" data-p="number"><div class="form-row"><label>Category</label><div class="fr-input"><select id="fc-cat">' + CATS.map(c => '<option value="' + c[0] + '"' + (c[0] === S.numFmtCat ? ' selected' : '') + '>' + c[1] + '</option>').join('') + '</select></div></div>' +
    '<div class="form-row" data-dec><label>Decimal places</label><div class="fr-input"><input type="number" id="fc-dec" min="0" max="10" value="2" style="width:90px"></div></div>' +
    '<div class="form-row" data-fmt><label>Type</label><div class="fr-input"><input type="text" id="fc-fmt" placeholder="0.00"></div></div>' +
    '<div class="form-row"><label>Preview</label><div class="fr-input"><div class="preview-box" id="fc-preview">1234.57</div></div></div></div>' +
    '<div class="dlg-page" data-p="font"><div class="form-row"><label>Font</label><div class="fr-input"><select id="fc-font">' + FONT_LIST.map(f => '<option' + (f === S.fontFamily ? ' selected' : '') + '>' + f + '</option>').join('') + '</select><input type="number" id="fc-size" min="6" max="96" value="' + S.fontSize + '" style="width:80px"></div></div>' +
    '<div class="form-row"><label>Style</label><div class="fr-input"><label><input type="checkbox" id="fc-bold"' + (S.bold ? ' checked' : '') + '> Bold</label><label><input type="checkbox" id="fc-italic"' + (S.italic ? ' checked' : '') + '> Italic</label><label><input type="checkbox" id="fc-strike"' + (S.strike ? ' checked' : '') + '> Strikethrough</label></div></div>' +
    '<div class="form-row"><label>Underline</label><div class="fr-input"><select id="fc-under"><option value="0">None</option><option value="1"' + (S.underline === 1 ? ' selected' : '') + '>Single</option><option value="2"' + (S.underline === 2 ? ' selected' : '') + '>Double</option></select></div></div>' +
    '<div class="form-row"><label>Color</label><div class="fr-input"><input type="color" id="fc-color" value="' + (S.color || '#1a1a1a') + '"></div></div></div>' +
    '<div class="dlg-page" data-p="border"><div class="border-style-row"><label style="font-size:12px;color:#605e5c">Style</label><select id="fc-bstyle"><option value="">(none)</option><option value="thin">Thin</option><option value="medium">Medium</option><option value="thick">Thick</option><option value="double">Double</option></select><label style="font-size:12px;color:#605e5c">Color</label><input type="color" id="fc-bcolor" value="' + S.borderColor + '"></div>' +
    '<div class="mini-grid-cells" id="fc-bgrid"></div><div class="hint">Click cells in the mini grid to toggle each border side of the selection outline, then press Apply. Use presets below for speed.</div>' +
    '<div class="form-row"><label>Presets</label><div class="fr-input"><select id="fc-bpreset"><option value="">Choose…</option><option value="all">All borders</option><option value="out">Outside border</option><option value="thick">Thick outside</option><option value="top">Top</option><option value="bottom">Bottom</option><option value="dblbottom">Double bottom</option><option value="left">Left</option><option value="right">Right</option><option value="none">No border</option></select></div></div></div>' +
    '<div class="dlg-page" data-p="align"><div class="form-row"><label>Horizontal</label><div class="fr-input"><select id="fc-halign"><option value="">General</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div></div>' +
    '<div class="form-row"><label>Vertical</label><div class="fr-input"><select id="fc-valign"><option value="">Default (middle)</option><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></div></div>' +
    '<div class="form-row"><label>Indent</label><div class="fr-input"><input type="number" id="fc-indent" min="0" max="15" value="' + (S.indent || 0) + '" style="width:90px"></div></div>' +
    '<div class="form-row"><label></label><div class="fr-input"><label><input type="checkbox" id="fc-wrap"' + (S.wrap ? ' checked' : '') + '> Wrap text</label></div></div></div>' +
    '<div class="dlg-page" data-p="fill"><div class="form-row"><label>Background</label><div class="fr-input"><input type="color" id="fc-bg" value="' + (S.backgroundColor || '#ffffff') + '"><button class="btn small" id="fc-bgnone">No Fill</button></div></div></div>' +
    '</div>');
  const fmtInput = content.querySelector('#fc-fmt');
  const decInput = content.querySelector('#fc-dec');
  function codeForCat(cat) {
    const d = clamp(parseInt(decInput.value || '2', 10) || 0, 0, 10);
    switch (cat) {
      case 'general': return 'General';
      case 'number': return NUMCAT.number(d);
      case 'currency': return NUMCAT.currency(d);
      case 'accounting': return NUMCAT.accounting(d);
      case 'shortDate': return NUMCAT.shortDate;
      case 'longDate': return NUMCAT.longDate;
      case 'time': return NUMCAT.time;
      case 'percent': return NUMCAT.percent(d);
      case 'fraction': return NUMCAT.fraction;
      case 'scientific': return NUMCAT.scientific;
      case 'text': return '@';
      case 'custom': return fmtInput.value || 'General';
    }
    return 'General';
  }
  function updatePreview() {
    const cat = content.querySelector('#fc-cat').value;
    const code = codeForCat(cat);
    fmtInput.value = cat === 'custom' ? fmtInput.value : code;
    const sampleVals = [1234.567, -1234.5, 0.5, dateToSerial(new Date())];
    const prev = content.querySelector('#fc-preview');
    prev.textContent = sampleVals.map(v => formatValue(v, code)).join('   |   ');
    content.querySelector('[data-dec]').style.display = ['number', 'currency', 'accounting', 'percent'].includes(cat) ? '' : 'none';
    content.querySelector('[data-fmt]').style.display = cat === 'custom' ? '' : 'none';
  }
  content.querySelector('#fc-cat').addEventListener('change', updatePreview);
  decInput.addEventListener('input', updatePreview);
  fmtInput.addEventListener('input', updatePreview);
  updatePreview();
  /* tabs */
  content.querySelectorAll('.dlg-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      content.querySelectorAll('.dlg-tab').forEach(t => t.classList.remove('active'));
      content.querySelectorAll('.dlg-page').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      content.querySelector('.dlg-page[data-p="' + tab.dataset.p + '"]').classList.add('active');
    });
  });
  /* border mini grid: 3x3 where clicking marks sides of the center cell */
  const bgrid = content.querySelector('#fc-bgrid');
  const marks = { t: S.borderSides.t, b: S.borderSides.b, l: S.borderSides.l, r: S.borderSides.r };
  for (let i = 0; i < 9; i++) {
    const cellBtn = el('<button class="mg' + '" data-i="' + i + '"></button>');
    cellBtn.addEventListener('click', () => { /* decorative grid positions map: top row toggles t, middle sides, bottom toggles b */ });
    bgrid.appendChild(cellBtn);
  }
  function paintMarks() {
    const cells = bgrid.querySelectorAll('.mg');
    cells.forEach((cbtn, i) => {
      cbtn.classList.remove('mark');
      if (i === 1 && marks.t) cbtn.classList.add('mark');
      if (i === 7 && marks.b) cbtn.classList.add('mark');
      if (i === 3 && marks.l) cbtn.classList.add('mark');
      if (i === 5 && marks.r) cbtn.classList.add('mark');
    });
  }
  const sideFor = i => i === 1 ? 't' : i === 7 ? 'b' : i === 3 ? 'l' : i === 5 ? 'r' : null;
  bgrid.addEventListener('click', e => {
    const i = e.target.dataset && e.target.dataset.i;
    const side = sideFor(+i);
    if (!side) return;
    marks[side] = marks[side] ? '' : (content.querySelector('#fc-bstyle').value || 'thin');
    paintMarks();
  });
  content.querySelector('#fc-bpreset').addEventListener('change', e => {
    const v = e.target.value;
    const st = content.querySelector('#fc-bstyle').value || 'thin';
    if (v === 'all') { marks.t = marks.b = marks.l = marks.r = 'thin'; }
    else if (v === 'out') { marks.t = marks.b = marks.l = marks.r = st; }
    else if (v === 'thick') { marks.t = marks.b = marks.l = marks.r = 'thick'; }
    else if (v === 'top') { marks.t = st; }
    else if (v === 'bottom') { marks.b = st; }
    else if (v === 'dblbottom') { marks.b = 'double'; }
    else if (v === 'left') { marks.l = st; }
    else if (v === 'right') { marks.r = st; }
    else if (v === 'none') { marks.t = marks.b = marks.l = marks.r = ''; }
    paintMarks();
    e.target.value = '';
  });
  openModal({
    title: 'Format Cells', width: 560, content,
    buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => {
      const cat = content.querySelector('#fc-cat').value;
      const code = cat === 'custom' ? (fmtInput.value || 'General') : codeForCat(cat);
      const dec = clamp(parseInt(decInput.value || '0', 10) || 0, 0, 10);
      const patch = {
        fontFamily: content.querySelector('#fc-font').value,
        fontSize: clamp(parseInt(content.querySelector('#fc-size').value, 10) || 11, 6, 96),
        bold: content.querySelector('#fc-bold').checked,
        italic: content.querySelector('#fc-italic').checked,
        underline: +content.querySelector('#fc-under').value,
        strike: content.querySelector('#fc-strike').checked,
        color: content.querySelector('#fc-color').value,
        halign: content.querySelector('#fc-halign').value || null,
        valign: content.querySelector('#fc-valign').value || null,
        wrap: content.querySelector('#fc-wrap').checked,
        indent: clamp(parseInt(content.querySelector('#fc-indent').value, 10) || 0, 0, 15),
        numberFormat: code === 'General' ? null : code,
        numFmtCat: code === 'General' ? null : cat,
        decimals: ['number', 'currency', 'accounting', 'percent'].includes(cat) ? dec : null
      };
      const bgInput = content.querySelector('#fc-bg');
      const bg = bgInput.dataset.touched ? (bgInput.dataset.none ? null : bgInput.value) : (S.backgroundColor || null);
      patch.backgroundColor = bg;
      const bc = content.querySelector('#fc-bcolor').value;
      const mk = s => marks[s] ? { style: marks[s], color: bc } : null;
      patch.border = { t: mk('t'), r: mk('r'), b: mk('b'), l: mk('l') };
      applyStyleToSelection(patch, { label: 'Format cells' });
      return true;
    } }]
  });
  setTimeout(() => { const nb = content.querySelector('#fc-bgnone'); if (nb) nb.addEventListener('click', () => { content.querySelector('#fc-bg').value = '#ffffff'; content.querySelector('#fc-bg').dataset.none = '1'; content.querySelector('#fc-bg').dataset.touched = '1'; }); const bgIn = content.querySelector('#fc-bg'); bgIn.addEventListener('input', () => { bgIn.dataset.touched = '1'; bgIn.dataset.none = ''; }); }, 0);
}
const FONT_LIST = ['Calibri', 'Segoe UI', 'Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Consolas', 'Impact', 'Comic Sans MS'];
const RIBBON_FONT_GROUPS = [
  ['Sans-Serif', ['Calibri', 'Segoe UI', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Ubuntu', 'Raleway', 'Oswald', 'Work Sans', 'DM Sans', 'Impact']],
  ['Serif', ['Georgia', 'Times New Roman', 'Merriweather', 'Lora', 'Libre Baskerville', 'DM Serif Display', 'Crimson Text']],
  ['Monospace', ['Courier New', 'Consolas', 'Fira Code', 'IBM Plex Mono', 'Courier Prime']],
  ['Handwriting', ['Comic Sans MS', 'Caveat', 'Dancing Script', 'Pacifico', 'Lobster', 'Permanent Marker']]
];
const RIBBON_FONTS = [];
for (const [head, names] of RIBBON_FONT_GROUPS) {
  RIBBON_FONTS.push({ head });
  for (const n of names) RIBBON_FONTS.push({ value: n, dataLabel: n, html: esc(n), style: 'font-family:' + n + ',sans-serif;' });
}

/* ---------------- Insert Function dialog ---------------- */
const RECENT_FUNCS = [];
function openInsertFunctionDialog() {
  const cats = ['All', 'Recently Used', ...[...new Set(FUNC_META.map(f => f.cat))]];
  let curCat = 'All', curSel = FUNC_META.find(f => f.name === 'SUM');
  const content = el('<div style="display:flex;gap:12px;min-height:340px"><div style="width:170px"><input type="search" id="fn-search" placeholder="Search functions" style="width:100%;height:26px;border:1px solid #d4d4d4;border-radius:3px;padding:0 8px;margin-bottom:8px"><div class="cat-list" id="fn-cats"></div></div><div style="flex:1;min-width:0"><div class="listbox" id="fn-list" style="max-height:180px"></div><div class="func-sig" id="fn-sig"></div><div class="func-desc" id="fn-desc"></div></div></div>');
  const catBox = content.querySelector('#fn-cats');
  const listBox = content.querySelector('#fn-list');
  function renderCats() {
    catBox.innerHTML = '';
    for (const c of cats) {
      const row = el('<div class="cat-row' + (c === curCat ? ' selected' : '') + '">' + esc(c) + '</div>');
      row.addEventListener('click', () => { curCat = c; renderCats(); renderList(); });
      catBox.appendChild(row);
    }
  }
  function renderList() {
    const q = content.querySelector('#fn-search').value.toLowerCase();
    listBox.innerHTML = '';
    let items = FUNC_META;
    if (curCat === 'Recently Used') items = RECENT_FUNCS.map(n => FUNC_META.find(f => f.name === n)).filter(Boolean);
    else if (curCat !== 'All') items = FUNC_META.filter(f => f.cat === curCat);
    if (q) items = FUNC_META.filter(f => f.name.toLowerCase().includes(q) || f.desc.toLowerCase().includes(q));
    for (const f of items) {
      const row = el('<div class="cat-row' + (curSel && f.name === curSel.name ? ' selected' : '') + '"><b>' + f.name + '</b> <span style="color:#8a8886;font-size:11px">' + esc(f.args.slice(0, 34)) + '</span></div>');
      /* 1-click flow: first click selects + shows detail, clicking the already-selected row inserts right away.
         (no dblclick handler here — a physical second click fires BOTH click and dblclick, which would insert twice) */
      row.addEventListener('click', () => {
        if (curSel && curSel.name === f.name) { insertFunction(); return; }
        curSel = f; renderList(); showDetail();
      });
      listBox.appendChild(row);
    }
    if (!items.length) listBox.innerHTML = '<div class="cat-row">No matching functions</div>';
  }
  function showDetail() {
    if (!curSel) return;
    content.querySelector('#fn-sig').textContent = curSel.args;
    content.querySelector('#fn-desc').textContent = curSel.desc;
  }
  content.querySelector('#fn-search').addEventListener('input', renderList);
  renderCats(); renderList(); showDetail();
  let lastInsert = 0;
  function insertFunction() {
    const now = Date.now();
    if (now - lastInsert < 450) return;   /* swallow the second click of an accidental double-click */
    lastInsert = now;
    if (!curSel) return;
    if (!RECENT_FUNCS.includes(curSel.name)) { RECENT_FUNCS.unshift(curSel.name); if (RECENT_FUNCS.length > 8) RECENT_FUNCS.pop(); }
    if (!Edit.active) beginEdit(SEL.active.r, SEL.active.c, { cursorMode: true });
    const ed = UI.editor;
    const v = ed.value;
    if (!v.startsWith('=')) ed.value = '=' + curSel.name + '()';
    else ed.value = v + curSel.name + '(';
    ed.focus();
    ed.setSelectionRange(ed.value.length, ed.value.length);
    updateFormulaBarForEdit(ed.value);
  }
  openModal({
    title: 'Insert Function', width: 700, content,
    buttons: [{ label: 'Cancel' }, { label: 'Insert', primary: true, onClick: () => { insertFunction(); return true; } }]
  });
}

/* ==========================================================================
 * 16. MENUBAR / RIBBON / HEADER / SHEET TABS / FIND & REPLACE / BOOT
 * ========================================================================== */
/* All former menu-bar commands live in the ribbon tabs now (see ribbonConfig).
   Keyboard shortcuts are registered independently in the global key handler. */
function openPasteSpecial() {
  if (!Clip.cells) { toast('Clipboard is empty', 'warn'); return; }
  openModal({
    title: 'Paste Special', width: 380,
    content: '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="ps" value="values" checked> Values only</label></div></div>' +
      '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="ps" value="formats"> Formats only</label></div></div>' +
      '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="ps" value="formulas"> Formulas (no formats)</label></div></div>' +
      '<div class="form-row"><label></label><div class="fr-input"><label><input type="radio" name="ps" value="transpose"> Transpose</label></div></div>',
    buttons: [{ label: 'Cancel' }, { label: 'Paste', primary: true, onClick: () => {
      const v = document.querySelector('input[name="ps"]:checked').value;
      doPaste(v);
      return true;
    } }]
  });
}

/* ---------------- ribbon ---------------- */
function colorPaletteItems(onPick, allowNone) {
  const colors = ['#000000', '#404040', '#7f7f7f', '#bfbfbf', '#ffffff', '#843c0c', '#c55a11', '#ed7d31', '#f4b183', '#fbe5d5',
    '#5b3b29', '#a0522d', '#d2691e', '#e8a33d', '#ffe4c4', '#264438', '#217346', '#4ea072', '#a9d5bb', '#e2efda',
    '#1e3a2f', '#2e5e4e', '#388573', '#9dc3ae', '#d7e8de', '#1f3864', '#2f5597', '#4472c4', '#8faadc', '#d9e2f3',
    '#5c2d5c', '#8b5e83', '#b57edc', '#d9b3e6', '#f0e1f7', '#7f1d1d', '#c0392b', '#e74c3c', '#f1948a', '#fadbd8'];
  const items = [{ custom: 'colors', colors, onPick, allowNone }];
  return items;
}
function ribbonConfig() {
  const cmd = (iconName, label, action, opts = {}) => Object.assign({ icon: iconName, label, action, title: opts.title || label }, opts);
  return {
    File: [],
    Home: [
      { label: 'History', items: [
        cmd('undo', 'Undo', () => undo(), { id: 'rbn-undo', title: 'Undo (Ctrl+Z)' }),
        cmd('redo', 'Redo', () => redo(), { id: 'rbn-redo', title: 'Redo (Ctrl+Y)' })
      ]},
      { label: 'Clipboard', items: [
        cmd('cut', 'Cut', () => doCopy(true), { title: 'Cut (Ctrl+X)' }),
        cmd('copy', 'Copy', () => doCopy(false), { title: 'Copy (Ctrl+C)' }),
        cmd('paste', 'Paste', () => doPaste(), { title: 'Paste (Ctrl+V)' })
      ]},
      { label: 'Font', items: [
        { custom: 'fontFamily' }, { custom: 'fontSize' },
        { custom: 'fontChips', items: [
          cmd('bold', '', () => toggleStyle('bold'), { small: true, toggleKey: 'bold', title: 'Bold (Ctrl+B)' }),
          cmd('italic', '', () => toggleStyle('italic'), { small: true, toggleKey: 'italic', title: 'Italic (Ctrl+I)' }),
          cmd('underline', '', () => toggleStyleUnderline(), { small: true, toggleFn: () => { const sh = activeSheet(); let on = false; forEachSelectedCell((r, c) => { const cell = sh.cells.get(key(r, c)); if (cell && cell.s && cell.s.underline) on = true; }); return on; }, title: 'Underline (Ctrl+U)' }),
          cmd('strike', '', () => toggleStyle('strike'), { small: true, toggleKey: 'strike', title: 'Strikethrough' })
        ]},
        { custom: 'fontColor' }, { custom: 'fillColor' },
        cmd('borders', 'Borders', null, { small: true, split: true, menu: [
          { label: 'All Borders', icon: 'borders', action: () => applyBorders('all') },
          { label: 'Outside Borders', icon: 'borders', action: () => applyBorders('out') },
          { label: 'Thick Outside Border', icon: 'borders', action: () => applyBorders('thick') },
          { sep: true },
          { label: 'Top Border', action: () => applyBorders('top') },
          { label: 'Bottom Border', action: () => applyBorders('bottom') },
          { label: 'Double Bottom Border', action: () => applyBorders('dblbottom') },
          { label: 'Left Border', action: () => applyBorders('left') },
          { label: 'Right Border', action: () => applyBorders('right') },
          { sep: true },
          { label: 'No Border', icon: 'x', action: () => applyBorders('none') }
        ] })
      ]},
      { label: 'Alignment', items: [
        { custom: 'stack', items: [
          cmd('alignTop', '', () => applyStyleToSelection({ valign: 'top' }), { title: 'Align top' }),
          cmd('alignMiddle', '', () => applyStyleToSelection({ valign: 'middle' }), { title: 'Align middle' }),
          cmd('alignBottom', '', () => applyStyleToSelection({ valign: 'bottom' }), { title: 'Align bottom' })
        ]},
        { custom: 'stack', items: [
          cmd('alignLeft', '', () => applyStyleToSelection({ halign: 'left' }), { title: 'Align left' }),
          cmd('alignCenter', '', () => applyStyleToSelection({ halign: 'center' }), { title: 'Align center' }),
          cmd('alignRight', '', () => applyStyleToSelection({ halign: 'right' }), { title: 'Align right' })
        ]},
        { custom: 'stack', items: [
          cmd('indentInc', '', () => adjustIndent(1), { title: 'Increase indent' }),
          cmd('indentDec', '', () => adjustIndent(-1), { title: 'Decrease indent' })
        ]},
        cmd('wrap', 'Wrap Text', () => { const sh = activeSheet(); let on = false; forEachSelectedCell((r, c) => { const cell = sh.cells.get(key(r, c)); if (cell && cell.s && cell.s.wrap) on = true; }); applyStyleToSelection({ wrap: !on }); }, { small: true, toggleFn: () => { const sh = activeSheet(); let on = false; forEachSelectedCell((r, c) => { const cell = sh.cells.get(key(r, c)); if (cell && cell.s && cell.s.wrap) on = true; }); return on; }, title: 'Wrap text' }),
        cmd('merge', 'Merge', () => mergeSelection('center'), { small: true, split: true, menu: [
          { label: 'Merge & Center', icon: 'merge', action: () => mergeSelection('center') },
          { label: 'Merge Across', action: () => mergeSelection('across') },
          { label: 'Unmerge', icon: 'unmerge', action: () => mergeSelection('unmerge') }
        ] })
      ]},
      { label: 'Number', items: [
        { custom: 'numFmt' },
        { custom: 'stack', items: [
          cmd('currency', '', () => applyStyleToSelection({ numberFormat: NUMCAT.currency(2), numFmtCat: 'currency' }), { title: 'Currency format' }),
          cmd('percent', '', () => applyStyleToSelection({ numberFormat: NUMCAT.percent(0), numFmtCat: 'percent' }), { title: 'Percent format' }),
          cmd('comma', '', () => applyStyleToSelection({ numberFormat: NUMCAT.number(2), numFmtCat: 'number' }), { title: 'Comma style' })
        ]},
        { custom: 'stack', items: [
          cmd('decInc', '', () => changeDecimals(1), { title: 'Increase decimals' }),
          cmd('decDec', '', () => changeDecimals(-1), { title: 'Decrease decimals' })
        ]}
      ]},
      { label: 'Styles', items: [
        cmd('styles', 'Conditional', () => openConditionalFormattingDialog(), { small: true, title: 'Conditional Formatting' }),
        cmd('table', 'Format as Table', () => formatAsTable(), { small: true }),
        cmd('grid', 'Cell Styles', null, { split: true, menu: CELL_STYLES.map(p => ({ custom: 'styleChip', preset: p })) })
      ]}
    ],
    Insert: [
      { label: 'Charts', items: CHART_TYPES.map(t => cmd(t.icon, t.name + ' Chart', () => openChartDialogFor(t.id), { small: true })) },
      { label: 'Cells', items: [
        cmd('plus', 'Insert Cells', () => openInsertDialog('cells'), { small: true, title: 'Insert cells, shifting others' }),
        cmd('rowInsert', 'Insert Rows', () => { const rows = selRows(); insertRows(rows[0], rows.length); }, { small: true }),
        cmd('colInsert', 'Insert Columns', () => { const cols = selCols(); insertCols(cols[0], cols.length); }, { small: true }),
        cmd('plusSheet', 'New Sheet', () => addSheet(WB.activeSheetId), { small: true }),
        cmd('trash', 'Delete', null, { split: true, menu: [
          { label: 'Delete Cells…', action: () => openInsertDialog('cells-del') },
          { label: 'Delete Rows', icon: 'rowDelete', action: () => { const rows = selRows(); deleteRows(rows[0], rows.length); } },
          { label: 'Delete Columns', icon: 'colDelete', action: () => { const cols = selCols(); deleteCols(cols[0], cols.length); } },
          { label: 'Delete Sheet', icon: 'trash', action: () => deleteSheetById(WB.activeSheetId) }
        ] }),
        cmd('grid', 'Format', null, { split: true, menu: [
          { label: 'Row Height…', action: () => promptRowHeight() },
          { label: 'AutoFit Row Height', action: () => { selRows().forEach(r => autoFitSize('row', r)); } },
          { label: 'Column Width…', action: () => promptColWidth() },
          { label: 'AutoFit Column Width', action: () => { selCols().forEach(c => autoFitSize('col', c)); } },
          { sep: true },
          { label: 'Hide Rows', action: () => setRowsHidden(selRows(), true) },
          { label: 'Unhide Rows…', action: () => unhideRowsMenu(300, 200) },
          { label: 'Hide Columns', action: () => setColsHidden(selCols(), true) },
          { label: 'Unhide Columns…', action: () => unhideColsMenu(300, 200) },
          { sep: true },
          { label: 'Format Cells…', action: () => openFormatCellsDialog() }
        ] })
      ]},
      { label: 'Notes & Names', items: [
        cmd('text', 'Note', () => openNoteEditor(SEL.active.r, SEL.active.c), { small: true, title: 'Add a note to the active cell (Shift+F2)' }),
        cmd('nameBox', 'Define Name', () => openDefineNameDialog(), { small: true })
      ]}
    ],
    Formulas: [
      { label: 'Function Library', items: [
        cmd('fx', 'Insert Function', () => openInsertFunctionDialog(), { small: true, title: 'Insert Function' }),
        cmd('sum', 'AutoSum', () => autoSum('SUM'), { split: true, menu: [
          { label: 'Sum', icon: 'sum', action: () => autoSum('SUM') },
          { label: 'Average', action: () => autoSum('AVERAGE') },
          { label: 'Count Numbers', action: () => autoSum('COUNT') },
          { label: 'Max', action: () => autoSum('MAX') },
          { label: 'Min', action: () => autoSum('MIN') }
        ] }),
        cmd('calculate', 'Recently Used', null, { split: true, menu: () => RECENT_FUNCS.length ? RECENT_FUNCS.map(n => ({ label: n, action: () => insertFunctionByName(n) })) : [{ label: '(none yet)', disabled: true }] }),
        cmd('file', 'Financial', null, { split: true, menu: catFunctions('Financial') }),
        cmd('validate', 'Logical', null, { split: true, menu: catFunctions('Logical') }),
        cmd('text', 'Text', null, { split: true, menu: catFunctions('Text') }),
        cmd('tag', 'Date & Time', null, { split: true, menu: catFunctions('Date & Time') }),
        cmd('search', 'Lookup & Reference', null, { split: true, menu: catFunctions('Lookup & Reference') }),
        cmd('sum', 'Math & Trig', null, { split: true, menu: catFunctions('Math & Trig') }),
        cmd('dots', 'More Functions', null, { split: true, menu: catFunctions('More') })
      ]},
      { label: 'Calculation', items: [
        cmd('calculate', 'Calculation Options', null, { split: true, menu: [
          { label: 'Automatic', checked: () => Calc.mode === 'auto', action: () => { Calc.mode = 'auto'; toast('Calculation: Automatic', 'info', 1400); } },
          { label: 'Manual', checked: () => Calc.mode === 'manual', action: () => { Calc.mode = 'manual'; toast('Calculation: Manual (F9 to recalc)', 'info', 1800); } }
        ] }),
        cmd('refresh', 'Calculate Now', () => recalcWorkbook(true), { small: true, title: 'Calculate now (F9)' })
      ]},
      { label: 'Engine Tools', items: [
        cmd('gauge', 'Diagnostics', () => openDiagnostics(), { small: true, title: 'Engine diagnostics & benchmarks' }),
        cmd('datamodel', 'Rebuild Deps', () => { rebuildAllDeps(); toast('Dependency graph rebuilt for ' + DepGraph.fDeps.size + ' formula(s)', 'success'); }, { small: true, title: 'Rebuild the dependency graph for all names and formulas' })
      ]},
      { label: 'Formula Auditing', items: [
        cmd('auditPrec', 'Trace Precedents', () => tracePrecedents(), { small: true, toggleFn: () => Audit.mode === 'prec' || Audit.mode === 'both', title: 'Trace Precedents — arrows from cells used by this formula' }),
        cmd('auditDep', 'Trace Dependents', () => traceDependents(), { small: true, toggleFn: () => Audit.mode === 'dep' || Audit.mode === 'both', title: 'Trace Dependents — arrows to formulas that use this cell' }),
        cmd('auditAll', 'Trace All', () => traceAll(), { small: true, toggleFn: () => Audit.mode === 'all', title: 'Trace All — multi-level dependency chain across the whole graph, with cross-sheet connectors' }),
        cmd('auditOff', 'Remove Arrows', () => removeAuditArrows(), { small: true, title: 'Remove all tracer arrows' })
      ]}
    ],
    Data: [
      { label: 'Sort & Filter', items: [
        cmd('sortAsc', 'Sort A→Z', () => quickSort(false), { small: true }),
        cmd('sortDesc', 'Sort Z→A', () => quickSort(true), { small: true }),
        cmd('sort', 'Custom Sort', () => openSortDialog(), { small: true }),
        cmd('filter', 'Filter', () => toggleFilter(), { toggleFn: () => !!activeSheet().filter, title: 'Toggle filter' }),
        cmd('refresh', 'Reapply', () => applyFilter(), { small: true, title: 'Reapply the current filter' })
      ]},
      { label: 'Data Tools', items: [
        cmd('split', 'Text to Columns', () => openTextToColumns(), { small: true }),
        cmd('validate', 'Data Validation', () => openValidationDialog(), { small: true }),
        cmd('dedupe', 'Remove Duplicates', () => openRemoveDuplicates(), { small: true })
      ]},
      { label: 'Editing', items: [
        cmd('sum', 'AutoSum', () => autoSum('SUM'), { split: true, menu: [
          { label: 'Sum', icon: 'sum', action: () => autoSum('SUM') },
          { label: 'Average', action: () => autoSum('AVERAGE') },
          { label: 'Count Numbers', action: () => autoSum('COUNT') },
          { label: 'Max', action: () => autoSum('MAX') },
          { label: 'Min', action: () => autoSum('MIN') }
        ] }),
        cmd('clear', 'Clear', null, { split: true, menu: [
          { label: 'Clear All', action: () => clearSelectionContents('all') },
          { label: 'Clear Formats', action: () => clearSelectionContents('formats') },
          { label: 'Clear Contents', shortcut: 'Del', action: () => clearSelectionContents('contents') }
        ] }),
        cmd('search', 'Find & Select', null, { split: true, menu: [
          { label: 'Find…', icon: 'search', shortcut: 'Ctrl+F', action: () => toggleFindPanel(true, 'find') },
          { label: 'Replace…', shortcut: 'Ctrl+H', action: () => toggleFindPanel(true, 'replace') },
          { label: 'Go To…', shortcut: 'Ctrl+G', action: () => openGoToDialog() },
          { sep: true },
          { label: 'Select All', shortcut: 'Ctrl+A', action: () => selectAll() }
        ] }),
        cmd('history', 'History', () => openHistoryDialog(), { small: true, title: 'Undo history — review, replay or revert edits' })
      ]}
    ],
    View: [
      { label: 'Show', items: [
        cmd('grid', 'Gridlines', () => toggleGridlines(), { toggleFn: () => activeSheet().showGridlines, small: true }),
        cmd('grid', 'Formula Bar', () => toggleFormulaBar(), { toggleFn: () => VIEW.showFormulaBar, small: true }),
        cmd('grid', 'Headings', () => toggleHeadings(), { toggleFn: () => VIEW.showHeadings, small: true }),
        cmd('fx', 'Show Formulas', () => { VIEW.showFormulas = !VIEW.showFormulas; requestPaint(); }, { toggleFn: () => VIEW.showFormulas, small: true, title: 'Show formulas instead of results (Ctrl+`)' })
      ]},
      { label: 'Freeze Panes', items: [
        cmd('freeze', 'Freeze Top Row', () => setFreeze(1, 0), { small: true }),
        cmd('freeze', 'Freeze 1st Column', () => setFreeze(0, 1), { small: true }),
        cmd('freeze', 'Freeze at Cell', () => setFreeze(SEL.active.r, SEL.active.c), { small: true }),
        cmd('freeze', 'Unfreeze', () => setFreeze(0, 0), { small: true })
      ]},
      { label: 'Zoom', items: [
        cmd('zoomIn', 'Zoom In', () => animateZoom(VIEW.zoom * 1.15), { small: true }),
        cmd('zoomOut', 'Zoom Out', () => animateZoom(VIEW.zoom / 1.15), { small: true }),
        cmd('zoomIn', '100%', () => animateZoom(1), { small: true }),
        cmd('zoomIn', 'Zoom to Selection', () => zoomToSelection(), { small: true })
      ]},
      { label: 'Help', items: [
        cmd('help', 'Quick Help', () => openHelpDialog('help'), { small: true }),
        cmd('keyboard', 'Shortcuts', () => openHelpDialog('shortcuts'), { small: true, title: 'Keyboard shortcuts' }),
        cmd('info', 'About', () => openHelpDialog('about'), { small: true, title: 'About EmeraldSheets' })
      ]}
    ]
  };
}
function catFunctions(cat) {
  let items = FUNC_META.filter(f => f.cat === cat);
  if (cat === 'More') items = FUNC_META.filter(f => !['Financial', 'Logical', 'Text', 'Date & Time', 'Lookup & Reference', 'Math & Trig'].includes(f.cat));
  if (!items.length) return [{ label: '(none)', disabled: true }];
  return items.map(f => ({ label: f.name, sub: '', action: () => insertFunctionByName(f.name) }));
}
function insertFunctionByName(name) {
  if (!RECENT_FUNCS.includes(name)) { RECENT_FUNCS.unshift(name); if (RECENT_FUNCS.length > 8) RECENT_FUNCS.pop(); }
  if (!Edit.active) beginEdit(SEL.active.r, SEL.active.c, { cursorMode: true });
  const ed = UI.editor;
  if (!ed.value.startsWith('=')) ed.value = '=' + name + '()';
  else ed.value = ed.value + name + '(';
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
  updateFormulaBarForEdit(ed.value);
}
function openChartDialogFor(type) {
  openChartDialog(null);
  /* preselect type after dialog opens */
  setTimeout(() => {
    const cell = document.querySelector('.chart-type-cell[data-t="' + type + '"]');
    if (cell) cell.click();
  }, 60);
}
function changeFontSize(delta) {
  const sh = activeSheet();
  const cell = sh.cells.get(key(SEL.active.r, SEL.active.c));
  const cur = cell && cell.s && cell.s.fontSize ? cell.s.fontSize : DEF.fontPt;
  applyStyleToSelection({ fontSize: clamp(cur + delta * 2, 6, 96) });
}
function adjustIndent(delta) {
  const sh = activeSheet();
  const cell = sh.cells.get(key(SEL.active.r, SEL.active.c));
  const cur = cell && cell.s && cell.s.indent ? cell.s.indent : 0;
  applyStyleToSelection({ indent: clamp(cur + delta, 0, 15) });
}
function changeDecimals(delta) {
  const sh = activeSheet();
  forEachSelectedCell((r, c) => {
    const cell = sh.cells.get(key(r, c));
    const s = cell && cell.s ? cell.s : {};
    const cat = s.numFmtCat || (s.numberFormat ? 'number' : 'number');
    const dec = s.decimals != null ? s.decimals : (s.numberFormat && /\.(0+)/.test(s.numberFormat) ? s.numberFormat.match(/\.?(0+)/)[1].length : 2);
    const nd = clamp(dec + delta, 0, 10);
    let code;
    if (cat === 'currency') code = NUMCAT.currency(nd);
    else if (cat === 'percent') code = NUMCAT.percent(nd);
    else if (cat === 'accounting') code = NUMCAT.accounting(nd);
    else code = NUMCAT.number(nd);
    const prev = cell;
    const prevSnap = prev ? snapOf(prev) : null;
    writeCell(sh, r, c, { s: normStyle(Object.assign({}, s, { numberFormat: code, numFmtCat: cat === 'number' ? 'number' : cat, decimals: nd })) });
    const nowC = sh.cells.get(key(r, c));
    pushHistory(histCellChange(sh, r, c, prevSnap, nowC ? snapOf(nowC) : null));
  });
  requestPaint();
}
function applyBorders(preset) {
  const sh = activeSheet();
  const rg = activeSelRange();
  const color = '#4a4a4a';
  const mk = st => ({ style: st, color });
  const side = {};
  if (preset === 'all') {
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sh.cells.get(key(r, c));
      const s = cell && cell.s ? Object.assign({}, cell.s) : {};
      const b = Object.assign({}, s.border);
      b.t = b.t || mk('thin'); b.b = b.b || mk('thin'); b.l = b.l || mk('thin'); b.r = b.r || mk('thin');
      applyStyleToSelectionAt(sh, r, c, s, { border: b });
    }
    requestPaint(); return;
  }
  if (preset === 'none') { applyStyleToSelection({ border: { t: null, r: null, b: null, l: null } }); return; }
  if (preset === 'top') side.t = mk('thin');
  if (preset === 'bottom') side.b = mk('thin');
  if (preset === 'dblbottom') side.b = mk('double');
  if (preset === 'left') side.l = mk('thin');
  if (preset === 'right') side.r = mk('thin');
  if (preset === 'out' || preset === 'thick') {
    const st = preset === 'thick' ? 'thick' : 'medium';
    side.t = mk(st); side.b = mk(st); side.l = mk(st); side.r = mk(st);
  }
  for (let r = rg.r1; r <= rg.r2; r++) {
    for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sh.cells.get(key(r, c));
      const s = cell && cell.s ? Object.assign({}, cell.s) : {};
      const b = Object.assign({}, s.border);
      if (side.t && r === rg.r1) b.t = side.t;
      if (side.b && r === rg.r2) b.b = side.b;
      if (side.l && c === rg.c1) b.l = side.l;
      if (side.r && c === rg.c2) b.r = side.r;
      const hasAny = b.t || b.b || b.l || b.r;
      applyStyleToSelectionAt(sh, r, c, s, { border: hasAny ? b : null });
    }
  }
  requestPaint();
}
function applyStyleToSelectionAt(sh, r, c, existingStyle, patch) {
  const merged = normStyle(Object.assign({}, existingStyle, patch));
  const prev = sh.cells.get(key(r, c));
  const prevSnap = prev ? snapOf(prev) : null;
  writeCell(sh, r, c, { s: merged });
  const nowC = sh.cells.get(key(r, c));
  pushHistory(histCellChange(sh, r, c, prevSnap, nowC ? snapOf(nowC) : null));
}
function autoSum(fnName) {
  const sh = activeSheet();
  const r = SEL.active.r, c = SEL.active.c;
  /* scan up for contiguous numbers */
  let r1 = r - 1;
  const isNumAt = (rr, cc) => {
    const cell = sh.cells.get(key(rr, cc));
    if (!cell) return false;
    if (cell.f) { const v = getComputedCell(sh.id, rr, cc); return typeof v === 'number'; }
    return typeof cell.v === 'number';
  };
  let end = r1;
  if (r1 >= 0 && isNumAt(r1, c)) {
    while (r1 - 1 >= 0 && isNumAt(r1 - 1, c)) r1--;
    const range = addr(r1, c) + ':' + addr(end, c);
    insertFormulaText('=' + fnName + '(' + range + ')');
    return;
  }
  /* scan left */
  let c1 = c - 1;
  if (c1 >= 0 && isNumAt(r, c1)) {
    const endC = c1;
    while (c1 - 1 >= 0 && isNumAt(r, c1 - 1)) c1--;
    insertFormulaText('=' + fnName + '(' + addr(r, c1) + ':' + addr(r, endC) + ')');
    return;
  }
  insertFormulaText('=' + fnName + '()');
}
function insertFormulaText(text) {
  beginEdit(SEL.active.r, SEL.active.c, { initial: text, cursorMode: false });
}

let activeRibbonTab = 'Home';
function buildRibbon() {
  const tabsBar = $('#ribbon-tabs');
  const body = $('#ribbon-body');
  tabsBar.innerHTML = '';
  body.innerHTML = '';
  closeMsMenus();
  tabsBar.appendChild(el('<span class="ribbon-tab-indicator" aria-hidden="true"></span>'));
  tabsBar.appendChild(el('<span class="rb-tabs-sep" aria-hidden="true"></span>'));
  const cfg = ribbonConfig();
  for (const tabName in cfg) {
    const btn = el('<button class="ribbon-tab' + (tabName === activeRibbonTab ? ' active' : '') + '" role="tab" data-tab="' + tabName.toLowerCase() + '" aria-selected="' + (tabName === activeRibbonTab) + '">' + tabName + '</button>');
    btn.addEventListener('click', () => {
      if (tabName === 'File') {
        if (activeRibbonTab !== 'File') {
          activeRibbonTab = 'File';
          tabsBar.querySelectorAll('.ribbon-tab').forEach(t => {
            const on = t === btn;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on);
          });
          positionRibbonIndicator();
          blurOutActivePanel();
        }
        openFileModal();
        return;
      }
      if (activeRibbonTab === tabName) return;
      activeRibbonTab = tabName;
      tabsBar.querySelectorAll('.ribbon-tab').forEach(t => {
        const on = t === btn;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on);
      });
      positionRibbonIndicator();
      swapRibbonBody();
    });
    tabsBar.appendChild(btn);
  }
  const act = el('<div class="ribbon-tabs-right"><button class="ribbon-tab-action" title="Export the active sheet as CSV" type="button">' + icon('csv') + '<span>Export</span></button></div>');
  act.querySelector('.ribbon-tab-action').addEventListener('click', () => exportCsv());
  tabsBar.appendChild(act);
  buildRibbonPanels();
  updateRibbonState();
  updateUndoRedoUI();
  positionRibbonIndicator();
}
function buildRibbonPanels() {
  const body = $('#ribbon-body');
  if (!body) return;
  body.innerHTML = '';
  const cfg = ribbonConfig();
  for (const tabName in cfg) {
    const panel = el('<div class="ribbon-panel" data-panel="' + tabName.toLowerCase() + '" aria-hidden="true"></div>');
    const groups = cfg[tabName] || [];
    for (const g of groups) {
      const gEl = el('<div class="ribbon-group"><div class="group-label">' + esc(g.label) + '</div><div class="ribbon-controls"></div></div>');
      const ctr = gEl.querySelector('.ribbon-controls');
      for (const item of g.items) {
        ctr.appendChild(buildRibbonItem(item));
      }
      panel.appendChild(gEl);
    }
    body.appendChild(panel);
  }
  const active = body.querySelector('.ribbon-panel[data-panel="' + activeRibbonTab.toLowerCase() + '"]');
  if (active) {
    active.classList.add('active');
    active.setAttribute('aria-hidden', 'false');
  }
  updateRibbonState();
  updateUndoRedoUI();
}
function swapRibbonBody() {
  const body = $('#ribbon-body');
  if (!body) return;
  const target = body.querySelector('.ribbon-panel[data-panel="' + activeRibbonTab.toLowerCase() + '"]');
  if (!target) return;
  const current = body.querySelector('.ribbon-panel.active');
  if (target === current) { updateRibbonState(); return; }
  const finishSwitch = () => {
    body.querySelectorAll('.ribbon-panel').forEach(p => {
      p.classList.remove('active', 'blur-out');
      p.setAttribute('aria-hidden', 'true');
    });
    target.classList.add('active');
    target.setAttribute('aria-hidden', 'false');
    updateRibbonState();
  };
  if (SmoothScroll.reduced || !current) { finishSwitch(); return; }
  current.classList.add('blur-out');
  current.classList.remove('active');
  const onBlurred = (e) => {
    if (e.propertyName !== 'opacity') return;
    current.removeEventListener('transitionend', onBlurred);
    current.classList.remove('blur-out');
    finishSwitch();
  };
  current.addEventListener('transitionend', onBlurred);
  setTimeout(() => {
    if (current.classList.contains('blur-out')) {
      current.removeEventListener('transitionend', onBlurred);
      current.classList.remove('blur-out');
      finishSwitch();
    }
  }, 220);
}
function blurOutActivePanel() {
  const activePanel = $('#ribbon-body .ribbon-panel.active');
  if (!activePanel) return;
  activePanel.classList.add('blur-out');
  activePanel.classList.remove('active');
  activePanel.setAttribute('aria-hidden', 'true');
  const finish = (e) => {
    if (e && e.propertyName !== 'opacity') return;
    activePanel.removeEventListener('transitionend', finish);
    activePanel.classList.remove('blur-out');
  };
  activePanel.addEventListener('transitionend', finish);
  setTimeout(() => {
    if (activePanel.classList.contains('blur-out')) {
      activePanel.removeEventListener('transitionend', finish);
      activePanel.classList.remove('blur-out');
    }
  }, 220);
}
function positionRibbonIndicator() {
  const ind = $('#ribbon-tabs .ribbon-tab-indicator');
  const active = $('#ribbon-tabs .ribbon-tab.active');
  if (!ind || !active) return;
  const left = active.offsetLeft;
  const width = active.offsetWidth;
  ind.style.width = width + 'px';
  ind.style.transform = 'translateX(' + left + 'px)';
  ind.classList.add('visible');
}
function buildRibbonItem(item) {
  if (item.custom) return buildCustomRibbonControl(item);
  const big = !item.small;
  const btn = el('<button class="ribbon-btn' + (big ? '' : ' ribbon-btn-icon') + (item.split ? ' split' : '') + '" title="' + esc(item.title || item.label) + '" aria-label="' + esc(item.title || item.label) + '">' + icon(item.icon) + (big ? '<span>' + esc(item.label) + '</span>' : '') + '</button>');
  if (item.action) {
    btn.addEventListener('click', e => {
      if (item.menu && e.offsetX > btn.clientWidth - 12 && item.split) { openRibbonMenu(item.menu, btn); return; }
      item.action();
      updateRibbonState();
    });
  }
  if (item.dblclick) btn.addEventListener('dblclick', item.dblclick);
  if (item.menu) {
    btn.addEventListener('mousedown', e => {
      if (e.button === 0 && (e.offsetY > btn.clientHeight * 0.6 || !item.action)) {
        e.preventDefault();
        openRibbonMenu(item.menu, btn);
      }
    });
  }
  if (item.toggleKey || item.toggleFn) btn.dataset.toggle = item.toggleKey || '';
  if (item.id) btn.id = item.id;
  btn._item = item;
  return btn;
}
let _msMenu = null, _msMenuBtn = null;
function closeMsMenus() {
  if (_msMenu) { const p = _msMenu.parentNode; if (p) p.removeChild(_msMenu); _msMenu = null; }
  if (_msMenuBtn) { _msMenuBtn.setAttribute('aria-expanded', 'false'); _msMenuBtn = null; }
}
function portalMsMenu(menu, btn) {
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const presetMax = parseInt(menu.style.maxHeight) || 0;
  if (!presetMax) {
    const isColorList = menu.classList.contains('color-list-menu');
    const cap = isColorList ? 240 : 320;
    menu.style.maxHeight = Math.min(cap, window.innerHeight * 0.6) + 'px';
  }
  menu.style.cssText = 'position:fixed;visibility:hidden;display:block;z-index:999999;margin:0;max-height:' + (presetMax ? presetMax + 'px' : menu.style.maxHeight) + ';overflow-y:auto;';
  const mW = menu.offsetWidth || 180;
  const mH = menu.offsetHeight || 200;
  const vW = window.innerWidth, vH = window.innerHeight;
  let top = r.bottom + 4;
  if (top + mH > vH - 8) top = r.top - mH - 4;
  if (top < 8) top = r.bottom + 4;
  let left = r.left;
  if (left + mW > vW - 8) left = vW - mW - 8;
  if (left < 8) left = 8;
  menu.style.cssText = 'position:fixed;display:block;visibility:visible;z-index:999999;margin:0;left:' + left + 'px;top:' + top + 'px;max-height:' + (presetMax ? presetMax + 'px' : menu.style.maxHeight) + ';overflow-y:auto;animation:dropdownFadeIn .18s ease;';
  menu.classList.add('open');
  _msMenu = menu; _msMenuBtn = btn;
  btn.setAttribute('aria-expanded', 'true');
  return menu;
}
function openMsMenu(menuItems, btn) {
  closeMsMenus();
  if (typeof menuItems === 'function') menuItems = menuItems();
  const menu = el('<div class="ms-dropdown-menu"></div>');
  for (const it of menuItems) {
    if (!it) continue;
    if (it.sep) { menu.appendChild(el('<div class="ms-dropdown-sep"></div>')); continue; }
    if (it.section) { menu.appendChild(el('<div class="ms-dropdown-section-label">' + esc(it.section) + '</div>')); continue; }
    if (it.custom === 'styleChip') {
      const chip = el('<button class="style-chip" style="background:' + (it.preset.style.backgroundColor || '#fff') + ';color:' + (it.preset.style.color || '#3b3a39') + ';font-weight:' + (it.preset.style.bold ? '700' : '400') + ';font-style:' + (it.preset.style.italic ? 'italic' : 'normal') + '">' + esc(it.preset.name) + '</button>');
      chip.addEventListener('click', () => { applyCellStylePreset(it.preset); closeMsMenus(); });
      menu.appendChild(chip);
      continue;
    }
    const chk = typeof it.checked === 'function' ? it.checked() : it.checked;
    const row = el('<div class="ms-dropdown-item' + (it.disabled ? ' disabled' : '') + (chk ? ' checked' : '') + '" role="menuitem">' +
      (it.color ? '<span class="color-preview" style="background:' + it.color + (it.color === 'transparent' ? ';border:1px solid #ccc' : '') + '"></span>' : '') +
      (it.icon ? '<span class="mi-icon">' + icon(it.icon) + '</span>' : '') +
      '<span class="ms-dd-label' + (chk ? ' checked' : '') + '">' + esc(it.label) + '</span>' +
      (chk ? '<span class="mi-check">' + icon('check') + '</span>' : '') +
      (it.shortcut ? '<span class="mi-shortcut">' + esc(it.shortcut) + '</span>' : '') +
      '</div>');
    if (!it.disabled) row.addEventListener('click', () => { closeMsMenus(); if (it.action) it.action(); });
    menu.appendChild(row);
  }
  return portalMsMenu(menu, btn);
}
document.addEventListener('scroll', () => closeMsMenus(), true);
window.addEventListener('resize', () => closeMsMenus());
document.addEventListener('mousedown', e => {
  if (_msMenu && _msMenuBtn && !_msMenu.contains(e.target) && e.target !== _msMenuBtn) closeMsMenus();
});
function openRibbonMenu(menu, anchor) {
  openMsMenu(menu, anchor);
}
function msDropdownCtrl(opts) {
  const dd = el('<div class="ms-dropdown" data-rbsync="1"></div>');
  const btn = el('<button type="button" class="ms-dropdown-btn" aria-haspopup="listbox" aria-expanded="false" title="' + esc(opts.title || '') + '" style="' + (opts.minWidth ? 'min-width:' + opts.minWidth + 'px;' : '') + '">' + opts.render(opts.value()) + '</button>');
  const menu = el('<div class="ms-dropdown-menu' + (opts.menuClass ? ' ' + opts.menuClass : '') + '"' + (opts.maxHeight ? ' style="max-height:' + opts.maxHeight + 'px"' : '') + '></div>');
  for (const it of opts.items) {
    if (it.head) {
      menu.appendChild(el('<div class="ms-dropdown-item" style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:.06em;cursor:default;pointer-events:none;padding:4px 8px 2px 12px;">' + esc(it.head) + '</div>'));
      continue;
    }
    const row = el('<div class="ms-dropdown-item" data-value="' + esc(it.value) + '"' + (it.dataLabel ? ' data-label="' + esc(it.dataLabel) + '"' : '') + (it.style ? ' style="' + it.style + '"' : '') + '>' + (it.html || esc(it.label)) + '</div>');
    row.addEventListener('click', () => { opts.pick(it.value); closeMsMenus(); });
    menu.appendChild(row);
  }
  btn.addEventListener('click', () => {
    if (_msMenuBtn === btn) { closeMsMenus(); return; }
    portalMsMenu(dd._ddMenu, btn);
  });
  dd.appendChild(btn);
  dd.appendChild(menu);
  dd._sync = () => { btn.innerHTML = opts.render(opts.value()); };
  dd._ddMenu = menu;
  return dd;
}
const FONT_COLORS = [
  { value: '#000000', label: 'Black', hex: '#000000' },
  { value: '#333333', label: 'Dark Gray', hex: '#333333' },
  { value: '#888888', label: 'Gray', hex: '#888888' },
  { value: '#FF0000', label: 'Red', hex: '#FF0000' },
  { value: '#FF6600', label: 'Orange', hex: '#FF6600' },
  { value: '#FFD700', label: 'Gold', hex: '#FFD700' },
  { value: '#008000', label: 'Green', hex: '#008000' },
  { value: '#2ecc71', label: 'Lime', hex: '#BFFF00' },
  { value: '#0000FF', label: 'Blue', hex: '#0000FF' },
  { value: '#1E90FF', label: 'Cyan', hex: '#00FFFF' },
  { value: '#800080', label: 'Purple', hex: '#800080' },
  { value: '#FF1493', label: 'Pink', hex: '#FF1493' },
  { value: '#8B4513', label: 'Brown', hex: '#8B4513' }
];
const FILL_COLORS = [
  { value: '#FFFF00', label: 'Yellow', hex: '#FFFF00' },
  { value: '#FFD700', label: 'Gold', hex: '#FFD700' },
  { value: '#90EE90', label: 'Light Green', hex: '#90EE90' },
  { value: '#98FB98', label: 'Pale Green', hex: '#98FB98' },
  { value: '#FFB6C1', label: 'Light Pink', hex: '#FFB6C1' },
  { value: '#FF8C69', label: 'Salmon', hex: '#FF8C69' },
  { value: '#ADD8E6', label: 'Light Blue', hex: '#ADD8E6' },
  { value: '#87CEFA', label: 'Sky Blue', hex: '#87CEFA' },
  { value: '#DDA0DD', label: 'Plum', hex: '#DDA0DD' },
  { value: '#FFDAB9', label: 'Peach', hex: '#FFDAB9' },
  { value: 'transparent', label: 'Clear', hex: 'transparent' }
];
function buildCustomRibbonControl(item) {
  switch (item.custom) {
    case 'fontFamily': {
      return msDropdownCtrl({
        minWidth: 110,
        title: 'Font',
        maxHeight: 280,
        value: () => { const sh = activeSheet(); const cell = sh.cells.get(key(SEL.active.r, SEL.active.c)); return (cell && cell.s && cell.s.fontFamily) || DEF.fontFamily; },
        render: v => '<span class="dropdown-value">' + esc(v) + '</span>',
        items: RIBBON_FONTS.map(f => f.head ? { head: f.head } : { value: f.value, dataLabel: f.dataLabel, html: f.html, style: f.style }),
        pick: v => applyStyleToSelection({ fontFamily: v })
      });
    }
    case 'fontSize': {
      return msDropdownCtrl({
        minWidth: 60,
        title: 'Font size',
        value: () => { const sh = activeSheet(); const cell = sh.cells.get(key(SEL.active.r, SEL.active.c)); return (cell && cell.s && cell.s.fontSize ? cell.s.fontSize : DEF.fontPt) + ''; },
        render: v => '<span class="dropdown-value">' + esc(v) + '</span>',
        items: [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map(s => ({ value: s + '', dataLabel: s + '', label: s + '' })),
        pick: v => applyStyleToSelection({ fontSize: +v })
      });
    }
    case 'numFmt': {
      const opts = [['General', 'General'], ['number', 'Number'], ['currency', 'Currency'], ['accounting', 'Accounting'], ['shortDate', 'Short Date'], ['longDate', 'Long Date'], ['time', 'Time'], ['percent', 'Percentage'], ['fraction', 'Fraction'], ['scientific', 'Scientific'], ['text', 'Text']];
      return msDropdownCtrl({
        minWidth: 100,
        title: 'Number format',
        value: () => {
          const sh = activeSheet();
          const cell = sh.cells.get(key(SEL.active.r, SEL.active.c));
          const cat = cell && cell.s && cell.s.numFmtCat ? cell.s.numFmtCat : 'General';
          return ['number', 'currency', 'accounting', 'shortDate', 'longDate', 'time', 'percent', 'fraction', 'scientific', 'text'].includes(cat) ? cat : 'General';
        },
        render: v => {
          const o = opts.find(x => x[0] === v);
          return '<span class="dropdown-value">' + esc(o ? o[1] : 'General') + '</span>';
        },
        items: opts.map(o => ({ value: o[0], label: o[1] })),
        pick: v => {
          const dec = 2;
          let code = 'General', cat = null;
          if (v === 'number') { code = NUMCAT.number(dec); cat = 'number'; }
          else if (v === 'currency') { code = NUMCAT.currency(dec); cat = 'currency'; }
          else if (v === 'accounting') { code = NUMCAT.accounting(dec); cat = 'accounting'; }
          else if (v === 'shortDate') { code = NUMCAT.shortDate; cat = 'shortDate'; }
          else if (v === 'longDate') { code = NUMCAT.longDate; cat = 'longDate'; }
          else if (v === 'time') { code = NUMCAT.time; cat = 'time'; }
          else if (v === 'percent') { code = NUMCAT.percent(2); cat = 'percent'; }
          else if (v === 'fraction') { code = NUMCAT.fraction; cat = 'fraction'; }
          else if (v === 'scientific') { code = NUMCAT.scientific; cat = 'scientific'; }
          else if (v === 'text') { code = '@'; cat = 'text'; }
          applyStyleToSelection(code === 'General' ? { numberFormat: null, numFmtCat: null } : { numberFormat: code, numFmtCat: cat });
        }
      });
    }
    case 'fontColor': {
      const ctrl = msDropdownCtrl({
        minWidth: 80,
        title: 'Text color',
        menuClass: 'color-list-menu',
        value: () => {
          const sh = activeSheet();
          const cell = sh.cells.get(key(SEL.active.r, SEL.active.c));
          return (cell && cell.s && cell.s.color) || '#000000';
        },
        render: v => '<span class="color-preview" style="background:' + (v === 'none' ? 'transparent' : v) + '"></span><span class="dropdown-value">Text</span>',
        items: FONT_COLORS.map(c => ({ value: c.value, html: '<span class="color-preview" style="background:' + c.hex + '"></span>' + c.label })),
        pick: v => applyStyleToSelection({ color: v === 'none' ? null : v })
      });
      return ctrl;
    }
    case 'fillColor': {
      return msDropdownCtrl({
        minWidth: 90,
        title: 'Highlight color',
        menuClass: 'color-list-menu',
        value: () => {
          const sh = activeSheet();
          const cell = sh.cells.get(key(SEL.active.r, SEL.active.c));
          return (cell && cell.s && cell.s.backgroundColor) || 'transparent';
        },
        render: v => '<span class="color-preview" style="background:' + (v === 'transparent' ? 'transparent;border:1px solid #ccc' : v) + '"></span><span class="dropdown-value">Highlight</span>',
        items: FILL_COLORS.map(c => ({ value: c.value, html: '<span class="color-preview" style="background:' + (c.value === 'transparent' ? 'transparent;border:1px solid #ccc;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#888">&#10005;' : c.hex) + '"></span>' + c.label })),
        pick: v => applyStyleToSelection({ backgroundColor: v === 'transparent' ? null : v })
      });
    }
    case 'fontChips': {
      const wrap = el('<div class="font-controls"></div>');
      for (const sub of item.items) { if (!sub.custom) sub.small = true; wrap.appendChild(buildRibbonItem(sub)); }
      return wrap;
    }
    case 'stack': {
      const wrap = el('<div class="rb-stack"></div>');
      for (const sub of item.items) { if (!sub.custom) sub.small = true; wrap.appendChild(buildRibbonItem(sub)); }
      return wrap;
    }
    case 'colors': return document.createElement('div');
    case 'styleChip': {
      const chip = el('<button class="style-chip">' + esc(item.preset.name) + '</button>');
      const st = item.preset.style;
      chip.style.background = st.backgroundColor || '#fff';
      chip.style.color = st.color || '#3b3a39';
      chip.style.fontWeight = st.bold ? '700' : '400';
      chip.style.fontStyle = st.italic ? 'italic' : 'normal';
      chip.addEventListener('click', () => { applyCellStylePreset(item.preset); closePopups(); });
      return chip;
    }
  }
  return document.createElement('div');
}
function wrapControl(sel) {
  const wrap = el('<div style="display:flex;flex-direction:column;justify-content:center;height:62px"></div>');
  wrap.appendChild(sel);
  return wrap;
}
function showColorPalette(x, y, onPick, allowNone) {
  const pop = el('<div class="popup" style="min-width:0"></div>');
  const grid = el('<div class="popup-colors"></div>');
  const colors = ['#000000', '#404040', '#7f7f7f', '#bfbfbf', '#ffffff', '#843c0c', '#c55a11', '#ed7d31', '#f4b183', '#fbe5d5',
    '#5b3b29', '#a0522d', '#d2691e', '#e8a33d', '#ffe4c4', '#264438', '#217346', '#4ea072', '#a9d5bb', '#e2efda',
    '#1e3a2f', '#2e5e4e', '#388573', '#9dc3ae', '#d7e8de', '#1f3864', '#2f5597', '#4472c4', '#8faadc', '#d9e2f3',
    '#5c2d5c', '#8b5e83', '#b57edc', '#d9b3e6', '#f0e1f7', '#7f1d1d', '#c0392b', '#e74c3c', '#f1948a', '#fadbd8'];
  if (allowNone) {
    const none = el('<button class="sw none" title="No color"></button>');
    none.addEventListener('click', () => { onPick('none'); closePopups(); });
    grid.appendChild(none);
  }
  for (const c of colors) {
    const sw = el('<button class="sw" style="background:' + c + '" title="' + c + '" aria-label="' + c + '"></button>');
    sw.addEventListener('click', () => { onPick(c); closePopups(); });
    grid.appendChild(sw);
  }
  pop.appendChild(grid);
  const more = el('<div class="popup-foot"><input type="color" value="#217346" aria-label="Custom color" style="width:34px;height:24px;border:1px solid #d4d4d4;border-radius:3px;padding:1px"><span style="font-size:11px;color:#605e5c">More colors…</span></div>');
  more.querySelector('input').addEventListener('change', e => { onPick(e.target.value); closePopups(); });
  pop.appendChild(more);
  showPopup(pop, null, { x, y });
}
function updateRibbonState() {
  const body = $('#ribbon-body');
  if (!body) return;
  const sh = activeSheet();
  body.querySelectorAll('.ribbon-btn[data-toggle]').forEach(btn => {
    const item = btn._item;
    if (!item) return;
    let on = false;
    if (item.toggleFn) on = !!item.toggleFn();
    else if (item.toggleKey) {
      const cell = sh.cells.get(key(SEL.active.r, SEL.active.c));
      on = !!(cell && cell.s && cell.s[item.toggleKey]);
      if (item.toggleKey === 'bold' && SEL.ranges.length) {
        let anyOn = false;
        forEachSelectedCell((r, c) => { const cl = sh.cells.get(key(r, c)); if (cl && cl.s && cl.s.bold) anyOn = true; });
        on = anyOn;
      }
    }
    btn.classList.toggle('active', on);
  });
  body.querySelectorAll('[data-rbsync]').forEach(c => { if (c._sync) try { c._sync(); } catch (e) {} });
  body.querySelectorAll('select[_sync]').forEach(s => { if (s._sync) try { s._sync(); } catch (e) {} });
  const filterBtn = body.querySelector('[title="Toggle filter"]');
  if (filterBtn) filterBtn.classList.toggle('active', !!sh.filter);
}

/* ---------------- view toggles / zoom ---------------- */
function toggleGridlines() {
  const sh = activeSheet();
  sh.showGridlines = !sh.showGridlines;
  requestPaint();
  Persistence.markDirty();
}
function toggleFormulaBar() {
  VIEW.showFormulaBar = !VIEW.showFormulaBar;
  $('#formula-row').style.display = VIEW.showFormulaBar ? '' : 'none';
  resizeCanvas();
  Persistence.markDirty();
}
function toggleHeadings() {
  VIEW.showHeadings = !VIEW.showHeadings;
  requestPaint();
  renderFilterChips();
  Persistence.markDirty();
}
function setZoom(z) {
  VIEW.zoom = clamp(z, 0.1, 4);
  $('#sb-zoom-pct').textContent = Math.round(VIEW.zoom * 100) + '%';
  hideEditor();
  cancelSmoothScroll();
  requestPaint();
  renderChartsLayer();
  renderFilterChips();
  Persistence.markDirty();
}
/* ease the zoom to a target (buttons, menus, reset, zoom-to-selection) */
const ZoomAnim = { raf: 0, from: 0, to: 0, t0: 0, dur: 220 };
function animateZoom(target) {
  const to = clamp(target, 0.1, 4);
  if (SmoothScroll.reduced) { setZoom(to); return; }
  if (ZoomAnim.raf) cancelAnimationFrame(ZoomAnim.raf);
  ZoomAnim.raf = 0;
  ZoomAnim.from = VIEW.zoom; ZoomAnim.to = to; ZoomAnim.t0 = performance.now();
  const step = () => {
    ZoomAnim.raf = 0;
    const p = Math.min(1, (performance.now() - ZoomAnim.t0) / ZoomAnim.dur);
    const e = 1 - Math.pow(1 - p, 3);
    setZoom(ZoomAnim.from + (ZoomAnim.to - ZoomAnim.from) * e);
    if (p < 1) ZoomAnim.raf = requestAnimationFrame(step);
    else pulseZoomPct();
  };
  step();
}
function pulseZoomPct() {
  const zp = $('#sb-zoom-pct');
  if (!zp || SmoothScroll.reduced || zp.classList.contains('pulse')) return;
  zp.classList.add('pulse');
  setTimeout(() => zp.classList.remove('pulse'), 500);
}
function zoomToSelection() {
  const sh = activeSheet();
  const rg = activeSelRange();
  const w = (sh.cols.offsetOf(rg.c2 + 1) - sh.cols.offsetOf(rg.c1)) ;
  const h = (sh.rows.offsetOf(rg.r2 + 1) - sh.rows.offsetOf(rg.r1));
  const L = R.layout;
  const target = Math.min((L.gridW - 40) / Math.max(1, w), (L.gridH - 40) / Math.max(1, h));
  animateZoom(clamp(target, 0.1, 4));
  ensureVisible(rg.r1, rg.c1, { smooth: true });
}
function hideEditor() {
  if (Edit.active) cancelEdit();
}
function updateUndoRedoUI() {
  const u = $('#hdr-undo'), r = $('#hdr-redo');
  if (u) u.disabled = !H.undo.length;
  if (r) r.disabled = !H.redo.length;
  const ru = $('#rbn-undo'), rr = $('#rbn-redo');
  if (ru) ru.disabled = !H.undo.length;
  if (rr) rr.disabled = !H.redo.length;
}

/* ---------------- sheet tabs ---------------- */
/* sheet ids that already played their tab entrance animation */
const TabSeen = { ids: new Set() };
function updateSheetTabBar() {
  const bar = $('#sheet-tabs');
  bar.innerHTML = '';
  for (const sh of WB.sheets) {
    if (sh.hidden) continue;
    const tab = el('<button class="sheet-tab' + (sh.id === WB.activeSheetId ? ' active' : '') + (sh.tabColor ? ' has-color' : '') + '" role="tab" aria-selected="' + (sh.id === WB.activeSheetId) + '" tabindex="0" title="' + esc(sh.name) + '">' +
      (sh.tabColor ? '<span class="tab-dot" style="background:' + sh.tabColor + '"></span>' : '') +
      '<span class="tab-label">' + esc(sh.name) + '</span></button>');
    if (!TabSeen.ids.has(sh.id)) { tab.classList.add('tab-enter'); TabSeen.ids.add(sh.id); }
    tab.addEventListener('click', () => setActiveSheet(sh.id));
    tab.addEventListener('dblclick', () => beginTabRename(sh, tab));
    /* keyboard parity for the double-click rename: F2 or Enter on a focused tab */
    tab.addEventListener('keydown', e => {
      if (e.key === 'F2' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault(); e.stopPropagation();
        beginTabRename(sh, tab);
      }
    });
    tab.addEventListener('contextmenu', e => {
      e.preventDefault();
      showPopupMenu([
        { label: 'Insert Sheet', icon: 'plusSheet', action: () => addSheet(sh.id) },
        { label: 'Delete Sheet', icon: 'trash', danger: true, action: () => deleteSheetById(sh.id) },
        { label: 'Rename', icon: 'pencil', action: () => beginTabRename(sh, tab) },
        { label: 'Duplicate', icon: 'dup', action: () => duplicateSheetById(sh.id) },
        { sep: true },
        { label: 'Move Left', icon: 'arrowLeft', action: () => moveSheetDelta(sh.id, -1) },
        { label: 'Move Right', icon: 'arrowRight', action: () => moveSheetDelta(sh.id, 1) },
        { sep: true },
        { label: 'Tab Color…', icon: 'tag', action: () => { const r = tab.getBoundingClientRect(); showColorPalette(r.left, r.bottom + 2, c => { sh.tabColor = c === 'none' ? null : c; updateSheetTabBar(); Persistence.markDirty(); }, true); } },
        { label: 'Hide Sheet', icon: 'eyeOff', action: () => {
          if (WB.sheets.filter(s => !s.hidden).length <= 1) { toast('Cannot hide the only visible sheet', 'warn'); return; }
          sh.hidden = true;
          if (WB.activeSheetId === sh.id) setActiveSheet(WB.sheets.find(s => !s.hidden).id);
          updateSheetTabBar();
          Persistence.markDirty();
        } },
        { label: 'Unhide Sheets…', icon: 'eye', action: () => {
          const hiddenSheets = WB.sheets.filter(s => s.hidden);
          if (!hiddenSheets.length) { toast('No hidden sheets', 'info'); return; }
          showPopupMenu(hiddenSheets.map(s => ({ label: s.name, action: () => { s.hidden = false; updateSheetTabBar(); Persistence.markDirty(); } })), tab.getBoundingClientRect().left, tab.getBoundingClientRect().bottom + 2);
        } }
      ], e.clientX, e.clientY);
    });
    bar.appendChild(tab);
  }
}
function beginTabRename(sh, tab) {
  const input = el('<input type="text" value="' + esc(sh.name) + '" aria-label="Sheet name">');
  tab.innerHTML = '';
  tab.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    if (save) {
      if (!renameSheetById(sh.id, input.value.trim())) { updateSheetTabBar(); return; }
    }
    updateSheetTabBar();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------------- find & replace panel ---------------- */
const Find = { text: '', replace: '', matchCase: false, inNotes: false, pos: -1, matches: [], hlCell: null };
function toggleFindPanel(show, tab) {
  const panel = $('#find-panel');
  if (!show) { panel.hidden = true; Find.hlCell = null; hideNotePopover(); return; }
  panel.hidden = false;
  buildFindPanel(tab === 'replace');
  panel.querySelector('input').focus();
  panel.querySelector('input').select();
}
function buildFindPanel(withReplace) {
  const panel = $('#find-panel');
  panel.innerHTML = '';
  const head = el('<div class="fr-row"><b style="flex:1">' + (withReplace ? 'Replace' : 'Find') + '</b><button class="iconbtn" data-x title="Close" aria-label="Close find panel">' + icon('x') + '</button></div>');
  const row1 = el('<div class="fr-row"><input type="text" id="fp-find" placeholder="Find what" aria-label="Find what"><button class="btn small" id="fp-prev" title="Find previous">▲</button><button class="btn small" id="fp-next" title="Find next">▼</button></div>');
  panel.appendChild(head);
  panel.appendChild(row1);
  if (withReplace) {
    const row2 = el('<div class="fr-row"><input type="text" id="fp-replace" placeholder="Replace with" aria-label="Replace with"><button class="btn small" id="fp-r1">Replace</button><button class="btn small" id="fp-ra">All</button></div>');
    panel.appendChild(row2);
  }
  const list = el('<div id="fp-list" class="fp-list" role="listbox" aria-label="Match list"></div>');
  panel.appendChild(list);
  const opts = el('<div class="fr-opts"><label><input type="checkbox" id="fp-case"> Match case</label><label><input type="checkbox" id="fp-notes"> Search notes</label><span id="fp-count" class="fr-count"></span></div>');
  panel.appendChild(opts);
  head.querySelector('[data-x]').addEventListener('click', () => toggleFindPanel(false));
  panel.querySelector('#fp-find').value = Find.text;
  panel.querySelector('#fp-case').checked = Find.matchCase;
  panel.querySelector('#fp-notes').checked = Find.inNotes;
  if (withReplace) panel.querySelector('#fp-replace').value = Find.replace;
  panel.querySelector('#fp-find').addEventListener('input', e => { Find.text = e.target.value; Find.matches = []; Find.pos = -1; updateFindCount(); });
  panel.querySelector('#fp-find').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); findNext(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); findNext(-1); }
  });
  panel.querySelector('#fp-case').addEventListener('change', e => { Find.matchCase = e.target.checked; Find.matches = []; Find.pos = -1; updateFindCount(); });
  panel.querySelector('#fp-notes').addEventListener('change', e => { Find.inNotes = e.target.checked; Find.matches = []; Find.pos = -1; updateFindCount(); });
  panel.querySelector('#fp-next').addEventListener('click', () => findNext(1));
  panel.querySelector('#fp-prev').addEventListener('click', () => findNext(-1));
  if (withReplace) {
    panel.querySelector('#fp-replace').addEventListener('input', e => { Find.replace = e.target.value; });
    panel.querySelector('#fp-r1').addEventListener('click', replaceOne);
    panel.querySelector('#fp-ra').addEventListener('click', replaceAll);
  }
  updateFindCount();
}
function collectMatches() {
  const sh = activeSheet();
  const q = Find.matchCase ? Find.text : Find.text.toLowerCase();
  if (!q) return [];
  const ur = usedRange(sh);
  const out = [];
  for (let r = 0; r <= ur.r2; r++) {
    for (let c = 0; c <= ur.c2; c++) {
      const cell = sh.cells.get(key(r, c));
      if (!cell) continue;
      let text;
      if (cell.f) text = cell.f;
      else if (cell.v != null) text = typeof cell.v === 'number' ? generalNum(cell.v) : String(cell.v);
      else continue;
      const hay = Find.matchCase ? text : text.toLowerCase();
      if (hay.includes(q)) out.push({ r, c });
    }
  }
  /* notes + replies (optional; matches open the thread popover on navigate) */
  if (Find.inNotes && sh.notes && sh.notes.size) {
    for (const [k, n] of sh.notes) {
      if (!n) continue;
      const parts = [String(n.text || '')].concat(noteReplies(n).map(rp => String(rp.t || '')));
      const hay = Find.matchCase ? parts.join('\n') : parts.join('\n').toLowerCase();
      if (!hay.includes(q)) continue;
      const seg = k.split(',');
      out.push({ r: +seg[0], c: +seg[1], note: true });
    }
  }
  return out;
}
function updateFindCount() {
  const elc = $('#fp-count');
  if (!elc) return;
  Find.matches = collectMatches();
  elc.textContent = Find.text ? Find.matches.length + ' match(es) on this sheet' : '';
  renderMatchList();
}
/* clickable list of all matches (cells + notes) under the find input */
function renderMatchList() {
  const box = $('#fp-list');
  if (!box) return;
  const CAP = 300;
  const sh = activeSheet();
  if (!Find.text) { box.innerHTML = '<div class="fp-list-empty">Type to search this sheet · Enter = next match</div>'; return; }
  const ms = Find.matches;
  if (!ms.length) { box.innerHTML = '<div class="fp-list-empty">No matches found</div>'; return; }
  let html = '';
  ms.slice(0, CAP).forEach((m, i) => {
    const cell = sh.cells.get(key(m.r, m.c));
    let text = '';
    let kind = '';
    if (m.note) {
      const n = noteAt(sh, m.r, m.c);
      text = [String((n && n.text) || '')].concat(n ? noteReplies(n).map(rp => String(rp.t || '')) : []).join(' · ');
      kind = 'note';
    } else if (cell) {
      text = cell.f ? cell.f : (typeof cell.v === 'number' ? generalNum(cell.v) : String(cell.v == null ? '' : cell.v));
      kind = cell.f ? 'fx' : 'cell';
    }
    html += '<div class="fp-item' + (m.note ? ' fp-note' : '') + '" role="option" data-i="' + i + '" tabindex="0" title="' + esc(addr(m.r, m.c)) + '">' +
      icon(m.note ? 'comment' : 'table') +
      '<span class="fp-addr">' + addr(m.r, m.c) + '</span>' +
      '<span class="fp-snip">' + highlightFindText(String(text), Find.text) + '</span>' +
      (kind === 'fx' ? '<span class="fp-kind" title="Formula match">fx</span>' : '') +
      (kind === 'note' ? '<span class="fp-kind fp-kind-note" title="Note match">N</span>' : '') +
      '</div>';
  });
  if (ms.length > CAP) html += '<div class="fp-list-empty">…' + (ms.length - CAP) + ' more — use ▲/▼ to cycle all</div>';
  box.innerHTML = html;
  box.querySelectorAll('.fp-item').forEach(item => {
    const go = () => jumpToMatch(+item.dataset.i);
    item.addEventListener('click', go);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  markActiveMatch();
}
function markActiveMatch() {
  const box = $('#fp-list');
  if (!box) return;
  box.querySelectorAll('.fp-item.active').forEach(x => x.classList.remove('active'));
  const cur = SEL.active;
  const item = Array.from(box.querySelectorAll('.fp-item')).find(it => {
    const m = Find.matches[+it.dataset.i];
    return m && m.r === cur.r && m.c === cur.c;
  });
  if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }); }
}
function jumpToMatch(i) {
  const m = Find.matches[i];
  if (!m) return;
  setSelection(m.r, m.c, m.r, m.c);
  Find.hlCell = m.note ? key(m.r, m.c) : null;
  if (m.note) {
    const sh2 = activeSheet();
    if (noteAt(sh2, m.r, m.c)) showNoteThreadPopover(sh2, m.r, m.c, cellScreenRect(sh2, m.r, m.c), false);
  } else hideNotePopover();
  markActiveMatch();
  requestPaint(); updateFormulaBar();
}
function findNext(dir) {
  if (!Find.text) return;
  if (!Find.matches.length) Find.matches = collectMatches();
  if (!Find.matches.length) { toast('No matches found for "' + Find.text + '"', 'warn'); return; }
  /* order matches row-major; find next after current position */
  const cur = { r: SEL.active.r, c: SEL.active.c };
  let idx;
  if (dir > 0) idx = Find.matches.findIndex(m => m.r > cur.r || (m.r === cur.r && m.c > cur.c));
  else { for (let i = Find.matches.length - 1; i >= 0; i--) { const m = Find.matches[i]; if (m.r < cur.r || (m.r === cur.r && m.c < cur.c)) { idx = i; break; } } }
  if (idx === -1) idx = dir > 0 ? 0 : Find.matches.length - 1;
  const m = Find.matches[idx];
  setSelection(m.r, m.c, m.r, m.c);
  Find.hlCell = m.note ? key(m.r, m.c) : null;
  if (m.note) {
    const sh2 = activeSheet();
    if (noteAt(sh2, m.r, m.c)) showNoteThreadPopover(sh2, m.r, m.c, cellScreenRect(sh2, m.r, m.c), false);
  } else hideNotePopover();
  markActiveMatch();
}
function replaceOne() {
  if (!Find.matches.length) Find.matches = collectMatches();
  const cur = Find.matches.find(m => m.r === SEL.active.r && m.c === SEL.active.c);
  if (!cur) { findNext(1); return; }
  replaceAt(activeSheet(), cur.r, cur.c);
  updateFindCount();
  requestPaint();
}
function replaceAll() {
  const sh = activeSheet();
  const matches = collectMatches();
  if (!matches.length) { toast('No matches found', 'warn'); return; }
  batchHistory(() => {
    for (const m of matches) replaceAt(sh, m.r, m.c);
  }, 'Replace all');
  updateFindCount();
  requestPaint(); updateStatusBar(); updateFormulaBar();
  toast('Replaced ' + matches.length + ' occurrence(s)', 'success');
}
function replaceAt(sh, r, c) {
  const cell = sh.cells.get(key(r, c));
  if (!cell) return;
  const q = Find.matchCase ? Find.text : Find.text.toLowerCase();
  const doRepl = text => {
    if (!Find.matchCase) {
      let out = '', i = 0;
      const low = text.toLowerCase();
      while (i < text.length) {
        const idx = low.indexOf(q, i);
        if (idx === -1) { out += text.slice(i); break; }
        out += text.slice(i, idx) + Find.replace;
        i = idx + Find.text.length;
      }
      return out;
    }
    return text.split(Find.text).join(Find.replace);
  };
  if (cell.f) {
    commitCellValue(sh, r, c, doRepl(cell.f));
  } else if (cell.v != null) {
    if (typeof cell.v === 'number') {
      const t = doRepl(generalNum(cell.v));
      commitCellValue(sh, r, c, t);
    } else {
      commitCellValue(sh, r, c, doRepl(String(cell.v)));
    }
  }
  /* note text (thread replies kept intact; only the main note body is rewritten) */
  if (Find.inNotes) {
    const note = noteAt(sh, r, c);
    if (note) {
      const nt = doRepl(String(note.text || ''));
      if (nt !== note.text) setNote(sh, r, c, nt);
    }
  }
}

/* ---------------- text to columns ---------------- */
function openTextToColumns() {
  const sh = activeSheet();
  const rg = activeSelRange();
  if (SEL.ranges.length !== 1) { toast('Select a single column range first', 'warn'); return; }
  const state = { delim: ',', custom: '', consecutive: false };
  const content = el('<div>' +
    '<div class="hint">Splits the text in each selected cell into multiple columns using the delimiter below. A preview is shown.</div>' +
    '<div class="form-row"><label>Delimiter</label><div class="fr-input"><select id="ttc-d"><option value=",">Comma</option><option value=";">Semicolon</option><option value="\t">Tab</option><option value=" ">Space</option><option value="|">Pipe</option><option value="custom">Custom…</option></select><input type="text" id="ttc-custom" placeholder="Custom character" style="width:110px" disabled></div></div>' +
    '<div class="form-row"><label></label><div class="fr-input"><label><input type="checkbox" id="ttc-cons"> Treat consecutive delimiters as one</label></div></div>' +
    '<div class="form-row"><label>Preview</label><div class="fr-input"><div class="table-preview" id="ttc-preview"></div></div></div></div>');
  const dSel = content.querySelector('#ttc-d');
  const customIn = content.querySelector('#ttc-custom');
  dSel.addEventListener('change', () => { customIn.disabled = dSel.value !== 'custom'; updatePreview(); });
  customIn.addEventListener('input', updatePreview);
  content.querySelector('#ttc-cons').addEventListener('change', e => { state.consecutive = e.target.checked; updatePreview(); });
  function curDelim() { return dSel.value === 'custom' ? (customIn.value || ',') : dSel.value === ' ' ? ' ' : dSel.value.replace('\\t', '\t'); }
  function splitRow(text) {
    const d = curDelim();
    let parts = text.split(d);
    if (state.consecutive && d !== ' ') parts = parts.filter((p, i) => p !== '' || i === 0).length ? text.split(d).filter(p => p !== '') : [''];
    if (state.consecutive && d === ' ') parts = text.split(/ +/).filter(p => p !== '');
    return parts;
  }
  function updatePreview() {
    const rows = [];
    const rr = Math.min(rg.r2, rg.r1 + 8);
    for (let r = rg.r1; r <= rr; r++) {
      const info = displayValue(sh, r, rg.c1);
      rows.push(splitRow(info.text));
    }
    const maxC = Math.max(1, ...rows.map(r => r.length));
    let html = '<table><tr>' + Array.from({ length: maxC }, (_, i) => '<th>' + colName(rg.c1 + i) + '</th>').join('') + '</tr>';
    for (const row of rows) html += '<tr>' + Array.from({ length: maxC }, (_, i) => '<td>' + esc(row[i] == null ? '' : row[i]) + '</td>').join('') + '</tr>';
    content.querySelector('#ttc-preview').innerHTML = html + '</table>';
  }
  updatePreview();
  openModal({
    title: 'Text to Columns', width: 560, content,
    buttons: [{ label: 'Cancel' }, { label: 'Finish', primary: true, onClick: () => {
      const before = snapshotSheet(sh);
      const maxLen = rg.r2 - rg.r1 + 1;
      for (let r = rg.r1; r <= rg.r2; r++) {
        const info = displayValue(sh, r, rg.c1);
        const parts = splitRow(info.text);
        for (let i = 0; i < parts.length; i++) {
          const cc = rg.c1 + i;
          if (cc >= MAX_COLS) break;
          if (i === 0) continue; /* keep first part in original cell */
          const parsed = parseUserInput(parts[i]);
          writeCell(sh, r, cc, { v: parsed.v !== undefined ? parsed.v : null, f: parsed.f || null });
        }
      }
      const after = snapshotSheet(sh);
      pushHistory({ label: 'Text to columns', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
      requestPaint(); Persistence.markDirty();
      toast('Text split into columns', 'success');
      return true;
    } }]
  });
}

/* ---------------- remove duplicates ---------------- */
function openRemoveDuplicates() {
  const sh = activeSheet();
  const rg = activeSelRange();
  let region;
  if (SEL.ranges.length === 1 && rg.r2 > rg.r1 && rg.c2 > rg.c1 && !isColSelection(rg) && !isRowSelection(rg)) region = rg;
  else region = detectRegionAround(SEL.active.r, SEL.active.c);
  if (region.r2 <= region.r1) { toast('Select a range with at least two rows', 'warn'); return; }
  const cols = [];
  for (let c = region.c1; c <= region.c2; c++) cols.push(c);
  const checked = new Set(cols);
  const content = el('<div><div class="hint">Rows are compared by the selected columns. The first occurrence is kept.</div><div id="rd-cols" style="margin-bottom:10px"></div></div>');
  const box = content.querySelector('#rd-cols');
  for (const c of cols) {
    const label = displayValue(sh, region.r1, c).text || colName(c);
    const row = el('<label class="filter-row" style="display:flex"><input type="checkbox" data-c="' + c + '" checked><span class="grow">Column ' + colName(c) + (label ? ' — ' + esc(String(label).slice(0, 18)) : '') + '</span></label>');
    row.querySelector('input').addEventListener('change', e => { if (e.target.checked) checked.add(c); else checked.delete(c); });
    box.appendChild(row);
  }
  openModal({
    title: 'Remove Duplicates', width: 460, content,
    buttons: [{ label: 'Cancel' }, { label: 'Remove', primary: true, onClick: () => {
      if (!checked.size) { toast('Select at least one column', 'warn'); return false; }
      const before = snapshotSheet(sh);
      const seen = new Set();
      const keepRows = [];
      let removed = 0;
      for (let r = region.r1; r <= region.r2; r++) {
        const sig = cols.map(c => {
          const cell = sh.cells.get(key(r, c));
          const v = cell ? (cell.f ? getComputedCell(sh.id, r, c) : cell.v) : null;
          return isErr(v) ? '#' + c : String(v == null ? '' : v).toLowerCase();
        }).join('\u0001') + '|' + [...checked].sort().join(',');
        const keySig = cols.filter(c => checked.has(c)).map(c => {
          const cell = sh.cells.get(key(r, c));
          const v = cell ? (cell.f ? getComputedCell(sh.id, r, c) : cell.v) : null;
          return String(v == null ? '' : v).toLowerCase();
        }).join('\u0001');
        if (seen.has(keySig)) { removed++; continue; }
        seen.add(keySig);
        keepRows.push(r);
      }
      if (removed === 0) { toast('No duplicate rows found', 'info'); return true; }
      /* compact rows */
      let w = 0;
      for (let r = region.r1; r <= region.r2; r++) {
        const keep = keepRows.includes(r);
        for (let c = region.c1; c <= region.c2; c++) {
          const src = keep ? sh.cells.get(key(r, c)) : null;
          const dstRow = region.r1 + w;
          if (keep) {
            const cell = src;
            writeCell(sh, dstRow, c, cell ? { v: cell.v, f: cell.f, s: cell.s } : { v: null, f: null, s: null });
          }
        }
        if (keep) w++;
      }
      for (let r = region.r1 + w; r <= region.r2; r++) for (let c = region.c1; c <= region.c2; c++) writeCell(sh, r, c, { v: null, f: null, s: null });
      const after = snapshotSheet(sh);
      pushHistory({ label: 'Remove duplicates', undo: () => restoreSheet(sh, before), redo: () => restoreSheet(sh, after) });
      requestPaint(); Persistence.markDirty();
      toast(removed + ' duplicate row(s) removed', 'success');
      return true;
    } }]
  });
}

/* ---------------- help ---------------- */
function openHelpDialog(page) {
  const shortcuts = [['Arrow keys / Tab / Enter', 'Move the active cell'], ['Shift + Arrow', 'Extend selection'], ['Ctrl + Arrow', 'Jump to edge of data region'], ['Ctrl + Home / End', 'Go to A1 / last used cell'], ['F2', 'Edit the active cell'], ['Type any character', 'Start typing in the active cell'], ['Enter / Tab / Esc', 'Commit / commit / cancel an edit'], ['Delete / Backspace', 'Clear cell contents'], ['Ctrl + C / X / V', 'Copy / cut / paste'], ['Ctrl + Z / Y', 'Undo / redo'], ['Ctrl + B / I / U', 'Bold / italic / underline'], ['Ctrl + F / H', 'Find / replace'], ['Ctrl + G', 'Go to'], ['Ctrl + A', 'Select all'], ['Ctrl + S', 'Save to browser'], ['Ctrl + P', 'Print / PDF'], ['F9', 'Recalculate workbook'], ['Ctrl + `', 'Toggle formula view'], ['Ctrl + Page Up/Down', 'Switch worksheets'], ['Double-click header edge', 'AutoFit row/column'], ['Drag fill handle', 'Fill series / copy / formulas'], ['Drag selection border', 'Move cells']];
  const rows = shortcuts.map(s => '<tr><td>' + esc(s[0]) + '</td><td>' + esc(s[1]) + '</td></tr>').join('');
  const bodies = {
    help: '<h3 style="margin-top:0">Welcome to EmeraldSheets</h3><p>EmeraldSheets is a complete spreadsheet that runs entirely in your browser. Everything is stored locally with IndexedDB — nothing is sent to any server.</p><ul><li>Enter formulas starting with <span class="kbd">=</span> — e.g. <span class="kbd">=SUM(A1:A10)</span>, <span class="kbd">=IF(A1&gt;5,"High","Low")</span>.</li><li>Use the ribbon for formatting, number formats, borders, merges, tables and charts.</li><li>Drag the small square at the selection corner to fill series; drag the selection border to move cells.</li><li>Use Data ▸ Filter for dropdown column filters, Data ▸ Validation to restrict entries.</li><li>The Home tab has Import, Export (.xlsx / .csv) and Print (also saves as PDF) buttons. Your work autosaves to this browser.</li></ul>',
    shortcuts: '<table class="help-table">' + rows + '</table>',
    about: '<h3 style="margin-top:0">EmeraldSheets</h3><p>A self-contained client-side spreadsheet application. Version 1.0.</p><p>Storage: IndexedDB in this browser. Import/export uses SheetJS from a CDN when available — the app works fully offline without it.</p><p>Privacy: all workbook data stays on this device. No servers, no accounts, no tracking.</p>'
  };
  openModal({ title: page === 'shortcuts' ? 'Keyboard Shortcuts' : page === 'about' ? 'About EmeraldSheets' : 'Quick Help', width: 620, content: '<div>' + bodies[page] + '</div>', buttons: [{ label: 'Close', primary: true }] });
}

/* ---------------- diagnostics (Tools > Diagnostics) ---------------- */
function runFormulaBench(rows) {
  rows = Math.min(Math.max(rows || 5000, 100), 20000);
  const sh = activeSheet();
  const t0 = performance.now();
  for (let r = 0; r < rows; r++) {
    sh.cells.set(key(r, 10), { v: (r % 89) + 1, f: null, s: null, cv: undefined, ast: undefined });
    sh.cells.set(key(r, 11), { v: null, f: '=K' + (r + 1) + '*2', s: null, cv: undefined, ast: undefined });
    sh.cells.set(key(r, 12), { v: null, f: '=L' + (r + 1) + '+K' + (r + 1), s: null, cv: undefined, ast: undefined });
  }
  if (rows - 1 > sh.usedMax.r) sh.usedMax.r = rows - 1;
  if (12 > sh.usedMax.c) sh.usedMax.c = 12;
  growExtent(sh, rows, 13);
  sh.rows.invalidate();
  const t1 = performance.now();
  rebuildAllDeps();
  const t2 = performance.now();
  recalcWorkbook(true);
  const t3 = performance.now();
  paint();
  const t4 = performance.now();
  const probe = sh.cells.get(key(0, 10));
  if (probe) { probe.v = 1000; probe.cv = undefined; markDirty(sh.id, 0, 10); }
  const t5 = performance.now();
  recalcWorkbook(false);
  const t6 = performance.now();
  paint();
  const t7 = performance.now();
  return { formulas: rows * 2, rows, fillMs: Math.round(t1 - t0), rebuildDepsMs: Math.round(t2 - t1), fullCalcMs: Math.round(t3 - t2), paintMs: Math.round(t4 - t3), touchRecalcMs: Math.round(t6 - t5), touchPaintMs: Math.round(t7 - t6) };
}
function clearBenchCells(rows) {
  const sh = activeSheet();
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (const c of [10, 11, 12]) { if (sh.cells.delete(key(r, c))) n++; }
  }
  sh.rows.invalidate();
  rebuildAllDeps();
  requestPaint();
  return n;
}
function collectWorkbookStats() {
  let cells = 0, formulas = 0, notes = 0, charts = 0, cf = 0, dv = 0, merges = 0;
  for (const sh of WB.sheets) {
    cells += sh.cells.size;
    for (const [, cell] of sh.cells) if (cell && cell.f) formulas++;
    notes += sh.notes ? sh.notes.size : 0;
    charts += sh.charts ? sh.charts.length : 0;
    cf += sh.cf ? sh.cf.length : 0;
    dv += sh.dv ? sh.dv.length : 0;
    merges += sh.merges ? sh.merges.length : 0;
  }
  let usage = null, quota = null;
  return {
    sheets: WB.sheets.length, cells, formulas, notes, charts, cf, dv, merges,
    names: Object.keys(WB.names || {}).length,
    history: H.undo.length, redo: H.redo.length, historyLimit: H.limit,
    activeSheet: activeSheet().name,
    storage: { usage, quota }
  };
}
function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function openDiagnostics() {
  const st = collectWorkbookStats();
  const stat = (label, value, cls) => '<div class="diag-stat' + (cls ? ' ' + cls : '') + '"><div class="diag-stat-v">' + esc(String(value)) + '</div><div class="diag-stat-l">' + esc(label) + '</div></div>';
  const statsHtml =
    '<div class="diag-section"><div class="diag-section-t">' + icon('database') + ' Workbook</div>' +
    '<div class="diag-grid">' +
    stat('Sheets', st.sheets) + stat('Cells', st.cells.toLocaleString()) + stat('Formulas', st.formulas.toLocaleString()) +
    stat('Named Ranges', st.names) + stat('Notes', st.notes) + stat('Charts', st.charts) +
    stat('Cond. Format Rules', st.cf) + stat('Validation Rules', st.dv) + stat('Merged Regions', st.merges) +
    '</div></div>' +
    '<div class="diag-section"><div class="diag-section-t">' + icon('history') + ' Session History</div>' +
    '<div class="diag-grid">' +
    stat('Undo Entries', st.history + ' / ' + st.historyLimit) + stat('Redo Entries', st.redo) + stat('Calc Mode', Calc.mode === 'auto' ? 'Automatic' : 'Manual (F9)') +
    '</div></div>';
  const content = el(
    '<div>' +
    statsHtml +
    '<div class="diag-section"><div class="diag-section-t">' + icon('gauge') + ' Storage (IndexedDB)</div>' +
    '<div class="diag-grid" id="diag-storage"><div class="diag-stat"><div class="diag-stat-v">…</div><div class="diag-stat-l">Used / Quota</div></div></div></div>' +
    '<div class="diag-section"><div class="diag-section-t">' + icon('calculate') + ' Formula Benchmark</div>' +
    '<div class="diag-bench-note">Writes temporary constants and formulas into columns K–M of the active sheet, then times dependency-graph rebuild and recalculation. Use “Clear benchmark data” to remove them.</div>' +
    '<div class="diag-bench-controls">' +
    '<label class="diag-ctl"><span>Rows</span><select id="diag-bench-rows" aria-label="Benchmark row count"><option value="1000">1,000</option><option value="5000" selected>5,000</option><option value="10000">10,000</option></select></label>' +
    '<button class="btn primary" id="diag-bench-run">Run Benchmark</button>' +
    '<button class="btn" id="diag-bench-clear">Clear Benchmark Data</button>' +
    '</div>' +
    '<div class="diag-bench-results" id="diag-bench-out" hidden></div>' +
    '</div>' +
    '</div>'
  );
  const modal = openModal({ title: 'Diagnostics', width: 640, content, buttons: [{ label: 'Close', primary: true }] });
  /* storage estimate (async) */
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(est => {
      const box = content.querySelector('#diag-storage');
      if (box && est) {
        const pct = est.quota ? Math.min(100, Math.round((est.usage / est.quota) * 100)) : null;
        box.innerHTML = stat('Used', fmtBytes(est.usage)) + stat('Quota', fmtBytes(est.quota)) + stat('Utilization', pct == null ? '—' : pct + '%', pct != null && pct > 80 ? 'warn' : '');
      }
    }).catch(() => { /* keep placeholder */ });
  } else {
    const box = content.querySelector('#diag-storage');
    if (box) box.innerHTML = stat('estimate()', 'Not supported in this browser');
  }
  /* benchmark runner */
  const out = content.querySelector('#diag-bench-out');
  content.querySelector('#diag-bench-run').addEventListener('click', () => {
    const rows = +content.querySelector('#diag-bench-rows').value;
    out.hidden = false;
    out.innerHTML = '<div class="diag-bench-running"><span class="spinner"></span> Running…</div>';
    /* let the dialog paint the running state before the synchronous benchmark blocks */
    setTimeout(() => {
      const r = runFormulaBench(rows);
      const bar = (label, ms, max) => '<div class="bench-row"><div class="bench-label">' + esc(label) + '</div><div class="bench-track"><div class="bench-fill" style="width:' + Math.max(2, Math.min(100, (ms / max) * 100)) + '%"></div></div><div class="bench-ms">' + ms.toLocaleString() + ' ms</div></div>';
      const maxMs = Math.max(r.fillMs, r.rebuildDepsMs, r.fullCalcMs, r.paintMs, 1);
      out.innerHTML =
        '<div class="bench-head">' + r.formulas.toLocaleString() + ' formulas across ' + r.rows.toLocaleString() + ' rows</div>' +
        bar('Fill test data', r.fillMs, maxMs) +
        bar('Rebuild dependency graph', r.rebuildDepsMs, maxMs) +
        bar('Full recalculation', r.fullCalcMs, maxMs) +
        bar('Repaint', r.paintMs, maxMs) +
        bar('Single-cell touch recalc', r.touchRecalcMs, Math.max(r.touchRecalcMs, 1)) +
        bar('Touch repaint', r.touchPaintMs, Math.max(r.touchPaintMs, 1)) +
        '<div class="bench-foot">All timings are wall-clock milliseconds measured on this device.</div>';
      toast('Benchmark complete', 'success', 1400);
    }, 40);
  });
  content.querySelector('#diag-bench-clear').addEventListener('click', () => {
    const rows = +content.querySelector('#diag-bench-rows').value;
    const n = clearBenchCells(rows);
    toast('Cleared ' + n + ' benchmark cell(s)', 'info', 1600);
  });
  return modal;
}
function openHistoryDialog() {
  const content = el('<div>' +
    '<div class="hist-hint">' + icon('history') + ' Click any entry to jump the workbook back (or forward) to that point. The latest entry sits at the top of the undo stack.</div>' +
    '<div class="hist-cols">' +
    '<div class="hist-col"><div class="hist-col-t">' + icon('undo') + ' Undo Stack <span class="hist-count" data-count="undo">0</span></div><div class="hist-lists" data-lists="undo"></div></div>' +
    '<div class="hist-col"><div class="hist-col-t">' + icon('redo') + ' Redo Stack <span class="hist-count" data-count="redo">0</span></div><div class="hist-lists" data-lists="redo"></div></div>' +
    '</div>' +
    '<div class="hist-note">History holds up to ' + H.limit + ' operations per session. Clearing it cannot be undone.</div>' +
    '</div>');
  function renderLists() {
    const undoList = H.undo.map(e => e.label || '(unnamed)');
    const redoList = H.redo.map(e => e.label || '(unnamed)');
    const item = (label, i, total, kind) => {
      const num = total - i;
      const steps = total - i;
      const cls = kind === 'undo' ? (i === total - 1 ? 'hist-item latest' : 'hist-item') : 'hist-item redo';
      const verb = kind === 'undo' ? 'Undo ' + steps + ' step' + (steps === 1 ? '' : 's') + ' back to here' : 'Redo ' + steps + ' step' + (steps === 1 ? '' : 's') + ' forward to here';
      return '<li class="' + cls + '" data-kind="' + kind + '" data-i="' + i + '" role="button" tabindex="0" title="' + esc(verb) + '">' +
        '<span class="hist-num">' + num + '</span><span class="hist-label">' + esc(label) + '</span>' +
        '<span class="hist-jump" aria-hidden="true">' + (kind === 'undo' ? icon('undo') : icon('redo')) + '</span></li>';
    };
    const undoBox = content.querySelector('[data-lists="undo"]');
    const redoBox = content.querySelector('[data-lists="redo"]');
    undoBox.innerHTML = undoList.length
      ? '<ul class="hist-list">' + undoList.map((l, i) => item(l, i, undoList.length, 'undo')).join('') + '</ul>'
      : '<div class="hist-empty">No undo history yet — every edit, format and structural change is recorded here.</div>';
    redoBox.innerHTML = redoList.length
      ? '<ul class="hist-list">' + redoList.map((l, i) => item(l, i, redoList.length, 'redo')).join('') + '</ul>'
      : '<div class="hist-empty">Nothing to redo.</div>';
    content.querySelector('[data-count="undo"]').textContent = undoList.length;
    content.querySelector('[data-count="redo"]').textContent = redoList.length;
  }
  function jump(kind, i) {
    if (kind === 'undo') {
      const steps = H.undo.length - i;
      if (steps <= 0) return;
      const label = H.undo[i] && H.undo[i].label ? H.undo[i].label : '';
      for (let k = 0; k < steps; k++) undo();
      toast('Reverted ' + steps + ' step' + (steps === 1 ? '' : 's') + (label ? ' — back before "' + label + '"' : ''), 'info', 1600);
    } else {
      const steps = H.redo.length - i;
      if (steps <= 0) return;
      const label = H.redo[i] && H.redo[i].label ? H.redo[i].label : '';
      for (let k = 0; k < steps; k++) redo();
      toast('Replayed ' + steps + ' step' + (steps === 1 ? '' : 's') + (label ? ' — through "' + label + '"' : ''), 'info', 1600);
    }
    renderLists();
  }
  content.addEventListener('click', e => {
    const li = e.target.closest('.hist-item');
    if (li) jump(li.dataset.kind, +li.dataset.i);
  });
  content.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = e.target.closest('.hist-item');
    if (li) { e.preventDefault(); jump(li.dataset.kind, +li.dataset.i); }
  });
  renderLists();
  openModal({
    title: 'Undo History', width: 560, content,
    buttons: [
      { label: 'Clear History', danger: true, onClick: () => { confirmDialog('Clear History', 'Discard all undo and redo information? Workbook content is not affected.', () => { H.undo.length = 0; H.redo.length = 0; updateUndoRedoUI(); closeModalStack(); toast('History cleared', 'info', 1400); }); return false; } },
      { label: 'Close', primary: true }
    ]
  });
}

/* ---------------- command palette (Ctrl+K) ---------------- */
function paletteCommands() {
  const cmds = [];
  const seen = new Set();
  const add = (label, iconName, group, action) => {
    if (!label || typeof action !== 'function') return;
    const id = String(label).toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    cmds.push({ label: String(label), icon: iconName || 'dots', group: group || 'Commands', action });
  };
  /* header-only commands that have no ribbon button */
  add('Undo', 'undo', 'Edit', () => undo());
  add('Redo', 'redo', 'Edit', () => redo());
  add('Save Now', 'save', 'Document', () => { Persistence.flush(); toast('Autosaved to this browser', 'success', 1300); });
  try {
    const cfg = ribbonConfig();
    for (const tabName in cfg) {
      for (const g of cfg[tabName]) {
        for (const item of g.items) {
          if (item.custom === 'stack' && item.items) {
            for (const sub of item.items) add(sub.title || sub.label, sub.icon, tabName, sub.action);
            continue;
          }
          if (item.action) add(item.title || item.label, item.icon, tabName, item.action);
          /* split buttons: index the dropdown menu entries too (labelled "Parent — Child" when the parent has no action) */
          if (item.menu) {
            const menu = typeof item.menu === 'function' ? item.menu() : item.menu;
            for (const sub of menu) {
              if (!sub || sub.sep || sub.custom) continue;
              const label = item.action ? sub.label : (item.label + ' — ' + sub.label);
              add(label, sub.icon || item.icon, tabName, sub.action);
              if (sub.submenu) {
                for (const s2 of sub.submenu) { if (s2 && !s2.sep) add(item.label + ' — ' + s2.label, s2.icon || item.icon, tabName, s2.action); }
              }
            }
          }
        }
      }
    }
  } catch (err) { /* palette is best-effort */ }
  return cmds;
}
let PAL = null;
function openCommandPalette() {
  if (PAL) { closeCommandPalette(); return; }
  closePopups();
  const overlay = el('<div class="palette-overlay" role="dialog" aria-modal="true" aria-label="Command palette"></div>');
  const box = el('<div class="palette">' +
    '<div class="palette-head">' + icon('search', 'pal-search') +
    '<input class="palette-input" type="text" placeholder="Type a command…" aria-label="Search commands" spellcheck="false" autocomplete="off">' +
    '<span class="palette-esc" aria-hidden="true">esc</span></div>' +
    '<div class="palette-list" role="listbox" aria-label="Commands"></div>' +
    '<div class="palette-foot"><span>' + icon('command', 'pal-cmd') + ' Type to filter · ↑↓ to navigate · Enter to run</span><span class="palette-count"></span></div>' +
    '</div>');
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  PAL = { overlay, box, input: box.querySelector('.palette-input'), list: box.querySelector('.palette-list'), cmds: paletteCommands(), sel: 0, filtered: [] };
  requestAnimationFrame(() => { if (PAL) PAL.overlay.classList.add('open'); });
  renderPaletteList('');
  PAL.input.addEventListener('input', () => { PAL.sel = 0; renderPaletteList(PAL.input.value); });
  PAL.input.addEventListener('keydown', e => {
    if (!PAL) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteSel(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
  });
  const backdropDismiss = e => { if (PAL && e.target === overlay) closeCommandPalette(); };
  overlay.addEventListener('pointerdown', backdropDismiss);
  overlay.addEventListener('mousedown', backdropDismiss);
  overlay.addEventListener('click', backdropDismiss);
  setTimeout(() => { if (PAL) PAL.input.focus(); }, 0);
}
function renderPaletteList(q) {
  if (!PAL) return;
  const query = (q || '').trim().toLowerCase();
  let items = PAL.cmds;
  if (query) {
    const tokens = query.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const c of items) {
      const hay = (c.label + ' ' + c.group).toLowerCase();
      let total = 0, ok = true;
      for (const tok of tokens) {
        const idx = hay.indexOf(tok);
        if (idx >= 0) { total += idx === 0 ? 0 : idx; continue; }
        /* token must live inside a single word of the label (subsequence) */
        const words = c.label.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
        let best = -1;
        for (const w of words) {
          if (w.indexOf(tok) >= 0) { best = Math.min(best < 0 ? 1e9 : best, w.indexOf(tok)); continue; }
          if (tok.length >= 3 && w.length > 2) {
            let pi = 0;
            for (let i = 0; i < w.length && pi < tok.length; i++) if (w[i] === tok[pi]) pi++;
            if (pi === tok.length) best = Math.min(best < 0 ? 1e9 : best, 200 + (w.length - tok.length));
          }
        }
        if (best < 0) { ok = false; break; }
        total += best;
      }
      if (ok) scored.push({ c, score: total + (c.group === 'Home' ? -0.4 : 0) });
    }
    scored.sort((a, b) => a.score - b.score);
    items = scored.map(s => s.c);
  }
  PAL.filtered = items.slice(0, 60);
  const list = PAL.list;
  list.innerHTML = '';
  if (!PAL.filtered.length) {
    list.appendChild(el('<div class="palette-empty">No matching commands</div>'));
  } else {
    PAL.filtered.forEach((c, i) => {
      const row = el('<div class="palette-item' + (i === PAL.sel ? ' sel' : '') + '" role="option" aria-selected="' + (i === PAL.sel) + '">' +
        '<span class="palette-ic">' + icon(c.icon) + '</span>' +
        '<span class="palette-label">' + esc(c.label) + '</span>' +
        '<span class="palette-group">' + esc(c.group) + '</span></div>');
      row.addEventListener('mouseenter', () => setPaletteSel(i));
      row.addEventListener('click', () => { PAL.sel = i; runPaletteSel(); });
      list.appendChild(row);
    });
  }
  const cnt = PAL.overlay.querySelector('.palette-count');
  if (cnt) cnt.textContent = query ? (PAL.filtered.length + ' / ' + PAL.cmds.length) : (PAL.cmds.length + ' commands');
  const selEl = list.querySelector('.palette-item.sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
}
function setPaletteSel(i) {
  if (!PAL) return;
  PAL.sel = i;
  PAL.list.querySelectorAll('.palette-item').forEach((n, j) => {
    n.classList.toggle('sel', j === i);
    n.setAttribute('aria-selected', j === i ? 'true' : 'false');
  });
}
function movePaletteSel(d) {
  if (!PAL || !PAL.filtered.length) return;
  setPaletteSel((PAL.sel + d + PAL.filtered.length) % PAL.filtered.length);
  const rows = PAL.list.querySelectorAll('.palette-item');
  if (rows[PAL.sel]) rows[PAL.sel].scrollIntoView({ block: 'nearest' });
}
function runPaletteSel() {
  if (!PAL || !PAL.filtered[PAL.sel]) return;
  const c = PAL.filtered[PAL.sel];
  closeCommandPalette();
  try { c.action(); } catch (err) { console.error(err); }
  updateRibbonState();
}
function closeCommandPalette() {
  if (!PAL) return;
  const p = PAL; PAL = null;
  const ov = p.overlay;
  if (SmoothScroll.reduced) { ov.remove(); return; }
  ov.classList.remove('open');
  ov.classList.add('closing');
  setTimeout(() => ov.remove(), 150);
}

/* ---------------- boot ---------------- */
function bootChrome() {
  buildRibbon();
  updateSheetTabBar();
  updateSaveStatus();
  $('#sb-zoom-pct').textContent = Math.round(VIEW.zoom * 100) + '%';
  $('#formula-row').style.display = VIEW.showFormulaBar ? '' : 'none';
  updateUndoRedoUI();
}
function resizeCanvas() {
  const area = $('#grid-area');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  R.dpr = dpr;
  const w = area.clientWidth, h = area.clientHeight;
  R.canvas.width = Math.max(10, Math.round(w * dpr));
  R.canvas.height = Math.max(10, Math.round(h * dpr));
  R.canvas.style.width = w + 'px';
  R.canvas.style.height = h + 'px';
  requestPaint();
}
function setupChrome() {
  R.canvas = $('#grid-canvas');
  R.ctx = R.canvas.getContext('2d');
  UI.editor = $('#cell-editor');
  UI.formulaInput = $('#formula-input');
  UI.nameBox = $('#name-box');
  UI.measureCtx = document.createElement('canvas').getContext('2d');
  UI.canvasFocus = () => { try { R.canvas.focus(); } catch (e) {} };
  R.canvas.tabIndex = 0;
  setupGridEvents();

  $('#fx-cancel').innerHTML = icon('x');
  $('#fx-confirm').innerHTML = icon('check');
  $('#name-box-dd').innerHTML = icon('chevDown');
  $('#formula-expand').innerHTML = icon('chevDown');
  $('#fx-cancel').addEventListener('click', () => { if (Edit.active) cancelEdit(); else cancelFormulaBar(); });
  $('#fx-confirm').addEventListener('click', () => { if (Edit.active) commitEditor(); else commitFormulaBar(); });
  $('#fx-insert').addEventListener('click', () => openInsertFunctionDialog());
  $('#name-box-dd').addEventListener('click', e => {
    const names = Object.keys(WB.names);
    const items = names.length ? names.map(n => ({ label: WB.names[n].name, action: () => { UI.nameBox.value = WB.names[n].name; commitNameBox(); } })) : [{ label: '(no named ranges)', disabled: true }];
    showPopupMenu(items, e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 2);
  });
  UI.formulaInput.addEventListener('focus', () => {
    if (!Edit.active) {
      beginEdit(SEL.active.r, SEL.active.c, { fromFormulaBar: true, cursorMode: true });
      UI.formulaInput.focus();
    }
  });
  UI.formulaInput.addEventListener('input', () => { if (Edit.active) { UI.editor.value = UI.formulaInput.value; } updateFormulaAC(UI.formulaInput); updateFormulaArgTip(UI.formulaInput); });
  UI.formulaInput.addEventListener('keydown', () => { if (FxAC.open) FxAC.host = UI.formulaInput; });
  UI.nameBox.addEventListener('focus', () => UI.nameBox.select());
  $('#formula-expand').addEventListener('click', () => $('#formula-row').classList.toggle('expanded'));
  /* ---- File modal (Backstage) ---- */
  $('#fileModalCloseXBtn').addEventListener('click', closeFileModal);
  $('#fileModal').addEventListener('click', e => { if (e.target.id === 'fileModal') closeFileModal(); });
  $('#fileCloseBtn').addEventListener('click', () => { closeFileModal(); closeWorkbookToWelcome(); });
  $('#fileDeleteBtn').addEventListener('click', () => { closeFileModal(); deleteCurrentWorkbook(); });
  $('#fileImportBtn').addEventListener('click', () => { closeFileModal(); importFileDialog(); });
  $('#fileExportXlsxBtn').addEventListener('click', () => { closeFileModal(); exportXlsx(); });
  $('#fileExportCsvBtn').addEventListener('click', () => { closeFileModal(); exportCsv(); });
  $('#filePrintBtn').addEventListener('click', () => { closeFileModal(); printWorksheet(); });
  const welcomeNewBtn = $('#welcomeNewBtn');
  if (welcomeNewBtn) welcomeNewBtn.addEventListener('click', welcomeNew);
  const welcomeImportBtn = $('#welcomeImportBtn');
  if (welcomeImportBtn) welcomeImportBtn.addEventListener('click', welcomeImport);
  const fileNameInput = $('#fileModalNameInput');
  fileNameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fileNameInput.blur(); closeFileModal(); }
  });
  fileNameInput.addEventListener('input', () => {
    const t = fileNameInput.value.trim() || 'Untitled workbook';
    if (t !== WB.title) { WB.title = t; Persistence.markDirty(); }
  });
  $('#add-sheet').innerHTML = icon('plus');
  $('#add-sheet').addEventListener('click', () => addSheet(WB.activeSheetId));
  $('#tab-home').innerHTML = icon('chevsLeft');
  $('#tab-prev').innerHTML = icon('chevLeft');
  $('#tab-next').innerHTML = icon('chevRight');
  $('#tab-end').innerHTML = icon('chevsRight');
  $('#tab-home').addEventListener('click', () => { $('#sheet-tabs').scrollLeft = 0; });
  $('#tab-prev').addEventListener('click', () => { $('#sheet-tabs').scrollLeft -= 120; });
  $('#tab-next').addEventListener('click', () => { $('#sheet-tabs').scrollLeft += 120; });
  $('#tab-end').addEventListener('click', () => { $('#sheet-tabs').scrollLeft = 99999; });
  $('#sb-zoom-pct').addEventListener('click', () => animateZoom(1));
  setupEditorEvents();
  window.addEventListener('resize', rafThrottle(() => { resizeCanvas(); positionRibbonIndicator(); }));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => positionRibbonIndicator());
  document.addEventListener('mousedown', e => {
    if (Edit.active && !Edit.refMode) {
      const t = e.target;
      if (t !== UI.editor && !t.closest('#formula-row') && !t.closest('.popup') && !t.closest('.modal-overlay') && t.id !== 'grid-canvas') {
        commitEditor();
      }
    }
  });
  window.addEventListener('beforeunload', () => { try { Persistence.flush(); } catch (e) {} });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') Persistence.flush(); });
}

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  setupChrome();
  await loadLastOrNew();
  showWelcomeScreen(true);
  /* Agent link: the AI chat posts an "es-edit" message here after rewriting
     a workbook, so an already-open sheets tab reloads it without a refresh. */
  if (window.emeraldsuiteAgent && window.emeraldsuiteAgent.onSync) {
    window.emeraldsuiteAgent.onSync((msg) => {
      if (msg && msg.type === 'es-edit' && msg.app === 'sheets' && msg.id && WB && msg.id === WB.id) {
        openWorkbook(msg.id);
      }
    });
  }
  /* Deep-link: ?owned=book_<ms>_<hex> opens that workbook immediately,
     matching Docs/Notes/Slides behaviour. */
  const ownedParam = (() => { try { return new URLSearchParams(location.search).get('owned'); } catch (e) { return null; } })();
  if (ownedParam) {
    try {
      const doc = await IO.loadDoc(ownedParam);
      if (doc && doc.data) { await openWorkbook(ownedParam); }
      else { history.replaceState({}, document.title, location.pathname); }
    } catch (e) { history.replaceState({}, document.title, location.pathname); }
  }
  /* marquee animation loop (cheap; only repaints when marquee active) */
  setInterval(() => { if (Clip.marquee) requestPaint(); }, 120);
  /* charts refresh after recalc */
  setInterval(() => { if (Calc.dirty.size === 0) return; }, 5000);
  console.log('EmeraldSheets ready — sheets:', WB.sheets.length);
  /* minimal debug/QA surface (read-only introspection) */
  window.ZS = {
    historyLen: () => H.undo.length,
    redoLen: () => H.redo.length,
    historyLabels: () => H.undo.map(e => e.label || '?'),
    redoLabels: () => H.redo.map(e => e.label || '?'),
    stats: () => collectWorkbookStats(),
    auditState: () => ({ mode: Audit.mode, target: Audit.target, count: Audit.arrows.length, arrows: Audit.arrows.map(a => a.kind === 'xsheet' ? 'xsheet:' + a.dir + ':' + a.label : a.kind + (a.from ? ' from ' + a.from.r + ',' + a.from.c : '') + (a.to ? ' to ' + a.to.r + ',' + a.to.c : '') + (a.range ? ' rng ' + JSON.stringify(a.range) : '')) }),
    cell: (addr) => { try { const sh = activeSheet(); const p = parseAddr(addr); const m = sh.cells.get(key(p.r, p.c)); if (!m) return null; const cv = m.cv == null ? null : (typeof m.cv === 'object' ? (m.cv.err || m.cv.rows ? (m.cv.err || 'range/array') : 'obj') : m.cv); return { v: m.v, f: m.f, cv }; } catch (e) { return 'err:' + e.message; } },
    xy: (addr) => { try { const sh = activeSheet(); const p = parseAddr(addr); const x = colScreenX(sh, p.c) + colScreenW(sh, p.c) / 2; const y = rowScreenY(sh, p.r) + rowScreenH(sh, p.r) / 2; const cv = document.getElementById('grid-canvas').getBoundingClientRect(); return { x: Math.round(cv.left + x), y: Math.round(cv.top + y), corner: { x: Math.round(cv.left + colScreenX(sh, p.c) + colScreenW(sh, p.c) - 2), y: Math.round(cv.top + rowScreenY(sh, p.r) + rowScreenH(sh, p.r) - 2) } }; } catch (e) { return 'err:' + e.message; } },
    view: () => ({ zoom: VIEW.zoom, headings: VIEW.showHeadings, gridlines: activeSheet().showGridlines, scrollX: Scroll.x, scrollY: Scroll.y, sheet: activeSheet().name, cells: activeSheet().cells.size, notes: activeSheet().notes ? activeSheet().notes.size : -1 }),
    extent: () => { const sh = activeSheet(); return { rows: sh.rows.max, cols: sh.cols.max, totalRowPx: Math.round(sh.rows.total()), totalColPx: Math.round(sh.cols.total()), usedMax: Object.assign({}, sh.usedMax) }; },
    layout: () => R.layout ? { gridX: R.layout.gridX, gridY: R.layout.gridY, w: R.layout.w, h: R.layout.h, zoom: R.layout.zoom, frzR: R.layout.frzR, frzC: R.layout.frzC, scrollVisibleV: R.layout.scrollVisibleV } : null,
    repaint: () => { paint(); return 'painted'; },
    chartData: (idx) => { try { const ch = activeSheet().charts[idx]; return ch ? chartExtractData(ch) : null; } catch (e) { return 'err:' + e.message; } },
    notes: () => { const sh = activeSheet(); return sh.notes ? [...sh.notes.entries()].map(([k, n]) => ({ key: k, text: n.text })) : []; },
    bench: (rows) => {
      rows = Math.min(Math.max(rows || 10000, 100), 50000);
      const sh = activeSheet();
      const t0 = performance.now();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < 8; c++) sh.cells.set(key(r, c), { v: (r * 8 + c) % 977, f: null, s: null, cv: undefined, ast: undefined });
      }
      if (rows - 1 > sh.usedMax.r) sh.usedMax.r = rows - 1;
      if (7 > sh.usedMax.c) sh.usedMax.c = 7;
      growExtent(sh, rows, 8);
      sh.rows.invalidate();
      const t1 = performance.now();
      paint();
      const t2 = performance.now();
      const oy = Scroll.y;
      Scroll.y = Math.min(oy + 600, sh.rows.total());
      paint();
      Scroll.y = oy;
      paint();
      const t3 = performance.now();
      return { filledCells: rows * 8, fillMs: Math.round(t1 - t0), firstPaintMs: Math.round(t2 - t1), scrollRepaintMs: Math.round(t3 - t2) };
    },
    benchFormulas: (rows) => runFormulaBench(rows),
    benchClear: () => {
      const sh = activeSheet();
      const n = sh.cells.size;
      sh.cells.clear(); sh.rows.invalidate();
      paint();
      return { cleared: n };
    },
    chartInfo: (idx) => { try { const ch = activeSheet().charts[idx]; return ch ? { type: ch.type, range: ch.range, x: ch.x, y: ch.y, w: ch.w, h: ch.h, labels: !!ch.dataLabels, labelPos: ch.labelPos || 'out', labelFmt: ch.labelFmt || null, axisTitles: ch.axisTitles || null } : null; } catch (e) { return 'err:' + e.message; } },
    cfRules: () => { try { return activeSheet().cf.map(r => ({ type: r.type, range: addr(r.range.r1, r.range.c1) + ':' + addr(r.range.r2, r.range.c2), value: r.value, color: r.color })); } catch (e) { return 'err:' + e.message; } },
    printDry: () => { try { const html = buildPrintHtml(activeSheet()); return { len: html.length, charts: (html.match(/class="print-chart"/g) || []).length, hasWrap: html.indexOf('print-grid-wrap') !== -1 }; } catch (e) { return 'err:' + e.message; } },
    importBuffer: async (buf, name) => { try { await importXlsx(new File([buf], name || 'import.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); return ZS.stats(); } catch (e) { return 'err:' + e.message; } }
  };
}
document.addEventListener('DOMContentLoaded', () => { boot(); });
if (document.readyState !== 'loading') { try { boot(); } catch (e) { console.error(e); } }
})();

