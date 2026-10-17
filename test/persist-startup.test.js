// The startup read of the checkpoint store (server/persist/persister.js restore, node.js load; docs/DEPLOY.md「断点续玩」):
// a host boot or a bare start runs the store's container and the server at once, so the store may refuse connections
// or still be loading its data set when the server reads the saved lobby. That read is asked again with a growing
// pause for up to RESTORE_WAIT_MS — the server does not listen meanwhile — and only for a store that is not answering
// (UNAVAILABLE / TIMEOUT / LOADING); a refused password or a value that does not decode is final at once. A game node
// asked to rebuild a match while its store is not answering says NOT_READY and the coordinator asks again.
// Real HTTP/WS servers and the real Valkey client against a small RESP server over an in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from '../server/index.js';
import { ReplyParser, ValkeyError } from '../server/persist/valkey.js';
import { LobbyPersister, RESTORE_WAIT_MS } from '../server/persist/persister.js';
import { NodeCheckpoints } from '../server/persist/node.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';
import { MemoryValkey, memoryStore } from './helpers/memoryStore.js';
import { stack, stop, nodeConfigs, playToPrep, client, until } from './helpers/clusterStack.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = { host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0, studio: false, assetIndex: false, persistSaveMs: 60_000 };
const LOADING = 'LOADING Valkey is loading the dataset in memory';

/** A logger that keeps every line. */
function capture() {
  const lines = [];
  const at = (level) => (...a) => lines.push(`${level} ${a.map(String).join(' ')}`);
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), debug() {} } };
}

/** A port nothing listens on (closed again at once). */
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** RESP2 encoding of a reply. */
function reply(v) {
  if (v instanceof ValkeyError) return Buffer.from(`-${v.message}\r\n`);
  if (v == null) return Buffer.from('$-1\r\n');
  if (typeof v === 'number') return Buffer.from(`:${v}\r\n`);
  if (typeof v === 'string') return Buffer.from(`+${v}\r\n`);
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`$${v.length}\r\n`), v, Buffer.from('\r\n')]);
  return Buffer.concat([Buffer.from(`*${v.length}\r\n`), ...v.map(reply)]);
}

/**
 * A MemoryValkey served over TCP with a password, as Valkey answers while it loads its data set: `loading` → AUTH is
 * accepted, every other command (PING too) gets -LOADING.
 */
async function respServer(memory, { port = 0, password = 'pw' } = {}) {
  const sockets = new Set(), seen = [];
  const state = { loading: false, seen };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const parser = new ReplyParser();
    let chain = Promise.resolve();
    socket.on('data', (chunk) => {
      for (const args of parser.feed(chunk)) chain = chain.then(async () => {
        const name = args[0].toString().toUpperCase(), rest = args.slice(1);
        seen.push(state.loading && name !== 'AUTH' ? `${name}:loading` : name);
        let out;
        if (name === 'AUTH') out = rest.at(-1).toString() === password ? 'OK' : new ValkeyError('REPLY', 'WRONGPASS invalid username-password pair');
        else if (state.loading) out = new ValkeyError('LOADING', LOADING);
        else {
          try { out = await memory.command(name, ...rest.map((b) => (name === 'SET' && b === rest[1] ? b : b.toString()))); }
          catch (e) { out = new ValkeyError('REPLY', `ERR ${e.message}`); }
        }
        if (!socket.destroyed) socket.write(reply(out));
      });
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  state.url = `redis://:${password}@127.0.0.1:${server.address().port}/0`;
  state.close = async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); };
  return state;
}

/** A first server lifetime over `memory`: a co-op room with its host and a guest, saved at close. */
async function savedLobby(memory) {
  const a = await startServer({ ...base, persistStore: memoryStore(memory) });
  const host = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const hw = await host.hello('Host', undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await host.waitFor('room.state');
  const guest = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const gw = await guest.hello('Guest', undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await guest.request({ t: 'room.join', code: room.code })).t, 'ok');
  await a.close();
  assert.ok(memory.data.has('sp:lobby'), 'the lobby was saved');
  return { code: room.code, host: hw, guest: gw };
}

/** Is anything listening on the port? */
const listening = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

/** The guest comes back to its room on the restarted server. */
async function guestBack(b, saved) {
  const back = await TestClient.connect(`ws://127.0.0.1:${b.port}/ws`);
  assert.equal((await back.hello('Guest', saved.guest.token, { matchmakingVersion: MATCHMAKING_VERSION })).playerId, saved.guest.playerId);
  assert.equal((await back.waitFor('room.state')).code, saved.code);
  await back.close();
}

