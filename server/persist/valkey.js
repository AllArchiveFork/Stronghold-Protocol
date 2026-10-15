// server/persist/valkey.js — a small Valkey / Redis client (RESP2 over TCP or TLS) for the match checkpoints
// (server/persist/, docs/DEPLOY.md「断点续玩」). No dependency: the server needs a handful of commands (GET, SET with PX,
// DEL, PING) and must never let the store slow a match down, so the rules are simple:
//
//   * one connection, opened on the first command and again after any failure (backoff 0.2 s → 5 s);
//   * while it is down a command fails at once (UNAVAILABLE) — nothing queues behind a dead store; only the commands
//     issued during a connection attempt wait for it (bounded by connectTimeoutMs and maxPending);
//   * every command has a deadline (commandTimeoutMs); a late reply means the stream can no longer be trusted, so the
//     connection is dropped and every pending command fails;
//   * the URL may carry a user / password (redis://user:pass@host:port/db; rediss:// or valkeys:// for TLS) or the
//     password comes from a file (SP_REDIS_PASSWORD_FILE): neither is ever logged.

import net from 'node:net';
import tls from 'node:tls';

const CRLF = Buffer.from('\r\n');

export class ValkeyError extends Error {
  constructor(code, message = code) { super(message); this.name = 'ValkeyError'; this.code = code; }
}

/**
 * Parse a store URL. @param {string} raw
 * @returns {{ host: string, port: number, tls: boolean, username: string | null, password: string | null, db: number }}
 */
export function parseValkeyUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new TypeError('invalid SP_REDIS_URL'); }
  const scheme = url.protocol.replace(/:$/, '');
  if (!['redis', 'rediss', 'valkey', 'valkeys'].includes(scheme) || !url.hostname || url.search || url.hash) throw new TypeError('invalid SP_REDIS_URL');
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0 || db > 255) throw new TypeError('invalid SP_REDIS_URL database');
  const port = url.port ? Number(url.port) : 6379;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port, tls: scheme === 'rediss' || scheme === 'valkeys',
    username: url.username ? decodeURIComponent(url.username) : null, password: url.password ? decodeURIComponent(url.password) : null, db };
}

