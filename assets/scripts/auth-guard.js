(function () {
    'use strict';

    var protectedPages = [
        '/docs',
        '/notes',
        '/sheets',
        '/slides',
        '/aichat',
        '/flowchart',
        '/emeraldsuite',
        '/search',
        '/services'
    ];

    function isProtectedPage(pathname) {
        if (!pathname) return false;
        var normalized = (pathname || '').replace(/\\/g, '/').split('?')[0].replace(/\/+$/, '');
        if (!normalized) return false;

        return protectedPages.some(function (page) {
            var base = page.replace(/\/+$/, '');
            return normalized === base || normalized === base + '.html';
        });
    }

    async function runGuard() {
        if (!window.EmeraldAuth || !window.EmeraldAuth.getSession) return;
        if (window.location.pathname === '/account.html' || window.location.pathname.endsWith('/account.html')) {
            return;
        }

        if (!isProtectedPage(window.location.pathname)) {
            return;
        }

        var session = await window.EmeraldAuth.getSession();
        if (!session || !session.user || !session.token) {
            var current = new URL(window.location.href);
            current.searchParams.delete('auth_session');
            current.searchParams.delete('auth_email');
            current.searchParams.delete('auth_provider');
            var finalCurrent = current.origin + current.pathname + current.search;
            try { sessionStorage.setItem('emerald.auth.return_url', finalCurrent); } catch (_) {}
            var accountUrl = '/account.html?redirect=' + encodeURIComponent(finalCurrent);
            window.location.replace(accountUrl);
            return;
        }

        try {
            if (window.EmeraldAuth && typeof window.EmeraldAuth.startAutoSync === 'function') {
                window.EmeraldAuth.startAutoSync();
            }
        } catch (_) {}
    }

    function wireAuthListener() {
        window.addEventListener('emerald-auth-changed', function () {
            runGuard().catch(function () {});
        });
        window.addEventListener('storage', function (event) {
            if (!event.key || event.key.indexOf('emerald.auth') !== -1) {
                runGuard().catch(function () {});
            }
        });
    }

    runGuard();
    wireAuthListener();
}());
