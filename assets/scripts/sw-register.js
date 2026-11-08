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

        console.warn('Service Worker registration failed:', err);
    });
}