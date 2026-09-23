// Framesmith service worker: offline app shell + "Share to Framesmith" on mobile.
const VERSION = 'fs-v3';
const SHELL = [
  '/',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/main.js',
  '/js/layout.js',
  '/js/render.js',
  '/js/backgrounds.js',
  '/js/annotations.js',
  '/js/history.js',
  '/js/trim.js',
  '/js/demo.js',
  '/js/crop.js',
  '/js/palette.js',
  '/js/session.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'fs-share' && k !== 'fs-fonts').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Web Share Target: stash the shared image, then open the editor.
  if (request.method === 'POST' && url.pathname === '/share') {
    e.respondWith(
      (async () => {
        try {
          const form = await request.formData();
          const file = form.get('image');
          if (file) {
            const cache = await caches.open('fs-share');
            await cache.put('/shared-image', new Response(file, { headers: { 'content-type': file.type } }));
          }
        } catch {
          /* fall through to the editor */
        }
        return Response.redirect('/?shared=1', 303);
      })(),
    );
    return;
  }

  if (request.method !== 'GET') return;

  // Fonts: cache-first, they never change.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open('fs-fonts').then(async (c) => {
        const hit = await c.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok || res.type === 'opaque') c.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // App files: network-first so deploys land immediately, cache as the offline fallback.
  e.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch {
        return (await cache.match(request, { ignoreSearch: request.mode === 'navigate' })) || (await cache.match('/'));
      }
    })(),
  );
});
