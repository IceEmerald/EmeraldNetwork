/* ============================================================
   EmeraldSuite TableKit — Word / Docs-like table interactions
   ============================================================
   A small shared layer that gives every EmeraldSuite rich-text
   editor Word-style table behaviour:

     • Column borders are drag-to-resize (blue hint line, live
       preview). Dragging an inner border redistributes width
       between the two touched columns; dragging the outer right
       border grows/shrinks the whole table — like Word's
       fixed-layout tables.
     • Row bottoms are drag-to-resize (row heights).
     • A grab handle above the top-left corner moves the whole
       table. Like a floating Word table, dragging it lifts the
       table out of the text flow and lets it be placed anywhere
       on the paper (including over the page margins), clamped to
       the paper bounds. Double-click the handle to put it back
       into the text flow.
     • Clicking the grab handle selects the whole table
       (fade tint + persistent handles, Word-style).
     • The bottom-right corner handle scales every column
       proportionally (whole-table resize).

   All chrome lives in an absolutely-positioned OVERLAY appended
   to <body>. The document DOM never receives kit nodes, so every
   app's saved innerHTML stays clean — only real user sizing
   (px width/height styles on cells) persists, which is content,
   not editor UI.
   ============================================================ */

(function () {
  'use strict';

  /* ---------------- tunables ---------------- */
  var EDGE = 7;              // px proximity to a border that activates it
  var CLICK_TOL = 4;         // px of pointer travel still counted as a click
  var MIN_COL = 32;          // default min column width (outer px)
  var MIN_ROW = 24;          // default min row height (outer px)
  var GRIP_SVG =
    '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
    '<circle cx="2" cy="2" r="1.15"/><circle cx="5" cy="2" r="1.15"/><circle cx="8" cy="2" r="1.15"/>' +
    '<circle cx="2" cy="5" r="1.15"/><circle cx="5" cy="5" r="1.15"/><circle cx="8" cy="5" r="1.15"/>' +
    '<circle cx="2" cy="8" r="1.15"/><circle cx="5" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/>' +
    '</svg>';

  /* ---------------- helpers ---------------- */
  function docRect(el) {
    var r = el.getBoundingClientRect();
    return {
      left: r.left + window.pageXOffset,
      top: r.top + window.pageYOffset,
      width: r.width,
      height: r.height
    };
  }

  function px(v) { return Math.round(v) + 'px'; }

  /* Docs zooms pages with a CSS transform; rect/offset gives the zoom. */
  function zoomOf(table) {
    var r = table.getBoundingClientRect();
    return (r.width / Math.max(1, table.offsetWidth)) || 1;
  }

  /* Available CONTENT width of the block the table lives in — the hard cap
     for whole-table and outer-border resizing (prevents the table from
     being dragged wider than the page and getting cropped). */
  function contentWidthOf(table) {
    var p = table.parentElement;
    if (!p) return Infinity;
    var cs = window.getComputedStyle(p);
    /* A floating table may use the whole paper (including the page's
       padding/margins), not just the text column — but it still cannot
       grow past the paper's right edge from wherever it currently sits. */
    if (isFloating(table)) {
      var paper = table.closest && table.closest('.page');
      var host = paper || p;
      var zoom = zoomOf(table) || 1;
      var hr = host.getBoundingClientRect();
      var tr = table.getBoundingClientRect();
      /* distance from the table's left edge to the paper's right edge */
      var room = (hr.left + host.clientLeft + host.clientWidth - tr.left) / zoom - 10;
      return Math.max(64, room);
    }
    var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    /* leave a small safety margin so the table never kisses the right edge
       and gets clipped by the page/scroll container */
    return Math.max(64, p.clientWidth - pad - 10);
  }

  /* Cells are content-box by default: style.width excludes padding+
     borders, so convert outer px ↦ content px before assigning. */
  function outerDelta(cell, dimension) {
    var cs = window.getComputedStyle(cell);
    var prop = dimension === 'w' ? 'width' : 'height';
    var off = dimension === 'w' ? cell.offsetWidth : cell.offsetHeight;
    return off - (parseFloat(cs[prop]) || 0);
  }
  function setOuterWidth(cell, w) {
    w = Math.max(8, w);
    cell.style.width = px(w - outerDelta(cell, 'w'));
  }
  function setOuterHeight(cell, h) {
    h = Math.max(6, h);
    cell.style.height = px(h - outerDelta(cell, 'h'));
  }

  /* First-row column map, colSpan-aware: each entry owns the visual
     columns in [start, start + span). */
  function columnsOf(table) {
    var first = table.rows && table.rows[0];
    if (!first) return [];
    var out = [], col = 0;
    for (var i = 0; i < first.cells.length; i++) {
      var span = Math.max(1, first.cells[i].colSpan || 1);
      out.push({ cell: first.cells[i], start: col, span: span });
      col += span;
    }
    return out;
  }

  function entryAt(entries, visualCol) {
    for (var i = 0; i < entries.length; i++) {
      if (visualCol >= entries[i].start && visualCol < entries[i].start + entries[i].span) {
        return entries[i];
      }
    }
    return null;
  }

  /* Switch an auto-layout table to Word-style fixed layout with px
     widths, based on what is rendered right now. Idempotent. */
  function ensureFixed(table) {
    if (table.style.tableLayout === 'fixed' && /^\d+px$/.test(table.style.width || '')) return;
    var entries = columnsOf(table);
    var total = table.offsetWidth;
    for (var i = 0; i < entries.length; i++) {
      setOuterWidth(entries[i].cell, entries[i].cell.offsetWidth);
    }
    table.style.tableLayout = 'fixed';
    table.style.width = px(total);
  }

  function el(cls, html) {
    var d = document.createElement('div');
    d.className = 'emtk-' + cls;
    if (html) d.innerHTML = html;
    return d;
  }

  /* A table is "floating" once its position is absolute. We detect the
     inline style (not a data attribute) so it survives every app's
     sanitizer and storage round-trip. */
  function isFloating(table) {
    return !!(table && table.style && table.style.position === 'absolute');
  }

  /* The box an absolutely-positioned table will be laid out against. */
  function containingBlockOf(node) {
    var p = node.parentElement;
    while (p && p !== document.documentElement) {
      var cs = window.getComputedStyle(p);
      if (cs.position !== 'static' || cs.transform !== 'none' ||
          cs.perspective !== 'none' || cs.filter !== 'none') {
        return p;
      }
      p = p.parentElement;
    }
    return document.body;
  }

  /* ---------------- the kit ---------------- */
  function Kit(opts) {
    opts = opts || {};
    this.root = typeof opts.root === 'string' ? document.getElementById(opts.root) : opts.root;
    if (!this.root || this.root.dataset.emtkBound) return;
    this.root.dataset.emtkBound = '1';

    this.onChange = opts.onChange || null;
    this.onSync = opts.onSync || null;
    this.onEngaged = opts.onEngaged || null;
    this.isEditable = opts.isEditable || null;
    this.minCol = opts.minColWidth || MIN_COL;
    this.minRow = opts.minRowHeight || MIN_ROW;

    this.table = null;
    this.selected = false;
    /* focus state: a table is "engaged" while the caret lives inside it —
       handles stay visible without hovering (add/delete row-col lives in
       each app's floating toolbar, not here) */
    this.focused = null;
    this.hover = null;
    this.drag = null;
    this._lastCur = '';

    this._buildOverlay();
    this._bind();
  }

  Kit.prototype._buildOverlay = function () {
    var ov = document.createElement('div');
    ov.className = 'emtk-overlay';
    ov.hidden = true;
    this.$tint = el('tint');
    this.$hoverV = el('line line-v');
    this.$hoverH = el('line line-h');
    this.$grab = el('grab', GRIP_SVG);
    this.$corner = el('corner', '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 10 L10 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M6 10 L10 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>');
    ov.appendChild(this.$tint);
    ov.appendChild(this.$hoverV);
    ov.appendChild(this.$hoverH);
    ov.appendChild(this.$grab);
    ov.appendChild(this.$corner);
    document.body.appendChild(ov);
    this.$ov = ov;
  };

  Kit.prototype._bind = function () {
    var self = this, root = this.root;

    /* hover targeting — at WINDOW level so the body-level handle chrome
       can't keep itself alive while the pointer is over the outline/outside
       of the table (the overlay is NOT inside the editor root, so a
       root-level listener never sees events over the handles). */
    window.addEventListener('pointermove', function (e) {
      if (self.drag) return;
      if (self.$ov.contains(e.target)) return;   // pointer is on a handle
      var t = e.target && e.target.closest && e.target.closest('table');
      if (!t || !root.contains(t)) {
        /* Just outside the current table's edge? Keep targeting it so the
           outer border is resizable from anywhere, not only once focused. */
        var near = self.table;
        if (near && near.isConnected && root.contains(near) && self._editable(near)) {
          var nr = near.getBoundingClientRect();
          if (e.clientX >= nr.left - EDGE && e.clientX <= nr.right + EDGE &&
              e.clientY >= nr.top - EDGE && e.clientY <= nr.bottom + EDGE) {
            self._setHover(self._hitTest(near, e.clientX, e.clientY));
            self._sync();
            return;
          }
        }
        if (!self.selected && !self.focused) { self.table = null; self._hide(); }
        else { self._setHover(null); self._sync(); }
        return;
      }
      if (!self._editable(t)) { self._setHover(null); self._hide(); return; }
      if (self.table !== t) { self.table = t; self.selected = false; }
      self._setHover(self._hitTest(t, e.clientX, e.clientY));
      self._sync();
    }, true);

    /* pointer leaves the document entirely: drop hover-only chrome */
    document.addEventListener('pointerout', function (e) {
      if (e.relatedTarget) return;               // still inside the window
      if (self.drag) return;
      if (!self.selected && !self.focused) { self.table = null; self._hide(); }
    });

    /* border drags start from the table/cell area or a few px outside its
       edge (the handle elements live in the body overlay and hook
       themselves) */
    root.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      var target = e.target;
      var cell = target && target.closest && target.closest('td, th');
      var t = target && target.closest && target.closest('table');
      /* The pointer can land on the table's own outer border (outside any
         cell) or a few px beyond its edge — still target the current table
         so its outer borders are draggable from anywhere. */
      if ((!t || !root.contains(t)) && self.table) {
        var nr = self.table.getBoundingClientRect();
        if (e.clientX >= nr.left - EDGE && e.clientX <= nr.right + EDGE &&
            e.clientY >= nr.top - EDGE && e.clientY <= nr.bottom + EDGE) {
          t = self.table;
          cell = null;
        }
      }
      if (t && root.contains(t) && self._editable(t)) {
        if (self.table !== t) { self.table = t; self.selected = false; }
        if (cell && t.contains(cell)) {
          /* a click inside a cell ENGAGES the table: handles stay visible */
          self.focused = t;
          /* _sync() notifies apps (onEngaged) that engagement changed — the
             ribbon must pop on the click itself, not on the next
             pointermove's unrelated hover _sync(). */
          self._sync();
        }
        self._setHover(self._hitTest(t, e.clientX, e.clientY));
        if (self.hover) {
          self._beginBorderDrag(e);
          return;
        }
        if (cell && t.contains(cell)) {
          if (self.selected) {
            /* clicked into the table body: Word clears the selection here */
            self.selected = false;
            self._sync();
          }
          return;
        }
        /* landed on the table's edge without a resize line: nothing to do */
        return;
      }
      /* pointer landed elsewhere: drop the Word-style selection AND the
         table's engaged (focused) state */
      if (self.selected && self.table && !self.table.contains(e.target)) self._deselect();
      if (self.focused) {
        self.focused = null;
        self._sync();
      }
    }, true);

    /* keep the engaged pill set in step with caret movement (typing,
       Tab navigation, click-to-focus …) */
    document.addEventListener('selectionchange', function () {
      self._updateFocusFromSelection();
    });

    /* grab handle: click = select table, drag = float/move it */
    this.$grab.addEventListener('pointerdown', function (e) {
      if (!self.table || !self._editable(self.table)) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
      self._beginGrab(e);
    });
    /* corner handle: proportional whole-table resize */
    this.$corner.addEventListener('pointerdown', function (e) {
      if (!self.table || !self._editable(self.table)) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
      self._beginCorner(e);
    });

    /* keep chrome glued to the table while the document mutates */
    if (window.MutationObserver) {
      var pending = false;
      var mo = new MutationObserver(function () {
        if (pending || self.drag) return;
        pending = true;
        window.requestAnimationFrame(function () {
          pending = false;
          self._tableMaybeGone();
          if (self.table) self._sync();
          if (self.root.querySelector('.emtk-has-float') ||
              self.root.querySelector('table[style*="absolute"]')) {
            self._refreshFloatHosts();
          }
        });
      });
      mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    window.addEventListener('resize', function () {
      self._tableMaybeGone();
      if (self.table) self._sync();
    });
    /* inner scroll containers don't bubble their scroll — capture the rest */
    var scrollQueued = false;
    var onScroll = function () {
      if (scrollQueued || !self.table || self.$ov.hidden) return;
      scrollQueued = true;
      window.requestAnimationFrame(function () {
        scrollQueued = false;
        if (self.table) self._sync();
      });
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (self.selected || self.focused)) {
        self._deselect();
        self.focused = null;
        self._sync();
      }
    });

    /* re-attach the overflow flag for tables loaded from storage */
    this._refreshFloatHosts();
  };

  Kit.prototype._tableMaybeGone = function () {
    if (this.table && !this.root.contains(this.table)) {
      this.table = null;
      this.selected = false;
      this._setHover(null);
      this._hide();
    }
  };

  /* Mark every containing block that holds a floating table so the app's
     CSS can stop clipping it at the text column (the paper still clips). */
  Kit.prototype._refreshFloatHosts = function () {
    var hosts = this.root.querySelectorAll('.emtk-has-float');
    for (var i = 0; i < hosts.length; i++) hosts[i].classList.remove('emtk-has-float');
    var tables = this.root.querySelectorAll('table');
    for (var j = 0; j < tables.length; j++) {
      if (isFloating(tables[j]) && tables[j].parentElement) {
        var host = (tables[j].closest && tables[j].closest('.page-content')) ||
          tables[j].parentElement;
        host.classList.add('emtk-has-float');
      }
    }
  };

  Kit.prototype._editable = function (table) {
    if (!table || !this.root.contains(table)) return false;
    var host = table.closest && table.closest('[contenteditable="true"]');
    if (!host) return false;
    if (typeof this.isEditable === 'function') return !!this.isEditable(table, host);
    return true;
  };

  /* The table the caret currently lives inside stays engaged. */
  /* The table the caret currently lives inside is "engaged", as is a
     table the user selected (grab handle). Apps use this to drive their
     contextual table chrome (e.g. the Docs Table Design ribbon tab). */
  Kit.prototype.engagedTable = function () {
    var t = this.focused || (this.selected ? this.table : null);
    return (t && t.isConnected) ? t : null;
  };

  Kit.prototype._updateFocusFromSelection = function () {
    if (this.drag) return;
    var t = null;
    var insideRoot = false;
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var node = sel.anchorNode;
      var eln = node && (node.nodeType === 1 ? node : node.parentElement);
      if (eln && this.root.contains(eln)) {
        insideRoot = true;
        var cell = eln.closest ? eln.closest('td, th') : null;
        if (cell) {
          t = cell.closest('table');
          if (!t || !this.root.contains(t) || !this._editable(t)) t = null;
        }
      }
    }
    /* A selection that has left the editor entirely came from clicking app
       chrome (a ribbon button, the floating toolbar, a dropdown, a modal) —
       not from moving the caret. Word keeps the table engaged in that case,
       so its contextual tab doesn't collapse under the user's pointer. Only
       a caret move INSIDE the document can end engagement. */
    if (!insideRoot) return;
    var changed = this.focused !== t;
    this.focused = t;
    if (t && this.table !== t) this.table = t;
    if (changed && this.table) this._sync();
  };

  /* ------------ hit testing ------------ */
  Kit.prototype._hitTest = function (table, cx, cy) {
    var entries = columnsOf(table);
    if (!entries.length) return null;
    var best = null;

    /* vertical borders: right edges of first-row cells */
    var first = table.rows[0];
    for (var i = 0; i < first.cells.length; i++) {
      var entry = entries[i];
      var cr = first.cells[i].getBoundingClientRect();
      var d = Math.abs(cx - cr.right);
      if (d > EDGE) continue;
      var half = entry.start + entry.span - 1;
      var left = entryAt(entries, half);
      var right = entryAt(entries, entry.start + entry.span);
      if (left === right) continue;           // border inside a colSpan cell
      var isLast = entry.start + entry.span === entries[entries.length - 1].start + entries[entries.length - 1].span;
      if (!best || d < best.d) {
        best = {
          type: 'col', d: d, x: cr.right,
          left: left, right: right, edge: isLast,
          cellTop: cr.top, cellBottom: cr.bottom
        };
      }
    }

    /* horizontal borders: row bottoms */
    var rows = table.rows;
    for (var r = 0; r < rows.length; r++) {
      var rr = rows[r].getBoundingClientRect();
      var dy = Math.abs(cy - rr.bottom);
      if (dy > EDGE) continue;
      if (!best || dy < best.d) {
        best = { type: 'row', d: dy, y: rr.bottom, row: rows[r], rowIdx: r };
      }
    }
    return best;
  };

  Kit.prototype._setHover = function (h) {
    /* resize affordances appear on ANY editable table under the pointer —
       the table does not have to be clicked/focused first. The grab and
       corner handles still stay tied to the engaged (selected/focused)
       state; only the border hints/cursor are hover-driven. */
    var cur = '';
    if (h && h.type === 'col') cur = 'col-resize';
    else if (h && h.type === 'row') cur = 'row-resize';
    if (cur !== this._lastCur) {
      this._lastCur = cur;
      this.root.style.cursor = cur;
    }
    /* identity: the border moved position, not just type */
    var changed;
    if (this.hover && h) {
      changed = this.hover.type !== h.type ||
        Math.round(this.hover.x || -1e9) !== Math.round(h.x || -1e9) ||
        Math.round(this.hover.y || -1e9) !== Math.round(h.y || -1e9);
    } else {
      changed = !!this.hover || !!h;
    }
    this.hover = h;
    if (this.table && changed) this._sync();
  };

  /* ------------ overlay placement ------------ */
  Kit.prototype._sync = function () {
    var t = this.table;
    if (this.onEngaged) {
      var eng = (t && t.isConnected && (this.selected || this.focused ||
        (this.drag && (this.drag.mode === 'grab' || this.drag.mode === 'corner')))) ? t : null;
      if (eng !== this._engagedNotified) {
        this._engagedNotified = eng;
        try { this.onEngaged(eng); } catch (e) {}
      }
    }
    if (!t || !t.isConnected || !(this.hover || this.selected || this.focused || this.drag)) {
      if (this.onSync) this.onSync(null);
      this.$ov.hidden = true;
      return;
    }
    var vp = t.getBoundingClientRect();
    var rect = docRect(t);
    var zoom = zoomOf(t);
    var ov = this.$ov;
    ov.hidden = false;
    /* fixed-position chrome: viewport coords (already zoom-aware) */
    ov.style.left = px(vp.left);
    ov.style.top = px(vp.top);
    ov.style.setProperty('--emtk-s', zoom);
    ov.style.width = px(rect.width / zoom);
    ov.style.height = px(rect.height / zoom);

    /* selection tint + persistent handles when the table is selected */
    this.$tint.style.display = this.selected ? '' : 'none';

    /* grab / corner handles only appear once the table is engaged
       (selected, caret inside it, or actively being moved/scaled) — never
       on a mere hover, so they can't clutter a table the user is just
       passing over. Border resize hints/cursor remain hover-driven. */
    var engaged = this.selected || this.focused ||
      (this.drag && (this.drag.mode === 'grab' || this.drag.mode === 'corner'));
    this.$grab.style.left = px(-24);
    this.$grab.style.top = px(0);
    this.$grab.style.display = engaged ? '' : 'none';
    this.$corner.style.right = px(-22);
    this.$corner.style.bottom = px(-22);
    this.$corner.style.display = engaged && this._editable(t) ? '' : 'none';
    if (this.onSync) this.onSync(t);

    var hv = this.$hoverV, hh = this.$hoverH;
    if (!this.drag && this.hover && this.hover.type === 'col') {
      hv.style.display = '';
      hv.style.left = px((this.hover.x - vp.left) / zoom - 1);
      hv.style.top = px(0);
      hv.style.height = px(vp.height / zoom);
      hv.style.width = '';
    } else {
      hv.style.display = 'none';
    }
    if (!this.drag && this.hover && this.hover.type === 'row') {
      hh.style.display = '';
      hh.style.top = px((this.hover.y - vp.top) / zoom - 1);
      hh.style.left = px(0);
      hh.style.width = px(vp.width / zoom);
      hh.style.height = '';
    } else {
      hh.style.display = 'none';
    }
  };

  Kit.prototype._deselect = function () {
    this.selected = false;
    this._sync();
    if (!this.hover) this._hide();
  };

  Kit.prototype._hide = function () {
    this.$ov.hidden = true;
    if (this.onSync) this.onSync(null);
    this._setHover(null);
  };

  /* ------------ border drags (column / row) ------------ */
  Kit.prototype._beginBorderDrag = function (e) {
    var h = this.hover;
    if (!h) return;
    var t = this.table;
    e.preventDefault();
    e.stopPropagation();
    ensureFixed(t);
    var zoom = zoomOf(t);
    var d = { zoom: zoom, startX: e.clientX, startY: e.clientY };

    if (h.type === 'col') {
      d.mode = 'col';
      d.edge = h.edge;
      d.left = h.left;
      d.right = h.edge ? null : h.right;
      d.leftW = h.left.cell.offsetWidth;
      d.rightW = h.right ? h.right.cell.offsetWidth : 0;
      d.totalW = t.offsetWidth;
      d.maxW = contentWidthOf(t);   // outer-border drags can't exceed the page
    } else {
      d.mode = 'row';
      d.row = h.row;
      d.h = h.row.offsetHeight;
    }

    this.drag = d;
    this._setHover(null);          // clears hover line + previous cursor
    this.root.style.cursor = d.mode === 'col' ? 'col-resize' : 'row-resize';
    this._sync();
    document.body.style.userSelect = 'none';
    this._hookWindow(this._onBorderMove.bind(this), this._onDragUp.bind(this));
  };

  Kit.prototype._onBorderMove = function (e) {
    var d = this.drag, t = this.table;
    if (!d) return;
    if (d.mode === 'col') {
      var dx = (e.clientX - d.startX) / d.zoom;
      if (d.edge) {
        /* outer right border: last column + whole table width, clamped to
           the content area so it can never get cropped by the page */
        var minDx = -Math.max(0, d.leftW - this.minCol);   // last col >= min
        if (dx < minDx) dx = minDx;
        if (dx > d.maxW - d.totalW) dx = d.maxW - d.totalW;
        setOuterWidth(d.left.cell, d.leftW + dx);
        t.style.width = px(d.totalW + dx);
      } else {
        var span = d.leftW + d.rightW;
        var lw = d.leftW + dx;
        var rw = d.rightW - dx;
        if (lw < this.minCol) { lw = this.minCol; rw = span - lw; }
        if (rw < this.minCol) { rw = this.minCol; lw = span - rw; }
        setOuterWidth(d.left.cell, lw);
        setOuterWidth(d.right.cell, rw);
      }
    } else {
      var dy = (e.clientY - d.startY) / d.zoom;
      var h = Math.max(this.minRow, d.h + dy);
      var cells = d.row.cells;
      for (var i = 0; i < cells.length; i++) setOuterHeight(cells[i], h);
    }
    this._sync();
  };

  Kit.prototype._onDragUp = function () {
    var mode = this.drag && this.drag.mode;
    this.drag = null;
    document.body.style.userSelect = '';
    this.root.style.cursor = '';
    this._lastCur = '';
    this._setHover(null);
    this._unhookWindow();
    this._sync();
    this._emit(mode === 'corner' ? 'scale' : mode === 'row' ? 'rowresize' : 'colresize');
  };

  /* ------------ corner: proportional scale ------------ */
  Kit.prototype._beginCorner = function (e) {
    var t = this.table;
    ensureFixed(t);
    var entries = columnsOf(t);
    var cols = [];
    for (var i = 0; i < entries.length; i++) {
      cols.push({ cell: entries[i].cell, w: entries[i].cell.offsetWidth });
    }
    this.drag = {
      mode: 'corner',
      zoom: zoomOf(t),
      cols: cols,
      baseW: t.offsetWidth,
      maxW: contentWidthOf(t),      // hard cap: content-box width of the block
      startX: e.clientX,
      startY: e.clientY
    };
    this.root.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
    this._hookWindow(this._onCornerMove.bind(this), this._onDragUp.bind(this));
  };

  Kit.prototype._onCornerMove = function (e) {
    var d = this.drag, t = this.table;
    if (!d) return;
    var dx = (e.clientX - d.startX) / d.zoom;
    var f = d.baseW > 0 ? (d.baseW + dx) / d.baseW : 1;
    /* never let any column get smaller than the minimum */
    for (var i = 0; i < d.cols.length; i++) {
      var need = this.minCol / Math.max(1, d.cols[i].w);
      if (need > f) f = need;
    }
    /* and never wider than the page content area — no overshoot */
    var cap = d.maxW;
    if (d.baseW * f > cap) f = cap / d.baseW;
    for (var k = 0; k < d.cols.length; k++) setOuterWidth(d.cols[k].cell, d.cols[k].w * f);
    t.style.width = px(d.baseW * f);
    this._sync();
  };

  /* ------------ grab handle: select + float/move ------------ */

  /* Convert the table to a floating (absolute) box without it visibly
     jumping, and return the geometry the drag needs. */
  Kit.prototype._detach = function (t) {
    ensureFixed(t);
    var zoom = zoomOf(t);
    var cb = containingBlockOf(t);
    var cr = cb.getBoundingClientRect();
    var tr = t.getBoundingClientRect();
    var left = (tr.left - cr.left - cb.clientLeft) / zoom + cb.scrollLeft;
    var top = (tr.top - cr.top - cb.clientTop) / zoom + cb.scrollTop;

    if (!t.__emtkPrev) {
      t.__emtkPrev = {
        position: t.style.position,
        left: t.style.left,
        top: t.style.top,
        margin: t.style.margin,
        zIndex: t.style.zIndex,
        maxWidth: t.style.maxWidth
      };
    }
    t.style.position = 'absolute';
    t.style.left = px(left);
    t.style.top = px(top);
    t.style.margin = '0';
    t.style.zIndex = '5';
    t.style.maxWidth = 'none';
    if (!/\d/.test(t.style.width || '')) t.style.width = px(t.offsetWidth);

    var host = (t.closest && t.closest('.page-content')) || cb;
    host.classList.add('emtk-has-float');
    return {
      cb: cb,
      zoom: zoom,
      left: left,
      top: top,
      w: t.offsetWidth,
      h: t.offsetHeight
    };
  };

  /* The paper bounds (in the containing block's coordinate space) a floating
     table must stay inside. In Docs that is the whole .page sheet, so the
     table can sit over the page margins — right up to the very top — but
     never outside the paper. In apps without paper pages it is the editor. */
  Kit.prototype._paperBounds = function (t, cb, zoom) {
    var paper = t.closest && t.closest('.page');
    if (paper && paper !== cb) {
      var pr = paper.getBoundingClientRect();
      var cr = cb.getBoundingClientRect();
      var left = (pr.left - cr.left - cb.clientLeft) / zoom + cb.scrollLeft;
      var top = (pr.top - cr.top - cb.clientTop) / zoom + cb.scrollTop;
      return {
        left: left,
        top: top,
        right: left + pr.width / zoom,
        bottom: top + pr.height / zoom
      };
    }
    /* no sheet: the editor itself is the paper — its full padding box */
    return {
      left: 0,
      top: 0,
      right: cb.clientWidth,
      bottom: Infinity
    };
  };

  Kit.prototype._beginGrab = function (e) {
    this.drag = {
      mode: 'grab',
      startX: e.clientX,
      startY: e.clientY,
      moved: false
    };
    this._hookWindow(this._onGrabMove.bind(this), this._onGrabUp.bind(this));
  };

  Kit.prototype._onGrabMove = function (e) {
    var d = this.drag, t = this.table;
    if (!d || !t) return;

    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) <= CLICK_TOL &&
          Math.abs(e.clientY - d.startY) <= CLICK_TOL) return;
      d.moved = true;
      document.body.style.userSelect = 'none';

      if (!isFloating(t)) {
        var info = this._detach(t);
        d.cb = info.cb;
        d.zoom = info.zoom;
        d.baseLeft = info.left;
        d.baseTop = info.top;
        d.w = info.w;
        d.h = info.h;
      } else {
        d.cb = containingBlockOf(t);
        d.zoom = zoomOf(t);
        d.baseLeft = parseFloat(t.style.left) || 0;
        d.baseTop = parseFloat(t.style.top) || 0;
        d.w = t.offsetWidth;
        d.h = t.offsetHeight;
      }
    }

    var dx = (e.clientX - d.startX) / d.zoom;
    var dy = (e.clientY - d.startY) / d.zoom;
    var left = d.baseLeft + dx;
    var top = d.baseTop + dy;

    var b = this._paperBounds(t, d.cb, d.zoom);
    var maxLeft = b.right - d.w;
    var maxTop = b.bottom - d.h;
    if (maxLeft < b.left) maxLeft = b.left;
    if (maxTop < b.top) maxTop = b.top;
    if (left < b.left) left = b.left;
    else if (left > maxLeft) left = maxLeft;
    if (top < b.top) top = b.top;
    else if (top > maxTop) top = maxTop;

    t.style.left = px(left);
    t.style.top = px(top);
    this._sync();
  };

  Kit.prototype._onGrabUp = function () {
    var d = this.drag;
    this._unhookWindow();
    this.drag = null;
    document.body.style.userSelect = '';

    if (!d) return;
    if (!d.moved) {
      var t = this.table;
      var now = Date.now();
      var isDouble = this._lastGrab && this._lastGrab.table === t &&
        (now - this._lastGrab.time) < 350;
      this._lastGrab = { table: t, time: now };
      /* double-click the grab handle: drop a floating table back into flow */
      if (isDouble && t && isFloating(t)) {
        this._unfloat(t);
        return;
      }
      /* plain click on the grab handle: select the whole table */
      if (t && this._editable(t)) {
        try {
          var rng = document.createRange();
          rng.selectNode(t);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(rng);
        } catch (err) { /* selection is a bonus, never fatal */ }
        this.selected = true;
        this._sync();
      }
      return;
    }
    /* keep the table engaged after a move so its handles stay put */
    this.selected = true;
    this._sync();
    this._emit('move');
  };

  /* Double-click escape hatch: drop a floating table back into the text
     flow at its original document position. */
  Kit.prototype._unfloat = function (t) {
    if (!t || !isFloating(t)) return false;
    var prev = t.__emtkPrev || {};
    t.style.position = prev.position || '';
    t.style.left = prev.left || '';
    t.style.top = prev.top || '';
    t.style.margin = prev.margin || '';
    t.style.zIndex = prev.zIndex || '';
    t.style.maxWidth = prev.maxWidth || '';
    delete t.__emtkPrev;
    this._refreshFloatHosts();
    this.selected = true;
    this._sync();
    this._emit('move');
    return true;
  };

  /* ------------ persistence hook ------------ */
  Kit.prototype._emit = function (type) {
    if (typeof this.onChange === 'function' && this.table) {
      this.onChange({ kit: 'emtablekit', type: type, table: this.table });
    }
  };

  /* ------------ window hook helpers ------------ */
  Kit.prototype._hookWindow = function (onMove, onUp) {
    this._wMove = onMove;
    this._wUp = onUp;
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  Kit.prototype._unhookWindow = function () {
    if (this._wMove) window.removeEventListener('pointermove', this._wMove);
    if (this._wUp) {
      window.removeEventListener('pointerup', this._wUp);
      window.removeEventListener('pointercancel', this._wUp);
    }
    this._wMove = this._wUp = null;
  };

  window.EMTableKit = {
    attach: function (opts) { return new Kit(opts); }
  };
})();
