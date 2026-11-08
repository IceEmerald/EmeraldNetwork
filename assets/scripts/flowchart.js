

const State = {
  shapes: new Map(),
  selectedId: null,
  nextId: 1,
  connecting: null,
  execution: null,
  running: false,
  paused: false,
  speed: 30,
  variables: new Map(),
  changedVars: new Set(),
  zoom: 1,
};

const VALID_TYPES = ['Integer', 'Real', 'String', 'Boolean'];

const STORAGE_KEY = 'flowcode:current-program';
let _persistenceReady = false;
let _persistDebounceTimer = null;
let _remoteRefreshPending = false;

function serializeState() {
  return {
    version: 2,
    nextId: State.nextId,
    shapes: Array.from(State.shapes.values()).map(s => ({
      id: s.id,
      type: s.type,
      x: s.x,
      y: s.y,
      text: s.text,
      data: s.data,
      next: s.next || null,
      alt: s.alt || null,
    })),
    pan: { x: State.pan.x, y: State.pan.y },
    zoom: State.zoom,
    speed: State.speed,
    savedAt: Date.now(),
  };
}

function deserializeState(data) {
  if (!data || !Array.isArray(data.shapes)) return false;
  State.shapes.clear();
  State.nextId = data.nextId || 1;
  data.shapes.forEach(s => {
    if (!s.data) migrateShape(s);
    if (!s.text) s.text = getDisplayText(s);
    State.shapes.set(s.id, s);
  });
  if (data.pan && typeof data.pan.x === 'number') {
    State.pan.x = data.pan.x;
    State.pan.y = data.pan.y;
  }
  State.zoom = clamp(typeof data.zoom === 'number' ? data.zoom : 1, 0.4, 2.5);
  applyPan();
  if (typeof data.speed === 'number') {
    State.speed = data.speed;
    const slider = $('#speed-slider');
    if (slider) {

      const v = Math.round((500 - data.speed) / 495 * 100);
      slider.value = String(clamp(v, 1, 100));
      const disp = $('#speed-display');
      if (disp) disp.textContent = data.speed + 'ms';
    }
  }
  State.selectedId = null;
  return true;
}

function persistState() {
  if (!_persistenceReady) return;
  if (!window.EmeraldIDBStorage) return;
  try {
    EmeraldIDBStorage.setJSONSync(STORAGE_KEY, serializeState());
  } catch (err) {
    console.warn('[FlowCode] Failed to persist flowchart state:', err);
  }
}

function persistStateDebounced(delay = 350) {
  if (_persistDebounceTimer) clearTimeout(_persistDebounceTimer);
  _persistDebounceTimer = setTimeout(persistState, delay);
}

async function applyPendingRemoteState() {
  if (!_remoteRefreshPending || dragInfo || panInfo || State.connecting) return;
  _remoteRefreshPending = false;
  const latest = await EmeraldIDBStorage.getJSON(STORAGE_KEY, null, { allowLegacy: false });
  if (!latest) return;
  deserializeState(latest);
  renderAll();
}

async function loadPersistedState() {
  if (!window.EmeraldIDBStorage) return false;
  await EmeraldIDBStorage.ready();

  const data = await EmeraldIDBStorage.getJSON(STORAGE_KEY, null, { allowLegacy: false });
  if (!data) return false;
  return deserializeState(data);
}

const DIALOG_INFO = {
  terminal:  { title: 'Terminal Properties',  desc: 'A Terminal Statement marks the start or end of the program.' },
  declare:   { title: 'Declare Properties',   desc: 'A Declare Statement creates a new variable and defines its data type.' },
  process:   { title: 'Assignment Properties', desc: 'An Assignment Statement calculates an expression and stores the result in a variable.' },
  input:     { title: 'Input Properties',     desc: 'An Input Statement reads a value from the user and stores it in a variable.' },
  output:    { title: 'Output Properties',    desc: 'An Output Statement displays an expression to the console.' },
  decision:  { title: 'If Properties',        desc: 'An If Statement evaluates a boolean expression. If true, the True branch executes. If false, the False branch executes.' },
  loop:      { title: 'While Properties',     desc: 'A While Loop repeats while a boolean expression is true. The condition is checked before each iteration.' },
  for:       { title: 'For Properties',       desc: 'A For Loop increments or decrements a variable through a range of values. This is a common replacement for a While Loop.' },
  do:        { title: 'Do Properties',        desc: 'A Do Loop executes the body first, then repeats while the condition is true (post-test loop).' },
  call:      { title: 'Call Properties',      desc: 'A Call Statement executes a subroutine or function.' },
  comment:   { title: 'Comment Properties',   desc: 'A Comment is a note that is not executed. Use it to document your program.' },
  breakpoint:{ title: 'Breakpoint Properties', desc: 'A Breakpoint pauses execution when reached. Use it for debugging.' },
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
function uid() { return 's' + (State.nextId++); }
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(iconKey, msg, type = '') {
  const el = $('#toast');
  if (!el) return;

  let iconSvg = null;
  switch (iconKey) {
    case 'edit':    iconSvg = _fcSvg.edit; break;
    case 'dup':     iconSvg = _fcSvg.dup; break;
    case 'disc':    iconSvg = _fcSvg.disc; break;
    case 'del':     iconSvg = _fcSvg.del; break;
    case 'add':     iconSvg = _fcSvg.add; break;
    case 'link':    iconSvg = _fcSvg.link; break;
    case 'info':    iconSvg = _fcSvg.info; break;
    case 'check':   iconSvg = _fcSvg.check; break;
    case 'warn':    iconSvg = _fcSvg.warn; break;
    case 'shape':   iconSvg = _fcSvg.shape; break;
    case 'conn':    iconSvg = _fcSvg.conn; break;
    case 'canvas':  iconSvg = _fcSvg.canvas; break;
    default: iconSvg = null;
  }
  el.replaceChildren();
  if (iconSvg) {
    const iconSpan = document.createElement('span');
    iconSpan.innerHTML = iconSvg;
    el.appendChild(iconSpan);
  }
  const textSpan = document.createElement('span');
  textSpan.textContent = msg;
  el.appendChild(textSpan);

  el.className = 'fc-toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 5000);
}

function createShape(type, x, y) {
  const id = uid();

  const shape = { id, type, x: x ?? 200, y: y ?? 100, text: '', data: null, next: null, alt: null };
  shape.data = defaultDataForType(type);
  shape.text = getDisplayText(shape);
  State.shapes.set(id, shape);
  return shape;
}

function defaultDataForType(type) {
  switch (type) {
    case 'terminal':   return { text: 'Start' };
    case 'declare':    return { names: ['x'], dataType: 'Integer', isArray: false, arraySize: 10 };
    case 'process':    return { variable: 'x', expression: '0' };
    case 'input':      return { variable: 'x' };
    case 'output':     return { expression: '"Hello"', newline: true };
    case 'decision':   return { expression: 'x > 0' };
    case 'loop':       return { expression: 'x < 10' };
    case 'for':        return { variable: 'i', start: '1', end: '10', direction: 'increasing', step: '1' };
    case 'do':         return { expression: 'x < 10' };
    case 'call':       return { function: 'MyFunction', parameters: '' };
    case 'comment':    return { text: 'This is a comment' };
    case 'breakpoint': return {};
    default: return {};
  }
}

function getDeclareNames(d) {
  if (Array.isArray(d.names) && d.names.length) return d.names.filter(n => n);
  if (typeof d.name === 'string' && d.name) return [d.name];
  return ['x'];
}

function getDisplayText(shape) {
  const d = shape.data;
  if (!d) return shape.text || '';
  switch (shape.type) {
    case 'terminal':   return d.text || 'Start';
    case 'declare':    { const ns = getDeclareNames(d).map(n => d.isArray ? n + '[' + d.arraySize + ']' : n).join(', '); return ns + ' : ' + d.dataType; }
    case 'process':    return d.variable + ' = ' + d.expression;
    case 'input':      return d.variable;
    case 'output':     return d.expression;
    case 'decision':   return d.expression;
    case 'loop':       return d.expression;
    case 'for':        { const dir = d.direction === 'decreasing' ? ' downto ' : ' to '; const step = d.step && d.step !== '1' ? ' step ' + d.step : ''; return d.variable + ' = ' + d.start + dir + d.end + step; }
    case 'do':         return d.expression;
    case 'call':       return d.function + '(' + (d.parameters || '') + ')';
    case 'comment':    return d.text || '';
    case 'breakpoint': return 'Break';
    default: return '';
  }
}

function migrateShape(shape) {
  if (shape.data) return;
  const text = shape.text || '';
  switch (shape.type) {
    case 'terminal': shape.data = { text }; break;
    case 'declare': {

      const m = text.match(/^([a-zA-Z_]\w*(?:\s*\[\s*\d+\s*\])?(?:\s*,\s*[a-zA-Z_]\w*(?:\s*\[\s*\d+\s*\])?)*)\s*(?:as|:)\s*(\w+)/i);
      if (m) {
        const parts = m[1].split(',').map(s => s.trim()).filter(Boolean);
        const names = [];
        let isArray = false;
        let firstSize = 10;
        parts.forEach(p => {
          const am = p.match(/^([a-zA-Z_]\w*)\s*\[\s*(\d+)\s*\]$/);
          if (am) { names.push(am[1]); isArray = true; if (firstSize === 10) firstSize = parseInt(am[2], 10); }
          else { names.push(p); }
        });
        shape.data = { names, dataType: capitalize(m[2].toLowerCase()), isArray, arraySize: firstSize };
      } else {
        shape.data = defaultDataForType('declare');
      }
      break;
    }
    case 'process': {
      const m = text.match(/^([a-zA-Z_]\w*(?:\[[^\]]+\])?)\s*=\s*(.+)$/);
      if (m) shape.data = { variable: m[1], expression: m[2].trim() };
      else shape.data = { variable: 'x', expression: text };
      break;
    }
    case 'input': shape.data = { variable: text.trim() }; break;
    case 'output': shape.data = { expression: text, newline: true }; break;
    case 'decision': shape.data = { expression: text }; break;
    case 'loop': shape.data = { expression: text }; break;
    case 'for': shape.data = defaultDataForType('for'); break;
    case 'do': shape.data = { expression: text }; break;
    case 'call': { const m = text.match(/^([a-zA-Z_]\w*)\s*\((.*)\)$/); shape.data = { function: m ? m[1] : text, parameters: m ? m[2] : '' }; break; }
    case 'comment': shape.data = { text }; break;
    case 'breakpoint': shape.data = {}; break;
    default: shape.data = {};
  }
}

function deleteShape(id) {
  const shape = State.shapes.get(id);
  if (!shape) return;
  State.shapes.forEach(s => { if (s.next === id) s.next = null; if (s.alt === id) s.alt = null; });
  State.shapes.delete(id);
  if (State.selectedId === id) State.selectedId = null;
  renderAll();
}

function getShape(id) { return State.shapes.get(id); }

function findStartShape() {
  for (const s of State.shapes.values()) {
    if (s.type === 'terminal' && /^start/i.test((s.data && s.data.text) || s.text || '')) return s;
  }
  for (const s of State.shapes.values()) { if (s.type === 'terminal') return s; }
  return null;
}

function renderAll() {
  renderShapes();
  renderConnections();
  renderVariables();

  persistState();
}

const SVG_SHAPE_TYPES = ['decision', 'loop', 'for', 'do', 'breakpoint'];

function renderShapes() {
  const layer = $('#shapes-layer');
  layer.innerHTML = '';
  State.shapes.forEach(shape => {
    if (!shape.data) migrateShape(shape);
    const el = document.createElement('div');
    el.className = 'shape ' + shape.type;
    el.dataset.id = shape.id;
    el.style.left = shape.x + 'px';
    el.style.top = shape.y + 'px';
    if (shape.id === State.selectedId) el.classList.add('selected');
    if (State.execution && State.execution.currentId === shape.id) el.classList.add('executing');

    const sz = getShapeSize(shape);

    if (SVG_SHAPE_TYPES.includes(shape.type)) {

      el.style.width = sz.w + 'px';
      el.style.height = sz.h + 'px';
      el.appendChild(buildShapeSvg(shape, sz));

      const textEl = document.createElement('div');
      textEl.className = 'shape-text';
      textEl.textContent = getDisplayText(shape);

      if (shape.type === 'decision') { textEl.style.padding = '0 28px'; }
      else if (shape.type === 'loop' || shape.type === 'for' || shape.type === 'do') { textEl.style.padding = '0 18px'; }
      else if (shape.type === 'breakpoint') { textEl.style.padding = '0 6px'; textEl.style.fontSize = '10px'; textEl.style.fontWeight = '700'; }
      el.appendChild(textEl);
    } else {
      const body = document.createElement('div');
      body.className = 'shape-body';
      body.textContent = getDisplayText(shape);
      el.appendChild(body);
    }

    if (shape.type !== 'terminal' && shape.type !== 'comment' && shape.type !== 'breakpoint') {
      if (['decision','loop','for','do'].includes(shape.type)) {

        const hl = document.createElement('div'); hl.className = 'shape-handle handle-left'; hl.dataset.port = 'next'; el.appendChild(hl);
        const lblT = document.createElement('div'); lblT.className = 'label'; lblT.textContent = 'T'; hl.appendChild(lblT);
        const hr = document.createElement('div'); hr.className = 'shape-handle handle-right'; hr.dataset.port = 'alt'; el.appendChild(hr);
        const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = 'F'; hr.appendChild(lbl);
      } else {

        const hb = document.createElement('div'); hb.className = 'shape-handle handle-bottom'; hb.dataset.port = 'next'; el.appendChild(hb);
      }
    } else if (shape.type === 'terminal') {
      const isStart = /^start/i.test((shape.data && shape.data.text) || shape.text || '');
      if (isStart) { const hb = document.createElement('div'); hb.className = 'shape-handle handle-bottom'; hb.dataset.port = 'next'; el.appendChild(hb); }
    }
    layer.appendChild(el);
  });
}

