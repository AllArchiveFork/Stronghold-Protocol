// Input rules of the feedback board: text cleaning and lengths, the in-memory rate limits and the owner key.
// Nothing here is persisted: limiter state lives only in this process (a restart forgets it), and neither IPs nor
// session signatures are hashed, logged or stored.
import { promises as fs } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const CATEGORIES = Object.freeze(['bug', 'gameplay', 'ui', 'other']);
export const STATUSES = Object.freeze(['unassigned', 'unplanned', 'planned', 'updated']);
/** [min, max] Unicode code points after cleaning and NFC. */
export const LENGTHS = Object.freeze({ title: [2, 80], body: [5, 4000], author: [0, 24], client: [0, 160], reply: [0, 2000], q: [0, 64] });
export const SEARCH_TERMS = 5;

// C0 and C1 controls (and DEL). Multi-line text keeps TAB and LF.
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
const CONTROLS_KEEP_TAB_LF = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** One line: every whitespace character becomes a space, controls go, runs of spaces collapse, NFC, trimmed. */
export const cleanLine = (value) => value.toWellFormed().replace(/\s/g, ' ').replace(CONTROLS, '')
  .replace(/ {2,}/g, ' ').normalize('NFC').trim();
/** Multi-line text: CRLF / CR → LF, controls except TAB and LF go, NFC, trimmed. */
export const cleanText = (value) => value.toWellFormed().replace(/\r\n?/g, '\n').replace(CONTROLS_KEEP_TAB_LF, '')
  .normalize('NFC').trim();
export const codePoints = (value) => { let n = 0; for (const _ of value) n++; return n; };

/** A cleaned string within LENGTHS[field], or null. `undefined` / `null` are '' for optional fields. */
function text(value, field, multiline) {
  const [min, max] = LENGTHS[field];
  if ((value === undefined || value === null) && min === 0) return '';
  if (typeof value !== 'string' || value.length > max * 4 + 256) return null;
  const clean = multiline ? cleanText(value) : cleanLine(value);
  const n = codePoints(clean);
  return n >= min && n <= max ? clean : null;
}

/**
 * A new item from a parsed JSON body. Unknown keys are ignored.
 * @returns {{ value: { category: string, title: string, body: string, author: string, client: string } } | { field: string }}
 */
export function validateNew(doc) {
  if (!CATEGORIES.includes(doc.category)) return { field: 'category' };
  const value = { category: doc.category };
  for (const [field, multiline] of [['title', false], ['body', true], ['author', false], ['client', false]]) {
    const clean = text(doc[field], field, multiline);
    if (clean === null) return { field };
    value[field] = clean;
  }
  return { value };
}

/**
 * The owner's change to an item: any of status, reply ('' clears it) and hidden. Unknown keys are ignored.
 * @returns {{ patch: { status?: string, reply?: string, hidden?: boolean } } | { field: string }}
 */
export function validatePatch(doc) {
  const patch = {};
  if (doc.status !== undefined) {
    if (!STATUSES.includes(doc.status)) return { field: 'status' };
    patch.status = doc.status;
  }
  if (doc.reply !== undefined) {
    if (doc.reply === null) return { field: 'reply' };
    const reply = text(doc.reply, 'reply', true);
    if (reply === null) return { field: 'reply' };
    patch.reply = reply;
  }
  if (doc.hidden !== undefined) {
    if (typeof doc.hidden !== 'boolean') return { field: 'hidden' };
    patch.hidden = doc.hidden;
  }
  return { patch };
}

/**
 * The list query: status / category ('' or 'all' = any), q (≤ 64 code points, up to 5 whitespace-separated terms,
 * the rest ignored), before (an id), limit (1…; above `maxLimit` is clamped).
 * @param {URLSearchParams} params
 */
export function parseListQuery(params, { defaultLimit = 20, maxLimit = 50 } = {}) {
  for (const key of ['status', 'category', 'q', 'before', 'limit']) {
    if (params.getAll(key).length > 1) return { field: key };
  }
  const pick = (key, allowed) => {
    const value = params.get(key);
    if (value === null || value === '' || value === 'all') return { value: null };
    return allowed.includes(value) ? { value } : null;
  };
  const status = pick('status', STATUSES), category = pick('category', CATEGORIES);
  if (!status) return { field: 'status' };
  if (!category) return { field: 'category' };
  const q = cleanLine(params.get('q') ?? '');
  if (codePoints(q) > LENGTHS.q[1]) return { field: 'q' };
  const terms = q ? q.split(' ').slice(0, SEARCH_TERMS) : [];
  let before = null;
  const rawBefore = params.get('before');
  if (rawBefore !== null && rawBefore !== '') {
    if (!/^[1-9]\d{0,15}$/.test(rawBefore) || !Number.isSafeInteger(Number(rawBefore))) return { field: 'before' };
    before = Number(rawBefore);
  }
  let limit = defaultLimit;
  const rawLimit = params.get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    if (!/^[1-9]\d{0,5}$/.test(rawLimit)) return { field: 'limit' };
    limit = Math.min(maxLimit, Number(rawLimit));
  }
  return { query: { status: status.value, category: category.value, terms, before, limit } };
}

