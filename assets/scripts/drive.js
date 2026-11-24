/* EmeraldNetwork Drive — account-synced files and folders */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    var activeModalResolver = null;

    function stopDriveMediaPlayback() {
        var body = $('driveModalBody');
        if (!body) return;
        var fullscreenNode = document.fullscreenElement || document.webkitFullscreenElement;
        if (fullscreenNode && body.contains(fullscreenNode)) {
            try {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } catch (_) {}
        }
        body.querySelectorAll('audio, video').forEach(function (media) {
            try { media.pause(); } catch (_) {}
            try { media.currentTime = 0; } catch (_) {}
        });
    }

    function closeDriveModal(result) {
        var modal = $('driveModal');
        if (!modal || modal.hidden) return;
        stopDriveMediaPlayback();
        modal.hidden = true;
        if (activeModalResolver) { var resolve = activeModalResolver; activeModalResolver = null; resolve(result || { confirmed: false, value: null }); }
    }

    function showDriveModal(options) {
        options = options || {};
        var modal = $('driveModal');
        var dialog = modal ? modal.querySelector('.drive-modal') : null;
        var title = $('driveModalTitle');
        var body = $('driveModalBody');
        var actions = $('driveModalActions');
        if (!modal || !dialog || !title || !body || !actions) return Promise.resolve({ confirmed: false, value: null });
        if (activeModalResolver) closeDriveModal();
        modal.classList.remove('drive-modal--preview');
        dialog.classList.toggle('drive-modal--preview', !!options.preview);
        title.textContent = options.title || 'Drive';
        body.innerHTML = '';
        if (options.message) { var message = document.createElement('p'); message.textContent = options.message; body.appendChild(message); }
        if (options.bodyHtml) body.insertAdjacentHTML('beforeend', options.bodyHtml);
        var control = null;
        if (options.input) {
            control = document.createElement('input');
            control.type = options.input.type || 'text';
            control.value = options.input.value || '';
            control.placeholder = options.input.placeholder || '';
            control.setAttribute('aria-label', options.input.label || options.title || 'Value');
            body.appendChild(control);
        } else if (options.select) {
            control = document.createElement('select');
            control.setAttribute('aria-label', options.select.label || 'Choose a folder');
            options.select.options.forEach(function (option) {
                var node = document.createElement('option'); node.value = option.value; node.textContent = option.label; control.appendChild(node);
            });
            body.appendChild(control);
        }
        actions.innerHTML = '';
        actions.hidden = !!options.preview;
        if (!options.preview) {
            var cancel = document.createElement('button');
            cancel.type = 'button'; cancel.textContent = options.cancelLabel || 'Cancel';
            cancel.addEventListener('click', function () { closeDriveModal(); });
            actions.appendChild(cancel);
            if (options.primaryLabel) {
                var primary = document.createElement('button');
                primary.type = 'button'; primary.className = 'primary' + (options.danger ? ' danger' : ''); primary.textContent = options.primaryLabel;
                primary.addEventListener('click', async function () {
                    var value = control ? control.value : null;
                    try {
                        if (options.onConfirm) await options.onConfirm(value);
                        closeDriveModal({ confirmed: true, value: value });
                    } catch (error) {
                        if (window.showToast) window.showToast(error.message || 'Could not complete this action.');
                    }
                });
                actions.appendChild(primary);
            }
        }
        modal.hidden = false;
        if (control) setTimeout(function () { control.focus(); if (control.select) control.select(); }, 20);
        return new Promise(function (resolve) { activeModalResolver = resolve; });
    }

    function bindDriveModal() {
        var modal = $('driveModal');
        var close = $('driveModalClose');
        if (close) close.addEventListener('click', function () { closeDriveModal(); });
        if (modal) modal.addEventListener('click', function (event) { if (event.target === modal) closeDriveModal(); });
        document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeDriveModal(); });
    }

    function storage() { return window.EmeraldIDBStorage || null; }

    function byteLengthOf(value) {
        try { return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value || '')).byteLength; }
        catch (_) { return 0; }
    }

    function previewTextFromDataUrl(dataUrl) {
        try {
            var comma = String(dataUrl || '').indexOf(',');
            if (comma < 0) return '';
            var header = dataUrl.slice(0, comma);
            var body = dataUrl.slice(comma + 1);
            if (/;base64/i.test(header)) {
                var raw = atob(body);
                var bytes = new Uint8Array(raw.length);
                for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                return new TextDecoder('utf-8').decode(bytes).slice(0, 20000);
            }
            return decodeURIComponent(body).slice(0, 20000);
        } catch (_) { return ''; }
    }

    var TEXT_PREVIEW_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'log', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'sql', 'py', 'sh', 'bash', 'bat', 'ps1', 'ini', 'conf', 'cfg', 'env', 'gitignore', 'dockerfile', 'makefile', 'toml', 'properties', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'scala', 'lua', 'r', 'm', 'pl', 'emeraldcore', 'emeraldsuite'];
    var AUDIO_PREVIEW_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'wma', 'opus', 'mid', 'midi'];
    var VIDEO_PREVIEW_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'm4v', 'mpeg', 'mpg', '3gp'];

    function fileExtensionOf(name) {
        var parts = String(name || '').split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : '';
    }

    function isTextLikeFile(file) {
        var mime = String((file && file.mimeType) || '').toLowerCase();
        if (/^text\//.test(mime)) return true;
        if (/(json|xml|javascript|ecmascript|yaml|x-www-form-urlencoded|csv|markdown)/.test(mime)) return true;
        return TEXT_PREVIEW_EXTENSIONS.indexOf(fileExtensionOf(file && file.name)) !== -1;
    }

    function isAudioFile(file) {
        var mime = String((file && file.mimeType) || '').toLowerCase();
        if (/^audio\//.test(mime)) return true;
        return AUDIO_PREVIEW_EXTENSIONS.indexOf(fileExtensionOf(file && file.name)) !== -1;
    }

    function isVideoFile(file) {
        var mime = String((file && file.mimeType) || '').toLowerCase();
        if (/^video\//.test(mime)) return true;
        return VIDEO_PREVIEW_EXTENSIONS.indexOf(fileExtensionOf(file && file.name)) !== -1;
    }

    function isMostlyText(value) {
        if (!value) return false;
        var printable = 0;
        for (var i = 0; i < value.length; i++) {
            var code = value.charCodeAt(i);
            if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) printable++;
        }
        return printable / value.length > 0.85;
    }

    /* ---------------- synced Drive data ---------------- */

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

    var FOLDER_ICONS = {
        'emerald-suite-root-folder': '/assets/images/favicon.webp',
        'emerald-suite-doc-folder': '/assets/images/docsicon.webp',
        'emerald-suite-sheet-folder': '/assets/images/sheetsicon.webp',
        'emerald-suite-slide-folder': '/assets/images/slidesicon.webp',
        'emerald-suite-note-folder': '/assets/images/notesicon.webp'
    };

    var folders = [];
    var files = [];
    var TRASH_KEY = 'emerald.drive.trash';
    var FLAGS_KEY = 'emerald.drive.flags';
    var FOLDERS_KEY = 'emerald.drive.folders';
    var FILES_KEY = 'emerald.drive.files';
    var trashMap = {};
    var flagsMap = {};
    var loading = true;
    var syncStuckAt = null;
    var SYNC_STUCK_MS = 25000;

    var state = { view: 'home', folderId: null, layout: 'grid', sort: 'modified', search: '' };
    var currentUserName = '';
    var selectedDriveItem = null;
    var driveClipboard = null;
    var selectionState = { items: [], anchor: null };
    var marqueeDrag = null;

    async function loadDriveData() {
        var s = storage();
        if (s && s.ready) await s.ready();
        folders = s && s.getJSON ? await s.getJSON(FOLDERS_KEY) : [];
        files = s && s.getJSON ? await s.getJSON(FILES_KEY) : [];
        trashMap = s && s.getJSON ? await s.getJSON(TRASH_KEY) : {};
        flagsMap = s && s.getJSON ? await s.getJSON(FLAGS_KEY) : {};
        folders = Array.isArray(folders) ? folders : [];
        files = Array.isArray(files) ? files : [];
        trashMap = trashMap && typeof trashMap === 'object' ? trashMap : {};
        flagsMap = flagsMap && typeof flagsMap === 'object' ? flagsMap : {};
        folders.forEach(function (folder) { folder.trashed = !!(folder.trashed || trashMap[folder.id]); });
        files.forEach(function (file) {
            var fileFlags = flagsMap[file.driveKey || file.id] || {};
            file.trashed = !!(file.trashed || trashMap[file.driveKey || file.id]);
            file.lastOpenedAt = Math.max(Number(file.lastOpenedAt) || 0, Number(fileFlags.lastOpenedAt) || 0);
            if (!file.previewText && file.dataUrl && /\.(txt|md|markdown|json|csv|tsv|xml|yaml|yml|log|js|jsx|ts|tsx|css|html|htm|sql|py|sh)$/i.test(file.name || '')) file.previewText = previewTextFromDataUrl(file.dataUrl);
        });
        var suiteMaps = [
            ['emeraldcore.storage.suite.docs', 'doc', 'docs'],
            ['emeraldcore.storage.suite.notes', 'note', 'notes'],
            ['emeraldcore.storage.suite.slides', 'slide', 'slides']
        ];
        for (var i = 0; i < suiteMaps.length; i++) {
            var mapping = suiteMaps[i];
            var records = s && s.getJSON ? await s.getJSON(mapping[0]) : [];
            var appRecords = Array.isArray(records) ? records : [];
            for (var recordIndex = 0; recordIndex < appRecords.length; recordIndex++) {
                var record = appRecords[recordIndex];
                if (!record || !record.id) continue;
                var key = mapping[2] + ':' + record.id;
                var deleted = !!trashMap[key];
                var modifiedAt = record.updatedAt || record.modifiedAt || record.createdAt || Date.now();
                var payload = record;
                if (mapping[2] !== 'notes' && s && s.getJSON) payload = await s.getJSON('emeraldcore.storage.suite.' + mapping[2] + '.' + record.id) || record;
                var sizeBytes = byteLengthOf(payload);
                var flags = flagsMap[key] || {};
                files.push({ id: String(record.id), driveKey: key, name: record.title || 'Untitled ' + mapping[1], type: mapping[1], appType: mapping[2], folder: flags.folder || null,
                    size: formatBytes(sizeBytes), sizeBytes: sizeBytes, previewData: payload, previewText: suitePreviewText(mapping[2], payload), modifiedAt: modifiedAt, lastOpenedAt: flags.lastOpenedAt || 0, modified: relativeOrOriginalDate(modifiedAt), starred: !!flags.starred, shared: !!(flags.sharedWith && flags.sharedWith.length), sharedWith: flags.sharedWith || [], trashed: deleted, externalApp: true });
            }
        }
        try {
            var db = await new Promise(function (resolve, reject) {
                var req = indexedDB.open('emeraldcore.storage.suite.sheets', 1);
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { reject(req.error); };
            });
            var tx = db.transaction('workbooks', 'readonly');
            var keys = await new Promise(function (resolve, reject) { var req = tx.objectStore('workbooks').getAllKeys(); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; });
            var vals = await new Promise(function (resolve, reject) { var req = tx.objectStore('workbooks').getAll(); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; });
            keys.forEach(function (id, index) { var data = vals[index] && vals[index].data || {}; var key = 'sheets:' + id; var flags = flagsMap[key] || {}; var modifiedAt = vals[index] && vals[index].savedAt || Date.now(); var sizeBytes = byteLengthOf(data); files.push({ id: String(id), driveKey: key, name: data.title || 'Untitled spreadsheet', type: 'sheet', appType: 'sheets', folder: flags.folder || null, size: formatBytes(sizeBytes), sizeBytes: sizeBytes, previewData: data, previewText: suitePreviewText('sheets', data), modifiedAt: modifiedAt, lastOpenedAt: flags.lastOpenedAt || 0, modified: relativeOrOriginalDate(modifiedAt), starred: !!flags.starred, shared: !!(flags.sharedWith && flags.sharedWith.length), sharedWith: flags.sharedWith || [], trashed: !!trashMap[key], externalApp: true }); });
        } catch (_) {}
        if (ensureSuiteFolders()) await saveDriveData();
        loading = false;
    }

    function ensureSuiteFolders() {
        var changed = false;
        var folderPalette = ['#f3b900', '#ef6c63', '#a879d8', '#4c9be8', '#39a66b', '#6d7c8f'];
        var root = folders.find(function (folder) { return folder.id === 'emerald-suite-root-folder'; });
        if (!root) { root = { id: 'emerald-suite-root-folder', name: 'EmeraldSuite', parent: null }; folders.push(root); changed = true; }
        if (root.name !== 'EmeraldSuite' || root.parent != null) { root.name = 'EmeraldSuite'; root.parent = null; changed = true; }
        if (root.color !== '#6d7c8f') { root.color = '#6d7c8f'; changed = true; }
        var categories = [
            { type: 'doc', name: 'Docs', color: '#4c9be8' },
            { type: 'slide', name: 'Slides', color: '#ef6c63' },
            { type: 'sheet', name: 'Sheets', color: '#39a66b' },
            { type: 'note', name: 'Notes', color: '#a879d8' }
        ];
        categories.forEach(function (category) {
            var id = 'emerald-suite-' + category.type + '-folder';
            var folder = folders.find(function (candidate) { return candidate.id === id; });
            if (!folder) { folder = { id: id, name: category.name, parent: root.id }; folders.push(folder); changed = true; }
            if (folder.name !== category.name || folder.parent !== root.id) { folder.name = category.name; folder.parent = root.id; changed = true; }
            if (category.type === 'doc') { if (folder.color !== '#4c9be8') { folder.color = '#4c9be8'; changed = true; } }
            else if (folderPalette.indexOf(String(folder.color || '').toLowerCase()) === -1) { folder.color = category.color; changed = true; }
            files.forEach(function (file) {
                if (file.externalApp && file.type === category.type && !file.folder) {
                    file.folder = folder.id;
                    if (file.driveKey) { flagsMap[file.driveKey] = Object.assign({}, flagsMap[file.driveKey], { folder: folder.id }); }
                    changed = true;
                }
            });
        });
        return changed;
    }

    function saveDriveData() {
        var s = storage();
        if (!s || !s.setJSON) return Promise.resolve();
        files.forEach(function (file) {
            var key = file.driveKey || file.id;
            flagsMap[key] = Object.assign({}, flagsMap[key], { starred: !!file.starred, sharedWith: file.sharedWith || [], folder: file.folder || null, lastOpenedAt: file.lastOpenedAt || 0 });
        });
        return Promise.all([s.setJSON(FOLDERS_KEY, folders), s.setJSON(FILES_KEY, files.filter(function (f) { return !f.externalApp; })), s.setJSON(TRASH_KEY, trashMap), s.setJSON(FLAGS_KEY, flagsMap)]);
    }

    function saveDriveFlags() {
        var s = storage();
        return s && s.setJSON ? s.setJSON(FLAGS_KEY, flagsMap) : Promise.resolve();
    }

    function showSkeleton() {
        var box = $('driveContent');
        if (!box) return;
        box.setAttribute('aria-busy', 'true');
        box.innerHTML = '<div class="dsection ddrive-loading"><h2 class="dsection-title">Loading your Drive</h2><div class="dgrid">' + new Array(7).join('<div class="loading-placeholder loading-card ddrive-skeleton-card" aria-hidden="true"><span class="loading-thumb"></span><span class="loading-line wide"></span><span class="loading-line"></span><span class="loading-line short"></span></div>') + '</div></div>';
    }

    /* ---------------- helpers ---------------- */

    function childrenOf(folderId) {
        return folders.filter(function (f) { return f.parent === folderId && !f.trashed; });
    }

    function filesIn(folderId) {
        return files.filter(function (f) { return f.folder === folderId && !f.trashed; });
    }

    function formatFileDate(value) {
        if (!value) return '—';
        var date = new Date(value);
        if (isNaN(date.getTime())) return String(value);
        if (Date.now() - date.getTime() < 60000) return 'Just now';
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function fileCreated(item) {
        return formatFileDate(item.created || item.createdAt || item.created_at || item.modifiedAt);
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
            return recencyMs(a.lastOpenedAt || a.modifiedAt || a.modified) - recencyMs(b.lastOpenedAt || b.modifiedAt || b.modified);
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

    function shadeHex(hex, amount) {
        var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!match) return '#f3b900';
        var value = parseInt(match[1], 16);
        var channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(function (channel) {
            return Math.max(0, Math.min(255, Math.round(channel + (amount > 0 ? (255 - channel) : -channel) * Math.abs(amount))));
        });
        return '#' + channels.map(function (channel) { return channel.toString(16).padStart(2, '0'); }).join('');
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

    function plainTextFromHtml(value) {
        var holder = document.createElement('div');
        holder.innerHTML = String(value || '');
        return (holder.innerText || holder.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function suitePreviewText(type, payload) {
        if (!payload) return '';
        if (type === 'notes' || type === 'docs') return plainTextFromHtml(payload.content || '').slice(0, 260);
        if (type === 'slides') {
            var text = [];
            (payload.slides || []).slice(0, 3).forEach(function (slide) {
                (slide.elements || []).forEach(function (element) { if (element && (element.text || element.value)) text.push(String(element.text || element.value)); });
            });
            return text.join(' · ').slice(0, 260) || ((payload.slides || []).length + ' slides');
        }
        if (type === 'sheets') {
            var cells = [];
            (payload.sheets || []).slice(0, 2).forEach(function (sheet) {
                Object.keys(sheet.cells || {}).sort().forEach(function (key) {
                    var cell = sheet.cells[key];
                    if (cell && cell.v != null && String(cell.v).trim()) cells.push(String(cell.v));
                });
            });
            return cells.slice(0, 18).join('  ·  ') || ((payload.sheets || []).length + ' sheets');
        }
        return '';
    }

    function safeColor(value, fallback) { return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? value : fallback; }

    function sheetPreviewMarkup(item) {
        var sheets = item.previewData && item.previewData.sheets || [];
        var sheet = sheets[0];
        var cells = sheet && sheet.cells || {};
        var cols = ['A', 'B', 'C', 'D', 'E'];
        var head = '<div class="dpreview-sheet-head"><i class="dpreview-sheet-corner"></i>' +
            cols.map(function (label) { return '<i>' + label + '</i>'; }).join('') + '</div>';
        var body = '';
        for (var row = 0; row < 5; row++) {
            body += '<div class="dpreview-sheet-row"><i class="dpreview-sheet-rowno">' + (row + 1) + '</i>';
            for (var col = 0; col < 5; col++) {
                var cell = cells[row + ',' + col] || {};
                var text = cell.v == null ? '' : String(cell.v);
                var style = cell.s || {};
                var fill = safeColor(style.fillColor || style.background || style.bg, '');
                body += '<span' + (fill ? ' style="background:' + fill + '"' : '') + '>' + esc(text.slice(0, 16)) + '</span>';
            }
            body += '</div>';
        }
        return '<div class="dfile-preview-page dpreview-sheet">' +
            '<div class="dpreview-sheet-title"><span>' + esc(sheet && sheet.name || item.name) + '</span></div>' +
            head + '<div class="dpreview-sheet-body">' + body + '</div></div>';
    }

    function slideMarkup(slide, index) {
        var bg = slide && slide.background && slide.background.type === 'color' ? safeColor(slide.background.value, '#fff') : '#fff';
        var elements = (slide && slide.elements || []).slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
        var inner = elements.map(function (element) {
            var left = Math.max(0, Math.min(100, Number(element.x) / 960 * 100 || 0));
            var top = Math.max(0, Math.min(100, Number(element.y) / 540 * 100 || 0));
            var width = Math.max(1, Math.min(100, Number(element.w) / 960 * 100 || 1));
            var height = Math.max(1, Math.min(100, Number(element.h) / 540 * 100 || 1));
            var style = 'left:' + left + '%;top:' + top + '%;width:' + width + '%;height:' + height + '%;';
            if (element.type === 'image' && element.src) return '<img class="dslide-el dslide-image" style="' + style + '" src="' + esc(element.src) + '" alt="">';
            if (element.type === 'shape') return '<i class="dslide-el dslide-shape" style="' + style + 'background:' + safeColor(element.fill, '#e5e7eb') + ';border-color:' + safeColor(element.stroke, 'transparent') + '"></i>';
            var text = element.text || plainTextFromHtml(element.html || '') || '';
            var color = safeColor(element.color, '#26332b');
            var fontSize = Math.max(4, Math.min(14, Number(element.fontSize || 14) * .15));
            return '<span class="dslide-el dslide-text" style="' + style + 'color:' + color + ';font-size:' + fontSize + 'px;font-weight:' + (element.bold || element.fontWeight === 'bold' ? '700' : '500') + '">' + esc(text).slice(0, 180) + '</span>';
        }).join('');
        return '<div class="dslide-mini" style="background:' + bg + '" aria-label="Slide ' + (index + 1) + '">' + inner + '</div>';
    }

    function slideDeckPreviewMarkup(item, limit, stacked) {
        var slides = item.previewData && item.previewData.slides || [];
        if (!slides.length) {
            var blankSlide = slideMarkup({}, 0);
            if (stacked) return '<div class="dslide-stack"><div class="dslide-stack-page slide-stack-0">' + blankSlide + '</div></div>';
            return '<div class="drive-slides-preview">' + blankSlide + '</div>';
        }
        var selected = slides.slice(0, limit || 4);
        if (stacked) return '<div class="dslide-stack">' + selected.slice(0, 2).map(function (slide, index) { return '<div class="dslide-stack-page slide-stack-' + index + '">' + slideMarkup(slide, index) + '</div>'; }).join('') + '</div>';
        return '<div class="drive-slides-preview">' + selected.map(slideMarkup).join('') + '</div><div class="drive-slide-count">' + slides.length + ' slides</div>';
    }

    function wrappedPreviewLines(value, maxChars, maxLines) {
        var words = String(value || '').split(/\s+/);
        var lines = [];
        var line = '';
        words.forEach(function (word) {
            if (!word) return;
            if (line && (line + ' ' + word).length > maxChars) { lines.push(line); line = ''; }
            line += (line ? ' ' : '') + word;
        });
        if (line) lines.push(line);
        return lines.slice(0, maxLines);
    }

    function contentPageMarkup(item, kind, modal) {
        var lineHtml;
        if (modal) {
            var lines = wrappedPreviewLines(item.previewText || '', 50, kind === 'note' ? 14 : 18);
            lineHtml = lines.map(function (line) { return '<span>' + esc(line) + '</span>'; }).join('');
        } else {
            lineHtml = '<span>' + esc(String(item.previewText || '').slice(0, 420)) + '</span>';
        }
        if (kind === 'note') return '<div class="drive-content-page drive-content-page--note' + (modal ? ' is-large' : '') + '"><div class="drive-page-heading">' + esc(item.name) + '</div><div class="drive-notebook-writing">' + lineHtml + '</div></div>';
        return '<div class="drive-content-page drive-content-page--doc' + (modal ? ' is-large' : '') + '"><div class="drive-page-heading">' + esc(item.name) + '</div><div class="drive-doc-writing">' + lineHtml + '</div></div>';
    }

    function drivePdfLibrary() {
        if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
        if (window._drivePdfLibraryPromise) return window._drivePdfLibraryPromise;
        window._drivePdfLibraryPromise = new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            script.integrity = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
            script.crossOrigin = 'anonymous';
            script.onload = function () { resolve(window.pdfjsLib || null); };
            script.onerror = function () { reject(new Error('PDF preview library failed to load.')); };
            document.head.appendChild(script);
        });
        return window._drivePdfLibraryPromise;
    }

    var drivePdfDocuments = new Map();
    async function getDrivePdfDocument(file) {
        if (drivePdfDocuments.has(file.id)) return drivePdfDocuments.get(file.id);
        var promise = (async function () {
            var lib = await drivePdfLibrary();
            if (!lib) throw new Error('PDF preview library is unavailable.');
            if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            var encoded = file.dataUrl.slice(file.dataUrl.indexOf(',') + 1);
            var raw = atob(encoded);
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            return lib.getDocument({ data: bytes }).promise;
        }());
        drivePdfDocuments.set(file.id, promise);
        try { return await promise; }
        catch (error) { drivePdfDocuments.delete(file.id); throw error; }
    }

    async function renderPdfPreview(file, container) {
        if (!container || !file || !file.dataUrl) return;
        var canvas = container.querySelector('canvas');
        if (!canvas) return;
        try {
            var pdf = await getDrivePdfDocument(file);
            var page = await pdf.getPage(1);
            var bounds = container.getBoundingClientRect();
            var base = page.getViewport({ scale: 1 });
            var scale = Math.min((bounds.width || 220) / base.width, (bounds.height || 320) / base.height);
            scale = Math.max(.1, scale);
            var ratio = Math.min(2, window.devicePixelRatio || 1);
            var viewport = page.getViewport({ scale: scale * ratio });
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            canvas.style.width = Math.floor(viewport.width / ratio) + 'px';
            canvas.style.height = Math.floor(viewport.height / ratio) + 'px';
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
            container.classList.remove('is-loading');
        } catch (error) {
            container.classList.remove('is-loading');
            container.classList.add('has-preview-error');
            console.warn('[Drive] PDF preview failed:', error);
        }
    }

    async function renderPdfDocumentPreview(file, container) {
        if (!container || !file || !file.dataUrl) return;
        try {
            var pdf = await getDrivePdfDocument(file);
            var pageArea = container.clientWidth || 680;
            var ratio = Math.min(1.5, window.devicePixelRatio || 1);
            for (var pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
                var page = await pdf.getPage(pageNumber);
                var base = page.getViewport({ scale: 1 });
                var scale = Math.min(1, (pageArea - 28) / base.width);
                var viewport = page.getViewport({ scale: scale * ratio });
                var wrap = document.createElement('div');
                wrap.className = 'drive-pdf-page';
                var canvas = document.createElement('canvas');
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                canvas.style.width = Math.floor(viewport.width / ratio) + 'px';
                canvas.style.height = Math.floor(viewport.height / ratio) + 'px';
                wrap.appendChild(canvas);
                container.appendChild(wrap);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
            }
            container.classList.remove('is-loading');
        } catch (error) {
            container.classList.remove('is-loading');
            container.classList.add('has-preview-error');
            console.warn('[Drive] PDF document preview failed:', error);
        }
    }

    function renderPdfThumbnails(root) {
        if (!root) return;
        root.querySelectorAll('[data-pdf-preview]').forEach(function (container) {
            var file = files.find(function (entry) { return String(entry.id) === container.getAttribute('data-pdf-preview'); });
            if (file) renderPdfPreview(file, container);
        });
    }

    function filePreview(item) {
        var mime = String(item.mimeType || '').toLowerCase();
        if (item.dataUrl && (/^image\//.test(mime) || item.type === 'image')) {
            return '<div class="dfile-preview-image-wrap"><img class="dfile-preview-image" src="' + esc(item.dataUrl) + '" alt=""></div>';
        }
        if (item.dataUrl && (item.type === 'pdf' || mime === 'application/pdf')) {
            return '<div class="dfile-preview-pdf is-loading" data-pdf-preview="' + esc(item.id) + '" aria-label="PDF first page preview"><canvas></canvas><span class="pdf-preview-sheen"></span><span class="pdf-preview-error">PDF page preview</span></div>';
        }
        if (item.type === 'note') return '<div class="dfile-preview-page dpreview-note-live">' + contentPageMarkup(item, 'note', false) + '</div>';
        if (item.type === 'doc') return '<div class="dfile-preview-page dpreview-doc-live">' + contentPageMarkup(item, 'doc', false) + '</div>';
        if (item.type === 'sheet' && item.previewData) return sheetPreviewMarkup(item);
        if (item.type === 'slide' && item.previewData) return slideDeckPreviewMarkup(item, 1, true);
        if (isTextLikeFile(item) && item.previewText) {
            var textLines = String(item.previewText).slice(0, 260).split(/\s+/).reduce(function (out, word) {
                var last = out[out.length - 1] || '';
                if ((last + ' ' + word).length > 28) out.push(word); else out[out.length - 1] = last ? last + ' ' + word : word;
                return out;
            }, []);
            return '<div class="dfile-preview-page dpreview-content"><span class="dpreview-content-title">' + esc(item.name) + '</span><div>' + textLines.slice(0, 6).map(function (line) { return '<i>' + esc(line) + '</i>'; }).join('') + '</div></div>';
        }
        if (item.previewText) {
            var lines = String(item.previewText).slice(0, 260).split(/\s+/).reduce(function (out, word) {
                var last = out[out.length - 1] || '';
                if ((last + ' ' + word).length > 30) out.push(word); else out[out.length - 1] = last ? last + ' ' + word : word;
                return out;
            }, []);
            return '<div class="dfile-preview-page dpreview-content"><span class="dpreview-content-title">' + esc(item.name) + '</span><div>' + lines.slice(0, 6).map(function (line) { return '<i>' + esc(line) + '</i>'; }).join('') + '</div></div>';
        }
        if (isVideoFile(item) && item.dataUrl) {
            return '<div class="dfile-preview-video-wrap"><video class="dfile-preview-video" src="' + esc(item.dataUrl) + '" muted preload="metadata" playsinline></video></div>';
        }
        if (isAudioFile(item)) {
            return '<div class="dfile-preview-audio">' + fileIconSvg(item.type, item.name) + '</div>';
        }
        return '<div class="dfile-preview-page dpreview-generic">' + fileIconSvg(item.type, item.name) + '</div>';
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

    function folderIconHtml(item) {
        var src = FOLDER_ICONS[item.id];
        var gradientId = 'folderGradient-' + esc(item.id);
        var folderColor = /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#f3b900';
        var svg = '<svg viewBox="0 0 160 110" aria-hidden="true">' +
            '<defs><linearGradient id="' + gradientId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + shadeHex(folderColor, .34) + '"/><stop offset=".58" stop-color="' + folderColor + '"/><stop offset="1" stop-color="' + shadeHex(folderColor, -.12) + '"/></linearGradient></defs>' +
            '<path d="M12 27a9 9 0 0 1 9-9h43c5 0 8 2 11 5l10 11h63a9 9 0 0 1 9 9v48a9 9 0 0 1-9 9H21a9 9 0 0 1-9-9z" fill="' + shadeHex(folderColor, -.16) + '"/>' +
            '<path d="M12 36h51c6 0 9-2 13-6l9-9h63a9 9 0 0 1 9 9v61a9 9 0 0 1-9 9H21a9 9 0 0 1-9-9z" fill="url(#' + gradientId + ')" stroke="' + shadeHex(folderColor, -.2) + '" stroke-width="1.5"/>' +
            '<path d="M14 35h49c6 0 9-2 13-6l8-8" fill="none" stroke="rgba(255,255,255,.78)" stroke-width="2.5"/>' +
            '</svg>';
        if (src) {
            return svg + '<img class="dfolder-app-badge" src="' + src + '" alt="" aria-hidden="true">';
        }
        return svg;
    }

    function cardHTML(item, isFolder) {
        if (isFolder) {
            return '<button class="dfolder-card" data-folder="' + item.id + '"' + (isSuiteFolder(item) ? '' : ' draggable="true"') + '>' +
                '<span class="dfolder-icon">' + folderIconHtml(item) + '</span>' +
                '<span class="dfolder-name">' + esc(item.name) + '</span>' +
                '</button>';
        }
        var m = TYPE_META[item.type] || TYPE_META.other;
        return '<div class="dfile-card" data-file="' + item.id + '" draggable="true" role="button" tabindex="0" aria-label="Open ' + esc(item.name) + '">' +
            '<div class="dfile-thumb dfile-thumb--' + esc(item.type || 'other') + '">' + filePreview(item) + typeBadge(item.type, item.name) +
                (item.starred ? '<span class="dfile-star" title="Starred" aria-label="Starred"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.83 5.74 6.34.92-4.59 4.47 1.08 6.31L12 17.26l-5.66 2.98 1.08-6.31-4.59-4.47 6.34-.92L12 2.8z"/></svg></span>' : '') +
            '</div>' +
            '<div class="dfile-body"><div class="dfile-name">' + esc(item.name) + '</div>' +
            '<div class="dfile-meta">' + esc(m.label) + ' · ' + esc(item.size) + ' · ' + esc(item.modified) + '</div></div></div>';
    }

    function rowHTML(item, isFolder) {
        var m = isFolder ? null : (TYPE_META[item.type] || TYPE_META.other);
        if (isFolder) {
            var stats = folderStats(item.id);
            var folderIconSrc = FOLDER_ICONS[item.id];
            var iconHtml = folderIconSrc
                ? '<img class="drow-app-icon" src="' + folderIconSrc + '" alt="" aria-hidden="true">'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
            var iconStyle = folderIconSrc ? '' : ' style="color:' + esc(item.color || '#8a8886') + '"';
            return '<div class="drow" data-folder="' + item.id + '"' + (isSuiteFolder(item) ? '' : ' draggable="true"') + ' role="button" tabindex="0">' +
                '<span class="drow-name"><span class="drow-icon"' + iconStyle + '>' + iconHtml + '</span><span class="drow-label">' + esc(item.name) + '</span></span>' +
                '<span class="drow-meta">' + esc(stats.size) + '</span><span class="drow-meta">' + esc(stats.modified) + '</span></div>';
        }
        return '<div class="drow" data-file="' + item.id + '" draggable="true" role="button" tabindex="0">' +
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
        clearDriveSelection();
        setActiveNav(state.view);
        var html = '';
        var q = state.search;

        if (state.view === 'home') {
            var recent = sortList(filterSearch(files.filter(function (f) { return !f.trashed; }))).slice(0, 4);
            if (q) {
                var all = filterSearch(files.filter(function (f) { return !f.trashed; }));
                html += all.length ? layoutHTML(all) : emptyHTML('No results', 'Nothing matches your search.', '/assets/images/nofilefound.webp');
            } else {
                html += homeHeroHTML();
                var suggested = recent.slice(0, 3);
                if (suggested.length) html += section('Suggested', layoutHTML(suggested));
                if (recent.length) html += section('Recent files', layoutHTML(recent));
                if (!recent.length) html += emptyHTML('Nothing here yet', 'Your recent files will appear here.', '/assets/images/nofileyet.webp');
            }
        } else if (state.view === 'mydrive') {
            var foldersHere = filterSearch(childrenOf(state.folderId));
            var filesHere = sortList(filterSearch(filesIn(state.folderId)));
            if (!foldersHere.length && !filesHere.length) {
                html += emptyHTML('Nothing here yet', q ? 'No matches in this folder.' : 'This folder is empty.', q ? '/assets/images/nofilefound.webp' : '/assets/images/nofileyet.webp');
            } else {
                if (foldersHere.length) html += section('Folders', folderLayoutHTML(foldersHere));
                if (filesHere.length) html += section('Files', layoutHTML(filesHere));
            }
        } else if (state.view === 'shared') {
            var shared = sortList(filterSearch(files.filter(function (f) { return f.shared && !f.trashed; })));
            html += shared.length ? layoutHTML(shared) : emptyHTML(q ? 'No results' : 'Nothing shared yet', q ? 'Nothing matches your search.' : 'Files shared with you will show up here.', q ? '/assets/images/nofilefound.webp' : '/assets/images/nofileyet.webp');
        } else if (state.view === 'recent') {
            var rec = sortList(filterSearch(files.filter(function (f) { return !f.trashed; })));
            html += rec.length ? layoutHTML(rec) : emptyHTML(q ? 'No results' : 'No recent files', q ? 'Nothing matches your search.' : 'Open a file and it will show up here.', q ? '/assets/images/nofilefound.webp' : '/assets/images/nofileyet.webp');
        } else if (state.view === 'starred') {
            var st = sortList(filterSearch(files.filter(function (f) { return f.starred && !f.trashed; })));
            html += st.length ? layoutHTML(st) : emptyHTML(q ? 'No results' : 'No starred files', q ? 'Nothing matches your search.' : 'Star a file to pin it here.', q ? '/assets/images/nofilefound.webp' : '/assets/images/nofileyet.webp');
        } else if (state.view === 'trash') {
            html += '<div class="dtrash-banner"><span class="dtrash-banner-icon" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span><span>Items in trash are deleted forever after 30 days.</span></div>';
            var tr = sortList(filterSearch(files.filter(function (f) { return f.trashed; })).concat(folders.filter(function (f) { return f.trashed; })));
            html += tr.length ? gridHTML(tr) : emptyHTML(q ? 'No results' : 'Trash is empty', q ? 'Nothing matches your search.' : 'Deleted files appear here for 30 days.', q ? '/assets/images/nofilefound.webp' : '/assets/images/nofileyet.webp');
        }

        box.innerHTML = html;
        box.removeAttribute('aria-busy');
        renderPdfThumbnails(box);
        updateDriveStorage();
        updateHomeGreeting();
        if (state.view === 'home' && !state.search) buildHomeSky(homeDaypart());
        bindContent();
        renderCrumbs();
        applyLayout();
    }

    function bindContent() {
        var box = $('driveContent');
        box.querySelectorAll('[data-folder]').forEach(function (n) {
            n.addEventListener('click', function (event) {
                if (handleSelectionModifier(event, 'folder', n.getAttribute('data-folder'))) return;
                clearDriveSelection();
                selectedDriveItem = folders.find(function (f) { return String(f.id) === n.getAttribute('data-folder'); }) || null;
                state.view = 'mydrive';
                state.folderId = n.getAttribute('data-folder');
                setActiveNav('mydrive');
                switchPage(render);
            });
        });
        box.querySelectorAll('[data-file]').forEach(function (n) {
            n.addEventListener('click', function (event) {
                if (handleSelectionModifier(event, 'file', n.getAttribute('data-file'))) return;
                clearDriveSelection();
                var file = files.find(function (f) { return String(f.id) === n.getAttribute('data-file'); });
                if (file) { selectedDriveItem = file; openDriveFile(file); }
            });
            n.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); var file = files.find(function (f) { return String(f.id) === n.getAttribute('data-file'); }); if (file) openDriveFile(file); }
            });
        });
    }

    /* ---------------- multi-select ---------------- */

    function driveItemKey(kind, id) { return kind + ':' + String(id); }

    function findDriveItemBySelection(kind, id) {
        if (kind === 'folder') return folders.find(function (folder) { return String(folder.id) === String(id); }) || null;
        return files.find(function (file) { return String(file.id) === String(id); }) || null;
    }

    function syncSelectionClasses() {
        var box = $('driveContent');
        if (!box) return;
        var selected = {};
        selectionState.items.forEach(function (entry) { selected[entry.key] = true; });
        box.querySelectorAll('[data-file],[data-folder]').forEach(function (node) {
            var isFolder = node.hasAttribute('data-folder');
            var kind = isFolder ? 'folder' : 'file';
            var id = isFolder ? node.getAttribute('data-folder') : node.getAttribute('data-file');
            var isSelected = !!selected[driveItemKey(kind, id)];
            node.classList.toggle('is-selected', isSelected);
            if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') node.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        });
    }

    function clearDriveSelection() {
        if (!selectionState.items.length && !selectionState.anchor) return;
        selectionState.items = [];
        selectionState.anchor = null;
        syncSelectionClasses();
    }

    function addSelectionEntry(map, kind, id) {
        var key = driveItemKey(kind, id);
        if (!map[key]) map[key] = { key: key, kind: kind, id: String(id) };
    }

    function commitSelection(map) {
        selectionState.items = Object.keys(map).map(function (key) { return map[key]; });
        syncSelectionClasses();
    }

    function toggleDriveSelection(kind, id, additive) {
        var key = driveItemKey(kind, id);
        var map = {};
        if (additive) selectionState.items.forEach(function (entry) { map[entry.key] = entry; });
        if (map[key]) delete map[key];
        else addSelectionEntry(map, kind, id);
        selectionState.anchor = { kind: kind, id: String(id) };
        commitSelection(map);
    }

    function selectDriveRange(kind, id, additive) {
        var box = $('driveContent');
        var anchor = selectionState.anchor;
        if (!box || !anchor) { toggleDriveSelection(kind, id, additive); return; }
        var nodes = Array.prototype.slice.call(box.querySelectorAll('[data-file],[data-folder]'));
        var fromIndex = -1, toIndex = -1;
        nodes.forEach(function (node, index) {
            var nodeKind = node.hasAttribute('data-folder') ? 'folder' : 'file';
            var nodeId = nodeKind === 'folder' ? node.getAttribute('data-folder') : node.getAttribute('data-file');
            if (nodeKind === anchor.kind && String(nodeId) === String(anchor.id)) fromIndex = index;
            if (nodeKind === kind && String(nodeId) === String(id)) toIndex = index;
        });
        if (fromIndex === -1 || toIndex === -1) { toggleDriveSelection(kind, id, additive); return; }
        var map = {};
        if (additive) selectionState.items.forEach(function (entry) { map[entry.key] = entry; });
        var start = Math.min(fromIndex, toIndex), end = Math.max(fromIndex, toIndex);
        for (var i = start; i <= end; i++) {
            var node = nodes[i];
            var nodeKind = node.hasAttribute('data-folder') ? 'folder' : 'file';
            var nodeId = nodeKind === 'folder' ? node.getAttribute('data-folder') : node.getAttribute('data-file');
            addSelectionEntry(map, nodeKind, nodeId);
        }
        commitSelection(map);
    }

    function handleSelectionModifier(event, kind, id) {
        if (!(event.metaKey || event.ctrlKey || event.shiftKey)) return false;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) selectDriveRange(kind, id, event.metaKey || event.ctrlKey);
        else toggleDriveSelection(kind, id, event.metaKey || event.ctrlKey);
        return true;
    }

    function selectionEntriesInBox(box) {
        if (!box) return [];
        return Array.prototype.slice.call(box.querySelectorAll('[data-file],[data-folder]')).map(function (node) {
            var isFolder = node.hasAttribute('data-folder');
            return { node: node, kind: isFolder ? 'folder' : 'file', id: isFolder ? node.getAttribute('data-folder') : node.getAttribute('data-file') };
        });
    }

    function bindMarqueeSelection() {
        var box = $('driveContent');
        var host = document.querySelector('.drive-main') || box;
        if (!box || !host) return;

        function finishMarquee() {
            document.removeEventListener('pointermove', moveMarquee);
            document.removeEventListener('pointerup', finishMarquee);
            document.removeEventListener('pointercancel', finishMarquee);
            document.body.classList.remove('drive-selecting');
            if (!marqueeDrag) return;
            var drag = marqueeDrag;
            marqueeDrag = null;
            if (drag.rect && drag.rect.parentNode) drag.rect.remove();
            if (!drag.active) {
                if (!drag.additive) clearDriveSelection();
                return;
            }
            if (!selectionState.items.length && !drag.additive) clearDriveSelection();
            else if (selectionState.items.length) selectionState.anchor = { kind: selectionState.items[0].kind, id: selectionState.items[0].id };
        }

        function moveMarquee(event) {
            if (!marqueeDrag) return;
            var dx = event.clientX - marqueeDrag.startX;
            var dy = event.clientY - marqueeDrag.startY;
            if (!marqueeDrag.active) {
                if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
                marqueeDrag.active = true;
                document.body.classList.add('drive-selecting');
                var rectangle = document.createElement('div');
                rectangle.className = 'drive-select-box';
                document.body.appendChild(rectangle);
                marqueeDrag.rect = rectangle;
            }
            event.preventDefault();
            var left = Math.min(marqueeDrag.startX, event.clientX);
            var top = Math.min(marqueeDrag.startY, event.clientY);
            var right = Math.max(marqueeDrag.startX, event.clientX);
            var bottom = Math.max(marqueeDrag.startY, event.clientY);
            marqueeDrag.rect.style.left = left + 'px';
            marqueeDrag.rect.style.top = top + 'px';
            marqueeDrag.rect.style.width = (right - left) + 'px';
            marqueeDrag.rect.style.height = (bottom - top) + 'px';
            var map = {};
            if (marqueeDrag.additive) selectionState.items.forEach(function (entry) { map[entry.key] = entry; });
            selectionEntriesInBox($('driveContent')).forEach(function (entry) {
                var rect = entry.node.getBoundingClientRect();
                if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) addSelectionEntry(map, entry.kind, entry.id);
            });
            selectionState.items = Object.keys(map).map(function (key) { return map[key]; });
            syncSelectionClasses();
        }

        host.addEventListener('pointerdown', function (event) {
            if (event.button !== 0 || event.pointerType === 'touch') return;
            var target = event.target;
            if (!target || !target.closest) return;
            if (target.closest('[data-file],[data-folder],[data-crumb],button,a,img,input,select,textarea,.dcol-resize,.dchip,.drow-head')) return;
            var bounds = host.getBoundingClientRect();
            if (event.clientX > bounds.left + host.clientWidth || event.clientY > bounds.top + host.clientHeight) return;
            if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) document.activeElement.blur();
            if (marqueeDrag) finishMarquee();
            marqueeDrag = {
                startX: event.clientX,
                startY: event.clientY,
                additive: !!(event.metaKey || event.ctrlKey || event.shiftKey),
                active: false,
                rect: null
            };
            document.body.classList.add('drive-selecting');
            document.addEventListener('pointermove', moveMarquee);
            document.addEventListener('pointerup', finishMarquee);
            document.addEventListener('pointercancel', finishMarquee);
        });

        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            if (marqueeDrag) { finishMarquee(); clearDriveSelection(); }
            else if (selectionState.items.length) clearDriveSelection();
        });

        window.addEventListener('blur', function () { if (marqueeDrag) finishMarquee(); });
    }

    async function downloadDriveSelection() {
        var selected = selectionState.items.slice();
        if (!selected.length) return;
        if (selected.length === 1) {
            var onlyItem = findDriveItemBySelection(selected[0].kind, selected[0].id);
            if (!onlyItem) return;
            if (selected[0].kind === 'folder') await downloadFolder(onlyItem);
            else await downloadFile(onlyItem);
            return;
        }
        try {
            if (window.showToast) window.showToast('Preparing zip…');
            var entries = [];
            selected.forEach(function (entry) {
                var item = findDriveItemBySelection(entry.kind, entry.id);
                if (!item) return;
                if (entry.kind === 'folder') entries = entries.concat(collectFolderEntries(item.id, ''));
                else entries.push({ type: 'file', path: sanitizeZipPathPart(suiteDownloadName(item)), file: item });
            });
            if (!entries.length) { if (window.showToast) window.showToast('Nothing to download.'); return; }
            var blob = await createZip(entries);
            saveDownload(blob, 'EmeraldNetwork-selection', '.zip');
            clearDriveSelection();
        } catch (error) {
            console.error('[Drive] selection zip failed', error);
            if (window.showToast) window.showToast(error.message || 'Could not download the selected items.');
        }
    }

    async function trashDriveSelection() {
        var selected = selectionState.items.slice();
        if (!selected.length) return;
        var eligible = selected.filter(function (entry) {
            var item = findDriveItemBySelection(entry.kind, entry.id);
            return item && !item.trashed && !(entry.kind === 'folder' && isSuiteFolder(item));
        });
        if (!eligible.length) { if (window.showToast) window.showToast('These items cannot be moved to trash.'); return; }
        var result = await showDriveModal({
            title: 'Move ' + eligible.length + (eligible.length === 1 ? ' item' : ' items') + ' to trash?',
            message: 'You can restore them from Drive Trash.',
            primaryLabel: 'Move to trash',
            danger: true
        });
        if (!result.confirmed) return;
        var processed = {};
        eligible.forEach(function (entry) {
            var item = findDriveItemBySelection(entry.kind, entry.id);
            if (!item) return;
            var targets = entry.kind === 'folder' ? folderContents(item.id) : [item];
            targets.forEach(function (target) {
                var key = target.driveKey || target.id;
                if (processed[key]) return;
                processed[key] = true;
                target.trashed = true;
                target.trashedAt = Date.now();
                trashMap[key] = target.trashedAt;
            });
            if (entry.kind === 'folder') item.trashed = true;
        });
        clearDriveSelection();
        await saveDriveData();
        render();
        if (window.showToast) window.showToast('Moved ' + eligible.length + (eligible.length === 1 ? ' item' : ' items') + ' to trash.');
    }

    function openDriveFile(file) {
        if (!file) return;
        file.lastOpenedAt = Date.now();
        flagsMap[file.driveKey || file.id] = Object.assign({}, flagsMap[file.driveKey || file.id], { lastOpenedAt: file.lastOpenedAt });
        saveDriveFlags();
        if (file.externalApp) {
            var urls = { doc: '/docs', note: '/notes', slide: '/slides', sheet: '/sheets' };
            var url = (urls[file.type] || '/') + '?owned=' + encodeURIComponent(file.id);
            var anchor = document.createElement('a');
            anchor.href = url;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            return;
        }
        previewDriveFile(file);
    }

    function wireDriveMediaPlayer(container, kind, src, name) {
        if (!container) return;
        container.innerHTML = '';
        function fmtTime(seconds) {
            if (!isFinite(seconds) || seconds < 0) return '0:00';
            var minutes = Math.floor(seconds / 60);
            var rest = Math.floor(seconds % 60);
            return minutes + ':' + (rest < 10 ? '0' : '') + rest;
        }
        var playSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
        var pauseSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        var volumeOnSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        var volumeOffSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
        var fullscreenSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';

        if (kind === 'video') {
            var player = document.createElement('div');
            player.className = 'drive-video-player paused';
            var video = document.createElement('video');
            video.src = src;
            video.preload = 'metadata';
            video.playsInline = true;
            video.muted = false;
            var bigPlay = document.createElement('div');
            bigPlay.className = 'vid-big-play';
            bigPlay.innerHTML = playSvg;
            var controls = document.createElement('div');
            controls.className = 'vid-controls';
            var progressWrap = document.createElement('div');
            progressWrap.className = 'vid-progress-wrap';
            var bufferBar = document.createElement('div');
            bufferBar.className = 'vid-buffer-bar';
            var progressBar = document.createElement('div');
            progressBar.className = 'vid-progress-bar';
            progressWrap.appendChild(bufferBar);
            progressWrap.appendChild(progressBar);
            var buttons = document.createElement('div');
            buttons.className = 'vid-btns';
            var playButton = document.createElement('button');
            playButton.className = 'vid-btn';
            playButton.type = 'button';
            playButton.innerHTML = playSvg;
            playButton.title = 'Play';
            var time = document.createElement('span');
            time.className = 'vid-time';
            time.textContent = '0:00 / 0:00';
            var spacer = document.createElement('div');
            spacer.className = 'vid-spacer';
            var volumeWrap = document.createElement('div');
            volumeWrap.className = 'vid-vol-wrap';
            var volumeButton = document.createElement('button');
            volumeButton.className = 'vid-btn';
            volumeButton.type = 'button';
            volumeButton.innerHTML = volumeOnSvg;
            volumeButton.title = 'Volume';
            var volumeSlider = document.createElement('input');
            volumeSlider.type = 'range';
            volumeSlider.className = 'vid-vol-slider';
            volumeSlider.min = '0';
            volumeSlider.max = '1';
            volumeSlider.step = '0.05';
            volumeSlider.value = '1';
            volumeWrap.appendChild(volumeButton);
            volumeWrap.appendChild(volumeSlider);
            var fullscreenButton = document.createElement('button');
            fullscreenButton.className = 'vid-btn';
            fullscreenButton.type = 'button';
            fullscreenButton.innerHTML = fullscreenSvg;
            fullscreenButton.title = 'Fullscreen';
            buttons.appendChild(playButton);
            buttons.appendChild(time);
            buttons.appendChild(spacer);
            buttons.appendChild(volumeWrap);
            buttons.appendChild(fullscreenButton);
            controls.appendChild(progressWrap);
            controls.appendChild(buttons);
            player.appendChild(video);
            player.appendChild(bigPlay);
            player.appendChild(controls);
            container.appendChild(player);

            function togglePlay() {
                if (video.paused) video.play(); else video.pause();
            }
            function updateState() {
                var paused = video.paused;
                player.classList.toggle('paused', paused);
                playButton.innerHTML = paused ? playSvg : pauseSvg;
                bigPlay.innerHTML = playSvg;
            }
            function updateTime() {
                var current = video.currentTime || 0;
                var duration = video.duration || 0;
                time.textContent = fmtTime(current) + ' / ' + fmtTime(duration);
                if (duration > 0) progressBar.style.width = (current / duration * 100) + '%';
            }
            function updateBuffer() {
                if (video.buffered.length > 0 && video.duration > 0) {
                    var end = video.buffered.end(video.buffered.length - 1);
                    bufferBar.style.width = (end / video.duration * 100) + '%';
                }
            }
            video.addEventListener('click', function (event) { event.stopPropagation(); togglePlay(); });
            bigPlay.addEventListener('click', function (event) { event.stopPropagation(); togglePlay(); });
            playButton.addEventListener('click', function (event) { event.stopPropagation(); togglePlay(); });
            video.addEventListener('play', updateState);
            video.addEventListener('pause', updateState);
            video.addEventListener('ended', updateState);
            video.addEventListener('timeupdate', updateTime);
            video.addEventListener('loadedmetadata', function () {
                updateTime();
                updateBuffer();
                if (!video.currentTime && video.duration) {
                    try { video.currentTime = Math.min(0.1, video.duration); } catch (_) {}
                }
            });
            video.addEventListener('progress', updateBuffer);
            progressWrap.addEventListener('click', function (event) {
                event.stopPropagation();
                var rect = progressWrap.getBoundingClientRect();
                var percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                if (video.duration) video.currentTime = percent * video.duration;
            });
            volumeSlider.addEventListener('input', function (event) {
                event.stopPropagation();
                video.volume = parseFloat(volumeSlider.value);
                video.muted = video.volume === 0;
                volumeButton.innerHTML = video.muted || video.volume === 0 ? volumeOffSvg : volumeOnSvg;
            });
            volumeButton.addEventListener('click', function (event) {
                event.stopPropagation();
                video.muted = !video.muted;
                volumeButton.innerHTML = video.muted ? volumeOffSvg : volumeOnSvg;
                volumeSlider.value = video.muted ? '0' : String(video.volume);
            });
            fullscreenButton.addEventListener('click', function (event) {
                event.stopPropagation();
                if (document.fullscreenElement === player) {
                    if (document.exitFullscreen) document.exitFullscreen();
                } else if (player.requestFullscreen) {
                    player.requestFullscreen();
                } else if (player.webkitRequestFullscreen) {
                    player.webkitRequestFullscreen();
                }
            });
            [playButton, volumeButton, volumeSlider, fullscreenButton, progressWrap, bigPlay].forEach(function (element) {
                element.addEventListener('mousedown', function (event) { event.stopPropagation(); });
            });
            updateState();
        } else {
            var audioPlayer = document.createElement('div');
            audioPlayer.className = 'drive-audio-player';
            var art = document.createElement('div');
            art.className = 'aud-art';
            var artIcon = document.createElement('div');
            artIcon.className = 'aud-art-icon';
            artIcon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
            var wave = document.createElement('div');
            wave.className = 'aud-wave';
            for (var i = 0; i < 5; i++) wave.appendChild(document.createElement('span'));
            art.appendChild(artIcon);
            art.appendChild(wave);
            var audio = document.createElement('audio');
            audio.src = src;
            audio.preload = 'metadata';
            var audioControls = document.createElement('div');
            audioControls.className = 'aud-controls';
            var audioProgressWrap = document.createElement('div');
            audioProgressWrap.className = 'aud-progress-wrap';
            var audioProgressBar = document.createElement('div');
            audioProgressBar.className = 'aud-progress-bar';
            audioProgressWrap.appendChild(audioProgressBar);
            var audioButtons = document.createElement('div');
            audioButtons.className = 'aud-btns';
            var audioPlayButton = document.createElement('button');
            audioPlayButton.className = 'aud-play-btn';
            audioPlayButton.type = 'button';
            audioPlayButton.innerHTML = playSvg;
            audioPlayButton.title = 'Play';
            var audioTime = document.createElement('span');
            audioTime.className = 'aud-time';
            audioTime.textContent = '0:00';
            var audioSpacer = document.createElement('div');
            audioSpacer.className = 'aud-spacer';
            var audioVolumeWrap = document.createElement('div');
            audioVolumeWrap.className = 'aud-vol-wrap';
            var audioVolumeButton = document.createElement('button');
            audioVolumeButton.className = 'aud-btn';
            audioVolumeButton.type = 'button';
            audioVolumeButton.innerHTML = volumeOnSvg;
            audioVolumeButton.title = 'Volume';
            var audioVolumeSlider = document.createElement('input');
            audioVolumeSlider.type = 'range';
            audioVolumeSlider.className = 'aud-vol-slider';
            audioVolumeSlider.min = '0';
            audioVolumeSlider.max = '1';
            audioVolumeSlider.step = '0.05';
            audioVolumeSlider.value = '1';
            audioVolumeWrap.appendChild(audioVolumeButton);
            audioVolumeWrap.appendChild(audioVolumeSlider);
            audioButtons.appendChild(audioPlayButton);
            audioButtons.appendChild(audioTime);
            audioButtons.appendChild(audioSpacer);
            audioButtons.appendChild(audioVolumeWrap);
            audioControls.appendChild(audioProgressWrap);
            audioControls.appendChild(audioButtons);
            audioPlayer.appendChild(art);
            audioPlayer.appendChild(audioControls);
            container.appendChild(audioPlayer);

            function updateAudioState() {
                audioPlayer.classList.toggle('paused', audio.paused);
                audioPlayer.classList.toggle('playing', !audio.paused);
                audioPlayButton.innerHTML = audio.paused ? playSvg : pauseSvg;
            }
            function updateAudioTime() {
                var current = audio.currentTime || 0;
                var duration = audio.duration || 0;
                audioTime.textContent = fmtTime(current) + (duration ? ' / ' + fmtTime(duration) : '');
                if (duration > 0) audioProgressBar.style.width = (current / duration * 100) + '%';
            }
            function updateAudioBuffer() {
                if (audio.buffered.length > 0 && audio.duration > 0) {
                    art.classList.add('is-buffering');
                }
            }
            audioPlayButton.addEventListener('click', function (event) { event.stopPropagation(); if (audio.paused) audio.play(); else audio.pause(); });
            audio.addEventListener('play', updateAudioState);
            audio.addEventListener('pause', updateAudioState);
            audio.addEventListener('ended', updateAudioState);
            audio.addEventListener('timeupdate', updateAudioTime);
            audio.addEventListener('loadedmetadata', function () { updateAudioTime(); updateAudioBuffer(); });
            audioProgressWrap.addEventListener('click', function (event) {
                event.stopPropagation();
                var rect = audioProgressWrap.getBoundingClientRect();
                var percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                if (audio.duration) audio.currentTime = percent * audio.duration;
            });
            audioVolumeSlider.addEventListener('input', function (event) {
                event.stopPropagation();
                audio.volume = parseFloat(audioVolumeSlider.value);
                audio.muted = audio.volume === 0;
                audioVolumeButton.innerHTML = audio.muted || audio.volume === 0 ? volumeOffSvg : volumeOnSvg;
            });
            audioVolumeButton.addEventListener('click', function (event) {
                event.stopPropagation();
                audio.muted = !audio.muted;
                audioVolumeButton.innerHTML = audio.muted ? volumeOffSvg : volumeOnSvg;
                audioVolumeSlider.value = audio.muted ? '0' : String(audio.volume);
            });
            updateAudioState();
        }
    }

    function previewDriveFile(file) {
        var bodyHtml = '';
        var mime = String(file.mimeType || '').toLowerCase();
        if (file.dataUrl && (/^image\//.test(mime) || file.type === 'image')) bodyHtml = '<div class="drive-preview-image-wrap"><img class="drive-preview-image" src="' + esc(file.dataUrl) + '" alt="' + esc(file.name) + '"></div>';
        else if (file.dataUrl && (file.type === 'pdf' || mime === 'application/pdf')) bodyHtml = '<div class="drive-pdf-document-preview is-loading" data-pdf-document="' + esc(file.id) + '" aria-label="All pages of ' + esc(file.name) + '"><span class="pdf-preview-sheen"></span><span class="pdf-preview-error">PDF preview could not be rendered</span></div>';
        else if (isAudioFile(file) && file.dataUrl) bodyHtml = '<div class="drive-preview-media"><div class="drive-media-player" data-drive-media="audio"></div><p class="drive-preview-media-name">' + esc(file.name) + '</p></div>';
        else if (isVideoFile(file) && file.dataUrl) bodyHtml = '<div class="drive-preview-media"><div class="drive-media-player" data-drive-media="video"></div><p class="drive-preview-media-name">' + esc(file.name) + '</p></div>';
        else if (isTextLikeFile(file)) {
            var previewText = file.previewText || previewTextFromDataUrl(file.dataUrl);
            if (previewText) {
                var pretty = previewText;
                if (/json/i.test(mime) || /\\.json$/i.test(file.name || '')) { try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch (_) {} }
                bodyHtml = '<pre class="drive-preview-text">' + esc(pretty.slice(0, 100000)) + '</pre>';
            } else bodyHtml = '<div class="drive-preview-other">' + fileIconSvg(file.type, file.name) + '<div><strong>' + esc(file.name) + '</strong><small>' + esc(file.mimeType || file.size || 'Preview is unavailable for this file type.') + '</small></div></div>';
        }
        else if (file.type === 'note' && file.previewText) bodyHtml = contentPageMarkup(file, 'note', true);
        else if (file.type === 'doc' && file.previewText) bodyHtml = contentPageMarkup(file, 'doc', true);
        else if (file.type === 'slide' && file.previewData) bodyHtml = slideDeckPreviewMarkup(file, 4, false);
        else if (file.type === 'sheet' && file.previewData) bodyHtml = '<div class="drive-sheet-large-preview">' + sheetPreviewMarkup(file) + '</div>';
        else if (file.previewText) {
            var previewText = String(file.previewText).slice(0, 5000);
            if (/json/i.test(file.mimeType || '') || /\.json$/i.test(file.name || '')) {
                try { previewText = JSON.stringify(JSON.parse(previewText), null, 2); } catch (_) {}
            }
            bodyHtml = '<pre class="drive-preview-text">' + esc(previewText) + '</pre>';
        }
        else {
            var decodedPreview = previewTextFromDataUrl(file.dataUrl);
            if (decodedPreview && isMostlyText(decodedPreview)) bodyHtml = '<pre class="drive-preview-text">' + esc(decodedPreview.slice(0, 100000)) + '</pre>';
            else bodyHtml = '<div class="drive-preview-other">' + fileIconSvg(file.type, file.name) + '<div><strong>' + esc(file.name) + '</strong><small>' + esc(file.mimeType || file.size || 'Preview is unavailable for this file type.') + '</small></div></div>';
        }
        showDriveModal({ title: file.name, bodyHtml: bodyHtml, preview: true });
        var mediaPlayer = $('driveModalBody') ? $('driveModalBody').querySelector('[data-drive-media]') : null;
        if (mediaPlayer) wireDriveMediaPlayer(mediaPlayer, mediaPlayer.getAttribute('data-drive-media'), file.dataUrl, file.name);
        if (file.type === 'pdf' || mime === 'application/pdf') renderPdfDocumentPreview(file, $('driveModalBody').querySelector('[data-pdf-document]'));
    }

    async function downloadFile(file) {
        if (!file) return;
        if (file.externalApp) {
            try {
                var blob, extension;
                if (file.appType === 'notes') {
                    var s = storage();
                    var records = s && s.getJSON ? await s.getJSON('emeraldcore.storage.suite.notes') : [];
                    var note = Array.isArray(records) && records.find(function (entry) { return String(entry && entry.id) === String(file.id); });
                    if (!note) throw new Error('Note data is not available on this device.');
                    var holder = document.createElement('div'); holder.innerHTML = note.content || '';
                    blob = new Blob([holder.innerText || holder.textContent || ''], { type: 'text/plain;charset=utf-8' });
                    extension = '.txt';
                } else if (file.appType === 'docs') {
                    var sDocs = storage();
                    var doc = sDocs && sDocs.getJSON ? await sDocs.getJSON('emeraldcore.storage.suite.docs.' + file.id) : null;
                    if (!doc || !window.EMDocx) throw new Error('Document exporter is unavailable.');
                    blob = await window.EMDocx.fromHtml(doc.content || '<p></p>', { title: doc.title || file.name, pageW: doc.pageSize && doc.pageSize.w, pageH: doc.pageSize && doc.pageSize.h, margins: doc.pageMargins || {} });
                    extension = '.docx';
                } else if (file.appType === 'slides') {
                    blob = await withSuiteFrame('/slides?owned=' + encodeURIComponent(file.id), async function (frameWindow) {
                        var app = frameWindow.slidesApp;
                        if (!app || !app.pres || String(app.pres.id) !== String(file.id)) throw new Error('Presentation is still loading.');
                        var exportBlob = await app.exportPPTX(true);
                        if (!exportBlob || typeof exportBlob.size !== 'number' || typeof exportBlob.slice !== 'function') throw new Error('Presentation export failed.');
                        return exportBlob;
                    });
                    extension = '.pptx';
                } else {
                    var sheetExport = await withSuiteFrame('/sheets?owned=' + encodeURIComponent(file.id), async function (frameWindow) {
                        if (!frameWindow.ZS || !frameWindow.ZS.exportBytes) throw new Error('Spreadsheet exporter is still loading.');
                        return frameWindow.ZS.exportBytes();
                    });
                    if (!sheetExport || typeof sheetExport === 'string' || !sheetExport.bytes) throw new Error('Spreadsheet export failed.');
                    blob = new Blob([sheetExport.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    extension = '.xlsx';
                }
                saveDownload(blob, file.name, extension);
            } catch (error) { console.error('[Drive] export failed', error); if (window.showToast) window.showToast(error.message || 'Could not export this file.'); }
            return;
        }
        if (!file.dataUrl) return;
        var anchor = document.createElement('a');
        anchor.href = file.dataUrl;
        anchor.download = file.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    function sanitizeZipPathPart(value) {
        return String(value || 'item').replace(/[\\\\/:*?"<>|]/g, '_').trim() || 'item';
    }

    function suiteDownloadExtension(file) {
        if (!file.externalApp) return '';
        if (file.appType === 'notes') return '.txt';
        if (file.appType === 'docs') return '.docx';
        if (file.appType === 'slides') return '.pptx';
        if (file.appType === 'sheets') return '.xlsx';
        return '';
    }

    function suiteDownloadName(file) {
        var base = file.name || 'Untitled';
        var extension = suiteDownloadExtension(file);
        if (extension && !new RegExp('\\' + extension + '$', 'i').test(base)) return base + extension;
        return base;
    }

    async function suiteFileBytes(file) {
        if (file.appType === 'notes') {
            var noteStorage = storage();
            var records = noteStorage && noteStorage.getJSON ? await noteStorage.getJSON('emeraldcore.storage.suite.notes') : [];
            var note = Array.isArray(records) && records.find(function (entry) { return String(entry && entry.id) === String(file.id); });
            var holder = document.createElement('div');
            holder.innerHTML = note && note.content || '';
            return new TextEncoder().encode(holder.innerText || holder.textContent || '');
        }
        if (file.appType === 'docs') {
            var docStorage = storage();
            var doc = docStorage && docStorage.getJSON ? await docStorage.getJSON('emeraldcore.storage.suite.docs.' + file.id) : null;
            if (!doc || !window.EMDocx) throw new Error('Document exporter is unavailable.');
            var blob = await window.EMDocx.fromHtml(doc.content || '<p></p>', { title: doc.title || file.name, pageW: doc.pageSize && doc.pageSize.w, pageH: doc.pageSize && doc.pageSize.h, margins: doc.pageMargins || {} });
            return new Uint8Array(await blob.arrayBuffer());
        }
        if (file.appType === 'slides') {
            var slideBlob = await withSuiteFrame('/slides?owned=' + encodeURIComponent(file.id), async function (frameWindow) {
                var app = frameWindow.slidesApp;
                if (!app || !app.pres || String(app.pres.id) !== String(file.id)) throw new Error('Presentation is still loading.');
                var exported = await app.exportPPTX(true);
                if (!exported || typeof exported.size !== 'number' || typeof exported.slice !== 'function') throw new Error('Presentation export failed.');
                return exported;
            });
            return new Uint8Array(await slideBlob.arrayBuffer());
        }
        if (file.appType === 'sheets') {
            var sheetExport = await withSuiteFrame('/sheets?owned=' + encodeURIComponent(file.id), async function (frameWindow) {
                if (!frameWindow.ZS || !frameWindow.ZS.exportBytes) throw new Error('Spreadsheet exporter is still loading.');
                return frameWindow.ZS.exportBytes();
            });
            if (!sheetExport || typeof sheetExport === 'string' || !sheetExport.bytes) throw new Error('Spreadsheet export failed.');
            return new Uint8Array(sheetExport.bytes);
        }
        throw new Error('This file cannot be included in a zip.');
    }

    async function fileBytesForZip(file) {
        if (file.externalApp) return suiteFileBytes(file);
        if (!file.dataUrl) throw new Error(file.name + ' has no downloadable data.');
        var response = await fetch(file.dataUrl);
        return new Uint8Array(await response.arrayBuffer());
    }

    function collectFolderEntries(folderId, prefix) {
        var folder = folders.find(function (entry) { return String(entry.id) === String(folderId); });
        var base = prefix ? prefix + '/' + sanitizeZipPathPart(folder ? folder.name : 'Folder') : sanitizeZipPathPart(folder ? folder.name : 'Folder');
        var entries = [{ type: 'dir', path: base + '/' }];
        childrenOf(folderId).forEach(function (child) {
            entries = entries.concat(collectFolderEntries(child.id, base));
        });
        files.filter(function (file) { return file.folder === folderId && !file.trashed; }).forEach(function (file) {
            entries.push({ type: 'file', path: base + '/' + sanitizeZipPathPart(suiteDownloadName(file)), file: file });
        });
        return entries;
    }

    function crc32(bytes) {
        var table = crc32.table;
        if (!table) {
            table = new Uint32Array(256);
            for (var i = 0; i < 256; i++) {
                var c = i;
                for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                table[i] = c >>> 0;
            }
            crc32.table = table;
        }
        var crc = 0xFFFFFFFF;
        for (var index = 0; index < bytes.length; index++) crc = table[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function concatUint8Arrays(parts) {
        var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
        var output = new Uint8Array(total);
        var offset = 0;
        parts.forEach(function (part) { output.set(part, offset); offset += part.length; });
        return output;
    }

    async function createZip(entries) {
        var localParts = [];
        var centralParts = [];
        var offset = 0;
        var encoder = new TextEncoder();
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var nameBytes = encoder.encode(entry.path);
            var isDir = entry.type === 'dir';
            var data = isDir ? new Uint8Array(0) : await fileBytesForZip(entry.file);
            var checksum = crc32(data);
            var localHeader = new Uint8Array(30 + nameBytes.length);
            var localView = new DataView(localHeader.buffer);
            localView.setUint32(0, 0x04034b50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, 0, true);
            localView.setUint16(12, 0, true);
            localView.setUint32(14, checksum, true);
            localView.setUint32(18, data.length, true);
            localView.setUint32(22, data.length, true);
            localView.setUint16(26, nameBytes.length, true);
            localView.setUint16(28, 0, true);
            localHeader.set(nameBytes, 30);
            var centralHeader = new Uint8Array(46 + nameBytes.length);
            var centralView = new DataView(centralHeader.buffer);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, 0, true);
            centralView.setUint16(14, 0, true);
            centralView.setUint32(16, checksum, true);
            centralView.setUint32(20, data.length, true);
            centralView.setUint32(24, data.length, true);
            centralView.setUint16(28, nameBytes.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, isDir ? (0x10 << 16) : 0, true);
            centralView.setUint32(42, offset, true);
            centralHeader.set(nameBytes, 46);
            localParts.push(localHeader, data);
            centralParts.push(centralHeader);
            offset += localHeader.length + data.length;
        }
        var centralDirectory = concatUint8Arrays(centralParts);
        var endRecord = new Uint8Array(22);
        var endView = new DataView(endRecord.buffer);
        endView.setUint32(0, 0x06054b50, true);
        endView.setUint16(4, 0, true);
        endView.setUint16(6, 0, true);
        endView.setUint16(8, entries.length, true);
        endView.setUint16(10, entries.length, true);
        endView.setUint32(12, centralDirectory.length, true);
        endView.setUint32(16, offset, true);
        endView.setUint16(20, 0, true);
        return new Blob([concatUint8Arrays(localParts), centralDirectory, endRecord], { type: 'application/zip' });
    }

    async function downloadFolder(folder) {
        if (!folder) return;
        try {
            if (window.showToast) window.showToast('Preparing zip…');
            var entries = collectFolderEntries(folder.id, '');
            var blob = await createZip(entries);
            saveDownload(blob, folder.name, '.zip');
        } catch (error) {
            console.error('[Drive] folder zip failed', error);
            if (window.showToast) window.showToast(error.message || 'Could not download this folder.');
        }
    }

    function withSuiteFrame(url, callback) {
        return new Promise(function (resolve, reject) {
            var frame = document.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;visibility:hidden';
            var timeout = setTimeout(function () { cleanup(); reject(new Error('The EmeraldSuite exporter took too long to load.')); }, 45000);
            function cleanup() { clearTimeout(timeout); frame.remove(); }
            frame.src = url;
            document.body.appendChild(frame);
            var attempts = 0;
            var poll = async function () {
                try {
                    if (frame.contentWindow && frame.contentDocument && frame.contentDocument.readyState === 'complete') {
                        var result = await callback(frame.contentWindow);
                        cleanup(); resolve(result); return;
                    }
                } catch (error) {
                    if (error && /still loading/.test(error.message) && attempts++ < 450) { setTimeout(poll, 100); return; }
                    cleanup(); reject(error); return;
                }
                if (attempts++ >= 450) { cleanup(); reject(new Error('The EmeraldSuite exporter took too long to load.')); return; }
                setTimeout(poll, 100);
            };
            frame.addEventListener('load', poll);
            setTimeout(poll, 100);
        });
    }

    function saveDownload(blob, name, extension) {
        var base = String(name || 'Untitled').replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '_') || 'Untitled';
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url; anchor.download = base + extension;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }

    function contextRow(label, action, danger) {
        return '<a href="#" role="menuitem" data-context-action="' + action + '"' + (danger ? ' class="ctx-danger"' : '') + '>' +
            esc(label) + '</a>';
    }

    function isSuiteFolder(item) {
        if (!item || item.type) return false;
        return [
            'emerald-suite-root-folder',
            'emerald-suite-doc-folder',
            'emerald-suite-slide-folder',
            'emerald-suite-sheet-folder',
            'emerald-suite-note-folder'
        ].indexOf(String(item.id)) !== -1;
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
        selectedDriveItem = item;
        var isSuiteFolderItem = isFolder && isSuiteFolder(item);
        var appNames = { doc: 'Docs', note: 'Notes', slide: 'Slides', sheet: 'Sheets' };
        var previewType = item.type === 'image' || item.type === 'pdf';
        var primaryLabel = isFolder ? 'Open folder' : (appNames[item.type] ? 'Open in ' + appNames[item.type] : (previewType ? 'Preview' : 'Open'));
        var itemIcon = isFolder
            ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
            : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>';
        var itemKind = isFolder ? 'Folder' : esc((TYPE_META[item.type] || TYPE_META.other).label);
        var html = '<div class="context-title">' + itemIcon + '<span>' + esc(item.name) + '</span></div>' +
            '<div class="context-text">' + itemKind + (item.shared ? ' · Shared' : '') + '</div>' +
            '<div class="context-section">' +
            contextRow(primaryLabel, 'open');
        if (item.trashed) {
            html += contextRow('Restore', 'restore') + contextRow('Delete forever', 'purge', true) + '</div>';
        } else {
        html += contextRow('Download', 'download') + contextRow('Copy link', 'copy-link');
        if (!isSuiteFolderItem) {
            html += contextRow('Rename', 'rename') +
                (isSuiteFolderItem ? '' : contextRow('Manage access', 'manage-access')) + contextRow('Duplicate', 'duplicate') +
                contextRow('Copy', 'copy') + (isSuiteFolderItem ? '' : contextRow('Move', 'move'));
        }
        if (isFolder && driveClipboard && !isSuiteFolderItem) html += contextRow('Paste', 'paste');
        if (isFolder) {
            html += '</div>';
            if (!isSuiteFolderItem) {
                html += '<div class="context-section drive-folder-color-section"><span class="drive-context-label">Folder color</span><div class="drive-folder-colors" role="group" aria-label="Folder color">' +
                    ['#f3b900', '#ef6c63', '#a879d8', '#4c9be8', '#39a66b', '#6d7c8f'].map(function (color, index) {
                        return '<button type="button" data-context-action="folder-color" data-color="' + color + '" aria-label="Folder color ' + (index + 1) + '" style="--swatch:' + color + '"></button>';
                    }).join('') + '</div></div>';
            }
        } else html += contextRow(item.starred ? 'Unstar' : 'Star', 'star') + '</div>';
        if (!isSuiteFolderItem) html += '<div class="context-section">' + contextRow('Move to trash', 'delete', true) + '</div>';
        }
        menu.innerHTML = html;
        menu.dataset.contextItemId = isFolder ? folderId : fileId;
        menu.dataset.contextIsFolder = isFolder ? '1' : '0';
        delete menu.dataset.contextSelection;
        positionContextMenu(menu, event.clientX, event.clientY);
    }

    function selectionEntryForTarget(target) {
        if (!target || !target.hasAttribute) return null;
        var isFolder = target.hasAttribute('data-folder');
        var id = isFolder ? target.getAttribute('data-folder') : target.getAttribute('data-file');
        if (id === null) return null;
        var key = driveItemKey(isFolder ? 'folder' : 'file', id);
        return selectionState.items.filter(function (entry) { return entry.key === key; })[0] || null;
    }

    function openSelectionContextMenu(event) {
        var menu = $('custom-context-menu');
        if (!menu) return;
        var count = selectionState.items.length;
        if (!count) return;
        event.preventDefault();
        var isTrash = state.view === 'trash';
        var icon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
        var html = '<div class="context-title">' + icon + '<span>' + count + (count === 1 ? ' item selected' : ' items selected') + '</span></div>' +
            '<div class="context-section">';
        if (!isTrash) {
            html += contextRow('Download ' + count + (count === 1 ? ' item' : ' items'), 'selection-download') +
                contextRow('Move ' + count + (count === 1 ? ' item' : ' items') + ' to trash', 'selection-trash', true);
        }
        html += contextRow('Clear selection', 'selection-clear') + '</div>';
        menu.innerHTML = html;
        delete menu.dataset.contextItemId;
        menu.dataset.contextIsFolder = '0';
        menu.dataset.contextSelection = '1';
        positionContextMenu(menu, event.clientX, event.clientY);
    }

    function bindContextMenu() {
        var menu = $('custom-context-menu');
        if (!menu) return;
        var defaultMenuHTML = menu.innerHTML;
        var suppressNextContextMenu = false;

        function closeContextMenu() {
            menu.style.display = 'none';
            delete menu.dataset.contextSelection;
        }

        // Pressing anywhere outside the menu dismisses it. A right-click outside
        // also suppresses the menu the browser would otherwise open right after.
        document.addEventListener('pointerdown', function (event) {
            if (menu.style.display !== 'block') return;
            var pressed = event.target;
            if (pressed && pressed.nodeType === 1 && pressed.closest('#custom-context-menu')) return;
            closeContextMenu();
            if (event.button === 2) {
                suppressNextContextMenu = true;
                setTimeout(function () { suppressNextContextMenu = false; }, 700);
            }
        }, true);

        window.addEventListener('contextmenu', function (event) {
            if (suppressNextContextMenu) {
                suppressNextContextMenu = false;
                event.preventDefault();
                closeContextMenu();
                return;
            }
            if (event.target && event.target.closest && event.target.closest('#custom-context-menu')) return;
            var target = event.target.closest('.dfile-card, .dfolder-card, .drow[data-file], .drow[data-folder]');
            if (target) {
                if (selectionState.items.length > 1) {
                    if (selectionEntryForTarget(target)) { openSelectionContextMenu(event); return; }
                    clearDriveSelection();
                }
                openItemContextMenu(event, target);
                return;
            }
            if (selectionState.items.length > 1 && event.target.closest('#driveContent')) {
                openSelectionContextMenu(event);
                return;
            }
            clearDriveSelection();
            menu.innerHTML = defaultMenuHTML;
            var pasteButton = menu.querySelector('[data-context-action="drive-paste"]');
            if (pasteButton) pasteButton.style.display = driveClipboard ? '' : 'none';
            delete menu.dataset.contextItemId;
            delete menu.dataset.contextSelection;
            menu.dataset.contextIsFolder = '0';
            positionContextMenu(menu, event.clientX, event.clientY);
        });
        menu.addEventListener('click', function (event) {
            var action = event.target.closest('[data-context-action]');
            if (!action) return;
            event.preventDefault();
            runContextAction(action.dataset.contextAction, action.dataset.color);
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closeContextMenu();
        });
    }

    async function runContextAction(action, color) {
        var menu = $('custom-context-menu');
        if (action === 'selection-download') { menu.style.display = 'none'; return downloadDriveSelection(); }
        if (action === 'selection-trash') { menu.style.display = 'none'; return trashDriveSelection(); }
        if (action === 'selection-clear') { menu.style.display = 'none'; return clearDriveSelection(); }
        var isFolder = menu.dataset.contextIsFolder === '1';
        var id = menu.dataset.contextItemId;
        if (action === 'drive-paste' || action === 'paste') {
            var pasteTarget = action === 'drive-paste' ? state.folderId : (isFolder ? id : state.folderId);
            await pasteDriveClipboard(pasteTarget || null);
            menu.style.display = 'none';
            return;
        }
        var item = isFolder ? folders.find(function (f) { return String(f.id) === String(id); }) : files.find(function (f) { return String(f.id) === String(id); });
        if (!item) return;
        menu.style.display = 'none';
        if (action === 'open') {
            if (isFolder) {
                state.view = 'mydrive';
                state.folderId = item.id;
                setActiveNav('mydrive');
                switchPage(render);
            } else {
                openDriveFile(item);
            }
            return;
        }
        if (action === 'download') return isFolder ? downloadFolder(item) : downloadFile(item);
        if (action === 'copy-link') {
            var link = item.externalApp
                ? new URL(({doc:'/docs',note:'/notes',slide:'/slides',sheet:'/sheets'})[item.type] + '?owned=' + encodeURIComponent(item.id), location.origin).href
                : (isFolder
                    ? new URL('/drive?folder=' + encodeURIComponent(item.id), location.origin).href
                    : new URL('/drive?file=' + encodeURIComponent(item.id), location.origin).href);
            try { await navigator.clipboard.writeText(link); if (window.showToast) window.showToast('Link copied'); }
            catch (_) { await showDriveModal({ title: 'Copy link', message: 'Copy this link to open the file in EmeraldNetwork.', input: { value: link, label: 'File link' }, primaryLabel: 'Done' }); }
            return;
        }
        if (action === 'star') { item.starred = !item.starred; await saveDriveData(); render(); return; }
        if (action === 'folder-color') { item.color = color; await saveDriveData(); render(); return; }
        if (action === 'rename') {
            var current = item.name || '';
            var result = await showDriveModal({ title: 'Rename', message: 'Enter a new name.', input: { value: current, label: 'Name' }, primaryLabel: 'Rename', cancelLabel: 'Cancel' });
            if (!result.confirmed) return;
            var value = String(result.value || '').trim();
            if (!value) { if (window.showToast) window.showToast('Name cannot be empty'); return; }
            if (value === current) return;
            item.name = value;
            if (item.externalApp) await renameSuiteFile(item, value);
            await saveDriveData(); render();
            if (window.showToast) window.showToast('Renamed to “' + esc(value) + '”.');
            return;
        }
        if (action === 'manage-access') {
            var current = (item.sharedWith || []).join(', ');
            var result = await showDriveModal({ title: 'Manage access', message: 'Enter email addresses separated by commas.', input: { value: current, placeholder: 'name@example.com', label: 'People with access' }, primaryLabel: 'Save', cancelLabel: 'Cancel' });
            if (!result.confirmed) return;
            var value = result.value || '';
            item.sharedWith = value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
            item.shared = item.sharedWith.length > 0;
            await saveDriveData(); render(); if (window.showToast) window.showToast(item.shared ? 'Access list updated' : 'Sharing turned off'); return;
        }
        if (action === 'copy' || action === 'move') {
            if (action === 'move' && isFolder && isSuiteFolder(item)) {
                if (window.showToast) window.showToast('Folders inside EmeraldSuite cannot be moved.');
                return;
            }
            driveClipboard = { itemId: String(item.id), driveKey: item.driveKey || null, isFolder: isFolder, mode: action };
            if (window.showToast) window.showToast((action === 'copy' ? 'Copied' : 'Ready to move') + ' “' + esc(item.name) + '”. Right-click a folder and choose Paste, or use Ctrl+V.');
            return;
        }
        if (action === 'delete' || action === 'purge' || action === 'restore') {
            if (action !== 'restore') {
                var confirm = await showDriveModal({ title: action === 'purge' ? 'Delete forever?' : 'Move to trash?', message: action === 'purge' ? 'This permanently removes this item and cannot be undone.' : 'You can restore this item from Drive Trash.', primaryLabel: action === 'purge' ? 'Delete forever' : 'Move to trash', danger: action === 'purge' });
                if (!confirm.confirmed) return;
            }
            var isDelete = action === 'delete';
            var targets = isFolder ? folderContents(item.id) : [item];
            for (var targetIndex = 0; targetIndex < targets.length; targetIndex++) {
                var entry = targets[targetIndex];
                var key = entry.driveKey || entry.id;
                if (isDelete) { entry.trashed = true; entry.trashedAt = Date.now(); trashMap[key] = entry.trashedAt; }
                else if (action === 'restore') { entry.trashed = false; delete trashMap[key]; }
                else {
                    delete trashMap[key];
                    if (entry.externalApp) {
                        await hardDeleteSuiteFile(entry);
                        files = files.filter(function (file) { return file !== entry; });
                    }
                    else files = files.filter(function (f) { return f !== entry; });
                }
            }
            if (isFolder && action !== 'restore') {
                if (action === 'purge') { var idsToRemove = targets.filter(function (entry) { return entry.type === undefined; }).map(function (entry) { return entry.id; }); folders = folders.filter(function (f) { return idsToRemove.indexOf(f.id) === -1; }); }
                else item.trashed = true;
            }
            await saveDriveData(); render(); return;
        }
        if (action === 'duplicate') {
            if (isFolder) { await duplicateFolder(item); await saveDriveData(); await loadDriveData(); }
            else if (item.externalApp) {
                await duplicateSuiteFile(item);
                await loadDriveData();
            }
            else files.push(Object.assign({}, item, { id: 'file_' + Date.now(), name: uniqueName(item.name, item.folder), modifiedAt: Date.now(), trashed: false, starred: false }));
            await saveDriveData(); render(); return;
        }
    }

    function folderContents(folderId) {
        var ids = [folderId];
        childrenOf(folderId).forEach(function (child) { ids = ids.concat(folderContents(child.id)); });
        return folders.filter(function (f) { return ids.indexOf(f.id) !== -1; }).concat(files.filter(function (f) { return ids.indexOf(f.folder) !== -1; }));
    }

    async function pasteDriveClipboard(parentId) {
        if (!driveClipboard) return;
        var source = driveClipboard.isFolder
            ? folders.find(function (folder) { return String(folder.id) === driveClipboard.itemId; })
            : files.find(function (file) { return String(file.id) === driveClipboard.itemId || (driveClipboard.driveKey && file.driveKey === driveClipboard.driveKey); });
        if (!source || source.trashed) { driveClipboard = null; if (window.showToast) window.showToast('That item is no longer available.'); return; }
        if (driveClipboard.isFolder && driveClipboard.mode === 'move' && isSuiteFolder(source)) { if (window.showToast) window.showToast('Folders inside EmeraldSuite cannot be moved.'); return; }
        if (parentId && !folders.some(function (folder) { return String(folder.id) === String(parentId) && !folder.trashed; })) { if (window.showToast) window.showToast('Choose an existing folder to paste into.'); return; }
        if (driveClipboard.isFolder && driveClipboard.mode === 'move' && (source.id === parentId || folderContents(source.id).some(function (entry) { return entry.type === undefined && String(entry.id) === String(parentId); }))) {
            if (window.showToast) window.showToast('A folder cannot be moved inside itself.');
            return;
        }
        if (driveClipboard.mode === 'copy') {
            if (driveClipboard.isFolder) await duplicateFolder(source, parentId);
            else if (source.externalApp) {
                var copyId = await duplicateSuiteFile(source);
                if (copyId) flagsMap[source.appType + ':' + copyId] = { folder: parentId || null };
            } else {
                files.push(Object.assign({}, source, { id: 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: uniqueName(source.name, parentId || null), folder: parentId || null, modifiedAt: Date.now(), modified: 'Just now', created: new Date().toISOString(), trashed: false, starred: false, lastOpenedAt: 0 }));
            }
        } else {
            if (driveClipboard.isFolder) source.parent = parentId || null;
            else source.folder = parentId || null;
            source.trashed = false;
            delete trashMap[source.driveKey || source.id];
        }
        var wasMove = driveClipboard.mode === 'move';
        if (wasMove) driveClipboard = null;
        await saveDriveData();
        await loadDriveData();
        render();
        if (window.showToast) window.showToast(wasMove ? 'Moved into folder' : 'Pasted into folder');
    }

    function bindDriveClipboard() {
        document.addEventListener('keydown', function (event) {
            var key = String(event.key || '').toLowerCase();
            var shortcut = event.ctrlKey || event.metaKey;
            var target = event.target;
            var editable = target && (target.matches('input,textarea,select,[contenteditable="true"]') || target.isContentEditable);
            if (!shortcut || editable) return;
            if (key === 'v' && driveClipboard) {
                event.preventDefault();
                pasteDriveClipboard(state.folderId);
                return;
            }
            if ((key === 'c' || key === 'x') && selectedDriveItem && !(window.getSelection && window.getSelection().toString())) {
                if (key === 'x' && isSuiteFolder(selectedDriveItem)) {
                    event.preventDefault();
                    if (window.showToast) window.showToast('Folders inside EmeraldSuite cannot be moved.');
                    return;
                }
                event.preventDefault();
                driveClipboard = { itemId: String(selectedDriveItem.id), driveKey: selectedDriveItem.driveKey || null, isFolder: !selectedDriveItem.type, mode: key === 'x' ? 'move' : 'copy' };
                if (window.showToast) window.showToast(key === 'x' ? 'Ready to move. Choose a folder and press Ctrl+V.' : 'Copied. Choose a folder and press Ctrl+V.');
            }
        });
    }

    async function renameSuiteFile(file, newName) {
        var s = storage();
        if (!s || !file || !file.appType) return;
        var title = String(newName || '').replace(/\.[^.]+$/, '') || 'Untitled';
        if (file.appType === 'sheets') {
            try {
                var db = await new Promise(function (resolve, reject) { var req = indexedDB.open('emeraldcore.storage.suite.sheets', 1); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; });
                var original = await new Promise(function (resolve, reject) { var req = db.transaction('workbooks').objectStore('workbooks').get(file.id); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; });
                if (original) {
                    var copy = JSON.parse(JSON.stringify(original));
                    if (copy.data) copy.data.title = title;
                    copy.savedAt = Date.now();
                    await new Promise(function (resolve, reject) { var tx = db.transaction('workbooks', 'readwrite'); tx.objectStore('workbooks').put(copy, file.id); tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
                }
            } catch (error) { console.warn('[Drive] spreadsheet rename failed', error); }
            return;
        }
        var listKey = 'emeraldcore.storage.suite.' + file.appType;
        var list = await s.getJSON(listKey) || [];
        if (!Array.isArray(list)) list = [];
        var record = list.find(function (entry) { return String(entry && entry.id) === String(file.id); });
        if (record) {
            record.title = title;
            record.updatedAt = Date.now();
            await s.setJSON(listKey, list);
        }
        if (file.appType === 'docs' || file.appType === 'slides') {
            var contentKey = listKey + '.' + file.id;
            var content = await s.getJSON(contentKey);
            if (content) { content = Object.assign({}, content, { title: title }); await s.setJSON(contentKey, content); }
        }
    }

    async function hardDeleteSuiteFile(file) {
        var s = storage();
        if (!s) return;
        var listKey = 'emeraldcore.storage.suite.' + file.appType;
        if (file.appType === 'sheets') {
            try {
                var db = await new Promise(function (resolve, reject) { var req = indexedDB.open('emeraldcore.storage.suite.sheets', 1); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; });
                await new Promise(function (resolve, reject) { var tx = db.transaction('workbooks', 'readwrite'); tx.objectStore('workbooks').delete(file.id); tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
            } catch (_) {}
            return;
        }
        var records = await s.getJSON(listKey) || [];
        if (Array.isArray(records)) await s.setJSON(listKey, records.filter(function (entry) { return String(entry && entry.id) !== String(file.id); }));
        if (file.appType === 'docs') { await s.delete('emeraldcore.storage.suite.docs.' + file.id); await s.delete('emeraldcore.storage.suite.docs.versions.' + file.id); }
        if (file.appType === 'slides') await s.delete('emeraldcore.storage.suite.slides.' + file.id);
    }

    async function duplicateSuiteFile(file) {
        var s = storage();
        var newId = 'copy_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        if (file.appType === 'sheets') {
            try {
                var db = await new Promise(function (resolve, reject) { var req = indexedDB.open('emeraldcore.storage.suite.sheets', 1); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; });
                var original = await new Promise(function (resolve, reject) { var req = db.transaction('workbooks').objectStore('workbooks').get(file.id); req.onsuccess = function () { resolve(req.result); }; req.onerror = function () { reject(req.error); }; });
                if (original) await new Promise(function (resolve, reject) { var tx = db.transaction('workbooks', 'readwrite'); var copy = JSON.parse(JSON.stringify(original)); if (copy.data) copy.data.title = uniqueName(file.name, file.folder).replace(/\.\w+$/, ''); copy.savedAt = Date.now(); tx.objectStore('workbooks').put(copy, newId); tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
            } catch (error) { console.warn('[Drive] spreadsheet copy failed', error); }
            return newId;
        }
        if (!s) return null;
        var listKey = 'emeraldcore.storage.suite.' + file.appType;
        var list = await s.getJSON(listKey) || [];
        if (!Array.isArray(list)) list = [];
        var originalRecord = list.find(function (entry) { return String(entry && entry.id) === String(file.id); });
        if (!originalRecord) return null;
        var title = uniqueName(file.name, file.folder).replace(/\.[^.]+$/, '');
        var copiedRecord = Object.assign({}, originalRecord, { id: newId, title: title, updatedAt: Date.now(), createdAt: new Date().toISOString() });
        list.push(copiedRecord);
        await s.setJSON(listKey, list);
        if (file.appType === 'docs' || file.appType === 'slides') {
            var contentKey = listKey + '.' + file.id;
            var content = await s.getJSON(contentKey);
            if (content) { content = Object.assign({}, content, { title: title }); await s.setJSON(listKey + '.' + newId, content); }
        }
        return newId;
    }

    function uniqueName(name, parent) {
        var base = name.replace(/(\.[^.]+)$/, '');
        var ext = name.slice(base.length);
        var candidate = base + ' copy' + ext;
        var n = 2;
        while (files.some(function (f) { return f.folder === parent && f.name === candidate; })) candidate = base + ' copy ' + n++ + ext;
        return candidate;
    }

    async function duplicateFolder(folder, parent) {
        var copy = { id: 'folder_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: uniqueFolderName(folder.name + ' copy', parent === undefined ? folder.parent : parent), parent: parent === undefined ? folder.parent : parent, color: folder.color };
        folders.push(copy);
        var entries = files.filter(function (file) { return file.folder === folder.id && !file.trashed; });
        for (var i = 0; i < entries.length; i++) {
            var file = entries[i];
            if (file.externalApp) {
                var newId = await duplicateSuiteFile(file);
                if (newId) flagsMap[file.appType + ':' + newId] = { folder: copy.id };
            } else files.push(Object.assign({}, file, { id: 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), folder: copy.id, name: uniqueName(file.name, copy.id), modifiedAt: Date.now(), starred: false, lastOpenedAt: 0 }));
        }
        var childFolders = childrenOf(folder.id).slice();
        for (var childIndex = 0; childIndex < childFolders.length; childIndex++) await duplicateFolder(childFolders[childIndex], copy.id);
        return copy;
    }

    function uniqueFolderName(name, parent) {
        var base = name;
        var candidate = base;
        var index = 2;
        while (folders.some(function (folder) { return folder.parent === parent && folder.name.toLowerCase() === candidate.toLowerCase() && !folder.trashed; })) candidate = base + ' ' + index++;
        return candidate;
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

    var storageMeasureRun = 0;
    async function updateDriveStorage() {
        var run = ++storageMeasureRun;
        var size = files.filter(function (f) { return !f.trashed; }).reduce(function (sum, f) { return sum + (Number(f.sizeBytes) || bytesFromSize(f.size)); }, 0);
        var quota = 15 * 1024 * 1024 * 1024;
        try {
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                var estimate = await navigator.storage.estimate();
                if (estimate && Number(estimate.quota) > 0) quota = Number(estimate.quota);
            }
        } catch (_) {}
        if (run !== storageMeasureRun) return;
        var percent = Math.min(100, size / quota * 100);
        var bar = $('driveStorageBar');
        var label = $('driveStorageLabel');
        if (bar) bar.style.width = percent.toFixed(2) + '%';
        if (label) label.textContent = formatBytes(size) + ' of ' + formatBytes(quota) + ' used';
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
            } else {
                chooseUploads(action.getAttribute('data-create-action') === 'directory');
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

    function chooseUploads(directory) {
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        if (directory) { input.webkitdirectory = true; input.setAttribute('directory', ''); }
        input.accept = '*/*';
        input.addEventListener('change', function () { importFiles(Array.prototype.slice.call(input.files || [])); });
        input.click();
    }

    function readFileAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(reader.error || new Error('Unable to read file')); };
            reader.readAsDataURL(file);
        });
    }

    async function importFiles(selected, targetFolderId) {
        if (!selected.length) return;
        var entries = selected.map(function (entry) {
            return entry && entry.file ? entry : { file: entry, relativePath: entry && entry.webkitRelativePath || '' };
        }).filter(function (entry) { return entry.file; });
        if (!entries.length) return;
        var baseParent = targetFolderId !== undefined ? (targetFolderId || null) : (state.view === 'mydrive' ? state.folderId : null);
        state.view = 'mydrive';
        state.folderId = baseParent;
        setActiveNav('mydrive');
        renderCrumbs();
        showSkeleton();
        try {
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var file = entry.file;
                var parent = baseParent;
                var relative = entry.relativePath || file.webkitRelativePath || '';
                if (relative) {
                    var parts = relative.split('/').filter(Boolean);
                    parts.pop();
                    parts.forEach(function (part) {
                        var found = folders.find(function (f) { return f.parent === parent && f.name === part && !f.trashed; });
                        if (!found) { found = { id: 'folder_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name: part, parent: parent }; folders.push(found); }
                        parent = found.id;
                    });
                }
                var name = file.name || 'Untitled file';
                var ext = name.split('.').pop().toLowerCase();
                var type = /^(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/.test(ext) ? 'image' : (ext === 'pdf' ? 'pdf' : 'other');
                var previewText = '';
                if (isTextLikeFile({ name: name, mimeType: file.type || 'application/octet-stream' })) {
                    try { previewText = (await file.text()).slice(0, 20000); } catch (_) {}
                }
                files.push({ id: 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9), name: name, type: type, folder: parent, size: formatBytes(file.size), sizeBytes: file.size, mimeType: file.type || 'application/octet-stream', dataUrl: await readFileAsDataUrl(file), previewText: previewText, modifiedAt: Date.now(), modified: 'Just now', created: new Date().toISOString(), starred: false, shared: false, trashed: false });
            }
            await saveDriveData();
            if (window.showToast) window.showToast(entries.length + (entries.length === 1 ? ' file uploaded' : ' files uploaded'));
            render();
        } catch (error) {
            console.warn('[Drive] upload failed', error);
            if (window.showToast) window.showToast('Could not upload these files. Check available storage and try again.');
            render();
        }
    }

    /* ---------------- drag & drop ---------------- */

    var dropHighlightEl = null;
    var internalDrag = null;

    function dragHasType(dataTransfer, type) {
        if (!dataTransfer || !dataTransfer.types) return false;
        var types = dataTransfer.types;
        for (var i = 0; i < types.length; i++) { if (types[i] === type) return true; }
        return false;
    }

    function isExternalDrag(dataTransfer) {
        if (!dataTransfer) return false;
        if (dragHasType(dataTransfer, 'Files')) return true;
        return !!(dataTransfer.files && dataTransfer.files.length > 0);
    }

    function readDriveDragPayload(dataTransfer) {
        if (!dataTransfer) return null;
        try {
            var raw = dataTransfer.getData('application/x-emerald-drive');
            if (!raw) return null;
            var payload = JSON.parse(raw);
            return payload && payload.id ? payload : null;
        } catch (_) { return null; }
    }

    function clearDropHighlight() {
        if (!dropHighlightEl) return;
        dropHighlightEl.classList.remove('is-drop-target', 'is-drop-active');
        dropHighlightEl = null;
    }

    function setDropHighlight(element) {
        if (dropHighlightEl === element) return;
        clearDropHighlight();
        dropHighlightEl = element;
        if (element) element.classList.add(element.id === 'driveContent' ? 'is-drop-active' : 'is-drop-target');
    }

    function dropZoneElement(event) {
        var target = event.target;
        if (!target || !target.closest) return null;
        return target.closest('[data-folder],[data-crumb]');
    }

    function dropTargetFolderId(event) {
        var zone = dropZoneElement(event);
        if (!zone) return state.view === 'mydrive' ? state.folderId : null;
        if (zone.hasAttribute('data-crumb')) {
            var crumb = zone.getAttribute('data-crumb');
            return crumb === 'root' ? null : crumb;
        }
        var folder = folders.find(function (f) { return String(f.id) === zone.getAttribute('data-folder') && !f.trashed; });
        return folder ? folder.id : null;
    }

    function readDroppedEntry(entry, path) {
        return new Promise(function (resolve) {
            if (!entry) { resolve([]); return; }
            if (entry.isFile) {
                entry.file(function (file) { resolve([{ file: file, relativePath: path + file.name }]); }, function () { resolve([]); });
                return;
            }
            if (entry.isDirectory) {
                var reader = entry.createReader();
                var children = [];
                var readBatch = function () {
                    reader.readEntries(function (batch) {
                        if (!batch.length) {
                            Promise.all(children.map(function (child) { return readDroppedEntry(child, path + entry.name + '/'); })).then(function (groups) {
                                resolve(groups.reduce(function (all, group) { return all.concat(group); }, []));
                            });
                            return;
                        }
                        children = children.concat(Array.prototype.slice.call(batch));
                        readBatch();
                    }, function () { resolve([]); });
                };
                readBatch();
                return;
            }
            resolve([]);
        });
    }

    function droppedFileFallback(dataTransfer) {
        return Array.prototype.slice.call(dataTransfer && dataTransfer.files || []).map(function (file) {
            return { file: file, relativePath: file.webkitRelativePath || '' };
        });
    }

    function readDroppedFiles(dataTransfer) {
        var items = dataTransfer && dataTransfer.items;
        if (!items || !items.length) return Promise.resolve(droppedFileFallback(dataTransfer));
        var entries = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || item.kind !== 'file') continue;
            var entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
            if (entry) { entries.push(entry); continue; }
            var file = item.getAsFile && item.getAsFile();
            if (file) entries.push({ isFile: true, isDirectory: false, name: file.name, file: (function (captured) { return function (cb) { cb(captured); }; })(file) });
        }
        if (!entries.length) return Promise.resolve(droppedFileFallback(dataTransfer));
        return Promise.all(entries.map(function (entry) { return readDroppedEntry(entry, ''); })).then(function (groups) {
            return groups.reduce(function (all, group) { return all.concat(group); }, []);
        });
    }

    function bindDragAndDrop() {
        var overlay = document.createElement('div');
        overlay.className = 'drive-drop-overlay';
        document.body.appendChild(overlay);
        function showOverlay(active) { overlay.classList.toggle('is-active', !!active); }

        document.addEventListener('dragstart', function (event) {
            var card = event.target && event.target.closest ? event.target.closest('[data-file],[data-folder]') : null;
            if (!card) return;
            clearDriveSelection();
            var isFolder = card.hasAttribute('data-folder');
            var id = isFolder ? card.getAttribute('data-folder') : card.getAttribute('data-file');
            var item = isFolder
                ? folders.find(function (f) { return String(f.id) === String(id); })
                : files.find(function (f) { return String(f.id) === String(id); });
            if (!item || item.trashed || (isFolder && isSuiteFolder(item))) { event.preventDefault(); return; }
            selectedDriveItem = item;
            internalDrag = { kind: isFolder ? 'folder' : 'file', id: String(item.id) };
            try {
                event.dataTransfer.setData('application/x-emerald-drive', JSON.stringify(internalDrag));
                event.dataTransfer.setData('text/plain', item.name || '');
                event.dataTransfer.effectAllowed = 'move';
            } catch (_) {}
            card.classList.add('is-dragging');
        });

        document.addEventListener('dragend', function (event) {
            var card = event.target && event.target.closest ? event.target.closest('.is-dragging') : null;
            if (card) card.classList.remove('is-dragging');
            internalDrag = null;
            clearDropHighlight();
            showOverlay(false);
        });

        document.addEventListener('dragover', function (event) {
            var external = isExternalDrag(event.dataTransfer);
            var internal = !external && (!!internalDrag || dragHasType(event.dataTransfer, 'application/x-emerald-drive'));
            if (!internal && !external) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = internal ? 'move' : 'copy';
            var zone = dropZoneElement(event);
            if (external) {
                showOverlay(true);
                if (zone) setDropHighlight(zone); else setDropHighlight(null);
            } else {
                showOverlay(false);
                if (zone) setDropHighlight(zone); else setDropHighlight(null);
            }
        });

        document.addEventListener('dragleave', function (event) {
            if (event.relatedTarget) return;
            showOverlay(false);
            clearDropHighlight();
        });

        document.addEventListener('drop', async function (event) {
            var external = isExternalDrag(event.dataTransfer);
            var internal = external ? null : (readDriveDragPayload(event.dataTransfer) || internalDrag);
            internalDrag = null;
            if (!internal && !external) return;
            event.preventDefault();
            showOverlay(false);
            var zone = dropZoneElement(event);
            var targetFolderId = dropTargetFolderId(event);
            clearDropHighlight();

            if (internal) {
                if (state.view !== 'mydrive') {
                    if (window.showToast) window.showToast('Open My Drive to move items between folders.');
                    return;
                }
                var isFolder = internal.kind === 'folder';
                var item = isFolder
                    ? folders.find(function (f) { return String(f.id) === String(internal.id); })
                    : files.find(function (f) { return String(f.id) === String(internal.id); });
                if (!item || item.trashed) return;
                if (!zone) {
                    if (window.showToast) window.showToast('Drop onto a folder to move this item.');
                    return;
                }
                var currentParent = isFolder ? item.parent : item.folder;
                if (String(currentParent || '') === String(targetFolderId || '')) return;
                driveClipboard = { itemId: String(item.id), driveKey: item.driveKey || null, isFolder: isFolder, mode: 'move' };
                await pasteDriveClipboard(targetFolderId || null);
                return;
            }

            var dropped = await readDroppedFiles(event.dataTransfer);
            if (!dropped.length) return;
            var dropParent = zone ? targetFolderId : (state.view === 'mydrive' ? state.folderId : null);
            await importFiles(dropped, dropParent);
        });
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
    async function newFolder() {
        var result = await showDriveModal({ title: 'Create a folder', message: 'Choose a name for your new folder.', input: { value: 'New folder', label: 'Folder name' }, primaryLabel: 'Create folder' });
        if (!result.confirmed) return;
        var name = String(result.value || '').trim();
        if (!name) { if (window.showToast) window.showToast('Folder name cannot be empty'); return; }
        var parent = state.view === 'mydrive' ? state.folderId : null;
        if (folders.some(function (f) { return f.parent === parent && f.name.toLowerCase() === name.toLowerCase() && !f.trashed; })) { if (window.showToast) window.showToast('A folder with that name already exists here'); return; }
        folders.push({ id: 'folder_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: name, parent: parent });
        await saveDriveData();
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
        var skeletonStartedAt = Date.now();
        showSkeleton();
        bindContextMenu();
        bindDriveModal();
        bindDriveClipboard();
        if (window.EmeraldAuth && window.EmeraldAuth.ready) await window.EmeraldAuth.ready();
        initTheme();
        bindProfile();
        renderAccountProfile();
        bindToolbar();
        bindCreateUploadMenu();
        bindSidebarNav();
        bindDragAndDrop();
        bindMarqueeSelection();
        try { await loadDriveData(); } catch (error) { console.warn('[Drive] Could not load synced files', error); loading = false; }
        var skeletonRemaining = 520 - (Date.now() - skeletonStartedAt);
        if (skeletonRemaining > 0) await new Promise(function (resolve) { setTimeout(resolve, skeletonRemaining); });
        render();
        var sharedFileId = new URLSearchParams(location.search).get('file');
        if (sharedFileId) {
            var sharedFile = files.find(function (file) { return String(file.id) === sharedFileId && !file.trashed; });
            if (sharedFile) openDriveFile(sharedFile);
        }
        var sharedFolderId = new URLSearchParams(location.search).get('folder');
        if (sharedFolderId) {
            var sharedFolder = folders.find(function (folder) { return String(folder.id) === sharedFolderId && !folder.trashed; });
            if (sharedFolder) {
                state.view = 'mydrive';
                state.folderId = sharedFolder.id;
                setActiveNav('mydrive');
                render();
            }
        }
        updateDriveStorage();
        if (window.EmeraldAuth && window.EmeraldAuth.requestSync) window.EmeraldAuth.requestSync();
        window.addEventListener('emerald-sync-state', function (event) {
            var detail = event && event.detail;
            if (detail && detail.state === 'syncing' && syncStuckAt === null) syncStuckAt = Date.now();
            else if (detail && detail.state && detail.state !== 'syncing') syncStuckAt = null;
            updateDriveStorage();
        });
        window.addEventListener('emerald-sync-complete', async function () {
            try { await loadDriveData(); render(); updateDriveStorage(); } catch (_) {}
        });
        var store = storage();
        if (store && store.subscribe) store.subscribe(function (change) {
            if (change && [FOLDERS_KEY, FILES_KEY, TRASH_KEY, FLAGS_KEY, 'emeraldcore.storage.suite.docs', 'emeraldcore.storage.suite.notes', 'emeraldcore.storage.suite.slides'].indexOf(change.key) !== -1) {
                loadDriveData().then(function () { render(); updateDriveStorage(); }).catch(function () {});
            }
        });
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