function buildShapeSvg(shape, sz) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'shape-svg');
  svg.setAttribute('width', sz.w);
  svg.setAttribute('height', sz.h);
  svg.setAttribute('viewBox', '0 0 ' + sz.w + ' ' + sz.h);

  const inset = 1.5;
  let points = '';
  let fill = '';
  let stroke = '';
  let strokeWidth = 2;

  switch (shape.type) {
    case 'decision':

      points = (sz.w/2) + ',' + inset + ' ' +
               (sz.w - inset) + ',' + (sz.h/2) + ' ' +
               (sz.w/2) + ',' + (sz.h - inset) + ' ' +
               inset + ',' + (sz.h/2);
      fill = 'var(--shape-decision-bg)';
      stroke = 'var(--shape-decision-bd)';
      break;
    case 'loop':
    case 'for':
    case 'do':

      points = (sz.w * 0.12) + ',' + inset + ' ' +
               (sz.w * 0.88) + ',' + inset + ' ' +
               (sz.w - inset) + ',' + (sz.h/2) + ' ' +
               (sz.w * 0.88) + ',' + (sz.h - inset) + ' ' +
               (sz.w * 0.12) + ',' + (sz.h - inset) + ' ' +
               inset + ',' + (sz.h/2);
      fill = 'var(--shape-loop-bg)';
      stroke = 'var(--shape-loop-bd)';
      break;
    case 'breakpoint':

      points = (sz.w * 0.3) + ',' + inset + ' ' +
               (sz.w * 0.7) + ',' + inset + ' ' +
               (sz.w - inset) + ',' + (sz.h * 0.3) + ' ' +
               (sz.w - inset) + ',' + (sz.h * 0.7) + ' ' +
               (sz.w * 0.7) + ',' + (sz.h - inset) + ' ' +
               (sz.w * 0.3) + ',' + (sz.h - inset) + ' ' +
               inset + ',' + (sz.h * 0.7) + ' ' +
               inset + ',' + (sz.h * 0.3);
      fill = 'var(--shape-breakpoint-bg)';
      stroke = 'var(--shape-breakpoint-bd)';
      break;
  }

  if (points) {
    const poly = document.createElementNS(svgNS, 'polygon');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', fill);
    poly.setAttribute('stroke', stroke);
    poly.setAttribute('stroke-width', strokeWidth);
    poly.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(poly);
  }
  return svg;
}

function renderConnections() {
  const svg = $('#connections');
  svg.innerHTML = '';
  ensureArrowhead(svg);
  State.shapes.forEach(shape => {
    if (shape.next) drawConnection(svg, shape, 'next', shape.next, 'T');
    if (shape.alt) drawConnection(svg, shape, 'alt', shape.alt, 'F');
  });
  if (State.connecting) {
    const from = getShape(State.connecting.fromId);
    if (from) {
      const start = getPortPos(from, State.connecting.fromPort);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', makePath(start.x, start.y, State.connecting.mouseX, State.connecting.mouseY));
      p.setAttribute('stroke', '#239a4d');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-dasharray', '5 4');
      p.setAttribute('fill', 'none');
      p.setAttribute('pointer-events', 'none');
      svg.appendChild(p);
    }
  }
}

function getShapeSize(shape) {
  switch (shape.type) {
    case 'terminal': return { w: 130, h: 44 };
    case 'declare': case 'process': return { w: 140, h: 44 };
    case 'input': case 'output': return { w: 150, h: 44 };
    case 'decision': return { w: 160, h: 80 };
    case 'loop': case 'for': case 'do': return { w: 160, h: 64 };
    case 'call': return { w: 150, h: 44 };
    case 'comment': return { w: 180, h: 36 };
    case 'breakpoint': return { w: 60, h: 50 };
    default: return { w: 130, h: 44 };
  }
}

function getPortPos(shape, port) {
  const sz = getShapeSize(shape);
  const x = shape.x, y = shape.y;
  const isBranching = ['decision','loop','for','do'].includes(shape.type);
  switch (port) {
    case 'in':   return { x: x + sz.w/2, y: y };
    case 'next': return isBranching ? { x: x, y: y + sz.h/2 } : { x: x + sz.w/2, y: y + sz.h };
    case 'alt':  return { x: x + sz.w, y: y + sz.h/2 };
    default:     return { x: x + sz.w/2, y: y + sz.h/2 };
  }
}

function makePath(x1, y1, x2, y2) {

  const dx = x2 - x1, dy = y2 - y1;
  const adx = Math.abs(dx), ady = Math.abs(dy);

  if (adx < 3) return 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2;

  if (ady < 3) return 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2;

  const r = Math.min(8, adx / 2, ady / 2, 12);

  if (ady >= adx) {

    const midY = y1 + dy / 2;
    const sy = dy > 0 ? 1 : -1;
    const sx = dx > 0 ? 1 : -1;
    return 'M ' + x1 + ' ' + y1 +
      ' L ' + x1 + ' ' + (midY - sy * r) +
      ' Q ' + x1 + ' ' + midY + ' ' + (x1 + sx * r) + ' ' + midY +
      ' L ' + (x2 - sx * r) + ' ' + midY +
      ' Q ' + x2 + ' ' + midY + ' ' + x2 + ' ' + (midY + sy * r) +
      ' L ' + x2 + ' ' + y2;
  } else {

    const midX = x1 + dx / 2;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    return 'M ' + x1 + ' ' + y1 +
      ' L ' + (midX - sx * r) + ' ' + y1 +
      ' Q ' + midX + ' ' + y1 + ' ' + midX + ' ' + (y1 + sy * r) +
      ' L ' + midX + ' ' + (y2 - sy * r) +
      ' Q ' + midX + ' ' + y2 + ' ' + (midX + sx * r) + ' ' + y2 +
      ' L ' + x2 + ' ' + y2;
  }
}

function drawConnection(svg, fromShape, portName, toId, label) {
  const to = getShape(toId);
  if (!to) return;
  const start = getPortPos(fromShape, portName);
  const end = getPortPos(to, 'in');
  const d = makePath(start.x, start.y, end.x, end.y);
  const isActive = State.execution && State.execution.lastEdge && State.execution.lastEdge.from === fromShape.id && State.execution.lastEdge.port === portName;

  const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hit.setAttribute('d', d);
  hit.setAttribute('class', 'conn-hit');
  hit.dataset.from = fromShape.id;
  hit.dataset.port = portName;
  hit.dataset.to = toId;
  hit.addEventListener('click', (e) => {
    e.stopPropagation();
    showInsertMenu(e.clientX, e.clientY, fromShape.id, portName, toId);
  });
  svg.appendChild(hit);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'conn-line' + (isActive ? ' active' : ''));
  path.setAttribute('marker-end', isActive ? 'url(#arrowhead-active)' : 'url(#arrowhead)');
  svg.appendChild(path);

  if (['decision','loop','for','do'].includes(fromShape.type) && label) {

    const tPos = 0.25;
    const lblX = start.x + (end.x - start.x) * tPos;
    const lblY = start.y + (end.y - start.y) * tPos;
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', lblX - 7); bg.setAttribute('y', lblY - 8);
    bg.setAttribute('width', 14); bg.setAttribute('height', 14);
    bg.setAttribute('class', 'conn-label-bg'); bg.setAttribute('rx', '3');
    svg.appendChild(bg);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', lblX); t.setAttribute('y', lblY + 3);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'conn-label');
    t.textContent = label;
    svg.appendChild(t);
  }
}

function ensureArrowhead(svg) {
  if (svg.querySelector('defs')) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8'); marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  path.setAttribute('fill', 'rgba(44,62,80,0.55)');
  marker.appendChild(path);
  defs.appendChild(marker);
  const markerA = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  markerA.setAttribute('id', 'arrowhead-active');
  markerA.setAttribute('viewBox', '0 0 10 10');
  markerA.setAttribute('refX', '8'); markerA.setAttribute('refY', '5');
  markerA.setAttribute('markerWidth', '7'); markerA.setAttribute('markerHeight', '7');
  markerA.setAttribute('orient', 'auto');
  const pathA = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathA.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  pathA.setAttribute('fill', '#239a4d');
  markerA.appendChild(pathA);
  defs.appendChild(markerA);
  svg.appendChild(defs);
}

function renderVariables() {
  const panel = $('#variables-panel');
  $('#var-count').textContent = State.variables.size;
  if (State.variables.size === 0) { panel.innerHTML = '<div class="var-empty">No variables yet. Run the program to see them.</div>'; return; }
  let html = '';
  State.variables.forEach((v, name) => {
    const changed = State.changedVars.has(name) ? ' changed' : '';
    let displayVal;
    if (Array.isArray(v.value)) displayVal = '[' + v.value.map(x => typeof x === 'string' ? '"' + x + '"' : x).join(', ') + ']';
    else if (v.type === 'String') displayVal = '"' + v.value + '"';
    else displayVal = String(v.value);
    const typeLabel = Array.isArray(v.value) ? v.type + '[]' : v.type;
    html += '<div class="var-item"><div class="var-name">' + escapeHtml(name) + '</div><div class="var-type ' + (Array.isArray(v.value) ? 'Array' : v.type) + '">' + escapeHtml(typeLabel) + '</div><div class="var-value' + changed + '">' + escapeHtml(displayVal) + '</div></div>';
  });
  panel.innerHTML = html;
  State.changedVars.clear();
}

let dragInfo = null;
let panInfo = null;
State.pan = { x: 0, y: 0 };
State.spaceHeld = false;

function applyPan() {
  $('#canvas-content').style.transform = 'translate(' + State.pan.x + 'px, ' + State.pan.y + 'px) scale(' + State.zoom + ')';
  $('#canvas-wrap').style.backgroundPosition = State.pan.x + 'px ' + State.pan.y + 'px';
  $('#canvas-wrap').style.backgroundSize = (22 * State.zoom) + 'px ' + (22 * State.zoom) + 'px';
}

function canvasPointFromClient(clientX, clientY) {
  const rect = $('#canvas-wrap').getBoundingClientRect();
  return {
    x: (clientX - rect.left - State.pan.x) / State.zoom,
    y: (clientY - rect.top - State.pan.y) / State.zoom,
  };
}

function setCanvasZoom(nextZoom, anchorClientX, anchorClientY) {
  const wrap = $('#canvas-wrap');
  const rect = wrap.getBoundingClientRect();
  const oldZoom = State.zoom;
  const newZoom = clamp(nextZoom, 0.4, 2.5);
  if (Math.abs(newZoom - oldZoom) < 0.001) return;
  const sx = anchorClientX - rect.left;
  const sy = anchorClientY - rect.top;
  const worldX = (sx - State.pan.x) / oldZoom;
  const worldY = (sy - State.pan.y) / oldZoom;
  State.zoom = newZoom;
  State.pan.x = sx - worldX * newZoom;
  State.pan.y = sy - worldY * newZoom;
  applyPan();
  renderConnections();
  persistStateDebounced(400);
  toast('canvas', ' Zoom ' + Math.round(State.zoom * 100) + '%');
}

$('#canvas-wrap').addEventListener('mousedown', (e) => {

  if (e.target.closest('.fc-ribbon, .fc-palette, .fc-panel, .fc-brand-pill, .fc-file-bar')) return;
  if (State.spaceHeld || e.button === 1) {
    panInfo = { startX: e.clientX, startY: e.clientY, panX: State.pan.x, panY: State.pan.y };
    $('#canvas-wrap').classList.add('panning');
    e.preventDefault();
    return;
  }
  const target = e.target.closest('.shape');
  if (target) {
    const handle = e.target.closest('.shape-handle');
    if (handle) {
      const fromId = target.dataset.id;
      const fromPort = handle.dataset.port;
      if (fromPort === 'in') return;
      const pt = canvasPointFromClient(e.clientX, e.clientY);
      State.connecting = { fromId, fromPort, mouseX: pt.x, mouseY: pt.y };
      document.body.classList.add('connecting-mode');
      e.preventDefault();
      return;
    }
    const id = target.dataset.id;
    const wasSelected = State.selectedId === id;
    State.selectedId = id;
    const shape = getShape(id);
    const pt = canvasPointFromClient(e.clientX, e.clientY);
    dragInfo = {
      id,
      offsetX: pt.x - shape.x,
      offsetY: pt.y - shape.y,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };

    if (!wasSelected) renderShapes();
  } else {
    if (State.selectedId) { State.selectedId = null; renderShapes(); }
  }
});

