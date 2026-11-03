/* ============================================================
   EmeraldNetwork — Authentication + Account dashboard (account.html)
   ============================================================ */

(function () {
    'use strict';

    /* ---------------- Mode switching ---------------- */

    var currentMode = 'login';
    var forms = {
        login: document.getElementById('login-form'),
        register: document.getElementById('register-form')
    };
    var title = document.getElementById('formCardTitle');
    var subtitle = document.getElementById('formCardSubtitle');
    var switchNote = document.getElementById('switchNote');
    var loggedInState = document.getElementById('loggedInState');
    var loggedInEmail = document.getElementById('loggedInEmail');
    var logoutBtn = document.getElementById('logoutBtn');
    var authShell = document.getElementById('authShell');
    var accountDashboard = document.getElementById('accountDashboard');

    var ARROW = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';

    var COPY = {
        login: {
            title: 'Welcome back!',
            subtitle: 'Sign in to your EmeraldNetwork account.',
            note: ''
        },
        register: {
            title: 'Create your account.',
            subtitle: 'Create an account to get started with EmeraldNetwork.',
            note: ''
        }
    };

    var ready = false;
    var sessionMonitor = null;

    function hasValidSession(session) {
        return !!(session && (session.user || session.email) && session.token);
    }

    function stopSessionMonitor() {
        if (sessionMonitor) {
            clearInterval(sessionMonitor);
            sessionMonitor = null;
        }
    }

    function startSessionMonitor() {
        if (sessionMonitor) return;
        sessionMonitor = setInterval(function () {
            refreshSessionView().catch(function () {});
        }, 1000);

        window.addEventListener('storage', function () {
            refreshSessionView().catch(function () {});
        });

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                refreshSessionView().catch(function () {});
            }
        });
    }

    function activateMode(name, animate) {
        if (animate && ready) {
            var card = document.querySelector('.auth-inner');
            card.classList.add('is-switching');
            setTimeout(function () {
                applyMode(name);
                void card.offsetWidth;
                card.classList.remove('is-switching');
                card.classList.add('is-entering');
                setTimeout(function () {
                    card.classList.remove('is-entering');
                }, 120);
            }, 150);
        } else {
            applyMode(name);
        }
    }

    function renderLoggedOutSwitchNote(mode) {
        if (!switchNote) return;
        switchNote.textContent = '';

        var prefix = document.createElement('span');
        prefix.className = 'switch-prefix';
        prefix.textContent = mode === 'login' ? 'New to EmeraldNetwork? ' : 'Already have an account? ';

        var link = document.createElement('a');
        link.id = 'modeSwitch';
        link.href = '#';
        link.textContent = mode === 'login' ? 'Create an account' : 'Sign in';

        switchNote.appendChild(prefix);
        switchNote.appendChild(link);
    }

    function applyMode(name) {
        currentMode = name;
        Object.keys(forms).forEach(function (key) {
            var form = forms[key];
            var isActive = key === name;
            form.classList.toggle('active', isActive);
            form.hidden = !isActive;
            if (!isActive) clearFormErrors(form);
        });

        if (loggedInState && loggedInState.hidden === false) {
            return;
        }

        title.textContent = COPY[name].title;
        subtitle.textContent = COPY[name].subtitle;
        renderLoggedOutSwitchNote(name);
    }

    function getStoredSessionDirect() {
        var candidates = [
            function () { try { return JSON.parse(localStorage.getItem('emerald.auth.session') || 'null'); } catch (_) { return null; } },
            function () { try { return JSON.parse(sessionStorage.getItem('emerald.auth.session') || 'null'); } catch (_) { return null; } },
            function () {
                if (!window.EmeraldIDBStorage || typeof window.EmeraldIDBStorage.getJSONSync !== 'function') return null;
                try { return window.EmeraldIDBStorage.getJSONSync('emerald.auth.session') || null; } catch (_) { return null; }
            }
        ];

        for (var i = 0; i < candidates.length; i++) {
            var value = candidates[i]();
            if (hasValidSession(value)) {
                return value;
            }
        }

        return null;
    }

    function resolveSessionEmail(session) {
        if (!session) return 'your account';

        var user = session.user || {};
        var possible = [
            user.email,
            session.email,
            user.account && user.account.email,
            session.account && session.account.email,
            user.name && user.name.includes('@') ? user.name : null
        ];

        for (var i = 0; i < possible.length; i++) {
            var value = possible[i];
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }

        return 'your account';
    }

    function showLoggedInState(session) {
        var email = resolveSessionEmail(session);
        if (forms.login) {
            forms.login.hidden = true;
            forms.login.style.display = 'none';
            forms.login.classList.remove('active');
        }
        if (forms.register) {
            forms.register.hidden = true;
            forms.register.style.display = 'none';
            forms.register.classList.remove('active');
        }

        var divider = document.querySelector('.divider');
        var socialButtons = document.querySelector('.social-buttons');
        var authFooter = document.getElementById('authFooter');
        if (divider) { divider.hidden = true; divider.style.display = 'none'; }
        if (socialButtons) { socialButtons.hidden = true; socialButtons.style.display = 'none'; }
        if (authFooter) { authFooter.hidden = true; authFooter.style.display = 'none'; }

        if (loggedInState) {
            loggedInState.hidden = false;
            loggedInState.style.display = 'flex';
        }
        if (loggedInEmail) loggedInEmail.textContent = email;
        if (switchNote) switchNote.textContent = '';
        title.textContent = 'Logged in!';
        subtitle.textContent = 'Account: ' + email;
        window.__emerald_auth_logged_out = false;

        if (authShell) authShell.style.display = 'none';
        if (accountDashboard) {
            accountDashboard.hidden = false;
            accountDashboard.style.display = '';
        }
        renderAccount(session).catch(function () {});
    }

    function showLoggedOutState() {
        var currentModeName = currentMode || 'login';
        var divider = document.querySelector('.divider');
        var socialButtons = document.querySelector('.social-buttons');
        var authFooter = document.getElementById('authFooter');
        if (divider) { divider.hidden = false; divider.style.display = 'flex'; }
        if (socialButtons) { socialButtons.hidden = false; socialButtons.style.display = 'grid'; }
        if (authFooter) { authFooter.hidden = false; authFooter.style.display = 'block'; }
        if (loggedInState) { loggedInState.hidden = true; loggedInState.style.display = 'none'; }
        if (forms.login && forms.register) {
            forms.login.hidden = currentModeName !== 'login';
            forms.login.style.display = currentModeName === 'login' ? '' : 'none';
            forms.register.hidden = currentModeName !== 'register';
            forms.register.style.display = currentModeName === 'register' ? '' : 'none';
            forms.login.classList.toggle('active', currentModeName === 'login');
            forms.register.classList.toggle('active', currentModeName === 'register');
        }
        if (switchNote) renderLoggedOutSwitchNote(currentModeName);
        title.textContent = COPY[currentModeName].title;
        subtitle.textContent = COPY[currentModeName].subtitle;
        window.__emerald_auth_logged_out = true;

        if (authShell) authShell.style.display = '';
        if (accountDashboard) {
            accountDashboard.hidden = true;
            accountDashboard.style.display = 'none';
        }
    }

    var isLoggedInView = false;
    var lastRenderedEmail = null;

    async function refreshSessionView() {
        var directSession = getStoredSessionDirect();
        var session = directSession;

        if (!session && window.EmeraldAuth && window.EmeraldAuth.getSession) {
            try { session = await window.EmeraldAuth.getSession(); } catch (_) {}
        }

        if (hasValidSession(session)) {
            var email = resolveSessionEmail(session);
            /* Only re-render the dashboard when we actually transition into
               the logged-in view (or switch accounts). Re-rendering on every
               1s tick would clobber whatever the user is currently typing. */
            if (!isLoggedInView || lastRenderedEmail !== email) {
                isLoggedInView = true;
                lastRenderedEmail = email;
                showLoggedInState(session);
            }
            startSessionMonitor();
            return;
        }

        isLoggedInView = false;
        lastRenderedEmail = null;

        if (window.__emerald_auth_logged_out !== false) {
            showLoggedOutState();
        }
        startSessionMonitor();
    }

    /* Delegated mode switch */
    if (switchNote) {
        switchNote.addEventListener('click', function (e) {
            if (loggedInState && loggedInState.hidden === false) return;
            var link = e.target && e.target.closest ? e.target.closest('#modeSwitch') : null;
            if (!link) return;
            e.preventDefault();
            activateMode(currentMode === 'login' ? 'register' : 'login', true);
        });
    }

    /* ---------------- Toast ---------------- */

    var toastTimer;

    function createToastIcon() {
        var ns = 'http://www.w3.org/2000/svg';
        var icon = document.createElementNS(ns, 'svg');
        var circle = document.createElementNS(ns, 'circle');
        var line = document.createElementNS(ns, 'path');
        var dot = document.createElementNS(ns, 'path');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.style.verticalAlign = '-3px';
        icon.style.marginRight = '6px';
        icon.style.opacity = '0.7';
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '10');
        line.setAttribute('d', 'M12 8v4');
        dot.setAttribute('d', 'M12 16h.01');
        icon.append(circle, line, dot);
        return icon;
    }

    function showToast(message) {
        var toast = document.getElementById('custom-toast');
        if (!toast) return;
        toast.replaceChildren(createToastIcon(), document.createTextNode(String(message || '')));
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove('show');
        }, 5000);
    }

    /* ---------------- Validation helpers ---------------- */

    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    function setError(inputId, message) {
        var input = document.getElementById(inputId);
        var error = document.getElementById(inputId + '-error');
        if (!input || !error) return;
        input.classList.toggle('invalid', Boolean(message));
        input.setAttribute('aria-invalid', message ? 'true' : 'false');
        error.textContent = message || '';
        error.classList.toggle('show', Boolean(message));
    }

    function clearFormErrors(form) {
        Array.prototype.slice.call(form.querySelectorAll('input')).forEach(function (input) {
            setError(input.id, '');
            input.classList.remove('invalid', 'match');
        });
    }

    /* ---------------- Login form ---------------- */

    function validateLoginForm() {
        var email = document.getElementById('login-email').value.trim();
        var password = document.getElementById('login-password').value;

        var ok = true;

        if (!email) {
            setError('login-email', 'Please enter your email.');
            ok = false;
        } else if (!EMAIL_RE.test(email)) {
            setError('login-email', 'That doesn\u2019t look like a valid email address.');
            ok = false;
        } else {
            setError('login-email', '');
        }

        if (!password) {
            setError('login-password', 'Please enter your password.');
            ok = false;
        } else {
            setError('login-password', '');
        }

        return ok;
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

    var authRequestPending = false;

    async function submitAuthRequest(mode) {
        if (authRequestPending) return;
        authRequestPending = true;
        var submitButtons = Array.prototype.slice.call(document.querySelectorAll('#login-form button[type="submit"], #register-form button[type="submit"]'));
        submitButtons.forEach(function (button) { button.disabled = true; });
        var email = mode === 'login'
            ? document.getElementById('login-email').value.trim()
            : document.getElementById('register-email').value.trim();
        var password = mode === 'login'
            ? document.getElementById('login-password').value
            : document.getElementById('register-password').value;

        try {
            showToast(mode === 'login' ? 'Signing in…' : 'Creating your account…');
            var result = mode === 'login'
                ? await window.EmeraldAuth.login(email, password)
                : await window.EmeraldAuth.register(email, password);

            var safeRedirect = sanitizeRedirectTarget(
                result && result.redirectUrl ? result.redirectUrl : window.EmeraldAuth.getReturnUrl(),
                '/'
            );

            window.location.assign(safeRedirect);
        } catch (error) {
            var message = error && error.message ? error.message : 'Authentication failed.';
            showToast(message);
        } finally {
            authRequestPending = false;
            submitButtons.forEach(function (button) { button.disabled = false; });
        }
    }

    forms.login.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!validateLoginForm()) return;
        submitAuthRequest('login');
    });

    /* ---------------- Register form ---------------- */

    function validateRegisterForm() {
        var email = document.getElementById('register-email').value.trim();
        var password = document.getElementById('register-password').value;
        var confirm = document.getElementById('register-confirm').value;

        var ok = true;

        if (!email) {
            setError('register-email', 'Please enter your email.');
            ok = false;
        } else if (!EMAIL_RE.test(email)) {
            setError('register-email', 'That doesn\u2019t look like a valid email address.');
            ok = false;
        } else {
            setError('register-email', '');
        }

        if (!password) {
            setError('register-password', 'Please choose a password.');
            ok = false;
        } else if (password.length < 8) {
            setError('register-password', 'Password must be at least 8 characters.');
            ok = false;
        } else {
            setError('register-password', '');
        }

        var confirmInput = document.getElementById('register-confirm');
        if (!confirm) {
            setError('register-confirm', 'Please re-enter your password.');
            confirmInput.classList.remove('match');
            ok = false;
        } else if (confirm !== password) {
            setError('register-confirm', 'Passwords don\u2019t match.');
            confirmInput.classList.remove('match');
            ok = false;
        } else {
            setError('register-confirm', '');
            confirmInput.classList.add('match');
        }

        return ok;
    }

    forms.register.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!validateRegisterForm()) return;
        submitAuthRequest('register');
    });

    function updateMatchState() {
        var password = document.getElementById('register-password').value;
        var confirm = document.getElementById('register-confirm').value;
        var input = document.getElementById('register-confirm');
        if (!confirm) {
            input.classList.remove('invalid', 'match');
            return;
        }
        if (confirm !== password) {
            input.classList.remove('invalid', 'match');
        } else {
            input.classList.remove('invalid');
            input.classList.add('match');
        }
    }

    function validateConfirmOnBlur() {
        var password = document.getElementById('register-password').value;
        var confirm = document.getElementById('register-confirm').value;
        var input = document.getElementById('register-confirm');
        if (!confirm) {
            setError('register-confirm', '');
            input.classList.remove('invalid', 'match');
            return;
        }
        if (confirm !== password) {
            setError('register-confirm', 'Passwords don\u2019t match.');
            input.classList.add('invalid');
            input.classList.remove('match');
        } else {
            setError('register-confirm', '');
            input.classList.remove('invalid');
            input.classList.add('match');
        }
    }

    document.getElementById('register-password').addEventListener('input', updateMatchState);
    document.getElementById('register-confirm').addEventListener('input', updateMatchState);
    document.getElementById('register-confirm').addEventListener('blur', validateConfirmOnBlur);
    document.getElementById('register-password').addEventListener('blur', validateConfirmOnBlur);

    function validateEmailOnBlur(inputId) {
        var email = document.getElementById(inputId).value.trim();
        var input = document.getElementById(inputId);
        if (!email) {
            setError(inputId, '');
            input.classList.remove('invalid');
            return;
        }
        if (!EMAIL_RE.test(email)) {
            setError(inputId, 'That doesn\u2019t look like a valid email address.');
            input.classList.add('invalid');
        } else {
            setError(inputId, '');
            input.classList.remove('invalid');
        }
    }

    document.getElementById('login-email').addEventListener('blur', function () {
        validateEmailOnBlur('login-email');
    });
    document.getElementById('register-email').addEventListener('blur', function () {
        validateEmailOnBlur('register-email');
    });
    document.querySelectorAll('.input-group input').forEach(function (input) {
        if (input.id === 'register-password' || input.id === 'register-confirm') return;
        input.addEventListener('input', function () {
            if (input.classList.contains('invalid')) setError(input.id, '');
        });
    });

    /* ---------------- Social buttons ---------------- */

    function oauthStub(provider, intent) {
        if (!window.EmeraldAuth || !window.EmeraldAuth.beginOAuth) {
            showToast('OAuth is not available yet. Set up the Cloudflare auth worker first.');
            return;
        }
        window.EmeraldAuth.beginOAuth(provider, intent);
    }

    document.getElementById('googleBtn').addEventListener('click', function () {
        oauthStub('Google', currentMode === 'register' ? 'register' : 'login');
    });

    /* ---------------- Forgot password ---------------- */

    document.getElementById('forgotLink').addEventListener('click', function (e) {
        e.preventDefault();
        showToast('Password reset will arrive with the account backend hookup.');
    });

    /* ---------------- Password show / hide ---------------- */

    Array.prototype.slice.call(document.querySelectorAll('.pw-toggle')).forEach(function (toggle) {
        var input = document.getElementById(toggle.dataset.target);
        if (!input) return;
        toggle.addEventListener('click', function () {
            var show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            toggle.setAttribute('aria-pressed', String(show));
            toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            input.focus();
        });
    });

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async function () {
            stopSessionMonitor();
            window.__emerald_auth_logged_out = true;

            try {
                if (window.EmeraldAuth && window.EmeraldAuth.logoutCurrentDevice) {
                    await window.EmeraldAuth.logoutCurrentDevice();
                } else if (window.EmeraldAuth && window.EmeraldAuth.clearSession) {
                    await window.EmeraldAuth.clearSession();
                }
            } catch (_) {}

            try {
                localStorage.removeItem('emerald.auth.session');
                sessionStorage.removeItem('emerald.auth.session');
                localStorage.removeItem('emerald.auth.return_url');
                sessionStorage.removeItem('emerald.auth.return_url');
                if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.delete === 'function') {
                    await window.EmeraldIDBStorage.delete('emerald.auth.session');
                    await window.EmeraldIDBStorage.delete('emerald.auth.return_url');
                }
            } catch (_) {}

            showLoggedOutState();
            activateMode('login', false);
            startSessionMonitor();
            if (window.location.pathname !== '/account.html') {
                try { window.location.replace('/account.html'); } catch (_) {}
            }
        });
    }

    /* ---------------- Account dashboard logic ---------------- */

    function getDeviceId() {
        var id = null;
        try { id = localStorage.getItem('emerald.device.id'); } catch (_) {}
        if (!id) {
            id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            try { localStorage.setItem('emerald.device.id', id); } catch (_) {}
        }
        return id;
    }

    function currentDeviceInfo() {
        return {
            id: getDeviceId(),
            name: (navigator.platform || 'This device'),
            userAgent: (navigator.userAgent || '').slice(0, 120),
            language: navigator.language || '',
            addedAt: Date.now(),
            current: true
        };
    }

    /* device-type visualisation for the overview card */
    function deviceKindOf(d) {
        var hay = ((d && d.userAgent) || '') + ' ' + ((d && d.name) || '');
        hay = hay.toLowerCase();
        if (/iphone|ipad|ipod|android|mobile|phone|tablet/.test(hay)) return 'phone';
        if (/desktop|workstation|\bpc\b/.test(hay)) return 'pc';
        return 'laptop';
    }

    /* Overview shows only the device you are using right now; the full list
       lives in the Devices section (Manage devices). */
    function renderDeviceRows(devices) {
        var wrap = document.getElementById('overviewDeviceList');
        if (!wrap) return;
        wrap.innerHTML = '';
        var labels = { phone: 'Phone', laptop: 'Laptop', pc: 'PC' };
        var currentId = getDeviceId();
        var rows = devices || [];
        rows.forEach(function (d) {
            if (!d || !d.id) return;
            var kind = deviceKindOf(d);
            var os = deviceOsOf(d);
            var browser = deviceBrowserOf(d && d.userAgent);
            var isCurrent = d.id === currentId;
            var row = document.createElement('div');
            row.className = 'ms-device-row';

            var art = document.createElement('span');
            art.className = 'ms-device-art';
            art.innerHTML = msDeviceArt(kind);
            art.setAttribute('role', 'img');
            art.setAttribute('aria-label', labels[kind] + ' illustration');
            row.appendChild(art);

            var info = document.createElement('div');
            info.className = 'ms-device-info';

            var head = document.createElement('h4');
            head.textContent = labels[kind];
            var chip = document.createElement('span');
            chip.className = 'ms-chip';
            chip.textContent = isCurrent ? 'This device' : '';
            head.appendChild(chip);
            info.appendChild(head);

            var model = document.createElement('p');
            model.className = 'ms-device-model';
            var bits = [os, browser, friendlyPlatform(d && d.name)].filter(Boolean);
            model.textContent = bits.join(' · ') || 'Details unavailable';
            info.appendChild(model);

            row.appendChild(info);
            wrap.appendChild(row);
        });
        if (rows.length === 0) {
            wrap.appendChild(Object.assign(document.createElement('div'), {
                className: 'ms-device-empty',
                textContent: 'No devices signed in on this browser yet.'
            }));
        }
    }

    /* platform strings stored in device records ('MacIntel', 'Win32', …)
       turned into readable names */
    function friendlyPlatform(name) {
        var n = (name || '').trim();
        if (/^Mac/i.test(n)) return 'Mac';
        if (/^Win/i.test(n)) return 'Windows';
        if (/^Linux/i.test(n)) return n;
        return (n && n !== 'This device') ? n : '';
    }

    function deviceOsOf(d) {
        var ua = (d && d.userAgent) || '';
        var name = (d && d.name) || '';
        if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
        if (/android/i.test(ua)) return 'Android';
        if (/windows/i.test(ua + ' ' + name)) return 'Windows';
        if (/mac os x|macintosh/i.test(ua) || /^Mac/i.test(name)) return 'macOS';
        if (/linux/i.test(ua + ' ' + name)) return 'Linux';
        return '';
    }

    function deviceBrowserOf(ua) {
        ua = ua || '';
        if (/Edg\//.test(ua)) return 'Microsoft Edge';
        if (/OPR\/|Opera/.test(ua)) return 'Opera';
        if (/Firefox\//.test(ua)) return 'Firefox';
        if (/Chrome\//.test(ua)) return 'Google Chrome';
        if (/Safari\//.test(ua)) return 'Safari';
        return '';
    }

    /* Microsoft-account-style flat artwork: dark bezel, brand screen with
       white window tiles, grey body on the deck / stand / keyboard. */
    function msDeviceArt(kind) {
        var screen = '#239a4d';
        var bezel = '#48524d';
        var deck = '#d9dfdc';
        var deck2 = '#c2cac6';
        var tiles = 'rgba(255, 255, 255, 0.85)';
        var svgs = {
            phone:
                '<svg viewBox="0 -2 72 114" xmlns="http://www.w3.org/2000/svg">' +
                '<rect x="8" y="2" width="56" height="106" rx="9" fill="' + bezel + '"/>' +
                '<rect x="12" y="12" width="48" height="86" rx="3" fill="' + screen + '"/>' +
                '<g fill="' + tiles + '">' +
                '<rect x="17" y="17" width="19" height="13" rx="1"/>' +
                '<rect x="38" y="17" width="9" height="6" rx="1"/>' +
                '<rect x="49" y="17" width="9" height="6" rx="1"/>' +
                '<rect x="38" y="25" width="9" height="5" rx="1"/>' +
                '<rect x="49" y="25" width="9" height="5" rx="1"/>' +
                '<rect x="38" y="33" width="20" height="12" rx="1"/>' +
                '</g>' +
                '<rect x="29" y="6.6" width="14" height="2.6" rx="1.3" fill="' + deck + '"/>' +
                '<circle cx="36" cy="102.5" r="2.6" fill="' + deck + '"/>' +
                '</svg>',
            laptop:
                '<svg viewBox="3 -4 114 87" xmlns="http://www.w3.org/2000/svg">' +
                '<rect x="26" y="2" width="68" height="52" rx="5" fill="' + bezel + '"/>' +
                '<rect x="30" y="6" width="60" height="44" rx="2" fill="' + screen + '"/>' +
                '<g fill="' + tiles + '">' +
                '<rect x="34" y="10" width="21" height="15" rx="1"/>' +
                '<rect x="57" y="10" width="12" height="7" rx="1"/>' +
                '<rect x="71" y="10" width="15" height="7" rx="1"/>' +
                '<rect x="57" y="19" width="12" height="6" rx="1"/>' +
                '<rect x="71" y="19" width="15" height="6" rx="1"/>' +
                '<rect x="57" y="28" width="29" height="18" rx="1"/>' +
                '</g>' +
                '<path d="M18 54h84l9 17a4 4 0 0 1-3.6 6H12.6a4 4 0 0 1-3.6-6z" fill="' + deck + '"/>' +
                '<rect x="49" y="59" width="22" height="10" rx="3" fill="' + deck2 + '"/>' +
                '</svg>',
            pc:
                '<svg viewBox="10 -4 92 105" xmlns="http://www.w3.org/2000/svg">' +
                '<rect x="16" y="2" width="88" height="62" rx="5" fill="' + bezel + '"/>' +
                '<rect x="20" y="6" width="80" height="54" rx="2" fill="' + screen + '"/>' +
                '<g fill="' + tiles + '">' +
                '<rect x="25" y="11" width="25" height="18" rx="1"/>' +
                '<rect x="53" y="11" width="13" height="8" rx="1"/>' +
                '<rect x="69" y="11" width="26" height="8" rx="1"/>' +
                '<rect x="53" y="21" width="13" height="8" rx="1"/>' +
                '<rect x="69" y="21" width="26" height="8" rx="1"/>' +
                '<rect x="53" y="32" width="42" height="21" rx="1"/>' +
                '</g>' +
                '<rect x="55" y="63" width="10" height="12" fill="' + deck2 + '"/>' +
                '<rect x="41" y="75" width="38" height="4" rx="2" fill="' + deck + '"/>' +
                '<rect x="24" y="85" width="72" height="10" rx="3" fill="' + deck + '"/>' +
                '<rect x="28" y="88" width="64" height="3" rx="1.5" fill="' + deck2 + '"/>' +
                '</svg>'
        };
        return svgs[kind] || svgs.laptop;
    }

    async function waitForStorageReady() {
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.ready === 'function') {
            try { await window.EmeraldIDBStorage.ready(); } catch (_) {}
        }
    }

    async function loadProfile(email) {
        await waitForStorageReady();
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.getJSON === 'function') {
            try {
                var p = await window.EmeraldIDBStorage.getJSON('emerald.account.profile');
                if (p) return p;
            } catch (_) {}
        }
        try {
            var raw = localStorage.getItem('emerald.account.profile.' + email);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    async function saveProfile(email, profile) {
        await waitForStorageReady();
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.setJSON === 'function') {
            try { await window.EmeraldIDBStorage.setJSON('emerald.account.profile', profile); } catch (_) {}
        }
        try { localStorage.setItem('emerald.account.profile.' + email, JSON.stringify(profile)); } catch (_) {}
    }

    async function loadDevices() {
        await waitForStorageReady();
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.getJSON === 'function') {
            try {
                var d = await window.EmeraldIDBStorage.getJSON('emerald.account.devices');
                if (Array.isArray(d)) return d;
            } catch (_) {}
        }
        try {
            var raw = localStorage.getItem('emerald.account.devices');
            return raw ? JSON.parse(raw) : [];
        } catch (_) { return []; }
    }

    async function saveDevices(list) {
        await waitForStorageReady();
        if (window.EmeraldIDBStorage && typeof window.EmeraldIDBStorage.setJSON === 'function') {
            try { await window.EmeraldIDBStorage.setJSON('emerald.account.devices', list); } catch (_) {}
        }
        try { localStorage.setItem('emerald.account.devices', JSON.stringify(list)); } catch (_) {}
    }

    async function ensureDevice() {
        var list = await loadDevices();
        var id = getDeviceId();
        var unique = [];
        var seen = {};
        (Array.isArray(list) ? list : []).forEach(function (device) {
            if (!device || !device.id || seen[device.id]) return;
            seen[device.id] = true;
            unique.push(Object.assign({}, device, { current: false }));
        });

        var localIndex = unique.findIndex(function (device) { return device.id === id; });
        if (localIndex === -1) {
            unique.unshift(Object.assign({}, currentDeviceInfo(), { current: false }));
        } else {
            unique[localIndex] = Object.assign({}, unique[localIndex], currentDeviceInfo(), { current: false });
        }

        if (JSON.stringify(list || []) !== JSON.stringify(unique)) {
            await saveDevices(unique);
        }
        return unique;
    }

    function defaultAvatarDataUrl() {
        return "data:image/svg+xml;utf8," + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="100%" height="100%" fill="#e8f3ec"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="DM Sans, sans-serif" font-size="44" fill="#239a4d">E</text></svg>'
        );
    }

    function setText(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    /* --- sliding navigation pill ------------------------------------- */

    function moveNavPill(instant) {
        var nav = document.getElementById('dashNav');
        var pill = nav ? nav.querySelector('.dash-nav-pill') : null;
        var active = nav ? nav.querySelector('.dash-nav-item.active') : null;
        if (!nav || !pill || !active) return;

        var navRect = nav.getBoundingClientRect();
        var btnRect = active.getBoundingClientRect();

        /* Same mechanic as wiki's .wiki-nav-pill: the rail's top stays 0 and
           the whole bar is translated to the active row, so moving between
           rows reads as one bar sliding, not two bars blinking. The bar is
           shorter than the row and vertically centred inside it. */
        var railH = Math.max(12, Math.min(Math.round(btnRect.height * 0.58), 20));
        pill.style.transform = 'translate3d(0, ' +
            ((btnRect.top - navRect.top) + (btnRect.height - railH) / 2) + 'px, 0)';
        pill.style.height = railH + 'px';

        if (instant) {
            pill.style.transition = 'none';
            void pill.offsetWidth;
            pill.style.transition = '';
        }
        pill.classList.add('is-on');
    }

    function setSrc(id, value) {
        var el = document.getElementById(id);
        if (el) el.src = value || defaultAvatarDataUrl();
    }

    /* ---------- network auto-detection ---------------------------------
       The public IP comes from the user's own network (WiFi/cellular)
       and is looked up against a free geolocation endpoint to suggest
       country + region for the profile form. Results are cached for a
       day so the lookup is not repeated on every render. */

    var GEO_CACHE_KEY = 'emeraldGeoLookupV2';

    function deriveDefaultName(email) {
        if (!email || email.indexOf('@') === -1) return '';
        var local = email.split('@')[0].trim();
        if (!local || local === 'test') local = 'Test User';  // mock test session
        // "john.doe_92" → "John Doe 92"
        var words = local.replace(/[._\-]+/g, ' ').trim().split(/\s+/);
        for (var i = 0; i < words.length; i++) {
            words[i] = words[i].charAt(0).toUpperCase() + words[i].slice(1);
        }
        return words.join(' ') || local;
    }

    async function detectNetworkLocation() {
        var cached = null;
        try { cached = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || 'null'); } catch (_) {}
        if (cached && cached.data && (Date.now() - cached.t) < 24 * 60 * 60 * 1000) {
            return cached.data;
        }

        var endpoints = ['https://ipwho.is/', 'https://ipapi.co/json/'];
        for (var i = 0; i < endpoints.length; i++) {
            try {
                var res = await fetch(endpoints[i], { cache: 'no-store' });
                if (!res.ok) continue;
                var geo = await res.json();
                var countryName = geo.country_name || geo.country || '';
                var countryCode = geo.country_code || geo.countryCode || '';
                // endpoints differ: some give "US", some "United States" —
                // normalise to the proper country name either way
                if (/^[A-Za-z]{2}$/.test(countryName.trim())) {
                    try {
                        countryName = new Intl.DisplayNames(['en'], { type: 'region' })
                            .of(countryName.trim().toUpperCase()) || countryName;
                    } catch (_) {}
                } else if (!countryName && countryCode) {
                    try {
                        countryName = new Intl.DisplayNames(['en'], { type: 'region' })
                            .of(countryCode.trim().toUpperCase()) || '';
                    } catch (_) {}
                }
                var data = {
                    ip: geo.ip || geo.query || '',
                    city: geo.city || '',
                    region: geo.region || geo.region_name || '',
                    country: countryName,
                    countryCode: String(countryCode || '').toUpperCase()
                };
                if (data.ip) {
                    try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify({ t: Date.now(), data: data })); } catch (_) {}
                    return data;
                }
            } catch (_) { /* offline or blocked — try the next endpoint */ }
        }
        return null;
    }

    /* Fill the network-detected country into the (now free-text) field. */
    function applyDetectedCountry(input, countryName) {
        if (!input || !countryName) return false;
        input.value = String(countryName);
        return true;
    }

    /* ---------- dirty-state tracking for the profile form ----------
       The "Save changes" button stays disabled until one of the fields
       differs from the last saved snapshot; it is disabled again right
       after a successful save. */

    var savedProfileSnapshot = null;
    var userEditedProfile = false;

    function profileFormValues() {
        return {
            name: (document.getElementById('profileName') && document.getElementById('profileName').value || '').trim(),
            birth: (document.getElementById('profileBirth') && document.getElementById('profileBirth').value || '').trim(),
            city: (document.getElementById('profileCity') && document.getElementById('profileCity').value || '').trim(),
            region: (document.getElementById('profileRegion') && document.getElementById('profileRegion').value || '').trim(),
            country: (document.getElementById('profileCountry') && document.getElementById('profileCountry').value || '').trim()
        };
    }

    function updateSaveButtonState() {
        var form = document.getElementById('profileForm');
        var btn = form ? form.querySelector('button[type="submit"]') : null;
        if (!btn) return;
        var changed = !savedProfileSnapshot ||
            JSON.stringify(profileFormValues()) !== JSON.stringify(savedProfileSnapshot);
        btn.disabled = !changed;
    }

    /* ---------- segmented birthday picker ------------------------------
       Day = numeric text input, Month = custom dropdown popup,
       Year = numeric text input. The day is clamped to the number of
       days that exist in the chosen month + year (leap years included),
       and the age is shown as soon as the full date is valid. The
       combined value is mirrored into the hidden #profileBirth input
       (YYYY-MM-DD), which is what gets saved. */

    var BIRTH_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    function daysInMonth(month, year) {
        return new Date(year, month, 0).getDate();
    }

    function pad2(n) {
        return String(n).length === 1 ? '0' + n : String(n);
    }

    function birthEls() {
        return {
            day: document.getElementById('profileBirthDay'),
            box: document.getElementById('profileBirthMonthBox'),
            btn: document.getElementById('profileBirthMonthBtn'),
            label: document.getElementById('profileBirthMonthLabel'),
            menu: document.getElementById('profileBirthMonthMenu'),
            year: document.getElementById('profileBirthYear'),
            hidden: document.getElementById('profileBirth')
        };
    }

    function chosenMonth(els) {
        return parseInt((els.box && els.box.dataset.value) || '', 10) || 0;
    }

    function closeMonthMenu(els) {
        els.box.classList.remove('open');
        els.btn.setAttribute('aria-expanded', 'false');
    }

    function refreshMonthOptions(els) {
        var chosen = chosenMonth(els);
        Array.prototype.forEach.call(els.menu.children, function (btn, i) {
            btn.classList.toggle('selected', i + 1 === chosen);
        });
    }

    function initBirthdayPicker() {
        var els = birthEls();
        if (!els.day || !els.box || !els.year) return;

        els.menu.innerHTML = '';
        BIRTH_MONTHS.forEach(function (name, idx) {
            var opt = document.createElement('button');
            opt.type = 'button';
            opt.className = 'month-option';
            opt.setAttribute('role', 'option');
            opt.textContent = name;
            opt.addEventListener('click', function () {
                els.box.dataset.value = String(idx + 1);
                els.label.textContent = name;
                els.label.classList.remove('b-empty');
                closeMonthMenu(els);
                refreshMonthOptions(els);
                clampBirthDay(els);
                userEditedProfile = true;
                syncBirthdayPicker();
            });
            els.menu.appendChild(opt);
        });

        els.btn.addEventListener('click', function () {
            var open = els.box.classList.toggle('open');
            els.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) refreshMonthOptions(els);
        });

        /* close when clicking anywhere else */
        document.addEventListener('click', function (e) {
            if (els.box.classList.contains('open') && !els.box.contains(e.target)) {
                closeMonthMenu(els);
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && els.box.classList.contains('open')) {
                closeMonthMenu(els);
            }
        });

        /* digits only, limited length */
        [els.day, els.year].forEach(function (input) {
            input.addEventListener('input', function () {
                var v = input.value.replace(/\D+/g, '');
                if (input === els.year) v = v.slice(0, 4);
                if (v !== input.value) input.value = v;
                userEditedProfile = true;
            });
        });

        /* day clamps to the real month length on commit (blur/Enter) */
        [els.day, els.year].forEach(function (input) {
            input.addEventListener('change', function () {
                userEditedProfile = true;
                clampBirthDay(els);
                syncBirthdayPicker();
            });
        });
        els.day.addEventListener('input', syncBirthdayPicker);
        els.year.addEventListener('input', syncBirthdayPicker);

        syncBirthdayPicker();
    }

    function clampBirthDay(els) {
        var d = parseInt(els.day.value, 10);
        if (!d) {
            els.day.value = els.day.value === '0' ? '' : els.day.value;
            return;
        }
        var m = chosenMonth(els);
        var y = parseInt(els.year.value, 10);
        var max = (m && y) ? daysInMonth(m, y) : 31;
        if (d > max) els.day.value = String(max);   // e.g. Feb 31 → 29
        else if (d < 1) els.day.value = '';
    }

    function setBirthdayPickerValue(ymd) {
        var els = birthEls();
        if (!els.day) return;
        var parts = (ymd || '').split('-');
        if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
            var y = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            var d = parseInt(parts[2], 10);
            if (y && m && d) {
                els.year.value = String(y);
                els.box.dataset.value = String(m);
                els.label.textContent = BIRTH_MONTHS[m - 1] || 'Month';
                els.label.classList.remove('b-empty');
                els.day.value = String(d);
            }
        } else {
            els.day.value = '';
            els.box.dataset.value = '';
            els.label.textContent = 'Month';
            els.label.classList.add('b-empty');
            els.year.value = '';
        }
        syncBirthdayPicker();
    }

    function syncBirthdayPicker() {
        var els = birthEls();
        if (!els.day) return;

        var d = parseInt(els.day.value, 10);
        var m = chosenMonth(els);
        var y = parseInt(els.year.value, 10);
        var complete = !!(d && m && y && String(els.year.value).length === 4);
        if (els.hidden) els.hidden.value = complete ? y + '-' + pad2(m) + '-' + pad2(d) : '';
        if (typeof updateSaveButtonState === 'function') updateSaveButtonState();
    }

    function applySection(name) {
        document.querySelectorAll('.dash-nav-item').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.section === name);
        });
        document.querySelectorAll('.dash-section').forEach(function (sec) {
            sec.classList.toggle('active', sec.id === 'section-' + name);
        });
        moveNavPill(false);
    }

    /* --- section switch, wiki's blur dissolve ----------------------------
       The content blurs out quickly, swaps at the midpoint and dissolves
       back in slowly (see .dash-main / .is-switching in the CSS). Rapid
       clicks remember only the newest target and apply it at the midpoint,
       exactly like wiki.js's go(). */
    var SWITCH_MS = 180;
    var switchAnimating = false;
    var switchPending = null;
    var dashMain = document.querySelector('.dash-main');

    function showSection(name) {
        if (!dashMain) {
            applySection(name);
            return;
        }
        if (switchAnimating) {
            switchPending = name;
            return;
        }
        switchPending = name;
        switchAnimating = true;
        dashMain.classList.add('is-switching');

        setTimeout(function () {
            var next = switchPending;
            switchPending = null;
            try {
                if (next) applySection(next);
            } finally {
                /* Force a reflow before removing the class, or there is
                   nothing to transition back from and the content snaps
                   into focus. */
                void dashMain.offsetWidth;
                dashMain.classList.remove('is-switching');
                setTimeout(function () { switchAnimating = false; }, 200);
            }
        }, SWITCH_MS);
    }
    window.showSection = showSection;

    async function renderDevices(list) {
        var ul = document.getElementById('deviceList');
        if (!ul) return;
        ul.innerHTML = '';
        var id = getDeviceId();
        var devices = Array.isArray(list) ? list.slice() : [];
        // Keep the current device at the top and de-duplicate by id.
        var seen = {};
        devices = devices.filter(function (d) {
            if (!d || !d.id || seen[d.id]) return false;
            seen[d.id] = true;
            return true;
        }).sort(function (a, b) {
            if (a.id === id) return -1;
            if (b.id === id) return 1;
            return Number(b.updatedAt || b.addedAt || 0) - Number(a.updatedAt || a.addedAt || 0);
        });

        devices.forEach(function (d) {
            var li = document.createElement('li');
            li.className = 'device-item';
            if (d.id === id) li.classList.add('current');
            var info = document.createElement('div');
            info.className = 'device-info';
            var name = document.createElement('div');
            name.className = 'device-name';
            name.textContent = (d.name || 'Device') + (d.id === id ? ' (this device)' : '');
            var meta = document.createElement('div');
            meta.className = 'device-meta';
            var os = deviceOsOf(d);
            var browser = deviceBrowserOf(d && d.userAgent);
            var bits = [os, browser, d.language].filter(Boolean);
            var when = d.updatedAt || d.addedAt;
            if (when) bits.push((d.id === id ? 'last active ' : 'added ') + new Date(when).toLocaleString());
            meta.textContent = bits.join(' · ') || 'Details unavailable';
            info.appendChild(name);
            info.appendChild(meta);
            li.appendChild(info);

            var btn = document.createElement('button');
            btn.className = 'btn secondary';
            btn.textContent = d.id === id ? 'Current' : 'Sign out';
            if (d.id === id) {
                btn.disabled = true;
                btn.title = 'You are using this device';
            } else {
                btn.addEventListener('click', async function () {
                    btn.disabled = true;
                    btn.textContent = 'Signing out…';
                    try {
                        if (window.EmeraldAuth && typeof window.EmeraldAuth.signOutDevice === 'function') {
                            await window.EmeraldAuth.signOutDevice(d.id);
                        }
                        var current = await loadDevices();
                        var next = current.filter(function (x) { return x && x.id !== d.id; });
                        await saveDevices(next);
                        await renderDevices(next);
                        showToast('Device signed out.');
                        try {
                            window.dispatchEvent(new CustomEvent('emerald-device-removed', {
                                detail: { deviceId: d.id }
                            }));
                        } catch (_) {}
                    } catch (error) {
                        btn.disabled = false;
                        btn.textContent = 'Sign out';
                        showToast((error && error.message) ? error.message : 'Could not sign out device.');
                        try {
                            var refreshed = await loadDevices();
                            await renderDevices(refreshed);
                        } catch (_) {}
                    }
                });
            }
            li.appendChild(btn);
            ul.appendChild(li);
        });

        if (!devices.length) {
            var empty = document.createElement('li');
            empty.className = 'device-item';
            empty.textContent = 'No devices signed in yet.';
            ul.appendChild(empty);
        }
    }

    /* Mirror of aichat's storage counter (_fmtBytes / _getStorageEstimate):
       the max is the browser/IDB origin quota reported by
       navigator.storage.estimate(), not a made-up 15 GB. Falls back to the
       old fixed-quota text when estimate() is unsupported/throttled. */
    function fmtBytes(b) {
        if (!Number.isFinite(b) || b <= 0) return '0 B';
        if (b < 1024) return b + ' B';
        var units = ['KB', 'MB', 'GB', 'TB'];
        var v = b;
        var u = -1;
        do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
        return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[u];
    }

    /* Which suite app owns which storage keys. Keys live in the shared
       `emeraldcore.storage.suite` kv store, qualified as acct:<scope>:<key>. */
    function suiteAppOf(qualifiedKey) {
        var k = qualifiedKey.replace(/^acct:[^:]*:/, '');
        if (k.indexOf('en_chat') === 0 || k.indexOf('en_onboarded') === 0) return 'AI Chat';
        if (k.indexOf('emeraldcore.storage.suite.docs') === 0) return 'Docs';
        if (k.indexOf('emeraldcore.storage.suite.slides') === 0) return 'Slides';
        if (k.indexOf('emeraldcore.storage.suite.sheets') === 0) return 'Sheets';
        if (k.indexOf('emeraldcore.storage.suite.notes') === 0) return 'Notes';
        if (k.indexOf('emerald.account') === 0) return 'Account';
        return 'Other';
    }

    var SUITE_APP_COLORS = {
        'AI Chat': '#239a4d',
        'Docs': '#4b8fd1',
        'Slides': '#f0a13b',
        'Sheets': '#7bc47f',
        'Notes': '#a67bd8',
        'Account': '#e0769a',
        'Other': '#9aa5a0'
    };

    /* Measure every entry in the suite's kv store and size it per app. */
    async function measureSuiteStorage() {
        var agg = {};
        var total = 0;
        try {
            var open = indexedDB.open('emeraldcore.storage.suite');
            var database = await new Promise(function (resolve, reject) {
                open.onsuccess = function () { resolve(open.result); };
                open.onerror = function () { reject(open.error); };
            });
            var tx = database.transaction('kv', 'readonly');
            var req = tx.objectStore('kv').getAll();
            var entries = await new Promise(function (resolve, reject) {
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { reject(req.error); };
            });
            database.close();
            var te = new TextEncoder();
            (entries || []).forEach(function (e) {
                if (!e || typeof e.key !== 'string') return;
                var rowBytes = 0;
                try {
                    rowBytes = typeof e.value === 'string'
                        ? te.encode(e.value).length
                        : te.encode(JSON.stringify(e.value || '')).length;
                } catch (_) {}
                if (!rowBytes) return;
                var app = suiteAppOf(e.key);
                agg[app] = (agg[app] || 0) + rowBytes;
                total += rowBytes;
            });
        } catch (_) {}
        return { agg: agg, total: total };
    }

    /* One donut for every .storage-pie on the page (overview + storage
       section): conic-gradient of app slices out of the quota, free space
       as the neutral remainder, and a matching legend. */
    function renderStorageDonut(agg, used, quota) {
        var apps = Object.keys(agg).filter(function (k) { return agg[k] > 0; })
            .sort(function (a, b) { return agg[b] - agg[a]; });
        var denom = (quota > 0 && quota > used) ? quota : Math.max(used, 1);
        var stops = [];
        var cursor = 0;
        apps.forEach(function (k) {
            var span = (agg[k] / denom) * 100;
            stops.push(SUITE_APP_COLORS[k] + ' ' + cursor.toFixed(2) + '% ' + (cursor + span).toFixed(2) + '%');
            cursor += span;
        });
        if (cursor < 100) stops.push('#e9edeb ' + cursor.toFixed(2) + '% 100%');
        var gradient = stops.length
            ? 'conic-gradient(' + stops.join(', ') + ')'
            : 'conic-gradient(#e9edeb 0% 100%)';

        document.querySelectorAll('.storage-pie').forEach(function (pie) {
            pie.style.background = gradient;
        });

        var pctUsed = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
        document.querySelectorAll('.pie-pct').forEach(function (el) {
            el.textContent = pctUsed.toFixed(1) + '%';
        });

        document.querySelectorAll('.storage-legend').forEach(function (legend) {
            legend.innerHTML = '';
            apps.forEach(function (k) {
                var share = used > 0 ? (agg[k] / used) * 100 : 0;
                var row = document.createElement('div');
                row.className = 'legend-row';
                row.innerHTML =
                    '<span class="legend-dot" style="background:' + SUITE_APP_COLORS[k] + '"></span>' +
                    '<span class="legend-name">' + k + '</span>' +
                    '<span class="legend-val">' + fmtBytes(agg[k]) + '</span>' +
                    '<span class="legend-pct">' + share.toFixed(0) + '%</span>';
                legend.appendChild(row);
            });
            if (!apps.length) {
                var empty = document.createElement('div');
                empty.className = 'legend-empty';
                empty.textContent = 'Nothing stored by the suite yet.';
                legend.appendChild(empty);
            }
        });
    }

    async function renderStorage() {
        var measured = { agg: {}, total: 0 };
        try { measured = await measureSuiteStorage(); } catch (_) {}
        var used = measured.total || 0;

        var quota = null;
        try {
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                var est = await navigator.storage.estimate();
                if (typeof est.quota === 'number' && est.quota > 0) quota = est.quota;
            }
        } catch (_) { /* estimate() unsupported/throttled — keep fixed fallback */ }

        var text;
        if (quota) {
            var pct = Math.min(100, (used / quota) * 100);
            text = fmtBytes(used) + ' of ' + fmtBytes(quota) + ' used · ' + pct.toFixed(1) + '%';
        } else {
            quota = 15 * 1024 * 1024 * 1024;
            text = (used / (1024 * 1024)).toFixed(2) + ' MB used of 15 GB';
        }

        renderStorageDonut(measured.agg, used, quota);
        var freeStr = fmtBytes(Math.max(0, quota - used));
        ['overviewStorageFree', 'storageFree'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.textContent = freeStr;
        });

        setText('storageText', text);
        setText('overviewStorage', text);
    }

    /* overview setup checklist, myaccount.google.com style: one dropdown on
       the card header (where the done-counter sits); each step row is a
       plain jump link — no per-step dropdowns. */
    function renderSetupChecklist(profile) {
        var list = document.getElementById('setupList');
        if (!list) return;
        var toggle = document.getElementById('setupToggle');
        var items = [
            { label: 'Add a profile photo', done: !!(profile.photo), target: 'personal' },
            { label: 'Add your birthday', done: !!(profile.birth), target: 'personal' },
            { label: 'Add where you live (city or country)', done: !!(profile.city || profile.region || profile.country), target: 'personal' }
        ];
        list.innerHTML = '';
        var doneCount = 0;
        items.forEach(function (it) {
            if (it.done) doneCount++;
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'setup-row' + (it.done ? ' done' : '');
            var mark = document.createElement('span');
            mark.className = 'setup-mark';
            mark.innerHTML = '&#10003;';
            row.appendChild(mark);
            var text = document.createElement('span');
            text.className = 'setup-text';
            text.textContent = it.label;
            row.appendChild(text);
            row.addEventListener('click', function () { showSection(it.target); });
            list.appendChild(row);
        });

        var allDone = doneCount === items.length;

        /* one dropdown state, on the whole card, animated with a
           max-height + opacity slide (border-box layout so 0 is exact) */
        var isOpen = false;
        var setOpen = function (open) {
            isOpen = open;
            if (toggle) {
                toggle.classList.toggle('closed', !open);
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            if (!open) {
                list.style.visibility = 'hidden';
                list.style.opacity = '0';
                list.style.maxHeight = '0px';
                return;
            }
            list.style.visibility = '';
            list.style.opacity = '1';
            list.style.maxHeight = list.scrollHeight + 'px';
        };
        if (toggle) {
            toggle.onclick = function () {
                setOpen(!isOpen);
            };
        }
        setOpen(!allDone);
    }

    /* header avatar button: photo (or initial) + name/email tooltip */
    function updateHeaderUser(name, email, photo) {
        var btn = document.getElementById('dashUserBtn');
        var img = document.getElementById('dashAvatar');
        var initials = document.getElementById('dashInitials');
        if (btn) btn.title = name + ' — Personal info';
        if (img) {
            if (photo) {
                img.src = photo;
                img.hidden = false;
            } else {
                img.removeAttribute('src');
                img.hidden = true;
            }
        }
        if (initials) {
            if (photo) {
                initials.hidden = true;
            } else {
                initials.textContent = (name.trim().charAt(0) || 'E').toUpperCase();
                initials.hidden = false;
            }
        }
    }

    async function renderAccount(session) {
        await waitForStorageReady();
        var email = resolveSessionEmail(session);
        var provider = (session && session.user && session.user.provider) || 'email';

        var profile = await loadProfile(email);
        if (!profile) profile = {};

        var name = profile.name || deriveDefaultName(email);
        var photo = profile.photo || '';

        setSrc('dashAvatar', photo);
        setSrc('overviewAvatar', photo);
        setSrc('profilePhoto', photo);

        updateHeaderUser(name, email, photo);
        setText('overviewName', name);
        setText('overviewEmail', email);
        setText('overviewProvider', provider === 'google' ? 'Signed in with Google' : 'Email account');
        setText('securityEmail', email);
        renderSetupChecklist(profile);

        /* greeting, time-of-day aware like myaccount.google.com */
        var greetingEl = document.getElementById('overviewGreeting');
        if (greetingEl) {
            var hour = new Date().getHours();
            var part = hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening');
            greetingEl.textContent = part + ', ' + (name.split(' ')[0] || name);
        }

        /* password card visibility */
        var passwordCard = document.getElementById('passwordCard');
        var googleCard = document.getElementById('googleProviderCard');
        if (provider === 'google') {
            if (passwordCard) passwordCard.hidden = true;
            if (googleCard) googleCard.hidden = false;
        } else {
            if (passwordCard) passwordCard.hidden = false;
            if (googleCard) googleCard.hidden = true;
        }

        /* profile form — name derives from the email; city/region/country
           are prefilled from network (IP) location when still empty */
        var nameInput = document.getElementById('profileName');
        var birthInput = document.getElementById('profileBirth');
        var cityInput = document.getElementById('profileCity');
        var regionInput = document.getElementById('profileRegion');
        var countryInput = document.getElementById('profileCountry');
        var suggestedName = profile.name || deriveDefaultName(email);
        if (nameInput) {
            nameInput.value = profile.name || suggestedName;
            nameInput.placeholder = suggestedName;
        }
        if (birthInput) birthInput.value = profile.birth || '';
        setBirthdayPickerValue(profile.birth || '');
        if (cityInput) cityInput.value = profile.city || '';
        if (regionInput) regionInput.value = profile.region || '';
        if (countryInput) countryInput.value = profile.country || '';

        /* baseline snapshot for the dirty-state button */
        savedProfileSnapshot = profileFormValues();
        userEditedProfile = false;
        updateSaveButtonState();

        /* network (WiFi/ISP) location suggestion, non-blocking */
        if (cityInput || regionInput || countryInput) {
            detectNetworkLocation().then(function (geo) {
                if (!geo) return;
                if (cityInput && !cityInput.value && geo.city) {
                    cityInput.value = geo.city;
                    cityInput.placeholder = geo.city;
                }
                if (regionInput && !regionInput.value && geo.region) {
                    regionInput.value = geo.region;
                    regionInput.placeholder = geo.region;
                }
                if (countryInput && !countryInput.value) {
                    applyDetectedCountry(countryInput, geo.country);
                }
                /* geo-filled values become the new baseline so the button
                   only lights up for genuine manual edits */
                if (!userEditedProfile) {
                    savedProfileSnapshot = profileFormValues();
                }
                updateSaveButtonState();
            });
        }

        /* devices: pull the latest registry from D1 first */
        if (window.EmeraldAuth && typeof window.EmeraldAuth.pollDeviceRegistry === 'function') {
            try { await window.EmeraldAuth.pollDeviceRegistry(); } catch (_) {}
        }
        var devices = await ensureDevice();
        await renderDevices(devices);
        setText('overviewDevices', (devices.length || 0) === 1
            ? '1 device signed in'
            : (devices.length || 0) + ' devices signed in');
        renderDeviceRows(devices);

        await renderStorage();
        requestAnimationFrame(function () { moveNavPill(true); });
    }

    /* Sign out of all other devices */
    var signOutAllBtn = document.getElementById('signOutAllDevicesBtn');
    if (signOutAllBtn) {
        signOutAllBtn.addEventListener('click', async function () {
            if (!confirm('Sign out of all other devices?')) return;
            signOutAllBtn.disabled = true;
            signOutAllBtn.textContent = 'Signing out…';
            try {
                var devices = await loadDevices();
                var currentId = getDeviceId();
                var others = (devices || []).filter(function (d) { return d && d.id && d.id !== currentId; });
                for (var i = 0; i < others.length; i++) {
                    try {
                        await window.EmeraldAuth.signOutDevice(others[i].id);
                    } catch (_) {}
                }
                var next = (devices || []).filter(function (d) { return d && d.id === currentId; });
                await saveDevices(next);
                await renderDevices(next);
                setText('overviewDevices', '1 device signed in');
                renderDeviceRows(next);
                showToast('All other devices signed out.');
                try {
                    window.dispatchEvent(new CustomEvent('emerald-device-removed', { detail: { all: true } }));
                } catch (_) {}
            } catch (e) {
                showToast('Could not sign out all devices.');
            } finally {
                signOutAllBtn.disabled = false;
                signOutAllBtn.textContent = 'Sign out of all other devices';
            }
        });
    }

    /* Navigation */
    document.querySelectorAll('.dash-nav-item').forEach(function (btn) {
        btn.addEventListener('click', function () {
            showSection(btn.dataset.section);
        });
    });
    document.querySelectorAll('[data-jump]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            showSection(btn.dataset.jump);
        });
    });

    /* clicking the avatar in the navbar jumps to Personal info */
    var dashUserBtn = document.getElementById('dashUserBtn');
    if (dashUserBtn) {
        dashUserBtn.addEventListener('click', function () { showSection('personal'); });
    }

    /* keep the pill glued to the active item on resize */
    window.addEventListener('resize', function () {
        moveNavPill(true);
    });

    /* Profile form */
    var profileForm = document.getElementById('profileForm');
    if (profileForm) {
        profileForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var session = null;
            try { session = await window.EmeraldAuth.getSession(); } catch (_) {}
            var email = resolveSessionEmail(session);
            var profile = await loadProfile(email) || {};
            profile.name = document.getElementById('profileName').value.trim();
            profile.birth = document.getElementById('profileBirth').value;
            profile.city = document.getElementById('profileCity').value.trim();
            profile.region = document.getElementById('profileRegion').value.trim();
            profile.country = document.getElementById('profileCountry').value;
            delete profile.language;  // field removed from the profile
            if (!profile.photo) profile.photo = (await loadProfile(email) || {}).photo || '';
            await saveProfile(email, profile);
            await renderAccount(session);
            savedProfileSnapshot = profileFormValues();
            userEditedProfile = false;
            updateSaveButtonState();
            showToast('Profile updated.');
        });
    }

    /* dirty tracking: any text input change flips the button on */
    ['profileName', 'profileCity', 'profileRegion', 'profileCountry'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', function () { userEditedProfile = true; updateSaveButtonState(); });
        el.addEventListener('change', function () { userEditedProfile = true; updateSaveButtonState(); });
    });

    /* Photo */
    var changePhotoBtn = document.getElementById('changePhotoBtn');
    var removePhotoBtn = document.getElementById('removePhotoBtn');
    var photoInput = document.getElementById('photoInput');
    if (changePhotoBtn && photoInput) {
        changePhotoBtn.addEventListener('click', function () { photoInput.click(); });
    }
    if (photoInput) {
        photoInput.addEventListener('change', async function () {
            var file = photoInput.files && photoInput.files[0];
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) {
                showToast('Image must be under 2 MB.');
                photoInput.value = '';
                return;
            }
            var reader = new FileReader();
            reader.onload = async function () {
                var dataUrl = reader.result;
                var session = null;
                try { session = await window.EmeraldAuth.getSession(); } catch (_) {}
                var email = resolveSessionEmail(session);
                var profile = await loadProfile(email) || {};
                profile.photo = dataUrl;
                await saveProfile(email, profile);
                await renderAccount(session);
                showToast('Photo updated.');
            };
            reader.readAsDataURL(file);
            photoInput.value = '';
        });
    }
    if (removePhotoBtn) {
        removePhotoBtn.addEventListener('click', async function () {
            var session = null;
            try { session = await window.EmeraldAuth.getSession(); } catch (_) {}
            var email = resolveSessionEmail(session);
            var profile = await loadProfile(email) || {};
            profile.photo = '';
            await saveProfile(email, profile);
            await renderAccount(session);
            showToast('Photo removed.');
        });
    }

    /* Password change */
    var passwordForm = document.getElementById('passwordForm');
    if (passwordForm) {
        passwordForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var session = null;
            try { session = await window.EmeraldAuth.getSession(); } catch (_) {}
            var email = resolveSessionEmail(session);
            var provider = (session && session.user && session.user.provider) || 'email';
            var msg = document.getElementById('passwordMsg');

            if (provider === 'google') {
                if (msg) msg.textContent = 'Password managed by Google.';
                return;
            }

            var current = document.getElementById('currentPassword').value;
            var newp = document.getElementById('newPassword').value;
            var confirm = document.getElementById('confirmNewPassword').value;

            if (!current || !newp || !confirm) {
                if (msg) msg.textContent = 'Please fill all fields.';
                return;
            }
            if (newp.length < 8) {
                if (msg) msg.textContent = 'New password must be at least 8 characters.';
                return;
            }
            if (newp !== confirm) {
                if (msg) msg.textContent = 'New passwords don\u2019t match.';
                return;
            }

            if (msg) msg.textContent = 'Password changing isn\u2019t available yet.';
        });
    }

    /* Data & privacy */
    var exportBtn = document.getElementById('exportDataBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', async function () {
            try {
                var data = await window.EmeraldAuth.exportAccountData();
                var blob = new Blob([JSON.stringify(data || {}, null, 2)], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'emerald-account-data.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast('Data exported.');
            } catch (e) {
                showToast('Export failed.');
            }
        });
    }

    var deleteBtn = document.getElementById('deleteDataBtn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async function () {
            if (!confirm('Delete all account data on this device?')) return;
            try {
                await waitForStorageReady();
                var data = {};
                try { data = await window.EmeraldAuth.exportAccountData(); } catch (_) {}
                if (window.EmeraldIDBStorage) {
                    Object.keys(data || {}).forEach(function (key) {
                        try { window.EmeraldIDBStorage.delete(key); } catch (_) {}
                    });
                }
                /* clear profile & devices */
                try { localStorage.removeItem('emerald.account.profile.' + resolveSessionEmail(await window.EmeraldAuth.getSession())); } catch (_) {}
                try { localStorage.removeItem('emerald.account.devices'); } catch (_) {}
                showToast('Data deleted.');
                var session = null;
                try { session = await window.EmeraldAuth.getSession(); } catch (_) {}
                if (session) await renderAccount(session);
                await renderStorage();
            } catch (e) {
                showToast('Delete failed.');
            }
        });
    }

    /* Dashboard sign out */
    var dashSignOut = document.getElementById('dashSignOutBtn');
    if (dashSignOut && logoutBtn) {
        dashSignOut.addEventListener('click', function () { logoutBtn.click(); });
    }

    /* ---------------- Footer year ---------------- */

    var yearEl = document.getElementById('footerYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    /* ---------------- Star field ---------------- */

    var visualStars = document.getElementById('visualStars');
    if (visualStars) {
        var count = window.innerWidth <= 860 ? 45 : 110;
        for (var i = 0; i < count; i++) {
            var star = document.createElement('span');
            var size = (Math.random() * 1.6 + 0.6).toFixed(2);
            star.style.left = (Math.random() * 100).toFixed(2) + '%';
            star.style.top = (Math.random() * 100).toFixed(2) + '%';
            star.style.width = size + 'px';
            star.style.height = size + 'px';
            star.style.animationDuration = (2.5 + Math.random() * 4).toFixed(2) + 's';
            star.style.animationDelay = (Math.random() * 5).toFixed(2) + 's';
            if (Math.random() < 0.06) {
                star.style.boxShadow = '0 0 6px 1px rgba(180, 255, 200, 0.9)';
                star.style.width = (parseFloat(size) + 1.2).toFixed(2) + 'px';
                star.style.height = (parseFloat(size) + 1.2).toFixed(2) + 'px';
            }
            var pick = Math.random();
            star.style.background =
                pick < 0.20 ? 'rgba(255, 255, 255, 0.95)' :
                    (pick < 0.45 ? 'rgba(230, 255, 235, 0.85)' :
                        'rgba(255, 255, 255, 0.70)');
            visualStars.appendChild(star);
        }
    }

    /* ---------------- Init ---------------- */

    var params = new URLSearchParams(window.location.search);
    initBirthdayPicker();
    activateMode(params.get('tab') === 'register' ? 'register' : 'login', false);

    refreshSessionView().catch(function () {});
    startSessionMonitor();

    // Immediately sync devices on page load so other devices appear right away
    if (window.EmeraldAuth && typeof window.EmeraldAuth.pollDeviceRegistry === 'function') {
        window.EmeraldAuth.pollDeviceRegistry().catch(function () {});
    }

    async function refreshSyncedDevices(snapshot) {
        var list = snapshot && Array.isArray(snapshot['emerald.account.devices'])
            ? snapshot['emerald.account.devices']
            : null;
        if (!Array.isArray(list)) {
            try { list = await loadDevices(); } catch (_) { list = []; }
        }
        var signOutRequests = snapshot && snapshot['emerald.account.signout_requests'];
        if (!signOutRequests || typeof signOutRequests !== 'object') signOutRequests = {};

        // Drop devices that have been signed out.
        list = (Array.isArray(list) ? list : []).filter(function (device) {
            if (!device || !device.id) return false;
            return !signOutRequests[device.id];
        });

        var currentId = getDeviceId();
        var unique = [];
        var seen = {};
        list.forEach(function (device) {
            if (!device || !device.id || seen[device.id]) return;
            seen[device.id] = true;
            unique.push(Object.assign({}, device, { current: device.id === currentId }));
        });
        if (!seen[currentId]) {
            unique.unshift(Object.assign({}, currentDeviceInfo(), { current: true }));
        }

        await saveDevices(unique);
        await renderDevices(unique);
        setText('overviewDevices', unique.length === 1
            ? '1 device signed in'
            : unique.length + ' devices signed in');
        renderDeviceRows(unique);
    }

    window.addEventListener('emerald-sync-complete', function (event) {
        var snapshot = event && event.detail && event.detail.snapshot;
        refreshSyncedDevices(snapshot).catch(function () {});
    });

    window.addEventListener('emerald-device-removed', function () {
        if (window.EmeraldAuth && typeof window.EmeraldAuth.syncCurrentData === 'function') {
            window.EmeraldAuth.syncCurrentData().catch(function () {});
        }
    });

    window.addEventListener('focus', function () {
        if (window.EmeraldAuth && typeof window.EmeraldAuth.syncCurrentData === 'function') {
            window.EmeraldAuth.syncCurrentData().catch(function () {});
        }
    });

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && window.EmeraldAuth && typeof window.EmeraldAuth.syncCurrentData === 'function') {
            window.EmeraldAuth.syncCurrentData().catch(function () {});
        }
    });

    var authError = params.get('error');
    if (authError) {
        var message = 'Authentication failed.';
        if (authError === 'no_account') message = 'No account found. Please create an account first.';
        else if (authError === 'already_account') message = 'You already have an account. Please sign in instead.';
        else if (authError === 'oauth_failed') message = 'Google sign-in failed. Please try again.';
        else if (authError === 'email_missing') message = 'Google did not return an email. Please try a different account.';
        else if (authError === 'email_unverified') message = 'Google did not verify this email address. Please use a verified Google account.';
        showToast(message);
    }

    ready = true;
})();

