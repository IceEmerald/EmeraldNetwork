(function () {
    'use strict';

    const TAB = Array.from(crypto.getRandomValues(new Uint32Array(2)), function (n) { return n.toString(36); }).join('');

    const APPS = {
        notes: {
            name: 'EmeraldNotes', file: '/notes', label: 'Note', urlLabel: 'Notes',
            color: '#a21caf',
            soft: 'rgba(162,28,175,0.10)',
            border: 'rgba(162,28,175,0.32)',
            fill: 'rgba(162,28,175,0.26)',
            empty: '/assets/images/nonotes.webp',
            emptyAction: '/notes',
            emptyCta: 'Create a note'
        },
        docs: {
            name: 'EmeraldDocs', file: '/docs', label: 'Document', urlLabel: 'Documents',
            color: '#0891b2',
            soft: 'rgba(8,145,178,0.10)',
            border: 'rgba(8,145,178,0.32)',
            fill: 'rgba(8,145,178,0.26)',
            empty: '/assets/images/nodocs.webp',
            emptyAction: '/docs',
            emptyCta: 'Create a document'
        },
        slides: {
            name: 'EmeraldSlides', file: '/slides', label: 'Presentation', urlLabel: 'Presentations',
            color: '#f97316',
            soft: 'rgba(249,115,22,0.10)',
            border: 'rgba(249,115,22,0.32)',
            fill: 'rgba(249,115,22,0.26)',
            empty: '/assets/images/noslides.webp',
            emptyAction: '/slides',
            emptyCta: 'Create a presentation'
        },
        sheets: {
            name: 'EmeraldSheets', file: '/sheets', label: 'Spreadsheet', urlLabel: 'Spreadsheets',
            color: '#217346',
            soft: 'rgba(33,115,70,0.10)',
            border: 'rgba(33,115,70,0.32)',
            fill: 'rgba(33,115,70,0.26)',
            empty: '/assets/images/nosheets.webp',
            emptyAction: '/sheets',
            emptyCta: 'Create a spreadsheet'
        }
    };

    const KEY_TO_TYPE = {
        'emeraldcore.storage.suite.notes': 'notes',
        'emeraldcore.storage.suite.docs': 'docs',
        'emeraldcore.storage.suite.slides': 'slides'
    };

    const SVG = {
        note: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>',
        doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>',
        slide: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
        sheet: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>',
        open: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        ctrl: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>',
        link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
        pen: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
        check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    };

    const state = {
        files: [],
        filter: 'all',
        filters: new Set(),
        search: '',
        sort: 'recent',
        syncing: false,
        currentFile: null
    };

    let syncChannel = null;
    if (typeof BroadcastChannel !== 'undefined') {
        syncChannel = new BroadcastChannel('emeraldsuite-sync');
    }

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function storage() { return window.EmeraldIDBStorage || null; }

    async function driveTrashMap() {
        const s = storage();
        const value = s && s.getJSON ? await s.getJSON('emerald.drive.trash') : {};
        return value && typeof value === 'object' ? value : {};
    }

    function toTs(v) {
        if (!v) return 0;
        const t = typeof v === 'string' ? Date.parse(v) : Number(v);
        return Number.isFinite(t) ? t : 0;
    }

    function plainHtml(html) {
        if (!html) return '';
        const ta = document.createElement('textarea');
        ta.textContent = String(html);
        return ta.value.replace(/\s+/g, ' ').trim();
    }

    function countWords(html) {
        const t = plainHtml(html);
        if (!t) return 0;
        return t.split(/\s+/).filter(Boolean).length;
    }

    function timeAgo(ts) {
        if (!ts) return 'never edited';
        const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (s < 10) return 'just now';
        if (s < 60) return s + 's ago';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ago';
        const d = Math.floor(h / 24);
        if (d === 1) return 'yesterday';
        if (d < 30) return d + 'd ago';
        return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function toast(message) {
        const toastEl = $('custom-toast');
        if (!toastEl) return;
        toastEl.innerHTML = message;
        toastEl.classList.add('show');
        clearTimeout(toastEl._t);
        toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 4000);
    }

    function appIcon(type) { return SVG[type] || SVG[String(type || '').replace(/s$/, '')] || SVG.doc; }

    async function loadNotes() {
        const s = storage();
        let raw = null;
        if (s) raw = await s.getJSON('emeraldcore.storage.suite.notes');
        const trash = await driveTrashMap();
        const arr = Array.isArray(raw) ? raw : [];
        return arr
            .filter(n => n && n.id && !n._isCollabNote && !trash['notes:' + n.id])
            .map(n => ({
                type: 'notes',
                id: String(n.id),
                title: (n.title || '').trim() || 'Untitled note',

                updatedAt: toTs(n.modifiedAt || n.createdAt || n.updatedAt),
                detail: countWords(n.content) + ' words'
            }));
    }

    async function loadDocs() {
        const s = storage();
        let raw = null;
        if (s) raw = await s.getJSON('emeraldcore.storage.suite.docs');
        const trash = await driveTrashMap();
        const arr = Array.isArray(raw) ? raw : [];
        return arr
            .filter(m => m && m.id && !trash['docs:' + m.id])
            .map(m => ({
                type: 'docs',
                id: String(m.id),
                title: (m.title || '').trim() || 'Untitled document',
                updatedAt: toTs(m.updatedAt),
                detail: (m.wordCount || 0) + ' words'
            }));
    }

    async function loadSlides() {
        const s = storage();
        let raw = null;
        if (s) raw = await s.getJSON('emeraldcore.storage.suite.slides');
        const trash = await driveTrashMap();
        const arr = Array.isArray(raw) ? raw : [];
        return arr
            .filter(m => m && m.id && !trash['slides:' + m.id])
            .map(m => {

                const n = Number(m.slideCount) || 0;
                return {
                    type: 'slides',
                    id: String(m.id),
                    title: (m.title || '').trim() || 'Untitled presentation',
                    updatedAt: toTs(m.updatedAt),
                    detail: n + (n === 1 ? ' slide' : ' slides')
                };
            });
    }

    function openSheetDB() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
            const rq = indexedDB.open('emeraldcore.storage.suite.sheets', 1);
            rq.onupgradeneeded = () => {
                const db = rq.result;
                if (!db.objectStoreNames.contains('workbooks')) {
                    db.createObjectStore('workbooks');
                }
            };
            rq.onsuccess = () => resolve(rq.result);
            rq.onerror = () => reject(rq.error);
        });
    }

    function idbReq(rq) {
        return new Promise((resolve, reject) => {
            rq.onsuccess = () => resolve(rq.result);
            rq.onerror = () => reject(rq.error);
        });
    }

    function sheetMini(data) {
        const sheets = (data && data.sheets) || [];
        const visible = sheets.filter(s => !s.hidden);
        const sh = visible[0] || sheets[0] || {};
        const cells = (sh && sh.cells) || {};
        const COLS = 6, ROWS = 4;
        let any = false;
        for (const k in cells) { any = true; break; }
        const out = [];
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const cell = cells[r + ',' + c];
                const filled = !!(cell && (cell.v != null || cell.f));
                out.push({ hdr: any && (r === 0 || c === 0) && filled, filled });
            }
        }
        return out;
    }

    async function loadSheets() {
        try {
            const db = await openSheetDB();
            const store = db.transaction('workbooks').objectStore('workbooks');
            const keys = await idbReq(store.getAllKeys());
            const vals = await idbReq(store.getAll());
            const trash = await driveTrashMap();
            const out = [];
            for (let i = 0; i < keys.length; i++) {
                const d = vals[i];
                if (!d || typeof d !== 'object' || trash['sheets:' + keys[i]]) continue;
                const data = (d && d.data) || {};
                const sheets = (data.sheets || []);
                out.push({
                    type: 'sheets',
                    id: String(keys[i]),
                    title: (data.title || '').trim() || 'Untitled spreadsheet',
                    updatedAt: toTs(d.savedAt || data.createdAt),
                    detail: sheets.length + (sheets.length === 1 ? ' sheet' : ' sheets'),
                    mini: sheetMini(data)
                });
            }
            return out;
        } catch (e) {
            return [];
        }
    }

    function setSyncing(on) {
        state.syncing = on;
        const el = $('syncIndicator');
        const text = $('syncText');
        if (!el) return;
        el.classList.toggle('syncing', on);
        if (text) text.textContent = on ? 'Syncing…' : 'All changes synced';
    }

    async function refresh(opts) {
        opts = opts || {};
        if (state.syncing && opts.silent !== true) return;
        setSyncing(true);
        let notes = [], docs = [], slides = [], sheets = [];
        try {
            [notes, docs, slides, sheets] = await Promise.all([
                loadNotes(), loadDocs(), loadSlides(), loadSheets()
            ]);
        } catch (e) {
            console.error('[EmeraldSuite] refresh failed:', e);
        }
        let files = notes.concat(docs, slides, sheets);
        files.forEach(f => { if (!f.updatedAt) f.updatedAt = 0; });
        files.sort((a, b) => (b.updatedAt - a.updatedAt));
        state.files = files;

        setSyncing(false);
        render();
    }

    function postSync() {
        if (syncChannel) {
            try { syncChannel.postMessage({ type: 'changed', by: TAB, at: Date.now() }); } catch (e) {}
        }
    }

    function findIn(arr, id) {
        return arr.find(x => x && String(x.id) === id);
    }

    async function renameFile(f, title) {
        const t = (title || '').trim();
        if (!t) { toast('Name cannot be empty'); return false; }
        const s = storage();
        if (f.type === 'notes') {
            let arr = s ? (await s.getJSON('emeraldcore.storage.suite.notes')) : null;
            arr = Array.isArray(arr) ? arr : [];
            const n = findIn(arr, f.id);
            if (n) { n.title = t; n.updatedAt = new Date().toISOString(); }
            if (s) { s.setJSONSync('emeraldcore.storage.suite.notes', arr); }
        } else if (f.type === 'docs') {
            let arr = s ? (await s.getJSON('emeraldcore.storage.suite.docs')) : null;
            arr = Array.isArray(arr) ? arr : [];
            const m = findIn(arr, f.id);
            if (m) { m.title = t; m.updatedAt = Date.now(); }
            if (s) { await s.setJSON('emeraldcore.storage.suite.docs', arr); }
            try {
                const dk = 'emeraldcore.storage.suite.docs.' + f.id;
                const data = s ? await s.getJSON(dk) : null;
                if (data) {
                    data.title = t;
                    if (s) { await s.setJSON(dk, data); }
                }
            } catch (e) {}
        } else if (f.type === 'slides') {
            let arr = s ? (await s.getJSON('emeraldcore.storage.suite.slides')) : null;
            arr = Array.isArray(arr) ? arr : [];
            const m = findIn(arr, f.id);
            if (m) { m.title = t; m.updatedAt = Date.now(); }
            if (s) { await s.setJSON('emeraldcore.storage.suite.slides', arr); }
            try {
                const pk = 'emeraldcore.storage.suite.slides.' + f.id;
                const data = s ? await s.getJSON(pk) : null;
                if (data) {
                    data.title = t;
                    if (s) { await s.setJSON(pk, data); }
                }
            } catch (e) {}
        } else if (f.type === 'sheets') {
            try {
                const db = await openSheetDB();
                const doc = await idbReq(db.transaction('workbooks').objectStore('workbooks').get(f.id));
                if (doc && doc.data) {
                    doc.data.title = t;
                    doc.savedAt = Date.now();
                    const store = db.transaction('workbooks', 'readwrite').objectStore('workbooks');
                    store.put(doc, f.id);
                }
            } catch (e) { console.warn('[EmeraldSuite] rename sheets failed', e); }
            postSync();
        }
        return true;
    }

    async function deleteFile(f) {
        const s = storage();
        if (!s || !s.setJSON) return false;
        const trash = await driveTrashMap();
        trash[f.type + ':' + f.id] = Date.now();
        await s.setJSON('emerald.drive.trash', trash);
        return true;
    }

    function fileUrl(f) {
        const app = APPS[f.type];
        return app.file + '?owned=' + encodeURIComponent(f.id);
    }

    function openFile(f) {
        location.href = fileUrl(f);
    }

    function visibleFiles() {
        let files = state.files.slice();
        if (state.filters.size && state.filter !== 'all') {
            files = files.filter(f => state.filters.has(f.type));
        }
        if (state.search) {
            const q = state.search.toLowerCase();
            files = files.filter(f => f.title.toLowerCase().includes(q));
        }
        if (state.sort === 'name') files.sort((a, b) => a.title.localeCompare(b.title));
        else if (state.sort === 'nameDesc') files.sort((a, b) => b.title.localeCompare(a.title));
        else files.sort((a, b) => (b.updatedAt - a.updatedAt));
        return files;
    }

    function thumbHTML(f) {
        const app = APPS[f.type];
        const style = '--c:' + app.color + ';--soft:' + app.soft + ';--border:' + app.border + ';--soft2:' + app.fill;
        if (f.type === 'notes') {
            const widths = [62, 86, 72, 92, 60];
            const inner = widths.map((w, idx) =>
                idx === 0 ? '<b style="width:' + w + '%"></b>' : '<i style="width:' + w + '%"></i>'
            ).join('');
            return '<div class="mini-wrap"><div class="mini-note" style="' + style + '">' + inner + '</div></div>';
        }
        if (f.type === 'docs') {
            return '<div class="mini-wrap"><div class="mini-doc" style="' + style + '"><b></b><i></i><i></i><i></i><i></i><i></i></div></div>';
        }
        if (f.type === 'slides') {
            return '<div class="mini-wrap"><div class="mini-slide" style="' + style + '">' +
                '<div class="slide-bar"><i></i></div><div class="slide-body"><i></i><i></i><i></i></div></div></div>';
        }

        const cells = (f.mini || []).map(c =>
            '<div class="wb-cell' + (c.hdr ? ' hdr' : '') + (c.filled ? ' filled' : '') + '"></div>'
        ).join('');
        return '<div class="mini-wrap" style="' + style + '"><div class="wb-mini">' + cells + '</div></div>';
    }

    function cardHTML(f, cls) {
        const app = APPS[f.type];
        const typ = {
            notes: 'Note', docs: 'Document', slides: 'Presentation', sheets: 'Spreadsheet'
        }[f.type];
        return '<article class="' + (cls || 'file-card') + '" role="listitem" tabindex="0" data-type="' + f.type + '" data-id="' + esc(f.id) + '" style="--c:' + app.color + ';--soft:' + app.soft + ';--border:' + app.border + '">' +
            '<div class="card-thumb">' +
                '<span class="type-flare"></span>' +
                '<div class="card-actions">' +
                    '<button data-action="open" title="Open in ' + app.name + '">' + SVG.open + '</button>' +
                    '<button data-action="rename" title="Rename">' + SVG.pen + '</button>' +
                    '<button data-action="delete" title="Delete">' + SVG.trash + '</button>' +
                '</div>' +
                thumbHTML(f) +
            '</div>' +
            '<div class="card-body">' +
                '<div class="card-title" title="' + esc(f.title) + '">' + esc(f.title) + '</div>' +
                '<div class="card-meta"><span class="dot"></span>' + esc(typ) + ' · ' + esc(f.detail) + ' · ' + esc(timeAgo(f.updatedAt)) + '</div>' +
            '</div>' +
        '</article>';
    }

    function rowHTML(f) {
        const app = APPS[f.type];
        const typ = {
            notes: 'Note', docs: 'Document', slides: 'Presentation', sheets: 'Spreadsheet'
        }[f.type];
        return '<article class="file-row" role="listitem" tabindex="0" data-type="' + f.type + '" data-id="' + esc(f.id) + '" style="--c:' + app.color + ';--soft:' + app.soft + ';--border:' + app.border + '">' +
            '<div class="row-thumb">' +
                '<div class="card-actions">' +
                    '<button data-action="open" title="Open in ' + app.name + '">' + SVG.open + '</button>' +
                    '<button data-action="rename" title="Rename">' + SVG.pen + '</button>' +
                    '<button data-action="delete" title="Delete">' + SVG.trash + '</button>' +
                '</div>' +
                thumbHTML(f) +
            '</div>' +
            '<div class="row-main">' +
                '<div class="row-title" title="' + esc(f.title) + '">' + esc(f.title) + '</div>' +
                '<div class="row-meta">' + esc(typ) + ' · ' + esc(f.detail) + '</div>' +
            '</div>' +
            '<div class="row-time">' + esc(timeAgo(f.updatedAt)) + '</div>' +
        '</article>';
    }

    function render() {
        renderRecent();
        renderFilters();
        renderGrid();
        $('recentGrid')?.removeAttribute('aria-busy');
        $('filesGrid')?.removeAttribute('aria-busy');
    }

    function renderRecent() {
        const grid = $('recentGrid');
        const empty = $('recentEmpty');
        if (!grid) return;
        const recent = state.files.slice()
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 3);
        grid.innerHTML = '';
        if (empty) empty.hidden = recent.length > 0;
        recent.forEach(f => grid.appendChild(elFromHTML(cardHTML(f, 'recent-card'))));
    }

    function elFromHTML(html) {
        const t = document.createElement('template');
        t.innerHTML = html.trim();
        return t.content.firstElementChild;
    }

    function renderFilters() {
        const btns = document.querySelectorAll('.filter-btn');
        btns.forEach(b => {
            const v = b.dataset.filter;
            b.classList.toggle('active', v === 'all' ? state.filter === 'all' : state.filters.has(v));
        });
    }

    function renderGrid() {
        const grid = $('filesGrid');
        const empty = $('emptyState');
        if (!grid) return;

        const files = visibleFiles();

        if (files.length === 0) {
            grid.innerHTML = '';
            empty.hidden = false;
            const app = state.filter !== 'all' && state.filters.size === 1 ? APPS[[...state.filters][0]] : null;
            const title = $('emptyTitle');
            const text = $('emptyText');
            if (state.search) {
                title.textContent = 'No matching files';
                text.textContent = 'Nothing matched “' + esc(state.search) + '”. Try a different search.';
                const img = $('emptyStateImg');
                if (img) { img.src = '/assets/images/nofilefound.webp'; img.hidden = false; }
            } else if (app) {
                title.textContent = 'No ' + app.urlLabel.toLowerCase() + ' yet';
                text.textContent = 'Create a new ' + app.label.toLowerCase() + ' and it will appear here automatically.';
                const img = $('emptyStateImg');
                if (img) img.hidden = true;
            } else {
                title.textContent = 'No files yet';
                text.textContent = 'Create a note, document, presentation or spreadsheet and it will appear here.';
                const img = $('emptyStateImg');
                if (img) img.hidden = true;
            }
            return;
        }

        empty.hidden = true;
        grid.innerHTML = '';
        const frag = document.createDocumentFragment();
        files.forEach(f => frag.appendChild(elFromHTML(rowHTML(f))));
        grid.appendChild(frag);
    }

    const fileMenu = $('fileMenu');

    function hideFileMenu() {
        if (!fileMenu) return;
        fileMenu.hidden = true;
        fileMenu.style.display = 'none';
    }

    function showFileMenu(f, x, y) {
        if (!fileMenu) return;
        const cm = $('custom-context-menu');
        if (cm) cm.style.display = 'none';
        const app = APPS[f.type];
        $('fmIcon').innerHTML = appIcon(f.type);
        $('fmTitle').textContent = f.title;
        $('fmMeta').textContent = app.name + ' · ' + timeAgo(f.updatedAt);
        fileMenu.style.left = '-9999px';
        fileMenu.style.top = '-9999px';
        fileMenu.hidden = false;
        fileMenu.style.display = 'block';
        const w = fileMenu.offsetWidth || 240;
        const h = fileMenu.offsetHeight || 240;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        let left = Math.min(x, vw - w - 8);
        let top = Math.min(y, vh - h - 8);
        if (left < 8) left = 8;
        if (top < 8) top = 8;
        fileMenu.style.left = left + 'px';
        fileMenu.style.top = top + 'px';
        state.currentFile = f;
    }

    let renameTarget = null;
    let deleteTarget = null;

    function openModal(id) { $(id).classList.add('show'); }
    function closeModal(id) { $(id).classList.remove('show'); }

    function openRename(f) {
        renameTarget = f;
        const app = APPS[f.type];
        $('renameAppLabel').innerHTML = appIcon(f.type) + ' ' + esc(app.name);
        $('renameInput').value = f.title;
        openModal('renameOverlay');
        setTimeout(() => {
            const input = $('renameInput');
            input.focus();
            input.select();
        }, 60);
    }

    async function commitRename() {
        const f = renameTarget;
        const input = $('renameInput');
        if (!f || !input) return;
        const t = input.value;
        closeModal('renameOverlay');
        try {
            const ok = await renameFile(f, t);
            if (!ok) return;
            await refresh({ silent: true });
            toast('<span style="color:#239a4d">' + SVG.check + '</span> Renamed to “' + esc(t) + '”');
        } catch (e) {
            console.error('[EmeraldSuite] rename failed', e);
            toast('Could not rename file');
        }
        renameTarget = null;
    }

    function openDelete(f) {
        deleteTarget = f;
        const app = APPS[f.type];
        $('deleteAppLabel').innerHTML = appIcon(f.type) + ' ' + esc(app.name);
        $('deleteText').innerHTML = 'Move <b>' + esc(f.title) + '</b> to Drive Trash? You can restore it from Drive for 30 days.';
        openModal('deleteOverlay');
    }

    async function commitDelete() {
        const f = deleteTarget;
        if (!f) return;
        closeModal('deleteOverlay');
        try {
            await deleteFile(f);
            await refresh({ silent: true });
            toast('<span style="color:#d93025">' + SVG.trash + '</span> Moved “' + esc(f.title) + '” to Drive Trash');
        } catch (e) {
            console.error('[EmeraldSuite] delete failed', e);
            toast('Could not delete file');
        }
        deleteTarget = null;
    }

    function bindUI() {
        const grid = $('filesGrid');

        let suppressNextFileContextMenu = false;

        document.addEventListener('pointerdown', (e) => {
            const menu = $('fileMenu');
            if (!menu || menu.hidden) return;
            const pressed = e.target && e.target.nodeType === 1 ? e.target : e.target?.parentElement;
            if (pressed && menu.contains(pressed)) return;
            hideFileMenu();
            if (e.button === 2) {
                suppressNextFileContextMenu = true;
                setTimeout(() => { suppressNextFileContextMenu = false; }, 700);
            }
        }, true);

        document.addEventListener('contextmenu', (e) => {
            if (suppressNextFileContextMenu) {
                suppressNextFileContextMenu = false;
                e.preventDefault();
                e.stopPropagation();
                hideFileMenu();
            }
        }, true);

        document.addEventListener('contextmenu', (e) => {
            const card = e.target.closest('.file-card, .file-row, .recent-card');
            if (!card) { hideFileMenu(); return; }
            e.preventDefault();
            e.stopPropagation();
            hideFileMenu();
            const f = state.files.find(x => x.type === card.dataset.type && x.id === card.dataset.id);
            if (f) showFileMenu(f, e.clientX, e.clientY);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideFileMenu();
                closeModal('renameOverlay');
                closeModal('deleteOverlay');
            }

            const tag = (e.target && e.target.tagName) || '';
            if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
                e.preventDefault();
                $('searchInput').focus();
            }
        });

        if (fileMenu) {
            fileMenu.addEventListener('click', (e) => {
                const item = e.target.closest('[data-fm]');
                if (!item) return;
                e.preventDefault();
                const f = state.currentFile;
                hideFileMenu();
                if (!f) return;
                const act = item.dataset.fm;
                if (act === 'open') openFile(f);
                else if (act === 'newtab') { window.open(fileUrl(f), '_blank', 'noopener'); }
                else if (act === 'copy') {
                    navigator.clipboard.writeText(new URL(fileUrl(f), location.href).href)
                        .then(() => toast('<span style="color:#239a4d">' + SVG.check + '</span> Link copied to clipboard'))
                        .catch(() => toast('Could not copy link'));
                }
                else if (act === 'rename') openRename(f);
                else if (act === 'delete') openDelete(f);
            });
        }

        const cardGrids = [$('filesGrid'), $('recentGrid')].filter(Boolean);

        cardGrids.forEach(g => {
            g.addEventListener('click', (e) => {
                const card = e.target.closest('.file-card, .file-row, .recent-card');
                if (!card) return;
                const f = state.files.find(x => x.type === card.dataset.type && x.id === card.dataset.id);
                if (!f) return;
                const btn = e.target.closest('[data-action]');
                if (btn) {
                    const a = btn.dataset.action;
                    if (a === 'open') openFile(f);
                    else if (a === 'rename') openRename(f);
                    else if (a === 'delete') openDelete(f);
                    return;
                }
                openFile(f);
            });

            g.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const card = e.target.closest('.file-card, .file-row, .recent-card');
                if (!card) return;
                e.preventDefault();
                const f = state.files.find(x => x.type === card.dataset.type && x.id === card.dataset.id);
                if (f) openFile(f);
            });
        });

        const applySearch = (value) => {
            state.search = value.trim();

            const main = document.querySelector('.suite-main');
            if (main) main.classList.toggle('searching', !!state.search);
            renderGrid();
        };

        $('searchInput').addEventListener('input', (e) => applySearch(e.target.value));

        const searchClear = document.querySelector('.su-search-clear');
        if (searchClear) {
            searchClear.addEventListener('click', () => {
                const input = $('searchInput');
                if (!input) return;
                if (!input.value) return;
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            });
        }

        const sortBtn = $('sortSelectBtn'), sortMenu = $('sortMenu'), sortLabel = $('sortSelectLabel');
        if (sortBtn && sortMenu) {
            const setSortOpen = (open) => {
                sortMenu.hidden = !open;
                sortBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            };
            sortBtn.addEventListener('click', (e) => { e.stopPropagation(); setSortOpen(sortMenu.hidden); });
            document.addEventListener('click', (e) => { if (!sortMenu.hidden && !sortMenu.contains(e.target) && !sortBtn.contains(e.target)) setSortOpen(false); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sortMenu.hidden) setSortOpen(false); });
            sortMenu.querySelectorAll('.sort-dd-item').forEach(item => {
                item.addEventListener('click', () => {
                    state.sort = item.dataset.sort;
                    sortLabel.textContent = (item.querySelector('.sort-dd-text')?.textContent || item.textContent).trim();
                    sortMenu.querySelectorAll('.sort-dd-item').forEach(x => {
                        const isActive = x === item;
                        x.classList.toggle('active', isActive);
                        x.setAttribute('aria-selected', isActive ? 'true' : 'false');
                    });
                    setSortOpen(false);
                    renderGrid();
                });
            });
        }

        const filterBar = $('filterBar');
        if (filterBar) {
            filterBar.addEventListener('click', (e) => {
                const btn = e.target.closest('.filter-btn');
                if (!btn) return;
                const v = btn.dataset.filter;
                if (v === 'all') {
                    state.filter = 'all';
                    state.filters.clear();
                } else {
                    state.filter = 'custom';
                    if (state.filters.has(v)) state.filters.delete(v);
                    else state.filters.add(v);
                    if (!state.filters.size) { state.filter = 'all'; }
                }
                renderFilters();
                renderGrid();
            });
        }

        $('renameClose').addEventListener('click', () => closeModal('renameOverlay'));
        $('renameCancel').addEventListener('click', () => { closeModal('renameOverlay'); renameTarget = null; });
        $('renameForm').addEventListener('submit', (e) => { e.preventDefault(); commitRename(); });
        $('deleteClose').addEventListener('click', () => closeModal('deleteOverlay'));
        $('deleteCancel').addEventListener('click', () => { closeModal('deleteOverlay'); deleteTarget = null; });
        $('deleteConfirm').addEventListener('click', commitDelete);

        ['renameOverlay', 'deleteOverlay'].forEach(id => {
            $(id).addEventListener('mousedown', (e) => {
                if (e.target === $(id)) closeModal(id);
            });
        });

        const syncEl = $('syncIndicator');
        if (syncEl) syncEl.addEventListener('click', () => refresh({}));

        const profileBtn = $('profileBtn'), accountPop = $('accountPop');
        if (profileBtn && accountPop) {
            const hideAccount = () => {
                accountPop.hidden = true;
                profileBtn.setAttribute('aria-expanded', 'false');
            };
            profileBtn.addEventListener('click', () => {
                accountPop.hidden = !accountPop.hidden;
                profileBtn.setAttribute('aria-expanded', String(!accountPop.hidden));
            });
            document.addEventListener('mousedown', (e) => {
                if (!accountPop.hidden && !accountPop.contains(e.target) && !profileBtn.contains(e.target)) hideAccount();
            });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideAccount(); });
            $('accountSignOut').addEventListener('click', async () => {
                if (window.EmeraldAuth && window.EmeraldAuth.logoutCurrentDevice) await window.EmeraldAuth.logoutCurrentDevice();
                window.location.href = '/account';
            });
        }
    }

    async function init() {
        if (window.EmeraldAuth && window.EmeraldAuth.ready) await window.EmeraldAuth.ready();
        await renderAccountProfile();
        setGreeting();
        bindUI();

        window.addEventListener('focus', () => refresh({ silent: true }));
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ silent: true }); });

        const s = storage();
        if (s && s.subscribe) {
            s.subscribe((change) => {
                if (change && change.key && KEY_TO_TYPE[change.key]) {
                    refresh({ silent: true });
                }
            });
        }

        if (syncChannel) {
            syncChannel.onmessage = (e) => {
                if (e.data && e.data.by !== TAB) refresh({ silent: true });
            };
        }

        window.addEventListener('focus', () => refresh({ silent: true }));
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refresh({ silent: true });
        });

        setInterval(() => refresh({ silent: true }), 60000);

        refresh({});
    }

    function sanitizePhotoUrl(value) {
        if (!value || typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/i.test(trimmed)) return trimmed;
        try {
            const parsed = new URL(trimmed, window.location.origin);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
            return parsed.href;
        } catch (_) {
            return '';
        }
    }

    async function renderAccountProfile() {
        try {
            const session = window.EmeraldAuth && window.EmeraldAuth.getSession ? await window.EmeraldAuth.getSession() : null;
            const user = session && session.user;
            const email = user && (user.email || user.username) || '';
            let profile = null;
            const store = storage();
            if (store && store.ready) await store.ready();
            if (store && store.getJSON) profile = await store.getJSON('emerald.account.profile');
            if (!profile && email) {
                try { profile = JSON.parse(localStorage.getItem('emerald.account.profile.' + email) || 'null'); } catch (_) {}
            }
            const name = profile && profile.name || user && (user.name || user.displayName) || (email ? email.split('@')[0] : 'Emerald user');
            const photo = profile && typeof profile.photo === 'string' ? sanitizePhotoUrl(profile.photo) : '';
            const initial = (name.trim()[0] || 'E').toUpperCase();
            $('profileBtn').title = name;
            $('profileInitial').textContent = initial;
            $('accountPopInitial').textContent = initial;
            $('accountPopName').textContent = name;
            $('accountPopEmail').textContent = email;
            $('accountPopEmail').title = email;
            const isGoogle = String(user && user.provider || '').toLowerCase() === 'google';
            $('accountProvider').innerHTML = isGoogle
                ? '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.6 27.6a12 12 0 0 1 0-7.2v-5.3H5.8a20 20 0 0 0 0 17.8l6.8-5.3Z"/><path fill="#EA4335" d="M24 12c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 6 29.5 4 24 4A20 20 0 0 0 5.8 15.1l6.8 5.3C14.2 15.6 18.7 12 24 12Z"/></svg><span>Google</span>'
                : '<img src="/assets/images/favicon.webp" alt=""><span>EmeraldNetwork</span>';
            if (photo) {
                try {
                    const res = await fetch(photo, { mode: 'cors', credentials: 'omit' });
                    const blob = res.ok ? await res.blob() : null;
                    if (blob && /^image\//.test(blob.type || '')) {
                        const obj = URL.createObjectURL(blob);
                        ['profileAvatar', 'accountPopAvatar'].forEach((id) => {
                            const img = $(id);
                            if (!img) return;
                            if (img._suiteAvatarObjUrl) { try { URL.revokeObjectURL(img._suiteAvatarObjUrl); } catch (_) {} }
                            img._suiteAvatarObjUrl = obj;
                            img.src = obj;
                            img.hidden = false;
                        });
                        $('profileInitial').hidden = true;
                        $('accountPopInitial').hidden = true;
                    }
                } catch (_) {}
            }
        } catch (_) {}
    }

    let forcedDaypart = null;
    window.suiteDaypart = function (part) {
        const valid = ['morning', 'afternoon', 'evening'];
        if (part === undefined || part === null) forcedDaypart = null;
        else if (valid.indexOf(part) !== -1) forcedDaypart = part;
        else { console.warn('suiteDaypart: expected one of', valid); return; }
        applyDaypart();
        console.log('[suite] daypart =', forcedDaypart || daypartFor(new Date().getHours()), '(forced=' + !!forcedDaypart + ')');
    };

    function setGreeting() {
        applyDaypart();
    }

    function applyDaypart() {
        const part = forcedDaypart || daypartFor(new Date().getHours());
        const el = $('greeting');
        if (el) el.innerHTML = greetingFor(part) + ', welcome to <span>EmeraldSuite</span>!';
        const app = document.querySelector('.suite-app');
        if (app) app.dataset.daypart = part;
        buildSky(part);
    }

    const STAR_TINTS = [
        ['#ffffff', 5],
        ['#e8f1ff', 3],
        ['#cfe0ff', 2],
        ['#fff4e2', 2],
        ['#ffd9a8', 1]
    ];

    function hexToRgba(hex, a) {
        const n = parseInt(hex.slice(1), 16);
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    function pickStarTint() {
        const total = STAR_TINTS.reduce((n, t) => n + t[1], 0);
        let r = Math.random() * total;
        for (const [hex, w] of STAR_TINTS) {
            r -= w;
            if (r <= 0) return hex;
        }
        return STAR_TINTS[0][0];
    }

    function starPosition() {
        const BAND = 0.7;
        if (Math.random() < BAND) {
            const x = Math.random() * 100;
            const centre = 46 - x * 0.34;
            const spread = 13 + Math.random() * 11;
            return { x: x, y: Math.max(-2, Math.min(58, centre + (Math.random() * 2 - 1) * spread)) };
        }
        return { x: Math.random() * 100, y: Math.random() * 58 };
    }

    function buildSky(part) {
        const sky = $('skyLayer');
        if (!sky) return;
        sky.innerHTML = '';
        if (part === 'morning') { buildGodRays(sky); return; }
        if (part !== 'evening') return;

        const frag = document.createDocumentFragment();
        for (let i = 0; i < 78; i++) {
            const star = document.createElement('i');
            star.className = 'su-star';

            const size = 1 + Math.round(Math.random() * 2.6);
            if (size >= 3) star.classList.add('big');

            const tint = pickStarTint();
            star.style.width = size.toFixed(1) + 'px';
            star.style.height = size.toFixed(1) + 'px';
            star.style.setProperty('--tint', tint);

            if (size >= 3) star.style.setProperty('--glow', hexToRgba(tint, .55));

            const pos = starPosition();
            star.style.left = pos.x.toFixed(2) + '%';
            star.style.top = pos.y.toFixed(2) + '%';
            star.style.setProperty('--dur', (2.4 + Math.random() * 4.2).toFixed(2) + 's');
            star.style.setProperty('--delay', (Math.random() * 5).toFixed(2) + 's');
            frag.appendChild(star);
        }
        for (let i = 0; i < 2; i++) {
            const shoot = document.createElement('i');
            shoot.className = 'su-shooting';
            shoot.style.animationDelay = (2 + Math.random() * 7 + i * 5).toFixed(2) + 's';
            frag.appendChild(shoot);
        }
        sky.appendChild(frag);
    }

    function buildGodRays(sky) {
        const COUNT = 9;
        const holder = document.createElement('div');
        holder.className = 'su-rays';

        let angle = 4;
        for (let i = 0; i < COUNT; i++) {
            const ray = document.createElement('i');
            ray.className = 'su-ray';

            const gap = 5 + Math.random() * 9;
            angle += i === 0 ? gap : gap;
            ray.style.transform = 'rotate(' + angle.toFixed(1) + 'deg)';

            const edge = 1 - Math.abs(i / (COUNT - 1) - 0.5) * 1.5;
            ray.style.setProperty('--w', (40 + Math.random() * 64 * Math.max(.45, edge)).toFixed(0) + 'px');

            ray.style.setProperty('--blur', (12 + Math.random() * 18).toFixed(1) + 'px');
            ray.style.setProperty('--dur', (7 + Math.random() * 7).toFixed(2) + 's');
            ray.style.setProperty('--delay', (Math.random() * 6).toFixed(2) + 's');
            holder.appendChild(ray);
        }
        sky.appendChild(holder);
    }

    function daypartFor(h) {
        if (h < 12) return 'morning';
        if (h < 18) return 'afternoon';
        return 'evening';
    }

    function greetingFor(part) {
        if (part === 'morning') return 'Good morning';
        if (part === 'afternoon') return 'Good afternoon';
        return 'Good evening';
    }

    document.addEventListener('DOMContentLoaded', init);
})();
