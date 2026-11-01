(function () {
    'use strict';

    var STORAGE_KEYS = {
        session: 'emerald.auth.session',
        returnUrl: 'emerald.auth.return_url'
    };

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
            var safePath = parsed.pathname + parsed.search + parsed.hash;
            return safePath || fallback;
        } catch (_) {
            if (trimmed.startsWith('/')) return trimmed;
            return fallback;
        }
    }

    function getReturnUrl() {
        try {
            var saved = sessionStorage.getItem(STORAGE_KEYS.returnUrl);
            var safeSaved = sanitizeRedirectTarget(saved, '/');
            if (safeSaved && safeSaved !== '/account.html') return safeSaved;
        } catch (_) {}

        var params = new URLSearchParams(window.location.search);
        var redirect = params.get('redirect');
        if (redirect) return sanitizeRedirectTarget(decodeURIComponent(redirect), '/');
        return '/';
    }

    function rememberReturnUrl(url) {
        var safeUrl = sanitizeRedirectTarget(url, null);
        if (!safeUrl || safeUrl === '/account.html') return;
        try {
            sessionStorage.setItem(STORAGE_KEYS.returnUrl, safeUrl);
        } catch (_) {}
    }

    async function login(email, password) {
        var result = await fetchJson('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: email, password: password, redirect: getReturnUrl() })
        });

        if (result && result.session) {
            await setSession(result.session);
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

        return fetchJson('/api/auth/sync', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + session.token
            },
            body: JSON.stringify({ snapshot: snapshot })
        });
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

    function beginOAuth(provider) {
        var name = String(provider || 'Google').toLowerCase();
        var returnUrl = getReturnUrl();
        rememberReturnUrl(returnUrl);
        var redirect = encodeURIComponent(returnUrl);
        window.location.href = getApiBase() + '/api/auth/' + name + '?redirect=' + redirect;
    }

    window.EmeraldAuth = {
        getApiBase: getApiBase,
        getReturnUrl: getReturnUrl,
        rememberReturnUrl: rememberReturnUrl,
        getSession: getSession,
        setSession: setSession,
        clearSession: clearSession,
        login: login,
        register: register,
        beginOAuth: beginOAuth,
        syncCurrentData: syncCurrentData,
        exportAccountData: exportAccountData,
        importAccountData: importAccountData,
        isLoggedIn: async function () {
            var session = await getSession();
            return !!(session && session.user && session.token);
        }
    };
}());
