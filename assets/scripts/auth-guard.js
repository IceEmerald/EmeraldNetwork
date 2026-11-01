(function () {
    'use strict';

    var protectedPages = [
        '/docs.html',
        '/notes.html',
        '/sheets.html',
        '/slides.html',
        '/aichat.html',
        '/flowchart.html',
        '/emeraldsuite.html'
    ];

    function isProtectedPage(pathname) {
        if (!pathname) return false;
        var normalized = pathname.replace(/\\/g, '/');
        return protectedPages.some(function (page) {
            return normalized === page || normalized.endsWith(page);
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
