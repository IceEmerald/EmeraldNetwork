(function () {
    'use strict';

    var STORAGE_KEYS = {
        session: 'emerald.auth.session',
        returnUrl: 'emerald.auth.return_url',
        syncMeta: '__emerald_sync_meta_v1__'
    };

    var HISTORY_KEY = 'emerald.activity.history.v1';
    var HISTORY_MAX_ENTRIES = 400;
    var ETAG_STORAGE_KEY = 'emerald.auth.sync_etag';
    var SYNC_POLL_MS = 15000;
    var SYNC_DEBOUNCE_MS = 300;
    var SYNC_MAX_BACKOFF_MS = 60000;
    var SYNC_REQUEST_TIMEOUT_MS = 15000;
    var SYNC_LOCK_TIMEOUT_MS = 12000;

    var autoSyncTimer = null;
    var storageSyncTimer = null;
    var syncRetryTimer = null;
    var syncInFlight = null;
    var syncRequestedAgain = false;
    var syncListenersInstalled = false;
    var syncPendingLocal = false;
    var syncFailureCount = 0;
    var hasSyncedThisSession = false;
    var lastSyncEtag = '';
    var lastSyncAt = 0;
    var lastSyncError = null;
    var syncState = 'idle';
    var realtimeDeviceTimer = null;
    var realtimeDeviceInFlight = null;
    var lastDeviceRegistryHash = '';
    var initializationPromise = null;

    function syncBackoffDelay() {
        if (!syncFailureCount) return SYNC_DEBOUNCE_MS;
        var base = Math.min(SYNC_MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(syncFailureCount, 6)));
        var jitter = 0.75 + Math.random() * 0.5;
        return Math.min(SYNC_MAX_BACKOFF_MS, Math.round(base * jitter));
    }

    function getSyncState() {
        return {
            state: syncState,
            online: navigator.onLine !== false,
            syncing: syncState === 'syncing',
            pending: syncPendingLocal,
            lastSyncedAt: lastSyncAt,
            error: lastSyncError ? (lastSyncError.message || String(lastSyncError)) : '',
            failures: syncFailureCount
        };
    }

    function setSyncState(next, extra) {
        syncState = next || 'idle';
        var detail = getSyncState();
        if (extra) Object.assign(detail, extra);
        try {
            window.dispatchEvent(new CustomEvent('emerald-sync-state', { detail: detail }));
        } catch (_) {}
    }

    function emitSyncComplete(snapshot) {
        try {
            window.dispatchEvent(new CustomEvent('emerald-sync-complete', {
                detail: { snapshot: snapshot || null, state: getSyncState() }
            }));
        } catch (_) {}
    }

    function requestSyncFromLocalChange(options) {
        syncPendingLocal = true;
        if (storageSyncTimer) {
            clearTimeout(storageSyncTimer);
        }
        if (syncRetryTimer) {
            clearTimeout(syncRetryTimer);
            syncRetryTimer = null;
        }

        var delay = options && options.immediate ? 0 : syncBackoffDelay();
        storageSyncTimer = setTimeout(async function () {
            storageSyncTimer = null;
            if (navigator.onLine === false) {
                setSyncState('offline');
                return;
            }
            try {
                var session = await getSession();
                if (!session || !session.token) {
                    setSyncState('signed-out');
                    return;
                }
                await syncCurrentData();
            } catch (_) {}
        }, delay);
    }

    function scheduleSyncRetry() {
        if (syncRetryTimer) clearTimeout(syncRetryTimer);
        syncRetryTimer = setTimeout(function () {
            syncRetryTimer = null;
            if (navigator.onLine === false) {
                setSyncState('offline');
                return;
            }
            getSession().then(function (session) {
                if (!session || !session.token) {
                    setSyncState('signed-out');
                    return null;
                }
                return syncCurrentData();
            }).catch(function () {});
        }, syncBackoffDelay());
    }

    function startAutoSync() {
        if (autoSyncTimer) return;

        startRealtimeDeviceSync();
        setSyncState('idle');

        autoSyncTimer = window.setInterval(function () {
            if (navigator.onLine === false) {
                setSyncState('offline');
                return;
            }
            getSession().then(function (session) {
                if (!session || !session.token) {
                    stopAutoSync();
                    setSyncState('signed-out');
                    return null;
                }
                return syncCurrentData();
            }).catch(function () {});
        }, SYNC_POLL_MS);

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
                if (!event.key || shouldExcludeFromSync(event.key)) return;
                requestSyncFromLocalChange();
            });

            window.addEventListener('online', function () {
                syncFailureCount = 0;
                lastSyncError = null;
                requestSyncFromLocalChange({ immediate: true });
                pollDeviceRegistry().catch(function () {});
            });

            window.addEventListener('offline', function () {
                setSyncState('offline');
            });

            window.addEventListener('emerald-device-removed', function () {
                requestSyncFromLocalChange({ immediate: true });
            });
        }
    }

    async function pollDeviceRegistry() {
        if (realtimeDeviceInFlight) return realtimeDeviceInFlight;
        realtimeDeviceInFlight = (async function () {
            var session = await getSession();
            if (!session || !session.token) return null;

            try {
                var result = await fetchJson('/api/auth/devices', {
                    method: 'GET',
                    headers: { Authorization: 'Bearer ' + session.token }
                });
                var snapshot = {
                    'emerald.account.devices': Array.isArray(result.devices) ? result.devices : [],
                    'emerald.account.signout_requests': result.signOutRequests && typeof result.signOutRequests === 'object'
                        ? result.signOutRequests : {}
                };
                var registry = {
                    devices: Array.isArray(snapshot['emerald.account.devices']) ? snapshot['emerald.account.devices'] : [],
                    signOutRequests: snapshot['emerald.account.signout_requests'] && typeof snapshot['emerald.account.signout_requests'] === 'object'
                        ? snapshot['emerald.account.signout_requests'] : {}
                };
                var hash = JSON.stringify(registry);
                if (hash === lastDeviceRegistryHash) return snapshot;
                lastDeviceRegistryHash = hash;

                await importDeviceRegistry(snapshot);
                try {
                    window.dispatchEvent(new CustomEvent('emerald-sync-complete', {
                        detail: { snapshot: snapshot }
                    }));
                } catch (_) {}
                return snapshot;
            } catch (error) {
                if (error && error.status === 403 && error.code === 'DEVICE_SIGNED_OUT') {
                    await clearSession();
                }
                return null;
            }
        })();

        try {
            return await realtimeDeviceInFlight;
        } finally {
            realtimeDeviceInFlight = null;
        }
    }

    function startRealtimeDeviceSync() {
        if (realtimeDeviceTimer) return;
        pollDeviceRegistry().catch(function () {});
        realtimeDeviceTimer = window.setInterval(function () {
            if (document.visibilityState === 'visible' && navigator.onLine !== false) {
                pollDeviceRegistry().catch(function () {});
            }
        }, 5000);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') pollDeviceRegistry().catch(function () {});
        });
        window.addEventListener('focus', function () {
            pollDeviceRegistry().catch(function () {});
        });
        window.addEventListener('online', function () {
            pollDeviceRegistry().catch(function () {});
        });
    }

    function stopRealtimeDeviceSync() {
        if (realtimeDeviceTimer) {
            clearInterval(realtimeDeviceTimer);
            realtimeDeviceTimer = null;
        }
        lastDeviceRegistryHash = '';
    }

    function stopAutoSync() {
        stopRealtimeDeviceSync();
        if (autoSyncTimer) {
            clearInterval(autoSyncTimer);
            autoSyncTimer = null;
        }
        if (storageSyncTimer) {
            clearTimeout(storageSyncTimer);
            storageSyncTimer = null;
        }
        if (syncRetryTimer) {
            clearTimeout(syncRetryTimer);
            syncRetryTimer = null;
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

    function getDeviceId() {
        var id = null;
        try { id = localStorage.getItem('emerald.device.id'); } catch (_) {}
        if (!id) {
            id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            try { localStorage.setItem('emerald.device.id', id); } catch (_) {}
        }
        return id;
    }

    function getCurrentDeviceInfo() {
        return {
            id: getDeviceId(),
            name: navigator.platform || 'This device',
            userAgent: (navigator.userAgent || '').slice(0, 120),
            language: navigator.language || '',
            addedAt: Date.now(),
            current: false
        };
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

        // A new session starts a fresh sync generation: never reuse the
        // previous account's ETag or "already synced" flag.
        hasSyncedThisSession = false;
        lastSyncEtag = '';
        lastSyncAt = 0;
        lastSyncError = null;
        syncFailureCount = 0;
        syncPendingLocal = !!session;

        emitSessionChanged();
    }

    async function revokeDevice(deviceId, options) {
        await waitForStorage();
        var id = deviceId || getDeviceId();
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.getJSON === 'function') {
            try {
                var devices = await window.EmeraldIDBStorage.getJSON('emerald.account.devices');
                if (Array.isArray(devices)) {
                    await window.EmeraldIDBStorage.setJSON('emerald.account.devices', devices.filter(function (device) {
                        return !device || device.id !== id;
                    }));
                }
            } catch (_) {}
        }
        await syncCurrentData().catch(function () {});
        if (!options || options.clearSession !== false) await clearSession();
        return true;
    }

    async function signOutDevice(deviceId) {
        var session = await getSession();
        if (!session || !session.token || !deviceId) return false;
        await fetchJson('/api/auth/device-action', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + session.token },
            body: JSON.stringify({ action: 'remove', deviceId: deviceId })
        });
        await pollDeviceRegistry().catch(function () {});
        return true;
    }

    async function logoutCurrentDevice() {
        var session = await getSession();
        var currentId = getDeviceId();
        if (session && session.token && currentId) {
            try {
                await fetchJson('/api/auth/device-action', {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + session.token },
                    body: JSON.stringify({ action: 'logout', deviceId: currentId })
                });
            } catch (_) {}
        }
        await clearSession();
        return true;
    }

    async function clearSession() {
        stopAutoSync();
        syncPendingLocal = false;
        syncFailureCount = 0;
        hasSyncedThisSession = false;
        lastSyncEtag = '';
        lastSyncError = null;
        setSyncState('signed-out');
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
        var requestOptions = Object.assign({}, options || {});
        var fetchUrl = getApiBase() + path;
        var timeoutMs = Number(requestOptions.timeoutMs) || SYNC_REQUEST_TIMEOUT_MS;
        var allowNotModified = !!requestOptions.allowNotModified;
        delete requestOptions.timeoutMs;
        delete requestOptions.allowNotModified;

        var headers = Object.assign({ 'Content-Type': 'application/json' }, requestOptions.headers || {});
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = controller ? setTimeout(function () {
            try { controller.abort(); } catch (_) {}
        }, timeoutMs) : null;

        var response;
        try {
            response = await fetch(fetchUrl, Object.assign({}, requestOptions, {
                credentials: 'include',
                headers: headers,
                signal: controller ? controller.signal : requestOptions.signal
            }));
        } catch (error) {
            if (timer) clearTimeout(timer);
            if (error && error.name === 'AbortError') {
                var timeoutError = new Error('The request timed out. Please try again.');
                timeoutError.code = 'TIMEOUT';
                throw timeoutError;
            }
            throw error;
        }
        if (timer) clearTimeout(timer);

        if (allowNotModified && response.status === 304) {
            return {
                __notModified: true,
                etag: response.headers.get('ETag') || lastSyncEtag
            };
        }

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
            requestError.code = data && data.code ? data.code : null;
            throw requestError;
        }

        if (data && typeof data === 'object' && !data.etag) {
            var responseEtag = response.headers.get('ETag');
            if (responseEtag) data.etag = responseEtag;
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
        var deviceId = params.get('auth_device') || getDeviceId();

        if (!token || !email) return null;

        return {
            deviceId: deviceId,
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
            body: JSON.stringify({
                email: email,
                password: password,
                redirect: getReturnUrl(),
                deviceId: getDeviceId(),
                device: getCurrentDeviceInfo()
            })
        });

        if (result && result.session) {
            await setSession(result.session);
            startAutoSync();
            syncCurrentData().catch(function () {});
            pollDeviceRegistry().catch(function () {});
        }

        return result;
    }

    async function register(email, password) {
        var result = await fetchJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({
                email: email,
                password: password,
                redirect: getReturnUrl(),
                deviceId: getDeviceId(),
                device: getCurrentDeviceInfo()
            })
        });

        if (result && result.session) {
            await setSession(result.session);
            startAutoSync();
            syncCurrentData().catch(function () {});
            pollDeviceRegistry().catch(function () {});
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

    function loadStoredEtag(email) {
        if (!email) return '';
        try {
            var raw = localStorage.getItem(ETAG_STORAGE_KEY);
            var saved = raw ? JSON.parse(raw) : null;
            if (saved && saved.email === email && typeof saved.etag === 'string') return saved.etag;
        } catch (_) {}
        return '';
    }

    function saveStoredEtag(email, etag) {
        if (!email || typeof etag !== 'string' || !etag) return;
        try {
            localStorage.setItem(ETAG_STORAGE_KEY, JSON.stringify({ email: email, etag: etag }));
        } catch (_) {}
    }

    function hashHistoryText(value) {
        var text = String(value || '');
        var hash = 2166136261;
        for (var index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function normalizeHistoryEntry(value) {
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
        if (!entry.id) {
            entry.id = 'h_' + t.toString(36) + '_' +
                hashHistoryText([entry.kind, entry.path, entry.label, entry.n].join('\u0001'));
        }
        return entry;
    }

    function normalizeHistoryPayload(value) {
        if (!value) return null;
        var list = null;
        var updatedAt = 0;
        var clearedAt = 0;
        if (Array.isArray(value)) {
            list = value;
        } else if (typeof value === 'object') {
            list = Array.isArray(value.entries) ? value.entries : null;
            updatedAt = Number(value.updatedAt) || 0;
            clearedAt = Number(value.clearedAt) || 0;
        }
        if (!list) return null;

        var byId = {};
        var entries = [];
        list.forEach(function (item) {
            var entry = normalizeHistoryEntry(item);
            if (!entry || entry.t <= clearedAt) return;
            var existing = byId[entry.id];
            if (!existing) {
                byId[entry.id] = entry;
                entries.push(entry);
            } else if (entry.t > existing.t || (entry.t === existing.t && entry.n > existing.n)) {
                entries[entries.indexOf(existing)] = entry;
                byId[entry.id] = entry;
            }
        });
        entries.sort(function (first, second) {
            return second.t - first.t || (second.n || 1) - (first.n || 1);
        });
        return {
            v: 2,
            updatedAt: updatedAt,
            clearedAt: clearedAt,
            entries: entries.slice(0, HISTORY_MAX_ENTRIES)
        };
    }

    function mergeHistoryValues(first, second) {
        var firstPayload = normalizeHistoryPayload(first);
        var secondPayload = normalizeHistoryPayload(second);
        if (!firstPayload && !secondPayload) return null;

        var clearedAt = Math.max(
            firstPayload ? firstPayload.clearedAt : 0,
            secondPayload ? secondPayload.clearedAt : 0
        );
        var combined = (firstPayload ? firstPayload.entries : [])
            .concat(secondPayload ? secondPayload.entries : [])
            .filter(function (entry) { return entry.t > clearedAt; });
        var merged = normalizeHistoryPayload({ entries: combined, clearedAt: clearedAt });
        var updatedAt = Math.max(
            firstPayload ? firstPayload.updatedAt : 0,
            secondPayload ? secondPayload.updatedAt : 0,
            clearedAt,
            merged.entries.length ? merged.entries[0].t : 0
        );
        merged.updatedAt = updatedAt;
        return merged;
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

            if (key === HISTORY_KEY) {
                var history = mergeHistoryValues(localValue, remoteValue);
                if (!history) return;
                merged[key] = history;
                mergedMeta.updated[key] = Math.max(newestUpdate, history.updatedAt) || Date.now();
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

    function withSyncLock(task) {
        var locks = typeof navigator !== 'undefined' ? navigator.locks : null;
        if (!locks || typeof locks.request !== 'function') {
            return Promise.resolve().then(task);
        }

        return new Promise(function (resolve, reject) {
            var settled = false;
            var timedOut = false;
            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

            function runFallback() {
                Promise.resolve().then(task).then(resolve, reject);
            }

            var timer = setTimeout(function () {
                timedOut = true;
                try { if (controller) controller.abort(); } catch (_) {}
                if (!settled) {
                    settled = true;
                    runFallback();
                }
            }, SYNC_LOCK_TIMEOUT_MS);

            var options = { mode: 'exclusive' };
            if (controller) options.signal = controller.signal;

            locks.request('emerald-sync', options, function () {
                if (timedOut) return undefined;
                clearTimeout(timer);
                return Promise.resolve().then(task).then(function (result) {
                    if (!settled) {
                        settled = true;
                        resolve(result);
                    }
                    return result;
                }, function (error) {
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                    throw error;
                });
            }).catch(function (error) {
                clearTimeout(timer);
                if (settled) return;
                if (timedOut) {
                    settled = true;
                    runFallback();
                    return;
                }
                // Lock API failed for another reason; syncing is still better
                // than stalling, so run the task directly.
                settled = true;
                runFallback();
            });
        });
    }

    function syncCurrentData() {
        if (syncInFlight) {
            syncRequestedAgain = true;
            syncPendingLocal = true;
            return syncInFlight;
        }

        syncInFlight = withSyncLock(function () {
            return performSync();
        });

        return syncInFlight.then(function (result) {
            syncFailureCount = 0;
            if (result && result.pendingLocalChanges) {
                syncPendingLocal = true;
            } else if (result) {
                syncPendingLocal = false;
            }
            return result;
        }).catch(function (error) {
            syncFailureCount = Math.min(syncFailureCount + 1, 8);
            lastSyncError = error || new Error('Sync failed.');
            syncPendingLocal = true;
            setSyncState(navigator.onLine === false ? 'offline' : 'error');
            scheduleSyncRetry();
            throw error;
        }).finally(function () {
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

    // A value-equality match between the local and merged snapshot does NOT
    // mean the server is up to date: when this device has edited something
    // (e.g. profile photo, personal info), the merge correctly keeps the
    // local values, which makes both snapshots identical. Local changes are
    // visible in the sync metadata instead: any local updated/deleted stamp
    // newer than the server's record means we still owe the server a push.
    function hasPendingLocalWrites(localSnapshot, remoteSnapshot) {
        var localMeta = {};
        var remoteMeta = {};
        try {
            localMeta = (localSnapshot && localSnapshot[STORAGE_KEYS.syncMeta]) || {};
            remoteMeta = (remoteSnapshot && remoteSnapshot[STORAGE_KEYS.syncMeta]) || {};
        } catch (_) {}

        function stamp(source, field, key) {
            var map = source && source[field] && typeof source[field] === 'object' ? source[field] : {};
            return Number(map[key]) || 0;
        }

        function pending(field) {
            var localStamps = localMeta[field] && typeof localMeta[field] === 'object' ? localMeta[field] : {};
            return Object.keys(localStamps).some(function (key) {
                var localTs = Number(localStamps[key]) || 0;
                if (localTs <= 0) return false;
                var remoteTs = Math.max(stamp(remoteMeta, 'updated', key), stamp(remoteMeta, 'deleted', key));
                return localTs > remoteTs;
            });
        }

        return pending('updated') || pending('deleted');
    }

    async function captureSnapshot() {
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.exportAll === 'function') {
            return await window.EmeraldIDBStorage.exportAll();
        }

        var snapshot = {};
        try {
            Object.keys(localStorage).forEach(function (key) {
                if (shouldExcludeFromSync(key)) return;
                try {
                    var raw = localStorage.getItem(key);
                    snapshot[key] = raw ? JSON.parse(raw) : raw;
                } catch (_) {
                    snapshot[key] = localStorage.getItem(key);
                }
            });
        } catch (_) {}
        return snapshot;
    }

    async function performSync() {
        var session = await getSession();
        if (!session || !session.token) {
            setSyncState('signed-out');
            return null;
        }

        if (navigator.onLine === false) {
            setSyncState('offline');
            return null;
        }

        setSyncState('syncing');

        // History batches are debounced locally; push them to IndexedDB
        // before taking the sync snapshot so the latest actions are included.
        if (window.EmeraldHistory && typeof window.EmeraldHistory.flush === 'function') {
            try { await window.EmeraldHistory.flush(); } catch (_) {}
        }

        var snapshot = await captureSnapshot();
        var email = session.user && session.user.email ? session.user.email : '';
        if (!lastSyncEtag && email) lastSyncEtag = loadStoredEtag(email);

        var conditional = hasSyncedThisSession && !syncPendingLocal && !!lastSyncEtag;
        var headers = { Authorization: 'Bearer ' + session.token };
        if (conditional) headers['If-None-Match'] = lastSyncEtag;

        var remote;
        try {
            remote = await fetchJson('/api/auth/sync', {
                method: 'GET',
                headers: headers,
                allowNotModified: true
            });
        } catch (error) {
            if (error && (error.status === 401 || error.status === 404)) await clearSession();
            if (error && error.status === 403 && error.code === 'DEVICE_SIGNED_OUT') await clearSession();
            throw error;
        }

        if (remote && remote.__notModified) {
            hasSyncedThisSession = true;
            syncPendingLocal = false;
            lastSyncAt = Date.now();
            lastSyncError = null;
            if (remote.etag) {
                lastSyncEtag = remote.etag;
                saveStoredEtag(email, remote.etag);
            }
            setSyncState('synced');
            emitSyncComplete(null);
            return { ok: true, notModified: true, snapshot: null };
        }

        var baseSnapshot = remote && remote.snapshot && typeof remote.snapshot === 'object' ? remote.snapshot : {};
        var remoteEtag = remote && typeof remote.etag === 'string' ? remote.etag : '';
        var mergedSnapshot = mergeSnapshots(snapshot, baseSnapshot);

        // Skip the push when the merge produced exactly what the server
        // already has AND this device has no local writes the server has not
        // seen yet. Value equality alone is not enough — a local edit makes
        // the merge keep the local value, so both sides can look identical
        // while the server is still stale.
        if (snapshotsMatch(mergedSnapshot, baseSnapshot) && !hasPendingLocalWrites(snapshot, baseSnapshot)) {
            // The server already has the merged result, but this device may
            // still be missing or hold an older copy of it (new browser,
            // cleared cache, another device edited). Pull it down without a
            // needless POST.
            if (!snapshotsMatch(snapshot, mergedSnapshot)) {
                await importDeviceRegistry(mergedSnapshot);
                await importAccountData(mergedSnapshot);
            }
            hasSyncedThisSession = true;
            syncPendingLocal = false;
            lastSyncAt = Date.now();
            lastSyncError = null;
            if (remoteEtag) {
                lastSyncEtag = remoteEtag;
                saveStoredEtag(email, remoteEtag);
            }
            setSyncState('synced');
            emitSyncComplete(mergedSnapshot);
            return { ok: true, snapshot: mergedSnapshot };
        }

        var syncResult = await fetchJson('/api/auth/sync', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + session.token
            },
            body: JSON.stringify({
                snapshot: mergedSnapshot,
                device: getCurrentDeviceInfo(),
                deviceId: getDeviceId()
            })
        });

        var serverSnapshot = syncResult && syncResult.snapshot && typeof syncResult.snapshot === 'object'
            ? syncResult.snapshot
            : mergedSnapshot;

        // Device registry changes are always safe to import separately. The
        // broader pending-edit guard below must not hide a new/removed device.
        await importDeviceRegistry(serverSnapshot);

        // Do not import the response captured before a local edit. Doing so
        // would visibly roll an in-progress edit back to its old position.
        var latestSnapshot = await exportAccountData();
        if (!snapshotsMatch(snapshot, latestSnapshot)) {
            syncRequestedAgain = true;
            setSyncState('syncing');
            return { ok: true, pendingLocalChanges: true };
        }

        if (serverSnapshot) {
            await importAccountData(serverSnapshot);
        }

        hasSyncedThisSession = true;
        syncPendingLocal = false;
        lastSyncAt = Date.now();
        lastSyncError = null;

        var resultEtag = syncResult && typeof syncResult.etag === 'string' ? syncResult.etag : '';
        if (resultEtag) {
            lastSyncEtag = resultEtag;
            saveStoredEtag(email, resultEtag);
        }

        setSyncState('synced');
        emitSyncComplete(serverSnapshot || mergedSnapshot);

        return { ok: true, snapshot: serverSnapshot };
    }

    async function importDeviceRegistry(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        var serverDevices = snapshot && snapshot['emerald.account.devices'];
        if (Array.isArray(serverDevices)) {
            snapshot = Object.assign({}, snapshot, { 'emerald.account.devices': serverDevices });
        }
        var keys = ['emerald.account.devices', 'emerald.account.signout_requests'];
        for (var index = 0; index < keys.length; index++) {
            var key = keys[index];
            var value = snapshot[key];
            if (value == null) continue;
            try {
                if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.setJSON === 'function') {
                    await window.EmeraldIDBStorage.setJSON(key, value, { type: 'import' });
                }
                localStorage.setItem(key, JSON.stringify(value));
            } catch (_) {}
        }
        try {
            window.dispatchEvent(new CustomEvent('emerald-sync-complete', {
                detail: { snapshot: snapshot }
            }));
        } catch (_) {}
    }

    function shouldExcludeFromSync(key) {
        return key === 'emerald.auth.session' ||
            key === 'emerald.auth.return_url' ||
            key === 'emerald.auth.sync_etag' ||
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
        var device = getCurrentDeviceInfo();
        var query = '?redirect=' + redirect + '&intent=' + encodeURIComponent(mode) +
            '&deviceId=' + encodeURIComponent(device.id) +
            '&device=' + encodeURIComponent(JSON.stringify(device));
        window.location.href = getApiBase() + '/api/auth/' + name + query;
    }

    window.EmeraldAuth = {
        getApiBase: getApiBase,
        getReturnUrl: getReturnUrl,
        rememberReturnUrl: rememberReturnUrl,
        getSession: getSession,
        setSession: setSession,
        clearSession: clearSession,
        revokeDevice: revokeDevice,
        signOutDevice: signOutDevice,
        logoutCurrentDevice: logoutCurrentDevice,
        consumeAuthCallbackFromUrl: consumeAuthCallbackFromUrl,
        login: login,
        register: register,
        beginOAuth: beginOAuth,
        syncCurrentData: syncCurrentData,
        requestSync: function (options) { requestSyncFromLocalChange(options); },
        getSyncState: getSyncState,
        flushHistory: function () {
            if (window.EmeraldHistory && typeof window.EmeraldHistory.flush === 'function') {
                return window.EmeraldHistory.flush();
            }
            return Promise.resolve(false);
        },
        pollDeviceRegistry: pollDeviceRegistry,
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
