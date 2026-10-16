// The players' feedback board (/feedback): bug reports and suggestions, public to every logged-in player; the owner
// replies, sets a status, hides or deletes. Native node:http, no framework, no npm dependency; storage in store.mjs,
// input rules / limits / owner key in policy.mjs, the page in public/ (README.md in this directory).
//
// Behind OpenResty only: nginx enforces the site's password gate on every path and sets the trusted X-Real-IP and
// X-Ark-Session (the signature part of the gate cookie: stable per login, not a player identity). Bind loopback.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemView, openStore } from './store.mjs';
import { WindowLimiter, clientKey, createOwnerKey, parseListQuery, validateNew, validatePatch } from './policy.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const BODY_LIMIT = 16 * 1024;
/** New items: per gate session, per client address (IPv6 by /64) and for everybody. Sliding windows, in memory. */
export const POST_LIMITS = Object.freeze({
  session: [{ max: 3, window: 10 * MINUTE }, { max: 15, window: DAY }],
  ip: [{ max: 30, window: DAY }],
  global: [{ max: 120, window: HOUR }],
});
/** Wrong owner keys per client address. */
export const OWNER_FAIL_LIMIT = Object.freeze({ max: 10, window: 10 * MINUTE });
export const DUPLICATE_WINDOW = DAY;
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ASSET_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2'], ['.ico', 'image/x-icon'],
]);
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
const ITEM_RE = /^\/feedback\/api\/items\/([1-9]\d{0,15})(\/admin)?$/;

/**
 * public/: the page (index.html, `__ASSET_VERSION__` → a hash of every top-level file) and the flat asset allowlist
 * (no subdirectories, dotfiles or index.html; only the types above). Read once at startup.
 */
export function loadPublic(dir) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
  const files = new Map(names.map((name) => [name, readFileSync(join(dir, name))]));
  if (!files.has('index.html')) throw new Error('feedback: public/index.html is missing');
  const all = createHash('sha256');
  for (const [name, data] of files) all.update(`${name}\0${data.length}\0`).update(data);
  const version = all.digest('hex').slice(0, 12);
  const tag = (data) => `"${createHash('sha256').update(data).digest('base64url').slice(0, 22)}"`;
  const assets = new Map();
  for (const [name, data] of files) {
    const type = ASSET_TYPES.get(extname(name).toLowerCase());
    if (name !== 'index.html' && type && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) assets.set(name, { type, data, etag: tag(data) });
  }
  const page = Buffer.from(files.get('index.html').toString('utf8').replaceAll('__ASSET_VERSION__', version));
  return { version, page: { data: page, etag: tag(page) }, assets };
}

class HttpError extends Error {
  constructor(status, error, extra = {}) { super(error); this.status = status; this.extra = extra; }
}

function readJSON(req) {
  if (!/^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] || '')) return Promise.reject(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE'));
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return Promise.reject(new HttpError(413, 'TOO_LARGE'));
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0, done = false;
    const finish = (error, value) => { if (!done) { done = true; if (error) reject(error); else resolveBody(value); } };
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > BODY_LIMIT) { chunks.length = 0; finish(new HttpError(413, 'TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let doc;
      try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { doc = null; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) finish(new HttpError(400, 'BAD_JSON'));
      else finish(null, doc);
    });
    // after 'end' this is a no-op; before it, the client went away
    req.on('close', () => finish(new HttpError(400, 'ABORTED')));
    req.on('error', () => finish(new HttpError(400, 'ABORTED')));
  });
}

