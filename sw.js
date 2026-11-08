const CACHE_NAME = "emeraldnetwork.emeraldcore.serviceWorker.v5.2026.10.14";
const OFFLINE_URL = "./offline.html";

const ASSETS_TO_CACHE = [
  "./offline.html",
  "./assets/styles/style.css",
  "./assets/images/nointernet.webp",
  "./assets/images/favicon.webp",
  "./assets/images/favicon.ico",
  "./assets/scripts/animationvisible.js",
  "./assets/scripts/scrollice.js",
  "./assets/scripts/rightclick.js",

  "./assets/scripts/dropdown.js",
  "./assets/scripts/offline.js"
];

const CACHED_PATHS = new Set(
  ASSETS_TO_CACHE.map((asset) => new URL(asset, self.location.href).pathname)
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.open(CACHE_NAME).then((cache) => cache.match(OFFLINE_URL))
      )
    );
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && CACHED_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
