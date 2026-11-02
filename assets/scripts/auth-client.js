(function () {
    'use strict';

    var STORAGE_KEYS = {
        session: 'emerald.auth.session',
        returnUrl: 'emerald.auth.return_url',
        syncMeta: '__emerald_sync_meta_v1__'
    };

    var autoSyncTimer = null;
    // Fallback polling detects edits made on another device; local edits sync from storage events below.
    var autoSyncIntervalMs = 8000;
    var storageSyncTimer = null;
    var syncInFlight = null;
    var syncRequestedAgain = false;
    var syncListenersInstalled = false;
    var initializationPromise = null;

    function requestSyncFromLocalChange() {
        if (storageSyncTimer) {
            clearTimeout(storageSyncTimer);
        }

        storageSyncTimer = setTimeout(async function () {
            try {
                var session = await getSession();
                if (!session || !session.token) return;
                await syncCurrentData();
            } catch (_) {}
        }, 250);
    }

    function startAutoSync() {
        if (autoSyncTimer) return;

        autoSyncTimer = window.setInterval(async function () {
            try {
                var session = await getSession();
                if (!session || !session.token) {
                    stopAutoSync();
                    return;
                }
                await syncCurrentData();
            } catch (_) {}
        }, autoSyncIntervalMs);

        if (!syncListenersInstalled) {
            syncListenersInstalled = true;
            document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'visible') requestSyncFromLocalChange();
            });

            if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.subscribe === 'function') {
                window.EmeraldIDBStorage.subscribe(function (change) {
                    if (change && (change.key === STORAGE_KEYS.session || change.type === 'import' || change.type === 'meta')) return;
                    requestSyncFromLocalChange();
                });
            }

            if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.subscribeLocal === 'function') {
                window.EmeraldIDBStorage.subscribeLocal(function (change) {
                    if (change && (change.key === STORAGE_KEYS.session || change.type === 'import' || change.type === 'meta')) return;
                    requestSyncFromLocalChange();
                });
            }

            window.addEventListener('storage', function (event) {
                if (!event.key || event.key === STORAGE_KEYS.session) return;
                requestSyncFromLocalChange();
            });

            window.addEventListener('online', function () {
                syncCurrentData().catch(function () {});
            });

            window.addEventListener('emerald-device-removed', function () {
                syncCurrentData().then(function () {
                    refreshDeviceListAfterRemoval();
                }).catch(function () {});
            });
        }
    }

    function refreshDeviceListAfterRemoval() {
        return ensureDevice().then(function (devices) {
            renderDevices(devices);
            setText('overviewDevices', devices.length === 1
                ? '1 device signed in'
                : devices.length + ' devices signed in');
            renderDeviceRows(devices);
        });
    }

    function stopAutoSync() {
        if (autoSyncTimer) {
            clearInterval(autoSyncTimer);
            autoSyncTimer = null;
        }
        if (storageSyncTimer) {
            clearTimeout(storageSyncTimer);
            storageSyncTimer = null;
        }
    }

    function getApiBase() {
        if (window.EMERALD_AUTH_API_BASE) return window.EMERALD_AUTH_API_BASE.replace(/\/+$/, '');
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            return 'http://localhost:8787';
        }
        return 'https://emeraldnetwork-auth.iceemerald.workers.dev';
    }

    function waitForStorage() {
        if (!window.EmeraldIDBStorage || !window.EmeraldIDBStorage.ready) return Promise.resolve();
        return window.EmeraldIDBStorage.ready();
    }

    function readStoredSession() {
        var candidates = [];
        try { candidates.push(localStorage.getItem(STORAGE_KEYS.session)); } catch (_) {}
        try { candidates.push(sessionStorage.getItem(STORAGE_KEYS.session)); } catch (_) {}

        var best = null;
        var bestUpdatedAt = -1;
        candidates.forEach(function (raw) {
            if (!raw) return;
            try {
                var candidate = JSON.parse(raw);
                if (!candidate || !candidate.user || !candidate.token) return;
                var updatedAt = Number(candidate.updatedAt) || 0;
                if (!best || updatedAt >= bestUpdatedAt) {
                    best = candidate;
                    bestUpdatedAt = updatedAt;
                }
            } catch (_) {}
        });
        return best;
    }

    function writeSessionRaw(value) {
        try { localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(value)); } catch (_) {}
        try { sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(value)); } catch (_) {}
    }

    async function getSession() {
        await waitForStorage();

        var storedSession = readStoredSession();
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.getJSONSync === 'function') {
            var idbSession = window.EmeraldIDBStorage.getJSONSync(STORAGE_KEYS.session) || null;
            if (idbSession && idbSession.user && idbSession.token) {
                var idbUpdatedAt = Number(idbSession.updatedAt) || 0;
                var storedUpdatedAt = Number(storedSession && storedSession.updatedAt) || 0;
                if (!storedSession || idbUpdatedAt > storedUpdatedAt) {
                    if (!storedSession || idbSession.user.email !== storedSession.user.email || idbSession.token !== storedSession.token) {
                        writeSessionRaw(idbSession);
                    }
                    return idbSession;
                }
                if (idbSession.user.email !== storedSession.user.email || idbSession.token !== storedSession.token) {
                    await window.EmeraldIDBStorage.setJSON(STORAGE_KEYS.session, storedSession);
                }
                return storedSession;
            }
        }

        return storedSession;
    }

    function emitSessionChanged() {
        try {
            window.dispatchEvent(new CustomEvent('emerald-auth-changed', {
                detail: { type: 'session-change' }
            }));
        } catch (_) {}
    }

    async function setSession(session) {
        await waitForStorage();

        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.setJSON === 'function') {
            await window.EmeraldIDBStorage.setJSON(STORAGE_KEYS.session, session || null);
        }

        if (session) {
            writeSessionRaw(session);
        } else {
            try { localStorage.removeItem(STORAGE_KEYS.session); } catch (_) {}
            try { sessionStorage.removeItem(STORAGE_KEYS.session); } catch (_) {}
        }

        emitSessionChanged();
    }

    async function clearSession() {
        stopAutoSync();
        await waitForStorage();

        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.delete === 'function') {
            try { await window.EmeraldIDBStorage.delete(STORAGE_KEYS.session); } catch (_) {}
        }

        try { localStorage.removeItem(STORAGE_KEYS.session); } catch (_) {}
        try { sessionStorage.removeItem(STORAGE_KEYS.session); } catch (_) {}
        try { localStorage.removeItem(STORAGE_KEYS.returnUrl); } catch (_) {}
        try { sessionStorage.removeItem(STORAGE_KEYS.returnUrl); } catch (_) {}

        try {
            if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.getJSONSync === 'function') {
                window.EmeraldIDBStorage.setJSONSync(STORAGE_KEYS.session, null);
            }
        } catch (_) {}

        emitSessionChanged();
    }

    async function fetchJson(path, options) {
        var requestOptions = options || {};
        var fetchUrl = getApiBase() + path;
        var response = await fetch(fetchUrl, {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...(requestOptions.headers || {})
            },
            ...requestOptions,
            headers: {
                'Content-Type': 'application/json',
                ...(requestOptions.headers || {})
            }
        });

        var data = null;
        var text = '';
        try {
            text = await response.text();
            data = text ? JSON.parse(text) : null;
        } catch (_) {
            data = null;
        }

        if (!response.ok) {
            var reason = data && data.error ? data.error : (data && data.message ? data.message : 'Request failed.');
            var requestError = new Error(reason);
            requestError.status = response.status;
            throw requestError;
        }

        return data;
    }

    function sanitizeRedirectTarget(value, fallback) {
        if (!value || typeof value !== 'string') return fallback;

        var trimmed = value.trim();
        if (!trimmed || trimmed === '#' || trimmed.startsWith('//')) return fallback;
        if (/^javascript:/i.test(trimmed) || /^data:/i.test(trimmed)) return fallback;

        try {
            var parsed = new URL(trimmed, window.location.origin);
            if (parsed.origin !== window.location.origin) return fallback;
            return parsed.href || fallback;
        } catch (_) {
            if (trimmed.startsWith('/')) return window.location.origin + trimmed;
            return fallback;
        }
    }

    function isAccountUrl(value) {
        if (!value) return false;
        try {
            var parsed = new URL(value, window.location.origin);
            return parsed.origin === window.location.origin && /(?:^|\/)account\.html\/?$/i.test(parsed.pathname);
        } catch (_) {
            return false;
        }
    }

    function getReturnUrl() {
        var params = new URLSearchParams(window.location.search);
        var redirect = params.get('redirect');
        if (redirect) {
            var safeRedirect = sanitizeRedirectTarget(redirect, window.location.origin + '/');
            if (safeRedirect && !isAccountUrl(safeRedirect)) return safeRedirect;
            return window.location.origin + '/';
        }

        try {
            var saved = sessionStorage.getItem(STORAGE_KEYS.returnUrl);
            var safeSaved = sanitizeRedirectTarget(saved, null);
            if (safeSaved && !isAccountUrl(safeSaved)) return safeSaved;
        } catch (_) {}

        if (window.location.pathname === '/account.html' || window.location.pathname.endsWith('/account.html')) {
            /* opened account.html directly (no ?redirect=, no saved return
               URL): after login, stay on the account dashboard itself. */
            return window.location.origin + '/account.html';
        }

        if (window.location.origin) {
            return window.location.origin + window.location.pathname + window.location.search;
        }

        return '/';
    }

    function rememberReturnUrl(url) {
        var safeUrl = sanitizeRedirectTarget(url, null);
        if (!safeUrl || isAccountUrl(safeUrl)) return;
        try {
            sessionStorage.setItem(STORAGE_KEYS.returnUrl, safeUrl);
        } catch (_) {}
    }

    function getAuthCallbackFromUrl() {
        var params = new URLSearchParams(window.location.search);
        var token = params.get('auth_session');
        var email = params.get('auth_email');
        var provider = params.get('auth_provider');

        if (!token || !email) return null;

        return {
            user: {
                email: String(email).trim().toLowerCase(),
                provider: provider || 'google'
            },
            token: token,
            updatedAt: Date.now()
        };
    }

    async function consumeAuthCallbackFromUrl() {
        var auth = getAuthCallbackFromUrl();
        if (!auth) return false;

        await setSession(auth);
        startAutoSync();
        syncCurrentData().catch(function () {});

        var savedReturnUrl = null;
        try {
            var saved = sessionStorage.getItem(STORAGE_KEYS.returnUrl);
            savedReturnUrl = sanitizeRedirectTarget(saved, null);
        } catch (_) {}

        var redirectTarget = savedReturnUrl || getReturnUrl();
        if (!redirectTarget) {
            /* nothing remembered and no ?redirect=: the OAuth callback came
               straight back to the account page — stay on the dashboard. */
            redirectTarget = window.location.origin + '/account.html';
        }

        var cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('auth_session');
        cleanUrl.searchParams.delete('auth_email');
        cleanUrl.searchParams.delete('auth_provider');

        if (window.history && window.history.replaceState) {
            window.history.replaceState({}, '', cleanUrl.toString());
        }

        window.location.assign(sanitizeRedirectTarget(redirectTarget, window.location.origin + '/'));
        return true;
    }

    async function login(email, password) {
        var result = await fetchJson('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: email, password: password, redirect: getReturnUrl() })
        });

        if (result && result.session) {
            await setSession(result.session);
            startAutoSync();
            syncCurrentData().catch(function () {});
        }

        return result;
    }

    async function register(email, password) {
        var result = await fetchJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email: email, password: password, redirect: getReturnUrl() })
        });

        if (result && result.session) {
            await setSession(result.session);
            startAutoSync();
            syncCurrentData().catch(function () {});
        }

        return result;
    }

    function mergeDeviceLists(localList, remoteList) {
        var merged = [];
        var byId = {};
        (localList || []).concat(remoteList || []).forEach(function (device) {
            if (!device || !device.id) return;
            var existing = byId[device.id];
            var candidate = existing && Number(existing.addedAt || 0) >= Number(device.addedAt || 0)
                ? existing
                : device;
            if (!existing) {
                merged.push(candidate);
                byId[device.id] = candidate;
            } else {
                var index = merged.indexOf(existing);
                merged[index] = candidate;
                byId[device.id] = candidate;
            }
        });
        return merged.map(function (device) {
            return Object.assign({}, device, { current: false });
        }).sort(function (first, second) {
            return Number(second.addedAt || 0) - Number(first.addedAt || 0);
        });
    }

    function mergeSnapshots(localSnapshot, remoteSnapshot) {
        var merged = {};
        var localMeta = localSnapshot && localSnapshot[STORAGE_KEYS.syncMeta] || {};
        var remoteMeta = remoteSnapshot && remoteSnapshot[STORAGE_KEYS.syncMeta] || {};
        var mergedMeta = { updated: {}, deleted: {} };
        var keys = new Set(Object.keys(localSnapshot || {}).filter(function (key) {
            return key !== STORAGE_KEYS.syncMeta && !shouldExcludeFromSync(key);
        }));
        Object.keys(remoteSnapshot || {}).forEach(function (key) {
            if (key !== STORAGE_KEYS.syncMeta && !shouldExcludeFromSync(key)) keys.add(key);
        });

        function updatedAt(value) {
            return Date.parse(value && value.updatedAt) || Number(value && value.updatedAt) || 0;
        }

        keys.forEach(function (key) {
            var localValue = localSnapshot && Object.prototype.hasOwnProperty.call(localSnapshot, key) ? localSnapshot[key] : null;
            var remoteValue = remoteSnapshot && Object.prototype.hasOwnProperty.call(remoteSnapshot, key) ? remoteSnapshot[key] : null;
            if (key === 'emerald.account.devices' && (Array.isArray(localValue) || Array.isArray(remoteValue))) {
                merged[key] = mergeDeviceLists(Array.isArray(localValue) ? localValue : [], Array.isArray(remoteValue) ? remoteValue : []);
                return;
            }
            var localUpdated = Math.max(Number(localMeta.updated && localMeta.updated[key]) || 0, updatedAt(localValue));
            var remoteUpdated = Math.max(Number(remoteMeta.updated && remoteMeta.updated[key]) || 0, updatedAt(remoteValue));
            var localDeleted = Number(localMeta.deleted && localMeta.deleted[key]) || 0;
            var remoteDeleted = Number(remoteMeta.deleted && remoteMeta.deleted[key]) || 0;
            var newestUpdate = Math.max(localValue == null ? 0 : localUpdated, remoteValue == null ? 0 : remoteUpdated);
            var newestDelete = Math.max(localDeleted, remoteDeleted);

            if (newestDelete >= newestUpdate && newestDelete > 0) {
                merged[key] = null;
                mergedMeta.deleted[key] = newestDelete;
                return;
            }

            if (localValue == null && remoteValue == null) return;
            // A tie means this device has no newer revision than the server.
            // Prefer the server in that case, otherwise an older value cached
            // on a reloaded device would overwrite a newer edit from another PC.
            var useLocal = remoteValue == null || (localValue != null && localUpdated > remoteUpdated);
            merged[key] = useLocal ? localValue : remoteValue;
            var winnerUpdated = useLocal ? localUpdated : remoteUpdated;
            if (winnerUpdated > 0) mergedMeta.updated[key] = winnerUpdated;
        });

        Object.keys(localMeta.deleted || {}).forEach(function (key) {
            if (mergedMeta.updated[key] == null && mergedMeta.deleted[key] == null) {
                mergedMeta.deleted[key] = Number(localMeta.deleted[key]) || 0;
            }
        });
        Object.keys(remoteMeta.deleted || {}).forEach(function (key) {
            if (mergedMeta.updated[key] == null && mergedMeta.deleted[key] == null) {
                mergedMeta.deleted[key] = Number(remoteMeta.deleted[key]) || 0;
            }
        });

        merged[STORAGE_KEYS.syncMeta] = mergedMeta;
        return merged;
    }

    function syncCurrentData() {
        if (syncInFlight) {
            syncRequestedAgain = true;
            return syncInFlight;
        }

        syncInFlight = performSync();
        return syncInFlight.finally(function () {
            syncInFlight = null;
            if (syncRequestedAgain) {
                syncRequestedAgain = false;
                requestSyncFromLocalChange();
            }
        });
    }

    function snapshotsMatch(first, second) {
        var firstKeys = Object.keys(first || {}).sort();
        var secondKeys = Object.keys(second || {}).sort();
        if (firstKeys.length !== secondKeys.length) return false;
        for (var index = 0; index < firstKeys.length; index++) {
            var key = firstKeys[index];
            if (key !== secondKeys[index] || JSON.stringify(first[key]) !== JSON.stringify(second[key])) return false;
        }
        return true;
    }

    async function performSync() {
        var session = await getSession();
        if (!session || !session.token) return null;

        var snapshot = {};
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.exportAll === 'function') {
            snapshot = await window.EmeraldIDBStorage.exportAll();
        } else {
            try {
                Object.keys(localStorage).forEach(function (key) {
                    try {
                        var raw = localStorage.getItem(key);
                        snapshot[key] = raw ? JSON.parse(raw) : raw;
                    } catch (_) {
                        snapshot[key] = localStorage.getItem(key);
                    }
                });
            } catch (_) {}
        }

        var remote;
        try {
            remote = await fetchJson('/api/auth/sync', {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer ' + session.token
                }
            });
        } catch (error) {
            if (error && (error.status === 401 || error.status === 404)) await clearSession();
            throw error;
        }

        var baseSnapshot = remote && remote.snapshot && typeof remote.snapshot === 'object' ? remote.snapshot : {};
        var mergedSnapshot = mergeSnapshots(snapshot, baseSnapshot);

        var syncResult = await fetchJson('/api/auth/sync', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + session.token
            },
            body: JSON.stringify({ snapshot: mergedSnapshot })
        });

        // Do not import the response captured before a local edit. Doing so
        // would visibly roll an in-progress edit back to its old position.
        var latestSnapshot = await exportAccountData();
        if (!snapshotsMatch(snapshot, latestSnapshot)) {
            syncRequestedAgain = true;
            return { ok: true, pendingLocalChanges: true };
        }

        var serverSnapshot = syncResult && syncResult.snapshot && typeof syncResult.snapshot === 'object'
            ? syncResult.snapshot
            : mergedSnapshot;
        if (serverSnapshot) {
            await importAccountData(serverSnapshot);
        }

        try {
            window.dispatchEvent(new CustomEvent('emerald-sync-complete', {
                detail: { snapshot: serverSnapshot || mergedSnapshot }
            }));
        } catch (_) {}

        return { ok: true, snapshot: serverSnapshot };
    }

    function shouldExcludeFromSync(key) {
        return key === 'emerald.auth.session' ||
            key === 'emerald.auth.return_url' ||
            key === 'emerald.device.id';
    }

    async function exportAccountData() {
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.exportAll === 'function') {
            var idbSnapshot = await window.EmeraldIDBStorage.exportAll();
            var filteredSnapshot = {};
            Object.keys(idbSnapshot || {}).forEach(function (key) {
                if (!shouldExcludeFromSync(key)) filteredSnapshot[key] = idbSnapshot[key];
            });
            return filteredSnapshot;
        }

        var snapshot = {};
        try {
            Object.keys(localStorage).forEach(function (key) {
                if (shouldExcludeFromSync(key)) return;
                var raw = localStorage.getItem(key);
                try {
                    snapshot[key] = raw ? JSON.parse(raw) : raw;
                } catch (_) {
                    snapshot[key] = raw;
                }
            });
        } catch (_) {}
        return snapshot;
    }

    async function importAccountData(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return false;
        var filteredSnapshot = {};
        Object.keys(snapshot).forEach(function (key) {
            if (!shouldExcludeFromSync(key)) filteredSnapshot[key] = snapshot[key];
        });
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.importAll === 'function') {
            await window.EmeraldIDBStorage.importAll(filteredSnapshot);
            return true;
        }

        Object.keys(filteredSnapshot).forEach(function (key) {
            try { localStorage.setItem(key, JSON.stringify(filteredSnapshot[key])); } catch (_) {}
        });
        return true;
    }

    function beginOAuth(provider, intent) {
        var name = String(provider || 'Google').toLowerCase();
        var returnUrl = getReturnUrl();
        rememberReturnUrl(returnUrl);
        var redirect = encodeURIComponent(returnUrl);
        var mode = String(intent || 'login').toLowerCase();
        var query = '?redirect=' + redirect + '&intent=' + encodeURIComponent(mode);
        window.location.href = getApiBase() + '/api/auth/' + name + query;
    }

    window.EmeraldAuth = {
        getApiBase: getApiBase,
        getReturnUrl: getReturnUrl,
        rememberReturnUrl: rememberReturnUrl,
        getSession: getSession,
        setSession: setSession,
        clearSession: clearSession,
        consumeAuthCallbackFromUrl: consumeAuthCallbackFromUrl,
        login: login,
        register: register,
        beginOAuth: beginOAuth,
        syncCurrentData: syncCurrentData,
        exportAccountData: exportAccountData,
        importAccountData: importAccountData,
        startAutoSync: startAutoSync,
        stopAutoSync: stopAutoSync,
        ready: function () { return initializationPromise || Promise.resolve(); },
        isLoggedIn: async function () {
            var session = await getSession();
            return !!(session && session.user && session.token);
        }
    };

    initializationPromise = (async function () {
        try {
            if (getAuthCallbackFromUrl()) {
                await consumeAuthCallbackFromUrl();
                return;
            }
            var session = await getSession();
            if (session && session.user && session.token) {
                startAutoSync();
                await new Promise(function (resolve) {
                    var timeout = setTimeout(resolve, 5000);
                    syncCurrentData().catch(function () {}).finally(function () {
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }
        } catch (_) {}
    })();
}());