const etagMatch = (header, etag) => typeof header === 'string'
  && header.split(',').some((v) => v.trim().replace(/^W\//, '') === etag);

/**
 * @param {{ db?: string, origin: string, ownerFile?: string | null, ownerPollMs?: number, backupDir?: string | null,
 *   backupKeep?: number, backupCheckMs?: number, publicDir?: string, now?: () => number,
 *   log?: { info: Function, warn: Function, error: Function } }} options
 * @returns {{ server: http.Server, version: string, refreshOwner: () => Promise<boolean>,
 *   backup: () => { name: string, created: boolean, removed: number } | null, visibleCount: () => number, close: () => Promise<void> }}
 */
export function createFeedbackServer({
  db = '/data/feedback.sqlite', origin, ownerFile = null, ownerPollMs = 5000, backupDir = null, backupKeep = 14,
  backupCheckMs = HOUR, publicDir = join(ROOT, 'public'), now = Date.now, log = console,
} = /** @type {any} */ ({})) {
  let allowedOrigin;
  try { allowedOrigin = new URL(origin).origin; } catch { allowedOrigin = null; }
  if (!allowedOrigin || allowedOrigin !== origin) throw new Error('feedback: FEEDBACK_ORIGIN must be an origin like https://example.org');
  const site = loadPublic(publicDir);
  const store = openStore(db, { now });
  const owner = createOwnerKey({ file: ownerFile, pollMs: ownerPollMs, log });
  const limits = {
    session: new WindowLimiter({ rules: POST_LIMITS.session }),
    ip: new WindowLimiter({ rules: POST_LIMITS.ip }),
    global: new WindowLimiter({ rules: POST_LIMITS.global }),
    ownerFail: new WindowLimiter({ rules: [OWNER_FAIL_LIMIT], maxKeys: 10_000 }),
  };

  const backup = () => {
    if (!backupDir) return null;
    try { return store.backup(backupDir, now(), backupKeep); } catch (e) {
      log.error(`[feedback] backup failed: ${e?.code || e?.name || 'error'}`);
      return null;
    }
  };
  backup();
  const backupTimer = backupDir ? setInterval(backup, Math.max(1000, backupCheckMs)) : null;
  backupTimer?.unref();

  const send = (req, res, status, data = null, headers = {}) => {
    if (data) headers['Content-Length'] = data.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data ?? undefined);
  };
  const json = (req, res, status, value, headers = {}) => send(req, res, status,
    value === null ? null : Buffer.from(JSON.stringify(value)),
    { ...(value === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), 'Cache-Control': 'no-store', ...headers });
  const retry = (ms) => Math.max(1, Math.ceil(ms / 1000));
  const limited = (ms) => new HttpError(429, 'RATE_LIMITED', { retryAfter: retry(ms) });
  const methods = (req, allowed) => {
    if (!allowed.includes(req.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', { allow: allowed.join(', ') });
  };
  const clientIP = (req) => {
    const forwarded = req.headers['x-real-ip'];
    return clientKey(typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'unknown');
  };
  const checkOrigin = (req) => {
    const fetchSite = req.headers['sec-fetch-site'];
    if (req.headers.origin !== allowedOrigin || (fetchSite !== undefined && fetchSite !== 'same-origin')) throw new HttpError(403, 'ORIGIN');
  };

  /** 'none' (no key), 'disabled' (no valid owner file), 'limited' (+ wait), 'invalid' (counted) or 'valid'. */
  function ownerState(req, ip) {
    const values = req.headersDistinct['x-owner-key'];
    if (!values || (values.length === 1 && values[0] === '')) return { state: 'none' };
    if (!owner.active()) return { state: 'disabled' };
    const wait = limits.ownerFail.wait(ip, now());
    if (wait) return { state: 'limited', wait };
    if (values.length === 1 && values[0].length <= 1024 && owner.verify(values[0])) return { state: 'valid' };
    limits.ownerFail.hit(ip, now());
    return { state: 'invalid' };
  }
  /** The owner or an HttpError: 503 without a valid owner file, 429 while the address is limited, else 403. */
  function requireOwner(req, ip) {
    if (!owner.active()) throw new HttpError(503, 'OWNER_DISABLED');
    const { state, wait } = ownerState(req, ip);
    if (state === 'valid') return;
    if (state === 'limited') throw limited(wait);
    if (state === 'disabled') throw new HttpError(503, 'OWNER_DISABLED');
    throw new HttpError(403, 'OWNER');
  }

  function page(req, res) {
    methods(req, ['GET', 'HEAD']);
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'private, no-cache', ETag: site.page.etag };
    if (etagMatch(req.headers['if-none-match'], site.page.etag)) return send(req, res, 304, null, headers);
    return send(req, res, 200, site.page.data, headers);
  }
  function asset(req, res, url, name) {
    methods(req, ['GET', 'HEAD']);
    const file = site.assets.get(name);
    if (!file) throw new HttpError(404, 'NOT_FOUND');
    const cache = url.searchParams.get('v') === site.version ? 'private, max-age=31536000, immutable' : 'private, no-cache';
    const headers = { 'Content-Type': file.type, 'Cache-Control': cache, ETag: file.etag };
    if (etagMatch(req.headers['if-none-match'], file.etag)) return send(req, res, 304, null, headers);
    return send(req, res, 200, file.data, headers);
  }

  async function createItem(req, res, ip) {
    checkOrigin(req);
    const values = req.headersDistinct['x-ark-session'];
    const session = values?.length === 1 && SESSION_RE.test(values[0]) ? values[0] : null;
    if (!session) throw new HttpError(403, 'NO_SESSION');
    const checked = validateNew(await readJSON(req));
    if ('field' in checked) throw new HttpError(400, 'INVALID', { field: checked.field });
    const item = checked.value, at = now();
    // A duplicate answers before the limits and costs no quota (a resend after a lost response finds its item).
    const id = store.duplicateOf(item.title, item.body, at - DUPLICATE_WINDOW);
    if (id !== null) throw new HttpError(409, 'DUPLICATE', { id });
    const wait = Math.max(limits.session.wait(session, at), limits.ip.wait(ip, at), limits.global.wait('', at));
    if (wait) throw limited(wait);
    const row = store.create(item, at);
    limits.session.hit(session, at);
    limits.ip.hit(ip, at);
    limits.global.hit('', at);
    return json(req, res, 201, { item: itemView(row) });
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (!req.url || req.url.length > 4096 || !req.url.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'BAD_REQUEST');
    const url = new URL(req.url, 'http://feedback.invalid');
    const path = url.pathname;
    const ip = clientIP(req);
    if (path === '/feedback') {
      methods(req, ['GET', 'HEAD']);
      return send(req, res, 301, null, { Location: `/feedback/${url.search}`, 'Cache-Control': 'no-store' });
    }
    if (path === '/feedback/') return page(req, res);
    if (path.startsWith('/feedback/assets/')) return asset(req, res, url, path.slice('/feedback/assets/'.length));
    if (path === '/feedback/api/health') {
      methods(req, ['GET', 'HEAD']);
      return json(req, res, 200, { ok: true, items: store.visibleCount() });
    }
    if (path === '/feedback/api/admin') {
      methods(req, ['GET', 'HEAD']);
      requireOwner(req, ip);
      return json(req, res, 204, null);
    }
    if (path === '/feedback/api/items') {
      methods(req, ['GET', 'HEAD', 'POST']);
      if (req.method === 'POST') return createItem(req, res, ip);
      const parsed = parseListQuery(url.searchParams);
      if ('field' in parsed) throw new HttpError(400, 'INVALID', { field: parsed.field });
      const admin = ownerState(req, ip).state === 'valid';
      const { rows, next } = store.list({ ...parsed.query, admin });
      const counts = store.counts({ ...parsed.query, admin });
      return json(req, res, 200, { items: rows.map((row) => itemView(row, admin)), next, counts });
    }
    const match = ITEM_RE.exec(path);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new HttpError(404, 'NOT_FOUND');
    const id = Number(match[1]);
    if (match[2]) {
      methods(req, ['POST']);
      checkOrigin(req);
      requireOwner(req, ip);
      const checked = validatePatch(await readJSON(req));
      if ('field' in checked) throw new HttpError(400, 'INVALID', { field: checked.field });
      const row = store.update(id, checked.patch, now());
      if (!row) throw new HttpError(404, 'NOT_FOUND');
      return json(req, res, 200, { item: itemView(row, true) });
    }
    methods(req, ['GET', 'HEAD', 'DELETE']);
    if (req.method === 'DELETE') {
      checkOrigin(req);
      requireOwner(req, ip);
      if (!store.remove(id)) throw new HttpError(404, 'NOT_FOUND');
      return json(req, res, 204, null);
    }
    const admin = ownerState(req, ip).state === 'valid';
    const row = store.get(id);
    if (!row || (row.hidden && !admin)) throw new HttpError(404, 'NOT_FOUND');
    return json(req, res, 200, { item: itemView(row, admin) });
  }

  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof HttpError) {
        const { allow, retryAfter, ...extra } = error.extra;
        const headers = {};
        if (allow) headers.Allow = allow;
        if (retryAfter) headers['Retry-After'] = String(retryAfter);
        if (error.status === 413 || error.message === 'ABORTED') { headers.Connection = 'close'; req.resume(); }
        return json(req, res, error.status, { error: error.message, ...(retryAfter ? { retryAfter } : {}), ...extra }, headers);
      }
      // Never log the request: no URL, headers, addresses, keys or bodies.
      log.error(`[feedback] request failed: ${error?.code || error?.name || 'error'}`);
      json(req, res, 500, { error: 'INTERNAL' });
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

  let closing = null;
  const close = () => closing ??= new Promise((resolveClose) => {
    if (backupTimer) clearInterval(backupTimer);
    owner.close();
    const done = () => { store.close(); resolveClose(); };
    if (!server.listening) return done();
    server.close(done);
    server.closeIdleConnections();
  });
  return { server, version: site.version, refreshOwner: owner.refresh, backup, visibleCount: store.visibleCount, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const port = Number(env.FEEDBACK_PORT || 3150);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FEEDBACK_PORT');
  if (!env.FEEDBACK_ORIGIN) throw new Error('FEEDBACK_ORIGIN is required (e.g. https://ark-proto.stardust.matce.cn)');
  const service = createFeedbackServer({
    db: env.FEEDBACK_DB || '/data/feedback.sqlite', origin: env.FEEDBACK_ORIGIN,
    ownerFile: env.FEEDBACK_OWNER_FILE || null, backupDir: env.FEEDBACK_BACKUP_DIR || null,
  });
  const host = env.FEEDBACK_HOST || '127.0.0.1';
  service.server.listen(port, host, () => console.log(`[feedback] listening on ${host}:${port}, ${service.visibleCount()} visible items, assets ${service.version}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    setTimeout(() => process.exit(1), 5000).unref();
    service.close().then(() => process.exit(0));
  });
}
