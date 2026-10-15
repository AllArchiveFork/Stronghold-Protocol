// Classic service worker for art a player imported on this origin, and (fork) the runtime art cache.
// Keep these three lines in sync with public/js/assetCache.js (that module documents why this file is not a module).
const IMPORTED_ASSET_CACHE = 'sp-imported-assets-v1';
const IMPORTED_ASSET_CACHE_PREFIX = 'sp-imported-assets-';
const IMPORTED_ASSET_PATH = /^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//;

// Runtime art cache (fork 2026-10-16, after xinhai-ai/Stronghold-Protocol 4b47e3d). Only when the page registered this
// worker as /sw.js?material=<profile> (public/js/assetCache.js assetWorkerUrl; the profile comes from /code-source.json).
// A same-origin GET of public art — the /assets/ and /media/ paths public/js/materialFallback.js accepts, with no query
// or its OpenI retry `?sp_source=openi` — is answered from Cache Storage by its path, so the provider's rotating signed
// redirect does not download the same file again; the OpenI retry fills the same entry. A miss is fetched in CORS mode
// (an opaque response can be neither checked nor kept: Chrome charges megabytes of quota for each) and only a complete
// 200 that is not an HTML error page is kept. Another profile is another cache: activating one drops the others.
// Range requests, other paths and other origins never reach it.
const MATERIAL_CACHE_PREFIX = 'sp-material-';
const MATERIAL_PROFILE = (() => {
  try {
    const value = new URL(self.location.href).searchParams.get('material');
    return value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
  } catch { return null; }
})();
const MATERIAL_CACHE = MATERIAL_PROFILE ? MATERIAL_CACHE_PREFIX + MATERIAL_PROFILE : null;
const MATERIAL_EXTENSIONS = /\.(?:png|jpg|jpeg|webp|gif|atlas|skel|obj|mtl|json|mp3|m4a|aac|ogg|oga|opus|wav)$/;

/** The cache key (origin + path) of a public art URL, or null. */
function materialKey(url) {
  const query = [...url.searchParams];
  if (query.length && (query.length !== 1 || query[0][0] !== 'sp_source' || query[0][1] !== 'openi')) return null;
  if (/%(?:2f|5c)/i.test(url.pathname)) return null;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (!/^\/(?:assets|media)\//.test(path)) return null;
  if (path.split('/').slice(1).some((s) => !/^[A-Za-z0-9_[\]-][A-Za-z0-9_.[\]-]*$/.test(s) || s.endsWith('.'))) return null;
  if (path.startsWith('/assets/') && !MATERIAL_EXTENSIONS.test(path)) return null;
  return url.origin + url.pathname;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (name.startsWith(IMPORTED_ASSET_CACHE_PREFIX) && name !== IMPORTED_ASSET_CACHE)
        // a worker without a profile (its page could not read /code-source.json) leaves the art cache to the next one
        || (MATERIAL_CACHE && name.startsWith(MATERIAL_CACHE_PREFIX) && name !== MATERIAL_CACHE))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function importedAsset(request, url) {
  const cache = await caches.open(IMPORTED_ASSET_CACHE);
  // The exact key: an import stores each URL without a query, so the path is the key. `ignoreSearch` would make
  // Chrome scan every entry — about 4 s per request once a whole pack (some 43,000 entries) is imported.
  const hit = await cache.match(url.origin + url.pathname);
  if (hit) return hit;
  // Do not cache the network response. The browser's own HTTP cache still applies to this fetch.
  return fetch(request);
}

async function runtimeArt(event, request, key) {
  let cache = null;
  try {
    cache = await caches.open(MATERIAL_CACHE);
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch { /* no storage: the network */ }
  let response;
  try {
    // CORS also for a plain <img> (no-cors): a CORS response may answer it, and only a readable one can be kept
    response = await fetch(request.url, { mode: 'cors', credentials: 'same-origin', signal: request.signal });
  } catch (err) {
    if (request.signal && request.signal.aborted) throw err;
    return fetch(request); // a source without CORS: the page's own request, not kept
  }
  const type = response.headers.get('content-type') || '';
  const control = response.headers.get('cache-control') || '';
  if (cache && response.status === 200 && response.type !== 'opaque' && !/text\/html|application\/xhtml\+xml/i.test(type)
    && !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(control)) {
    const copy = response.clone();
    event.waitUntil(cache.put(key, copy).catch(() => { /* quota or a dropped body: just not kept */ }));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (IMPORTED_ASSET_PATH.test(url.pathname)) { event.respondWith(importedAsset(request, url)); return; }
  const key = MATERIAL_CACHE ? materialKey(url) : null;
  if (key) event.respondWith(runtimeArt(event, request, key));
});
