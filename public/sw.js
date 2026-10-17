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
// 200 that is not an HTML error page is kept. Another profile is another cache: activating one drops the others,
// except the one /code-source.json `materialCarry.from` names (deploy/stardust/STUDIO-CODE-SOURCE.md): a miss is then
// answered from that cache unless its path is in `materialCarry.drop` (exact paths, or directories ending in `/`, whose
// bytes changed), and the entry moves to this profile's cache. A switch then refetches only what changed.
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

/** Where the activated carry-over is kept, inside MATERIAL_CACHE (never a path the page requests through materialKey). */
const MATERIAL_CARRY_KEY = '/__sp-material-carry';
const MATERIAL_CARRY_MAX = 4096;

/** `materialCarry` of a /code-source.json that names this worker's profile → { from, drop }, or null. */
function parseCarry(json) {
  const carry = json && json.material === MATERIAL_PROFILE ? json.materialCarry : null;
  if (!carry || typeof carry.from !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(carry.from)
    || carry.from === MATERIAL_PROFILE || !Array.isArray(carry.drop) || carry.drop.length > MATERIAL_CARRY_MAX
    || carry.drop.some((p) => typeof p !== 'string' || !/^\/(?:assets|media)\/./.test(p))) return null;
  return { from: carry.from, drop: carry.drop };
}

async function fetchCarry() {
  try {
    const res = await fetch('/code-source.json', { cache: 'no-store', credentials: 'same-origin' });
    return res.ok ? parseCarry(await res.json()) : null;
  } catch { return null; }
}

let carryState = null;
/** The carry-over this worker activated with: { cacheName, exact: Set, dirs: string[] }, or null. Read once per start. */
function activeCarry() {
  if (!carryState) {
    carryState = (async () => {
      try {
        const hit = await caches.match(self.location.origin + MATERIAL_CARRY_KEY, { cacheName: MATERIAL_CACHE });
        const carry = hit ? parseCarry({ material: MATERIAL_PROFILE, materialCarry: await hit.json() }) : null;
        return carry && { cacheName: MATERIAL_CACHE_PREFIX + carry.from, exact: new Set(carry.drop.filter((p) => !p.endsWith('/'))),
          dirs: carry.drop.filter((p) => p.endsWith('/')) };
      } catch { return null; }
    })();
  }
  return carryState;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const carry = MATERIAL_CACHE ? await fetchCarry() : null;
    const kept = carry ? MATERIAL_CACHE_PREFIX + carry.from : null;
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (name.startsWith(IMPORTED_ASSET_CACHE_PREFIX) && name !== IMPORTED_ASSET_CACHE)
        // a worker without a profile (its page could not read /code-source.json) leaves the art cache to the next one
        || (MATERIAL_CACHE && name.startsWith(MATERIAL_CACHE_PREFIX) && name !== MATERIAL_CACHE && name !== kept))
      .map((name) => caches.delete(name)));
    if (MATERIAL_CACHE) {
      try {
        const cache = await caches.open(MATERIAL_CACHE);
        const key = self.location.origin + MATERIAL_CARRY_KEY;
        if (carry && names.includes(kept)) {
          await cache.put(key, new Response(JSON.stringify(carry), { headers: { 'content-type': 'application/json' } }));
        } else {
          await cache.delete(key);
        }
      } catch { /* no storage: nothing carried */ }
      carryState = null;
    }
    await self.clients.claim();
  })());
});

/** A miss of this profile answered from the carried profile's cache (moved into `cache`), or null. */
async function carriedArt(event, cache, key) {
  const carry = await activeCarry();
  if (!carry) return null;
  let path;
  try { path = decodeURIComponent(new URL(key).pathname); } catch { return null; }
  if (carry.exact.has(path) || carry.dirs.some((dir) => path.startsWith(dir))) return null;
  let hit;
  try { hit = await caches.match(key, { cacheName: carry.cacheName }); } catch { return null; }
  if (!hit) return null;
  if (cache) {
    event.waitUntil(cache.put(key, hit.clone())
      .then(() => caches.open(carry.cacheName)).then((old) => old.delete(key))
      .catch(() => { /* quota: served, not moved */ }));
  }
  return hit;
}

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
  const carried = await carriedArt(event, cache, key);
  if (carried) return carried;
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
