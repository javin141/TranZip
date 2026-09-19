/*
 * TranZip service worker - deliberately minimal.
 *
 * It caches the APP SHELL only (the page, its built JS/CSS, icon, manifest) so
 * the app opens with no signal, e.g. underground. It never touches /api/*:
 * live crowd, arrival and alert data must not be replayed from a cache as if
 * it were current (the page shows its own saved journey, clearly labelled as
 * out of date, instead). Map tiles are cross-origin and are left to the
 * browser, so the map is blank offline but the route is still listed.
 *
 * `__BUILD_ID__` is replaced with a per-build value when `vite build` runs
 * (see vite.config.js), so every deploy changes this file's bytes, the
 * browser installs it as an update, and old caches are deleted on activate.
 */

const CACHE_PREFIX = 'tranzip-shell-';
const CACHE_NAME = `${CACHE_PREFIX}__BUILD_ID__`;
const STATIC_FILES = ['/manifest.webmanifest', '/icon.jpg'];
// With a bad or absent connection, don't make someone wait on the network for the page.
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await fetch('/', { cache: 'reload' });
    if (!response.ok) throw new Error(`Shell fetch failed (${response.status})`);
    const html = await response.clone().text();
    await cache.put('/', response);

    // The built page names its hashed script and stylesheet: cache exactly those.
    const files = new Set(STATIC_FILES);
    for (const match of html.matchAll(/(?:src|href)=["'](\/[^"'?#]+)["']/g)) {
      if (!match[1].startsWith('//') && !match[1].startsWith('/api/')) files.add(match[1]);
    }
    await Promise.all([...files].map((file) => cache.add(file).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('timeout')), ms); }),
  ]);
}

/** Page loads: the network when it answers in time (and refresh the cached copy), else the cached shell. */
async function pageRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
      cache.put('/', response.clone());
    }
    return response;
  } catch {
    return (await cache.match('/')) || Response.error();
  }
}

/** Built assets are content-hashed, so a cached copy is always the right one. */
async function assetRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // map tiles and other third parties
  if (url.pathname.startsWith('/api/')) return; // live data: always the network, never a cache

  if (request.mode === 'navigate') {
    event.respondWith(pageRequest(request));
  } else if (url.pathname.startsWith('/assets/') || STATIC_FILES.includes(url.pathname)) {
    event.respondWith(assetRequest(request));
  }
});