document.addEventListener('mousemove', (e) => {
  if (panInfo) {
    State.pan.x = panInfo.panX + (e.clientX - panInfo.startX);
    State.pan.y = panInfo.panY + (e.clientY - panInfo.startY);
    applyPan();
    persistStateDebounced(500);
    return;
  }
  if (dragInfo) {

    if (Math.abs(e.clientX - dragInfo.startX) > 4 || Math.abs(e.clientY - dragInfo.startY) > 4) {
      dragInfo.moved = true;
    }
    const shape = getShape(dragInfo.id);
    if (shape) {
      const pt = canvasPointFromClient(e.clientX, e.clientY);
      shape.x = pt.x - dragInfo.offsetX;
      shape.y = pt.y - dragInfo.offsetY;
      const el = document.querySelector('.shape[data-id="' + dragInfo.id + '"]');
      if (el) { el.style.left = shape.x + 'px'; el.style.top = shape.y + 'px'; }
      renderConnections();
      if (dragInfo.moved) persistStateDebounced(500);
    }
  }
  if (State.connecting) {
    const pt = canvasPointFromClient(e.clientX, e.clientY);
    State.connecting.mouseX = pt.x;
    State.connecting.mouseY = pt.y;
    renderConnections();
  }
});

$('#canvas-wrap').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  if (e.target.closest('.fc-ribbon, .fc-palette, .fc-panel, .fc-brand-pill, .fc-file-bar')) return;
  e.preventDefault();
  const direction = e.deltaY > 0 ? -1 : 1;
  const factor = direction > 0 ? 1.1 : 1 / 1.1;
  setCanvasZoom(State.zoom * factor, e.clientX, e.clientY);
}, { passive: false });

document.addEventListener('mouseup', (e) => {
  if (panInfo) {
    panInfo = null;
    $('#canvas-wrap').classList.remove('panning');
    applyPendingRemoteState().catch(() => {});
    return;
  }
  if (State.connecting) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const targetShape = target ? target.closest('.shape') : null;
    if (targetShape) {
      const toId = targetShape.dataset.id;
      const fromShape = getShape(State.connecting.fromId);
      if (fromShape && fromShape.id !== toId) {
        const toShape = getShape(toId);
        const isStart = toShape.type === 'terminal' && /^start/i.test((toShape.data && toShape.data.text) || toShape.text || '');
        if (!isStart && toShape.type !== 'comment' && toShape.type !== 'breakpoint') {
          if (State.connecting.fromPort === 'next') fromShape.next = toId;
          else if (State.connecting.fromPort === 'alt') fromShape.alt = toId;
        }
      }
    }
    State.connecting = null;
    document.body.classList.remove('connecting-mode');
    renderConnections();
    persistState();
  }
  if (dragInfo && dragInfo.moved) persistState();
  dragInfo = null;
  applyPendingRemoteState().catch(() => {});
});

$('#canvas-wrap').addEventListener('dblclick', (e) => {

  if (e.target.closest('.fc-ribbon, .fc-palette, .fc-panel, .fc-brand-pill, .fc-file-bar')) return;

  if (e.target.closest('.shape-handle')) return;
  const target = e.target.closest('.shape');
  if (!target) return;

  e.preventDefault();
  State.selectedId = target.dataset.id;
  renderShapes();
  openPropertyDialog(target.dataset.id);
});

document.addEventListener('contextmenu', (e) => {

  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.target.closest('.modal-overlay')) return;

  e.preventDefault();

  const shapeEl = e.target.closest('.shape');
  const connHit = e.target.closest('.conn-hit');

  if (shapeEl) {
    State.selectedId = shapeEl.dataset.id;
    renderShapes();
    showShapeContextMenu(e.clientX, e.clientY, shapeEl.dataset.id);
  } else if (connHit) {
    showConnectionContextMenu(
      e.clientX, e.clientY,
      connHit.dataset.from, connHit.dataset.port, connHit.dataset.to
    );
  } else {

    showCanvasContextMenu(e.clientX, e.clientY);
  }
});

function showInsertMenu(x, y, fromId, port, toId) {
  const fromShape = getShape(fromId);
  const toShape = getShape(toId);
  if (!fromShape || !toShape) return;
  const fromPos = getPortPos(fromShape, port);
  const toPos = getPortPos(toShape, 'in');
  const midX = (fromPos.x + toPos.x) / 2 - 70;
  const midY = (fromPos.y + toPos.y) / 2 - 22;

  const menu = $('#context-menu');
  const options = [
    { type: 'process', label: 'Insert Assign' },
    { type: 'declare', label: 'Insert Declare' },
    { type: 'input', label: 'Insert Input' },
    { type: 'output', label: 'Insert Output' },
    { type: 'decision', label: 'Insert If' },
    { type: 'call', label: 'Insert Call' },
    { type: 'comment', label: 'Insert Comment' },
  ];
  menu.innerHTML =
    '<div class="context-title">' + _fcSvg.conn + ' CONNECTION</div>' +
    options.map(o => '<a data-type="' + o.type + '">' + o.label + ' Here</a>').join('');
  positionContextMenu(menu, x, y);
  menu.querySelectorAll('a[data-type]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      const newShape = createShape(el.dataset.type, midX, midY);
      if (port === 'next') fromShape.next = newShape.id;
      else fromShape.alt = newShape.id;
      newShape.next = toId;
      State.selectedId = newShape.id;
      renderAll();
      hideContextMenu();
      setTimeout(() => openPropertyDialog(newShape.id), 100);
    });
  });
}

$$('.palette-item').forEach(item => {
  item.addEventListener('click', () => {
    const type = item.dataset.type;
    const rect = $('#canvas-wrap').getBoundingClientRect();
    const x = (rect.width / 2 - State.pan.x) / State.zoom - 70 + (Math.random() * 40 - 20);
    const y = (60 - State.pan.y) / State.zoom + State.shapes.size * 6;
    const shape = createShape(type, x, y);
    State.selectedId = shape.id;
    renderAll();
  });
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('shape-type', item.dataset.type);
    e.dataTransfer.effectAllowed = 'copy';
  });
});

$$('.panel-toggle').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = btn.dataset.target;
    const panel = document.getElementById('panel-' + target);
    if (!panel) return;
    panel.classList.toggle('minimized');
  });
});

$('#canvas-wrap').addEventListener('dragover', (e) => {
  if (e.target.closest('.fc-ribbon, .fc-palette, .fc-panel, .fc-brand-pill, .fc-file-bar')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
$('#canvas-wrap').addEventListener('drop', (e) => {
  if (e.target.closest('.fc-ribbon, .fc-palette, .fc-panel, .fc-brand-pill, .fc-file-bar')) return;
  e.preventDefault();
  const type = e.dataTransfer.getData('shape-type');
  if (!type) return;
  const pt = canvasPointFromClient(e.clientX, e.clientY);
  const shape = createShape(type, pt.x - 65, pt.y - 22);
  State.selectedId = shape.id;
  renderAll();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!State.spaceHeld) {
      State.spaceHeld = true;
      $('#canvas-wrap').classList.add('space-mode');
    }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (State.selectedId) { deleteShape(State.selectedId); toast('del', ' Shape deleted'); } }
  else if (e.key === 'Enter') { if (State.selectedId && !$('.modal-overlay')) openPropertyDialog(State.selectedId); }
  else if (e.key === 'Escape') {
    if (State.connecting) { State.connecting = null; document.body.classList.remove('connecting-mode'); renderConnections(); }
    hideContextMenu();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    State.spaceHeld = false;
    $('#canvas-wrap').classList.remove('space-mode');
    $('#canvas-wrap').classList.remove('panning');
    panInfo = null;
  }
});

window.addEventListener('blur', () => {
  State.spaceHeld = false;
  $('#canvas-wrap').classList.remove('space-mode');
  $('#canvas-wrap').classList.remove('panning');
  panInfo = null;
});

function positionContextMenu(menu, x, y) {
  menu.style.display = 'block';
  const menuWidth = menu.offsetWidth || 240;
  const menuHeight = menu.offsetHeight || 160;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let left = x;
  let top = y;
  if (left + menuWidth > viewportWidth) left = viewportWidth - menuWidth - 8;
  if (left < 8) left = 8;
  if (top + menuHeight > viewportHeight) top = viewportHeight - menuHeight - 8;
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

const _fcSvg = {
  edit:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.7"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  dup:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.7"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  disc:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.7"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  del:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.7"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
  add:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.7"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  link:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.7"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  info:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.7"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',

  shape:  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;display:inline-block"><rect x="3" y="8" width="18" height="8" rx="2"/></svg>',
  conn:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;display:inline-block"><path d="M9 17H7a5 5 0 0 1 0-10h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  canvas: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;display:inline-block"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',

  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.8"><path d="M20 6L9 17l-5-5"/></svg>',
  warn:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;opacity:0.8"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

function showShapeContextMenu(x, y, shapeId) {
  const menu = $('#context-menu');
  const shape = getShape(shapeId);
  if (!shape) return;

  let html = '<div class="context-title">' + _fcSvg.shape + ' SHAPE</div>';
  html += '<a data-action="edit">Edit Properties</a>';
  html += '<a data-action="duplicate">Duplicate</a>';

  if (shape.type !== 'terminal' && shape.type !== 'comment' && shape.type !== 'breakpoint') {
    if (shape.next) {
      html += '<a data-action="disconnect-next">Disconnect True</a>';
    }
    if (['decision','loop','for','do'].includes(shape.type) && shape.alt) {
      html += '<a data-action="disconnect-alt">Disconnect False</a>';
    }
  }

  html += '<a class="ctx-danger" data-action="delete">Delete</a>';

  menu.innerHTML = html;
  positionContextMenu(menu, x, y);

  menu.querySelectorAll('a[data-action]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      handleContextAction(a.dataset.action, shapeId);
      hideContextMenu();
    });
  });
}

function showConnectionContextMenu(x, y, fromId, port, toId) {
  const menu = $('#context-menu');
  const fromShape = getShape(fromId);
  const toShape = getShape(toId);
  if (!fromShape || !toShape) return;

  const fromPos = getPortPos(fromShape, port);
  const toPos = getPortPos(toShape, 'in');
  const midX = (fromPos.x + toPos.x) / 2 - 70;
  const midY = (fromPos.y + toPos.y) / 2 - 22;

  const insertOptions = [
    { type: 'process',  label: 'Insert Assign' },
    { type: 'declare',  label: 'Insert Declare' },
    { type: 'input',    label: 'Insert Input' },
    { type: 'output',   label: 'Insert Output' },
    { type: 'decision', label: 'Insert If' },
    { type: 'call',     label: 'Insert Call' },
    { type: 'comment',  label: 'Insert Comment' },
  ];

  let html = '<div class="context-title">' + _fcSvg.conn + ' CONNECTION</div>';
  insertOptions.forEach(o => {
    html += '<a data-type="' + o.type + '">' + o.label + ' Here</a>';
  });

  html += '<a class="ctx-danger" data-action="disconnect">Disconnect</a>';

  menu.innerHTML = html;
  positionContextMenu(menu, x, y);

  menu.querySelectorAll('a[data-type]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const newShape = createShape(a.dataset.type, midX, midY);
      if (port === 'next') fromShape.next = newShape.id;
      else fromShape.alt = newShape.id;
      newShape.next = toId;
      State.selectedId = newShape.id;
      renderAll();
      hideContextMenu();
      setTimeout(() => openPropertyDialog(newShape.id), 100);
    });
  });

  const disc = menu.querySelector('a[data-action="disconnect"]');
  if (disc) {
    disc.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (port === 'next') fromShape.next = null;
      else fromShape.alt = null;
      renderConnections();
      persistState();
      hideContextMenu();
      toast('disc', ' Connection removed');
    });
  }
}

function showCanvasContextMenu(x, y) {
  const menu = $('#context-menu');

  const pt = canvasPointFromClient(x, y);
  const cx = pt.x - 65;
  const cy = pt.y - 22;

  const addOptions = [
    { type: 'terminal',  label: 'Add Terminal' },
    { type: 'declare',   label: 'Add Declare' },
    { type: 'process',   label: 'Add Assign' },
    { type: 'input',     label: 'Add Input' },
    { type: 'output',    label: 'Add Output' },
    { type: 'decision',  label: 'Add If' },
    { type: 'call',      label: 'Add Call' },
    { type: 'comment',   label: 'Add Comment' },
  ];

  let html = '<div class="context-title">' + _fcSvg.canvas + ' CANVAS</div>';
  addOptions.forEach(o => {
    html += '<a data-type="' + o.type + '">' + o.label + ' Here</a>';
  });

  html += '<a data-action="copy-link">Copy Page Link</a>';
  html += '<a data-action="show-info">Show Canvas Info</a>';

  if (State.shapes.size > 0) {
    html += '<a class="ctx-danger" data-action="clear">Clear Canvas</a>';
  }

  menu.innerHTML = html;
  positionContextMenu(menu, x, y);

  menu.querySelectorAll('a[data-type]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const s = createShape(a.dataset.type, cx, cy);
      State.selectedId = s.id;
      renderAll();
      hideContextMenu();
      if (a.dataset.type !== 'comment' && a.dataset.type !== 'breakpoint') {
        setTimeout(() => openPropertyDialog(s.id), 100);
      }
    });
  });

  menu.querySelectorAll('a[data-action]').forEach(a => {
    a.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const action = a.dataset.action;
      if (action === 'copy-link') {
        try {
          await navigator.clipboard.writeText(location.href);
          toast('link', ' Page link copied!', 'success');
        } catch {
          toast('warn', ' Could not copy link!', 'error');
        }
      } else if (action === 'show-info') {
        const n = State.shapes.size;
        const conns = Array.from(State.shapes.values()).reduce(
          (acc, s) => acc + (s.next ? 1 : 0) + (s.alt ? 1 : 0), 0
        );
        toast(
          'info',
          'Canvas — ' + n + ' shape' + (n === 1 ? '' : 's') +
          ' · ' + conns + ' connection' + (conns === 1 ? '' : 's') +
          ' · Pan (' + Math.round(State.pan.x) + ', ' + Math.round(State.pan.y) + ')'
        );
      } else if (action === 'clear') {
        const ok = await showConfirmModal({
          title: 'Clear Canvas',
          message: 'Remove all ' + State.shapes.size + ' shape' +
                   (State.shapes.size === 1 ? '' : 's') +
                   ' from the canvas? This cannot be undone.',
          confirmLabel: 'Clear All',
          danger: true,
        });
        if (ok) {
          State.shapes.clear();
          State.selectedId = null;
          renderAll();
          persistState();
          toast('check', ' Canvas cleared', 'success');
        }
      }
      hideContextMenu();
    });
  });
}
function hideContextMenu() { $('#context-menu').style.display = 'none'; }
document.addEventListener('click', hideContextMenu);
function handleContextAction(action, id) {
  const shape = getShape(id);
  if (!shape) return;
  switch (action) {
    case 'edit': openPropertyDialog(id); break;
    case 'duplicate': { const copy = createShape(shape.type, shape.x + 30, shape.y + 30); copy.data = JSON.parse(JSON.stringify(shape.data)); copy.text = getDisplayText(copy); State.selectedId = copy.id; renderAll(); toast('dup', ' Duplicated'); break; }
    case 'delete': deleteShape(id); toast('del', ' Deleted'); break;
    case 'disconnect-next': shape.next = null; renderConnections(); persistState(); break;
    case 'disconnect-alt': shape.alt = null; renderConnections(); persistState(); break;
  }
}

