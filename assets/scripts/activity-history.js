/* ── EmeraldNetwork activity history ──────────────────────────────────
   Account-scoped record of actions taken across the EmeraldNetwork
   suite. History lives in EmeraldIDBStorage (so the account sync engine
   can merge it across devices) with an immediate localStorage mirror for
   instant reads. Opening a page on its own is NOT recorded — only real
   actions such as creating a file, exporting, or asking the AI.

   Public API (window.EmeraldHistory):
     record(label, { kind, path, title })  add an entry
     action(label, { path, title })        shortcut for kind: 'action'
     visit()                               record the current page (opt-in)
     get(limit)                            newest-first entries
     exportAll()                           copy of entries (for export)
     clear()                               remove history everywhere
     resetLocal()                          clear this browser only (no sync)
     flush()                               push pending entries to storage
     subscribe(callback)                   notified after changes
     scope()                               current account scope
     storageKey()                          localStorage key for that scope
      seedRandom(n)                         demo samples (local test account only)
*/
(function () {
    'use strict';

    var KEY = 'emerald.activity.history.v1';
    var VERSION = 2;
    var MAX_ENTRIES = 400;
    var VISIT_DEDUPE_MS = 5 * 60 * 1000;
    var ACTION_DEDUPE_MS = 20 * 1000;
    var FLUSH_DELAY_MS = 4000;
    var listeners = [];

    var activeScope = null;
    var entries = [];
    var loaded = false;
    var dirty = false;
    var stateUpdatedAt = 0;
    var clearedAt = 0;
    var lastPersistedRaw = '';
    var lastSyncedRaw = '';
    var flushTimer = null;
    var flushPromise = null;
    var flushAgain = false;
    var storageHooked = false;

    function normalizeScope(value) {
        if (!value) return 'guest';
        var raw = String(value).trim().toLowerCase();
        var safe = raw.replace(/[^a-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '');
        return safe || 'guest';
    }

    function readSession() {
        var stores = [];
        try { stores.push(localStorage); } catch (_) {}
        try { stores.push(sessionStorage); } catch (_) {}

        for (var i = 0; i < stores.length; i++) {
            try {
                var session = JSON.parse(stores[i].getItem('emerald.auth.session') || 'null');
                if (!session) continue;
                if (session.user && (session.user.email || session.user.id)) return session;
                if (session.email) return session;
            } catch (_) {}
        }
        return null;
    }

    function currentScope() {
        var session = readSession();
        if (session) {
            if (session.user && session.user.email) return normalizeScope(session.user.email);
            if (session.email) return normalizeScope(session.email);
            if (session.user && session.user.id) return normalizeScope(session.user.id);
        }
        return 'guest';
    }

    function storageKey(scope) {
        return 'acct:' + (scope || currentScope()) + ':' + KEY;
    }

    function hashText(value) {
        var text = String(value || '');
        var hash = 2166136261;
        for (var i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function makeId(entry) {
        var stamp = (Number(entry && entry.t) || 0).toString(36);
        var seed = [entry && entry.kind, entry && entry.path, entry && entry.label, entry && entry.n].join('\u0001');
        return 'h_' + stamp + '_' + hashText(seed);
    }

    function normalizeEntry(value) {
        if (!value || typeof value !== 'object') return null;
        var t = Number(value.t) || 0;
        if (!t) return null;
        var entry = {
            id: typeof value.id === 'string' && value.id ? value.id : '',
            t: t,
            kind: String(value.kind || 'action'),
            label: String(value.label || value.title || 'Action').slice(0, 240),
            title: String(value.title || value.label || 'Action').slice(0, 240),
            path: String(value.path || '/').slice(0, 500),
            n: Math.max(1, Number(value.n) || 1)
        };
        if (!entry.id) entry.id = makeId(entry);
        return entry;
    }

    function normalizeEntries(list) {
        var seen = Object.create(null);
        var result = [];
        (Array.isArray(list) ? list : []).forEach(function (value) {
            var entry = normalizeEntry(value);
            if (!entry) return;
            var existing = seen[entry.id];
            if (!existing) {
                seen[entry.id] = entry;
                result.push(entry);
                return;
            }
            if (entry.t > existing.t || (entry.t === existing.t && entry.n > existing.n)) {
                var index = result.indexOf(existing);
                result[index] = entry;
                seen[entry.id] = entry;
            }
        });
        result.sort(function (first, second) {
            return second.t - first.t || (second.n || 1) - (first.n || 1);
        });
        return result.slice(0, MAX_ENTRIES);
    }

    function mergeEntries(first, second, watermark) {
        var cut = Number(watermark) || 0;
        var list = (first || []).concat(second || []).filter(function (entry) {
            return (Number(entry && entry.t) || 0) > cut;
        });
        return normalizeEntries(list);
    }

    function parsePayload(raw) {
        if (!raw) return null;
        try {
            var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!data || typeof data !== 'object') return null;
            var list = Array.isArray(data.entries) ? data.entries : (Array.isArray(data) ? data : null);
            if (!list) return null;
            var clearedAt = Number(data.clearedAt) || 0;
            return {
                v: VERSION,
                updatedAt: Number(data.updatedAt) || 0,
                clearedAt: clearedAt,
                entries: normalizeEntries(list.filter(function (entry) {
                    return (Number(entry && entry.t) || 0) > clearedAt;
                }))
            };
        } catch (_) {
            return null;
        }
    }

    function readStored(scope) {
        try {
            return parsePayload(localStorage.getItem(storageKey(scope)));
        } catch (_) {
            return null;
        }
    }

    function loadScope(scope, force) {
        if (!force && loaded && activeScope === scope) return;
        activeScope = scope;
        loaded = true;
        var payload = readStored(scope);
        entries = payload ? payload.entries : [];
        stateUpdatedAt = payload ? payload.updatedAt : 0;
        clearedAt = payload ? payload.clearedAt : 0;
        lastPersistedRaw = payload ? JSON.stringify(payload) : '';
        lastSyncedRaw = lastPersistedRaw;
        dirty = false;
    }

    function buildPayload() {
        var newest = entries.length ? entries[0].t : 0;
        return {
            v: VERSION,
            updatedAt: Math.max(stateUpdatedAt || 0, newest),
            clearedAt: clearedAt || 0,
            entries: entries
        };
    }

    function persistLocal() {
        var raw = JSON.stringify(buildPayload());
        lastPersistedRaw = raw;
        try { localStorage.setItem(storageKey(activeScope), raw); } catch (_) {}
        return raw;
    }

    function notify() {
        listeners.slice().forEach(function (callback) {
            try { callback(); } catch (_) {}
        });
    }

    function normalizePath(value) {
        var path = String(value || '/');
        try {
            path = new URL(path, window.location.origin).pathname;
        } catch (_) {
            path = path.split('?')[0].split('#')[0];
        }
        path = path.replace(/\/index\.html$/i, '/');
        path = path.replace(/\.html$/i, '');
        if (path.length > 1) path = path.replace(/\/+$/, '');
        return path || '/';
    }

    function cleanTitle(value) {
        var title = String(value || '')
            .replace(/^Emerald(?:Network|Suite|Studio)\s*[|·–—-]\s*/i, '')
            .replace(/\s*[|·–—-]\s*Emerald(?:Network|Suite|Studio).*$/i, '')
            .trim();
        return title;
    }

    function pageMeta() {
        var path = normalizePath(window.location.pathname);
        var title = cleanTitle(document.title);
        if (!title || /^Emerald(?:Network|Suite|Studio)$/i.test(title)) {
            if (path === '/') title = 'Home';
            else {
                var last = path.split('/').filter(Boolean).pop() || path;
                title = last.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (character) {
                    return character.toUpperCase();
                });
            }
        }
        return { path: path, title: title };
    }

    /* ── IndexedDB sync storage ─────────────────────────────────────── */

    function storageApi() {
        return window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.setJSON === 'function'
            ? window.EmeraldIDBStorage
            : null;
    }

    function applyExternalPayload(payload) {
        if (!payload) return;

        // A clear is a watermark, not a one-shot delete: entries older than
        // the newest clear (from either side) stay gone even after this
        // device records a brand-new action.
        var watermark = Math.max(clearedAt || 0, payload.clearedAt || 0);
        var merged = mergeEntries(entries, payload.entries, watermark);
        var mergedPayload = {
            v: VERSION,
            updatedAt: Math.max(stateUpdatedAt || 0, payload.updatedAt || 0, merged.length ? merged[0].t : 0),
            clearedAt: watermark,
            entries: merged
        };
        var mergedRaw = JSON.stringify(mergedPayload);
        var externalRaw = JSON.stringify(payload);
        var changed = mergedRaw !== externalRaw;

        entries = merged;
        clearedAt = watermark;
        stateUpdatedAt = mergedPayload.updatedAt;
        lastSyncedRaw = externalRaw;
        lastPersistedRaw = mergedRaw;
        if (changed) {
            try { localStorage.setItem(storageKey(activeScope), mergedRaw); } catch (_) {}
        }
        dirty = changed;
        notify();
        if (dirty) scheduleFlush();
    }

    function handleStorageChange(change) {
        if (!change || change.key !== KEY) return;

        var targetKey = typeof change.storageKey === 'string' && change.storageKey
            ? change.storageKey
            : storageKey();
        var scopeMatch = targetKey.match(/^acct:(.+):emerald\.activity\.history\.v1$/);
        if (scopeMatch && normalizeScope(scopeMatch[1]) !== activeScope) return;

        var raw = '';
        try { raw = localStorage.getItem(targetKey) || ''; } catch (_) {}
        if (!raw) {
            // Legacy hard delete: drop the in-memory list so it cannot be
            // written back. New clears use the clearedAt watermark instead.
            if (!entries.length && !lastPersistedRaw) return;
            entries = [];
            stateUpdatedAt = 0;
            clearedAt = Math.max(clearedAt || 0, Date.now());
            lastPersistedRaw = '';
            lastSyncedRaw = '';
            dirty = false;
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            notify();
            return;
        }
        if (raw === lastPersistedRaw) return;
        var payload = parsePayload(raw);
        if (!payload) return;
        applyExternalPayload(payload);
    }

    function ensureStorageHooks() {
        var storage = storageApi();
        if (storageHooked || !storage) return;
        storageHooked = true;

        if (typeof storage.subscribe === 'function') {
            storage.subscribe(handleStorageChange);
        }
        if (typeof storage.subscribeLocal === 'function') {
            storage.subscribeLocal(handleStorageChange);
        }

        if (typeof storage.getJSON === 'function') {
            storage.getJSON(KEY).then(function (value) {
                var payload = parsePayload(value);
                if (!payload) return;
                applyExternalPayload(payload);
            }).catch(function () {});
        }
    }

    function scheduleFlush(delay) {
        ensureStorageHooks();
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(function () {
            flushTimer = null;
            flushNow();
        }, delay == null ? FLUSH_DELAY_MS : delay);
    }

    function flushNow(force) {
        ensureStorageHooks();

        var storage = storageApi();
        if (!storage) return Promise.resolve(false);
        if (!dirty && !force) return Promise.resolve(false);
        if (flushPromise) {
            flushAgain = true;
            return flushPromise;
        }

        var scope = activeScope || currentScope();
        var payload = buildPayload();
        var raw = JSON.stringify(payload);
        if (raw === lastSyncedRaw) {
            dirty = false;
            return Promise.resolve(false);
        }

        lastPersistedRaw = raw;
        try { localStorage.setItem(storageKey(scope), raw); } catch (_) {}

        flushPromise = Promise.resolve(storage.setJSON(KEY, payload, { scope: scope })).then(function () {
            var currentRaw = '';
            try { currentRaw = localStorage.getItem(storageKey(scope)) || ''; } catch (_) {}
            if (currentRaw === raw) {
                lastSyncedRaw = raw;
                dirty = false;
            } else {
                dirty = true;
            }
            return true;
        }).catch(function (error) {
            console.warn('Failed to sync activity history:', error);
            return false;
        }).finally(function () {
            flushPromise = null;
            if (flushAgain || dirty) {
                flushAgain = false;
                scheduleFlush(0);
            }
        });

        return flushPromise;
    }

    function flush() {
        return flushNow(true);
    }

    /* ── Recording ─────────────────────────────────────────────────── */

    function addEntry(kind, label, options) {
        options = options || {};
        var scope = currentScope();
        loadScope(scope);

        var meta = pageMeta();
        var now = Date.now();
        // Never timestamp a new action at or before the clear watermark or
        // the watermark would immediately filter it out again.
        if (now <= clearedAt) now = clearedAt + 1;
        var path = normalizePath(options.path || meta.path);
        var title = options.title ? cleanTitle(options.title) || meta.title : meta.title;
        var text = String(label || title || 'Action').slice(0, 240);
        var entryKind = kind || 'action';

        var last = entries[0];
        var dedupeMs = entryKind === 'visit'
            ? VISIT_DEDUPE_MS
            : (entryKind === 'action' ? ACTION_DEDUPE_MS : 0);

        if (dedupeMs && last && last.kind === entryKind &&
            last.path === path && last.label === text && (now - last.t) < dedupeMs) {
            entries[0] = Object.assign({}, last, {
                t: now,
                title: title,
                n: (last.n || 1) + 1
            });
        } else {
            entries.unshift({
                id: makeId({ t: now, kind: entryKind, path: path, label: text, n: 1 }),
                t: now,
                kind: entryKind,
                label: text,
                title: title,
                path: path,
                n: 1
            });
        }

        if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
        stateUpdatedAt = now;
        dirty = true;
        persistLocal();
        notify();
        scheduleFlush();
    }

    function record(label, options) {
        options = options || {};
        addEntry(options.kind || 'action', label, options);
    }

    function action(label, options) {
        options = options || {};
        addEntry('action', label, options);
    }

    function visit() {
        var meta = pageMeta();
        addEntry('visit', meta.title, meta);
    }

    function getEntries(limit) {
        loadScope(currentScope());
        var list = entries.slice();
        if (limit && limit > 0 && list.length > limit) list = list.slice(0, limit);
        return list.map(function (entry) {
            return {
                id: entry.id,
                t: entry.t,
                kind: entry.kind || 'action',
                label: entry.label || entry.title || 'Action',
                title: entry.title || entry.label || 'Action',
                path: entry.path || '/',
                n: entry.n || 1
            };
        });
    }

    function exportAll() {
        return getEntries();
    }

    function clear() {
        var scope = currentScope();
        loadScope(scope);

        var newest = entries.length ? entries[0].t : 0;
        var now = Math.max(Date.now(), Number(stateUpdatedAt) + 1, Number(newest) + 1);
        entries = [];
        clearedAt = now;
        stateUpdatedAt = now;
        dirty = true;

        // Store an empty payload carrying the clear watermark. It survives
        // new actions and lets every device drop only entries older than the
        // clear, instead of wiping history recorded afterwards.
        persistLocal();
        notify();

        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushNow(true);
    }

    // Wipe this browser's copy without creating a clear watermark, so the
    // account-wide history (and other devices) stay untouched. Used by the
    // "Delete data on this device" flow.
    function resetLocal() {
        var scope = currentScope();
        activeScope = scope;
        loaded = true;
        entries = [];
        stateUpdatedAt = 0;
        clearedAt = 0;
        dirty = false;
        lastPersistedRaw = '';
        lastSyncedRaw = '';

        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        try { localStorage.removeItem(storageKey(scope)); } catch (_) {}
        notify();
    }

    function subscribe(callback) {
        if (typeof callback !== 'function') return function () {};
        listeners.push(callback);
        return function () {
            var index = listeners.indexOf(callback);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    /* ── Demo seeding for the local test account ───────────────────── */

    var TEST_SCOPES = ['test@local', 'google@local'];
    var SEED_FLAG_KEY = 'emerald.test.history.seeded.v1';

    var SAMPLE_ACTIONS = [
        { path: '/docs',      label: 'Created document \u201CGarden project plan\u201D' },
        { path: '/docs',      label: 'Saved document \u201CGarden project plan\u201D' },
        { path: '/docs',      label: 'Exported document \u201CBudget overview\u201D as PDF' },
        { path: '/docs',      label: 'Opened document \u201CBudget overview\u201D' },
        { path: '/sheets',    label: 'Created spreadsheet' },
        { path: '/sheets',    label: 'Exported spreadsheet as XLSX' },
        { path: '/slides',    label: 'Created presentation \u201CQ3 review\u201D' },
        { path: '/slides',    label: 'Exported presentation as PPTX' },
        { path: '/slides',    label: 'Exported presentation as PDF' },
        { path: '/notes',     label: 'Created note' },
        { path: '/notes',     label: 'Exported note \u201CGift ideas\u201D as a link' },
        { path: '/notes',     label: 'Deleted note \u201CTo-do list\u201D' },
        { path: '/flowchart', label: 'Exported flowchart as .emeraldcore' },
        { path: '/flowchart', label: 'Imported a flowchart' },
        { path: '/aichat',    label: 'Asked AI: \u201CHow do I propagate basil?\u201D' },
        { path: '/aichat',    label: 'Deleted AI chat \u201CStyle ideas\u201D' },
        { path: '/wiki',      label: 'Searched wiki for \u201Ccompanion planting\u201D' },
        { path: '/account',   label: 'Updated personal info' },
        { path: '/account',   label: 'Updated profile photo' },
        { path: '/account',   label: 'Exported account data as .emeraldcore' }
    ];

    function isTestScope(scope) {
        return TEST_SCOPES.indexOf(normalizeScope(scope)) !== -1;
    }

    // Backdated sample activity for the local test account, so the history
    // card has something to show on a first sign-in. Entries spread over
    // the last two weeks; each gets a distinct timestamp so IDs stay unique.
    function seedRandom(count) {
        var scope = currentScope();
        loadScope(scope);
        if (!isTestScope(scope)) return 0;
        count = Math.max(1, Math.min(Number(count) || 20, SAMPLE_ACTIONS.length * 3));

        var now = Date.now();
        var fresh = [];
        for (var i = 0; i < count; i++) {
            var sample = SAMPLE_ACTIONS[i % SAMPLE_ACTIONS.length];
            var t = now - 1000 * 60 * 60 * (4 + i * 16) - i * 1000;
            fresh.push({
                id: '',
                t: t,
                kind: 'action',
                label: sample.label,
                title: sample.label,
                path: sample.path,
                n: 1
            });
        }

        var watermark = clearedAt || 0;
        entries = mergeEntries(entries, fresh, watermark);
        var newest = entries.length ? entries[0].t : 0;
        stateUpdatedAt = Math.max(stateUpdatedAt || 0, newest);
        dirty = true;
        persistLocal();
        notify();

        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushNow(true);
        return entries.length;
    }

    // Auto-seed once per browser. The sticky flag means a later clear stays
    // cleared: after the flag exists the samples are never written again,
    // even if the list is empty. resetLocal keeps the flag as well.
    function maybeAutoSeed() {
        var scope = activeScope || currentScope();
        if (!isTestScope(scope)) return;
        var flag = '';
        try { flag = localStorage.getItem(SEED_FLAG_KEY) || ''; } catch (_) {}
        if (flag === '1') return;
        if (entries.length || clearedAt) return;
        try { localStorage.setItem(SEED_FLAG_KEY, '1'); } catch (_) {}
        seedRandom(20);
    }

    function refreshScope() {
        var scope = currentScope();
        if (scope !== activeScope) {
            loadScope(scope, true);
            maybeAutoSeed();
            notify();
        }
    }

    window.EmeraldHistory = {
        record: record,
        action: action,
        visit: visit,
        get: getEntries,
        exportAll: exportAll,
        clear: clear,
        resetLocal: resetLocal,
        flush: flush,
        subscribe: subscribe,
        seedRandom: seedRandom,
        refresh: refreshScope,
        scope: currentScope,
        storageKey: storageKey
    };

    loadScope(currentScope());
    maybeAutoSeed();
    ensureStorageHooks();
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('emerald-auth-changed', refreshScope);
        window.addEventListener('pagehide', function () { flushNow(); });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') flushNow();
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureStorageHooks, { once: true });
    } else {
        setTimeout(ensureStorageHooks, 0);
    }
})();
