

(function () {
  'use strict';

  var EDGE = 7;
  var CLICK_TOL = 4;
  var MIN_COL = 32;
  var MIN_ROW = 24;
  var GRIP_SVG =
    '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
    '<circle cx="2" cy="2" r="1.15"/><circle cx="5" cy="2" r="1.15"/><circle cx="8" cy="2" r="1.15"/>' +
    '<circle cx="2" cy="5" r="1.15"/><circle cx="5" cy="5" r="1.15"/><circle cx="8" cy="5" r="1.15"/>' +
    '<circle cx="2" cy="8" r="1.15"/><circle cx="5" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/>' +
    '</svg>';

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

  function zoomOf(table) {
    var r = table.getBoundingClientRect();
    return (r.width / Math.max(1, table.offsetWidth)) || 1;
  }

  function contentWidthOf(table) {
    var p = table.parentElement;
    if (!p) return Infinity;
    var cs = window.getComputedStyle(p);

    if (isFloating(table)) {
      var paper = table.closest && table.closest('.page');
      var host = paper || p;
      var zoom = zoomOf(table) || 1;
      var hr = host.getBoundingClientRect();
      var tr = table.getBoundingClientRect();

      var room = (hr.left + host.clientLeft + host.clientWidth - tr.left) / zoom - 10;
      return Math.max(64, room);
    }
    var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);

    return Math.max(64, p.clientWidth - pad - 10);
  }

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

  function isFloating(table) {
    return !!(table && table.style && table.style.position === 'absolute');
  }

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

    window.addEventListener('pointermove', function (e) {
      if (self.drag) return;
      if (self.$ov.contains(e.target)) return;
      var t = e.target && e.target.closest && e.target.closest('table');
      if (!t || !root.contains(t)) {

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

    document.addEventListener('pointerout', function (e) {
      if (e.relatedTarget) return;
      if (self.drag) return;
      if (!self.selected && !self.focused) { self.table = null; self._hide(); }
    });

    root.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      var target = e.target;
      var cell = target && target.closest && target.closest('td, th');
      var t = target && target.closest && target.closest('table');

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

          self.focused = t;

          self._sync();
        }
        self._setHover(self._hitTest(t, e.clientX, e.clientY));
        if (self.hover) {
          self._beginBorderDrag(e);
          return;
        }
        if (cell && t.contains(cell)) {
          if (self.selected) {

            self.selected = false;
            self._sync();
          }
          return;
        }

        return;
      }

      if (self.selected && self.table && !self.table.contains(e.target)) self._deselect();
      if (self.focused) {
        self.focused = null;
        self._sync();
      }
    }, true);

    document.addEventListener('selectionchange', function () {
      self._updateFocusFromSelection();
    });

    this.$grab.addEventListener('pointerdown', function (e) {
      if (!self.table || !self._editable(self.table)) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
      self._beginGrab(e);
    });

    this.$corner.addEventListener('pointerdown', function (e) {
      if (!self.table || !self._editable(self.table)) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
      self._beginCorner(e);
    });

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

    if (!insideRoot) return;
    var changed = this.focused !== t;
    this.focused = t;
    if (t && this.table !== t) this.table = t;
    if (changed && this.table) this._sync();
  };

  Kit.prototype._hitTest = function (table, cx, cy) {
    var entries = columnsOf(table);
    if (!entries.length) return null;
    var best = null;

    var first = table.rows[0];
    for (var i = 0; i < first.cells.length; i++) {
      var entry = entries[i];
      var cr = first.cells[i].getBoundingClientRect();
      var d = Math.abs(cx - cr.right);
      if (d > EDGE) continue;
      var half = entry.start + entry.span - 1;
      var left = entryAt(entries, half);
      var right = entryAt(entries, entry.start + entry.span);
      if (left === right) continue;
      var isLast = entry.start + entry.span === entries[entries.length - 1].start + entries[entries.length - 1].span;
      if (!best || d < best.d) {
        best = {
          type: 'col', d: d, x: cr.right,
          left: left, right: right, edge: isLast,
          cellTop: cr.top, cellBottom: cr.bottom
        };
      }
    }

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

    var cur = '';
    if (h && h.type === 'col') cur = 'col-resize';
    else if (h && h.type === 'row') cur = 'row-resize';
    if (cur !== this._lastCur) {
      this._lastCur = cur;
      this.root.style.cursor = cur;
    }

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

    ov.style.left = px(vp.left);
    ov.style.top = px(vp.top);
    ov.style.setProperty('--emtk-s', zoom);
    ov.style.width = px(rect.width / zoom);
    ov.style.height = px(rect.height / zoom);

    this.$tint.style.display = this.selected ? '' : 'none';

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
      d.maxW = contentWidthOf(t);
    } else {
      d.mode = 'row';
      d.row = h.row;
      d.h = h.row.offsetHeight;
    }

    this.drag = d;
    this._setHover(null);
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

        var minDx = -Math.max(0, d.leftW - this.minCol);
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
      maxW: contentWidthOf(t),
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

    for (var i = 0; i < d.cols.length; i++) {
      var need = this.minCol / Math.max(1, d.cols[i].w);
      if (need > f) f = need;
    }

    var cap = d.maxW;
    if (d.baseW * f > cap) f = cap / d.baseW;
    for (var k = 0; k < d.cols.length; k++) setOuterWidth(d.cols[k].cell, d.cols[k].w * f);
    t.style.width = px(d.baseW * f);
    this._sync();
  };

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

      if (isDouble && t && isFloating(t)) {
        this._unfloat(t);
        return;
      }

      if (t && this._editable(t)) {
        try {
          var rng = document.createRange();
          rng.selectNode(t);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(rng);
        } catch (err) {  }
        this.selected = true;
        this._sync();
      }
      return;
    }

    this.selected = true;
    this._sync();
    this._emit('move');
  };

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

  Kit.prototype._emit = function (type) {
    if (typeof this.onChange === 'function' && this.table) {
      this.onChange({ kit: 'emtablekit', type: type, table: this.table });
    }
  };

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
