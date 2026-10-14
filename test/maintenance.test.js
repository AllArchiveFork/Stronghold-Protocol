// The maintenance switch (fork lobby, 2026-10-14): the limits file's `maintenance` (server/onlineLimit.js, 0 | 1). While
// it is on, room.create / room.start / queue.join answer MAINTENANCE, the matchmaker forms no offer and the queue is
// emptied when it goes on; rooms, joins, spectating and running matches go on. Every switch reaches every online session
// as presence.state (maintenance: true while on) at once; /healthz limits report it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOnlineLimit, parseLimits } from '../server/onlineLimit.js';
import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { Matchmaking } from '../server/matchmaking.js';
import { SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { ERR, ERR_TEXT, MATCHMAKING_VERSION } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A limits object like server/onlineLimit.js createOnlineLimit, switched by hand. */
function switchable() {
  const watchers = new Set();
  const state = { on: false };
  return {
    caps: () => ({}), maintenance: () => state.on,
    onMaintenance(fn) { watchers.add(fn); return () => watchers.delete(fn); },
    set(on) { state.on = on; for (const fn of [...watchers]) fn(on); },
    watchers,
  };
}

function fixture(t, { LobbyClass = Lobby, extra = {} } = {}) {
  const limits = switchable();
  const registry = new SessionRegistry();
  const lobby = new LobbyClass({ registry, MatchClass: StubMatch, getData: () => ({}), log: quiet, limits, ...extra });
  t.after(() => lobby.shutdown());
  let count = 0;
  const player = () => {
    const s = registry.create(`Maint${++count}`);
    s.messages = []; s.connected = true; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const presence = (s) => s.messages.filter((m) => m.t === 'presence.state');
  return { limits, registry, lobby, player, presence };
}

test('the limits file key: maintenance 0 | 1 (missing = 0); any other value invalidates the file', () => {
  assert.deepEqual(parseLimits({ maintenance: 1 }), { limit: 0, caps: {}, maintenance: true });
  assert.deepEqual(parseLimits({ limit: 10, maxRooms: 5, maintenance: 0 }), { limit: 10, caps: { maxRooms: 5 }, maintenance: false });
  assert.equal(parseLimits({ limit: 10 }).maintenance, false);
  for (const bad of [2, -1, true, '1', 0.5, null]) assert.equal(parseLimits({ limit: 10, maintenance: bad }), null, String(bad));
});

test('the switch follows its file and tells its watchers once per flip', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-maint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'online-limit.json');
  const logs = [], flips = [];
  const limit = createOnlineLimit({ file, pollMs: 60_000, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  t.after(() => limit.close());
  const stop = limit.onMaintenance((on) => flips.push(on));
  limit.onMaintenance(() => { throw new Error('a broken watcher'); });
  await limit.refresh();
  assert.equal(limit.maintenance(), false);
  writeFileSync(file, '{ "limit": 100, "maintenance": 1 }\n');
  await limit.refresh();
  assert.equal(limit.maintenance(), true);
  assert.equal(limit.limit(), 100);
  writeFileSync(file, '{ "limit": 200, "maintenance": 1 }\n');
  await limit.refresh();
  assert.deepEqual(flips, [true], 'another key changing is no flip');
  writeFileSync(file, '{ "maintenance": "yes" }\n');
  await limit.refresh();
  assert.equal(limit.maintenance(), true, 'a bad edit keeps the switch');
  rmSync(file);
  await limit.refresh();
  assert.equal(limit.maintenance(), false, 'no file: off');
  assert.deepEqual(flips, [true, false]);
  stop();
  writeFileSync(file, '{ "maintenance": 1 }\n');
  await limit.refresh();
  assert.deepEqual(flips, [true, false], 'unsubscribed');
  assert.ok(logs.some((m) => /maintenance off → on/.test(m)) && logs.some((m) => /maintenance on → off/.test(m)), logs.join('\n'));
  assert.ok(logs.some((m) => /maintenance watcher failed/.test(m)), 'a throwing watcher is logged, not fatal');
});

test('while on: no new room, start or matchmaking; joins, spectating and running matches go on', (t) => {
  const { limits, lobby, player } = fixture(t);
  const a = player(), b = player(), c = player(), d = player();
  assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const room = lobby.roomOf(a);
  assert.deepEqual(lobby.create(c, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  assert.deepEqual(lobby.start(c), { ok: true });
  const running = lobby.roomOf(c).match;
  limits.set(true);
  assert.equal(lobby.create(b, { mode: 'coop', difficulty: 'NORMAL' }).error, ERR.MAINTENANCE);
  assert.equal(lobby.onMessage(b, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' }).error, ERR.MAINTENANCE);
  assert.equal(lobby.onMessage(b, { t: 'queue.join', difficulty: 'NORMAL' }).error, ERR.MAINTENANCE);
  assert.deepEqual(lobby.join(b, { code: room.code }), { ok: true }, 'joining an existing room is allowed');
  assert.deepEqual(lobby.spectate(d, { code: room.code }), { ok: true }, 'spectating is allowed');
  lobby.ready(b, { ready: true });
  assert.equal(lobby.start(a).error, ERR.MAINTENANCE);
  assert.equal(lobby.start(b).error, ERR.NOT_HOST, 'the host checks come first');
  assert.equal(lobby.roomOf(c).match, running, 'a running match is untouched');
  assert.deepEqual(lobby.limitStats().maintenance, 1);
  limits.set(false);
  assert.deepEqual(lobby.start(a), { ok: true });
  assert.equal(lobby.limitStats().maintenance, 0);
});

test('switching on empties the queue (reason maintenance) and refuses accepts; every online session hears it at once', (t) => {
  const { limits, lobby, player, presence } = fixture(t);
  const players = Array.from({ length: 6 }, () => player());
  const [p0, p1, p2, p3, p4, p5] = players;
  for (const s of [p0, p1, p2, p3]) assert.deepEqual(lobby.queue.join(s, { difficulty: 'NORMAL' }), { ok: true });
  const offer = lobby.queue.state(p0);
  assert.equal(offer.state, 'offered');
  // p5 plays a match (presence in a match is normally held back to PRESENCE_IN_MATCH_MS)
  lobby.create(p5, { mode: 'solo', difficulty: 'NORMAL' });
  lobby.start(p5);
  lobby.publishPresence();
  for (const s of players) s.messages.length = 0;
  limits.set(true);
  assert.equal(lobby.queue.size, 0);
  assert.equal(lobby.queue.offers.size, 0);
  for (const s of [p0, p1, p2, p3]) {
    assert.deepEqual(s.messages.find((m) => m.t === 'queue.state'), { t: 'queue.state', state: 'idle', ticketId: null, required: 4, reason: 'maintenance' });
  }
  for (const s of players) assert.equal(presence(s).at(-1)?.maintenance, true, `${s.name} told at once`);
  assert.equal(lobby.queue.accept(p0, { ticketId: offer.ticketId, offerId: offer.offerId }).error, ERR.MAINTENANCE);
  assert.equal(lobby.presenceState().maintenance, true);
  // a fresh hello learns it from its first presence.state
  const late = player();
  assert.equal(presence(late).at(-1).maintenance, true);
  for (const s of players) s.messages.length = 0;
  limits.set(false);
  for (const s of [p4, p5]) assert.equal(Object.hasOwn(presence(s).at(-1), 'maintenance'), false, 'omitted when off');
  assert.deepEqual(lobby.queue.join(p4, { difficulty: 'NORMAL' }), { ok: true });
  lobby.shutdown();
  assert.equal(limits.watchers.size, 0, 'shutdown stops following the switch');
});

test('the matchmaker forms no offer while paused, even for a ticket admitted just before the switch', () => {
  let paused = false, checks = 0;
  const sent = [];
  const mm = new Matchmaking({ send: (s, m) => sent.push(m), available: () => true, allocate: () => ({ code: 'ABCD' }),
    paused: () => paused && ++checks > 1 });
  const session = (i) => ({ playerId: `p${i}`, matchmakingVersion: MATCHMAKING_VERSION, limitKey: null });
  for (let i = 0; i < 3; i++) assert.deepEqual(mm.join(session(i), { difficulty: 'NORMAL' }), { ok: true });
  paused = true; // the fourth join passes its own check, the switch is on by its pump
  assert.deepEqual(mm.join(session(3), { difficulty: 'NORMAL' }), { ok: true });
  assert.equal(mm.offers.size, 0);
  assert.equal(mm.join(session(4), { difficulty: 'NORMAL' }).error, ERR.MAINTENANCE);
  paused = false;
  mm.pump();
  assert.equal(mm.offers.size, 1, 'off again: the waiting tickets match');
  mm.close();
  assert.throws(() => new Matchmaking({ send() {}, available: () => true, paused: true }), /paused/);
});

test('cluster: a manual start is refused while on', (t) => {
  const platform = { build: 'synthetic-build', protocol: 1, prepare() { throw new Error('no start expected'); },
    resume() { return true; }, deliverEnd() { return true; }, release() { return Promise.resolve(true); } };
  class ClusterWithPlatform extends ClusterLobby { constructor(opts) { super({ ...opts, platform }); } }
  const { limits, lobby, player } = fixture(t, { LobbyClass: ClusterWithPlatform });
  const a = player();
  lobby.create(a, { mode: 'solo', difficulty: 'NORMAL' });
  limits.set(true);
  assert.equal(lobby.start(a).error, ERR.MAINTENANCE);
  assert.equal(lobby.create(player(), { mode: 'solo', difficulty: 'NORMAL' }).error, ERR.MAINTENANCE);
});

test('a real server: the file switch reaches the client, refuses room.create with the text and shows in /healthz', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-maint-'));
  const file = path.join(dir, 'online-limit.json');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, onlineLimitFile: file });
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(async () => { await client.terminate(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.hello('Doctor');
  writeFileSync(file, '{ "maintenance": 1 }\n');
  await srv.lobby.limits.refresh(); // the poll, without waiting for its interval
  const on = await client.waitFor('presence.state', (m) => m.maintenance === true);
  client.clearInbox();
  const refused = await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  assert.equal(refused.code, ERR.MAINTENANCE);
  assert.equal(refused.msg, '服务器即将维护，暂停开启新的模拟');
  assert.equal(ERR_TEXT.MAINTENANCE, refused.msg);
  const health = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
  assert.equal(health.limits.maintenance, 1);
  writeFileSync(file, '{ "maintenance": 0 }\n');
  await srv.lobby.limits.refresh();
  const off = await client.waitFor('presence.state', (m) => m.seq > on.seq);
  assert.equal(Object.hasOwn(off, 'maintenance'), false);
  assert.equal((await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
});
