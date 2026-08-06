// Minimal service worker: makes the app installable and survives flaky
// connections. Live data (/api, /ws) is NEVER cached — charts and signals
// always come from the network.
const CACHE = "mwb-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add("/")));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  if (e.request.mode === "navigate") {
    // Network-first for pages; cached shell only as an offline fallback.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put("/", res.clone()));
          return res.clone();
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Hashed build assets + icons: cache-first (immutable by filename).
  if (url.pathname.startsWith("/assets/") || /\.(png|svg|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
      )
    );
  }
});