/** RESP2 encoding of one command. @param {(string | Buffer | number)[]} args */
export function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}\r\n`), b, CRLF);
  }
  return Buffer.concat(parts);
}

/**
 * Incremental RESP2 reply parser. feed() takes a chunk and returns the complete replies (an error reply is a
 * ValkeyError value; bulk strings are Buffers; null bulk / array is null).
 */
export class ReplyParser {
  constructor() { this.buf = Buffer.alloc(0); }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) { // loop-cap: every pass consumes one complete reply from the buffer, or stops
      const r = this.parse(0);
      if (!r) break;
      out.push(r.value);
      this.buf = this.buf.subarray(r.end);
    }
    return out;
  }

  line(at) {
    const i = this.buf.indexOf(CRLF, at);
    return i < 0 ? null : { text: this.buf.toString('utf8', at + 1, i), next: i + 2 };
  }

  parse(at) {
    if (at >= this.buf.length) return null;
    const type = String.fromCharCode(this.buf[at]);
    const l = this.line(at);
    if (!l) return null;
    switch (type) {
      case '+': return { value: l.text, end: l.next };
      case '-': return { value: new ValkeyError('REPLY', l.text.slice(0, 200)), end: l.next };
      case ':': return { value: Number(l.text), end: l.next };
      case '$': {
        const n = Number(l.text);
        if (n < 0) return { value: null, end: l.next };
        if (this.buf.length < l.next + n + 2) return null;
        return { value: this.buf.subarray(l.next, l.next + n), end: l.next + n + 2 };
      }
      case '*': {
        const n = Number(l.text);
        if (n < 0) return { value: null, end: l.next };
        const items = [];
        let end = l.next;
        for (let i = 0; i < n; i++) {
          const r = this.parse(end);
          if (!r) return null;
          items.push(r.value);
          end = r.end;
        }
        return { value: items, end };
      }
      default: throw new ValkeyError('PROTOCOL', 'unexpected reply type');
    }
  }
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

export class ValkeyClient {
  /**
   * @param {{ url: string, password?: string | null, log?: object, connectTimeoutMs?: number, commandTimeoutMs?: number,
   *   maxPending?: number, connect?: Function }} opts  `connect` (tests): (options) => a net.Socket-like stream
   */
  constructor({ url, password = null, log = noopLog, connectTimeoutMs = 2000, commandTimeoutMs = 3000, maxPending = 256, connect = null }) {
    this.target = parseValkeyUrl(url);
    if (password) this.target.password = password;
    this.log = log;
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxPending = maxPending;
    this.connectFn = connect;
    this.socket = null;
    /** @type {{ resolve: Function, reject: Function, timer: any }[]} replies the open connection still owes */
    this.inflight = [];
    /** @type {{ args: any[], resolve: Function, reject: Function }[]} commands waiting for the connection attempt */
    this.waiting = [];
    this.state = 'idle'; // idle | connecting | ready | closed
    this.retryAt = 0;
    this.backoffMs = 200;
    this.connecting = null;
    this.stats = { connects: 0, failures: 0, commands: 0, errors: 0 };
    this.warnedAt = -Infinity;
  }

  get ready() { return this.state === 'ready'; }

  /** One command. @returns {Promise<any>} the reply; rejects with ValkeyError (UNAVAILABLE, TIMEOUT, REPLY, …) */
  command(...args) {
    if (this.state === 'closed') return Promise.reject(new ValkeyError('CLOSED'));
    this.stats.commands++;
    if (this.state === 'ready') return this.send(args);
    if (this.state === 'idle') {
      if (Date.now() < this.retryAt) return Promise.reject(new ValkeyError('UNAVAILABLE'));
      this.open();
    }
    if (this.waiting.length >= this.maxPending) return Promise.reject(new ValkeyError('UNAVAILABLE'));
    return new Promise((resolve, reject) => this.waiting.push({ args, resolve, reject }));
  }

  send(args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.state !== 'ready' && this.state !== 'connecting') { reject(new ValkeyError('UNAVAILABLE')); return; }
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => this.drop(new ValkeyError('TIMEOUT')), this.commandTimeoutMs);
      entry.timer.unref?.();
      this.inflight.push(entry);
      try { this.socket.write(encodeCommand(args)); } catch { this.drop(new ValkeyError('UNAVAILABLE')); }
    });
  }

  open() {
    this.state = 'connecting';
    const t = this.target;
    const parser = new ReplyParser();
    let socket;
    try {
      socket = this.connectFn ? this.connectFn(t)
        : t.tls ? tls.connect({ host: t.host, port: t.port, servername: net.isIP(t.host) ? undefined : t.host })
          : net.connect({ host: t.host, port: t.port });
    } catch { this.fail(new ValkeyError('UNAVAILABLE')); return; }
    this.socket = socket;
    socket.setNoDelay?.(true);
    const timer = setTimeout(() => { if (this.socket === socket && this.state === 'connecting') this.drop(new ValkeyError('UNAVAILABLE')); }, this.connectTimeoutMs);
    timer.unref?.();
    socket.on('data', (chunk) => {
      if (this.socket !== socket) return;
      let replies;
      try { replies = parser.feed(chunk); } catch (e) { this.drop(e); return; }
      for (const value of replies) {
        const entry = this.inflight.shift();
        if (!entry) { this.drop(new ValkeyError('PROTOCOL', 'unexpected reply')); return; }
        clearTimeout(entry.timer);
        if (value instanceof ValkeyError) { this.stats.errors++; entry.reject(value); } else entry.resolve(value);
      }
    });
    socket.on('error', () => { if (this.socket === socket) this.drop(new ValkeyError('UNAVAILABLE')); });
    socket.on('close', () => { if (this.socket === socket) this.drop(new ValkeyError('UNAVAILABLE')); });
    socket.once(t.tls ? 'secureConnect' : 'connect', async () => {
      if (this.socket !== socket) return;
      try {
        if (t.password) await this.send(t.username ? ['AUTH', t.username, t.password] : ['AUTH', t.password]);
        if (t.db) await this.send(['SELECT', t.db]);
        await this.send(['PING']);
      } catch (e) {
        if (this.socket === socket) this.drop(e instanceof ValkeyError && e.code === 'REPLY' ? new ValkeyError('AUTH') : e);
        return;
      }
      if (this.socket !== socket) return;
      clearTimeout(timer);
      this.state = 'ready';
      this.backoffMs = 200;
      this.stats.connects++;
      const waiting = this.waiting; this.waiting = [];
      for (const w of waiting) this.send(w.args).then(w.resolve, w.reject);
    });
  }

  /** The connection failed or can no longer be trusted: fail everything it owes and back off. */
  drop(error) {
    const socket = this.socket;
    this.socket = null;
    try { socket?.destroy(); } catch { /* already gone */ }
    const inflight = this.inflight; this.inflight = [];
    for (const e of inflight) { clearTimeout(e.timer); e.reject(error); }
    this.fail(error);
  }

  fail(error) {
    if (this.state === 'closed') return;
    this.stats.failures++;
    this.state = 'idle';
    this.retryAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(5000, this.backoffMs * 2);
    const waiting = this.waiting; this.waiting = [];
    for (const w of waiting) w.reject(error);
    const now = Date.now();
    if (now - this.warnedAt > 60_000) {
      this.warnedAt = now;
      try { this.log.warn?.(`[persist] store unavailable (${error?.code || 'error'}); checkpoints are skipped until it answers`); } catch { /* logging only */ }
    }
  }

  async close() {
    if (this.state === 'closed') return;
    const socket = this.socket;
    this.state = 'closed';
    this.socket = null;
    const inflight = this.inflight; this.inflight = [];
    for (const e of inflight) { clearTimeout(e.timer); e.reject(new ValkeyError('CLOSED')); }
    for (const w of this.waiting) w.reject(new ValkeyError('CLOSED'));
    this.waiting = [];
    if (socket) await new Promise((resolve) => { socket.once('close', resolve); try { socket.end(); } catch { resolve(); } setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } resolve(); }, 500).unref?.(); });
  }
}
