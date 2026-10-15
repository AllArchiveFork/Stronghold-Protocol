// test/helpers/memoryStore.js — an in-memory stand-in for the checkpoint store's Valkey client (server/persist/valkey.js):
// GET / SET [PX] / DEL / PING / HSET / HDEL / HGETALL / PEXPIRE on Maps that outlives the servers of a test, and a switch to make it fail like a store
// that is down.
import { CheckpointStore } from '../../server/persist/store.js';

export class MemoryValkey {
  constructor() {
    /** @type {Map<string, Buffer>} */
    this.data = new Map();
    /** @type {Map<string, Map<string, Buffer>>} */
    this.hashes = new Map();
    this.down = false;
    this.ready = true;
    this.stats = { connects: 1, failures: 0 };
    this.commands = [];
  }

  async command(name, ...args) {
    this.commands.push(name);
    if (this.down) { const e = new Error('UNAVAILABLE'); e.code = 'UNAVAILABLE'; throw e; }
    switch (name) {
      case 'PING': return 'PONG';
      case 'GET': return this.data.get(String(args[0])) ?? null;
      case 'SET': this.data.set(String(args[0]), Buffer.isBuffer(args[1]) ? Buffer.from(args[1]) : Buffer.from(String(args[1]))); return 'OK';
      case 'DEL': return (this.data.delete(String(args[0])) || this.hashes.delete(String(args[0]))) ? 1 : 0;
      case 'HSET': {
        const h = this.hash(args[0]);
        for (let i = 1; i + 1 < args.length; i += 2) h.set(String(args[i]), Buffer.from(String(args[i + 1])));
        return args.length >> 1;
      }
      case 'HDEL': { const h = this.hash(args[0]); let n = 0; for (const f of args.slice(1)) n += h.delete(String(f)) ? 1 : 0; return n; }
      case 'HGETALL': { const h = this.hashes.get(String(args[0])); return h ? [...h].flatMap(([f, v]) => [Buffer.from(f), v]) : []; }
      case 'PEXPIRE': return 1;
      default: throw new Error(`unsupported ${name}`);
    }
  }

  hash(key) { let h = this.hashes.get(String(key)); if (!h) this.hashes.set(String(key), h = new Map()); return h; }
  keys(prefix = '') { return [...this.data.keys(), ...this.hashes.keys()].filter((k) => k.startsWith(prefix)).sort(); }
  async close() {}
}

/** A CheckpointStore over a shared MemoryValkey (a fresh store object per server, like a restarted process). */
export function memoryStore(client, opts = {}) {
  return new CheckpointStore({ url: 'redis://memory', client, ...opts });
}