test('startup: a store that refuses connections at first is read again once it is up; the server listens only after the restore', { timeout: 60_000 }, async (t) => {
  const memory = new MemoryValkey();
  const saved = await savedLobby(memory);
  const storePort = await freePort(), webPort = await freePort();
  const { lines, log } = capture();
  const t0 = Date.now();
  let started = false;
  const starting = startServer({ ...base, port: webPort, log, redisUrl: `redis://:pw@127.0.0.1:${storePort}/0` });
  starting.then(() => { started = true; }, () => {});
  await sleep(1200);
  assert.equal(started, false, 'still reading the store');
  assert.equal(await listening(webPort), false, 'no player is accepted before the lobby is back');
  assert.ok(lines.some((l) => /not answering at startup \(UNAVAILABLE\): attempt 2 in 0\.5 s/.test(l)), lines.join('\n'));
  const store = await respServer(memory, { port: storePort });
  t.after(() => store.close());
  const b = await starting;
  t.after(() => b.close());
  assert.equal(b.persistence.restored.ok, true);
  assert.equal(b.persistence.restored.rooms, 1);
  assert.equal(b.persistence.restored.sessions, 2);
  assert.ok(Date.now() - t0 < 15_000);
  assert.ok(lines.some((l) => /^info \[persist\] the store answered at startup \(attempt \d+, [\d.]+ s\)/.test(l)), lines.join('\n'));
  await guestBack(b, saved);
});

test('startup: a store still loading its data set (-LOADING, also to the connection\'s PING) is waited for, not taken for a refused password', { timeout: 60_000 }, async (t) => {
  const memory = new MemoryValkey();
  const saved = await savedLobby(memory);
  const store = await respServer(memory);
  t.after(() => store.close());
  store.loading = true;
  const { lines, log } = capture();
  let started = false;
  const starting = startServer({ ...base, log, redisUrl: store.url });
  starting.then(() => { started = true; }, () => {});
  await until(() => store.seen.filter((c) => c === 'PING:loading').length >= 2, 10_000, 'two attempts while loading');
  assert.equal(started, false);
  assert.ok(store.seen.includes('AUTH'), 'the password was accepted meanwhile');
  assert.ok(lines.some((l) => /not answering at startup \(LOADING\)/.test(l)), lines.join('\n'));
  store.loading = false;
  const b = await starting;
  t.after(() => b.close());
  assert.equal(b.persistence.restored.rooms, 1);
  assert.equal(lines.filter((l) => /could not be read|did not answer/.test(l)).length, 0, lines.join('\n'));
  await guestBack(b, saved);
});