/** The rate-limit key of an address: IPv4 as is, IPv6 by its /64 (one subscriber's prefix). */
export function clientKey(ip) {
  if (typeof ip !== 'string' || isIP(ip) !== 6) return String(ip);
  if (/^::ffff:/i.test(ip) && isIP(ip.slice(7)) === 4) return ip.slice(7);
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/**
 * Sliding windows over the times of past events, per key: `wait()` says how long (ms) until one more event fits every
 * rule, `hit()` records one. Only the newest `max(rule.max)` times per key are kept, and keys whose last event is older
 * than the longest window are swept once a minute. With `maxKeys`, an unknown key is refused while the table is full.
 */
export class WindowLimiter {
  /** @param {{ rules: { max: number, window: number }[], maxKeys?: number }} opts windows in ms */
  constructor({ rules, maxKeys = Infinity }) {
    this.rules = rules;
    this.maxKeys = maxKeys;
    this.span = Math.max(...rules.map((r) => r.window));
    this.keep = Math.max(...rules.map((r) => r.max));
    /** @type {Map<string, number[]>} oldest first */
    this.times = new Map();
    this.nextSweep = 0;
  }
  sweep(now) {
    if (now < this.nextSweep) return;
    this.nextSweep = now + 60_000;
    for (const [key, list] of this.times) if (!list.length || list[list.length - 1] <= now - this.span) this.times.delete(key);
  }
  wait(key, now) {
    this.sweep(now);
    const list = this.times.get(key);
    if (!list) return this.times.size >= this.maxKeys ? 60_000 : 0;
    let wait = 0;
    for (const { max, window } of this.rules) {
      const recent = list.filter((t) => t > now - window);
      // the event that has to leave the window before one more fits
      if (recent.length >= max) wait = Math.max(wait, recent[recent.length - max] + window - now);
    }
    return wait;
  }
  hit(key, now) {
    let list = this.times.get(key);
    if (!list) this.times.set(key, list = []);
    list.push(now);
    while (list.length > this.keep || (list.length && list[0] <= now - this.span)) list.shift();
  }
}

// The owner key: the same file and the same rules as server/ownerFile.js (that module is not in this image).
const NAME_DROP = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu;
const nameKey = (name) => name.normalize('NFKC').replace(NAME_DROP, '').toUpperCase().toLowerCase();

/** The key digest of a valid owner file (`{ "names": [...], "keySha256": "<64 hex>" }`, nothing else), or null. */
export function parseOwnerFile(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (Object.keys(doc).some((key) => key !== 'names' && key !== 'keySha256')) return null;
  const { names, keySha256 } = doc;
  if (typeof keySha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(keySha256)) return null;
  if (!Array.isArray(names) || names.length > 64) return null;
  if (!names.every((name) => typeof name === 'string' && name.length <= 64 && nameKey(name))) return null;
  return Buffer.from(keySha256, 'hex');
}

/**
 * Watches the owner file: re-read when its mtime / size / inode change, checked every `pollMs` off the request path.
 * No file name, a missing file or an invalid one = admin off. The key, its digest and the file are never logged.
 * @returns {{ verify: (key: unknown) => boolean, active: () => boolean, refresh: () => Promise<boolean>, close: () => void }}
 */
export function createOwnerKey({ file = null, pollMs = 5000, log = { info() {}, warn() {} } } = {}) {
  let hash = null, stamp = null, warned = null, timer = null, closed = false;
  const set = (next) => {
    if (next && !hash) log.info('[feedback] owner file loaded: admin on');
    else if (!next && hash) log.info('[feedback] owner file gone or invalid: admin off');
    hash = next;
  };
  const check = async () => {
    if (!file || closed) return !!hash;
    try {
      let st;
      try { st = await fs.stat(file); } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
        if (stamp !== 'missing') { stamp = 'missing'; set(null); }
        return !!hash;
      }
      const next = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (next === stamp) return !!hash;
      stamp = next;
      let parsed = null;
      // never log a parse error: its message may quote the file
      try { parsed = parseOwnerFile(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { parsed = null; }
      if (parsed) warned = null;
      else if (warned !== next) { warned = next; log.warn('[feedback] owner file invalid: admin off'); }
      set(parsed);
    } catch (e) {
      if (warned !== 'error') { warned = 'error'; log.warn(`[feedback] cannot read the owner file: ${e?.code || 'error'}`); }
    }
    return !!hash;
  };
  let chain = Promise.resolve(false);
  const refresh = () => (chain = chain.then(check, check));
  if (file) {
    void refresh();
    timer = setInterval(() => { void refresh(); }, Math.max(250, pollMs));
    timer.unref?.();
  }
  const verify = (key) => {
    if (!hash || typeof key !== 'string' || !key) return false;
    return timingSafeEqual(createHash('sha256').update(key, 'utf8').digest(), hash);
  };
  return { verify, active: () => !!hash, refresh,
    close: () => { closed = true; if (timer) clearInterval(timer); timer = null; } };
}
