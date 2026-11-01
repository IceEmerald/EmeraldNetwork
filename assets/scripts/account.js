/* ============================================================
   EmeraldNetwork — Authentication page behaviour (account.html)
   • Login/register mode switch (top-right link + ?tab=register)
   • Client-side validation with inline, temporary errors
   • Backend-less actions (social auth, forgot password, demo
     submit) surface through the site-wide #custom-toast toast,
     matching index.html / notes.html behaviour

   NOTE (backend hookup): submit handlers stop short of any
   real request — replace the showToast "demo" call at the end
   of validateLoginForm / validateRegisterForm handling with a
   fetch() to the auth API.
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

    /* deconstruct-and-rebuild arrow so the ↗ tracker matches the mockup */
    var ARROW = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';

    /* deconstruct-and-rebuild arrow so the ↗ tracker matches the mockup */
    var ARROW = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';

    var COPY = {
        login: {
            title: 'Welcome back!',
            subtitle: 'Sign in to your EmeraldNetwork account.',
            note: '<span class="switch-prefix">New to EmeraldNetwork? </span><a href="#" id="modeSwitch">Create an account</a>'
        },
        register: {
            title: 'Create your account.',
            subtitle: 'Create an account to get started with EmeraldNetwork.',
            note: '<span class="switch-prefix">Already have an account? </span><a href="#" id="modeSwitch">Sign in</a>'
        }
    };

    var ready = false;

    function activateMode(name, animate) {
        if (animate && ready) {
            var card = document.querySelector('.auth-inner');
            card.classList.add('is-switching');
            setTimeout(function () {
                // peak blur: swap content, then show it blurred before unblurring
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

    function applyMode(name) {
        currentMode = name;
        Object.keys(forms).forEach(function (key) {
            var form = forms[key];
            var isActive = key === name;
            form.classList.toggle('active', isActive);
            form.hidden = !isActive;
            /* clear leftover errors when leaving a form */
            if (!isActive) clearFormErrors(form);
        });
        title.textContent = COPY[name].title;
        subtitle.textContent = COPY[name].subtitle;
        switchNote.innerHTML = COPY[name].note;
    }

    /* Delegated, so clicks survive the note text being rewritten */
    switchNote.addEventListener('click', function (e) {
        var link = e.target.closest ? e.target.closest('#modeSwitch') : null;
        if (!link) return;
        e.preventDefault();
        activateMode(currentMode === 'login' ? 'register' : 'login', true);
    });

    /* ---------------- Toast (site-wide pattern) ---------------- */

    var toastTimer;

    /* Site-wide toast icon (matches rightclick.js / index.html pattern:
       glyph, vertical-aligned, muted, no colour of its own) */
    var TOAST_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px;opacity:0.7"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

    function showToast(message) {
        var toast = document.getElementById('custom-toast');
        if (!toast) return;
        toast.innerHTML = TOAST_ICON + message;
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
        Array.prototype.slice
            .call(form.querySelectorAll('input'))
            .forEach(function (input) {
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

    async function submitAuthRequest(mode) {
        var email = mode === 'login'
            ? document.getElementById('login-email').value.trim()
            : document.getElementById('register-email').value.trim();
        var password = mode === 'login'
            ? document.getElementById('login-password').value
            : document.getElementById('register-password').value;

        var apiBase = window.EmeraldAuth && window.EmeraldAuth.getApiBase
            ? window.EmeraldAuth.getApiBase()
            : 'https://emeraldnetwork-auth.iceemerald.workers.dev';

        try {
            showToast(mode === 'login' ? 'Signing in…' : 'Creating your account…');
            var result = mode === 'login'
                ? await window.EmeraldAuth.login(email, password)
                : await window.EmeraldAuth.register(email, password);

            if (result && result.redirectUrl) {
                window.location.href = result.redirectUrl;
                return;
            }

            window.location.href = window.EmeraldAuth.getReturnUrl();
        } catch (error) {
            var message = error && error.message ? error.message : 'Authentication failed.';
            showToast(message);
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

    /* Silent match-state update while typing (no error shown yet) */
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

    /* Show the mismatch error only once the user leaves the field */
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

    /* Email structure check on blur (gentle: no error while typing) */
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

    /* ---------------- Social buttons (OAuth stubs) ---------------- */

    function oauthStub(provider) {
        if (!window.EmeraldAuth || !window.EmeraldAuth.beginOAuth) {
            showToast('OAuth is not available yet. Set up the Cloudflare auth worker first.');
            return;
        }
        window.EmeraldAuth.beginOAuth(provider);
    }

    document.getElementById('googleBtn').addEventListener('click', function () {
        oauthStub('Google');
    });

    /* ---------------- Forgot password ---------------- */

    document.getElementById('forgotLink').addEventListener('click', function (e) {
        e.preventDefault();
        showToast('Password reset will arrive with the account backend hookup.');
    });

    /* ---------------- Password show / hide ---------------- */

    Array.prototype.slice.call(document.querySelectorAll('.pw-toggle'))
        .forEach(function (toggle) {
            var input = document.getElementById(toggle.dataset.target);
            if (!input) return;
            toggle.addEventListener('click', function () {
                var show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                toggle.setAttribute('aria-pressed', String(show));
                toggle.setAttribute('aria-label',
                    show ? 'Hide password' : 'Show password');
                input.focus();
            });
        });

    /* ---------------- Footer year ---------------- */

    var yearEl = document.getElementById('footerYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    /* ---------------- Star field for the sky half ---------------- */

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
            star.style.animationDuration =
                (2.5 + Math.random() * 4).toFixed(2) + 's';
            star.style.animationDelay = (Math.random() * 5).toFixed(2) + 's';
            /* occasional brighter star with a halo */
            if (Math.random() < 0.06) {
                star.style.boxShadow = '0 0 6px 1px rgba(180, 255, 200, 0.9)';
                star.style.width = (parseFloat(size) + 1.2).toFixed(2) + 'px';
                star.style.height = (parseFloat(size) + 1.2).toFixed(2) + 'px';
            }
            /* subtle sparkle variety — light */
            var pick = Math.random();
            star.style.background =
                pick < 0.20 ? 'rgba(255, 255, 255, 0.95)' :
                    (pick < 0.45 ? 'rgba(230, 255, 235, 0.85)' :
                        'rgba(255, 255, 255, 0.70)');
            visualStars.appendChild(star);
        }
    }

    /* ---------------- Init: honor ?tab=register deep link ---------------- */

    var params = new URLSearchParams(window.location.search);
    activateMode(params.get('tab') === 'register' ? 'register' : 'login', false);
    ready = true;
})();
