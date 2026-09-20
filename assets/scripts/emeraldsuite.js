(function () {
    'use strict';

    const TAB = Math.random().toString(36).slice(2) + Date.now().toString(36);

    const APPS = {
        notes: {
            name: 'EmeraldNotes', file: 'notes.html', label: 'Note', urlLabel: 'Notes',
            color: '#a21caf',
            soft: 'rgba(162,28,175,0.10)',
            border: 'rgba(162,28,175,0.32)',
            fill: 'rgba(162,28,175,0.26)',
            empty: '/assets/images/nonotes.webp',
            emptyAction: 'notes.html',
            emptyCta: 'Create a note'
        },
        docs: {
            name: 'EmeraldDocs', file: 'docs.html', label: 'Document', urlLabel: 'Documents',
            color: '#0891b2',
            soft: 'rgba(8,145,178,0.10)',
            border: 'rgba(8,145,178,0.32)',
            fill: 'rgba(8,145,178,0.26)',
            empty: '/assets/images/nodocs.webp',
            emptyAction: 'docs.html',
            emptyCta: 'Create a document'
        },
        slides: {
            name: 'EmeraldSlides', file: 'slides.html', label: 'Presentation', urlLabel: 'Presentations',
            color: '#f97316',
            soft: 'rgba(249,115,22,0.10)',
            border: 'rgba(249,115,22,0.32)',
            fill: 'rgba(249,115,22,0.26)',
            empty: '/assets/images/noslides.webp',
            emptyAction: 'slides.html',
            emptyCta: 'Create a presentation'
        },
        sheets: {
            name: 'EmeraldSheets', file: 'sheets.html', label: 'Spreadsheet', urlLabel: 'Spreadsheets',
            color: '#217346',
            soft: 'rgba(33,115,70,0.10)',
            border: 'rgba(33,115,70,0.32)',
            fill: 'rgba(33,115,70,0.26)',
            empty: '/assets/images/nosheets.webp',
            emptyAction: 'sheets.html',
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
        search: '',
        sort: 'recent',
        syncing: false,
        currentFile: null
    };

    let syncChannel = null;
    if (typeof BroadcastChannel !== 'undefined') {
        syncChannel = new BroadcastChannel('emeraldsuite-sync');
    }

    /* ---------------- small helpers ---------------- */
    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function storage() { return window.EmeraldIDBStorage || null; }

    function toTs(v) {
        if (!v) return 0;
        const t = typeof v === 'string' ? Date.parse(v) : Number(v);
        return Number.isFinite(t) ? t : 0;
    }

    function plainHtml(html) {
        if (!html) return '';
        try {
            const doc = new DOMParser().parseFromString(String(html), 'text/xml');
            return (doc.documentElement?.textContent || '').replace(/\s+/g, ' ').trim();
        } catch (e) {
            try {
                const doc = new DOMParser().parseFromString(String(html), 'text/html');
                return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
            } catch { return ''; }
        }
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

    function appIcon(type) { return SVG[type] || SVG.doc; }

    /* ---------------- loaders ---------------- */
    async function loadNotes() {
        const s = storage();
        let raw = null;
        if (s) raw = await s.getJSON('emeraldcore.storage.suite.notes');
        const arr = Array.isArray(raw) ? raw : [];
        return arr
            .filter(n => n && n.id && !n._isCollabNote)
            .map(n => ({
                type: 'notes',
                id: String(n.id),
                title: (n.title || '').trim() || 'Untitled note',
                updatedAt: toTs(n.updatedAt),
                detail: countWords(n.content) + ' words'
            }));
    }

    async function loadDocs() {
        const s = storage();
        let raw = null;
        if (s) raw = await s.getJSON('emeraldcore.storage.suite.docs');
        const arr = Array.isArray(raw) ? raw : [];
        return arr
            .filter(m => m && m.id)
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
        const arr = Array.isArray(raw) ? raw : [];
        return arr
            .filter(m => m && m.id)
            .map(m => ({
                type: 'slides',
                id: String(m.id),
                title: (m.title || '').trim() || 'Untitled presentation',
                updatedAt: toTs(m.updatedAt),
                detail: 'Presentation'
            }));
    }

    /* Sheets use their own IndexedDB (emeraldcore.storage.suite.sheets / workbooks). */
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
            const out = [];
            for (let i = 0; i < keys.length; i++) {
                const d = vals[i];
                if (!d || typeof d !== 'object') continue;
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

    /* ---------------- refresh / sync ---------------- */
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

    /* ---------------- writers (rename / delete) ---------------- */
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
        if (f.type === 'notes') {
            let arr = s ? (await s.getJSON('emeraldcore.storage.suite.notes')) : null;
            arr = Array.isArray(arr) ? arr : [];
            arr = arr.filter(n => !(n && String(n.id) === f.id));
            if (s) { s.setJSONSync('emeraldcore.storage.suite.notes', arr); }
        } else if (f.type === 'docs') {
            let arr = s ? (await s.getJSON('emeraldcore.storage.suite.docs')) : null;
            arr = Array.isArray(arr) ? arr : [];
            arr = arr.filter(m => !(m && String(m.id) === f.id));
            if (s) { await s.setJSON('emeraldcore.storage.suite.docs', arr); }
            try {
                const dk = 'emeraldcore.storage.suite.docs.' + f.id;
                const vk = 'emeraldcore.storage.suite.docs.versions.' + f.id;
                if (s) {
                    await s.delete(dk);
                    await s.delete(vk);
                }
            } catch (e) {}
        } else if (f.type === 'slides') {
            let arr = s ? (await s.getJSON('emeraldcore.storage.suite.slides')) : null;
            arr = Array.isArray(arr) ? arr : [];
            arr = arr.filter(m => !(m && String(m.id) === f.id));
            if (s) { await s.setJSON('emeraldcore.storage.suite.slides', arr); }
            try {
                const pk = 'emeraldcore.storage.suite.slides.' + f.id;
                if (s) { await s.delete(pk); }
            } catch (e) {}
        } else if (f.type === 'sheets') {
            try {
                const db = await openSheetDB();
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('workbooks', 'readwrite');
                    tx.objectStore('workbooks').delete(f.id);
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });
            } catch (e) { console.warn('[EmeraldSuite] delete sheets failed', e); }
            postSync();
        }
        return true;
    }

    /* ---------------- opening ---------------- */
    function fileUrl(f) {
        const app = APPS[f.type];
        return app.file + '?owned=' + encodeURIComponent(f.id);
    }

    function openFile(f) {
        location.href = fileUrl(f);
    }

    /* ---------------- rendering ---------------- */
    function visibleFiles() {
        let files = state.files.slice();
        if (state.filter !== 'all') {
            files = files.filter(f => f.type === state.filter);
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
        /* sheets */
        const cells = (f.mini || []).map(c =>
            '<div class="wb-cell' + (c.hdr ? ' hdr' : '') + (c.filled ? ' filled' : '') + '"></div>'
        ).join('');
        return '<div class="mini-wrap" style="' + style + '"><div class="wb-mini">' + cells + '</div></div>';
    }

    function cardHTML(f) {
        const app = APPS[f.type];
        const typ = {
            notes: 'Note', docs: 'Document', slides: 'Presentation', sheets: 'Spreadsheet'
        }[f.type];
        return '<article class="file-card" role="listitem" tabindex="0" data-type="' + f.type + '" data-id="' + esc(f.id) + '" style="--c:' + app.color + ';--soft:' + app.soft + ';--border:' + app.border + '">' +
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

    function render() {
        renderTiles();
        renderFilters();
        renderGrid();
    }

    function renderTiles() {
        const counts = { notes: 0, docs: 0, slides: 0, sheets: 0 };
        state.files.forEach(f => { counts[f.type] = (counts[f.type] || 0) + 1; });
        const map = { notes: 'statNumNotes', docs: 'statNumDocs', slides: 'statNumSlides', sheets: 'statNumSheets' };
        Object.keys(map).forEach(k => {
            const el = $(map[k]);
            if (el) el.textContent = String(counts[k] || 0);
        });
    }

    function renderFilters() {
        const btns = document.querySelectorAll('.filter-btn');
        btns.forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
    }

    function renderGrid() {
        const grid = $('filesGrid');
        const empty = $('emptyState');
        const countEl = $('filesCount');
        if (!grid) return;

        const files = visibleFiles();

        if (countEl) {
            const total = state.files.length;
            countEl.textContent = files.length === total
                ? total + (total === 1 ? ' file' : ' files')
                : files.length + ' of ' + total + ' files';
        }

        if (files.length === 0) {
            grid.innerHTML = '';
            empty.hidden = false;
            const app = state.filter !== 'all' ? APPS[state.filter] : null;
            const img = $('emptyImg');
            const title = $('emptyTitle');
            const text = $('emptyText');
            const actions = $('emptyActions');
            if (actions) actions.innerHTML = '';
            if (state.search) {
                img.src = '/assets/images/favicon.webp';
                title.textContent = 'No matching files';
                text.textContent = 'Nothing matched “' + esc(state.search) + '”. Try a different search.';
            } else if (app) {
                img.src = app.empty;
                title.textContent = 'No ' + app.urlLabel.toLowerCase() + ' yet';
                text.textContent = 'Create a new ' + app.label.toLowerCase() + ' and it will appear here automatically.';
                if (actions) {
                    const a = document.createElement('a');
                    a.className = 'btn-empty';
                    a.href = app.emptyAction;
                    a.innerHTML = appIcon(app.type) + 'Create a ' + app.label.toLowerCase();
                    actions.appendChild(a);
                }
            } else {
                img.src = '/assets/images/favicon.webp';
                title.textContent = 'No files yet';
                text.textContent = 'Create a note, document, presentation or spreadsheet and it will appear here.';
                if (actions) {
                    Object.keys(APPS).forEach(key => {
                        const app = APPS[key];
                        const a = document.createElement('a');
                        a.className = 'btn-empty btn-empty-mini';
                        a.href = app.emptyAction;
                        a.style.setProperty('--c', app.color);
                        a.style.setProperty('--soft', app.soft);
                        a.innerHTML = appIcon(key) + 'Create a ' + app.label.toLowerCase();
                        actions.appendChild(a);
                    });
                }
            }
            return;
        }

        empty.hidden = true;
        grid.innerHTML = '';
        const frag = document.createDocumentFragment();
        files.forEach(f => {
            const div = document.createElement('div');
            div.innerHTML = cardHTML(f);
            frag.appendChild(div.firstElementChild);
        });
        grid.appendChild(frag);
    }

    /* ---------------- context menu ---------------- */
    const fileMenu = $('fileMenu');

    function hideFileMenu() {
        if (fileMenu) fileMenu.hidden = true;
    }

    function showFileMenu(f, x, y) {
        if (!fileMenu) return;
        const app = APPS[f.type];
        fileMenu.style.setProperty('--c', app.color);
        fileMenu.style.setProperty('--soft', app.soft);
        $('fmIcon').innerHTML = appIcon(f.type);
        $('fmTitle').textContent = f.title;
        $('fmMeta').textContent = app.name + ' · ' + timeAgo(f.updatedAt);
        fileMenu.hidden = false;
        const w = fileMenu.offsetWidth || 250;
        const h = fileMenu.offsetHeight || 240;
        fileMenu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
        fileMenu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
        state.currentFile = f;
    }

    /* ---------------- modals ---------------- */
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
        $('deleteText').innerHTML = 'Delete <b>' + esc(f.title) + '</b> permanently from this device? This cannot be undone and will also remove it from open ' + app.name + ' tabs.';
        openModal('deleteOverlay');
    }

    async function commitDelete() {
        const f = deleteTarget;
        if (!f) return;
        closeModal('deleteOverlay');
        try {
            await deleteFile(f);
            await refresh({ silent: true });
            toast('<span style="color:#d93025">' + SVG.trash + '</span> Deleted “' + esc(f.title) + '”');
        } catch (e) {
            console.error('[EmeraldSuite] delete failed', e);
            toast('Could not delete file');
        }
        deleteTarget = null;
    }

    /* ---------------- events ---------------- */
    function bindUI() {
        const grid = $('filesGrid');

        document.addEventListener('click', (e) => {
            const menu = $('fileMenu');
            if (menu && !menu.hidden && !menu.contains(e.target)) hideFileMenu();
        });

        document.addEventListener('contextmenu', (e) => {
            const card = e.target.closest('.file-card');
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
            /* '/' focuses search (unless typing in an input) */
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

        grid.addEventListener('click', (e) => {
            const card = e.target.closest('.file-card');
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

        grid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const card = e.target.closest('.file-card');
            if (!card) return;
            e.preventDefault();
            const f = state.files.find(x => x.type === card.dataset.type && x.id === card.dataset.id);
            if (f) openFile(f);
        });

        $('searchInput').addEventListener('input', (e) => {
            state.search = e.target.value.trim();
            renderGrid();
        });

        $('sortSelect').addEventListener('change', (e) => {
            state.sort = e.target.value;
            renderGrid();
        });

        const filterBar = $('filterBar');
        if (filterBar) {
            filterBar.addEventListener('click', (e) => {
                const btn = e.target.closest('.filter-btn');
                if (!btn) return;
                state.filter = btn.dataset.filter;
                renderFilters();
                renderGrid();
            });
        }

        /* New dropdown */
        const newBtn = $('newFileBtn');
        const newMenu = $('newMenu');
        function setNewOpen(open) {
            if (!newMenu) return;
            newMenu.hidden = !open;
            if (newBtn) newBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (newBtn && newMenu) {
            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setNewOpen(newMenu.hidden);
            });
            document.addEventListener('click', (e) => {
                if (!newMenu.hidden && !newMenu.contains(e.target) && !newBtn.contains(e.target)) setNewOpen(false);
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !newMenu.hidden) { setNewOpen(false); newBtn.focus(); }
            });
            window.addEventListener('blur', () => { if (!newMenu.hidden) setNewOpen(false); });
        }

        $('refreshBtn').addEventListener('click', () => refresh({}));

        /* modals */
        $('renameClose').addEventListener('click', () => closeModal('renameOverlay'));
        $('renameCancel').addEventListener('click', () => { closeModal('renameOverlay'); renameTarget = null; });
        $('renameForm').addEventListener('submit', (e) => { e.preventDefault(); commitRename(); });
        $('deleteClose').addEventListener('click', () => closeModal('deleteOverlay'));
        $('deleteCancel').addEventListener('click', () => { closeModal('deleteOverlay'); deleteTarget = null; });
        $('deleteConfirm').addEventListener('click', commitDelete);

        /* overlay click-outside */
        ['renameOverlay', 'deleteOverlay'].forEach(id => {
            $(id).addEventListener('mousedown', (e) => {
                if (e.target === $(id)) closeModal(id);
            });
        });

        /* sync indicator click = sync now */
        const syncEl = $('syncIndicator');
        if (syncEl) syncEl.addEventListener('click', () => refresh({}));
    }

    function init() {
        setGreeting();
        bindUI();

        /* cross-tab sync for notes/docs/slides (EmeraldIDBStorage channel) */
        const s = storage();
        if (s && s.subscribe) {
            s.subscribe((change) => {
                if (change && change.key && KEY_TO_TYPE[change.key]) {
                    refresh({ silent: true });
                }
            });
        }

        /* cross-tab sync for sheets + everything else */
        if (syncChannel) {
            syncChannel.onmessage = (e) => {
                if (e.data && e.data.by !== TAB) refresh({ silent: true });
            };
        }

        window.addEventListener('focus', () => refresh({ silent: true }));
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refresh({ silent: true });
        });

        /* periodic gentle refresh keeps cards' "edited X ago" fresh */
        setInterval(() => refresh({ silent: true }), 60000);

        refresh({});
    }

    function setGreeting() {
        const el = $('greeting');
        if (!el) return;
        const h = new Date().getHours();
        let g = 'Welcome back.';
        if (h < 5) g = 'Working late?';
        else if (h < 12) g = 'Good morning.';
        else if (h < 18) g = 'Good afternoon.';
        else g = 'Good evening.';
        el.innerHTML = g + ' <span>Everything in one place.</span>';
    }

    document.addEventListener('DOMContentLoaded', init);
})();