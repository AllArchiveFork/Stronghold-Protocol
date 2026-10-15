// Public copy of the browser simulation and the game data (deploy/stardust/STUDIO-CODE-SOURCE.md, the owner's request of
// 2026-10-15 to take load off the Jinan edge): a release may publish its /sim, /shared and /data files on the ModelScope
// Studio, and the edge then answers GET /code-source.json with their base URLs. The page loads the simulation and the
// game data from there and falls back to its own host — a missing or invalid /code-source.json (a dev server, a release
// without the copy), a failed request or a file that does not arrive in time. A failure is sticky for the page: one
// slow or missing file does not make every later one wait for the Studio again.
//
// The simulation must come from ONE origin: runner.js injects the data with simdata.js setSimData, and the content
// modules import simdata.js relatively — a module graph split between the edge and the Studio would hold two simdata
// instances, one of them empty. So the base is passed to loadBrowserSim, never redirected per file by the edge.

export const CODE_SOURCE_URL = '/code-source.json';
/** How long the page waits for /code-source.json before using its own host. */
export const CODE_SOURCE_TIMEOUT_MS = 3000;
/** How long one data file may take to start arriving from the Studio before the page asks its own host. */
export const REMOTE_DATA_TIMEOUT_MS = 10000;
/** Game data the page always reads from its own host: the notice board (edited between releases) and the per-host
 *  art index (served by the coordinator, not part of a release). */
export const LOCAL_ONLY_DATA = Object.freeze(new Set(['announcements.json', 'local-assets.json']));

/** A base URL /code-source.json may name: absolute https (http only on the loopback, for local checks), a directory
 *  (trailing slash), no query, fragment or credentials. */
function baseUrl(v) {
  if (typeof v !== 'string' || v.length > 1024 || !v.endsWith('/')) return null;
  try {
    const u = new URL(v);
    const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
    return scheme && !u.search && !u.hash && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

/** { version: 1, sim, data } → { sim, data }; null for anything else. */
export function parseCodeSource(json) {
  if (!json || typeof json !== 'object' || json.version !== 1) return null;
  const sim = baseUrl(json.sim), data = baseUrl(json.data);
  return sim && data ? { sim, data } : null;
}

/** fetch with its own deadline for the response headers, chained to the caller's signal (no AbortSignal.any: Safari < 17.4). */
async function fetchWithin(doFetch, url, init, ms, timers) {
  const controller = new AbortController();
  const outer = init && init.signal;
  const onAbort = () => controller.abort();
  if (outer) { if (outer.aborted) controller.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  const timer = timers.set(() => controller.abort(), ms);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    timers.clear(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {{ fetch?: typeof fetch, url?: string, timeoutMs?: number, dataTimeoutMs?: number,
 *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [opts]
 */
export function createCodeSource(opts = {}) {
  const doFetch = opts.fetch || ((...a) => globalThis.fetch(...a));
  const url = opts.url || CODE_SOURCE_URL;
  const timeoutMs = opts.timeoutMs ?? CODE_SOURCE_TIMEOUT_MS;
  const dataTimeoutMs = opts.dataTimeoutMs ?? REMOTE_DATA_TIMEOUT_MS;
  const timers = { set: opts.setTimeout || ((fn, ms) => setTimeout(fn, ms)), clear: opts.clearTimeout || ((h) => clearTimeout(h)) };
  let pending = null;
  const failed = new Set();

  /** The parsed /code-source.json, fetched once per page; null when there is none. */
  function get() {
    if (!pending) {
      pending = (async () => {
        try {
          const res = await fetchWithin(doFetch, url, { cache: 'no-store', credentials: 'same-origin' }, timeoutMs, timers);
          if (!res || !res.ok) return null;
          return parseCodeSource(await res.json());
        } catch { return null; }
      })();
    }
    return pending;
  }

  /** The Studio base for 'sim' / 'data', or null (none, or it failed on this page already). */
  async function base(kind) {
    if (failed.has(kind)) return null;
    const src = await get();
    return (!failed.has(kind) && src && src[kind]) || null;
  }

  /** Stop using the Studio for `kind` on this page. */
  function fail(kind, err) {
    if (failed.has(kind)) return;
    failed.add(kind);
    console.warn(`[code-source] ${kind} from the Studio failed (${err?.message || err}); using this host`);
  }

  /**
   * A data file (`name` relative to data/): the Studio copy when there is one, else — or when it fails — `localUrl`.
   * A response that arrived is returned as it is; reading its body stays the caller's. `localFetch` asks the own host.
   */
  async function fetchData(name, localUrl, init = {}, localFetch = doFetch) {
    const remote = LOCAL_ONLY_DATA.has(name) ? null : await base('data');
    if (remote) {
      try {
        // no credentials to another origin: the Studio answers `Access-Control-Allow-Origin: *`
        const res = await fetchWithin(doFetch, remote + name, { ...init, credentials: 'omit' }, dataTimeoutMs, timers);
        if (res && res.ok) return res;
        fail('data', new Error(`HTTP ${res ? res.status : '???'}`));
      } catch (err) {
        if (init.signal && init.signal.aborted) throw err;
        fail('data', err);
      }
    }
    return localFetch(localUrl, init);
  }

  return { get, base, fail, fetchData };
}

/** The page's code source. */
export const codeSource = createCodeSource();