function renderShapeIcon(type) {
  const icons = {
    terminal: '<div class="icon-shape" style="background:#fff8db;border:2px solid #d4a017;border-radius:20px;">Start</div>',
    declare: '<div class="icon-shape" style="background:#fff8db;border:2px solid #d4a017;">Declare</div>',
    process: '<div class="icon-shape" style="background:#fff8db;border:2px solid #d4a017;">Assign</div>',
    input: '<div class="icon-shape" style="background:#d6ecf5;border:2px solid #3b7a99;transform:skewX(-15deg);">Input</div>',
    output: '<div class="icon-shape" style="background:#d7f0d7;border:2px solid #2a8a44;transform:skewX(-15deg);">Output</div>',
    decision: '<div class="icon-shape" style="background:#fbdfe4;border:2px solid #c93b53;clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);width:40px;height:40px;">If</div>',
    loop: '<div class="icon-shape" style="background:#ffe6cc;border:2px solid #c97a3a;clip-path:polygon(12% 0,88% 0,100% 50%,88% 100%,12% 100%,0 50%);">While</div>',
    for: '<div class="icon-shape" style="background:#ffe6cc;border:2px solid #c97a3a;clip-path:polygon(12% 0,88% 0,100% 50%,88% 100%,12% 100%,0 50%);">For</div>',
    do: '<div class="icon-shape" style="background:#ffe6cc;border:2px solid #c97a3a;clip-path:polygon(12% 0,88% 0,100% 50%,88% 100%,12% 100%,0 50%);">Do</div>',
    call: '<div class="icon-shape" style="background:#ece4f7;border:2px solid #7c5cb8;border-left:4px double #7c5cb8;border-right:4px double #7c5cb8;">Call</div>',
    comment: '<div class="icon-shape" style="background:#fff;border:1px dashed rgba(0,0,0,0.3);font-style:italic;">Comment</div>',
    breakpoint: '<div class="icon-shape" style="background:#ff6b6b;border:2px solid #c92a2a;clip-path:polygon(30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%);width:30px;height:30px;color:#fff;">B</div>',
  };
  return icons[type] || '';
}

function createDialogShell(shape) {
  const info = DIALOG_INFO[shape.type] || { title: 'Properties', desc: '' };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="prop-dialog">' +
      '<div class="prop-header">' +
        '<div class="prop-shape-icon">' + renderShapeIcon(shape.type) + '</div>' +
        '<div class="prop-description">' + escapeHtml(info.desc) + '</div>' +
      '</div>' +
      '<div class="prop-body"></div>' +
      '<div class="prop-footer">' +
        '<button class="prop-btn cancel">Cancel</button>' +
        '<button class="prop-btn primary ok">OK</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  return {
    overlay,
    body: overlay.querySelector('.prop-body'),
    okBtn: overlay.querySelector('.ok'),
    cancelBtn: overlay.querySelector('.cancel'),
    close: () => overlay.remove(),
  };
}

function openPropertyDialog(shapeId) {
  const shape = getShape(shapeId);
  if (!shape) return;
  if (!shape.data) migrateShape(shape);
  switch (shape.type) {
    case 'terminal': openTerminalDialog(shape); break;
    case 'declare': openDeclareDialog(shape); break;
    case 'process': openAssignDialog(shape); break;
    case 'input': openInputDialog(shape); break;
    case 'output': openOutputDialog(shape); break;
    case 'decision': openIfDialog(shape); break;
    case 'loop': openWhileDialog(shape); break;
    case 'for': openForDialog(shape); break;
    case 'do': openDoDialog(shape); break;
    case 'call': openCallDialog(shape); break;
    case 'comment': openCommentDialog(shape); break;
    case 'breakpoint': openBreakpointDialog(shape); break;
  }
}

function openTerminalDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  const current = (d.text || 'Start').toLowerCase();
  const isStart = current !== 'end';
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Terminal Type</label>' +
    '<div class="terminal-type-buttons">' +
      '<button type="button" class="terminal-type-btn' + (isStart ? ' active' : '') + '" data-value="Start">' +
        '<span class="terminal-type-icon">▶</span>' +
        '<span>Start</span>' +
      '</button>' +
      '<button type="button" class="terminal-type-btn' + (!isStart ? ' active' : '') + '" data-value="End">' +
        '<span class="terminal-type-icon">■</span>' +
        '<span>End</span>' +
      '</button>' +
    '</div></div>';
  let selectedValue = isStart ? 'Start' : 'End';
  dlg.body.querySelectorAll('.terminal-type-btn').forEach(btn => {
    btn.onclick = () => {
      dlg.body.querySelectorAll('.terminal-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedValue = btn.dataset.value;
    };
  });

  dlg.body.querySelectorAll('.terminal-type-btn').forEach(btn => {
    btn.ondblclick = () => {
      selectedValue = btn.dataset.value;
      d.text = selectedValue;
      shape.text = getDisplayText(shape);
      renderAll();
      dlg.close();
    };
  });
  dlg.okBtn.onclick = () => { d.text = selectedValue; shape.text = getDisplayText(shape); renderAll(); dlg.close(); };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openDeclareDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  const namesStr = getDeclareNames(d).join(', ');
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Names <span style="color:var(--fc-text-muted);font-weight:400;font-size:11px;">(comma-separated, e.g. x, y, z)</span></label>' +
    '<input type="text" id="f-name" value="' + escapeHtml(namesStr) + '" placeholder="e.g. x, y, z"></div>' +
    '<div class="prop-field"><label>Data Type</label>' +
    '<select id="f-type">' +
      '<option value="Integer">Integer</option>' +
      '<option value="Real">Real</option>' +
      '<option value="String">String</option>' +
      '<option value="Boolean">Boolean</option>' +
    '</select></div>' +
    '<div class="prop-field"><label class="prop-checkbox"><input type="checkbox" id="f-array"> Array? <span style="color:var(--fc-text-muted);font-weight:400;font-size:11px;">(applies to all names)</span></label></div>' +
    '<div class="prop-field" id="f-size-field" style="display:none;"><label>Array Size (number of elements)</label>' +
    '<input type="number" id="f-size" value="' + (d.arraySize || 10) + '" min="1" max="10000"></div>';
  dlg.body.querySelector('#f-type').value = d.dataType || 'Integer';
  const arrayCheck = dlg.body.querySelector('#f-array');
  arrayCheck.checked = d.isArray || false;
  const sizeField = dlg.body.querySelector('#f-size-field');
  sizeField.style.display = arrayCheck.checked ? '' : 'none';
  arrayCheck.onchange = () => { sizeField.style.display = arrayCheck.checked ? '' : 'none'; };
  const nameInput = dlg.body.querySelector('#f-name');
  nameInput.focus(); nameInput.select();
  dlg.okBtn.onclick = () => {
    const raw = nameInput.value.trim();
    if (!raw) { toast('warn', ' Please enter at least one variable name', 'error'); return; }

    const names = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (names.length === 0) { toast('warn', ' Please enter at least one variable name', 'error'); return; }

    for (const n of names) {
      if (!/^[a-zA-Z_]\w*$/.test(n)) {
        toast('warn', ' Invalid variable name: "' + n + '". Use letters, digits, _; cannot start with a digit.', 'error');
        return;
      }
    }

    const lowered = names.map(n => n.toLowerCase());
    if (new Set(lowered).size !== lowered.length) {
      const seen = {};
      let dup = '';
      for (const l of lowered) { seen[l] = (seen[l] || 0) + 1; if (seen[l] > 1) { dup = l; break; } }
      toast('warn', ' Duplicate variable name: "' + dup + '"', 'error');
      return;
    }
    d.names = names;
    delete d.name;
    d.dataType = dlg.body.querySelector('#f-type').value;
    d.isArray = arrayCheck.checked;
    d.arraySize = parseInt(dlg.body.querySelector('#f-size').value, 10) || 1;
    shape.text = getDisplayText(shape);
    renderAll(); dlg.close();
  };
  dlg.cancelBtn.onclick = dlg.close;
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.okBtn.click(); if (e.key === 'Escape') dlg.close(); });
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openAssignDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML =
    '<div class="prop-field"><div class="prop-assign-row">' +
    '<input type="text" id="f-var" value="' + escapeHtml(d.variable || '') + '" placeholder="variable">' +
    '<span class="equals">=</span>' +
    '<textarea id="f-expr" placeholder="expression">' + escapeHtml(d.expression || '') + '</textarea>' +
    '</div></div>';
  const varInput = dlg.body.querySelector('#f-var');
  const exprInput = dlg.body.querySelector('#f-expr');
  varInput.focus(); varInput.select();
  dlg.okBtn.onclick = () => {
    const v = varInput.value.trim();
    if (!v) { toast('warn', ' Please enter a variable name', 'error'); return; }
    d.variable = v;
    d.expression = exprInput.value.trim();
    if (!d.expression) { toast('warn', ' Please enter an expression', 'error'); return; }
    shape.text = getDisplayText(shape);
    renderAll(); dlg.close();
  };
  dlg.cancelBtn.onclick = dlg.close;
  [varInput, exprInput].forEach(el => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && el === varInput) { e.preventDefault(); exprInput.focus(); } if (e.key === 'Escape') dlg.close(); });
  });
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openInputDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Variable</label>' +
    '<input type="text" id="f-var" value="' + escapeHtml(d.variable || '') + '" placeholder="variable name"></div>';
  const varInput = dlg.body.querySelector('#f-var');
  varInput.focus(); varInput.select();
  dlg.okBtn.onclick = () => {
    d.variable = varInput.value.trim();
    delete d.prompt;
    if (!d.variable) { toast('warn', ' Please enter a variable name', 'error'); return; }
    shape.text = getDisplayText(shape);
    renderAll(); dlg.close();
  };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openOutputDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Expression</label>' +
    '<textarea id="f-expr" placeholder="e.g. &quot;Hello&quot; or x + y">' + escapeHtml(d.expression || '') + '</textarea></div>' +
    '<div class="prop-field"><label class="prop-checkbox"><input type="checkbox" id="f-nl" ' + (d.newline !== false ? 'checked' : '') + '> Output a newline after</label></div>';
  const exprInput = dlg.body.querySelector('#f-expr');
  exprInput.focus(); exprInput.select();
  dlg.okBtn.onclick = () => {
    d.expression = exprInput.value.trim();
    if (!d.expression) { toast('warn', ' Please enter an expression', 'error'); return; }
    d.newline = dlg.body.querySelector('#f-nl').checked;
    shape.text = getDisplayText(shape);
    renderAll(); dlg.close();
  };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openIfDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Boolean Expression (True branch goes down, False branch goes right)</label>' +
    '<textarea id="f-expr" placeholder="e.g. x > 5">' + escapeHtml(d.expression || '') + '</textarea></div>';
  const exprInput = dlg.body.querySelector('#f-expr');
  exprInput.focus(); exprInput.select();
  dlg.okBtn.onclick = () => {
    d.expression = exprInput.value.trim();
    if (!d.expression) { toast('warn', ' Please enter an expression', 'error'); return; }
    shape.text = getDisplayText(shape);
    renderAll(); dlg.close();
  };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openWhileDialog(shape) { openIfDialog(shape); }
function openDoDialog(shape) { openIfDialog(shape); }

function openForDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Variable</label>' +
    '<input type="text" id="f-var" value="' + escapeHtml(d.variable || '') + '"></div>' +
    '<div class="prop-inline">' +
    '<div class="prop-field" style="flex:1;"><label>Start Value</label><input type="text" id="f-start" value="' + escapeHtml(d.start || '') + '"></div>' +
    '<div class="prop-field" style="flex:1;"><label>End Value</label><input type="text" id="f-end" value="' + escapeHtml(d.end || '') + '"></div>' +
    '</div>' +
    '<div class="prop-inline">' +
    '<div class="prop-field" style="flex:1;"><label>Direction</label><div class="prop-radio-group">' +
    '<label class="prop-radio"><input type="radio" name="dir" value="increasing" ' + (d.direction !== 'decreasing' ? 'checked' : '') + '> Increasing</label>' +
    '<label class="prop-radio"><input type="radio" name="dir" value="decreasing" ' + (d.direction === 'decreasing' ? 'checked' : '') + '> Decreasing</label>' +
    '</div></div>' +
    '<div class="prop-field" style="flex:1;"><label>Step By</label><input type="text" id="f-step" value="' + escapeHtml(d.step || '1') + '"></div>' +
    '</div>';
  const varInput = dlg.body.querySelector('#f-var');
  varInput.focus(); varInput.select();
  dlg.okBtn.onclick = () => {
    d.variable = varInput.value.trim();
    d.start = dlg.body.querySelector('#f-start').value.trim();
    d.end = dlg.body.querySelector('#f-end').value.trim();
    d.direction = dlg.body.querySelector('input[name=dir]:checked').value;
    d.step = dlg.body.querySelector('#f-step').value.trim() || '1';
    if (!d.variable || !d.start || !d.end) { toast('warn', ' Please fill in all fields', 'error'); return; }
    shape.text = getDisplayText(shape);
    renderAll(); dlg.close();
  };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openCallDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Function Name</label>' +
    '<input type="text" id="f-func" value="' + escapeHtml(d.function || '') + '"></div>' +
    '<div class="prop-field"><label>Parameters (comma-separated expressions)</label>' +
    '<textarea id="f-params" placeholder="e.g. x, y, 10">' + escapeHtml(d.parameters || '') + '</textarea></div>';
  const funcInput = dlg.body.querySelector('#f-func');
  funcInput.focus(); funcInput.select();
  dlg.okBtn.onclick = () => {
    d.function = funcInput.value.trim();
    d.parameters = dlg.body.querySelector('#f-params').value.trim();
    if (!d.function) { toast('warn', ' Please enter a function name', 'error'); return; }
    shape.text = getDisplayText(shape);
    renderAll(); dlg.close();
  };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openCommentDialog(shape) {
  const d = shape.data;
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML =
    '<div class="prop-field"><label>Comment Text</label>' +
    '<textarea id="f-text" style="min-height:80px;">' + escapeHtml(d.text || '') + '</textarea></div>';
  const textInput = dlg.body.querySelector('#f-text');
  textInput.focus(); textInput.select();
  dlg.okBtn.onclick = () => { d.text = textInput.value; shape.text = getDisplayText(shape); renderAll(); dlg.close(); };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

function openBreakpointDialog(shape) {
  const dlg = createDialogShell(shape);
  dlg.body.innerHTML = '<p style="color:var(--fc-text-dim);font-size:13px;line-height:1.65;">A breakpoint pauses execution when reached. Click OK to keep it, or Cancel to discard.</p>';
  dlg.okBtn.onclick = () => { renderAll(); dlg.close(); };
  dlg.cancelBtn.onclick = dlg.close;
  dlg.overlay.addEventListener('click', (e) => { if (e.target === dlg.overlay) dlg.close(); });
}

const BUILTINS = {

  sqrt:(x)=>Math.sqrt(x), abs:(x)=>Math.abs(x), floor:(x)=>Math.floor(x),
  ceiling:(x)=>Math.ceil(x), round:(x)=>Math.round(x),
  max:(...a)=>Math.max(...a), min:(...a)=>Math.min(...a),
  power:(a,b)=>Math.pow(a,b),
  sin:(x)=>Math.sin(x), cos:(x)=>Math.cos(x), tan:(x)=>Math.tan(x),
  arcsin:(x)=>Math.asin(x), arccos:(x)=>Math.acos(x), arctan:(x)=>Math.atan(x),
  log:(x)=>Math.log(x), log10:(x)=>(Math.log10?Math.log10(x):Math.log(x)/Math.LN10),
  logten:(x)=>(Math.log10?Math.log10(x):Math.log(x)/Math.LN10),
  exp:(x)=>Math.exp(x),

  random:(a,b)=>{ if(b===undefined) return Math.floor(Math.random()*(a+1)); return Math.floor(Math.random()*(b-a+1))+a; },
  randomseed:(s)=>{  },

  length:(s)=>String(s).length,

  charat:(s,i)=>String(s)[Math.trunc(Number(i))]||'',

  char:(n)=>String.fromCharCode(Math.trunc(Number(n))),
  chr:(n)=>String.fromCharCode(Math.trunc(Number(n))),

  ascii:(c)=>String(c).charCodeAt(0),
  asc:(c)=>String(c).charCodeAt(0),
  indexof:(s,sub)=>String(s).indexOf(String(sub)),
  substring:(s,start,len)=>len===undefined?String(s).slice(Math.trunc(Number(start))):String(s).substr(Math.trunc(Number(start)),Math.trunc(Number(len))),
  toupper:(s)=>String(s).toUpperCase(),
  tolower:(s)=>String(s).toLowerCase(),
  trim:(s)=>String(s).trim(),

  tointeger:(x)=>parseInt(x,10),
  toreal:(x)=>parseFloat(x),
  tostring:(x)=>String(x),
  tofixedstring:(x,d)=>{ const n=Number(x); const dec=Math.max(0,Math.trunc(Number(d)||0)); return isNaN(n)?String(x):n.toFixed(dec); },

  isinteger:(x)=>{ if (typeof x==='number') return Number.isInteger(x); if (typeof x==='string') return /^-?\d+$/.test(x.trim()); return false; },
  isreal:(x)=>{ if (typeof x==='number') return !Number.isNaN(x); if (typeof x==='string') return !isNaN(parseFloat(x)) && isFinite(x); return false; },
  isnumber:(x)=>!isNaN(Number(x)),
  isstring:(x)=>typeof x==='string',
  isboolean:(x)=>typeof x==='boolean',
};

function translateToJS(expr) {
  const strings = [];
  let js = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => { strings.push(m); return '\u0000S' + strings.length + '\u0000'; });
  js = js.replace(/\u2260/g,'!=').replace(/\u2264/g,'<=').replace(/\u2265/g,'>=').replace(/\u00d7/g,'*').replace(/\u00f7/g,'/');
  js = js.replace(/\^/g,'**');
  js = js.replace(/\bmod\b/gi,'%').replace(/\bdiv\b/gi,'__ID__').replace(/\band\b/gi,'&&').replace(/\bor\b/gi,'||').replace(/\bnot\b/gi,'!').replace(/\bxor\b/gi,'!=');

  js = js.replace(/(?<!&)&(?!&)/g, '+');
  js = js.replace(/([\w.\u0000()]+)\s*__ID__\s*([\w.\u0000()]+)/g, 'Math.trunc(($1)/($2))');
  js = js.replace(/__ID__/g,'/');
  js = js.replace(/(^|[^=!<>+\-*/%&|^~])(=)([^=])/g, (m,p,_,q) => p+'=='+q);
  js = js.replace(/([^=!<>+\-*/%&|^~])=$/, '$1==');
  js = js.replace(/\u0000S(\d+)\u0000/g, (_, i) => strings[parseInt(i,10)-1]);
  return js;
}

function evalExpression(expr, vars) {
  if (!expr || !expr.trim()) throw new Error('Empty expression');
  let js = translateToJS(expr);

  const __strings = [];
  js = js.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => { __strings.push(m); return '\u0000S' + __strings.length + '\u0000'; });

  const lowerBuiltinSet = new Set(Object.keys(BUILTINS));
  const jsKeywords = new Set(['true','false','null','undefined','Math','NaN','Infinity',
    'return','if','else','while','for','do','break','continue','function','var','let',
    'const','new','this','typeof','instanceof','in','of','void','delete','throw','try',
    'catch','finally','switch','case','default','yield','await','async','class','extends',
    'super','import','export','Number','String','Boolean','Array','Object','Map','Set',
    'Date','JSON','RegExp','Error','parseInt','parseFloat','isNaN','isFinite','Symbol']);

  js = js.replace(/\b([A-Za-z_]\w*)\s*(?=\()/g, (match, name) => {
    const lower = name.toLowerCase();
    if (lowerBuiltinSet.has(lower)) return lower;
    return match;
  });

  const declaredNames = Array.from(vars.keys());
  const caseInsensitiveVars = new Map();
  declaredNames.forEach(n => caseInsensitiveVars.set(n.toLowerCase(), n));

  if (caseInsensitiveVars.size > 0) {
    js = js.replace(/\b([A-Za-z_]\w*)\b/g, (match, name, offset, full) => {

      if (jsKeywords.has(name)) return match;

      if (lowerBuiltinSet.has(name.toLowerCase())) return match;

      let i = offset - 1;
      while (i >= 0 && /\s/.test(full[i])) i--;
      if (i >= 0 && full[i] === '.') return match;

      let j = offset + name.length;
      while (j < full.length && /\s/.test(full[j])) j++;
      if (j < full.length && full[j] === '(') return match;

      const lower = name.toLowerCase();
      if (caseInsensitiveVars.has(lower)) {
        return caseInsensitiveVars.get(lower);
      }
      return match;
    });
  }

  js = js.replace(/\u0000S(\d+)\u0000/g, (_, i) => __strings[parseInt(i,10)-1]);

  const builtinNames = Object.keys(BUILTINS);
  const builtinValues = builtinNames.map(n => BUILTINS[n]);
  const declaredValues = declaredNames.map(n => vars.get(n).value);

  try {
    const fn = new Function(...builtinNames, ...declaredNames, '"use strict"; return (' + js + ');');
    return fn(...builtinValues, ...declaredValues);
  } catch (err) {
    throw new Error('Cannot evaluate "' + expr + '" — ' + err.message);
  }
}

function defaultValueForType(type) {
  switch ((type||'').toLowerCase()) {
    case 'integer': return 0;
    case 'real': return 0.0;
    case 'string': return '';
    case 'boolean': return false;
    default: return 0;
  }
}

function inferType(value) {
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'string') return 'String';
  return 'String';
}

function setVariable(name, value, forcedType) {
  const type = forcedType || inferType(value);
  const prev = State.variables.get(name);
  let coerced = value;
  if (forcedType === 'Integer' && typeof coerced === 'number') coerced = Math.trunc(coerced);
  if (forcedType === 'Boolean') coerced = !!coerced;
  State.variables.set(name, { type, value: coerced });
  if (!prev || prev.value !== coerced) State.changedVars.add(name);
}

function parseValueAsType(input, type) {
  const s = String(input).trim();
  switch ((type||'').toLowerCase()) {
    case 'integer': { const i = parseInt(s, 10); if (isNaN(i) || !/^-?\d+$/.test(s)) throw new Error('"' + s + '" is not a valid Integer'); return i; }
    case 'real': { const r = parseFloat(s); if (isNaN(r)) throw new Error('"' + s + '" is not a valid Real number'); return r; }
    case 'string': return String(input);
    case 'boolean': { const b = s.toLowerCase(); if (['true','1','yes','y','t'].includes(b)) return true; if (['false','0','no','n','f'].includes(b)) return false; throw new Error('"' + s + '" is not a valid Boolean (use true/false)'); }
    default: return input;
  }
}

function formatValue(val) {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  return String(val);
}

function startExecution() {
  const start = findStartShape();
  if (!start) { logError('No Start terminal found.'); return null; }
  State.variables.clear();
  State.changedVars.clear();
  State.execution = { currentId: start.id, lastEdge: null, done: false, error: null, iterationCount: 0, maxIterations: 100000, forStates: new Map(), doStates: new Map() };
  return State.execution;
}

