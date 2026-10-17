// server/persist/store.js — where checkpoints live (docs/DEPLOY.md「断点续玩」): a Valkey / Redis compatible store named
// by SP_REDIS_URL (off when unset — nothing connects, nothing changes). Keys, under the prefix SP_REDIS_PREFIX
// (default `sp:`; one per deployment profile when several share a store):
//
//   <prefix>lobby        the lobby document's head { v, kind, savedAt } (server/persist/lobbyState.js) — written by a
//                        single-process server or the cluster coordinator, after
//   <prefix>lobby:sessions / <prefix>lobby:rooms   hashes of its records by player id / room code, each written only when it
//                        changed (persister.js): thousands of sessions cost nothing while they stay as they are
//   <prefix>cp:<id>      one match checkpoint (server/match/snapshot.js + its platform envelope): a local match's id is
//                        `L.<room>.<matchNo>.<seed>`, a cluster match's is its assignment id — written by the process
//                        running the match (the server, or the game node), deleted when the match ends
//
// Values are JSON, deflated off the main thread (libuv's pool, not a Worker) once larger than 1 KiB. Every key carries
// a TTL (25 h: longer than a solo run's 24 h reconnect window); a write refreshes it. A store that is down costs nothing
// but the checkpoints: every call resolves false / null and is counted (stats, /healthz `persistence`); a read that
// failed says why (`error`: the client's code, DATA for a value that does not decode, CLOSED) — the startup read waits
// out the TRANSIENT ones (persister.js restore, node.js load).

import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { ValkeyClient } from './valkey.js';

const deflate = promisify(zlib.deflateRaw);
const inflate = promisify(zlib.inflateRaw);

/** Key lifetime (ms). */
export const STORE_TTL_MS = 25 * 3600_000;
/** Values larger than this are deflated. */
const DEFLATE_MIN = 1024;
/** First byte of a deflated value (JSON values start with `{`). */
const DEFLATED = 0x01;
/** Fields per HSET / HDEL command. */
const HASH_CHUNK = 256;
/** Largest value read back (a corrupt or foreign key cannot make the server inflate gigabytes). */
const MAX_VALUE_BYTES = 64 * 1024 * 1024;

/**
 * The read failures that pass by themselves (valkey.js codes): the store not reachable (yet), no reply in time, or still
 * loading its data set. A refused password, an error reply or a value that does not decode (DATA) stay as they are.
 */
export const TRANSIENT_FAILURES = new Set(['UNAVAILABLE', 'TIMEOUT', 'LOADING']);

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const PREFIX_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The store configuration from the environment / options, or null when persistence is off.
 * @param {{ url?: string | null, prefix?: string | null, passwordFile?: string | null }} [opts]
 * @param {Record<string, string | undefined>} [env]
 */
export function storeConfig(opts = {}, env = process.env) {
  const url = opts.url ?? env.SP_REDIS_URL ?? '';
  if (!String(url).trim()) return null;
  const prefix = String(opts.prefix ?? env.SP_REDIS_PREFIX ?? 'sp:');
  if (!PREFIX_RE.test(prefix)) throw new TypeError('invalid SP_REDIS_PREFIX');
  const passwordFile = opts.passwordFile ?? env.SP_REDIS_PASSWORD_FILE ?? null;
  return { url: String(url).trim(), prefix, passwordFile: passwordFile ? String(passwordFile) : null };
}

export class CheckpointStore {
  /**
   * @param {{ url: string, prefix?: string, passwordFile?: string | null, log?: object, client?: any, ttlMs?: number }} opts
   *   `client` (tests): an object with command(...args) and close()
   */
  constructor({ url, prefix = 'sp:', passwordFile = null, log = noopLog, client = null, ttlMs = STORE_TTL_MS }) {
    this.prefix = prefix;
    this.log = log;
    this.ttlMs = ttlMs;
    let password = null;
    if (passwordFile) password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
    this.client = client || new ValkeyClient({ url, password, log });
    this.stats = { writes: 0, writeFailures: 0, reads: 0, readFailures: 0, deletes: 0, bytesWritten: 0, lastWriteAt: null };
    this.closed = false;
  }

  key(name) { return this.prefix + name; }
  checkpointKey(id) {
    if (!ID_RE.test(String(id))) throw new TypeError('invalid checkpoint id');
    return this.key(`cp:${id}`);
  }

  /** Is the store answering now (a PING)? */
  async ping() {
    try { return String(await this.client.command('PING')) === 'PONG'; } catch { return false; }
  }

  async encode(value) {
    const json = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    if (json.length < DEFLATE_MIN) return json;
    const packed = await deflate(json, { level: 6 });
    return Buffer.concat([Buffer.from([DEFLATED]), packed]);
  }

