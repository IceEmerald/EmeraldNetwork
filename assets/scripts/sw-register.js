if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function (registration) {
        console.log('Service Worker registered!');
        registration.addEventListener('updatefound', function () {
            var newWorker = registration.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', function () {
                if (newWorker.state === 'activated') {
                    window.location.reload();
                }
            });
        });
    }).catch(function (err) {
        // A failed registration (insecure context, unsupported host, bad
        // MIME type) rejects with no handler, producing an unhandled
        // rejection on every page load.
        console.warn('Service Worker registration failed:', err);
    });
}