async function executeStep() {
  if (!State.execution || State.execution.done) return false;
  if (State.execution.iterationCount++ > State.execution.maxIterations) {
    State.execution.error = 'Maximum iterations exceeded — possible infinite loop.';
    State.execution.done = true;
    logError(State.execution.error);
    return false;
  }
  const shape = getShape(State.execution.currentId);
  if (!shape) { State.execution.error = 'Shape not found'; State.execution.done = true; return false; }
  if (!shape.data) migrateShape(shape);
  const d = shape.data;

  try {
    switch (shape.type) {
      case 'terminal':
        if (/^start/i.test(d.text || '')) {
          State.execution.lastEdge = { from: shape.id, port: 'next' };
          State.execution.currentId = shape.next;
        } else {
          State.execution.done = true;
          logInfo('— Program finished —');
        }
        break;

      case 'comment':
        State.execution.lastEdge = { from: shape.id, port: 'next' };
        State.execution.currentId = shape.next;
        break;

      case 'breakpoint':
        logInfo('— Breakpoint reached —');
        State.execution.lastEdge = { from: shape.id, port: 'next' };
        State.execution.currentId = shape.next;
        if (State.running) { State.running = false; State.paused = true; setStatus('paused', 'Paused (breakpoint)'); }
        break;

      case 'declare': {

        const declNames = getDeclareNames(d);
        if (d.isArray) {
          const size = parseInt(d.arraySize, 10);
          const defVal = defaultValueForType(d.dataType);
          declNames.forEach(n => {

            const arr = new Array(size).fill(defVal);
            State.variables.set(n, { type: d.dataType, value: arr });
            State.changedVars.add(n);
          });
        } else {
          declNames.forEach(n => setVariable(n, defaultValueForType(d.dataType), d.dataType));
        }
        State.execution.lastEdge = { from: shape.id, port: 'next' };
        State.execution.currentId = shape.next;
        break;
      }

      case 'process': {
        const value = evalExpression(d.expression, State.variables);
        const arrMatch = d.variable.match(/^([a-zA-Z_]\w*)\[(.+)\]$/);
        if (arrMatch) {
          const arrName = arrMatch[1];
          const index = evalExpression(arrMatch[2], State.variables);
          const arr = State.variables.get(arrName);
          if (!arr) throw new Error('Array "' + arrName + '" not declared');
          if (!Array.isArray(arr.value)) throw new Error('"' + arrName + '" is not an array');
          arr.value[Math.trunc(index)] = value;
          State.changedVars.add(arrName);
        } else {

          const existing = State.variables.get(d.variable);
          if (!existing) {
            throw new Error('Variable "' + d.variable + '" has not been declared. Add a Declare statement first.');
          }
          setVariable(d.variable, value, existing.type);
        }
        State.execution.lastEdge = { from: shape.id, port: 'next' };
        State.execution.currentId = shape.next;
        break;
      }

      case 'input': {

        const existing = State.variables.get(d.variable);
        if (!existing) {
          throw new Error('Variable "' + d.variable + '" has not been declared. Add a Declare statement first.');
        }
        const effectiveType = existing.type;
        const inputVal = await promptInput(d.variable, effectiveType);
        if (inputVal === null) { State.execution.done = true; logInfo('— Program cancelled —'); break; }
        setVariable(d.variable, inputVal, effectiveType);
        State.execution.lastEdge = { from: shape.id, port: 'next' };
        State.execution.currentId = shape.next;
        break;
      }

      case 'output': {
        const val = evalExpression(d.expression, State.variables);
        const text = formatValue(val);

        logOutput(text, d.newline !== false);
        State.execution.lastEdge = { from: shape.id, port: 'next' };
        State.execution.currentId = shape.next;
        break;
      }

      case 'decision': {
        const cond = evalExpression(d.expression, State.variables);
        if (cond) { State.execution.lastEdge = { from: shape.id, port: 'next' }; State.execution.currentId = shape.next; }
        else { State.execution.lastEdge = { from: shape.id, port: 'alt' }; State.execution.currentId = shape.alt; }
        break;
      }

      case 'loop': {
        const cond = evalExpression(d.expression, State.variables);
        if (cond) { State.execution.lastEdge = { from: shape.id, port: 'next' }; State.execution.currentId = shape.next; }
        else { State.execution.lastEdge = { from: shape.id, port: 'alt' }; State.execution.currentId = shape.alt; }
        break;
      }

      case 'for': {

        let forState = State.execution.forStates.get(shape.id);
        if (!forState) {
          const startVal = evalExpression(d.start, State.variables);
          const existing = State.variables.get(d.variable);
          if (existing && existing.type !== 'Integer') {
            throw new Error('For loop variable "' + d.variable + '" must be Integer (declared as ' + existing.type + ').');
          }
          setVariable(d.variable, Math.trunc(Number(startVal)), 'Integer');
          forState = { initialized: true };
          State.execution.forStates.set(shape.id, forState);
        } else {
          const stepVal = evalExpression(d.step, State.variables);
          const currVal = State.variables.get(d.variable).value;
          const newVal = d.direction === 'decreasing' ? currVal - Math.trunc(Number(stepVal)) : currVal + Math.trunc(Number(stepVal));
          setVariable(d.variable, newVal, 'Integer');
        }
        const endVal = evalExpression(d.end, State.variables);
        const currVal = State.variables.get(d.variable).value;
        const cond = d.direction === 'decreasing' ? currVal >= endVal : currVal <= endVal;
        if (cond) { State.execution.lastEdge = { from: shape.id, port: 'next' }; State.execution.currentId = shape.next; }
        else { State.execution.forStates.delete(shape.id); State.execution.lastEdge = { from: shape.id, port: 'alt' }; State.execution.currentId = shape.alt; }
        break;
      }

      case 'do': {
        let doState = State.execution.doStates.get(shape.id);
        if (!doState) {
          doState = { visited: true };
          State.execution.doStates.set(shape.id, doState);
          State.execution.lastEdge = { from: shape.id, port: 'next' };
          State.execution.currentId = shape.next;
        } else {
          const cond = evalExpression(d.expression, State.variables);
          if (cond) { State.execution.lastEdge = { from: shape.id, port: 'next' }; State.execution.currentId = shape.next; }
          else { State.execution.doStates.delete(shape.id); State.execution.lastEdge = { from: shape.id, port: 'alt' }; State.execution.currentId = shape.alt; }
        }
        break;
      }

      case 'call':
        logInfo('[call] ' + d.function + '(' + (d.parameters || '') + ')');
        State.execution.lastEdge = { from: shape.id, port: 'next' };
        State.execution.currentId = shape.next;
        break;
    }
  } catch (err) {
    State.execution.error = err.message;
    State.execution.done = true;
    logError('Runtime error at ' + shape.type + ' "' + getDisplayText(shape) + '": ' + err.message);
    return false;
  }

  if (!State.execution.currentId) { State.execution.done = true; logInfo('— Program ended (no successor) —'); }
  return !State.execution.done;
}

function promptInput(varName, type) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const typeLabel = type || 'Auto';
    const placeholder = type === 'Boolean' ? 'true or false' : type === 'Integer' ? 'e.g. 42' : type === 'Real' ? 'e.g. 3.14' : type === 'String' ? 'type any text' : 'type a value';
    overlay.innerHTML =
      '<div class="prop-dialog" style="max-width:440px;">' +
        buildModalHeader('gold', HELP_ICONS.input, 'Input Required') +
        '<div class="prop-body">' +
          '<div class="prop-field"><label>Variable: <code style="color:#239a4d;font-family:var(--fc-mono);">' + escapeHtml(varName) + '</code> &nbsp; Type: <code style="color:#2a8a44;font-family:var(--fc-mono);">' + typeLabel + '</code></label>' +
          '<input type="text" id="input-value" autocomplete="off" spellcheck="false" placeholder="' + placeholder + '">' +
          '<div class="help-text" id="input-error" style="color:#c92a2a;display:none;font-size:11px;margin-top:6px;font-weight:500;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="prop-footer"><button class="prop-btn cancel">Cancel</button><button class="prop-btn primary submit">OK</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#input-value');
    const errEl = overlay.querySelector('#input-error');
    input.focus();
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.cancel').onclick = () => close(null);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    const submit = () => {
      const raw = input.value;
      if (raw === '') { errEl.textContent = 'Please enter a value.'; errEl.style.display = 'block'; return; }
      try {
        const parsed = parseValueAsType(raw, type);
        logInput(raw + (type ? '  [' + type + ']' : ''));
        close(parsed);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        input.focus(); input.select();
      }
    };
    overlay.querySelector('.submit').onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(null); });
  });
}

let _openConsoleLine = null;

function logLine(text, cls) {
  const c = $('#console');
  const line = document.createElement('div');
  line.className = 'console-line ' + (cls || 'console-out');
  line.textContent = text;
  c.appendChild(line);
  _openConsoleLine = null;
  c.scrollTop = c.scrollHeight;
}

function logOutput(t, newline) {

  const c = $('#console');
  const wantNewline = newline !== false;
  if (_openConsoleLine && !wantNewline) {
    _openConsoleLine.textContent += t;
  } else if (!wantNewline) {
    const line = document.createElement('div');
    line.className = 'console-line console-out';
    line.textContent = t;
    c.appendChild(line);
    _openConsoleLine = line;
  } else {
    const line = document.createElement('div');
    line.className = 'console-line console-out';
    line.textContent = t;
    c.appendChild(line);
    _openConsoleLine = null;
  }
  c.scrollTop = c.scrollHeight;
}
function logError(t) { logLine('ERROR: ' + t, 'console-err'); }
function logInfo(t) { logLine(t, 'console-info'); }
function logInput(t) { logLine('> ' + t, 'console-input'); }
function logSuccess(t) { logLine(t, 'console-success'); }
function clearConsole() { $('#console').innerHTML = ''; _openConsoleLine = null; }

async function runProgram() {
  if (State.running) return;
  if (State.execution) State.execution = null;
  clearConsole();
  State.variables.clear();
  logInfo('— Program started —');
  if (!startExecution()) { setStatus('error', 'No Start'); return; }
  State.running = true;
  $('#btn-run').disabled = true;
  $('#btn-step').disabled = true;
  $('#btn-stop').disabled = false;
  setStatus('running', 'Running...');
  while (State.running && State.execution && !State.execution.done) {
    const more = await executeStep();
    renderShapes(); renderConnections(); renderVariables();
    if (!more) break;
    if (!State.running) break;
    await sleep(State.speed);
  }
  State.running = false;
  $('#btn-run').disabled = false;
  $('#btn-step').disabled = false;
  $('#btn-stop').disabled = true;
  if (State.execution && State.execution.error) setStatus('error', 'Error');
  else if (!State.paused) { setStatus('ready', 'Done'); logSuccess('Program completed.'); }
  if (!State.paused) { setTimeout(() => { State.execution = null; renderShapes(); renderConnections(); }, 300); }
}

async function stepProgram() {
  if (!State.execution || State.execution.done) {
    clearConsole();
    State.variables.clear();
    logInfo('— Stepping —');
    if (!startExecution()) { setStatus('error', 'No Start'); return; }
    setStatus('paused', 'Paused');
  }
  const more = await executeStep();
  renderShapes(); renderConnections(); renderVariables();
  if (!more) {
    if (State.execution && State.execution.error) setStatus('error', 'Error');
    else setStatus('ready', 'Done');
  }
}

function stopProgram() {
  State.running = false;
  State.paused = false;
  if (State.execution) State.execution.done = true;
  $('#btn-run').disabled = false;
  $('#btn-step').disabled = false;
  $('#btn-stop').disabled = true;
  setStatus('ready', 'Stopped');
  logInfo('— Program stopped —');
}