/** A LobbyPersister over a store whose client fails as told (`fail(name, n)` → a code, or nothing to answer). */
function scripted(fail, { restoreWaitMs } = {}) {
  const memory = new MemoryValkey();
  let n = 0;
  const client = { stats: memory.stats, ready: true, close: async () => {},
    command: async (name, ...args) => {
      const code = fail(name, n++);
      if (code) throw new ValkeyError(code);
      return memory.command(name, ...args);
    } };
  let clock = 1_000_000;
  const sleeps = [];
  const { lines, log } = capture();
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, getData: () => ({}) });
  const persister = new LobbyPersister({ store: memoryStore(client), registry, lobby, log, now: () => clock, restoreWaitMs,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  return { memory, persister, sleeps, lines, lobby, commands: memory.commands };
}

test('startup: a store that never answers is given up after RESTORE_WAIT_MS (pauses 0.5 s doubling to 5 s), each retry and the outcome logged', async () => {
  assert.equal(RESTORE_WAIT_MS, 60_000);
  for (const code of ['UNAVAILABLE', 'TIMEOUT', 'LOADING']) {
    const s = scripted(() => code);
    const out = await s.persister.restore();
    assert.deepEqual(out, { ok: false, reason: 'unavailable' });
    assert.deepEqual(s.sleeps.slice(0, 5), [500, 1000, 2000, 4000, 5000]);
    assert.ok(s.sleeps.slice(4).every((ms) => ms === 5000));
    const total = s.sleeps.reduce((a, b) => a + b, 0);
    assert.ok(total <= RESTORE_WAIT_MS && total + 5000 > RESTORE_WAIT_MS, `waited ${total} ms`);
    assert.equal(s.lines.filter((l) => l.includes('not answering at startup')).length, s.sleeps.length, 'each retry logged');
    assert.equal(s.lines.at(-1), `warn [persist] the store did not answer at startup (${code}, ${s.sleeps.length + 1} attempt(s) in ${(total / 1000).toFixed(1)} s): nothing restored`);
    s.lobby.shutdown();
  }
  // a budget of 0 (persistRestoreWaitMs): one read, as before
  const once = scripted(() => 'UNAVAILABLE', { restoreWaitMs: 0 });
  assert.deepEqual(await once.persister.restore(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(once.sleeps, []);
  once.lobby.shutdown();
});

test('startup: a document that does not decode, a refused password or an error reply is final at once — no retry', async () => {
  // the lobby head is there but is no deflated JSON
  const corrupt = scripted(() => null);
  await corrupt.memory.command('SET', 'sp:lobby', Buffer.from([0x01, 0xde, 0xad, 0xbe, 0xef]));
  assert.deepEqual(await corrupt.persister.restore(), { ok: false, reason: 'unreadable' });
  assert.deepEqual(corrupt.sleeps, []);
  assert.equal(corrupt.commands.filter((c) => c === 'GET').length, 1, 'read once');
  assert.match(corrupt.lines.at(-1), /^warn \[persist\] the saved lobby could not be read at startup \(DATA\): nothing restored$/);
  corrupt.lobby.shutdown();
  for (const code of ['AUTH', 'REPLY']) {
    const s = scripted(() => code);
    assert.deepEqual(await s.persister.restore(), { ok: false, reason: 'unreadable' });
    assert.deepEqual(s.sleeps, []);
    assert.match(s.lines.at(-1), new RegExp(`could not be read at startup \\(${code}\\)`));
    s.lobby.shutdown();
  }
  // a store that answers on the third attempt (nothing saved yet: a fresh start)
  const late = scripted((name, n) => (n < 2 ? 'UNAVAILABLE' : null));
  assert.deepEqual(await late.persister.restore(), { ok: true, sessions: 0, rooms: 0, matches: 0 });
  assert.deepEqual(late.sleeps, [500, 1000]);
  assert.match(late.lines.find((l) => l.includes('answered')), /attempt 3, 1\.5 s/);
  late.lobby.shutdown();
});

test('a cluster restarted with its store still loading: the coordinator waits for it, a node asked to rebuild a match says NOT_READY meanwhile, the coordinator asks again and the match comes back', { timeout: 120_000 }, async (t) => {
  // the node's read on its own: not answering → NOT_READY (the coordinator retries); missing → null (NO_CHECKPOINT)
  const memory = new MemoryValkey();
  let code = 'LOADING';
  const flaky = { stats: memory.stats, ready: true, close: async () => {},
    command: async (name, ...args) => { if (code && name === 'GET') throw new ValkeyError(code); return memory.command(name, ...args); } };
  const gameHost = { contexts: new Map(), onCheckpoint: null };
  const node = new NodeCheckpoints({ store: memoryStore(flaky), gameHost, nodeId: 'game-a', log: capture().log });
  for (code of ['LOADING', 'UNAVAILABLE', 'TIMEOUT']) await assert.rejects(node.load('A.1'), (e) => e.code === 'NOT_READY');
  code = null;
  assert.equal(await node.load('A.1'), null);
  assert.equal(node.counts.restoreFailures, 1, 'only the missing checkpoint counts as a failure');

  // the whole stack restarts with its store still loading: the coordinator's startup read waits for it, then the nodes'
  // checkpoint reads still say LOADING for a while (NOT_READY) and the coordinator asks them again
  const store = new MemoryValkey(), configs = nodeConfigs();
  const first = await stack(() => memoryStore(store), { configs });
  const { c, code: room } = await playToPrep(first, 1);
  await stop(first);
  await c.closed;
  let loading = 'all';
  const refused = { lobby: 0, checkpoints: 0 };
  const gated = { stats: store.stats, ready: true, close: async () => {},
    command: async (name, ...args) => {
      const checkpoint = String(args[0]).startsWith('sp:cp:');
      if (loading === 'all' || loading === 'checkpoints' && name === 'GET' && checkpoint) {
        refused[checkpoint ? 'checkpoints' : 'lobby']++;
        throw new ValkeyError('LOADING', LOADING);
      }
      return store.command(name, ...args);
    } };
  let up = null;
  const starting = stack(() => memoryStore(gated), { configs });
  starting.then((s) => { up = s; }, () => {});
  t.after(async () => { const s = await starting.catch(() => null); if (s) await stop(s); });
  await until(() => refused.lobby >= 2, 15_000, 'the coordinator read the store while loading');
  assert.equal(up, null, 'the coordinator is still in its startup read');
  loading = 'checkpoints';
  const second = await starting;
  assert.equal(second.coordinator.lobby.restoreStats.pending, 1, 'the match restored, its node not yet');
  await until(() => refused.checkpoints >= 2, 15_000, 'the nodes were asked while loading');
  assert.equal(second.coordinator.lobby.restoreStats.failed, 0, 'not given up');
  assert.ok(second.coordinator.lobby.getRoom(room)?.match, 'the room still holds its match');
  loading = null;
  await until(() => second.coordinator.lobby.restoreStats.rebuilt === 1, 15_000, 'rebuilt');
  const back = await client(second.ingress.url, 'Doctor', c.token);
  await until(() => back.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP' && f.round === 1), 10_000, 'resync');
  back.socket.close();
});
