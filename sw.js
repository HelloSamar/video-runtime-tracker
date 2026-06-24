/**
 * VRT — Video Runtime Tracker
 * Service Worker: network-first app shell with a scan hotfix injector.
 */

const CACHE = 'vrt-v4';
const PRECACHE = ['./', './index.html', './worker.js', './manifest.json', './icon.svg', './vrt-hotfix.js'];
const HOTFIX_TAG = '<script src="./vrt-hotfix.js?v=v4"></script>';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function htmlWithHotfix(res) {
  if (!res) return res;

  const text = await res.text();
  const patched = text.includes('vrt-hotfix.js')
    ? text
    : text.replace('</body>', `  ${HOTFIX_TAG}\n</body>`);

  const headers = new Headers(res.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-cache');

  return new Response(patched, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function networkFirst(request, cacheName = CACHE) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request, { cache: 'no-store' });
    if (res && res.status === 200 && res.type === 'basic') cache.put(request, res.clone());
    return res;
  } catch (_) {
    return cache.match(request);
  }
}

self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return;

  const url = new URL(e.request.url);
  const isHTML = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  const isHotfix = url.pathname.endsWith('/vrt-hotfix.js');
  const isWorker = url.pathname.endsWith('/worker.js');

  if (isHTML) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const network = await fetch(e.request, { cache: 'no-store' });
        const patched = await htmlWithHotfix(network);
        cache.put(e.request, patched.clone());
        return patched;
      } catch (_) {
        const cached = await cache.match(e.request) || await cache.match('./index.html');
        return cached ? htmlWithHotfix(cached) : cached;
      }
    })());
    return;
  }

  if (isHotfix || isWorker) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});
