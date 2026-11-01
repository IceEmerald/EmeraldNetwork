(function () {
    'use strict';

    var STORAGE_KEYS = {
        session: 'emerald.auth.session',
        returnUrl: 'emerald.auth.return_url'
    };

    var autoSyncTimer = null;
    // Fallback polling detects edits made on another device; local edits sync from storage events below.
    var autoSyncIntervalMs = 10000;
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
                    if (change && (change.key === STORAGE_KEYS.session || change.type === 'import')) return;
                    requestSyncFromLocalChange();
                });
            }

            if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.subscribeLocal === 'function') {
                window.EmeraldIDBStorage.subscribeLocal(function (change) {
                    if (change && (change.key === STORAGE_KEYS.session || change.type === 'import')) return;
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
        }
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
            return window.location.origin + '/';
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
        try {
            await syncCurrentData();
        } catch (_) {}

        var savedReturnUrl = null;
        try {
            var saved = sessionStorage.getItem(STORAGE_KEYS.returnUrl);
            savedReturnUrl = sanitizeRedirectTarget(saved, null);
        } catch (_) {}

        var redirectTarget = savedReturnUrl || getReturnUrl();
        if (!redirectTarget || isAccountUrl(redirectTarget)) {
            redirectTarget = window.location.origin + '/';
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
            try {
                await syncCurrentData();
            } catch (_) {}
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
            try {
                await syncCurrentData();
            } catch (_) {}
        }

        return result;
    }

    function mergeSnapshots(localSnapshot, remoteSnapshot) {
        var merged = {};
        var keys = new Set(Object.keys(localSnapshot || {}));
        Object.keys(remoteSnapshot || {}).forEach(function (key) { keys.add(key); });

        keys.forEach(function (key) {
            var localValue = localSnapshot && Object.prototype.hasOwnProperty.call(localSnapshot, key) ? localSnapshot[key] : null;
            var remoteValue = remoteSnapshot && Object.prototype.hasOwnProperty.call(remoteSnapshot, key) ? remoteSnapshot[key] : null;

            if (!localValue && !remoteValue) return;
            if (!localValue) { merged[key] = remoteValue; return; }
            if (!remoteValue) { merged[key] = localValue; return; }

            var localUpdated = Date.parse(localValue && localValue.updatedAt) || Number(localValue && localValue.updatedAt) || 0;
            var remoteUpdated = Date.parse(remoteValue && remoteValue.updatedAt) || Number(remoteValue && remoteValue.updatedAt) || 0;
            merged[key] = localUpdated >= remoteUpdated ? localValue : remoteValue;
        });

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

        await fetchJson('/api/auth/sync', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + session.token
            },
            body: JSON.stringify({ snapshot: mergedSnapshot })
        });

        if (remote.snapshot && typeof remote.snapshot === 'object') {
            await importAccountData(mergedSnapshot);
        }

        return { ok: true, snapshot: mergedSnapshot };
    }

    async function exportAccountData() {
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.exportAll === 'function') {
            return window.EmeraldIDBStorage.exportAll();
        }

        var snapshot = {};
        try {
            Object.keys(localStorage).forEach(function (key) {
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
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.importAll === 'function') {
            await window.EmeraldIDBStorage.importAll(snapshot);
            return true;
        }

        Object.keys(snapshot).forEach(function (key) {
            try { localStorage.setItem(key, JSON.stringify(snapshot[key])); } catch (_) {}
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
