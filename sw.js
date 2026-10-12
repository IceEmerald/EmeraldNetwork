const CACHE_NAME = "emeraldnetwork.emeraldcore.serviceWorker.v4.26.18.07";
const OFFLINE_URL = "./offline.html";

const ASSETS_TO_CACHE = [
  "./offline.html",
  "./assets/styles/style.css",  
  "./assets/images/nointernet.webp", 
  "./assets/images/favicon.webp",
  "./assets/scripts/animationvisible.js",
  "./assets/scripts/scrollice.js",
  "./assets/scripts/rightclick.js",
  // These two are what offline.html actually loads. They were missing, so
  // the offline page booted without its script and its nav behaviour, and
  // both requests fell through to the (dead) network.
  "./assets/scripts/dropdown.js",
  "./assets/scripts/offline.js"
];

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
  // Only handle full-page navigations
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.open(CACHE_NAME).then((cache) => cache.match(OFFLINE_URL))
      )
    );
  }
  // For CSS/JS/images requested by offline.html
  else if (ASSETS_TO_CACHE.some((asset) => event.request.url.includes(asset.replace("./", "")))) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
