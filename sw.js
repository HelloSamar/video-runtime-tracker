/**
 * VRT — Video Runtime Tracker
 * Service Worker: force-refresh app shell and inject scanner hotfix.
 *
 * GitHub Pages + an older service worker can keep serving the old inline
 * index.html scanner. This version deletes every old VRT cache, takes control
 * immediately, reloads open clients once, and injects the latest hotfix into
 * every HTML navigation response.
 */

const CACHE = 'vrt-v6';
const PRECACHE = ['./', './index.html', './worker.js', './manifest.json', './icon.svg', './vrt-hotfix.js'];
const REFRESH_PARAM = 'v6';
const HOTFIX_TAG = '<script src="./vrt-hotfix.js?v=v6"></script>';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => key.startsWith('vrt-') ? caches.delete(key) : undefined));
    await caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).catch(() => undefined);
    await self.clients.claim();

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map(client => {
      const url = new URL(client.url);
      if (url.searchParams.get('vrt-refresh') === REFRESH_PARAM) return undefined;
      url.searchParams.set('vrt-refresh', REFRESH_PARAM);
      return client.navigate(url.toString()).catch(() => undefined);
    }));
  })());
});

function isHTMLRequest(request) {
  const url = new URL(request.url);
  return request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
}

async function htmlWithHotfix(response) {
  if (!response) return response;

  const html = await response.text();
  const withoutOldHotfix = html.replace(/<script\s+src=["'][^"']*vrt-hotfix\.js[^"']*["']\s*><\/script>\s*/ig, '');
  const patched = withoutOldHotfix.replace(/<\/body>\s*<\/html>\s*$/i, `  ${HOTFIX_TAG}\n</body>\n</html>`);

  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'pragma': 'no-cache',
      'expires': '0',
    },
  });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.status === 200 && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cache = await caches.open(CACHE);
    return cache.match(request);
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (isHTMLRequest(event.request)) {
    event.respondWith((async () => {
      try {
        const network = await fetch(event.request, { cache: 'no-store' });
        return htmlWithHotfix(network);
      } catch (_) {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(event.request) || await cache.match('./index.html') || await cache.match('./');
        return cached ? htmlWithHotfix(cached) : Response.error();
      }
    })());
    return;
  }

  if (url.pathname.endsWith('/vrt-hotfix.js') || url.pathname.endsWith('/worker.js') || url.pathname.endsWith('/sw.js')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response && response.status === 200 && response.type === 'basic') {
        caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
      }
      return response;
    }))
  );
});
