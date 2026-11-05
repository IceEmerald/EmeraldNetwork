(function () {
    const DB_NAME = 'emeraldcore.storage.suite';
    const DB_VERSION = 2;
    const STORE_NAME = 'kv';
    const SYNC_META_KEY = '__emerald_sync_meta_v1__';
    const GLOBAL_KEYS = new Set([
        'emerald.auth.session',
        'emerald.auth.return_url'
    ]);
    const cache = new Map();
    const subscribers = new Set();
    const localSubscribers = new Set();
    const tabRandom = new Uint8Array(16);
    let hasSecureTabId = false;
    try {
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(tabRandom);
            hasSecureTabId = true;
        }
    } catch (_) {}
    const tabId = hasSecureTabId
        ? Array.from(tabRandom, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('')
        : 'tab-' + Date.now().toString(36) + '-' + Math.floor(typeof performance !== 'undefined' ? performance.now() : 0).toString(36);
    const channel = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('emeraldcore.storage.suite')
        : null;
    let db = null;
    let ready = false;

    function canUseIndexedDB() {
        return typeof indexedDB !== 'undefined';
    }

    function normalizeAccountScope(value) {
        if (!value) return 'guest';
        var raw = String(value).trim().toLowerCase();
        var safe = raw.replace(/[^a-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '');
        return safe || 'guest';
    }

    function readCurrentSession() {
        var raw = cache.get('emerald.auth.session');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    function shouldScopeKey(key) {
        if (typeof key !== 'string') return true;
        return !GLOBAL_KEYS.has(key);
    }

    function getAccountScope(explicitScope) {
        if (explicitScope) return normalizeAccountScope(explicitScope);

        var session = readCurrentSession();
        if (session && session.user && session.user.email) return normalizeAccountScope(session.user.email);
        if (session && session.email) return normalizeAccountScope(session.email);
        if (session && session.user && session.user.id) return normalizeAccountScope(session.user.id);

        return 'guest';
    }

    function qualifyKey(key, explicitScope) {
        if (!shouldScopeKey(key)) return String(key);
        var scope = getAccountScope(explicitScope);
        return 'acct:' + scope + ':' + String(key);
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!canUseIndexedDB()) {
                resolve(null);
                return;
            }

            var request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function () {
                var database = request.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
            request.onblocked = function () { console.warn('IndexedDB upgrade blocked for EmeraldCore storage.'); };
        });
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
    }

    async function loadCache() {
        if (!db) return;
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var all = await requestToPromise(store.getAll());
        all.forEach(function (entry) {
            if (entry && typeof entry.key === 'string') cache.set(entry.key, entry.value);
        });
    }

    async function refreshKey(key) {
        await readyPromise;
        if (!db) return;
        var tx = db.transaction(STORE_NAME, 'readonly');
        var entry = await requestToPromise(tx.objectStore(STORE_NAME).get(key));
        if (entry && typeof entry.key === 'string') {
            cache.set(entry.key, entry.value);
        } else {
            cache.delete(key);
        }
    }

    function notify(change) {
        var publicChange = Object.assign({}, change);
        if (typeof publicChange.key === 'string') {
            var scopedKey = publicChange.key.match(/^acct:[^:]+:(.*)$/);
            if (scopedKey) {
                publicChange.storageKey = publicChange.key;
                publicChange.key = scopedKey[1];
            }
        }
        subscribers.forEach(function (callback) {
            try { callback(publicChange); } catch (error) { console.warn('Storage subscriber failed:', error); }
        });
    }

    function notifyLocal(change) {
        localSubscribers.forEach(function (callback) {
            try { callback(change); } catch (error) { console.warn('Local storage subscriber failed:', error); }
        });
    }

    function broadcast(change) {
        var message = Object.assign({}, change, { source: tabId, at: Date.now() });
        if (channel) channel.postMessage(message);
    }

    function readLocalRaw(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function removeLocalRaw(key) {
        try { localStorage.removeItem(key); } catch (_) {}
    }

    function putRaw(key, value) {
        cache.set(key, value);
        if (!db) return Promise.resolve();
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ key: key, value: value, updatedAt: Date.now() });
        return new Promise(function (resolve, reject) {
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error); };
        });
    }

    function readSyncMeta(scope) {
        var metaKey = qualifyKey(SYNC_META_KEY, scope);
        var raw = readCache(metaKey) || readLocalRaw(metaKey);
        if (!raw) return { updated: {}, deleted: {} };
        try {
            var meta = JSON.parse(raw);
            return {
                updated: meta && meta.updated && typeof meta.updated === 'object' ? meta.updated : {},
                deleted: meta && meta.deleted && typeof meta.deleted === 'object' ? meta.deleted : {}
            };
        } catch (_) {
            return { updated: {}, deleted: {} };
        }
    }

    function serializeSyncMeta(meta) {
        function sortMap(value) {
            var result = {};
            Object.keys(value || {}).sort().forEach(function (key) { result[key] = value[key]; });
            return result;
        }
        return JSON.stringify({ updated: sortMap(meta.updated), deleted: sortMap(meta.deleted) });
    }

    async function writeSyncMeta(meta, scope) {
        var metaKey = qualifyKey(SYNC_META_KEY, scope);
        var raw = serializeSyncMeta(meta);
        var currentRaw = readCache(metaKey) || readLocalRaw(metaKey);
        if (currentRaw) {
            try {
                var current = JSON.parse(currentRaw);
                if (serializeSyncMeta(current) === raw) return;
            } catch (_) {}
        }
        cache.set(metaKey, raw);
        await readyPromise;
        if (db) await putRaw(metaKey, raw);
    }

    async function markSyncMeta(key, scope, deleted, timestamp) {
        if (!shouldScopeKey(key) || key === SYNC_META_KEY) return;
        var meta = readSyncMeta(scope);
        timestamp = Math.max(Number(timestamp) || Date.now(),
            Math.max(Number(meta.updated[key]) || 0, Number(meta.deleted[key]) || 0) + 1);
        if (deleted) {
            delete meta.updated[key];
            meta.deleted[key] = timestamp;
        } else {
            delete meta.deleted[key];
            meta.updated[key] = timestamp;
        }
        await writeSyncMeta(meta, scope);
    }

    function markSyncMetaSync(key, scope, deleted, timestamp) {
        if (!shouldScopeKey(key) || key === SYNC_META_KEY) return;
        var meta = readSyncMeta(scope);
        timestamp = Math.max(Number(timestamp) || Date.now(),
            Math.max(Number(meta.updated[key]) || 0, Number(meta.deleted[key]) || 0) + 1);
        if (deleted) {
            delete meta.updated[key];
            meta.deleted[key] = timestamp;
        } else {
            delete meta.deleted[key];
            meta.updated[key] = timestamp;
        }
        var metaKey = qualifyKey(SYNC_META_KEY, scope);
        var raw = serializeSyncMeta(meta);
        cache.set(metaKey, raw);
        readyPromise.then(function () {
            if (db) return putRaw(metaKey, raw);
        }).catch(function (error) {
            console.warn('Failed to save sync metadata:', error);
        });
    }

    function deleteRaw(key, explicitScope, options = {}) {
        var scope = explicitScope || getAccountScope();
        var qualifiedKey = qualifyKey(key, explicitScope);
        cache.delete(qualifiedKey);
        removeLocalRaw(qualifiedKey);
        if (!options.preserveSyncMeta) markSyncMetaSync(String(key), scope, true, Date.now());
        if (!db) {
            var localChange = { key: qualifiedKey, type: options.type || 'delete' };
            broadcast(localChange);
            notifyLocal(localChange);
            return Promise.resolve();
        }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(qualifiedKey);
        return new Promise(function (resolve, reject) {
            tx.oncomplete = function () {
                var change = { key: qualifiedKey, type: options.type || 'delete' };
                broadcast(change);
                notifyLocal(change);
                resolve();
            };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error); };
        });
    }

    const readyPromise = openDatabase()
        .then(function (database) {
            db = database;
            return loadCache();
        })
        .catch(function (error) {
            console.warn('IndexedDB unavailable. Account data will not persist after this page closes.', error);
            db = null;
        })
        .finally(function () { ready = true; });

    function readCache(key) {
        return cache.get(key) || null;
    }

    async function hydrateKey(key, explicitScope) {
        var qualifiedKey = qualifyKey(key, explicitScope);
        var raw = readLocalRaw(qualifiedKey);
        if (raw == null && shouldScopeKey(key)) {
            raw = readLocalRaw(key);
        }
        if (raw == null) return;
        if (!db) {
            cache.set(qualifiedKey, raw);
            return;
        }
        try {
            await putRaw(qualifiedKey, raw);
        } catch (error) {
            return;
        }
        if (cache.get(qualifiedKey) === raw) removeLocalRaw(qualifiedKey);
        if (shouldScopeKey(key)) removeLocalRaw(key);
    }

    async function getJSON(key, explicitScope, options = {}) {
        await readyPromise;
        var qualifiedKey = qualifyKey(key, explicitScope);
        var allowLegacy = options.allowLegacy !== false;
        if (readLocalRaw(qualifiedKey) != null || readCache(qualifiedKey) != null) {
            await hydrateKey(key, explicitScope);
        } else if (allowLegacy && shouldScopeKey(key) && (readLocalRaw(key) != null || readCache(key) != null)) {
            await hydrateKey(key, explicitScope);
        }
        var raw = readCache(qualifiedKey) || readLocalRaw(qualifiedKey);
        if (!raw && allowLegacy && shouldScopeKey(key)) {
            raw = readCache(key) || readLocalRaw(key);
        }
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    async function setJSON(key, value, options = {}) {
        var scope = options.scope || getAccountScope(options.accountScope);
        var qualifiedKey = qualifyKey(key, scope);
        var raw = JSON.stringify(value);
        await readyPromise;
        cache.set(qualifiedKey, raw);
        if (db) {
            try { await putRaw(qualifiedKey, raw); }
            catch (error) {
                cache.delete(qualifiedKey);
                console.warn('IndexedDB write failed; data was not persisted:', qualifiedKey, error);
                throw error;
            }
        } else {
            console.warn('IndexedDB is unavailable; data is only available until this page closes:', key);
        }
        if (shouldScopeKey(key)) {
            try { localStorage.removeItem(key); } catch (_) {}
        }
        if (options.type !== 'import' && options.type !== 'meta') {
            await markSyncMeta(String(key), scope, false, Date.now());
        }
        var change = { key: qualifiedKey, type: options.type || 'set' };
        broadcast(change);
        notifyLocal(change);
    }

    function setJSONSync(key, value, options = {}) {
        var scope = options.scope || getAccountScope(options.accountScope);
        var qualifiedKey = qualifyKey(key, scope);
        var raw = JSON.stringify(value);
        cache.set(qualifiedKey, raw);
        if (options.type !== 'import' && options.type !== 'meta') {
            markSyncMetaSync(String(key), scope, false, Date.now());
        }
        notifyLocal({ key: qualifiedKey, type: 'set' });

        readyPromise.then(function () {
            var write = db ? putRaw(qualifiedKey, raw) : Promise.resolve();
            return write.then(function () {
                broadcast({ key: qualifiedKey, type: 'set' });
            });
        }).catch(function (error) {
            console.warn('Failed to write IndexedDB value:', qualifiedKey, error);
        });
    }

    function getJSONSync(key, explicitScope) {
        var qualifiedKey = qualifyKey(key, explicitScope);
        var raw = readCache(qualifiedKey) || readLocalRaw(qualifiedKey);
        if (!raw && shouldScopeKey(key)) {
            raw = readCache(key) || readLocalRaw(key);
        }
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    function migrateLocalJSON(key, explicitScope) {
        return getJSON(key, explicitScope);
    }

    async function exportAll(explicitScope) {
        await readyPromise;
        var scope = getAccountScope(explicitScope);
        var prefix = 'acct:' + scope + ':';
        var snapshot = {};

        if (db) {
            var tx = db.transaction(STORE_NAME, 'readonly');
            var entries = await requestToPromise(tx.objectStore(STORE_NAME).getAll());
            entries.forEach(function (entry) {
                if (!entry || typeof entry.key !== 'string') return;
                if (!entry.key.startsWith(prefix)) return;
                var actualKey = entry.key.slice(prefix.length);
                try {
                    snapshot[actualKey] = JSON.parse(entry.value);
                } catch (_) {
                    snapshot[actualKey] = entry.value;
                }
            });
            return snapshot;
        }

        Object.keys(localStorage).forEach(function (key) {
            if (!key.startsWith(prefix)) return;
            var actualKey = key.slice(prefix.length);
            var raw = readLocalRaw(key);
            if (raw == null) return;
            try {
                snapshot[actualKey] = JSON.parse(raw);
            } catch (_) {
                snapshot[actualKey] = raw;
            }
        });

        return snapshot;
    }

    async function importAll(snapshot, explicitScope) {
        if (!snapshot || typeof snapshot !== 'object') return;
        var scope = getAccountScope(explicitScope);
        var meta = snapshot[SYNC_META_KEY] && typeof snapshot[SYNC_META_KEY] === 'object'
            ? snapshot[SYNC_META_KEY]
            : { updated: {}, deleted: {} };
        var entries = Object.entries(snapshot);
        for (var i = 0; i < entries.length; i++) {
            var key = entries[i][0];
            var value = entries[i][1];
            if (!key || key === SYNC_META_KEY) continue;
            if (Number(meta.deleted && meta.deleted[key]) >= Number(meta.updated && meta.updated[key] || 0)) continue;
            var current = await getJSON(key, scope);
            if (JSON.stringify(current) === JSON.stringify(value)) continue;
            await setJSON(key, value, { scope: scope, type: 'import' });
            notify({ key: qualifyKey(key, scope), type: 'import', source: tabId, local: true });
        }
        for (const key of Object.keys(meta.deleted || {})) {
            var deletedAt = Number(meta.deleted[key]) || 0;
            var updatedAt = Number(meta.updated && meta.updated[key]) || 0;
            if (deletedAt >= updatedAt) {
                var currentValue = await getJSON(key, scope);
                if (currentValue !== null) {
                    await deleteRaw(key, scope, { preserveSyncMeta: true, type: 'import' });
                    notify({ key: qualifyKey(key, scope), type: 'import', source: tabId, local: true });
                }
            }
        }
        await writeSyncMeta(meta, scope);
    }

    function createJSONStore(options = {}) {
        var scope = options.scope || getAccountScope(options.accountScope);
        return {
            get: function (key) { return getJSONSync(key, scope); },
            set: function (key, value) { setJSONSync(key, value, { scope: scope }); },
            del: function (key) { return deleteRaw(key, scope).catch(function () {}); },
            exportAll: function () { return exportAll(scope); },
            importAll: function (snapshot) { return importAll(snapshot, scope); }
        };
    }

    if (channel) {
        channel.onmessage = function (event) {
            var message = event.data || {};
            if (!message.key || message.source === tabId) return;
            refreshKey(message.key).then(function () { notify(message); }).catch(function (error) {
                console.warn('Failed to refresh IndexedDB cache:', error);
            });
        };
    }

    window.EmeraldIDBStorage = {
        ready: function () { return readyPromise; },
        isReady: function () { return ready; },
        usingIndexedDB: function () { return !!db; },
        getJSON: getJSON,
        getJSONSync: getJSONSync,
        setJSON: setJSON,
        setJSONSync: setJSONSync,
        delete: deleteRaw,
        migrateLocalJSON: migrateLocalJSON,
        exportAll: exportAll,
        importAll: importAll,
        createJSONStore: createJSONStore,
        subscribe: function (callback) {
            subscribers.add(callback);
            return function () { subscribers.delete(callback); };
        },
        subscribeLocal: function (callback) {
            localSubscribers.add(callback);
            return function () { localSubscribers.delete(callback); };
        }
    };
}());
