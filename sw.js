// VRT service worker v9: cleanup only, then allow network-first GitHub Pages.
const CACHE_PREFIX = 'vrt-';
const TARGET_PARAM = 'vrt-mediainfo';
const TARGET_VERSION = 'v9';

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
      if (url.searchParams.get(TARGET_PARAM) !== TARGET_VERSION) {
        url.searchParams.set(TARGET_PARAM, TARGET_VERSION);
        client.navigate(url.toString()).catch(() => undefined);
      }
    }
  })());
});

self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request)));
});
