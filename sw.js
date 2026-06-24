// VRT service worker v7: remove stale cached app shells and pass through network.
// The app now runs directly from index.html; this worker only cleans old caches.

const CACHE_PREFIX = 'vrt-';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => key.startsWith(CACHE_PREFIX) ? caches.delete(key) : undefined));
    await self.clients.claim();
    await self.registration.unregister().catch(() => undefined);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      const url = new URL(client.url);
      if (url.searchParams.get('vrt-direct') !== 'v7') {
        url.searchParams.set('vrt-direct', 'v7');
        client.navigate(url.toString()).catch(() => undefined);
      }
    }
  })());
});

self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request)));
});
