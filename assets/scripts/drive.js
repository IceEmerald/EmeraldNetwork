/* EmeraldNetwork Drive — account-scoped SQL-backed Drive */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    function storage() { return window.EmeraldIDBStorage || null; }

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
    var sharedFiles = [];

    var state = { view: 'home', folderId: null, layout: 'grid', sort: 'modified', search: '' };
    var currentUserName = '';
    var currentEmail = '';
    var currentSession = null;
    var serverRevision = 0;
    var saveChain = Promise.resolve();
    var driveStatus = 'loading';
    var driveChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('emerald.drive.sql') : null;
    var DRIVE_LIMIT = 10 * 1024 * 1024 * 1024;
    var SQL_BLOB_LIMIT = 1024 * 1024;

    function makeDefaultDriveState() {
        return {
            version: 1,
            folders: [
                { id: 'suite-root', name: 'EmeraldSuite', parent: null, color: '', createdAt: Date.now(), updatedAt: Date.now(), trashed: false },
                { id: 'suite-notes', name: 'Notes', parent: 'suite-root', color: '', createdAt: Date.now(), updatedAt: Date.now(), trashed: false },
                { id: 'suite-docs', name: 'Docs', parent: 'suite-root', color: '', createdAt: Date.now(), updatedAt: Date.now(), trashed: false },
                { id: 'suite-sheets', name: 'Sheets', parent: 'suite-root', color: '', createdAt: Date.now(), updatedAt: Date.now(), trashed: false },
                { id: 'suite-slides', name: 'Slides', parent: 'suite-root', color: '', createdAt: Date.now(), updatedAt: Date.now(), trashed: false }
            ],
            files: [],
            settings: { layout: 'grid', sort: 'modified', updatedAt: Date.now() },
            tombstones: { folders: {}, files: {} },
            updatedAt: Date.now()
        };
    }

    var localDbPromise = null;

    function openLocalDriveDb() {
        if (localDbPromise) return localDbPromise;
        localDbPromise = new Promise(function (resolve, reject) {
            var request = indexedDB.open('emerald.drive.local', 1);
            request.onupgradeneeded = function () {
                if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records', { keyPath: 'key' });
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('Could not open local Drive storage.')); };
        });
        return localDbPromise;
    }

    function localRecordKey(key) { return currentEmail + ':' + key; }

    async function localGet(key) {
        var db = await openLocalDriveDb();
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('records', 'readonly');
            var request = tx.objectStore('records').get(localRecordKey(key));
            request.onsuccess = function () { resolve(request.result ? request.result.value : null); };
            request.onerror = function () { reject(request.error); };
        });
    }

    async function localSet(key, value) {
        var db = await openLocalDriveDb();
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('records', 'readwrite');
            tx.objectStore('records').put({ key: localRecordKey(key), value: value, updatedAt: Date.now() });
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error); };
        });
    }

    async function localDelete(key) {
        var db = await openLocalDriveDb();
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('records', 'readwrite');
            tx.objectStore('records').delete(localRecordKey(key));
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
    }

    function authApiBase() {
        if (window.EMERALD_AUTH_API_BASE) return String(window.EMERALD_AUTH_API_BASE).replace(/\/+$/, '');
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return 'http://localhost:8787';
        return 'https://emeraldnetwork-auth.iceemerald.workers.dev';
    }

    async function driveRequest(path, options) {
        if (!currentSession || !currentSession.token) throw new Error('Sign in to use Drive.');
        var requestOptions = Object.assign({}, options || {});
        requestOptions.headers = Object.assign({}, requestOptions.headers || {}, {
            Authorization: 'Bearer ' + currentSession.token
        });
        var response = await fetch(authApiBase() + '/api/drive' + path, requestOptions);
        if (!response.ok) {
            var body = {};
            try { body = await response.json(); } catch (_) {}
            var error = new Error(body.error || 'Drive request failed (' + response.status + ').');
            error.status = response.status;
            error.code = body.code || '';
            error.state = body.state || null;
            error.revision = Number(body.revision) || 0;
            throw error;
        }
        return response;
    }

    function validDriveState(value) {
        return value && typeof value === 'object' && Array.isArray(value.folders) && Array.isArray(value.files);
    }

    function mergeDriveState(local, remote) {
        local = validDriveState(local) ? local : makeDefaultDriveState();
        remote = validDriveState(remote) ? remote : makeDefaultDriveState();
        var merged = makeDefaultDriveState();
        var tombstones = { folders: {}, files: {} };
        ['folders', 'files'].forEach(function (kind) {
            [remote.tombstones && remote.tombstones[kind] || {}, local.tombstones && local.tombstones[kind] || {}].forEach(function (source) {
                Object.keys(source).forEach(function (id) {
                    tombstones[kind][id] = Math.max(Number(tombstones[kind][id]) || 0, Number(source[id]) || 0);
                });
            });
            var byId = new Map();
            (remote[kind] || []).concat(local[kind] || []).forEach(function (item) {
                if (!item || !item.id) return;
                var previous = byId.get(String(item.id));
                if (!previous || (Number(item.updatedAt) || 0) >= (Number(previous.updatedAt) || 0)) byId.set(String(item.id), item);
            });
            merged[kind] = Array.from(byId.values()).filter(function (item) {
                return (Number(tombstones[kind][item.id]) || 0) < (Number(item.updatedAt) || 0);
            });
        });
        merged.settings = (Number(local.settings && local.settings.updatedAt) || 0) >= (Number(remote.settings && remote.settings.updatedAt) || 0)
            ? Object.assign({}, remote.settings, local.settings)
            : Object.assign({}, local.settings, remote.settings);
        merged.tombstones = tombstones;
        merged.updatedAt = Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0, Date.now());
        return merged;
    }

    async function loadDriveState() {
        var cached = null;
        try { cached = await localGet('state'); } catch (_) {}
        try {
            var response = await driveRequest('/state', { method: 'GET', headers: { 'Cache-Control': 'no-store' } });
            var remote = await response.json();
            serverRevision = Number(remote.revision) || 0;
            state.layout = remote.state.settings && remote.state.settings.layout || 'grid';
            state.sort = remote.state.settings && remote.state.settings.sort || 'modified';
            var merged = mergeDriveState(cached && cached.state, remote.state);
            folders = merged.folders;
            files = merged.files;
            state.settings = merged.settings;
            state.tombstones = merged.tombstones;
            driveStatus = 'online';
            if (cached && Number(cached.state && cached.state.updatedAt) > Number(remote.state && remote.state.updatedAt)) {
                await persistDriveState();
            } else {
                await localSet('state', { state: merged, revision: serverRevision });
                var hasSuiteRoot = merged.folders.some(function (folder) { return folder.id === 'suite-root'; });
                if (!remote.state.folders.length || !hasSuiteRoot) await persistDriveState();
            }
            await loadSharedItems();
            return;
        } catch (error) {
            if (error.status === 401) throw error;
            if (cached && validDriveState(cached.state)) {
                folders = cached.state.folders;
                files = cached.state.files;
                serverRevision = Number(cached.revision) || 0;
                state.layout = cached.state.settings && cached.state.settings.layout || 'grid';
                state.sort = cached.state.settings && cached.state.settings.sort || 'modified';
                state.settings = cached.state.settings || { layout: state.layout, sort: state.sort };
                state.tombstones = cached.state.tombstones || { folders: {}, files: {} };
                driveStatus = 'offline';
                return;
            }
            var fresh = makeDefaultDriveState();
            folders = fresh.folders;
            files = fresh.files;
            state.settings = fresh.settings;
            state.tombstones = fresh.tombstones;
            driveStatus = 'offline';
            if (window.showToast) window.showToast('Drive is offline. New changes will be saved on this device.');
        }
    }

    async function loadSharedItems() {
        sharedFiles = [];
        try {
            var response = await driveRequest('/shared', { method: 'GET' });
            var result = await response.json();
            for (var index = 0; index < (result.shares || []).length; index++) {
                var share = result.shares[index];
                var noteResponse = await driveRequest('/shared/' + encodeURIComponent(share.id), { method: 'GET' });
                var noteResult = await noteResponse.json();
                sharedFiles.push({
                    id: 'shared_' + share.id,
                    shareId: share.id,
                    ownerEmail: share.ownerEmail,
                    name: noteResult.note && noteResult.note.title || 'Shared note',
                    type: 'note',
                    folder: null,
                    size: new TextEncoder().encode(String(noteResult.note && noteResult.note.content || '')).byteLength,
                    mime: 'text/html',
                    updatedAt: Number(share.createdAt) || Date.now(),
                    starred: false,
                    trashed: false,
                    shared: true,
                    readOnly: true,
                    previewText: previewText(noteResult.note && noteResult.note.content),
                    previewContent: String(noteResult.note && noteResult.note.content || '')
                });
            }
        } catch (error) {
            if (error.status !== 401) console.warn('Shared notes are unavailable:', error.message);
        }
    }

    function persistDriveState() {
        state.layout = state.layout === 'list' ? 'list' : 'grid';
        state.sort = ['modified', 'name', 'size'].indexOf(state.sort) >= 0 ? state.sort : 'modified';
        var timestamp = Date.now();
        var next = {
            version: 1,
            folders: folders,
            files: files,
            settings: Object.assign({}, state.settings || {}, { layout: state.layout, sort: state.sort, updatedAt: timestamp }),
            tombstones: state.tombstones || { folders: {}, files: {} },
            updatedAt: timestamp
        };
        state.settings = next.settings;
        state.tombstones = next.tombstones;
        saveChain = saveChain.catch(function () {}).then(async function () {
            await localSet('state', { state: next, revision: serverRevision });
            try {
                var response = await driveRequest('/state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ state: next, revision: serverRevision })
                });
                var result = await response.json();
                serverRevision = Number(result.revision) || serverRevision + 1;
                driveStatus = 'online';
                await localSet('state', { state: next, revision: serverRevision });
                if (driveChannel) driveChannel.postMessage({ email: currentEmail, revision: serverRevision, updatedAt: timestamp });
            } catch (error) {
                if (error.status === 409 && validDriveState(error.state)) {
                    var merged = mergeDriveState(next, error.state);
                    folders = merged.folders;
                    files = merged.files;
                    state.settings = merged.settings;
                    state.tombstones = merged.tombstones;
                    state.updatedAt = merged.updatedAt;
                    serverRevision = error.revision;
                    var retryResponse = await driveRequest('/state', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ state: merged, revision: serverRevision })
                    });
                    var retry = await retryResponse.json();
                    serverRevision = Number(retry.revision) || serverRevision + 1;
                    driveStatus = 'online';
                    await localSet('state', { state: merged, revision: serverRevision });
                    return;
                }
                driveStatus = 'offline';
                if (navigator.onLine !== false && error.status !== 413 && window.showToast) {
                    window.showToast('Drive is offline. Changes are saved on this device and will sync when available.');
                }
                if (error.status === 413) throw error;
            }
        });
        return saveChain;
    }

    function totalBytes() {
        return files.reduce(function (sum, file) { return sum + (file.trashed ? 0 : Number(file.size) || 0); }, 0);
    }

    function updateStorageCounter() {
        var used = totalBytes();
        var fill = document.querySelector('.drive-storage-bar span');
        var label = document.querySelector('.drive-storage-label');
        if (fill) fill.style.width = Math.min(100, used / DRIVE_LIMIT * 100).toFixed(1) + '%';
        if (label) label.textContent = formatBytes(used) + ' of 10 GB used' + (driveStatus === 'offline' ? ' · Offline' : '');
    }

    function makeId(prefix) {
        var id = '';
        try { id = crypto.randomUUID().replace(/-/g, ''); } catch (_) { id = Date.now().toString(36) + Math.random().toString(36).slice(2); }
        return (prefix || 'd') + '_' + id;
    }

    function typeFromFile(file) {
        var mime = String(file && file.type || '').toLowerCase();
        var name = String(file && file.name || '').toLowerCase();
        if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
        if (mime.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/.test(name)) return 'image';
        if (/\.(doc|docx|odt|rtf)$/.test(name)) return 'doc';
        if (/\.(xls|xlsx|ods|csv)$/.test(name)) return 'sheet';
        if (/\.(ppt|pptx|odp)$/.test(name)) return 'slide';
        return 'other';
    }

    function previewText(value) {
        var text = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        return text.slice(0, 180);
    }

    function suiteFile(type, item, old) {
        var suiteId = String(item.id);
        var id = ('suite-' + type + '-' + suiteId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
        var dataString = JSON.stringify(item);
        return Object.assign({}, old || {}, {
            id: id,
            name: String(item.title || item.name || (type === 'note' ? 'Untitled Note' : 'Untitled ' + type)).slice(0, 180),
            type: type,
            folder: 'suite-' + (type === 'slide' ? 'slides' : type === 'sheet' ? 'sheets' : type === 'doc' ? 'docs' : 'notes'),
            size: new TextEncoder().encode(dataString).byteLength,
            mime: 'application/json',
            createdAt: Number(item.createdAt || item.created_at) || Number(old && old.createdAt) || Date.now(),
            updatedAt: Number(item.updatedAt || item.savedAt || item.modifiedAt) || Number(old && old.updatedAt) || 0,
            starred: !!(old && old.starred),
            trashed: !!(old && old.trashed),
            trashedAt: Number(old && old.trashedAt) || 0,
            suite: type,
            suiteId: suiteId.slice(0, 120),
            previewText: previewText(item.content || item.text || item.title || item.name || ''),
            localOnly: !!(item.localOnly || item.syncAvailable === false),
            shared: false
        });
    }

    async function refreshSuiteMirrors() {
        if (!currentEmail || !storage()) return;
        var found = [];
        var store = storage();
        try {
            var notes = await store.getJSON('emeraldcore.storage.suite.notes');
            if (Array.isArray(notes)) notes.forEach(function (note) { if (note && note.id && !note._isCollabNote) found.push(suiteFile('note', note, files.find(function (f) { return f.id === 'suite-note-' + note.id; }))); });
            var docs = await store.getJSON('emeraldcore.storage.suite.docs');
            if (Array.isArray(docs)) {
                for (var di = 0; di < docs.length; di++) {
                    var doc = await store.getJSON('emeraldcore.storage.suite.docs.' + docs[di].id);
                    found.push(suiteFile('doc', Object.assign({}, docs[di], doc || {}), files.find(function (f) { return f.id === 'suite-doc-' + docs[di].id; })));
                }
            }
            var slides = await store.getJSON('emeraldcore.storage.suite.slides');
            if (Array.isArray(slides)) {
                for (var si = 0; si < slides.length; si++) {
                    var slide = await store.getJSON('emeraldcore.storage.suite.slides.' + slides[si].id);
                    found.push(suiteFile('slide', Object.assign({}, slides[si], slide || {}), files.find(function (f) { return f.id === 'suite-slide-' + slides[si].id; })));
                }
            }
            if (window.EmeraldSheetsStorage && typeof window.EmeraldSheetsStorage.listDocs === 'function') {
                var sheets = await window.EmeraldSheetsStorage.listDocs();
                sheets.forEach(function (entry) {
                    var data = entry && entry.doc || {};
                    found.push(suiteFile('sheet', Object.assign({ id: entry.id }, data, { title: data.title || data.name || 'Untitled Spreadsheet' }), files.find(function (f) { return f.id === 'suite-sheet-' + entry.id; })));
                });
            }
        } catch (error) {
            console.warn('Could not read EmeraldSuite items for Drive:', error);
        }
        var previous = files.filter(function (file) { return file.suite; });
        found = found.filter(function (file) {
            return (Number(state.tombstones && state.tombstones.files && state.tombstones.files[file.id]) || 0) < (Number(file.updatedAt) || 0);
        });
        var foundIds = new Set(found.map(function (file) { return file.id; }));
        previous.forEach(function (file) {
            if (!foundIds.has(file.id) && !file.trashed) {
                file.trashed = true;
                file.trashedAt = Date.now();
                touched(file);
            }
        });
        var changed = false;
        found.forEach(function (file) {
            var index = files.findIndex(function (existing) { return existing.id === file.id; });
            if (index < 0) { files.push(file); changed = true; }
            else if (JSON.stringify(files[index]) !== JSON.stringify(file)) { files[index] = file; changed = true; }
        });
        if (changed) await persistDriveState();
    }

    /* ---------------- helpers ---------------- */

    function childrenOf(folderId) {
        return folders.filter(function (f) { return f.parent === folderId && !f.trashed; });
    }

    function filesIn(folderId) {
        return files.filter(function (f) { return f.folder === folderId && !f.trashed; });
    }

    function fileCreated(item) {
        var value = item.createdAt || item.created || item.created_at;
        return value ? relativeOrOriginalDate(value) : '—';
    }

    function fileDisplaySize(item) {
        return formatBytes(Number(item && item.size) || bytesFromSize(item && item.size));
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
            if (key === 'size') return (Number(b.size) || bytesFromSize(b.size)) - (Number(a.size) || bytesFromSize(a.size));
            return (Number(b.updatedAt || b.modifiedAt) || 0) - (Number(a.updatedAt || a.modifiedAt) || 0);
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
            if (state.folderId) {
                html += '<button class="dcrumb-back" type="button" data-drive-back aria-label="Back to parent folder" title="Back">‹</button><span class="dcrumb-sep" aria-hidden="true">›</span>';
            }
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
        var backButton = el.querySelector('[data-drive-back]');
        if (backButton) backButton.addEventListener('click', function () {
            var current = folders.find(function (folder) { return String(folder.id) === String(state.folderId); });
            state.folderId = current ? current.parent : null;
            render();
        });
    }

    function cardHTML(item, isFolder) {
        if (isFolder) {
            var gradientId = 'folderGradient-' + esc(item.id);
            var folderColor = /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#ffc52e';
            return '<button class="dfolder-card" data-folder="' + item.id + '">' +
                '<span class="dfolder-icon"><svg viewBox="0 0 160 110" aria-hidden="true">' +
                    '<defs><linearGradient id="' + gradientId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="' + esc(folderColor) + '"/></linearGradient></defs>' +
                    '<path d="M12 27a9 9 0 0 1 9-9h43c5 0 8 2 11 5l10 11h63a9 9 0 0 1 9 9v48a9 9 0 0 1-9 9H21a9 9 0 0 1-9-9z" fill="' + esc(folderColor) + '"/>' +
                    '<path d="M12 36h51c6 0 9-2 13-6l9-9h63a9 9 0 0 1 9 9v61a9 9 0 0 1-9 9H21a9 9 0 0 1-9-9z" fill="url(#' + gradientId + ')" stroke="' + esc(folderColor) + '" stroke-width="1.5"/>' +
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
            '<div class="dfile-meta">' + esc(m.label) + ' · ' + esc(fileDisplaySize(item)) + ' · ' + esc(relativeOrOriginalDate(item.updatedAt || item.createdAt)) + (item.localOnly ? ' · This device only' : '') + '</div></div></div>';
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
            '<span class="drow-meta">' + esc(m.label) + (item.localOnly ? ' · Device only' : '') + '</span>' +
            '<span class="drow-meta">' + esc(fileDisplaySize(item)) + '</span>' +
            '<span class="drow-meta">' + esc(fileCreated(item)) + '</span>' +
            '<span class="drow-meta">' + esc(item.updatedAt ? relativeOrOriginalDate(item.updatedAt) : '—') + '</span></div>';
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
        setActiveNav(state.view);
        var html = '';
        var q = state.search;

        if (state.view === 'home') {
            var recent = sortList(filterSearch(files.filter(function (f) { return !f.trashed; }))).slice(0, 4);
            if (q) {
                var all = sortList(filterSearch(files.filter(function (f) { return !f.trashed; })));
                html += all.length ? layoutHTML(all) : emptyHTML('No results', 'Nothing matches your search.', '/assets/images/nofilefound.webp');
            } else {
                html += homeHeroHTML();
                var suggested = recent.slice(0, 3);
                if (suggested.length) html += section('Suggested', layoutHTML(suggested));
                if (recent.length) html += section('Recent files', layoutHTML(recent));
                if (!recent.length) html += emptyHTML('Nothing here yet', 'Create a folder or upload a file to get started.', '/assets/images/nofilefound.webp');
            }
        } else if (state.view === 'mydrive') {
            var foldersHere = filterSearch(childrenOf(state.folderId));
            var filesHere = sortList(filterSearch(filesIn(state.folderId)));
            if (!foldersHere.length && !filesHere.length) {
                html += emptyHTML('Nothing here yet', q ? 'No matches in this folder.' : 'This folder is empty.', '/assets/images/nofilefound.webp');
            } else {
                if (foldersHere.length) html += section('Folders', folderLayoutHTML(foldersHere));
                if (filesHere.length) html += section('Files', layoutHTML(filesHere));
            }
        } else if (state.view === 'shared') {
            var shared = sortList(filterSearch(sharedFiles.filter(function (f) { return !f.trashed; })));
            html += shared.length ? layoutHTML(shared) : emptyHTML('Nothing shared yet', 'Files shared with you will show up here.', '/assets/images/nofilefound.webp');
        } else if (state.view === 'recent') {
            var rec = sortList(filterSearch(files.filter(function (f) { return !f.trashed; })));
            html += rec.length ? layoutHTML(rec) : emptyHTML('No recent files', 'Open a file and it will show up here.', '/assets/images/nofilefound.webp');
        } else if (state.view === 'starred') {
            var st = sortList(filterSearch(files.filter(function (f) { return f.starred && !f.trashed; })));
            html += st.length ? layoutHTML(st) : emptyHTML('No starred files', 'Star a file to pin it here.', '/assets/images/nofilefound.webp');
        } else if (state.view === 'trash') {
            html += '<div class="dtrash-banner"><span class="dtrash-banner-icon" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span><span>Items in trash are deleted forever after 30 days.</span></div>';
            var trashedFolders = filterSearch(folders.filter(function (folder) { return folder.trashed; }));
            var tr = sortList(filterSearch(files.filter(function (f) { return f.trashed; })));
            if (tr.length || trashedFolders.length) html += '<div class="dtrash-actions"><button type="button" data-drive-action="empty-trash">Empty Trash</button></div>';
            if (trashedFolders.length) html += section('Folders', folderLayoutHTML(trashedFolders));
            if (tr.length) html += section('Files', layoutHTML(tr));
            if (!tr.length && !trashedFolders.length) html += emptyHTML('Trash is empty', 'Deleted files appear here.', '/assets/images/nofilefound.webp');
        }

        box.innerHTML = html;
        updateHomeGreeting();
        if (state.view === 'home' && !state.search) buildHomeSky(homeDaypart());
        bindContent();
        renderCrumbs();
        applyLayout();
        updateStorageCounter();
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
        box.querySelectorAll('[data-file]').forEach(function (node) {
            node.addEventListener('click', function (event) {
                if (event.target.closest('button, a')) return;
                var item = files.find(function (file) { return String(file.id) === String(node.getAttribute('data-file')); });
                if (item) openFile(item);
            });
        });
        box.querySelectorAll('[data-drive-action="empty-trash"]').forEach(function (button) {
            button.addEventListener('click', emptyTrash);
        });
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
            : files.find(function (f) { return String(f.id) === fileId; }) || sharedFiles.find(function (f) { return String(f.id) === fileId; });
        if (!item) return;

        event.preventDefault();
        var appNames = { doc: 'Docs', note: 'Notes', slide: 'Slides', sheet: 'Sheets' };
        var previewType = item.type === 'image' || item.type === 'pdf';
        var primaryLabel = isFolder ? 'Open folder' : (appNames[item.type] ? 'Open in ' + appNames[item.type] : (previewType ? 'Preview' : 'Open'));
        var itemIcon = isFolder
            ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
            : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>';
        var inTrash = !!item.trashed;
        var readOnly = !!item.readOnly;
        var itemKind = isFolder ? 'Folder' : esc((TYPE_META[item.type] || TYPE_META.other).label);
        var html = '<div class="context-title">' + itemIcon + '<span>' + esc(item.name) + '</span></div>' +
            '<div class="context-text">' + itemKind + (item.shared ? ' · Shared' : '') + (item.localOnly ? ' · This device only' : '') + '</div>' +
            '<div class="context-section">' +
            contextRow(inTrash ? 'Restore' : primaryLabel, inTrash ? 'restore' : 'open');
        if (!inTrash && !readOnly) {
            html += contextRow('Download', 'download') + contextRow('Cut', 'cut') + contextRow('Copy link', 'copy-link') +
                contextRow('Manage access', 'manage-access') + contextRow('Duplicate', 'duplicate') +
                contextRow('Move to', 'move-to') + contextRow('Copy to', 'copy-to') + contextRow('Rename', 'rename');
        } else if (readOnly) {
            html += contextRow('Copy link', 'copy-link') + '</div>';
        }
        if (isFolder && !inTrash) {
            html += '</div><div class="context-section drive-folder-color-section"><span class="drive-context-label">Folder color</span><div class="drive-folder-colors" role="group" aria-label="Folder color">' +
                ['#f3b900', '#ef6c63', '#a879d8', '#4c9be8', '#39a66b', '#6d7c8f'].map(function (color, index) {
                    return '<button type="button" data-context-action="folder-color" data-color="' + color + '" aria-label="Folder color ' + (index + 1) + '" style="--swatch:' + color + '"></button>';
                }).join('') + '</div></div>';
        } else if (!isFolder && !inTrash && !readOnly) html += contextRow(item.starred ? 'Unstar' : 'Star', 'star') + '</div>';
        if (!readOnly && inTrash) html += '<div class="context-section">' + contextRow('Delete permanently', 'permanent-delete', true) + '</div>';
        else if (!readOnly) html += '<div class="context-section">' + contextRow('Move to Trash', 'delete', true) + '</div>';
        menu.innerHTML = html;
        menu.dataset.contextItemId = isFolder ? folderId : fileId;
        menu.dataset.contextIsFolder = isFolder ? '1' : '0';
        positionContextMenu(menu, event.clientX, event.clientY);
    }

    function bindContextMenu() {
        var menu = $('custom-context-menu');
        if (!menu) return;
        window.addEventListener('contextmenu', function (event) {
            var target = event.target.closest('.dfile-card, .dfolder-card, .drow[data-file], .drow[data-folder], .dchip');
            if (target) openItemContextMenu(event, target);
            else menu.style.display = 'none';
        });
        menu.addEventListener('click', async function (event) {
            var action = event.target.closest('[data-context-action]');
            if (!action) return;
            event.preventDefault();
            var itemId = menu.dataset.contextItemId;
            var isFolder = menu.dataset.contextIsFolder === '1';
            var item = isFolder
                ? folders.find(function (folder) { return String(folder.id) === String(itemId); })
                : files.find(function (file) { return String(file.id) === String(itemId); }) || sharedFiles.find(function (file) { return String(file.id) === String(itemId); });
            menu.style.display = 'none';
            if (!item) return;
            try { await performItemAction(action.dataset.contextAction, item, isFolder, action.dataset.color); }
            catch (error) { if (window.showToast) window.showToast(error.message || 'That action failed.'); }
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') menu.style.display = 'none';
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && cutItem) {
                if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
                event.preventDefault();
                pasteCutItem().catch(function (error) { if (window.showToast) window.showToast(error.message || 'Paste failed.'); });
            }
        });
    }

    function touched(item) {
        item.updatedAt = Date.now();
        return item;
    }

    function activeFolderOptions() {
        return folders.filter(function (folder) { return !folder.trashed; }).map(function (folder) {
            return { id: String(folder.id), label: folderPath(folder.id).map(function (part) { return part.name; }).join(' / ') };
        });
    }

    function askDestination(currentId) {
        var options = activeFolderOptions();
        var promptText = 'Destination folder path (leave blank for My Drive):\n' +
            options.map(function (option) { return option.label + '  [' + option.id + ']'; }).join('\n');
        var value = window.prompt(promptText, '');
        if (value === null) return null;
        var input = value.trim();
        if (!input) return null;
        var byId = options.find(function (option) { return option.id === input; });
        if (byId) return byId.id;
        var byName = options.find(function (option) { return option.label.toLowerCase() === input.toLowerCase(); });
        if (!byName) throw new Error('Folder not found. Use one of the listed paths or IDs.');
        if (currentId && byName.id === currentId) throw new Error('An item cannot be moved into itself.');
        return byName.id;
    }

    async function fetchFileBlob(item) {
        if (item.shared && item.shareId) {
            var sharedResponse = await driveRequest('/shared/' + encodeURIComponent(item.shareId), { method: 'GET' });
            var sharedResult = await sharedResponse.json();
            return new Blob([String(sharedResult.note && sharedResult.note.content || '')], { type: 'text/plain;charset=utf-8' });
        }
        if (item.suite && item.suiteId) {
            var suiteItem = await readSuiteItem(item);
            if (suiteItem) {
                var text = suiteItem.content || suiteItem.html || JSON.stringify(suiteItem, null, 2);
                return new Blob([String(text)], { type: item.mime || 'text/plain;charset=utf-8' });
            }
        }
        if (item.localOnly) {
            var local = await localGet('blob:' + item.id);
            if (!local) throw new Error('This file is only available on the device where it was uploaded.');
            return local instanceof Blob ? local : new Blob([local], { type: item.mime || 'application/octet-stream' });
        }
        var response = await driveRequest('/blob/' + encodeURIComponent(item.id), { method: 'GET' });
        return response.blob();
    }

    async function readSuiteItem(item) {
        var store = storage();
        if (!store || !item.suiteId) return null;
        try {
            if (item.suite === 'note') {
                var notes = await store.getJSON('emeraldcore.storage.suite.notes');
                return Array.isArray(notes) ? notes.find(function (note) { return String(note.id) === String(item.suiteId); }) : null;
            }
            if (item.suite === 'doc') return await store.getJSON('emeraldcore.storage.suite.docs.' + item.suiteId);
            if (item.suite === 'slide') return await store.getJSON('emeraldcore.storage.suite.slides.' + item.suiteId);
            if (item.suite === 'sheet' && window.EmeraldSheetsStorage) return await window.EmeraldSheetsStorage.getDoc(item.suiteId);
        } catch (_) {}
        return null;
    }

    function suiteUrl(item) {
        var paths = { note: '/notes.html', doc: '/docs.html', sheet: '/sheets.html', slide: '/slides.html' };
        return (paths[item.suite] || '/drive.html') + '?owned=' + encodeURIComponent(item.suiteId);
    }

    async function openFile(item) {
        if (item.trashed) return;
        if (item.suite && item.suiteId) {
            if (item.localOnly && !(await readSuiteItem(item))) {
                if (window.showToast) window.showToast('This workbook is only available on the device where it was created.');
                return;
            }
            window.location.href = suiteUrl(item);
            return;
        }
        if (item.shared && item.shareId) {
            window.location.href = '/notes.html?driveShare=' + encodeURIComponent(item.shareId);
            return;
        }
        var popup = window.open('about:blank', '_blank');
        if (!popup) {
            if (window.showToast) window.showToast('Allow pop-ups to preview this file.');
            return;
        }
        try {
            var blob = await fetchFileBlob(item);
            if (/^(text\/html|application\/xhtml\+xml|application\/javascript|image\/svg\+xml)/i.test(blob.type || item.mime || '')) {
                blob = new Blob([await blob.text()], { type: 'text/plain;charset=utf-8' });
            }
            var url = URL.createObjectURL(blob);
            popup.location.href = url;
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
            touched(item);
            await persistDriveState();
        } catch (error) {
            try { popup.close(); } catch (_) {}
            if (window.showToast) window.showToast(error.message || 'Could not open this file.');
        }
    }

    function showTextPreview(title, content) {
        var dialog = document.getElementById('drivePreviewDialog');
        if (!dialog) {
            dialog = document.createElement('dialog');
            dialog.id = 'drivePreviewDialog';
            dialog.innerHTML = '<form method="dialog" class="drive-preview-dialog"><header><strong></strong><button aria-label="Close">×</button></header><pre></pre></form>';
            document.body.appendChild(dialog);
            dialog.addEventListener('click', function (event) {
                if (event.target === dialog) dialog.close();
            });
        }
        var heading = dialog.querySelector('strong');
        var body = dialog.querySelector('pre');
        heading.textContent = title || 'Preview';
        var text = String(content || '');
        try { text = new DOMParser().parseFromString(text, 'text/html').body.textContent || ''; } catch (_) {}
        body.textContent = text;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    async function openSharedNote(shareId) {
        window.location.href = '/notes.html?driveShare=' + encodeURIComponent(shareId);
    }

    async function downloadFile(item) {
        var blob = await fetchFileBlob(item);
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = item.name || 'download';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    async function duplicateItem(item, isFolder, destinationFolder) {
        if (isFolder) {
            var sourceFolderIds = [String(item.id)];
            folders.forEach(function (folder) {
                if (!folder.trashed && folderPath(folder.id).some(function (part) { return String(part.id) === String(item.id); })) sourceFolderIds.push(String(folder.id));
            });
            var idMap = {};
            sourceFolderIds.forEach(function (id) { idMap[id] = makeId('folder'); });
            var newFolders = folders.filter(function (folder) { return sourceFolderIds.indexOf(String(folder.id)) >= 0; }).map(function (folder) {
                return Object.assign({}, folder, {
                    id: idMap[String(folder.id)],
                    name: String(folder.id) === String(item.id) ? 'Copy of ' + item.name : folder.name,
                    parent: String(folder.id) === String(item.id) ? (destinationFolder === undefined ? item.parent : destinationFolder) : idMap[String(folder.parent)],
                    createdAt: Date.now(), updatedAt: Date.now(), trashed: false, trashedAt: 0
                });
            });
            var sourceFiles = files.filter(function (file) { return sourceFolderIds.indexOf(String(file.folder)) >= 0 && !file.trashed; });
            var copiedFiles = sourceFiles.map(function (file) {
                var copy = Object.assign({}, file, { id: makeId('file'), folder: idMap[String(file.folder)], name: 'Copy of ' + file.name, createdAt: Date.now(), updatedAt: Date.now(), starred: false, suite: '', suiteId: '', localOnly: false });
                return copy;
            });
            folders = folders.concat(newFolders);
            files = files.concat(copiedFiles);
            for (var copyIndex = 0; copyIndex < copiedFiles.length; copyIndex++) {
                var copyFile = copiedFiles[copyIndex];
                var sourceFile = sourceFiles[copyIndex];
                if (!sourceFile) { copyFile.localOnly = true; continue; }
                try {
                    var sourceBlob = await fetchFileBlob(sourceFile);
                    if (sourceBlob.size <= SQL_BLOB_LIMIT && !sourceFile.localOnly) {
                        await driveRequest('/blob/' + encodeURIComponent(copyFile.id), { method: 'POST', headers: { 'Content-Type': sourceFile.mime || 'application/octet-stream' }, body: sourceBlob });
                    } else {
                        copyFile.localOnly = true;
                        await localSet('blob:' + copyFile.id, sourceBlob);
                    }
                } catch (_) { copyFile.localOnly = true; }
            }
        } else {
            var copy = Object.assign({}, item, { id: makeId('file'), name: 'Copy of ' + item.name, folder: destinationFolder === undefined ? item.folder : destinationFolder, createdAt: Date.now(), updatedAt: Date.now(), starred: false, trashed: false, trashedAt: 0, shared: false, suite: '', suiteId: '' });
            if (item.localOnly) {
                var localBlob = await localGet('blob:' + item.id);
                if (localBlob) await localSet('blob:' + copy.id, localBlob);
            } else if (!item.suite) {
                var remoteBlob = await fetchFileBlob(item);
                if (remoteBlob.size <= SQL_BLOB_LIMIT) {
                    await driveRequest('/blob/' + encodeURIComponent(copy.id), { method: 'POST', headers: { 'Content-Type': item.mime || 'application/octet-stream' }, body: remoteBlob });
                } else {
                    copy.localOnly = true;
                    await localSet('blob:' + copy.id, remoteBlob);
                }
            } else {
                copy.suite = '';
                copy.suiteId = '';
                copy.localOnly = true;
                var suiteBlob = await fetchFileBlob(item);
                await localSet('blob:' + copy.id, suiteBlob);
            }
            files.push(copy);
        }
        await persistDriveState();
        render();
    }

    async function deleteItem(item, isFolder, permanent) {
        var targets = isFolder
            ? folders.filter(function (folder) { return folder.id === item.id || folderPath(folder.id).some(function (part) { return part.id === item.id; }); })
            : [];
        if (isFolder) {
            var ids = targets.map(function (folder) { return String(folder.id); });
            var contained = files.filter(function (file) { return ids.indexOf(String(file.folder)) >= 0; });
            for (var fileIndex = 0; fileIndex < contained.length; fileIndex++) {
                var file = contained[fileIndex];
                if (permanent) await permanentlyRemoveFile(file);
                else { file.trashed = true; file.trashedAt = Date.now(); touched(file); }
            }
            targets.forEach(function (folder) {
                if (permanent) {
                    state.tombstones.folders[folder.id] = Date.now();
                    folders = folders.filter(function (candidate) { return candidate.id !== folder.id; });
                } else { folder.trashed = true; folder.trashedAt = Date.now(); touched(folder); }
            });
        } else if (permanent) {
            await permanentlyRemoveFile(item);
        } else {
            item.trashed = true;
            item.trashedAt = Date.now();
            touched(item);
        }
        await persistDriveState();
        render();
    }

    async function permanentlyRemoveFile(item) {
        try {
            if (item.localOnly) await localDelete('blob:' + item.id);
            else if (!item.suite) await driveRequest('/blob/' + encodeURIComponent(item.id), { method: 'DELETE' });
        } catch (_) {}
        state.tombstones.files[item.id] = Date.now();
        files = files.filter(function (file) { return String(file.id) !== String(item.id); });
    }

    async function restoreItem(item, isFolder) {
        if (isFolder) {
            folders.filter(function (folder) { return folder.id === item.id || folderPath(folder.id).some(function (part) { return part.id === item.id; }); })
                .forEach(function (folder) { folder.trashed = false; folder.trashedAt = 0; touched(folder); });
            var ids = folders.map(function (folder) { return folder.id; });
            files.forEach(function (file) { if (ids.indexOf(file.folder) >= 0) { file.trashed = false; file.trashedAt = 0; touched(file); } });
        } else { item.trashed = false; item.trashedAt = 0; touched(item); }
        await persistDriveState();
        render();
    }

    async function emptyTrash() {
        var toRemove = files.filter(function (file) { return file.trashed; });
        for (var index = 0; index < toRemove.length; index++) await permanentlyRemoveFile(toRemove[index]);
        folders.filter(function (folder) { return folder.trashed; }).forEach(function (folder) {
            state.tombstones.folders[folder.id] = Date.now();
            folders = folders.filter(function (candidate) { return candidate.id !== folder.id; });
        });
        await persistDriveState();
        render();
    }

    async function shareNote(item) {
        if (item.type !== 'note' || !item.suiteId) throw new Error('Only a synced EmeraldSuite Note can be shared.');
        var listResponse = await driveRequest('/shares', { method: 'GET' });
        var listResult = await listResponse.json();
        var existing = (listResult.shares || []).filter(function (share) { return String(share.fileId) === String(item.suiteId); });
        var instruction = existing.length
            ? 'Existing shares:\n' + existing.map(function (share) { return share.recipientEmail + ' — revoke id: ' + share.id; }).join('\n') + '\n\nEnter revoke:<id> to revoke, or enter an email to add access.'
            : 'Share this note with the EmeraldNetwork account email:';
        var recipientEmail = window.prompt(instruction);
        if (!recipientEmail) return;
        var revokeMatch = /^revoke:([a-zA-Z0-9_-]+)$/.exec(recipientEmail.trim());
        if (revokeMatch) {
            await driveRequest('/shares/' + encodeURIComponent(revokeMatch[1]), { method: 'POST' });
            if (window.showToast) window.showToast('Note access revoked.');
            return;
        }
        var response = await driveRequest('/shares', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: item.id, recipientEmail: recipientEmail })
        });
        var result = await response.json();
        var link = window.location.origin + '/notes.html?driveShare=' + encodeURIComponent(result.share.id);
        try { await navigator.clipboard.writeText(link); } catch (_) {}
        if (window.showToast) window.showToast('Read-only note link copied for ' + recipientEmail + '.');
    }

    var cutItem = null;

    async function pasteCutItem() {
        if (!cutItem) return;
        var destination = state.view === 'mydrive' ? state.folderId : null;
        var item = cutItem.isFolder
            ? folders.find(function (folder) { return String(folder.id) === String(cutItem.id); })
            : files.find(function (file) { return String(file.id) === String(cutItem.id); });
        if (!item) { cutItem = null; return; }
        if (!cutItem.isFolder && item.suite) throw new Error('Suite items stay inside EmeraldSuite folders.');
        if (cutItem.isFolder && (destination === item.id || folderPath(destination).some(function (folder) { return folder.id === item.id; }))) {
            throw new Error('A folder cannot be moved into itself or a child folder.');
        }
        if (cutItem.isFolder) item.parent = destination;
        else item.folder = destination;
        touched(item);
        cutItem = null;
        await persistDriveState();
        render();
        if (window.showToast) window.showToast('Item moved.');
    }

    async function performItemAction(action, item, isFolder, color) {
        if (action === 'open') return isFolder ? (state.view = 'mydrive', state.folderId = item.id, render()) : openFile(item);
        if (action === 'download') return downloadFile(item);
        if (action === 'star') { item.starred = !item.starred; touched(item); await persistDriveState(); return render(); }
        if (action === 'folder-color') { item.color = color || ''; touched(item); await persistDriveState(); return render(); }
        if (action === 'rename') {
            var name = window.prompt('New name:', item.name);
            if (!name || !name.trim()) return;
            item.name = name.trim().slice(0, 180); touched(item); await persistDriveState(); return render();
        }
        if (action === 'copy-link') {
            var link = item.shared
                ? window.location.origin + '/notes.html?driveShare=' + encodeURIComponent(item.shareId)
                : window.location.origin + '/drive.html?file=' + encodeURIComponent(item.id);
            await navigator.clipboard.writeText(link);
            if (window.showToast) window.showToast('Link copied. The recipient still needs access to this account.');
            return;
        }
        if (action === 'manage-access') return shareNote(item);
        if (action === 'duplicate') return duplicateItem(item, isFolder);
        if (action === 'cut') { cutItem = { id: item.id, isFolder: isFolder }; if (window.showToast) window.showToast('Cut. Open a destination folder and press Ctrl+V.'); return; }
        if (action === 'move-to' || action === 'copy-to') {
            var destination = askDestination(isFolder ? item.id : item.folder);
            if (destination === null && window.confirm && !window.confirm('Move/copy to My Drive root?')) return;
            if (isFolder && (destination === item.id || folderPath(destination).some(function (part) { return part.id === item.id; }))) throw new Error('A folder cannot be moved or copied into itself or its descendants.');
            if (action === 'move-to') {
                if (!isFolder && item.suite) throw new Error('Suite items stay in their EmeraldSuite folder; copy the item to My Drive instead.');
                if (isFolder) item.parent = destination;
                else item.folder = destination;
            } else return duplicateItem(item, isFolder, destination);
            touched(item); await persistDriveState(); return render();
        }
        if (action === 'delete') return deleteItem(item, isFolder, false);
        if (action === 'restore') return restoreItem(item, isFolder);
        if (action === 'permanent-delete') return deleteItem(item, isFolder, true);
        throw new Error('This action is not supported.');
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
        var sortLabel = $('sortLabel');
        if (sortLabel) sortLabel.textContent = String(state.sort || 'modified').charAt(0).toUpperCase() + String(state.sort || 'modified').slice(1);
        document.querySelectorAll('#sortMenu [data-sort]').forEach(function (button) {
            var active = button.getAttribute('data-sort') === state.sort;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
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
                persistDriveState();
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
                    persistDriveState();
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
                newFolder().catch(function (error) { if (window.showToast) window.showToast(error.message || 'Could not create folder.'); });
            } else if (action.getAttribute('data-create-action') === 'file') {
                var fileInput = $('driveFileInput');
                if (fileInput) fileInput.click();
            } else if (action.getAttribute('data-create-action') === 'directory') {
                var folderInput = $('driveFolderInput');
                if (folderInput) folderInput.click();
            }
        });
        ['driveFileInput', 'driveFolderInput'].forEach(function (inputId) {
            var input = $(inputId);
            if (!input) return;
            input.addEventListener('change', function () {
                var selected = Array.from(input.files || []);
                input.value = '';
                handleUploadFiles(selected).catch(function (error) {
                    if (window.showToast) window.showToast(error.message || 'Upload failed.');
                });
            });
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

    function bindDriveSync() {
        var store = storage();
        if (store && typeof store.subscribe === 'function') {
            store.subscribe(function (change) {
                var key = String(change && change.key || '');
                if (/^emeraldcore\.storage\.suite\.(notes|docs|slides|sheets)(\.|$)/.test(key)) {
                    refreshSuiteMirrors().then(render).catch(function (error) { console.warn('Drive suite sync failed:', error); });
                }
            });
        }
        window.addEventListener('emerald-suite-storage-changed', function (event) {
            if (event.detail && event.detail.app === 'sheets') {
                refreshSuiteMirrors().then(render).catch(function (error) { console.warn('Drive Sheets sync failed:', error); });
            }
        });
        if (driveChannel) {
            driveChannel.onmessage = function (event) {
                var message = event.data || {};
                if (!currentEmail || message.email !== currentEmail || Number(message.revision) <= serverRevision) return;
                loadDriveState().then(function () { return refreshSuiteMirrors(); }).then(render).catch(function (error) { console.warn('Could not refresh Drive from another tab:', error); });
            };
        }
        window.addEventListener('online', function () {
            if (!currentSession) return;
            loadDriveState().then(function () { return refreshSuiteMirrors(); }).then(render).catch(function (error) {
                driveStatus = 'offline';
                updateStorageCounter();
                console.warn('Drive reconnect sync failed:', error);
            });
        });
        window.addEventListener('emerald-auth-changed', async function () {
            var session = window.EmeraldAuth && window.EmeraldAuth.getSession ? await window.EmeraldAuth.getSession() : null;
            var nextEmail = session && session.user && String(session.user.email || '').toLowerCase() || '';
            if (nextEmail !== currentEmail) {
                folders = [];
                files = [];
                sharedFiles = [];
                window.location.href = nextEmail ? '/drive.html' : '/account';
            }
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

    function createFolderRecord(name, parent) {
        var value = String(name || '').replace(/[\\/:*?"<>|\0]+/g, '_').trim().slice(0, 180) || 'Untitled folder';
        var duplicate = folders.some(function (folder) { return !folder.trashed && folder.parent === parent && folder.name.toLowerCase() === value.toLowerCase(); });
        if (duplicate) value += ' ' + Date.now().toString(36).slice(-4);
        var folder = { id: makeId('folder'), name: value, parent: parent == null ? null : String(parent), color: '', createdAt: Date.now(), updatedAt: Date.now(), trashed: false, trashedAt: 0 };
        folders.push(folder);
        return folder;
    }

    function ensureFolderPath(parts, startFolderId) {
        var parent = startFolderId == null ? null : String(startFolderId);
        parts.forEach(function (part) {
            var name = String(part || '').trim();
            if (!name || name === '.' || name === '..') return;
            var match = folders.find(function (folder) {
                return !folder.trashed && String(folder.parent) === String(parent) && folder.name.toLowerCase() === name.toLowerCase();
            });
            if (!match) match = createFolderRecord(name, parent);
            parent = String(match.id);
        });
        return parent;
    }

    async function handleUploadFiles(fileList) {
        var selected = Array.from(fileList || []).filter(function (file) { return file && file.name; });
        if (!selected.length) return;
        var incoming = selected.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
        if (totalBytes() + incoming > DRIVE_LIMIT) {
            if (window.showToast) window.showToast('This upload would exceed the 10 GB Drive limit.');
            return;
        }
        var localOnlyCount = 0;
        var added = 0;
        for (var index = 0; index < selected.length; index++) {
            var file = selected[index];
            var relative = String(file.webkitRelativePath || file.name).split('/').filter(Boolean);
            var name = relative.pop() || file.name;
            var parent = ensureFolderPath(relative, state.view === 'mydrive' ? state.folderId : null);
            var id = makeId('file');
            var mime = file.type || 'application/octet-stream';
            var record = {
                id: id,
                name: name.slice(0, 180),
                type: typeFromFile(file),
                folder: parent,
                size: Number(file.size) || 0,
                mime: mime,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                starred: false,
                trashed: false,
                trashedAt: 0,
                localOnly: false,
                suite: '',
                suiteId: '',
                previewText: ''
            };
            if (file.size > SQL_BLOB_LIMIT) {
                record.localOnly = true;
                await localSet('blob:' + id, file);
                localOnlyCount++;
            } else {
                try {
                    await driveRequest('/blob/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': mime }, body: file });
                } catch (_) {
                    record.localOnly = true;
                    await localSet('blob:' + id, file);
                    localOnlyCount++;
                }
            }
            files.push(record);
            added++;
        }
        await persistDriveState();
        state.view = 'mydrive';
        render();
        if (window.showToast) {
            var message = added + ' file' + (added === 1 ? '' : 's') + ' added';
            if (localOnlyCount) message += '; ' + localOnlyCount + ' saved on this device only (SQL file limit is 1 MiB each).';
            window.showToast(message);
        }
    }

    async function newFolder() {
        var n = 1;
        var base = 'New folder';
        var parent = state.view === 'mydrive' ? state.folderId : null;
        while (folders.some(function (f) { return !f.trashed && f.parent === parent && f.name === (n === 1 ? base : base + ' ' + n); })) n++;
        var name = window.prompt('Name this folder:', n === 1 ? base : base + ' ' + n);
        if (!name || !name.trim()) return;
        createFolderRecord(name, parent);
        await persistDriveState();
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
        currentSession = window.EmeraldAuth && window.EmeraldAuth.getSession ? await window.EmeraldAuth.getSession() : null;
        currentEmail = String(currentSession && currentSession.user && currentSession.user.email || '').trim().toLowerCase();
        if (!currentEmail || !currentSession.token) {
            window.location.href = '/account?next=' + encodeURIComponent('/drive.html');
            return;
        }
        try {
            await loadDriveState();
            await refreshSuiteMirrors();
        } catch (error) {
            if (error.status === 401 || error.code === 'DEVICE_SIGNED_OUT' || error.code === 'ACCOUNT_DATA_RESET') {
                window.location.href = '/account?next=' + encodeURIComponent('/drive.html');
                return;
            }
            driveStatus = 'offline';
            console.error('Drive could not load account data:', error);
            if (window.showToast) window.showToast(error.message || 'Could not load Drive data.');
        }
        initTheme();
        bindProfile();
        renderAccountProfile();
        bindToolbar();
        bindCreateUploadMenu();
        bindSidebarNav();
        bindDriveSync();
        render();
        var params = new URLSearchParams(window.location.search);
        var requestedFile = params.get('file');
        var requestedShare = params.get('shared');
        if (requestedShare) {
            openSharedNote(requestedShare);
            history.replaceState({}, document.title, window.location.pathname);
        } else if (requestedFile) {
            var requested = files.find(function (file) { return String(file.id) === requestedFile; });
            if (requested) openFile(requested);
        }
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
