// Online cap and room / AI caps, changeable while the server runs: a small JSON file
// `{ "limit": 3000, "maxRoomsPerAddr": 24, "maxBotsPerAddr": 60 }` is re-read when its modification time changes,
// checked every `pollMs` off the request path (fs.promises.stat; the read happens only after a change). A bad file —
// a value that is not an integer 0..ONLINE_LIMIT_MAX, an unknown key — keeps ALL previous values and is reported once.
//   * `limit` (0, a missing file or a missing key = no cap): Network.onHelloMsg refuses NEW sessions with
//     ERR.SERVER_FULL while the lobby's online count is at the cap; a hello that resumes an existing session (a reload,
//     a reconnect inside the reconnect window) is never refused, so nobody already online or in a match is locked out.
//   * ROOM_CAP_KEYS (server/lobby.js Lobby.cap): each key the file sets replaces that lobby option (0 = unlimited) for
//     the next room.create / room.start / room.addBot; a key it leaves out (or a missing file) keeps the option. Rooms,
//     matches and AI seats that already exist are never closed by a lower cap.
// Mount the file's DIRECTORY (an editor replaces the file's inode).
import { promises as fs } from 'node:fs';

export const ONLINE_LIMIT_MAX = 1_000_000;
/** How long a refused client waits before its next try (it retries on its own, with ±25 % jitter). */
export const SERVER_FULL_RETRY_MS = 20_000;
/** The lobby caps the file may set (server/lobby.js LOBBY_DEFAULTS). */
export const ROOM_CAP_KEYS = Object.freeze(['maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'maxBots', 'maxBotsPerAddr']);

const capValue = (n) => Number.isSafeInteger(n) && n >= 0 && n <= ONLINE_LIMIT_MAX;
const NO_CAPS = Object.freeze({});

/**
 * @param {unknown} doc parsed file contents
 * @returns {{ limit: number, caps: Readonly<Record<string, number>> } | null} the online cap (0 = none) and the room caps
 *   the file sets; null when invalid
 */
export function parseLimits(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const caps = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key !== 'limit' && !ROOM_CAP_KEYS.includes(key)) return null;
    if (!capValue(value)) return null;
    if (key !== 'limit') caps[key] = value;
  }
  return { limit: Object.hasOwn(doc, 'limit') ? doc.limit : 0, caps: Object.freeze(caps) };
}

/** @param {unknown} doc parsed file contents @returns {number|null} the online cap (0 = none), null when invalid */
export function parseOnlineLimit(doc) { return parseLimits(doc)?.limit ?? null; }

const capsText = (caps) => (Object.keys(caps).length ? JSON.stringify(caps) : 'options');

/**
 * @param {{ file?: string | null, pollMs?: number, log?: { info: Function, warn: Function } }} [opts]
 * @returns {{ limit: () => number, caps: () => Readonly<Record<string, number>>, refresh: () => Promise<number>,
 *   close: () => void }}
 */
export function createOnlineLimit({ file = null, pollMs = 5000, log = { info() {}, warn() {} } } = {}) {
  let value = 0, caps = NO_CAPS, stamp = null, warned = null, timer = null, closed = false;
  const apply = (next) => {
    if (next.limit !== value) { log.info(`[limit] online cap ${value || 'none'} → ${next.limit || 'none'}`); value = next.limit; }
    if (capsText(next.caps) !== capsText(caps)) { log.info(`[limit] room caps ${capsText(caps)} → ${capsText(next.caps)}`); caps = next.caps; }
  };
  const check = async () => {
    if (!file || closed) return value;
    try {
      let st;
      try { st = await fs.stat(file); } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
        if (stamp !== 'missing') { stamp = 'missing'; apply({ limit: 0, caps: NO_CAPS }); }
        return value;
      }
      const next = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (next === stamp) return value;
      stamp = next;
      let parsed = null;
      try { parsed = parseLimits(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { parsed = null; }
      if (parsed == null) {
        if (warned !== next) {
          warned = next;
          log.warn(`[limit] ${file} is not {"limit"|${ROOM_CAP_KEYS.join('|')}: 0..${ONLINE_LIMIT_MAX}}: keeping ${value}, ${capsText(caps)}`);
        }
      } else apply(parsed);
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
  return { limit: () => value, caps: () => caps, refresh, close: () => { closed = true; if (timer) clearInterval(timer); timer = null; } };
}

/** The refusal's developer detail (errorMsg keeps 120 chars): parsed back by the client (public/js/net.js serverFull). */
export const serverFullDetail = (online, limit, retryMs = SERVER_FULL_RETRY_MS) => `online=${online} limit=${limit} retry=${retryMs}`;