/* ---------------- Wiki-style settings search (Ctrl/⌘+K, arrow nav) --------------- */

(function () {
    var input = document.getElementById('dashSearchInput');
    var box = document.getElementById('dashSearchResults');
    var clearBtn = box ? box.parentElement.querySelector('.dash-search-clear') : null;
    if (!input || !box) return;

    var icons = {
        overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
        personal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        devices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>',
        security: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
        data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>',
        storage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>'
    };

    var items = [
        { label: 'Overview', key: 'overview', hint: 'Your account at a glance', words: ['home', 'summary', 'dashboard'] },
        { label: 'Personal info', key: 'personal', hint: 'Name, birthday, city, region, country', words: ['profile', 'photo', 'name', 'birth', 'region', 'country', 'city'] },
        { label: 'Devices', key: 'devices', hint: 'Signed-in devices', words: ['device', 'sessions', 'computers'] },
        { label: 'Security', key: 'security', hint: 'Email address & password', words: ['email', 'password', 'login', 'google'] },
        { label: 'Data & privacy', key: 'data', hint: 'Download or delete your data', words: ['export', 'download', 'delete', 'privacy'] },
        { label: 'Storage', key: 'storage', hint: 'Usage and quota', words: ['space', 'quota', 'usage'] }
    ];

    var matches = [];
    var cursor = -1;

    function hide() {
        box.classList.remove('show');
        box.innerHTML = '';
        matches = [];
        cursor = -1;
    }

    function update(q) {
        var query = (q || '').trim().toLowerCase();
        if (!query) { hide(); return; }
        matches = items.filter(function (it) {
            var hay = (it.label + ' ' + it.hint + ' ' + (it.words || []).join(' ')).toLowerCase();
            return hay.indexOf(query) !== -1;
        });
        cursor = matches.length ? 0 : -1;
        render();
    }

    function render() {
        box.innerHTML = '';
        if (!matches.length) {
            box.classList.add('show');
            var empty = document.createElement('div');
            empty.className = 'dash-search-empty';
            empty.textContent = 'No matching settings.';
            box.appendChild(empty);
            return;
        }
        matches.forEach(function (item, idx) {
            var row = document.createElement('div');
            row.className = 'dash-search-result' + (idx === cursor ? ' active' : '');
            row.setAttribute('role', 'option');

            var icon = document.createElement('span');
            icon.className = 'dsr-icon';
            icon.innerHTML = icons[item.key] || '';
            row.appendChild(icon);

            var text = document.createElement('div');
            text.className = 'dsr-text';
            var label = document.createElement('div');
            label.className = 'dsr-label';
            label.textContent = item.label;
            var hint = document.createElement('div');
            hint.className = 'dsr-hint';
            hint.textContent = item.hint;
            text.appendChild(label);
            text.appendChild(hint);
            row.appendChild(text);

            var kbd = document.createElement('kbd');
            kbd.textContent = 'Enter';
            row.appendChild(kbd);

            row.addEventListener('click', function () { go(item); });
            box.appendChild(row);
        });
        box.classList.add('show');
    }

    function go(item) {
        hide();
        input.value = '';
        clearBtn && (clearBtn.style.display = 'none');
        if (window.showSection) window.showSection(item.key);
        input.blur();
    }

    function update(q) {
        var query = (q || '').trim().toLowerCase();
        if (!query) { hide(); return; }
        matches = items.filter(function (it) { return it.label.toLowerCase().indexOf(query) !== -1; });
        cursor = matches.length ? 0 : -1;
        render();
    }

    input.addEventListener('input', function () { update(input.value); });
    input.addEventListener('focus', function () { update(input.value); });
    input.addEventListener('keydown', function (e) {
        if (!box.classList.contains('show')) return;
        if (e.key === 'ArrowDown' && matches.length) {
            cursor = (cursor + 1) % matches.length;
            render();
            e.preventDefault();
        } else if (e.key === 'ArrowUp' && matches.length) {
            cursor = (cursor - 1 + matches.length) % matches.length;
            render();
            e.preventDefault();
        } else if (e.key === 'Enter' && matches.length) {
            go(matches[cursor]);
            e.preventDefault();
        } else if (e.key === 'Escape') {
            hide();
            input.blur();
        }
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            input.value = '';
            hide();
            input.focus();
        });
    }

    /* click outside closes */
    document.addEventListener('click', function (e) {
        if (!box.contains(e.target) && e.target !== input) hide();
    });

    /* Ctrl/⌘+K focuses the search like the wiki */
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
            input.focus();
            e.preventDefault();
        }
    });
})();
