// The checkpoint store against a real Valkey (server/persist/valkey.js, store.js; docs/DEPLOY.md「断点续玩」). Opt-in:
// SP_TEST_REDIS_URL=redis://:password@127.0.0.1:port/0 names a throwaway instance (its keys under a random prefix are
// written and deleted); without it the suite is skipped. The unreachable-store cases need no instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { ValkeyClient, ReplyParser, encodeCommand, parseValkeyUrl } from '../server/persist/valkey.js';
import { CheckpointStore, storeConfig } from '../server/persist/store.js';
import { startServer } from '../server/index.js';
import { Match } from '../server/match/Match.js';
import { TestClient } from './helpers/wsClient.js';
import { stack, stop, nodeConfigs, actorOf, playToPrep, client, until } from './helpers/clusterStack.js';

const URL_ = process.env.SP_TEST_REDIS_URL || '';
const live = { skip: URL_ ? false : 'SP_TEST_REDIS_URL not set' };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Delete every key of a test prefix (SCAN), then close. */
async function dropPrefix(prefix) {
  const store = new CheckpointStore({ url: URL_, prefix, log: quiet });
  let cursor = '0';
  do {
    const [next, keys] = await store.client.command('SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', 1000);
    cursor = next.toString();
    for (const k of keys) await store.client.command('DEL', k);
  } while (cursor !== '0');
  await store.close();
}

test('RESP: commands encode as arrays of bulk strings; replies parse across chunk boundaries', () => {
  assert.equal(encodeCommand(['SET', 'k', Buffer.from('v1'), 'PX', 10]).toString(), '*5\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\nv1\r\n$2\r\nPX\r\n$2\r\n10\r\n');
  const p = new ReplyParser();
  const wire = Buffer.from('+OK\r\n$5\r\nhello\r\n$-1\r\n:42\r\n-ERR nope\r\n*2\r\n$1\r\na\r\n*-1\r\n');
  const out = [];
  for (let i = 0; i < wire.length; i += 3) out.push(...p.feed(wire.subarray(i, i + 3)));
  assert.equal(out[0], 'OK');
  assert.equal(out[1].toString(), 'hello');
  assert.equal(out[2], null);
  assert.equal(out[3], 42);
  assert.equal(out[4].code, 'REPLY');
  // a store still loading its data set: its own code (the startup read waits it out, test/persist-startup.test.js)
  assert.equal(new ReplyParser().feed(Buffer.from('-LOADING Valkey is loading the dataset in memory\r\n'))[0].code, 'LOADING');
  assert.equal(out[5][0].toString(), 'a');
  assert.equal(out[5][1], null);
});

test('URL and configuration: schemes, credentials, database; off without SP_REDIS_URL', () => {
  assert.deepEqual(parseValkeyUrl('redis://u:p%40ss@10.0.0.5:6380/2'), { host: '10.0.0.5', port: 6380, tls: false, username: 'u', password: 'p@ss', db: 2 });
  assert.equal(parseValkeyUrl('valkeys://store.internal').tls, true);
  assert.throws(() => parseValkeyUrl('http://x'));
  assert.throws(() => parseValkeyUrl('redis://x/999'));
  assert.equal(storeConfig({}, {}), null);
  assert.deepEqual(storeConfig({}, { SP_REDIS_URL: 'redis://x', SP_REDIS_PREFIX: 'formal:' }), { url: 'redis://x', prefix: 'formal:', passwordFile: null });
  assert.throws(() => storeConfig({}, { SP_REDIS_URL: 'redis://x', SP_REDIS_PREFIX: 'bad prefix' }));
});

test('a store that does not answer fails fast and then backs off: nothing waits on it', async () => {
  const server = net.createServer(); // a port that is closed again at once
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const client = new ValkeyClient({ url: `redis://127.0.0.1:${port}`, log: quiet, connectTimeoutMs: 500 });
  const t0 = Date.now();
  await assert.rejects(client.command('PING'), (e) => e.code === 'UNAVAILABLE');
  assert.ok(Date.now() - t0 < 2000);
  const t1 = Date.now();
  await assert.rejects(client.command('PING'), (e) => e.code === 'UNAVAILABLE');
  assert.ok(Date.now() - t1 < 50, 'during the backoff a command fails at once');
  const store = new CheckpointStore({ url: `redis://127.0.0.1:${port}`, client, log: quiet });
  assert.equal(await store.saveLobby({ v: 1 }), false);
  assert.deepEqual(await store.loadLobby(), { ok: false, value: null, error: 'UNAVAILABLE' });
  assert.equal(store.snapshot().writeFailures, 1);
  await store.close();
});