function resetProgram() {
  stopProgram();
  State.execution = null;
  State.variables.clear();
  clearConsole();
  logInfo('Console cleared.');
  setStatus('ready', 'Ready');
  renderAll();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setStatus(state, text) {

  const cs = $('#console-status');
  if (cs) cs.textContent = state === 'running' ? 'running' : state === 'paused' ? 'paused' : state === 'error' ? 'error' : 'idle';
}

function stripJsoncComments(text) {

  let out = '';
  let i = 0;
  let inString = false;
  let stringDelim = '';
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {

        if (i + 1 < len) { out += next; i += 2; continue; }
      }
      if (ch === stringDelim) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringDelim = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {

      while (i < len && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {

      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function parseEmeraldCore(text) {
  const stripped = stripJsoncComments(text);
  let data;
  try {
    data = JSON.parse(stripped);
  } catch (err) {
    throw new Error('The file is not valid .emeraldcore format. ' + err.message);
  }
  if (!data || typeof data !== 'object') {
    throw new Error('The file does not contain a flowchart object.');
  }
  if (!Array.isArray(data.shapes)) {
    throw new Error('The file is missing a "shapes" array — it may be a different kind of file.');
  }
  return data;
}

function serializeEmeraldCore(data) {
  const header = [
    '// ====================================================',
    '//                  flowchart.emeraldcore',
    '// ====================================================',
    '//',
    '//',
    '// ┌─ FLOWCHART ─────────────────────────────────────┐',
    '// │                                                 │',
    '// │  shapes → list of nodes and connectors          │',
    '// │    id    → unique node/line identifier          │',
    '// │    type  → process | decision | start | end     │',
    '// │    label → text displayed inside the shape      │',
    '// │                                                 │',
    '// └─────────────────────────────────────────────────┘',
    '//',
    '//',
    '// Generated: ' + new Date().toISOString(),
    '// Shapes: ' + (data.shapes ? data.shapes.length : 0),
    '//',
    '//',
    '',
    '',
  ].join('\n');
  return header + JSON.stringify(data, null, 2);
}

function showErrorModal(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
      '<div class="prop-dialog" style="max-width:440px;">' +
        buildModalHeader('red', HELP_ICONS.error, title) +
        '<div class="prop-body" style="font-size:13px;line-height:1.65;color:var(--fc-text-dim);">' +
          '<p style="margin:0;">' + escapeHtml(message) + '</p>' +
        '</div>' +
        '<div class="prop-footer"><button class="prop-btn primary">OK</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); resolve(); };
    const escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
    const btn = overlay.querySelector('button');
    btn.onclick = close;
    btn.focus();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  });
}

function showConfirmModal(opts) {
  const title = opts.title || 'Confirm';
  const message = opts.message || '';
  const confirmLabel = opts.confirmLabel || 'Confirm';
  const cancelLabel = opts.cancelLabel || 'Cancel';
  const danger = opts.danger === true;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const confirmClass = danger ? 'prop-btn danger' : 'prop-btn primary';
    const headerVariant = danger ? 'red' : 'gold';
    const headerIcon = danger ? HELP_ICONS.error : HELP_ICONS.warning;
    overlay.innerHTML =
      '<div class="prop-dialog" style="max-width:440px;">' +
        buildModalHeader(headerVariant, headerIcon, title) +
        '<div class="prop-body" style="font-size:13px;line-height:1.65;color:var(--fc-text-dim);">' +
          '<p style="margin:0;">' + escapeHtml(message) + '</p>' +
        '</div>' +
        '<div class="prop-footer">' +
          '<button class="prop-btn cancel">' + escapeHtml(cancelLabel) + '</button>' +
          '<button class="' + confirmClass + ' ok">' + escapeHtml(confirmLabel) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', escHandler); resolve(val); };
    const escHandler = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', escHandler);
    overlay.querySelector('.cancel').onclick = () => close(false);
    const okBtn = overlay.querySelector('.ok');
    okBtn.onclick = () => close(true);
    okBtn.focus();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  });
}

function saveProgram() {
  try {
    const data = { version: 2, nextId: State.nextId, shapes: Array.from(State.shapes.values()) };
    const text = serializeEmeraldCore(data);
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flowchart.emeraldcore';

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(url), 200);
    toast('check', ' Flowchart exported as .emeraldcore', 'success');
    try { window.EmeraldHistory.action('Exported flowchart as .emeraldcore'); } catch (_) {}
  } catch (err) {
    showErrorModal('Export Failed', err.message);
  }
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function getFlowchartBounds(padding = 56) {
  if (!State.shapes.size) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  State.shapes.forEach(shape => {
    const sz = getShapeSize(shape);
    minX = Math.min(minX, shape.x);
    minY = Math.min(minY, shape.y);
    maxX = Math.max(maxX, shape.x + sz.w);
    maxY = Math.max(maxY, shape.y + sz.h);
  });
  return {
    x: minX - padding,
    y: minY - padding,
    w: Math.max(1, maxX - minX + padding * 2),
    h: Math.max(1, maxY - minY + padding * 2)
  };
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function polygonPath(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
  ctx.closePath();
}

function drawWrappedText(ctx, text, x, y, w, h, options = {}) {
  const fontSize = options.fontSize || 12.5;
  const lineHeight = options.lineHeight || 16;
  const maxLines = Math.max(1, Math.floor((h - 10) / lineHeight));
  ctx.font = (options.weight ? options.weight + ' ' : '') + fontSize + 'px "DM Mono", monospace';
  ctx.fillStyle = options.color || cssVar('--fc-text-strong', '#1f2933');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const pushLongWord = (word) => {
    let chunk = '';
    Array.from(word).forEach(ch => {
      const next = chunk + ch;
      if (ctx.measureText(next).width <= w || !chunk) {
        chunk = next;
      } else {
        lines.push(chunk);
        chunk = ch;
      }
    });
    line = chunk;
  };
  words.forEach(word => {
    const next = line ? line + ' ' + word : word;
    if (ctx.measureText(next).width <= w) {
      line = next;
    } else {
      if (line) lines.push(line);
      if (ctx.measureText(word).width > w) pushLongWord(word);
      else line = word;
    }
  });
  if (line) lines.push(line);
  if (!lines.length) lines.push('');
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines && visible.length) {
    let last = visible[visible.length - 1];
    while (last.length > 1 && ctx.measureText(last + '...').width > w) last = last.slice(0, -1);
    visible[visible.length - 1] = last + '...';
  }
  const startY = y + h / 2 - ((visible.length - 1) * lineHeight) / 2;
  visible.forEach((l, i) => ctx.fillText(l, x + w / 2, startY + i * lineHeight));
}

function drawExportConnection(ctx, fromShape, portName, toShape, label) {
  const start = getPortPos(fromShape, portName);
  const end = getPortPos(toShape, 'in');
  const dx = end.x - start.x, dy = end.y - start.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  const r = Math.min(8, adx / 2, ady / 2, 12);
  let arrowFrom = { x: start.x, y: start.y };
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  if (adx < 3 || ady < 3) {
    ctx.lineTo(end.x, end.y);
  } else if (ady >= adx) {
    const midY = start.y + dy / 2;
    const sy = dy > 0 ? 1 : -1;
    const sx = dx > 0 ? 1 : -1;
    ctx.lineTo(start.x, midY - sy * r);
    ctx.quadraticCurveTo(start.x, midY, start.x + sx * r, midY);
    ctx.lineTo(end.x - sx * r, midY);
    ctx.quadraticCurveTo(end.x, midY, end.x, midY + sy * r);
    ctx.lineTo(end.x, end.y);
    arrowFrom = { x: end.x, y: midY + sy * r };
  } else {
    const midX = start.x + dx / 2;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    ctx.lineTo(midX - sx * r, start.y);
    ctx.quadraticCurveTo(midX, start.y, midX, start.y + sy * r);
    ctx.lineTo(midX, end.y - sy * r);
    ctx.quadraticCurveTo(midX, end.y, midX + sx * r, end.y);
    ctx.lineTo(end.x, end.y);
    arrowFrom = { x: midX + sx * r, y: end.y };
  }
  ctx.strokeStyle = 'rgba(44, 62, 80, 0.62)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  const angle = Math.atan2(end.y - arrowFrom.y, end.x - arrowFrom.x);
  const arrowLen = 9;
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - arrowLen * Math.cos(angle - Math.PI / 6), end.y - arrowLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(end.x - arrowLen * Math.cos(angle + Math.PI / 6), end.y - arrowLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = 'rgba(44, 62, 80, 0.62)';
  ctx.fill();

  if (['decision', 'loop', 'for', 'do'].includes(fromShape.type) && label) {
    const lblX = start.x + (end.x - start.x) * 0.25;
    const lblY = start.y + (end.y - start.y) * 0.25;
    roundedRectPath(ctx, lblX - 8, lblY - 9, 16, 16, 3);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.font = '700 11px "DM Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--fc-text', '#2c3e50');
    ctx.fillText(label, lblX, lblY);
  }
}

function drawExportShape(ctx, shape) {
  const sz = getShapeSize(shape);
  const x = shape.x, y = shape.y, w = sz.w, h = sz.h;
  const styles = {
    terminal: [cssVar('--shape-terminal-bg', '#e9f7ef'), cssVar('--shape-terminal-bd', '#239a4d')],
    declare: [cssVar('--shape-terminal-bg', '#e9f7ef'), cssVar('--shape-terminal-bd', '#239a4d')],
    process: [cssVar('--shape-terminal-bg', '#e9f7ef'), cssVar('--shape-terminal-bd', '#239a4d')],
    input: [cssVar('--shape-input-bg', '#d6ecf5'), cssVar('--shape-input-bd', '#3b7a99')],
    output: [cssVar('--shape-output-bg', '#fff3cd'), cssVar('--shape-output-bd', '#b48608')],
    loop: [cssVar('--shape-loop-bg', '#f3e8ff'), cssVar('--shape-loop-bd', '#7c3aed')],
    for: [cssVar('--shape-loop-bg', '#f3e8ff'), cssVar('--shape-loop-bd', '#7c3aed')],
    do: [cssVar('--shape-loop-bg', '#f3e8ff'), cssVar('--shape-loop-bd', '#7c3aed')],
    decision: [cssVar('--shape-decision-bg', '#fde2e2'), cssVar('--shape-decision-bd', '#c92a2a')],
    call: [cssVar('--shape-call-bg', '#e7f0ff'), cssVar('--shape-call-bd', '#2563eb')],
    comment: ['rgba(255, 255, 255, 0.96)', 'rgba(0, 0, 0, 0.35)'],
    breakpoint: [cssVar('--shape-breakpoint-bg', '#fee2e2'), cssVar('--shape-breakpoint-bd', '#b91c1c')]
  };
  const [fill, stroke] = styles[shape.type] || styles.process;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = shape.type === 'comment' ? 1.25 : 2;
  ctx.setLineDash(shape.type === 'comment' ? [5, 4] : []);

  if (shape.type === 'terminal') {
    roundedRectPath(ctx, x, y, w, h, h / 2);
  } else if (shape.type === 'input' || shape.type === 'output') {
    polygonPath(ctx, [[x + 12, y], [x + w, y], [x + w - 12, y + h], [x, y + h]]);
  } else if (shape.type === 'decision') {
    polygonPath(ctx, [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]);
  } else if (['loop', 'for', 'do'].includes(shape.type)) {
    polygonPath(ctx, [[x + w * 0.12, y], [x + w * 0.88, y], [x + w, y + h / 2], [x + w * 0.88, y + h], [x + w * 0.12, y + h], [x, y + h / 2]]);
  } else if (shape.type === 'breakpoint') {
    polygonPath(ctx, [[x + w * 0.3, y], [x + w * 0.7, y], [x + w, y + h * 0.3], [x + w, y + h * 0.7], [x + w * 0.7, y + h], [x + w * 0.3, y + h], [x, y + h * 0.7], [x, y + h * 0.3]]);
  } else {
    roundedRectPath(ctx, x, y, w, h, shape.type === 'comment' ? 4 : 3);
  }
  ctx.fill();
  ctx.stroke();

  if (shape.type === 'declare') {
    ctx.setLineDash([]);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 5);
    ctx.lineTo(x + w - 5, y + 5);
    ctx.moveTo(x + 5, y + 5);
    ctx.lineTo(x + 5, y + h - 5);
    ctx.stroke();
  }
  if (shape.type === 'call') {
    ctx.setLineDash([]);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 3);
    ctx.lineTo(x + 10, y + h - 3);
    ctx.moveTo(x + w - 10, y + 3);
    ctx.lineTo(x + w - 10, y + h - 3);
    ctx.stroke();
  }

  const displayText = shape.type === 'terminal' ? getDisplayText(shape).toUpperCase() : getDisplayText(shape);
  drawWrappedText(ctx, displayText, x + 10, y + 4, w - 20, h - 8, {
    fontSize: shape.type === 'terminal' ? 11.5 : 12.5,
    weight: shape.type === 'terminal' ? '700' : '',
    color: shape.type === 'comment' ? cssVar('--fc-text-muted', '#64748b') : cssVar('--fc-text-strong', '#1f2933')
  });
  ctx.restore();
}

function exportFlowchartPng() {
  const bounds = getFlowchartBounds();
  if (!bounds) { toast('warn', ' Nothing to export yet.', 'error'); return; }
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bounds.w * scale);
  canvas.height = Math.ceil(bounds.h * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-bounds.x, -bounds.y);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);

  State.shapes.forEach(shape => {
    if (shape.next) {
      const to = getShape(shape.next);
      if (to) drawExportConnection(ctx, shape, 'next', to, 'T');
    }
    if (shape.alt) {
      const to = getShape(shape.alt);
      if (to) drawExportConnection(ctx, shape, 'alt', to, 'F');
    }
  });
  Array.from(State.shapes.values())
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .forEach(shape => drawExportShape(ctx, shape));

  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.download = 'flowchart-' + date + '.png';
  a.href = canvas.toDataURL('image/png');
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('check', ' Flowchart exported as PNG', 'success');
  try { window.EmeraldHistory.action('Exported flowchart as PNG'); } catch (_) {}
}

function loadProgram() {
  const input = $('#file-input');

  input.onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.emeraldcore')) {
      showErrorModal('Unsupported File', 'Only .emeraldcore files can be imported. Please select a file with the .emeraldcore extension.');
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = parseEmeraldCore(ev.target.result);
        State.shapes.clear();
        State.nextId = data.nextId || 1;
        data.shapes.forEach(s => {
          if (!s.data) migrateShape(s);
          if (!s.text) s.text = getDisplayText(s);
          State.shapes.set(s.id, s);
        });
        renderAll();
        toast('check', ' Flowchart imported', 'success');
        try { window.EmeraldHistory.action('Imported a flowchart'); } catch (_) {}
      } catch (err) {
        await showErrorModal('Import Failed', err.message);
      }
    };
    reader.onerror = async () => {
      await showErrorModal('Import Failed', 'Could not read the selected file.');
    };
    reader.readAsText(file);
  };
  input.click();
}

function createStarterTemplate() {
  State.shapes.clear();
  State.nextId = 1;
  State.selectedId = null;

  const STEP = 80;

  const s = createShape('terminal', 0, 0);
  s.data = { text: 'Start' };
  const o = createShape('output', 0, STEP);
  o.data = { expression: '"Hello"', newline: true };
  const e = createShape('terminal', 0, STEP * 2);
  e.data = { text: 'End' };
  s.next = o.id; o.next = e.id;

  State.shapes.forEach(sh => { sh.text = getDisplayText(sh); });
}

