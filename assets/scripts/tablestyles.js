

(function () {
  'use strict';

  var PRESETS = [
    { id: "none", name: "No Style, Table Grid", accent: "#8a8f98",
      kind: "grid", border: "#b6bac2", headerFill: null, headerInk: null,
      bandFill: null },
    { id: "grid-azure", name: "Grid Table — Azure", accent: "#4472c4",
      kind: "grid", border: "#9db2df", headerFill: "#4472c4",
      headerInk: "#ffffff", bandFill: "#e7edf8" },
    { id: "grid-teal", name: "Grid Table — Teal", accent: "#199a8e",
      kind: "grid", border: "#9ad6d1", headerFill: "#199a8e",
      headerInk: "#ffffff", bandFill: "#e3f4f2" },
    { id: "grid-violet", name: "Grid Table — Violet", accent: "#7c5cd6",
      kind: "grid", border: "#c3b5ec", headerFill: "#7c5cd6",
      headerInk: "#ffffff", bandFill: "#efeafb" },
    { id: "grid-rose", name: "Grid Table — Rose", accent: "#d9576a",
      kind: "grid", border: "#eeb3bc", headerFill: "#d9576a",
      headerInk: "#ffffff", bandFill: "#fbe9ec" },
    { id: "grid-amber", name: "Grid Table — Amber", accent: "#d9962b",
      kind: "grid", border: "#ecc896", headerFill: "#d9962b",
      headerInk: "#ffffff", bandFill: "#faf0dc" },
    { id: "grid-green", name: "Grid Table — Green", accent: "#4e9f50",
      kind: "grid", border: "#a9d3aa", headerFill: "#4e9f50",
      headerInk: "#ffffff", bandFill: "#e8f4e8" },
    { id: "grid-slate", name: "Grid Table — Slate", accent: "#5b6b7c",
      kind: "grid", border: "#b3bdc7", headerFill: "#5b6b7c",
      headerInk: "#ffffff", bandFill: "#eaeef2" },
    { id: "grid-carbon", name: "Grid Table — Carbon", accent: "#333a44",
      kind: "grid", border: "#a8adb6", headerFill: "#333a44",
      headerInk: "#ffffff", bandFill: "#eceef1" },
    { id: "lines-azure", name: "List Table — Azure", accent: "#4472c4",
      kind: "lines", border: "#9db2df", headerFill: "transparent",
      headerInk: "#37517e", bandFill: "#e7edf8" },
    { id: "lines-carbon", name: "List Table — Carbon", accent: "#333a44",
      kind: "lines", border: "#7d838d", headerFill: "transparent",
      headerInk: "#333a44", bandFill: "#eceef1" }
  ];

  var DEFAULT_OPTS = {
    header: true, total: false, bandedRows: true,
    bandedCols: false, firstCol: false, lastCol: false
  };

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return null;
  }

  function readDesign(table) {
    var d = { style: "none", opts: Object.assign({}, DEFAULT_OPTS), shade: {} };
    if (!table) return d;
    var style = table.getAttribute("data-table-style");
    if (style && presetById(style)) d.style = style;
    else if (style) d.style = "none";
    try {
      var raw = table.getAttribute("data-table-opts");
      if (raw) d.opts = Object.assign({}, DEFAULT_OPTS, JSON.parse(raw));
    } catch (e) {}
    try {
      var raw2 = table.getAttribute("data-table-shade");
      if (raw2) d.shade = JSON.parse(raw2) || {};
    } catch (e) {}
    return d;
  }

  function writeDesign(table, design) {
    if (!table) return;
    table.setAttribute("data-table-style", design.style);
    table.setAttribute("data-table-opts", JSON.stringify(design.opts));
    var shadeKeys = Object.keys(design.shade || {});
    if (shadeKeys.length) {
      table.setAttribute("data-table-shade", JSON.stringify(design.shade));
    } else {
      table.removeAttribute("data-table-shade");
    }
  }

  function shadeKeyOf(cell, rowIdx, cellIdx) {
    return "r" + rowIdx + "c" + cellIdx;
  }

  function rgbDist(a, b) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var dr = ((pa >> 16) & 255) - ((pb >> 16) & 255);
    var dg = ((pa >> 8) & 255) - ((pb >> 8) & 255);
    var db = (pa & 255) - (pb & 255);
    return dr * dr + dg * dg + db * db;
  }

  function presetForAccent(hex) {
    if (!hex || hex.charAt(0) !== "#") return presetById("none");
    var best = null, bestD = Infinity;
    for (var i = 1; i < PRESETS.length; i++) {
      var p = PRESETS[i];
      if (p.kind !== "grid") continue;
      var d = rgbDist(hex.toLowerCase(), p.accent);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best || presetById("grid-azure");
  }

  function applyDesign(table, design) {
    if (!table) return;
    var d = design || readDesign(table);
    var p = presetById(d.style) || PRESETS[0];
    var rows = table.rows;
    if (!rows || !rows.length) return;

    var thead = table.tHead;
    var headerRows = thead ? thead.rows.length :
      (d.opts.header ? 1 : 0);
    var hasV = p.kind !== "lines";
    var bodyStart = headerRows;

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var isHeader = r < headerRows;
      var bodyIndex = r - bodyStart;
      var isTotal = !isHeader && d.opts.total && r === rows.length - 1;
      var cells = row.cells;
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;
        var css = "";

        var bc = p.border;
        if (hasV) {
          css += "border-top:" + (r === 0 ? "1.5" : "1") + "px solid " + bc + ";";
          css += "border-bottom:" + (r === rows.length - 1 ? "1.5" : "1") + "px solid " + bc + ";";
          css += "border-left:" + bc + ";";
          css += "border-right:" + bc + ";";
        } else {

          css += "border-top:" + (isHeader ? "2" : "1") + "px solid " + bc + ";";
          css += "border-bottom:" + (r === rows.length - 1 && !isHeader ? "1.5" : "1") + "px solid " + bc + ";";
          css += "border-left:none;";
          css += "border-right:none;";
        }

        var fill = null, ink = null, weight = null;
        if (isHeader && p.headerFill && p.headerFill !== "transparent") {
          fill = p.headerFill;
          ink = p.headerInk;
          weight = "700";
        } else if (isHeader) {
          ink = p.kind === "lines" ? p.headerInk : null;
          weight = "700";
        } else {
          var band = false;
          if (d.opts.bandedRows && bodyIndex >= 0 && bodyIndex % 2 === 1) band = true;
          if (d.opts.bandedCols && c % 2 === 1) band = true;
          if (band && p.bandFill) fill = p.bandFill;
        }
        var manual = d.shade && d.shade[shadeKeyOf(cell, r, c)];
        if (manual === "") fill = null;
        else if (manual) { fill = manual; }

        if (d.opts.firstCol && !isHeader && c === 0) { weight = "600"; }
        if (d.opts.lastCol && !isHeader && c === cells.length - 1) { weight = "600"; }

        if (fill) css += "background-color:" + fill + ";";
        if (ink) css += "color:" + ink + ";";
        if (weight) css += "font-weight:" + weight + ";";

        if (isTotal) css += "border-top:2px double " + bc + ";";

        cell.setAttribute("style", mergeStyle(cell.getAttribute("style"), css));
      }
    }
    writeDesign(table, d);
  }

  var MANAGED_PROPS = /^(border-|background-color|color|font-weight)/;

  function mergeStyle(prev, next) {
    var keep = [];
    if (prev) {
      var parts = prev.split(/;\s*/);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] && !MANAGED_PROPS.test(parts[i])) keep.push(parts[i]);
      }
    }
    return (keep.length ? keep.join(";") + ";" : "") + next;
  }

  function shadeCells(table, cells, color) {
    if (!table || !cells || !cells.length) return 0;
    var d = readDesign(table);
    var n = 0;
    for (var r = 0; r < table.rows.length; r++) {
      var rowCells = table.rows[r].cells;
      for (var c = 0; c < rowCells.length; c++) {
        var cell = rowCells[c];
        if (cells.indexOf(cell) === -1) continue;
        var key = shadeKeyOf(cell, r, c);
        if (color) {
          d.shade[key] = color;
          cell.style.backgroundColor = color;
        } else {
          d.shade[key] = "";
          cell.style.backgroundColor = "";
        }
        n++;
      }
    }
    writeDesign(table, d);
    return n;
  }

  function keepShadeMap(table) {
    return readDesign(table).shade;
  }

  var POP_CSS =
    ".emts-pop{position:fixed;z-index:9000;background:rgba(255,255,255,.99);" +
    "border:1px solid rgba(0,0,0,.12);border-radius:14px;box-shadow:0 14px 38px rgba(0,0,0,.18);" +
    "padding:14px 14px 16px;width:560px;max-width:min(90vw,620px);max-height:460px;overflow-y:auto;" +
    "animation:emtsPopIn .16s ease;font-family:inherit;}" +
    "@keyframes emtsPopIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}" +
    ".emts-pop-header{font-size:11px;font-weight:600;color:rgb(133,138,147);text-transform:uppercase;" +
    "letter-spacing:.05em;padding:0 2px 10px;border-bottom:1px solid rgb(240,240,240);" +
    "margin-bottom:12px;user-select:none}" +
    ".emts-pop-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 12px}" +
    ".emts-pop-cell{background:transparent;border:none;padding:0;margin:0;cursor:pointer;" +
    "display:flex;flex-direction:column;gap:5px;font-family:inherit}" +
    ".emts-card{width:100%;aspect-ratio:16/9;box-sizing:border-box;display:flex;align-items:center;" +
    "justify-content:center;padding:10px;border-radius:6px;border:1px solid rgba(0,0,0,.08);" +
    "background:#fff;transition:border-color .18s,box-shadow .18s}" +
    ".emts-pop-cell:hover .emts-card{border-color:var(--ui-accent-border,rgba(16,185,129,.45));" +
    "box-shadow:rgba(0,0,0,.08) 0 2px 6px}" +
    ".emts-pop-cell.current .emts-card{border-color:var(--ui-accent,#10b981);" +
    "box-shadow:0 0 0 2px var(--ui-accent-soft,rgba(16,185,129,.18))}" +
    ".emts-card .td-style-thumb{border-collapse:collapse;table-layout:fixed;width:82%;" +
    "pointer-events:none;font-size:0}" +
    ".emts-card .td-style-thumb td{padding:0;height:12px;line-height:1;font-size:0}" +
    ".emts-name{font-size:10.5px;font-weight:500;color:rgb(75,85,99);text-align:center;" +
    "line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".emts-shade-head{font-size:11px;font-weight:600;color:rgb(133,138,147);text-transform:uppercase;" +
    "letter-spacing:.05em;padding:12px 2px 10px;border-top:1px solid rgb(240,240,240);" +
    "margin-top:14px;user-select:none}" +
    ".emts-shade-row{display:flex;gap:8px;margin-top:2px;align-items:center}" +
    ".emts-shade{width:22px;height:22px;border-radius:50%;border:1px solid rgba(0,0,0,.15);" +
    "cursor:pointer;flex-shrink:0;box-sizing:border-box;transition:transform .15s,box-shadow .15s}" +
    ".emts-shade:hover{transform:scale(1.12)}" +
    ".emts-shade.current{box-shadow:0 0 0 2px #fff,0 0 0 3.5px var(--ui-accent,#10b981)}" +
    ".emts-shade-none{background:linear-gradient(to bottom right,#fff 45%,#f00 45%,#f00 55%,#fff 55%)}";

  function ensurePopStyles() {
    if (document.getElementById("emts-pop-styles")) return;
    var st = document.createElement("style");
    st.id = "emts-pop-styles";
    st.textContent = POP_CSS;
    document.head.appendChild(st);
  }

  var _emtsPop = null;

  function closeDesignPopover() {
    if (_emtsPop) {
      var p = _emtsPop;
      _emtsPop = null;
      if (p.parentElement) p.parentElement.removeChild(p);
      document.removeEventListener("mousedown", _emtsPopOutside, true);
      window.removeEventListener("scroll", _emtsPopClose, true);
    }
  }

  function _emtsPopClose(e) {
    if (e && e.target && _emtsPop &&
      (e.target === _emtsPop || _emtsPop.contains(e.target))) return;
    closeDesignPopover();
  }
  function _emtsPopOutside(e) {
    if (_emtsPop && !_emtsPop.contains(e.target)) closeDesignPopover();
  }

  function openDesignPopover(opts) {
    if (!opts || !opts.table || !window.document) return;
    ensurePopStyles();
    closeDesignPopover();
    var d = readDesign(opts.table);
    var pop = document.createElement("div");
    pop.className = "emts-pop";
    var header = document.createElement("div");
    header.className = "emts-pop-header";
    header.textContent = "Table Styles";
    pop.appendChild(header);

    var grid = document.createElement("div");
    grid.className = "emts-pop-grid";
    PRESETS.forEach(function (p) {
      var cellW = document.createElement("div");
      cellW.className = "emts-pop-cell" + (p.id === d.style ? " current" : "");

      var card = document.createElement("div");
      card.className = "emts-card";
      var th = document.createElement("table");
      th.className = "td-style-thumb";
      for (var r = 0; r < 4; r++) {
        var tr = document.createElement("tr");
        for (var c = 0; c < 3; c++) {
          var td = document.createElement("td");
          td.textContent = "\u00a0";
          tr.appendChild(td);
        }
        if (r === 0) {
          var thead = th.createTHead();
          thead.appendChild(tr);
        } else {
          th.appendChild(tr);
        }
      }
      applyDesign(th, {
        style: p.id,
        opts: { header: true, total: false, bandedRows: true, bandedCols: false, firstCol: false, lastCol: false },
        shade: {}
      });
      card.appendChild(th);
      cellW.appendChild(card);

      var name = document.createElement("div");
      name.className = "emts-name";
      name.textContent = p.name.replace(" — ", " ");
      cellW.appendChild(name);
      cellW.addEventListener("click", function () {
        applyDesign(opts.table, Object.assign({}, d, { style: p.id }));
        closeDesignPopover();
        if (opts.onDone) opts.onDone();
      });
      grid.appendChild(cellW);
    });
    pop.appendChild(grid);

    var shadeHead = document.createElement("div");
    shadeHead.className = "emts-shade-head";
    shadeHead.textContent = "Shading";
    pop.appendChild(shadeHead);
    var shadeRow = document.createElement("div");
    shadeRow.className = "emts-shade-row";
    var swatches = ["", "#ffe3e3", "#ffe9c9", "#fff4c2", "#e2f6e3", "#dcf3f5", "#e3ecff", "#ece4fb", "#333a44"];

    var shadeRef = (opts.shadeTargets && opts.shadeTargets[0]) || allCellsOf(opts.table)[0] || null;
    var currentShade = null;
    if (shadeRef && d.shade) {
      var sk = shadeKeyOf(shadeRef, shadeRef.parentElement.rowIndex, shadeRef.cellIndex);
      if (Object.prototype.hasOwnProperty.call(d.shade, sk)) currentShade = d.shade[sk];
    }
    swatches.forEach(function (col) {
      var sw = document.createElement("div");
      sw.className = "emts-shade" + (col === "" ? " emts-shade-none" : "") +
        ((col || "") === (currentShade || "") && (currentShade !== null) ? " current" : "");
      if (col) sw.style.background = col;
      sw.title = col === "" ? "No Fill" : col;
      sw.addEventListener("click", function () {
        var targets = opts.shadeTargets && opts.shadeTargets.length ?
          opts.shadeTargets : allCellsOf(opts.table);
        shadeCells(opts.table, targets, col || null);
        closeDesignPopover();
        if (opts.onDone) opts.onDone();
      });
      shadeRow.appendChild(sw);
    });
    pop.appendChild(shadeRow);
    document.body.appendChild(pop);
    _emtsPop = pop;

    var r = opts.anchor.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    setTimeout(function () {
      document.addEventListener("mousedown", _emtsPopOutside, true);
      window.addEventListener("scroll", _emtsPopClose, true);
    }, 0);
  }

  function allCellsOf(table) {
    var out = [];
    for (var r = 0; r < table.rows.length; r++) {
      for (var c = 0; c < table.rows[r].cells.length; c++) out.push(table.rows[r].cells[c]);
    }
    return out;
  }

  function presetForWord(wordStyle, accentHex) {
    if (!wordStyle) return presetById("none");
    var id = String(wordStyle).toLowerCase();
    if (/listtable|lightlist/.test(id)) {
      var fallback = presetById("lines-azure");
      if (!accentHex || accentHex.charAt(0) !== "#") return fallback;

      var p = presetForAccent(accentHex);
      var twin = presetById(p.id.replace("grid-", "lines-"));
      return twin || fallback;
    }
    if (/gridtable|tablegrid|darklist|mediumlist|mediumshading/.test(id)) {
      return presetForAccent(accentHex || "#4472c4");
    }
    return null;
  }

  window.EMTableStyles = {
    PRESETS: PRESETS,
    DEFAULT_OPTS: DEFAULT_OPTS,
    presetById: presetById,
    presetForAccent: presetForAccent,
    presetForWord: presetForWord,
    readDesign: readDesign,
    writeDesign: writeDesign,
    applyDesign: applyDesign,
    shadeCells: shadeCells,
    shadeKeyOf: shadeKeyOf,
    openDesignPopover: openDesignPopover,
    closeDesignPopover: closeDesignPopover
  };
})();