test('real Valkey: values round-trip (large ones deflated), keys expire, a wrong password is refused', live, async (t) => {
  const prefix = `sptest-${randomBytes(4).toString('hex')}:`;
  const store = new CheckpointStore({ url: URL_, prefix, log: quiet });
  t.after(() => store.close());
  assert.equal(await store.ping(), true);
  const big = { v: 1, boards: Array.from({ length: 2000 }, (_, i) => ({ i, piece: 'char_' + (i % 97), items: [i, i * 2] })) };
  assert.equal(await store.saveCheckpoint('A.1', big), true);
  assert.deepEqual((await store.loadCheckpoint('A.1')).value, big);
  const raw = await store.client.command('GET', prefix + 'cp:A.1');
  assert.equal(raw[0], 0x01, 'deflated');
  assert.ok(raw.length < JSON.stringify(big).length / 3);
  const ttl = await store.client.command('PTTL', prefix + 'cp:A.1');
  assert.ok(ttl > 24 * 3600_000 && ttl <= 25 * 3600_000);
  assert.equal(await store.deleteCheckpoint('A.1'), true);
  assert.deepEqual(await store.loadCheckpoint('A.1'), { ok: true, value: null });
  const u = new URL(URL_);
  u.password = 'wrong-password';
  const bad = new CheckpointStore({ url: u.toString(), prefix, log: quiet });
  assert.equal(await bad.saveLobby({ v: 1 }), false);
  await bad.close();
});

class QuickMatch extends Match {
  constructor(opts) { super({ ...opts, clientCombat: false, botRehearsal: 0, combatSpeed: 200 }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('real Valkey: a solo run survives a server restart', { ...live, timeout: 60_000 }, async (t) => {
  const prefix = `sptest-${randomBytes(4).toString('hex')}:`;
  const opts = { host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0, studio: false, assetIndex: false,
    MatchClass: QuickMatch, redisUrl: URL_, redisPrefix: prefix, persistSaveMs: 60_000 };
  const a = await startServer(opts);
  const c = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const w = await c.hello('Doctor');
  assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  const code = a.registry.byId(w.playerId).roomCode, match = a.lobby.rooms.get(code).match;
  for (let i = 0; i < 2000 && !(match.phase === 'BAND_DRAFT'); i++) {
    if (match.phase === 'INFO_CHECK') match.handle(w.playerId, { t: 'g.infoReady' });
    await sleep(10);
  }
  assert.equal(match.phase, 'BAND_DRAFT');
  await a.close();
  const b = await startServer(opts);
  t.after(async () => { await b.close(); await dropPrefix(prefix); });
  assert.equal(b.persistence.restored.matches, 1);
  const back = await TestClient.connect(`ws://127.0.0.1:${b.port}/ws`);
  assert.equal((await back.hello('Doctor', w.token)).playerId, w.playerId);
  assert.equal((await back.waitFor('m.public', (m) => m.phase === 'BAND_DRAFT')).phase, 'BAND_DRAFT');
  await back.close();
});

test('real Valkey: the whole cluster restarts and the match comes back on a node from its checkpoint', { ...live, timeout: 120_000 }, async (t) => {
  const prefix = `sptest-${randomBytes(4).toString('hex')}:`, stores = [];
  const storeFor = () => { const s = new CheckpointStore({ url: URL_, prefix, log: quiet }); stores.push(s); return s; };
  t.after(async () => { await Promise.all(stores.map((s) => s.close())); await dropPrefix(prefix); });
  const configs = nodeConfigs();
  const first = await stack(storeFor, { configs });
  const { c, code, ps } = await playToPrep(first, 1);
  const funds = ps.funds;
  await stop(first);
  await c.closed;
  const second = await stack(storeFor, { configs });
  t.after(() => stop(second));
  await until(() => second.coordinator.lobby.restoreStats.rebuilt === 1, 15_000, 'rebuilt');
  const back = await client(second.ingress.url, 'Doctor', c.token);
  await until(() => back.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP' && f.round === 1), 10_000, 'resync');
  assert.equal(actorOf(second, code).match.players.get(c.playerId).funds, funds);
  const health = await (await fetch(`${second.coordinator.url}/healthz`)).json();
  assert.equal(health.persistence.remote.rebuilt, 1);
  assert.equal(health.persistence.restoredRooms, 1);
  back.socket.close();
});
