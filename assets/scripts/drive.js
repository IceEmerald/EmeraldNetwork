/* EmeraldNetwork Drive — live view of EmeraldSuite storage */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    function storage() { return window.EmeraldIDBStorage || null; }

    var DRIVE_META_KEY = 'emerald.drive.metadata.v1';
    var DRIVE_FOLDERS_KEY = 'emerald.drive.folders.v1';
    var APP_FOLDERS = [
        { id: 'suite-notes', name: 'Notes', type: 'note', color: '#a21caf' },
        { id: 'suite-docs', name: 'Docs', type: 'doc', color: '#0891b2' },
        { id: 'suite-sheets', name: 'Sheets', type: 'sheet', color: '#217346' },
        { id: 'suite-slides', name: 'Slides', type: 'slide', color: '#f97316' }
    ];
    var DEFAULT_FOLDERS = [{ id: 'suite-root', name: 'EmeraldSuite', parent: null, color: '#239a4d', system: true }]
        .concat(APP_FOLDERS.map(function (folder) {
            return { id: folder.id, name: folder.name, parent: 'suite-root', color: folder.color, system: true };
        }));

    /* ---------------- live Drive data ---------------- */

    var TYPE_META = {
        doc:    { label: 'Document',     color: '#0891b2', soft: 'rgba(8,145,178,.12)' },
        note:   { label: 'Note',         color: '#a21caf', soft: 'rgba(162,28,175,.12)' },
        slide:  { label: 'Presentation', color: '#f97316', soft: 'rgba(249,115,22,.12)' },
        sheet:  { label: 'Spreadsheet',  color: '#217346', soft: 'rgba(33,115,70,.12)' },
        image:  { label: 'Image',        color: '#e11d48', soft: 'rgba(225,29,72,.12)' },
        pdf:    { label: 'PDF',          color: '#dc2626', soft: 'rgba(220,38,38,.12)' },
        other:  { label: 'File',         color: '#64748b', soft: 'rgba(100,116,139,.12)' }
    };

    var TYPE_ICONS = {
        doc: '/assets/images/docsicon.webp',
        note: '/assets/images/notesicon.webp',
        slide: '/assets/images/slidesicon.webp',
        sheet: '/assets/images/sheetsicon.webp'
    };

    var folders = [];
    var files = [];
    var metadata = {};

    var state = { view: 'home', folderId: null, layout: 'grid', sort: 'modified', search: '' };
    var currentUserName = '';

    function itemKey(type, id) { return type + ':' + String(id); }

    async function readJSON(key, fallback) {
        var s = storage();
        if (!s || !s.getJSON) return fallback;
        try { var value = await s.getJSON(key); return value == null ? fallback : value; } catch (_) { return fallback; }
    }

    async function writeJSON(key, value) {
        var s = storage();
        if (s && s.setJSON) await s.setJSON(key, value);
    }

    function sheetDatabase() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var request = indexedDB.open('emeraldcore.storage.suite.sheets', 1);
            request.onupgradeneeded = function () {
                if (!request.result.objectStoreNames.contains('workbooks')) request.result.createObjectStore('workbooks');
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
    }

    function idbResult(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
    }

    async function loadDriveData() {
        var s = storage();
        if (s && s.ready) await s.ready();
        var savedFolders = await readJSON(DRIVE_FOLDERS_KEY, []);
        folders = DEFAULT_FOLDERS.map(function (folder) {
            var saved = Array.isArray(savedFolders) && savedFolders.find(function (entry) { return entry.id === folder.id; });
            return Object.assign({}, folder, saved || {});
        });
        if (Array.isArray(savedFolders)) savedFolders.forEach(function (folder) {
            if (folder && folder.id && !folders.some(function (entry) { return entry.id === folder.id; })) folders.push(folder);
        });
        metadata = await readJSON(DRIVE_META_KEY, {});
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};

        var apps = [
            { key: 'emeraldcore.storage.suite.notes', type: 'note', route: '/notes', empty: 'Untitled note' },
            { key: 'emeraldcore.storage.suite.docs', type: 'doc', route: '/docs', empty: 'Untitled document' },
            { key: 'emeraldcore.storage.suite.slides', type: 'slide', route: '/slides', empty: 'Untitled presentation' }
        ];
        var nextFiles = [];
        for (var ai = 0; ai < apps.length; ai++) {
            var app = apps[ai];
            var records = await readJSON(app.key, []);
            if (!Array.isArray(records)) continue;
            records.forEach(function (record) {
                if (!record || record.id == null) return;
                var meta = metadata[itemKey(app.type, record.id)] || {};
                nextFiles.push({
                    id: String(record.id), name: String(record.title || record.name || app.empty), type: app.type,
                    appType: app.type === 'note' ? 'notes' : (app.type === 'doc' ? 'docs' : 'slides'),
                    folder: Object.prototype.hasOwnProperty.call(meta, 'folder') ? meta.folder : (app.type === 'note' ? 'suite-notes' : (app.type === 'doc' ? 'suite-docs' : 'suite-slides')),
                    size: '—', modified: relativeOrOriginalDate(record.updatedAt || record.modifiedAt || record.createdAt),
                    modifiedAt: record.updatedAt || record.modifiedAt || record.createdAt || 0,
                    starred: !!meta.starred, shared: false, trashed: !!meta.trashed,
                    trashedAt: meta.trashedAt || 0, openedAt: meta.openedAt || 0, route: app.route
                });
            });
        }
        try {
            var db = await sheetDatabase();
            var store = db.transaction('workbooks', 'readonly').objectStore('workbooks');
            var keys = await idbResult(store.getAllKeys());
            var values = await idbResult(store.getAll());
            var workbookMap = {};
            keys.forEach(function (id, index) { workbookMap[String(id)] = values[index]; });
            var syncedWorkbooks = await readJSON('emeraldcore.storage.suite.sheets.sync.v1', {});
            Object.keys(syncedWorkbooks || {}).forEach(function (id) { if (!workbookMap[id]) workbookMap[id] = syncedWorkbooks[id]; });
            Object.keys(workbookMap).forEach(function (id) {
                var record = workbookMap[id];
                var data = record && record.data || {};
                var meta = metadata[itemKey('sheet', id)] || {};
                nextFiles.push({
                    id: String(id), name: String(data.title || 'Untitled spreadsheet'), type: 'sheet', appType: 'sheets',
                    folder: Object.prototype.hasOwnProperty.call(meta, 'folder') ? meta.folder : 'suite-sheets', size: '—', modified: relativeOrOriginalDate(record.savedAt || data.createdAt),
                    modifiedAt: record.savedAt || data.createdAt || 0, starred: !!meta.starred, shared: false,
                    trashed: !!meta.trashed, trashedAt: meta.trashedAt || 0, openedAt: meta.openedAt || 0, route: '/sheets'
                });
            });
            db.close();
        } catch (error) { console.warn('[Drive] Could not read EmeraldSheets:', error); }
        files = nextFiles;
        var currentMeta = metadata;
        var repaired = false;
        files.forEach(function (file) {
            var key = itemKey(file.type, file.id);
            if (!currentMeta[key]) { currentMeta[key] = { folder: file.folder }; repaired = true; }
        });
        if (repaired) await writeJSON(DRIVE_META_KEY, metadata);
    }

    async function saveMetadata() { await writeJSON(DRIVE_META_KEY, metadata); }
    async function saveFolders() { await writeJSON(DRIVE_FOLDERS_KEY, folders); }

    /* ---------------- helpers ---------------- */

    function childrenOf(folderId) {
        return folders.filter(function (f) { return f.parent === folderId && !f.trashed; });
    }

    function descendantFolderIds(folderId) {
        var ids = [];
        var pending = [folderId];
        while (pending.length) {
            var parent = pending.pop();
            folders.filter(function (folder) { return folder.parent === parent; }).forEach(function (folder) {
                if (ids.indexOf(folder.id) === -1) { ids.push(folder.id); pending.push(folder.id); }
            });
        }
        return ids;
    }

    function filesIn(folderId) {
        return files.filter(function (f) { return f.folder === folderId && !f.trashed; });
    }

    function fileCreated(item) {
        return item.created || item.createdAt || item.created_at || '—';
    }

    function bytesFromSize(size) {
        var match = String(size || '').match(/([\d.]+)\s*(B|KB|MB|GB|TB)?/i);
        if (!match) return 0;
        var units = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
        return Number(match[1]) * (units[(match[2] || 'B').toUpperCase()] || 1);
    }

    function formatBytes(bytes) {
        if (!bytes) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        var value = bytes / Math.pow(1024, index);
        return (index === 0 ? Math.round(value) : parseFloat(value.toFixed(1))) + ' ' + units[index];
    }

    function folderStats(folderId) {
        var descendants = childrenOf(folderId);
        var nestedIds = descendants.reduce(function (ids, folder) { return ids.concat([folder.id], folderStats(folder.id).folderIds); }, []);
        var folderIds = [folderId].concat(nestedIds);
        var containedFiles = files.filter(function (file) { return folderIds.indexOf(file.folder) !== -1 && !file.trashed; });
        var newest = containedFiles.reduce(function (latest, file) {
            var date = file.modifiedAt || file.modified_at || file.updatedAt || file.updated_at || file.modified;
            if (!date) return latest;
            if (!latest || recencyMs(date) < recencyMs(latest)) return date;
            return latest;
        }, '');
        return {
            folderIds: nestedIds,
            size: formatBytes(containedFiles.reduce(function (total, file) { return total + bytesFromSize(file.size); }, 0)),
            modified: newest ? relativeOrOriginalDate(newest) : '—'
        };
    }

    function recencyMs(value) {
        var date = new Date(value);
        if (!isNaN(date.getTime())) return Math.max(0, Date.now() - date.getTime());
        var text = String(value).toLowerCase();
        if (text === 'today' || text.indexOf('just now') !== -1) return 0;
        if (text === 'yesterday') return 86400000;
        var match = text.match(/([\d.]+)\s*(m|min|h|d|w|mo|y)/);
        if (!match) return Number.MAX_SAFE_INTEGER;
        var multipliers = { m: 60000, min: 60000, h: 3600000, d: 86400000, w: 604800000, mo: 2592000000, y: 31536000000 };
        return Number(match[1]) * multipliers[match[2]];
    }

    function relativeOrOriginalDate(value) {
        if (!value) return '—';
        var date = new Date(value);
        return !isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : String(value);
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
            return itemRecentTime(b) - itemRecentTime(a);
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

    function fileIconSvg(type, name) {
        var extension = String(name || '').split('.').pop().toLowerCase();
        var category = type;
        var extensions = {
            pdf: ['pdf'], image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'tif', 'tiff', 'ico'],
            archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst'],
            audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'wma', 'opus', 'mid', 'midi'],
            video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'm4v', 'mpeg', 'mpg', '3gp'],
            code: ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bash', 'sql', 'html', 'htm', 'css', 'scss', 'json', 'xml', 'yaml', 'yml'],
            text: ['txt', 'md', 'markdown', 'log'],
            document: ['doc', 'docx', 'odt', 'pages', 'rtf'],
            spreadsheet: ['xls', 'xlsx', 'ods', 'numbers', 'tsv'],
            presentation: ['ppt', 'pptx', 'odp', 'key']
        };
        if (String(category || '').indexOf('/') !== -1) {
            category = /^image\//i.test(category) ? 'image' : (/^audio\//i.test(category) ? 'audio' : (/^video\//i.test(category) ? 'video' : (/pdf/i.test(category) ? 'pdf' : 'other')));
        }
        if (!extensions[category]) {
            Object.keys(extensions).some(function (key) {
                if (extensions[key].indexOf(extension) !== -1) { category = key; return true; }
                return false;
            });
        }
        var paths = {
            pdf: '<path d="M6 2.8h8l4.2 4.3v14.1H6z"/><path d="M14 3v5h5M8.5 14.5h7M8.5 17.5h5"/><path d="M8.5 11.2h7"/>',
            image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="m5 17 4.5-4 3.2 2.6 2.4-2.1 4 3.5"/>',
            archive: '<path d="M4 7h16v13H4z"/><path d="M3 4h18v4H3zM10 11h4v3h-4z"/>',
            audio: '<path d="M10 18V5l10-2v13"/><circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
            video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
            code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M14 5l-4 14"/>',
            text: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6M9 15h6M9 18h4"/>',
            document: '<path d="M6 2.8h8l4.2 4.3v14.1H6z"/><path d="M14 3v5h5M9 13h6M9 16h6M9 19h4"/>',
            spreadsheet: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9h17M9 4.5v15M15 4.5v15M3.5 14h17"/>',
            presentation: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M12 17v4M8 21h8M9 9h6M9 12h4"/>',
            file: '<path d="M6 2.8h8l4.2 4.3v14.1H6z"/><path d="M14 3v5h5M9 13h6M9 16h6"/>'
        };
        var colors = { pdf: '#d64545', image: '#4389c7', archive: '#7a8792', audio: '#8c67bd', video: '#6375c7', code: '#bf8b35', text: '#64748b', document: '#4389c7', spreadsheet: '#438b5f', presentation: '#c77753', file: '#64748b' };
        var shape = paths[category] || paths.file;
        return '<svg class="dfile-type-svg" viewBox="0 0 24 24" fill="none" stroke="' + (colors[category] || colors.file) + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + shape + '</svg>';
    }

    function typeBadge(type, name) {
        var m = TYPE_META[type] || TYPE_META.other;
        var icon = TYPE_ICONS[type]
            ? '<img src="' + TYPE_ICONS[type] + '" alt="" aria-hidden="true">'
            : fileIconSvg(type, name);
        return '<span class="dfile-badge" aria-hidden="true" style="color:' + m.color + ';background:#fff">' + icon + '</span>';
    }

    function filePreview(type) {
        if (type === 'note') {
            return '<div class="dfile-preview-page dpreview-note"><span class="dpreview-note-margin"></span><div class="dpreview-note-lines">' +
                [72, 88, 64, 82, 54, 78, 68].map(function (width) { return '<i style="width:' + width + '%"></i>'; }).join('') + '</div></div>';
        }
        if (type === 'sheet') {
            return '<div class="dfile-preview-page dpreview-sheet"><span class="dpreview-sheet-toolbar"></span><span class="dpreview-sheet-head"></span><div class="dpreview-sheet-grid">' +
                new Array(30).join('<i></i>') + '</div></div>';
        }
        if (type === 'slide') {
            return '<div class="dfile-preview-page dpreview-slide"><span class="dpreview-slide-art"></span><span class="dpreview-slide-title"></span><span class="dpreview-slide-copy"></span></div>';
        }
        return '<div class="dfile-preview-page dpreview-doc"><span class="dpreview-doc-title"></span><div class="dpreview-doc-lines">' +
            [64, 82, 78, 70, 86, 58, 76, 68].map(function (width) { return '<i style="width:' + width + '%"></i>'; }).join('') + '</div></div>';
    }

    /* ---------------- rendering ---------------- */

    function renderCrumbs() {
        var el = $('driveCrumbs');
        if (!el) return;
        var html = '';
        if (state.view === 'mydrive') {
            var path = folderPath(state.folderId);
            var crumbs = [{ id: 'root', name: 'My Drive', root: true }];
            path.forEach(function (folder) { crumbs.push({ id: folder.id, name: folder.name }); });
            var collapsed = crumbs.length > 6;
            if (collapsed) crumbs = [crumbs[0], { ellipsis: true }].concat(crumbs.slice(-5));
            for (var i = 0; i < crumbs.length; i++) {
                if (i) html += '<span class="dcrumb-sep" aria-hidden="true">›</span>';
                if (crumbs[i].ellipsis) {
                    html += '<span class="dcrumb-ellipsis" title="Earlier folders hidden" aria-label="Earlier folders hidden">...</span>';
                } else {
                    var isCurrent = i === crumbs.length - 1;
                    html += '<button class="dcrumb' + (isCurrent ? ' current' : '') + '" data-crumb="' + crumbs[i].id + '" title="' + esc(crumbs[i].name) + '">' + esc(crumbs[i].name) + '</button>';
                }
            }
        } else {
            var titles = { home: 'Home', shared: 'Shared with me', recent: 'Recent', starred: 'Starred', trash: 'Trash' };
            html += '<span class="dcrumb dcrumb-view current">' + (titles[state.view] || 'Drive') + '</span>';
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
            var gradientId = 'folderGradient-' + esc(item.id);
            var color = item.color || '#f3b900';
            return '<button class="dfolder-card" data-folder="' + item.id + '" style="--folder-color:' + color + '">' +
                '<span class="dfolder-icon"><svg viewBox="0 0 160 110" aria-hidden="true">' +
                    '<defs><linearGradient id="' + gradientId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + color + '"/><stop offset="1" stop-color="' + color + '" stop-opacity=".72"/></linearGradient></defs>' +
                    '<path d="M12 27a9 9 0 0 1 9-9h43c5 0 8 2 11 5l10 11h63a9 9 0 0 1 9 9v48a9 9 0 0 1-9 9H21a9 9 0 0 1-9-9z" fill="' + color + '"/>' +
                    '<path d="M12 36h51c6 0 9-2 13-6l9-9h63a9 9 0 0 1 9 9v61a9 9 0 0 1-9 9H21a9 9 0 0 1-9-9z" fill="url(#' + gradientId + ')" stroke="' + color + '" stroke-width="1.5"/>' +
                    '<path d="M14 35h49c6 0 9-2 13-6l8-8" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="2.5"/>' +
                '</svg></span>' +
                '<span class="dfolder-name">' + esc(item.name) + '</span>' +
                '</button>';
        }
        var m = TYPE_META[item.type] || TYPE_META.other;
        return '<div class="dfile-card" data-file="' + item.id + '">' +
            '<div class="dfile-thumb dfile-thumb--' + esc(item.type || 'other') + '">' + filePreview(item.type) + typeBadge(item.type, item.name) +
                (item.starred ? '<span class="dfile-star" title="Starred" aria-label="Starred"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.83 5.74 6.34.92-4.59 4.47 1.08 6.31L12 17.26l-5.66 2.98 1.08-6.31-4.59-4.47 6.34-.92L12 2.8z"/></svg></span>' : '') +
            '</div>' +
            '<div class="dfile-body"><div class="dfile-name">' + esc(item.name) + '</div>' +
            '<div class="dfile-meta">' + esc(m.label) + ' · ' + esc(item.size) + ' · ' + esc(item.modified) + '</div></div></div>';
    }

    function rowHTML(item, isFolder) {
        var m = isFolder ? null : (TYPE_META[item.type] || TYPE_META.other);
        if (isFolder) {
            var stats = folderStats(item.id);
            return '<div class="drow" data-folder="' + item.id + '" role="button" tabindex="0">' +
                '<span class="drow-name"><span class="drow-icon" style="color:#8a8886"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span><span class="drow-label">' + esc(item.name) + '</span></span>' +
                '<span class="drow-meta">' + esc(stats.size) + '</span><span class="drow-meta">' + esc(stats.modified) + '</span></div>';
        }
        return '<div class="drow" data-file="' + item.id + '" role="button" tabindex="0">' +
            '<span class="drow-name"><span class="drow-icon" style="color:' + m.color + '">' + typeBadge(item.type, item.name) + '</span><span class="drow-label">' + esc(item.name) + '</span></span>' +
            '<span class="drow-meta">' + esc(m.label) + '</span>' +
            '<span class="drow-meta">' + esc(item.size) + '</span>' +
            '<span class="drow-meta">' + esc(fileCreated(item)) + '</span>' +
            '<span class="drow-meta">' + esc(item.modified || '—') + '</span></div>';
    }

    function section(title, innerHTML) {
        return '<section class="dsection"><h2 class="dsection-title">' + esc(title) + '</h2>' + innerHTML + '</section>';
    }

    function gridHTML(list) {
        return '<div class="dgrid">' + list.map(function (i) { return cardHTML(i, i.type === undefined); }).join('') + '</div>';
    }
    function listHTML(list, isFolderList) {
        var columns = isFolderList ? ['Name', 'Size (total)', 'Modified'] : ['Name', 'Type', 'Size', 'Created', 'Modified'];
        return '<div class="dlist ' + (isFolderList ? 'dlist-folders' : 'dlist-files') + '" data-list-kind="' + (isFolderList ? 'folders' : 'files') + '"><div class="drow drow-head">' +
            columns.map(function (label, index) {
                return '<span class="drow-cell drow-head-cell' + (index === 0 ? ' drow-name' : ' drow-meta') + '">' + label + (index < columns.length - 1 ? '<span class="dcol-resize" role="separator" aria-orientation="vertical" aria-label="Resize ' + label + ' column"></span>' : '') + '</span>';
            }).join('') + '</div>' +
            list.map(function (i) { return rowHTML(i, isFolderList); }).join('') + '</div>';
    }
    function layoutHTML(list) { return state.layout === 'list' ? listHTML(list, false) : gridHTML(list); }
    function folderLayoutHTML(list) {
        return state.layout === 'list' ? listHTML(list, true) :
            '<div class="dfolder-grid">' + list.map(function (folder) { return cardHTML(folder, true); }).join('') + '</div>';
    }

    function emptyHTML(title, text, image) {
        var img = image ? '<img class="dempty-img" src="' + esc(image) + '" alt="" aria-hidden="true">' : '';
        return '<div class="dempty">' + img + '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p></div>';
    }

    var forcedHomeDaypart = null;
    var renderedHomeSkyPart = null;
    var renderedHomeSkyElement = null;

    function homeDaypart() {
        if (forcedHomeDaypart) return forcedHomeDaypart;
        var h = new Date().getHours();
        return h < 12 ? 'morning' : (h < 18 ? 'afternoon' : 'evening');
    }

    window.driveDaypart = function (part) {
        var valid = ['morning', 'afternoon', 'evening'];
        if (part === undefined || part === null) forcedHomeDaypart = null;
        else if (valid.indexOf(part) !== -1) forcedHomeDaypart = part;
        else { console.warn('driveDaypart: expected one of', valid); return; }
        updateHomeGreeting();
        buildHomeSky(homeDaypart());
        console.log('[drive] daypart =', homeDaypart(), '(forced=' + !!forcedHomeDaypart + ')');
    };

    function homeGreeting() {
        var part = homeDaypart();
        var base = part === 'morning' ? 'Good morning' : (part === 'afternoon' ? 'Good afternoon' : 'Good evening');
        var name = String(currentUserName || '').trim();
        var first = name && name !== 'Emerald user' ? name.split(/\s+/)[0] : '';
        return base + (first ? ', ' + first : '');
    }

    function updateHomeGreeting() {
        var el = document.querySelector('.dhome-hero h1');
        if (el) el.textContent = homeGreeting();
        var hero = document.querySelector('.dhome-hero');
        if (hero) hero.setAttribute('data-daypart', homeDaypart());
        var content = $('driveContent');
        if (content) content.setAttribute('data-daypart', homeDaypart());
        buildHomeSky(homeDaypart());
    }

    var SKY_STAR_TINTS = [
        ['#ffffff', 5], ['#e8f1ff', 3], ['#cfe0ff', 2], ['#fff4e2', 2], ['#ffd9a8', 1]
    ];

    function skyHexToRgba(hex, alpha) {
        var n = parseInt(hex.slice(1), 16);
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
    }

    function pickSkyStarTint() {
        var total = SKY_STAR_TINTS.reduce(function (sum, tint) { return sum + tint[1]; }, 0);
        var pick = Math.random() * total;
        for (var i = 0; i < SKY_STAR_TINTS.length; i++) {
            pick -= SKY_STAR_TINTS[i][1];
            if (pick <= 0) return SKY_STAR_TINTS[i][0];
        }
        return SKY_STAR_TINTS[0][0];
    }

    function skyStarPosition() {
        var x = Math.random() * 100;
        if (Math.random() < .7) {
            var centre = 46 - x * .34;
            var spread = 13 + Math.random() * 11;
            return { x: x, y: Math.max(-2, Math.min(58, centre + (Math.random() * 2 - 1) * spread)) };
        }
        return { x: x, y: Math.random() * 58 };
    }

    function buildHomeSky(part) {
        var sky = document.querySelector('.dhome-hero .su-sky');
        if (!sky) return;
        if (renderedHomeSkyElement === sky && renderedHomeSkyPart === part) return;
        var previousSky = renderedHomeSkyElement;
        var sameDaypart = renderedHomeSkyPart === part;
        renderedHomeSkyElement = sky;
        renderedHomeSkyPart = part;
        sky.innerHTML = '';
        if (sameDaypart && previousSky) {
            Array.prototype.forEach.call(previousSky.childNodes, function (node) {
                sky.appendChild(node.cloneNode(true));
            });
            return;
        }
        if (part === 'morning') {
            var rays = document.createElement('div');
            rays.className = 'su-rays';
            var angle = 4;
            for (var r = 0; r < 9; r++) {
                var ray = document.createElement('i');
                ray.className = 'su-ray';
                angle += 5 + Math.random() * 9;
                var edge = 1 - Math.abs(r / 8 - .5) * 1.5;
                ray.style.transform = 'rotate(' + angle.toFixed(1) + 'deg)';
                ray.style.setProperty('--w', (40 + Math.random() * 64 * Math.max(.45, edge)).toFixed(0) + 'px');
                ray.style.setProperty('--blur', (12 + Math.random() * 18).toFixed(1) + 'px');
                ray.style.setProperty('--dur', (7 + Math.random() * 7).toFixed(2) + 's');
                ray.style.setProperty('--delay', (Math.random() * 6).toFixed(2) + 's');
                rays.appendChild(ray);
            }
            sky.appendChild(rays);
            return;
        }
        if (part !== 'evening') return;

        var fragment = document.createDocumentFragment();
        for (var s = 0; s < 78; s++) {
            var star = document.createElement('i');
            star.className = 'su-star';
            var size = 1 + Math.round(Math.random() * 2.6);
            if (size >= 3) star.classList.add('big');
            var tint = pickSkyStarTint();
            var pos = skyStarPosition();
            star.style.width = size.toFixed(1) + 'px';
            star.style.height = size.toFixed(1) + 'px';
            star.style.setProperty('--tint', tint);
            if (size >= 3) star.style.setProperty('--glow', skyHexToRgba(tint, .55));
            star.style.left = pos.x.toFixed(2) + '%';
            star.style.top = pos.y.toFixed(2) + '%';
            star.style.setProperty('--dur', (2.4 + Math.random() * 4.2).toFixed(2) + 's');
            star.style.setProperty('--delay', (Math.random() * 5).toFixed(2) + 's');
            fragment.appendChild(star);
        }
        for (var shootIndex = 0; shootIndex < 2; shootIndex++) {
            var shooting = document.createElement('i');
            shooting.className = 'su-shooting';
            shooting.style.animationDelay = (2 + Math.random() * 7 + shootIndex * 5).toFixed(2) + 's';
            fragment.appendChild(shooting);
        }
        sky.appendChild(fragment);
    }

    function homeHeroHTML() {
        return '<section class="dhome-hero su-shell">' +
            '<div class="su-sky" aria-hidden="true"></div>' +
            '<div class="dhome-hero-copy">' +
                '<h1>' + esc(homeGreeting()) + '</h1>' +
                '<p>Your files are right where you need them. Pick up a recent project or make something new.</p>' +
            '</div>' +
        '</section>';
    }

    function render() {
        var box = $('driveContent');
        if (!box) return;
        var count = $('driveFileCount');
        if (count) {
            var liveCount = files.filter(function (file) { return !file.trashed; }).length;
            count.textContent = liveCount + (liveCount === 1 ? ' file' : ' files');
        }
        setActiveNav(state.view);
        var html = '';
        var q = state.search;

        if (state.view === 'home') {
            var recent = filterSearch(files.filter(function (f) { return !f.trashed; })).slice().sort(function (a, b) {
                return itemRecentTime(b) - itemRecentTime(a);
            }).slice(0, 4);
            if (q) {
                var all = filterSearch(files.filter(function (f) { return !f.trashed; }));
                html += all.length ? layoutHTML(all) : emptyHTML('No results', 'Nothing matches your search.', '/assets/images/nofilefound.webp');
            } else {
                html += homeHeroHTML();
                var suggested = recent.slice(0, 3);
                if (suggested.length) html += section('Suggested', layoutHTML(suggested));
                if (recent.length) html += section('Recent files', layoutHTML(recent));
                if (!recent.length) html += emptyHTML('Nothing here yet', 'Your recent files will appear here.');
            }
        } else if (state.view === 'mydrive') {
            var foldersHere = filterSearch(childrenOf(state.folderId));
            var filesHere = sortList(filterSearch(filesIn(state.folderId)));
            if (!foldersHere.length && !filesHere.length) {
                html += emptyHTML('Nothing here yet', q ? 'No matches in this folder.' : 'This folder is empty.', q ? '/assets/images/nofilefound.webp' : null);
            } else {
                if (foldersHere.length) html += section('Folders', folderLayoutHTML(foldersHere));
                if (filesHere.length) html += section('Files', layoutHTML(filesHere));
            }
        } else if (state.view === 'shared') {
            var shared = sortList(filterSearch(files.filter(function (f) { return f.shared && !f.trashed; })));
            html += shared.length ? layoutHTML(shared) : emptyHTML('Nothing shared yet', 'Files shared with you will show up here.', '/assets/images/nofilefound.webp');
        } else if (state.view === 'recent') {
            var rec = filterSearch(files.filter(function (f) { return !f.trashed; })).slice().sort(function (a, b) {
                return itemRecentTime(b) - itemRecentTime(a);
            });
            html += rec.length ? layoutHTML(rec) : emptyHTML('No recent files', 'Open a file and it will show up here.', '/assets/images/nofilefound.webp');
        } else if (state.view === 'starred') {
            var st = sortList(filterSearch(files.filter(function (f) { return f.starred && !f.trashed; })));
            html += st.length ? layoutHTML(st) : emptyHTML('No starred files', 'Star a file to pin it here.', '/assets/images/nofilefound.webp');
        } else if (state.view === 'trash') {
            html += '<div class="dtrash-banner"><span class="dtrash-banner-icon" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span><span>Restore items or delete them permanently from here.</span></div>';
            var tr = sortList(filterSearch(files.filter(function (f) { return f.trashed; })));
            var trashedFolders = filterSearch(folders.filter(function (folder) { return folder.trashed; }));
            if (trashedFolders.length) html += section('Folders', folderLayoutHTML(trashedFolders));
            if (tr.length) html += section('Files', layoutHTML(tr));
            if (!tr.length && !trashedFolders.length) html += emptyHTML('Trash is empty', 'Deleted files appear here for 30 days.', '/assets/images/nofilefound.webp');
        }

        box.innerHTML = html;
        box.removeAttribute('aria-busy');
        updateHomeGreeting();
        if (state.view === 'home' && !state.search) buildHomeSky(homeDaypart());
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
        box.querySelectorAll('[data-file]').forEach(function (n) {
            n.addEventListener('click', function (event) {
                if (event.target.closest('[data-action]')) return;
                var file = files.find(function (entry) { return String(entry.id) === n.getAttribute('data-file'); });
                if (file && !file.trashed) openDriveFile(file);
            });
            n.addEventListener('keydown', function (event) {
                if ((event.key === 'Enter' || event.key === ' ') && event.target === n) {
                    event.preventDefault();
                    var file = files.find(function (entry) { return String(entry.id) === n.getAttribute('data-file'); });
                    if (file && !file.trashed) openDriveFile(file);
                }
            });
        });
    }

    function metaFor(item) {
        return metadata[itemKey(item.type, item.id)] || (metadata[itemKey(item.type, item.id)] = {});
    }

    function itemRecentTime(item) {
        if (Number(item.openedAt)) return Number(item.openedAt);
        var timestamp = new Date(item.modifiedAt).getTime();
        return Number.isFinite(timestamp) ? timestamp : 0;
    }

    async function openDriveFile(item) {
        var meta = metaFor(item);
        meta.openedAt = Date.now();
        await saveMetadata();
        location.href = item.route + '?owned=' + encodeURIComponent(item.id);
    }

    function updateDriveSyncStatus(detail) {
        var button = $('driveSyncStatus');
        var text = $('driveSyncText');
        if (!button || !text) return;
        var status = detail && detail.state || 'idle';
        button.classList.toggle('syncing', status === 'syncing' || !!(detail && detail.pending));
        button.classList.toggle('offline', status === 'offline' || status === 'error');
        if (status === 'syncing') text.textContent = 'Syncing…';
        else if (status === 'offline' || (detail && detail.online === false)) text.textContent = 'Offline';
        else if (status === 'signed-out') text.textContent = 'Local changes';
        else if (status === 'error') text.textContent = 'Sync paused';
        else if (detail && detail.pending) text.textContent = 'Changes pending';
        else text.textContent = 'All changes synced';
        button.title = detail && detail.error ? detail.error : 'Click to sync now';
    }

    async function moveToTrash(item) {
        var meta = metaFor(item);
        meta.trashed = true;
        meta.trashedAt = Date.now();
        await saveMetadata();
        await loadDriveData();
        render();
    }

    async function restoreFromTrash(item) {
        var meta = metaFor(item);
        meta.trashed = false;
        delete meta.trashedAt;
        await saveMetadata();
        await loadDriveData();
        render();
    }

    function showDriveToast(message) {
        if (window.showToast) window.showToast(message);
        else {
            var toast = $('custom-toast');
            if (toast) { toast.textContent = message; toast.classList.add('show'); setTimeout(function () { toast.classList.remove('show'); }, 2600); }
        }
    }

    function routeForType(type) {
        return type === 'note' ? '/notes' : type === 'doc' ? '/docs' : type === 'slide' ? '/slides' : type === 'sheet' ? '/sheets' : '';
    }

    async function updateSuiteRecord(item, transform, remove) {
        var s = storage();
        if (!s) throw new Error('Local storage is not ready');
        var key = item.appType === 'notes' ? 'emeraldcore.storage.suite.notes' :
            item.appType === 'docs' ? 'emeraldcore.storage.suite.docs' :
                item.appType === 'slides' ? 'emeraldcore.storage.suite.slides' : null;
        if (key) {
            var list = await s.getJSON(key);
            list = Array.isArray(list) ? list : [];
            var index = list.findIndex(function (record) { return record && String(record.id) === String(item.id); });
            if (index < 0) return null;
            if (remove) list.splice(index, 1); else transform(list[index]);
            await s.setJSON(key, list);
            return { list: list, key: key };
        }
        if (item.appType === 'sheets') {
            var db = await sheetDatabase();
            var tx = db.transaction('workbooks', remove ? 'readonly' : 'readonly');
            var store = tx.objectStore('workbooks');
            var record = await idbResult(store.get(item.id));
            if (record && !remove) {
                transform(record);
                await new Promise(function (resolve, reject) {
                    var writeTx = db.transaction('workbooks', 'readwrite');
                    writeTx.objectStore('workbooks').put(record, item.id);
                    writeTx.oncomplete = resolve;
                    writeTx.onerror = function () { reject(writeTx.error); };
                });
            }
            if (remove) {
                await new Promise(function (resolve, reject) {
                    var writeTx = db.transaction('workbooks', 'readwrite');
                    writeTx.objectStore('workbooks').delete(item.id);
                    writeTx.oncomplete = resolve;
                    writeTx.onerror = function () { reject(writeTx.error); };
                });
                var synced = await readJSON('emeraldcore.storage.suite.sheets.sync.v1', {});
                delete synced[String(item.id)];
                await writeJSON('emeraldcore.storage.suite.sheets.sync.v1', synced);
            }
            db.close();
            return { record: record };
        }
        return null;
    }

    async function renameDriveItem(item, newName) {
        var title = String(newName || '').trim();
        if (!title) return;
        if (item.type === 'folder') {
            var folder = folders.find(function (entry) { return String(entry.id) === String(item.id); });
            if (folder) folder.name = title;
            await saveFolders();
        } else {
            await updateSuiteRecord(item, function (record) {
                if (item.appType === 'sheets') record.data.title = title;
                else record.title = title;
                if (item.appType === 'notes') record.updatedAt = new Date().toISOString();
                else record.updatedAt = Date.now();
            });
        }
        await loadDriveData();
        render();
    }

    async function duplicateFile(item, targetFolder) {
        var newId = 'copy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        var copyName = item.name + ' copy';
        var result = await updateSuiteRecord(item, function () {});
        var s = storage();
        if (item.appType === 'sheets') {
            var db = await sheetDatabase();
            var record = result && result.record;
            if (record) {
                record = JSON.parse(JSON.stringify(record));
                record.data.title = copyName;
                record.data.id = newId;
                record.savedAt = Date.now();
                await new Promise(function (resolve, reject) {
                    var tx = db.transaction('workbooks', 'readwrite');
                    tx.objectStore('workbooks').put(record, newId);
                    tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
                });
            }
            db.close();
        } else if (s) {
            var indexKey = result && result.key;
            var sourceList = result && result.list || [];
            var source = sourceList.find(function (record) { return record && String(record.id) === String(item.id); });
            if (source) {
                var clone = JSON.parse(JSON.stringify(source));
                clone.id = newId; clone.title = copyName; clone.updatedAt = Date.now();
                sourceList.push(clone);
                await s.setJSON(indexKey, sourceList);
                var dataKey = 'emeraldcore.storage.suite.' + item.appType + '.' + item.id;
                var data = await s.getJSON(dataKey);
                if (data) { data = JSON.parse(JSON.stringify(data)); data.id = newId; data.title = copyName; await s.setJSON('emeraldcore.storage.suite.' + item.appType + '.' + newId, data); }
            }
        }
        metadata[itemKey(item.type, newId)] = { folder: targetFolder === undefined ? item.folder : targetFolder };
        await saveMetadata(); await loadDriveData(); render();
    }

    async function runContextAction(action, id, isFolder, color) {
        var item = isFolder
            ? folders.find(function (entry) { return String(entry.id) === String(id); })
            : files.find(function (entry) { return String(entry.id) === String(id); });
        if (!item) return;
        try {
            if (action === 'open') {
                if (isFolder) { state.view = 'mydrive'; state.folderId = item.id; setActiveNav('mydrive'); render(); }
                else if (!item.trashed) await openDriveFile(item);
            } else if (action === 'delete') {
                if (isFolder) {
                    var childIds = [item.id].concat(descendantFolderIds(item.id));
                    folders.filter(function (folder) { return childIds.indexOf(folder.id) !== -1; }).forEach(function (folder) { folder.trashed = true; });
                    files.filter(function (file) { return childIds.indexOf(file.folder) !== -1 && !file.trashed; }).forEach(function (file) {
                        var meta = metaFor(file); meta.trashed = true; meta.trashedAt = Date.now();
                    });
                } else { var fileMeta = metaFor(item); fileMeta.trashed = true; fileMeta.trashedAt = Date.now(); }
                await saveMetadata(); await saveFolders(); await loadDriveData(); render();
            } else if (action === 'restore') {
                if (isFolder) {
                    var restoreIds = [item.id].concat(descendantFolderIds(item.id));
                    folders.filter(function (folder) { return restoreIds.indexOf(folder.id) !== -1; }).forEach(function (folder) { folder.trashed = false; });
                    files.filter(function (file) { return restoreIds.indexOf(file.folder) !== -1 && file.trashed; }).forEach(function (file) {
                        var restoreMeta = metaFor(file); restoreMeta.trashed = false; delete restoreMeta.trashedAt;
                    });
                } else await restoreFromTrash(item);
                await saveFolders(); await loadDriveData(); render();
            } else if (action === 'purge') {
                if (isFolder) {
                    var removeIds = [item.id].concat(descendantFolderIds(item.id));
                    folders = folders.filter(function (folder) { return removeIds.indexOf(folder.id) === -1; });
                    await saveFolders();
                } else {
                    await updateSuiteRecord(item, function () {}, true);
                    delete metadata[itemKey(item.type, item.id)]; await saveMetadata();
                }
                await loadDriveData(); render();
            } else if (action === 'star') {
                var meta = metaFor(item); meta.starred = !meta.starred; item.starred = meta.starred;
                await saveMetadata(); render();
            } else if (action === 'folder-color') {
                item.color = color; await saveFolders(); render();
            } else if (action === 'rename') {
                var nextName = window.prompt('Enter a new name', item.name);
                if (nextName !== null) await renameDriveItem(item, nextName);
            } else if (action === 'copy-link') {
                await navigator.clipboard.writeText(new URL(routeForType(item.type) + '?owned=' + encodeURIComponent(item.id), location.href).href);
                showDriveToast('Link copied');
            } else if (action === 'download') {
                var response = await updateSuiteRecord(item, function () {});
                var payload = response && (response.record || (response.list || []).find(function (entry) { return String(entry.id) === String(item.id); }));
                var blob = new Blob([JSON.stringify(payload || item, null, 2)], { type: 'application/json' });
                var link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = item.name.replace(/[\\/:*?"<>|]/g, '_') + '.json'; link.click();
                setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
            } else if (action === 'duplicate') {
                if (isFolder) { folders.push(Object.assign({}, item, { id: 'folder-' + Date.now().toString(36), name: item.name + ' copy', trashed: false })); await saveFolders(); await loadDriveData(); render(); }
                else await duplicateFile(item);
            }
            else if (action === 'move-to' || action === 'copy-to') {
                var disallowedTargets = isFolder ? [item.id].concat(descendantFolderIds(item.id)) : [];
                var available = folders.filter(function (folder) { return !folder.trashed && disallowedTargets.indexOf(folder.id) === -1; });
                var choices = available.map(function (folder) { return folderPath(folder.id).map(function (part) { return part.name; }).join(' / '); });
                var chosen = window.prompt('Enter a destination folder name:\n' + choices.join('\n'), item.folder ? folderPath(item.folder).map(function (part) { return part.name; }).join(' / ') : 'My Drive');
                if (chosen !== null) {
                    var target = available.find(function (folder) { return choices[available.indexOf(folder)].toLowerCase() === chosen.trim().toLowerCase(); });
                    var targetId = target ? target.id : null;
                    if (action === 'copy-to' && !isFolder) await duplicateFile(item, targetId);
                    else if (action === 'copy-to' && isFolder) { folders.push(Object.assign({}, item, { id: 'folder-' + Date.now().toString(36), name: item.name + ' copy', parent: targetId, trashed: false })); await saveFolders(); await loadDriveData(); render(); }
                    else if (isFolder) { item.parent = targetId; await saveFolders(); await loadDriveData(); render(); }
                    else { metaFor(item).folder = targetId; await saveMetadata(); await loadDriveData(); render(); }
                }
            } else if (action === 'manage-access') {
                showDriveToast('Sharing settings are not available for this file yet.');
            }
        } catch (error) { console.error('[Drive] Action failed:', action, error); showDriveToast('Could not ' + action.replace(/-/g, ' ') + '.'); }
    }

    function contextRow(label, action, danger) {
        return '<a href="#" role="menuitem" data-context-action="' + action + '"' + (danger ? ' class="ctx-danger"' : '') + '>' +
            esc(label) + '</a>';
    }

    function positionContextMenu(menu, x, y) {
        menu.style.display = 'block';
        menu.style.left = '-9999px';
        menu.style.top = '-9999px';
        var width = menu.offsetWidth || 260;
        var height = menu.offsetHeight || 360;
        x = Math.min(x, document.documentElement.clientWidth - width - 8);
        y = Math.min(y, document.documentElement.clientHeight - height - 8);
        menu.style.left = Math.max(8, x) + 'px';
        menu.style.top = Math.max(8, y) + 'px';
    }

    function openItemContextMenu(event, target) {
        var menu = $('custom-context-menu');
        if (!menu) return;
        var folderId = target.getAttribute('data-folder');
        var fileId = target.getAttribute('data-file');
        var isFolder = folderId !== null;
        var item = isFolder
            ? folders.find(function (f) { return String(f.id) === folderId; })
            : files.find(function (f) { return String(f.id) === fileId; });
        if (!item) return;

        event.preventDefault();
        var appNames = { doc: 'EmeraldDocs', note: 'EmeraldNotes', slide: 'EmeraldSlides', sheet: 'EmeraldSheets' };
        var previewType = item.type === 'image' || item.type === 'pdf';
        var primaryLabel = isFolder ? 'Open folder' : (appNames[item.type] ? 'Open in ' + appNames[item.type] : (previewType ? 'Preview' : 'Open'));
        var itemIcon = isFolder
            ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
            : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>';
        var itemKind = isFolder ? 'Folder' : esc((TYPE_META[item.type] || TYPE_META.other).label);
        var html = '<div class="context-title">' + itemIcon + '<span>' + esc(item.name) + '</span></div>' +
            '<div class="context-text">' + itemKind + (item.shared ? ' · Shared' : '') + '</div>' +
            '<div class="context-section">';
        if (!item.trashed) html += contextRow(primaryLabel, 'open');
        if (item.trashed) {
            html += contextRow('Restore', 'restore') + contextRow('Delete permanently', 'purge', true);
        } else {
            if (!isFolder) html += contextRow('Download', 'download') + contextRow('Copy link', 'copy-link');
            html += contextRow('Rename', 'rename') + contextRow('Duplicate', 'duplicate') +
                contextRow('Move to', 'move-to') + contextRow('Copy to', 'copy-to');
        }
        if (isFolder && !item.trashed) {
            html += '</div><div class="context-section drive-folder-color-section"><span class="drive-context-label">Folder color</span><div class="drive-folder-colors" role="group" aria-label="Folder color">' +
                ['#f3b900', '#ef6c63', '#a879d8', '#4c9be8', '#39a66b', '#6d7c8f'].map(function (color, index) {
                    return '<button type="button" data-context-action="folder-color" data-color="' + color + '" aria-label="Folder color ' + (index + 1) + '" style="--swatch:' + color + '"></button>';
                }).join('') + '</div></div>';
        } else if (!isFolder && !item.trashed) html += contextRow(item.starred ? 'Unstar' : 'Star', 'star') + '</div>';
        else html += '</div>';
        if (!item.trashed) html += '<div class="context-section">' + contextRow('Move to trash', 'delete', true) + '</div>';
        menu.innerHTML = html;
        menu.dataset.contextItemId = isFolder ? folderId : fileId;
        menu.dataset.contextIsFolder = isFolder ? '1' : '0';
        positionContextMenu(menu, event.clientX, event.clientY);
    }

    function bindContextMenu() {
        var menu = $('custom-context-menu');
        if (!menu) return;
        var defaultMenuHTML = menu.innerHTML;
        window.addEventListener('contextmenu', function (event) {
            var target = event.target.closest('.dfile-card, .dfolder-card, .drow[data-file], .drow[data-folder], .dchip');
            if (target) openItemContextMenu(event, target);
            else {
                menu.innerHTML = defaultMenuHTML;
                positionContextMenu(menu, event.clientX, event.clientY);
            }
        });
        menu.addEventListener('click', function (event) {
            var action = event.target.closest('[data-context-action]');
            if (!action) return;
            event.preventDefault();
            menu.style.display = 'none';
            runContextAction(action.dataset.contextAction, menu.dataset.contextItemId, menu.dataset.contextIsFolder === '1', action.dataset.color);
        });
        document.addEventListener('click', function (event) {
            if (!menu.contains(event.target)) menu.style.display = 'none';
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') menu.style.display = 'none';
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
        var navRect = nav.getBoundingClientRect();
        var activeRect = active.getBoundingClientRect();
        var h = activeRect.height;
        var bar = h ? Math.max(14, Math.round(h * 0.62)) : 14;
        pill.style.top = (activeRect.top - navRect.top + (h - bar) / 2).toFixed(2) + 'px';
        pill.style.height = bar + 'px';
        pill.classList.add('visible');
    }

    var SWITCH_MS = 180;
    var switchAnimating = false;
    var switchPending = null;

    function switchPage(fn) {
        var box = $('driveContent');
        if (!box) { fn(); return; }
        switchPending = fn;
        if (switchAnimating) return;
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
                switchAnimating = false;
            }
        }, SWITCH_MS);
    }

    function applyLayout() {
        document.querySelectorAll('#viewToggle button').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-layout') === state.layout);
        });
        bindListColumnResize();
    }

    function bindListColumnResize() {
        document.querySelectorAll('.dlist').forEach(function (list) {
            var kind = list.getAttribute('data-list-kind');
            var headers = Array.prototype.slice.call(list.querySelectorAll('.drow-head-cell'));
            var key = 'emerald.drive.columns.' + kind;
            var saved;
            try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { saved = null; }
            if (Array.isArray(saved) && saved.length === headers.length) {
                list.style.setProperty('--drive-list-columns', saved.map(function (width) { return Math.max(80, Number(width) || 0) + 'px'; }).join(' '));
            }
            headers.forEach(function (header, index) {
                var grip = header.querySelector('.dcol-resize');
                if (!grip) return;
                grip.addEventListener('pointerdown', function (event) {
                    event.preventDefault();
                    event.stopPropagation();
                    var widths = headers.map(function (cell) { return cell.getBoundingClientRect().width; });
                    var startX = event.clientX;
                    var startWidths = widths.slice();
                    grip.classList.add('is-resizing');
                    if (grip.setPointerCapture) grip.setPointerCapture(event.pointerId);
                    function resize(moveEvent) {
                        var delta = moveEvent.clientX - startX;
                        var minCurrent = index === 0 ? 180 : 90;
                        var minNext = index + 1 === 0 ? 180 : 90;
                        var applied = Math.max(minCurrent - startWidths[index], Math.min(startWidths[index + 1] - minNext, delta));
                        widths[index] = startWidths[index] + applied;
                        widths[index + 1] = startWidths[index + 1] - applied;
                        list.style.setProperty('--drive-list-columns', widths.map(function (width) { return Math.round(width) + 'px'; }).join(' '));
                    }
                    function finish() {
                        grip.classList.remove('is-resizing');
                        document.removeEventListener('pointermove', resize);
                        document.removeEventListener('pointerup', finish);
                        try { localStorage.setItem(key, JSON.stringify(widths.map(Math.round))); } catch (_) {}
                    }
                    document.addEventListener('pointermove', resize);
                    document.addEventListener('pointerup', finish, { once: true });
                });
            });
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
                if (!sortMenu.hidden) {
                    sortMenu.style.left = '8px';
                    sortMenu.style.top = '8px';
                    var buttonRect = sortBtn.getBoundingClientRect();
                    var menuRect = sortMenu.getBoundingClientRect();
                    var left = Math.min(buttonRect.right - menuRect.width, window.innerWidth - menuRect.width - 8);
                    if (left < 8) left = Math.max(8, Math.min(buttonRect.left, window.innerWidth - menuRect.width - 8));
                    var top = buttonRect.bottom + 6;
                    if (top + menuRect.height > window.innerHeight - 8) {
                        top = buttonRect.top - menuRect.height - 6;
                        if (top < 8) top = Math.max(8, window.innerHeight - menuRect.height - 8);
                    }
                    sortMenu.style.left = Math.round(left) + 'px';
                    sortMenu.style.top = Math.round(top) + 'px';
                }
            });
            document.addEventListener('click', function (e) {
                if (!sortMenu.hidden && !sortMenu.contains(e.target)) { sortMenu.hidden = true; sortBtn.setAttribute('aria-expanded', 'false'); }
            });
            sortMenu.querySelectorAll('[data-sort]').forEach(function (b) {
                b.addEventListener('click', function () {
                    state.sort = b.getAttribute('data-sort');
                    sortMenu.querySelectorAll('[data-sort]').forEach(function (x) {
                        x.classList.toggle('active', x === b);
                        x.setAttribute('aria-selected', String(x === b));
                    });
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
            var clearBtn = document.querySelector('.wiki-search-clear');
            if (clearBtn) {
                clearBtn.addEventListener('click', function () {
                    search.value = '';
                    state.search = '';
                    render();
                    search.focus();
                });
            }
        }
    }

    function bindCreateUploadMenu() {
        var wrap = $('createUploadWrap');
        var button = $('createUploadBtn');
        var menu = $('createUploadMenu');
        if (!wrap || !button || !menu) return;

        var menuAnimation = null;

        function setOpen(open) {
            var activePill = $('sidebarActivePill');
            if (activePill) activePill.classList.add('is-tracking');
            var startHeight = menu.getBoundingClientRect().height;
            if (menuAnimation) {
                menuAnimation.cancel();
                menuAnimation = null;
            }
            menu.style.height = startHeight + 'px';
            if (open) {
                menu.inert = false;
                menu.setAttribute('aria-hidden', 'false');
                wrap.classList.remove('closing');
                wrap.classList.add('open');
            } else {
                wrap.classList.remove('open');
                wrap.classList.add('closing');
                menu.setAttribute('aria-hidden', 'true');
                menu.inert = true;
            }
            button.setAttribute('aria-expanded', String(open));
            updateNavPill();

            if (menu.animate) {
                var endHeight = open ? menu.scrollHeight : 0;
                var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                menuAnimation = menu.animate(
                    [{ height: startHeight + 'px' }, { height: endHeight + 'px' }],
                    { duration: reduceMotion ? 1 : 460, easing: 'cubic-bezier(.22,1,.36,1)' }
                );
                menuAnimation.onfinish = function () {
                    menuAnimation = null;
                    if (wrap.classList.contains('open')) menu.style.height = 'auto';
                    else {
                        menu.style.height = '0px';
                        wrap.classList.remove('closing');
                    }
                    updateNavPill();
                    if (activePill) activePill.classList.remove('is-tracking');
                };
            } else {
                menu.style.height = open ? 'auto' : '0px';
                if (!open) wrap.classList.remove('closing');
                if (activePill) activePill.classList.remove('is-tracking');
            }
        }

        button.addEventListener('click', function (event) {
            event.stopPropagation();
            var opening = !wrap.classList.contains('open');
            if (opening && state.view !== 'mydrive') {
                state.view = 'mydrive';
                state.folderId = null;
                setActiveNav('mydrive');
                switchPage(render);
            }
            setOpen(opening);
        });
        menu.addEventListener('click', function (event) {
            var action = event.target.closest('[data-create-action]');
            if (!action) return;
            setOpen(false);
            if (action.getAttribute('data-create-action') === 'folder') {
                newFolder();
            }
        });
        document.addEventListener('click', function (event) {
            if (!wrap.contains(event.target) && wrap.classList.contains('open')) setOpen(false);
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && wrap.classList.contains('open')) {
                setOpen(false);
                button.focus();
            }
        });
        if (window.ResizeObserver) {
            var menuResizeObserver = new window.ResizeObserver(updateNavPill);
            menuResizeObserver.observe(wrap);
            menuResizeObserver.observe(wrap.parentElement);
        } else {
            menu.addEventListener('transitionrun', updateNavPill);
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
            currentUserName = name;
            updateHomeGreeting();
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
        var name = window.prompt('Folder name', 'New folder');
        if (name === null || !name.trim()) return;
        var n = 1;
        var base = name.trim();
        while (folders.some(function (f) { return f.parent === state.folderId && f.name === (n === 1 ? base : base + ' ' + n); })) n++;
        folders.push({ id: 'folder-' + Date.now().toString(36), name: n === 1 ? base : base + ' ' + n, parent: state.view === 'mydrive' ? state.folderId : null, color: '#f3b900' });
        saveFolders();
        state.view = 'mydrive';
        setActiveNav('mydrive');
        render();
        closeMobileSidebar();
    }

    window.openMobileSidebar = openMobileSidebar;
    window.closeMobileSidebar = closeMobileSidebar;
    window.newFolder = newFolder;

    /* ---------------- init ---------------- */

    async function init() {
        bindContextMenu();
        if (window.EmeraldAuth && window.EmeraldAuth.ready) await window.EmeraldAuth.ready();
        initTheme();
        bindProfile();
        renderAccountProfile();
        bindToolbar();
        bindCreateUploadMenu();
        bindSidebarNav();
        var syncStatus = $('driveSyncStatus');
        if (syncStatus) syncStatus.addEventListener('click', function () {
            if (window.EmeraldAuth && typeof window.EmeraldAuth.syncCurrentData === 'function') {
                updateDriveSyncStatus({ state: 'syncing', online: navigator.onLine !== false });
                window.EmeraldAuth.syncCurrentData().catch(function (error) {
                    updateDriveSyncStatus({ state: 'error', error: error.message || 'Could not sync' });
                });
            }
        });
        window.addEventListener('emerald-sync-state', function (event) { updateDriveSyncStatus(event.detail || {}); });
        if (window.EmeraldAuth && window.EmeraldAuth.getSyncState) updateDriveSyncStatus(window.EmeraldAuth.getSyncState());
        await loadDriveData();
        render();
        var s = storage();
        if (s && s.subscribe) s.subscribe(function (change) {
            if (change && (change.key === DRIVE_META_KEY || change.key === DRIVE_FOLDERS_KEY ||
                change.key === 'emeraldcore.storage.suite.notes' || change.key === 'emeraldcore.storage.suite.docs' ||
                change.key === 'emeraldcore.storage.suite.slides' || change.key === 'emeraldcore.storage.suite.sheets.sync.v1')) {
                loadDriveData().then(render).catch(function (error) { console.warn('[Drive] Refresh failed:', error); });
            }
        });
        window.addEventListener('focus', function () { loadDriveData().then(render).catch(function () {}); });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) loadDriveData().then(render).catch(function () {});
        });
        window.setInterval(function () { loadDriveData().then(render).catch(function () {}); }, 60000);
        window.setInterval(updateHomeGreeting, 60000);
        window.addEventListener('resize', updateNavPill);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateNavPill);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
