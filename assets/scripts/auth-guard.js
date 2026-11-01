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
            var current = window.location.pathname + window.location.search;
            try { sessionStorage.setItem('emerald.auth.return_url', current); } catch (_) {}
            window.location.href = '/account.html?redirect=' + encodeURIComponent(current);
        }
    }

    runGuard();
}());
