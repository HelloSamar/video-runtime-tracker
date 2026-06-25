/* ─────────────────────────────────────────────────────
   Video Runtime Tracker — Service Worker v10
   Strategy:
     • On install  → cache v10 assets, skip waiting
     • On activate → DELETE all old vrt-* caches, claim clients
     • On fetch    → network-first for HTML navigation (always fresh),
                     cache-first for static assets (icon, manifest, sw)
   ───────────────────────────────────────────────────── */
const CACHE_NAME = 'vrt-v10';
const PRECACHE   = ['./', './index.html', './icon.svg', './manifest.json', './sw.js'];

/* ── INSTALL: pre-cache v10 assets and take over immediately ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .catch(() => { /* non-fatal — works without pre-cache */ })
  );
  self.skipWaiting(); // activate without waiting for old SW clients to close
});

/* ── ACTIVATE: purge every other vrt-* cache, then claim all tabs ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k !== CACHE_NAME)          // keep only vrt-v10
            .map(k => {
              console.log('[SW v10] deleting stale cache:', k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())              // take over all open tabs immediately
  );
});

/* ── FETCH: network-first for navigation, cache-first for assets ── */
self.addEventListener('fetch', event => {
  const req = event.request;

  /* Only handle GET requests */
  if (req.method !== 'GET') return;

  /* Navigation requests (HTML pages): always try network first
     so users never get stuck on a stale cached version */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          /* Cache a fresh copy for offline fallback */
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  /* Static assets: cache-first (they're versioned via cache name) */
  event.respondWith(
    caches.match(req)
      .then(cached => {
        if (cached) return cached;
        return fetch(req).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return response;
        });
      })
      .catch(() => { /* offline and not cached — let it fail naturally */ })
  );
});
