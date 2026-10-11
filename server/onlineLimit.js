// Online cap, changeable while the server runs: a small JSON file `{ "limit": 3000 }` (0, a missing file or a missing
// key = no cap) is re-read when its modification time changes, checked every `pollMs` off the request path
// (fs.promises.stat; the read happens only after a change). A bad file keeps the previous value and is reported once.
// Network.onHelloMsg refuses NEW sessions with ERR.SERVER_FULL while the lobby's online count is at the cap; a hello
// that resumes an existing session (a reload, a reconnect inside the reconnect window) is never refused, so nobody
// already online or in a match is locked out. Mount the file's DIRECTORY (an editor replaces the file's inode).
import { promises as fs } from 'node:fs';

export const ONLINE_LIMIT_MAX = 1_000_000;
/** How long a refused client waits before its next try (it retries on its own, with ±25 % jitter). */
export const SERVER_FULL_RETRY_MS = 20_000;

/** @param {unknown} doc parsed file contents @returns {number|null} the cap (0 = none), null when invalid */
export function parseOnlineLimit(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (!Object.hasOwn(doc, 'limit')) return 0;
  const n = doc.limit;
  return Number.isSafeInteger(n) && n >= 0 && n <= ONLINE_LIMIT_MAX ? n : null;
}

/**
 * @param {{ file?: string | null, pollMs?: number, log?: { info: Function, warn: Function } }} [opts]
 * @returns {{ limit: () => number, refresh: () => Promise<number>, close: () => void }}
 */
export function createOnlineLimit({ file = null, pollMs = 5000, log = { info() {}, warn() {} } } = {}) {
  let value = 0, stamp = null, warned = null, timer = null, closed = false;
  const check = async () => {
    if (!file || closed) return value;
    try {
      let st;
      try { st = await fs.stat(file); } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
        if (stamp !== 'missing') { stamp = 'missing'; if (value !== 0) log.info(`[limit] ${file} removed: no online cap`); value = 0; }
        return value;
      }
      const next = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (next === stamp) return value;
      stamp = next;
      let parsed = null;
      try { parsed = parseOnlineLimit(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { parsed = null; }
      if (parsed == null) {
        if (warned !== next) { warned = next; log.warn(`[limit] ${file} is not {"limit": 0..${ONLINE_LIMIT_MAX}}: keeping ${value}`); }
      } else if (parsed !== value) {
        log.info(`[limit] online cap ${value || 'none'} → ${parsed || 'none'}`);
        value = parsed;
      }
    } catch (e) {
      if (warned !== 'error') { warned = 'error'; log.warn(`[limit] cannot read ${file}: ${e?.code || e?.message}`); }
    }
    return value;
  };
  // checks run one after another: a refresh() during the timer's check sees the file as it is after that one
  let chain = Promise.resolve(value);
  const refresh = () => (chain = chain.then(check, check));
  if (file) {
    void refresh();
    timer = setInterval(() => { void refresh(); }, Math.max(250, pollMs));
    timer.unref?.();
  }
  return { limit: () => value, refresh, close: () => { closed = true; if (timer) clearInterval(timer); timer = null; } };
}

/** The refusal's developer detail (errorMsg keeps 120 chars): parsed back by the client (public/js/net.js serverFull). */
export const serverFullDetail = (online, limit, retryMs = SERVER_FULL_RETRY_MS) => `online=${online} limit=${limit} retry=${retryMs}`;
