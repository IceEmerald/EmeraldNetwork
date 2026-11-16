/* EmeraldNetwork Drive — front-end mockup */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    function storage() { return window.EmeraldIDBStorage || null; }

    /* ---------------- mock data ---------------- */

    var TYPE_META = {
        doc:    { label: 'Document',     color: '#0891b2', soft: 'rgba(8,145,178,.12)' },
        note:   { label: 'Note',         color: '#a21caf', soft: 'rgba(162,28,175,.12)' },
        slide:  { label: 'Presentation', color: '#f97316', soft: 'rgba(249,115,22,.12)' },
        sheet:  { label: 'Spreadsheet',  color: '#217346', soft: 'rgba(33,115,70,.12)' },
        image:  { label: 'Image',        color: '#e11d48', soft: 'rgba(225,29,72,.12)' },
        pdf:    { label: 'PDF',          color: '#dc2626', soft: 'rgba(220,38,38,.12)' },
        other:  { label: 'File',         color: '#64748b', soft: 'rgba(100,116,139,.12)' }
    };

    var folders = [
        { id: 'f1', name: 'Projects', parent: null },
        { id: 'f2', name: 'Photos', parent: null },
        { id: 'f3', name: 'Reports', parent: 'f1' },
        { id: 'f4', name: 'Archive', parent: null }
    ];

    var files = [
        { id: 'd1', name: 'Q4 Report', type: 'doc', folder: 'f1', size: '2.1 MB', modified: 'Today', starred: true, shared: true, trashed: false },
        { id: 'd2', name: 'Roadmap 2027', type: 'doc', folder: 'f3', size: '640 KB', modified: 'Yesterday', starred: false, shared: true, trashed: false },
        { id: 'n1', name: 'Meeting notes', type: 'note', folder: null, size: '12 KB', modified: '2h ago', starred: true, shared: false, trashed: false },
        { id: 'n2', name: 'Ideas', type: 'note', folder: null, size: '8 KB', modified: '5d ago', starred: false, shared: false, trashed: false },
        { id: 's1', name: 'Budget', type: 'sheet', folder: 'f1', size: '310 KB', modified: 'Yesterday', starred: true, shared: true, trashed: false },
        { id: 'p1', name: 'Launch deck', type: 'slide', folder: 'f1', size: '8.4 MB', modified: '3d ago', starred: false, shared: true, trashed: false },
        { id: 'i1', name: 'sunset.png', type: 'image', folder: 'f2', size: '3.2 MB', modified: '1w ago', starred: false, shared: false, trashed: false },
        { id: 'i2', name: 'team-photo.jpg', type: 'image', folder: 'f2', size: '5.7 MB', modified: '2w ago', starred: false, shared: false, trashed: false },
        { id: 'r1', name: 'Invoice-2026-11.pdf', type: 'pdf', folder: 'f4', size: '180 KB', modified: '1d ago', starred: false, shared: false, trashed: false },
        { id: 't1', name: 'Old notes', type: 'note', folder: null, size: '9 KB', modified: '1mo ago', starred: false, shared: false, trashed: true }
    ];

    var state = { view: 'home', folderId: null, layout: 'grid', sort: 'modified', search: '' };

    /* ---------------- helpers ---------------- */

    function childrenOf(folderId) {
        return folders.filter(function (f) { return f.parent === folderId; });
    }

    function filesIn(folderId) {
        return files.filter(function (f) { return f.folder === folderId && !f.trashed; });
    }

    function folderPath(folderId) {
        var path = [];
        var cur = folders.find(function (f) { return f.id === folderId; });
        while (cur) { path.unshift(cur); cur = folders.find(function (f) { return f.id === cur.parent; }); }
        return path;
    }

    function sortList(list) {
        var key = state.sort;
        return list.slice().sort(function (a, b) {
            if (key === 'name') return a.name.localeCompare(b.name);
            if (key === 'size') return parseFloat(b.size) - parseFloat(a.size);
            return 0; // modified: keep natural order (mock)
        });
    }

    function filterSearch(list) {
        if (!state.search) return list;
        var q = state.search.toLowerCase();
        return list.filter(function (f) { return f.name.toLowerCase().indexOf(q) !== -1; });
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function typeBadge(type) {
        var m = TYPE_META[type] || TYPE_META.other;
        return '<span class="dfile-badge" style="color:' + m.color + ';background:' + m.soft + '">' + esc(m.label[0]) + '</span>';
    }

    /* ---------------- rendering ---------------- */

    function renderCrumbs() {
        var el = $('driveCrumbs');
        if (!el) return;
        var html = '';
        if (state.view === 'mydrive') {
            html += '<button class="dcrumb' + (state.folderId ? '' : ' current') + '" data-crumb="root">My Drive</button>';
            var path = folderPath(state.folderId);
            for (var i = 0; i < path.length; i++) {
                html += '<span class="dcrumb-sep">›</span><button class="dcrumb' + (i === path.length - 1 ? ' current' : '') + '" data-crumb="' + path[i].id + '">' + esc(path[i].name) + '</button>';
            }
        } else {
            var titles = { home: 'Home', shared: 'Shared with me', recent: 'Recent', starred: 'Starred', trash: 'Trash' };
            html += '<span class="dcrumb current">' + (titles[state.view] || 'Drive') + '</span>';
        }
        el.innerHTML = html;
        el.querySelectorAll('[data-crumb]').forEach(function (b) {
            b.addEventListener('click', function () {
                state.view = 'mydrive';
                state.folderId = b.getAttribute('data-crumb') === 'root' ? null : b.getAttribute('data-crumb');
                setActiveNav('mydrive');
                switchPage(render);
            });
        });
    }

    function cardHTML(item, isFolder) {
        if (isFolder) {
            return '<button class="dfolder-card" data-folder="' + item.id + '">' +
                '<span class="dfolder-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>' +
                '<span class="dfolder-name">' + esc(item.name) + '</span>' +
                '</button>';
        }
        var m = TYPE_META[item.type] || TYPE_META.other;
        return '<div class="dfile-card" data-file="' + item.id + '">' +
            '<div class="dfile-thumb" style="background:' + m.soft + ';color:' + m.color + '">' + typeBadge(item.type) + '</div>' +
            '<div class="dfile-body"><div class="dfile-name">' + esc(item.name) + '</div>' +
            '<div class="dfile-meta">' + esc(m.label) + ' · ' + esc(item.size) + ' · ' + esc(item.modified) + '</div></div>' +
            (item.starred ? '<span class="dfile-star" title="Starred">★</span>' : '') +
            '</div>';
    }

    function rowHTML(item, isFolder) {
        var m = isFolder ? null : (TYPE_META[item.type] || TYPE_META.other);
        if (isFolder) {
            return '<div class="drow" data-folder="' + item.id + '" role="button" tabindex="0">' +
                '<span class="drow-icon" style="color:#8a8886"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>' +
                '<span class="drow-name">' + esc(item.name) + '</span>' +
                '<span class="drow-meta">Folder</span><span class="drow-meta">—</span></div>';
        }
        return '<div class="drow" data-file="' + item.id + '" role="button" tabindex="0">' +
            '<span class="drow-icon" style="color:' + m.color + '">' + typeBadge(item.type) + '</span>' +
            '<span class="drow-name">' + esc(item.name) + '</span>' +
            '<span class="drow-meta">' + esc(m.label) + '</span>' +
            '<span class="drow-meta">' + esc(item.size) + ' · ' + esc(item.modified) + '</span></div>';
    }

    function section(title, innerHTML) {
        return '<section class="dsection"><h2 class="dsection-title">' + esc(title) + '</h2>' + innerHTML + '</section>';
    }

    function gridHTML(list) {
        return '<div class="dgrid">' + list.map(function (i) { return cardHTML(i, i.type === undefined); }).join('') + '</div>';
    }
    function listHTML(list) {
        return '<div class="dlist"><div class="drow drow-head"><span class="drow-icon"></span><span class="drow-name">Name</span><span class="drow-meta">Type</span><span class="drow-meta">Size · Modified</span></div>' +
            list.map(function (i) { return rowHTML(i, i.type === undefined); }).join('') + '</div>';
    }
    function layoutHTML(list) { return state.layout === 'list' ? listHTML(list) : gridHTML(list); }

    function emptyHTML(title, text) {
        return '<div class="dempty"><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p></div>';
    }

    function render() {
        var box = $('driveContent');
        if (!box) return;
        setActiveNav(state.view);
        var html = '';
        var q = state.search;

        if (state.view === 'home') {
            var recent = filterSearch(files.filter(function (f) { return !f.trashed; })).slice(0, 4);
            var rootFolders = childrenOf(null);
            if (q) {
                var all = filterSearch(files.filter(function (f) { return !f.trashed; }));
                html += all.length ? layoutHTML(all) : emptyHTML('No results', 'Nothing matches your search.');
            } else {
                var suggested = recent.slice(0, 3);
                if (suggested.length) html += section('Suggested', '<div class="dchips">' + suggested.map(function (f) {
                    var m = TYPE_META[f.type] || TYPE_META.other;
                    return '<button class="dchip" data-file="' + f.id + '"><span class="dchip-badge" style="color:' + m.color + ';background:' + m.soft + '">' + esc(m.label[0]) + '</span><span>' + esc(f.name) + '</span></button>';
                }).join('') + '</div>');
                if (rootFolders.length) html += section('Folders', '<div class="dfolder-grid">' + rootFolders.map(function (f) { return cardHTML(f, true); }).join('') + '</div>');
                if (recent.length) html += section('Recent files', layoutHTML(recent));
                if (!rootFolders.length && !recent.length) html += emptyHTML('Nothing here yet', 'Use the New button in the sidebar to create a folder.');
            }
        } else if (state.view === 'mydrive') {
            var foldersHere = filterSearch(childrenOf(state.folderId));
            var filesHere = sortList(filterSearch(filesIn(state.folderId)));
            if (!foldersHere.length && !filesHere.length) {
                html += emptyHTML('Nothing here yet', q ? 'No matches in this folder.' : 'This folder is empty.');
            } else {
                if (foldersHere.length) html += section('Folders', '<div class="dfolder-grid">' + foldersHere.map(function (f) { return cardHTML(f, true); }).join('') + '</div>');
                if (filesHere.length) html += section('Files', layoutHTML(filesHere));
            }
        } else if (state.view === 'shared') {
            var shared = sortList(filterSearch(files.filter(function (f) { return f.shared && !f.trashed; })));
            html += shared.length ? layoutHTML(shared) : emptyHTML('Nothing shared yet', 'Files shared with you will show up here.');
        } else if (state.view === 'recent') {
            var rec = sortList(filterSearch(files.filter(function (f) { return !f.trashed; })));
            html += rec.length ? layoutHTML(rec) : emptyHTML('No recent files', 'Open a file and it will show up here.');
        } else if (state.view === 'starred') {
            var st = sortList(filterSearch(files.filter(function (f) { return f.starred && !f.trashed; })));
            html += st.length ? layoutHTML(st) : emptyHTML('No starred files', 'Star a file to pin it here.');
        } else if (state.view === 'trash') {
            html += '<div class="dtrash-banner">Items in trash are deleted forever after 30 days.</div>';
            var tr = sortList(filterSearch(files.filter(function (f) { return f.trashed; })));
            html += tr.length ? layoutHTML(tr) : emptyHTML('Trash is empty', 'Deleted files appear here for 30 days.');
        }

        box.innerHTML = html;
        bindContent();
        renderCrumbs();
        applyLayout();
    }

    function bindContent() {
        var box = $('driveContent');
        box.querySelectorAll('[data-folder]').forEach(function (n) {
            n.addEventListener('click', function () {
                state.view = 'mydrive';
                state.folderId = n.getAttribute('data-folder');
                setActiveNav('mydrive');
                switchPage(render);
            });
        });
    }

    function setActiveNav(view) {
        document.querySelectorAll('[data-drive-nav]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-drive-nav') === view);
        });
        document.querySelectorAll('.sidebar-item').forEach(function (b) {
            b.classList.remove('active');
        });
        updateNavPill();
    }

    function updateNavPill() {
        var nav = document.querySelector('.sidebar-nav');
        var pill = $('sidebarActivePill');
        if (!nav || !pill) return;
        var active = nav.querySelector('.sidebar-btn.active');
        if (!active) { pill.classList.remove('visible'); return; }
        var h = active.offsetHeight;
        var bar = h ? Math.max(14, Math.round(h * 0.62)) : 14;
        pill.style.top = Math.round(active.offsetTop + (h - bar) / 2) + 'px';
        pill.style.height = bar + 'px';
        pill.classList.add('visible');
    }

    var SWITCH_MS = 180;
    var switchAnimating = false;
    var switchPending = null;

    function switchPage(fn) {
        var box = $('driveContent');
        if (!box) { fn(); return; }
        if (switchAnimating) { switchPending = fn; return; }
        switchPending = fn;
        switchAnimating = true;
        box.classList.add('is-switching');

        setTimeout(function () {
            var next = switchPending;
            switchPending = null;
            try {
                if (next) next();
            } finally {
                void box.offsetWidth;
                box.classList.remove('is-switching');
                setTimeout(function () { switchAnimating = false; }, 200);
            }
        }, SWITCH_MS);
    }

    function applyLayout() {
        document.querySelectorAll('#viewToggle button').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-layout') === state.layout);
        });
    }

    /* ---------------- toolbar ---------------- */

    function bindToolbar() {
        document.querySelectorAll('#viewToggle button').forEach(function (b) {
            b.addEventListener('click', function () {
                state.layout = b.getAttribute('data-layout');
                applyLayout();
                render();
            });
        });

        var sortBtn = $('sortBtn'), sortMenu = $('sortMenu');
        if (sortBtn && sortMenu) {
            sortBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                sortMenu.hidden = !sortMenu.hidden;
                sortBtn.setAttribute('aria-expanded', String(!sortMenu.hidden));
            });
            document.addEventListener('click', function (e) {
                if (!sortMenu.hidden && !sortMenu.contains(e.target)) { sortMenu.hidden = true; sortBtn.setAttribute('aria-expanded', 'false'); }
            });
            sortMenu.querySelectorAll('[data-sort]').forEach(function (b) {
                b.addEventListener('click', function () {
                    state.sort = b.getAttribute('data-sort');
                    sortMenu.querySelectorAll('[data-sort]').forEach(function (x) { x.classList.toggle('active', x === b); });
                    $('sortLabel').textContent = state.sort[0].toUpperCase() + state.sort.slice(1);
                    sortMenu.hidden = true;
                    sortBtn.setAttribute('aria-expanded', 'false');
                    render();
                });
            });
        }

        var search = document.querySelector('[data-wiki-search]');
        if (search) {
            search.addEventListener('input', function () {
                state.search = search.value.trim();
                render();
            });
        }
    }

    /* ---------------- sidebar nav ---------------- */

    function bindSidebarNav() {
        document.querySelectorAll('[data-drive-nav]').forEach(function (b) {
            b.addEventListener('click', function () {
                state.view = b.getAttribute('data-drive-nav');
                state.folderId = null;
                setActiveNav(state.view);
                switchPage(render);
            });
        });
    }

    /* ---------------- theme ---------------- */

    var STORE_THEME = 'emeraldcore.wiki.theme';

    function readStore(key, fallback) {
        try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
    }
    function writeStore(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { }
    }

    function applyTheme(theme) {
        var resolved = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-wiki-theme', resolved);
        var btn = document.querySelector('.wiki-theme-btn');
        if (btn) {
            var label = 'Theme: ' + resolved + '. Click to switch.';
            btn.setAttribute('aria-label', label);
            btn.setAttribute('title', label);
        }
    }

    function initTheme() {
        applyTheme(readStore(STORE_THEME, 'light'));
        var btn = document.querySelector('.wiki-theme-btn');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var next = readStore(STORE_THEME, 'light') === 'dark' ? 'light' : 'dark';
            writeStore(STORE_THEME, next);
            applyTheme(next);
        });
    }

    /* ---------------- account profile ---------------- */

    function sanitizePhotoUrl(value) {
        if (!value || typeof value !== 'string') return '';
        var trimmed = value.trim();
        if (!trimmed) return '';
        if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/i.test(trimmed)) return trimmed;
        try {
            var parsed = new URL(trimmed, window.location.origin);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
            return parsed.href;
        } catch (_) { return ''; }
    }

    async function renderAccountProfile() {
        try {
            var session = (window.EmeraldAuth && window.EmeraldAuth.getSession) ? await window.EmeraldAuth.getSession() : null;
            var user = session && session.user;
            var email = user && (user.email || user.username) || '';
            var profile = null;
            var store = storage();
            if (store && store.ready) await store.ready();
            if (store && store.getJSON) profile = await store.getJSON('emerald.account.profile');
            if (!profile && email) {
                try { profile = JSON.parse(localStorage.getItem('emerald.account.profile.' + email) || 'null'); } catch (_) {}
            }
            var name = (profile && profile.name) || (user && (user.name || user.displayName)) || (email ? email.split('@')[0] : 'Emerald user');
            var photo = (profile && typeof profile.photo === 'string') ? sanitizePhotoUrl(profile.photo) : '';
            var initial = (name.trim()[0] || 'E').toUpperCase();

            var profileBtn = $('profileBtn');
            if (profileBtn) profileBtn.title = name;
            var profileInitial = $('profileInitial');
            if (profileInitial) profileInitial.textContent = initial;
            var accountPopInitial = $('accountPopInitial');
            if (accountPopInitial) accountPopInitial.textContent = initial;
            var accountPopName = $('accountPopName');
            if (accountPopName) accountPopName.textContent = name;
            var accountPopEmail = $('accountPopEmail');
            if (accountPopEmail) { accountPopEmail.textContent = email; accountPopEmail.title = email; }

            var isGoogle = String(user && user.provider || '').toLowerCase() === 'google';
            var accountProvider = $('accountProvider');
            if (accountProvider) {
                accountProvider.innerHTML = isGoogle
                    ? '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.6 27.6a12 12 0 0 1 0-7.2v-5.3H5.8a20 20 0 0 0 0 17.8l6.8-5.3Z"/><path fill="#EA4335" d="M24 12c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 6 29.5 4 24 4A20 20 0 0 0 5.8 15.1l6.8 5.3C14.2 15.6 18.7 12 24 12Z"/></svg><span>Google</span>'
                    : '<img src="/assets/images/favicon.webp" alt=""><span>EmeraldNetwork</span>';
            }

            if (photo) {
                try {
                    var res = await fetch(photo, { mode: 'cors', credentials: 'omit' });
                    var blob = res.ok ? await res.blob() : null;
                    if (blob && /^image\//.test(blob.type || '')) {
                        var obj = URL.createObjectURL(blob);
                        ['profileAvatar', 'accountPopAvatar'].forEach(function (id) {
                            var img = $(id);
                            if (!img) return;
                            if (img._driveAvatarObjUrl) { try { URL.revokeObjectURL(img._driveAvatarObjUrl); } catch (_) {} }
                            img._driveAvatarObjUrl = obj;
                            img.src = obj;
                            img.hidden = false;
                        });
                        if (profileInitial) profileInitial.hidden = true;
                        var accountPopInitial = $('accountPopInitial');
                        if (accountPopInitial) accountPopInitial.hidden = true;
                    } else {
                        if (profileInitial) profileInitial.hidden = false;
                        var api = $('accountPopInitial');
                        if (api) api.hidden = false;
                    }
                } catch (_) {
                    if (profileInitial) profileInitial.hidden = false;
                    var api2 = $('accountPopInitial');
                    if (api2) api2.hidden = false;
                }
            } else {
                if (profileInitial) profileInitial.hidden = false;
                var api3 = $('accountPopInitial');
                if (api3) api3.hidden = false;
            }
        } catch (_) {}
    }

    function bindProfile() {
        var profileBtn = $('profileBtn');
        var accountPop = $('accountPop');
        if (!profileBtn || !accountPop) return;
        var hideAccount = function () {
            accountPop.hidden = true;
            profileBtn.setAttribute('aria-expanded', 'false');
        };
        profileBtn.addEventListener('click', function () {
            accountPop.hidden = !accountPop.hidden;
            profileBtn.setAttribute('aria-expanded', String(!accountPop.hidden));
        });
        document.addEventListener('mousedown', function (e) {
            if (!accountPop.hidden && !accountPop.contains(e.target) && !profileBtn.contains(e.target)) hideAccount();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideAccount(); });
        var signOut = $('accountSignOut');
        if (signOut) {
            signOut.addEventListener('click', async function () {
                if (window.EmeraldAuth && window.EmeraldAuth.logoutCurrentDevice) await window.EmeraldAuth.logoutCurrentDevice();
                window.location.href = '/account';
            });
        }
    }

    /* ---------------- mobile sidebar ---------------- */

    function openMobileSidebar() {
        var sb = document.getElementById('sidebar');
        var bd = document.getElementById('sidebarBackdrop');
        if (sb) sb.classList.add('mobile-open');
        if (bd) bd.classList.add('visible');
    }
    function closeMobileSidebar() {
        var sb = document.getElementById('sidebar');
        var bd = document.getElementById('sidebarBackdrop');
        if (sb) sb.classList.remove('mobile-open');
        if (bd) bd.classList.remove('visible');
    }
    function newFolder() {
        var n = 1;
        var base = 'New folder';
        while (folders.some(function (f) { return f.parent === state.folderId && f.name === (n === 1 ? base : base + ' ' + n); })) n++;
        folders.push({ id: 'f' + Date.now(), name: n === 1 ? base : base + ' ' + n, parent: state.view === 'mydrive' ? state.folderId : null });
        state.view = 'mydrive';
        setActiveNav('mydrive');
        switchPage(render);
        closeMobileSidebar();
    }

    window.openMobileSidebar = openMobileSidebar;
    window.closeMobileSidebar = closeMobileSidebar;
    window.newFolder = newFolder;

    /* ---------------- init ---------------- */

    async function init() {
        if (window.EmeraldAuth && window.EmeraldAuth.ready) await window.EmeraldAuth.ready();
        initTheme();
        bindProfile();
        renderAccountProfile();
        bindToolbar();
        bindSidebarNav();
        render();
        window.addEventListener('resize', updateNavPill);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateNavPill);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