  async decode(buf) {
    if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_VALUE_BYTES) return null;
    const json = buf[0] === DEFLATED ? await inflate(buf.subarray(1), { maxOutputLength: MAX_VALUE_BYTES }) : buf;
    return JSON.parse(json.toString('utf8'));
  }

  /** Write a value (an object, or its JSON text). @returns {Promise<boolean>} */
  async put(key, value) {
    if (this.closed) return false;
    try {
      const bytes = await this.encode(value);
      await this.client.command('SET', key, bytes, 'PX', this.ttlMs);
      this.stats.writes++;
      this.stats.bytesWritten += bytes.length;
      this.stats.lastWriteAt = Date.now();
      return true;
    } catch (e) {
      this.stats.writeFailures++;
      this.log.debug?.(`[persist] write failed (${e?.code || e?.message || 'error'})`);
      return false;
    }
  }

  /**
   * @returns {Promise<{ ok: boolean, value: any, error?: string }>} ok false: the store did not answer or the value did not
   *   decode (`error`, see the header); value null: no such key
   */
  async get(key) {
    if (this.closed) return { ok: false, value: null, error: 'CLOSED' };
    let raw;
    try { raw = await this.client.command('GET', key); } catch (e) { return this.readFailed(e); }
    this.stats.reads++;
    if (raw == null) return { ok: true, value: null };
    try { return { ok: true, value: await this.decode(raw) }; } catch { return this.readFailed({ code: 'DATA' }); }
  }

  /** A failed read, counted. @returns {{ ok: false, value: null, error: string }} */
  readFailed(e) {
    const error = typeof e?.code === 'string' ? e.code : 'ERROR';
    this.stats.readFailures++;
    this.log.debug?.(`[persist] read failed (${error})`);
    return { ok: false, value: null, error };
  }

  async del(key) {
    if (this.closed) return false;
    try { await this.client.command('DEL', key); this.stats.deletes++; return true; } catch { return false; }
  }

  /**
   * Write and delete fields of a hash (`entries`: [field, JSON text]) in bounded commands, then refresh its TTL.
   * @returns {Promise<boolean>}
   */
  async hashUpdate(name, entries, removed = []) {
    if (this.closed) return false;
    const key = this.key(name);
    try {
      for (let i = 0; i < entries.length; i += HASH_CHUNK) {
        const args = [];
        for (const [field, text] of entries.slice(i, i + HASH_CHUNK)) { args.push(field, text); this.stats.bytesWritten += text.length; }
        await this.client.command('HSET', key, ...args);
      }
      for (let i = 0; i < removed.length; i += HASH_CHUNK) await this.client.command('HDEL', key, ...removed.slice(i, i + HASH_CHUNK));
      if (entries.length || removed.length) await this.client.command('PEXPIRE', key, this.ttlMs);
      this.stats.writes++;
      this.stats.lastWriteAt = Date.now();
      return true;
    } catch (e) {
      this.stats.writeFailures++;
      this.log.debug?.(`[persist] hash write failed (${e?.code || e?.message || 'error'})`);
      return false;
    }
  }

  /** Every field of a hash, parsed. @returns {Promise<{ ok: boolean, value: Map<string, any> | null, error?: string }>} */
  async hashRead(name) {
    if (this.closed) return { ok: false, value: null, error: 'CLOSED' };
    let flat;
    try { flat = await this.client.command('HGETALL', this.key(name)); } catch (e) { return this.readFailed(e); }
    this.stats.reads++;
    const out = new Map();
    for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2) {
      try { out.set(flat[i].toString(), JSON.parse(flat[i + 1].toString('utf8'))); } catch { /* a broken record is skipped */ }
    }
    return { ok: true, value: out };
  }

  saveCheckpoint(id, value) { return this.put(this.checkpointKey(id), value); }
  loadCheckpoint(id) { return this.get(this.checkpointKey(id)); }
  deleteCheckpoint(id) { return this.del(this.checkpointKey(id)); }
  saveLobby(value) { return this.put(this.key('lobby'), value); }
  loadLobby() { return this.get(this.key('lobby')); }

  snapshot() {
    const c = this.client.stats || {};
    return { ...this.stats, connected: !!this.client.ready, connects: c.connects ?? 0, connectFailures: c.failures ?? 0 };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.client.close(); } catch { /* closing */ }
  }
}

/** A store from the configuration (storeConfig), or null. */
export function createCheckpointStore(config, { log = noopLog } = {}) {
  if (!config) return null;
  return new CheckpointStore({ ...config, log });
}