function centerViewOnShapes() {
  if (State.shapes.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  State.shapes.forEach(sh => {
    const el = document.querySelector('.shape[data-id="' + sh.id + '"]');
    const w = el ? el.offsetWidth : getShapeSize(sh).w;
    const h = el ? el.offsetHeight : getShapeSize(sh).h;
    minX = Math.min(minX, sh.x);
    minY = Math.min(minY, sh.y);
    maxX = Math.max(maxX, sh.x + w);
    maxY = Math.max(maxY, sh.y + h);
  });
  const wrap = $('#canvas-wrap');
  State.pan.x = Math.round((wrap.clientWidth - (maxX - minX) * State.zoom) / 2 - minX * State.zoom);
  State.pan.y = Math.round((wrap.clientHeight - (maxY - minY) * State.zoom) / 2 - minY * State.zoom);
  applyPan();
  renderConnections();
}

function newProgram() {
  createStarterTemplate();
  renderAll();
  centerViewOnShapes();
  toast('check', ' Canvas cleared', 'success');
  try { window.EmeraldHistory.action('Cleared the flowchart'); } catch (_) {}
}

function loadExample() {
  State.shapes.clear();
  State.nextId = 1;
  const start = createShape('terminal', 300, 30);
  start.data = { text: 'Start' };
  const decl = createShape('declare', 300, 100);
  decl.data = { names: ['n', 'sum'], dataType: 'Integer', isArray: false, arraySize: 0 };
  const inp = createShape('input', 300, 170);
  inp.data = { variable: 'n' };
  const init = createShape('process', 300, 310);
  init.data = { variable: 'sum', expression: '0' };
  const forl = createShape('for', 300, 380);
  forl.data = { variable: 'i', start: '1', end: 'n', direction: 'increasing', step: '1' };
  const add = createShape('process', 480, 470);
  add.data = { variable: 'sum', expression: 'sum + i' };
  const out = createShape('output', 300, 470);
  out.data = { expression: '"Sum of 1 to " + n + " = " + sum', newline: true };
  const end = createShape('terminal', 300, 550);
  end.data = { text: 'End' };
  start.next = decl.id; decl.next = inp.id; inp.next = init.id; init.next = forl.id;
  forl.next = add.id; forl.alt = out.id; add.next = forl.id; out.next = end.id;
  State.shapes.forEach(s => s.text = getDisplayText(s));
  renderAll();
  toast('check', ' Example loaded', 'success');
}

function loadArrayExample() {
  State.shapes.clear();
  State.nextId = 1;
  const start = createShape('terminal', 300, 30);
  start.data = { text: 'Start' };
  const decl = createShape('declare', 300, 100);
  decl.data = { name: 'nums', dataType: 'Integer', isArray: true, arraySize: 5 };
  const decl2 = createShape('declare', 300, 170);
  decl2.data = { names: ['i', 'total'], dataType: 'Integer', isArray: false, arraySize: 0 };
  const init = createShape('process', 300, 240);
  init.data = { variable: 'total', expression: '0' };
  const forl = createShape('for', 300, 380);
  forl.data = { variable: 'i', start: '0', end: '4', direction: 'increasing', step: '1' };
  const assign = createShape('process', 480, 470);
  assign.data = { variable: 'nums[i]', expression: 'i * 10' };
  const add = createShape('process', 480, 540);
  add.data = { variable: 'total', expression: 'total + nums[i]' };
  const out = createShape('output', 300, 470);
  out.data = { expression: '"Array: [" + nums[0] + ", " + nums[1] + ", " + nums[2] + ", " + nums[3] + ", " + nums[4] + "]"', newline: true };
  const out2 = createShape('output', 300, 540);
  out2.data = { expression: '"Total = " + total', newline: true };
  const end = createShape('terminal', 300, 620);
  end.data = { text: 'End' };
  start.next = decl.id; decl.next = decl2.id; decl2.next = init.id; init.next = forl.id;
  forl.next = assign.id; forl.alt = out.id; assign.next = add.id; add.next = forl.id; out.next = out2.id; out2.next = end.id;
  State.shapes.forEach(s => s.text = getDisplayText(s));
  renderAll();
  toast('check', ' Array example loaded', 'success');
}

$('#btn-run').onclick = runProgram;
$('#btn-step').onclick = stepProgram;
$('#btn-stop').onclick = stopProgram;
$('#btn-reset').onclick = resetProgram;
$('#btn-clear-console').onclick = clearConsole;

$('#btn-save').onclick = saveProgram;
$('#btn-export-png').onclick = exportFlowchartPng;
$('#btn-open').onclick = loadProgram;
$('#btn-clear').onclick = async () => {
  if (State.shapes.size > 0) {
    const ok = await showConfirmModal({
      title: 'Clear Canvas?',
      message: 'This will remove all shapes from the canvas and cannot be undone. Make sure you have saved your work first.',
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
  }
  newProgram();
};

$('#speed-slider').oninput = (e) => {
  const v = parseInt(e.target.value);
  State.speed = Math.round(500 - (v / 100) * 495);
  $('#speed-display').textContent = State.speed + 'ms';
  persistStateDebounced(300);
};
$('#speed-slider').dispatchEvent(new Event('input'));

const menus = {
  file: [
    { label: 'New', action: newProgram },
    { label: 'Open...', action: loadProgram },
    { label: 'Save...', action: saveProgram },
    { sep: true },
    { label: 'Load Example (For Loop)', action: loadExample },
    { label: 'Load Array Example', action: loadArrayExample },
  ],
  edit: [
    { label: 'Edit Properties', action: () => { if (State.selectedId) openPropertyDialog(State.selectedId); } },
    { label: 'Delete Shape', action: () => { if (State.selectedId) deleteShape(State.selectedId); } },
    { sep: true },
    { label: 'Clear Console', action: clearConsole },
  ],
  help: [
    { label: 'Quick Start Guide', action: showHelp },
    { label: 'Syntax Reference', action: showSyntaxHelp },
    { label: 'Keyboard Shortcuts', action: showShortcuts },
    { sep: true },
    { label: 'About FlowCode', action: showAbout },
  ],
};

$$('.menu-btn').forEach(btn => {
  btn.onclick = (e) => {
    e.stopPropagation();
    const name = btn.dataset.menu;
    const rect = btn.getBoundingClientRect();
    showMenuDropdown(name, rect.left, rect.bottom);
  };
});

function showMenuDropdown(name, x, y) {
  hideContextMenu();
  const menu = $('#context-menu');
  const items = menus[name] || [];
  menu.innerHTML = items.map(it => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    return '<div class="ctx-item">' + escapeHtml(it.label) + '</div>';
  }).join('');
  positionContextMenu(menu, x, y);
  menu.querySelectorAll('.ctx-item').forEach((el, i) => {
    el.onclick = () => { const item = items[i]; if (item && item.action) item.action(); hideContextMenu(); };
  });
}

function buildModalHeader(variant, iconSvg, title) {
  const colors = {
    green:  '#239a4d',
    blue:   '#005fa3',
    gold:   '#b48608',
    red:    '#ee5a52',
    purple: '#7c5cb8',
  };
  const bg = colors[variant] || colors.green;
  return '<div class="prop-header">' +
    '<div class="prop-shape-icon" style="background:' + bg + ';box-shadow:0 4px 12px ' + bg + '40;">' + iconSvg + '</div>' +
    '<h3 class="prop-title">' + escapeHtml(title) + '</h3>' +
  '</div>';
}

const HELP_ICONS = {
  guide: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
  syntax: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  keyboard: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>',
  about: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  input: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  error: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  warning: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
};

function showHelp() {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = '<div class="prop-dialog" style="max-width:560px;">' + buildModalHeader('blue', HELP_ICONS.guide, 'Quick Start Guide') +
    '<div class="prop-body" style="font-size:13px;line-height:1.75;color:rgba(44,62,80,0.7);">' +
    '<p><b style="color:var(--fc-text);">1. Add shapes:</b> Click a shape in the left palette, or drag it onto the canvas.</p>' +
    '<p style="margin-top:10px;"><b style="color:var(--fc-text);">2. Edit properties:</b> Double-click any shape on the canvas to open its properties dialog. Each shape has its own dialog with the right fields.</p>' +
    '<p style="margin-top:10px;"><b style="color:var(--fc-text);">3. Connect shapes:</b> Hover over a shape to see the green handle (pill-shaped). Drag from the handle onto another shape to connect. If/Loop/For/Do shapes have two handles: bottom = True, right = False.</p>' +
    '<p style="margin-top:10px;"><b style="color:var(--fc-text);">4. Insert on a line:</b> Click any connection line to insert a new shape in between — a menu pops up with shape options.</p>' +
    '<p style="margin-top:10px;"><b style="color:var(--fc-text);">5. Pan the canvas:</b> Hold <kbd>Space</kbd> and drag with the mouse to move the whole view around.</p>' +
    '<p style="margin-top:10px;"><b style="color:var(--fc-text);">6. Run:</b> Click the Run or Step button in the bottom toolbar to execute. Watch variables update in the bottom-right panel.</p>' +
    '<p style="margin-top:10px;"><b style="color:var(--fc-text);">7. Generated code:</b> Watch the bottom-left Code panel update live as you build your flowchart.</p>' +
    '</div><div class="prop-footer"><button class="prop-btn primary">Got it</button></div></div>';
  document.body.appendChild(o);
  o.querySelector('button').onclick = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
}

function showSyntaxHelp() {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = '<div class="prop-dialog" style="max-width:620px;">' + buildModalHeader('purple', HELP_ICONS.syntax, 'Syntax Reference') +
    '<div class="prop-body" style="font-size:12.5px;line-height:1.8;color:rgba(44,62,80,0.7);max-height:55vh;overflow-y:auto;">' +
    '<div style="font-weight:700;color:var(--fc-text);margin-bottom:6px;">Data Types</div>' +
    '<div style="font-family:var(--fc-mono);">' +
      '<div><span style="color:#2a8a44;">Integer</span> — whole numbers: 5, 42, -7</div>' +
      '<div><span style="color:#3b7a99;">Real</span> — decimals: 3.14, 0.5</div>' +
      '<div><span style="color:#b48608;">String</span> — text: "hello", "Bob"</div>' +
      '<div><span style="color:#7c5cb8;">Boolean</span> — true or false</div>' +
      '<div><span style="color:#c97a3a;">Array</span> — check "Array?" in Declare dialog</div>' +
    '</div>' +
    '<div style="font-weight:700;color:var(--fc-text);margin:12px 0 6px;">Operators</div>' +
    '<div style="font-family:var(--fc-mono);">' +
      '<div>+ - * / mod div ^ (power) &nbsp;|&nbsp; &amp; (string concat)</div>' +
      '<div>= == != &lt; &gt; &lt;= &gt;= &nbsp;|&nbsp; ≠ ≤ ≥ × ÷</div>' +
      '<div>and or not xor (logical)</div>' +
    '</div>' +
    '<div style="font-weight:700;color:var(--fc-text);margin:12px 0 6px;">Built-in Functions</div>' +
    '<div style="font-family:var(--fc-mono);font-size:11.5px;">' +
      '<div>sqrt abs floor ceiling round power max min random randomseed</div>' +
      '<div>sin cos tan arcsin arccos arctan log log10 logten exp</div>' +
      '<div>length char charat ascii asc chr substring toupper tolower trim indexof</div>' +
      '<div>tointeger toreal tostring tofixedstring</div>' +
      '<div>isinteger isreal isstring isboolean isnumber</div>' +
      '<div style="color:rgba(44,62,80,0.55);margin-top:4px;">Function names are case-insensitive (Flowgorithm-compatible).</div>' +
    '</div>' +
    '<div style="font-weight:700;color:var(--fc-text);margin:12px 0 6px;">Array Access</div>' +
    '<div style="font-family:var(--fc-mono);">nums[i] = 10 &nbsp; arr[0] + arr[1]</div>' +
    '</div><div class="prop-footer"><button class="prop-btn primary">Close</button></div></div>';
  document.body.appendChild(o);
  o.querySelector('button').onclick = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
}

function showShortcuts() {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  const row = (label, key) => '<div style="display:flex;justify-content:space-between;align-items:center;"><span>' + label + '</span><code style="background:var(--fc-accent-soft);padding:3px 10px;border-radius:5px;color:var(--fc-accent);font-family:var(--fc-mono);font-weight:600;font-size:11px;">' + key + '</code></div>';
  o.innerHTML = '<div class="prop-dialog" style="max-width:420px;">' + buildModalHeader('gold', HELP_ICONS.keyboard, 'Keyboard Shortcuts') +
    '<div class="prop-body" style="font-size:13px;line-height:2.1;color:rgba(44,62,80,0.7);">' +
      row('Delete shape', 'Del') +
      row('Edit properties', 'Double-click / Enter') +
      row('Cancel', 'Esc') +
    '</div><div class="prop-footer"><button class="prop-btn primary">Close</button></div></div>';
  document.body.appendChild(o);
  o.querySelector('button').onclick = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
}

function showAbout() {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = '<div class="prop-dialog" style="max-width:400px;text-align:center;">' + buildModalHeader('green', HELP_ICONS.about, 'About EmeraldStudio Flowchart') +
    '<div class="prop-body" style="padding:8px 8px 16px;">' +
      '<div style="font-size:11px;color:var(--fc-text-muted);margin-bottom:14px;letter-spacing:0.04em;">Part of EmeraldSuite</div>' +
      '<div style="font-size:13px;color:rgba(44,62,80,0.7);line-height:1.7;">A visual flowchart programming environment inspired by Flowgorithm. Build, run, and debug algorithms visually — right in your browser.</div>' +
    '</div><div class="prop-footer"><button class="prop-btn primary">Close</button></div></div>';
  document.body.appendChild(o);
  o.querySelector('button').onclick = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
}

async function init() {
  if (window.EmeraldAuth?.ready) await window.EmeraldAuth.ready();
  ensureArrowhead($('#connections'));
  let loaded = false;
  try {
    loaded = await loadPersistedState();
  } catch (err) {
    console.warn('[FlowCode] Failed to load persisted state:', err);
  }
  _persistenceReady = true;

  const isFreshStart = !loaded || State.shapes.size === 0;
  if (isFreshStart) {
    createStarterTemplate();
  }
  renderAll();

  if (isFreshStart) centerViewOnShapes();
  if (window.EmeraldIDBStorage?.subscribe) {
    window.EmeraldIDBStorage.subscribe(async function (change) {
      if (!change || change.key !== STORAGE_KEY || change.type !== 'import') return;
      _remoteRefreshPending = true;
      await applyPendingRemoteState();
    });
  }

  window.addEventListener('beforeunload', () => {
    if (_persistDebounceTimer) { clearTimeout(_persistDebounceTimer); _persistDebounceTimer = null; }
    persistState();
  });
  window.addEventListener('resize', () => { ensureArrowhead($('#connections')); renderConnections(); });
}
init();
