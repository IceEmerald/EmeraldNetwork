(function () {
    'use strict';

    var STORAGE_KEYS = {
        session: 'emerald.auth.session',
        returnUrl: 'emerald.auth.return_url'
    };

    var autoSyncTimer = null;
    var autoSyncIntervalMs = 10000;

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

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                syncCurrentData().catch(function () {});
            }
        });
    }

    function stopAutoSync() {
        if (autoSyncTimer) {
            clearInterval(autoSyncTimer);
            autoSyncTimer = null;
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

    async function getSession() {
        await waitForStorage();

        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.getJSONSync === 'function') {
            return window.EmeraldIDBStorage.getJSONSync(STORAGE_KEYS.session) || null;
        }

        try {
            var raw = localStorage.getItem(STORAGE_KEYS.session);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    async function setSession(session) {
        await waitForStorage();

        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.setJSON === 'function') {
            await window.EmeraldIDBStorage.setJSON(STORAGE_KEYS.session, session || null);
            return;
        }

        try {
            if (session) {
                localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
            } else {
                localStorage.removeItem(STORAGE_KEYS.session);
            }
        } catch (_) {}
    }

    async function clearSession() {
        stopAutoSync();
        await waitForStorage();
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.delete === 'function') {
            try { await window.EmeraldIDBStorage.delete(STORAGE_KEYS.session); } catch (_) {}
        }
        try { localStorage.removeItem(STORAGE_KEYS.session); } catch (_) {}
        try { sessionStorage.removeItem(STORAGE_KEYS.returnUrl); } catch (_) {}
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
            throw new Error(reason);
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

    function getReturnUrl() {
        try {
            var saved = sessionStorage.getItem(STORAGE_KEYS.returnUrl);
            var safeSaved = sanitizeRedirectTarget(saved, null);
            if (safeSaved && safeSaved !== '/account.html') return safeSaved;
        } catch (_) {}

        var params = new URLSearchParams(window.location.search);
        var redirect = params.get('redirect');
        if (redirect) return sanitizeRedirectTarget(decodeURIComponent(redirect), window.location.origin + '/');

        if (window.location.origin) {
            return window.location.origin + window.location.pathname + window.location.search;
        }

        return '/';
    }

    function rememberReturnUrl(url) {
        var safeUrl = sanitizeRedirectTarget(url, null);
        if (!safeUrl || safeUrl === '/account.html') return;
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

        var redirectTarget = getReturnUrl();
        if (!redirectTarget || redirectTarget === '/account.html') {
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

    async function syncCurrentData() {
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

        await fetchJson('/api/auth/sync', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + session.token
            },
            body: JSON.stringify({ snapshot: snapshot })
        });

        var remote = await fetchJson('/api/auth/sync', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer ' + session.token
            }
        });

        if (remote && remote.snapshot && typeof remote.snapshot === 'object') {
            await importAccountData(remote.snapshot);
        }

        return remote;
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
        isLoggedIn: async function () {
            var session = await getSession();
            return !!(session && session.user && session.token);
        }
    };

    (async function () {
        try {
            var session = await getSession();
            if (session && session.user && session.token) {
                startAutoSync();
                await syncCurrentData();
            }
        } catch (_) {}
    })();

    consumeAuthCallbackFromUrl();
}());
