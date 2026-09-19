(function () {
    const DB_NAME = 'emeraldcore.storage.suite';
    const DB_VERSION = 2;
    const KV_STORE = 'kv';
    const BLOB_STORE = 'blobs';
    const META_STORE = 'meta';
    const LARGE_THRESHOLD = 512 * 1024;
    const MAX_INLINE = 1024 * 1024;

    const cache = new Map();
    const subscribers = new Set();
    const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const channel = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('emeraldcore.storage.suite')
        : null;
    let db = null;
    let ready = false;

    function canUseIndexedDB() {
        return typeof indexedDB !== 'undefined';
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!canUseIndexedDB()) {
                resolve(null);
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const database = request.result;
                if (!database.objectStoreNames.contains(KV_STORE)) {
                    database.createObjectStore(KV_STORE, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(BLOB_STORE)) {
                    database.createObjectStore(BLOB_STORE, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(META_STORE)) {
                    const metaStore = database.createObjectStore(META_STORE, { keyPath: 'key' });
                    metaStore.createIndex('bySize', 'size');
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => console.warn('IndexedDB upgrade blocked for EmeraldCore storage.');
        });
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function putRaw(key, value, options = {}) {
        if (!db) return;
        const isLarge = typeof value === 'string' && value.length > LARGE_THRESHOLD;
        const storeName = isLarge ? BLOB_STORE : KV_STORE;
        const tx = db.transaction(storeName, 'readwrite');
        const record = { key, value, updatedAt: Date.now(), size: value.length };
        if (options.meta) record.meta = options.meta;
        tx.objectStore(storeName).put(record);
        if (isLarge && db.objectStoreNames.contains(META_STORE)) {
            tx.objectStore(META_STORE).put({ key, size: value.length, updatedAt: Date.now() });
        }
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    async function getRaw(key) {
        if (!db) return cache.get(key) || null;
        const tx = db.transaction([KV_STORE, BLOB_STORE], 'readonly');
        const [kvResult, blobResult] = await Promise.all([
            requestToPromise(tx.objectStore(KV_STORE).get(key)),
            requestToPromise(tx.objectStore(BLOB_STORE).get(key)),
        ]);
        const entry = kvResult || blobResult;
        return entry?.value ?? null;
    }

    async function deleteRaw(key) {
        cache.delete(key);
        if (!db) return;
        const tx = db.transaction([KV_STORE, BLOB_STORE, META_STORE], 'readwrite');
        tx.objectStore(KV_STORE).delete(key);
        tx.objectStore(BLOB_STORE).delete(key);
        if (db.objectStoreNames.contains(META_STORE)) {
            tx.objectStore(META_STORE).delete(key);
        }
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => {
                broadcast({ key, type: 'delete' });
                resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    function notify(change) {
        subscribers.forEach((callback) => {
            try { callback(change); } catch (error) { console.warn('Storage subscriber failed:', error); }
        });
    }

    function broadcast(change) {
        if (!channel) return;
        const message = { ...change, source: tabId, at: Date.now() };
        channel.postMessage(message);
    }

    function readLocalRaw(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function removeLocalRaw(key) {
        try { localStorage.removeItem(key); } catch {}
    }

    const readyPromise = openDatabase()
        .then((database) => {
            db = database;
        })
        .catch((error) => {
            console.warn('IndexedDB unavailable. Falling back to memory-only storage.', error);
            db = null;
        })
        .finally(() => { ready = true; });

    function readCache(key) {
        return cache.get(key) ?? null;
    }

    async function hydrateKey(key) {
        const raw = readLocalRaw(key);
        if (raw == null) return;
        if (!db) {
            if (raw.length <= MAX_INLINE) cache.set(key, raw);
            return;
        }
        try { await putRaw(key, raw); } catch { return; }
        if (cache.get(key) === raw) removeLocalRaw(key);
    }

    async function getJSON(key) {
        await readyPromise;
        const localRaw = readLocalRaw(key);
        if (localRaw != null) await hydrateKey(key);
        const raw = readCache(key) || await getRaw(key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }

    async function setJSON(key, value, options = {}) {
        const raw = JSON.stringify(value);
        await readyPromise;
        if (raw.length <= MAX_INLINE) cache.set(key, raw);
        if (raw.length <= LARGE_THRESHOLD) {
            try { localStorage.setItem(key, raw); } catch {}
        }
        if (db) {
            try { await putRaw(key, raw, options); }
            catch (error) { console.warn('IndexedDB write failed:', key, error); return; }
        }
        if (cache.get(key) === raw && raw.length <= LARGE_THRESHOLD) removeLocalRaw(key);
        broadcast({ key, type: 'set' });
    }

    function setJSONSync(key, value, options = {}) {
        const raw = JSON.stringify(value);
        if (raw.length <= MAX_INLINE) cache.set(key, raw);
        if (raw.length <= LARGE_THRESHOLD) {
            try { localStorage.setItem(key, raw); } catch {}
        }
        readyPromise.then(() => {
            if (!db) return;
            return putRaw(key, raw, options).then(() => {
                if (cache.get(key) === raw && raw.length <= LARGE_THRESHOLD) removeLocalRaw(key);
                broadcast({ key, type: 'set' });
            });
        }).catch((error) => {
            console.warn('Failed to write IndexedDB value:', key, error);
        });
    }

    function getJSONSync(key) {
        const raw = readCache(key) || (readLocalRaw(key));
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }

    async function getBlob(key) {
        await readyPromise;
        if (!db) return null;
        const tx = db.transaction(BLOB_STORE, 'readonly');
        const entry = await requestToPromise(tx.objectStore(BLOB_STORE).get(key));
        return entry?.value ?? null;
    }

    async function setBlob(key, value) {
        await readyPromise;
        if (!db) return;
        if (typeof value === 'string') value = new TextEncoder().encode(value);
        const tx = db.transaction(BLOB_STORE, 'readwrite');
        tx.objectStore(BLOB_STORE).put({ key, value, updatedAt: Date.now(), size: value.byteLength });
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    function createJSONStore(options = {}) {
        return {
            get: getJSONSync,
            set(key, value) { setJSONSync(key, value); },
            del(key) { deleteRaw(key).catch(() => {}); }
        };
    }

    if (channel) {
        channel.onmessage = (event) => {
            const message = event.data || {};
            if (!message.key || message.source === tabId) return;
            if (db) {
                getRaw(message.key).then((val) => {
                    if (val) cache.set(message.key, val);
                    notify(message);
                }).catch((error) => {
                    console.warn('Failed to refresh IndexedDB cache:', error);
                });
            } else {
                notify(message);
            }
        };
    }

    window.EmeraldIDBStorage = {
        ready: () => readyPromise,
        isReady: () => ready,
        usingIndexedDB: () => !!db,
        getJSON,
        getJSONSync,
        setJSON,
        setJSONSync,
        getBlob,
        setBlob,
        delete: deleteRaw,
        migrateLocalJSON: (key) => getJSON(key),
        createJSONStore,
        subscribe(callback) {
            subscribers.add(callback);
            return () => subscribers.delete(callback);
        }
    };
})();