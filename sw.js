/**
 * WiseQuiz Service Worker
 *
 * Strategy:
 *  - App shell (HTML, CSS, JS)  → Cache-first  (fast repeat loads)
 *  - Data files (data/*.json)   → Network-first (always try to get fresh questions)
 *  - Google Fonts               → Cache-first with long TTL
 *  - Everything else            → Network-first with cache fallback
 *
 * Versioning: bump CACHE_NAME whenever the shell changes so old caches
 * are cleaned up on the next activate event.
 */

const CACHE_NAME  = 'wisequiz-shell-v1';
const DATA_CACHE  = 'wisequiz-data-v1';
const FONT_CACHE  = 'wisequiz-fonts-v1';

// Files that form the app shell — pre-cached on install
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/* ── Install ────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // activate immediately, don't wait for old SW to die
  );
});

/* ── Activate ───────────────────────────────────── */
self.addEventListener('activate', (event) => {
  const KEEP = new Set([CACHE_NAME, DATA_CACHE, FONT_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => !KEEP.has(key))   // delete any cache not in our keep-set
          .map((key)  => caches.delete(key))
      ))
      .then(() => self.clients.claim())       // take control of all open tabs immediately
  );
});

/* ── Fetch ──────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ── Google Fonts: cache-first, very long TTL ───
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // ── Data files: network-first ─────────────────
  if (url.pathname.startsWith('/data/') || url.pathname.endsWith('.json')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // ── App shell: cache-first ────────────────────
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // ── Everything else: network-first ────────────
  event.respondWith(networkFirst(request, CACHE_NAME));
});

/* ── Strategy helpers ───────────────────────────── */

/**
 * Cache-first: serve from cache if available, otherwise fetch and cache.
 * Best for assets that change only when the cache version bumps.
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // No network and not cached — return a minimal offline response
    return offlineFallback(request);
  }
}

/**
 * Network-first: always try the network. Falls back to cache when offline.
 * Best for data files where freshness matters.
 */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineFallback(request);
  }
}

/**
 * Offline fallback: return the cached home page for navigation requests,
 * or a minimal JSON error for data requests, or a 503 for anything else.
 */
async function offlineFallback(request) {
  const accept = request.headers.get('Accept') || '';

  if (accept.includes('text/html')) {
    const cached = await caches.match('/index.html');
    return cached || new Response('<h1>WiseQuiz — offline</h1><p>Your cached decks are still available. Reload once you\'re back online.</p>', {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (accept.includes('application/json') || request.url.endsWith('.json')) {
    return new Response(JSON.stringify({ error: 'offline', message: 'Data unavailable offline.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Offline', { status: 503 });
}

/* ── Message handler ────────────────────────────── */
// Lets the page trigger a manual cache refresh:  navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' })
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
