// Coordinator main-thread offload (P0/P1): phase timings in /healthz, the sliced presence fan-out with its
// in-match refresh rate, and the sliced heartbeat. Local fixtures only: no load test, no production claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Lobby, PRESENCE_SLICE, PRESENCE_IN_MATCH_MS } from '../server/lobby.js';
import { Network, SessionRegistry, HEARTBEAT_SLICES_MAX } from '../server/net.js';
import { createPhaseMetrics, NO_PHASES, PHASE_BUCKETS_MS } from '../server/phaseMetrics.js';
import { createHealthMetrics } from '../server/healthMetrics.js';
import { startCoordinator, closeReasonFor } from '../server/cluster/coordinator.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

class QuietMatch {
  constructor(opts) { this.opts = opts; }
  start() {}
  handle() { return { ok: true }; }
  onLeave() {} onDisconnect() {} onReconnect() {} dispose() {}
}

function lobbyHarness(t) {
  let clock = 50_000;
  const registry = new SessionRegistry({ now: () => clock });
  const lobby = new Lobby({ registry, now: () => clock, MatchClass: QuietMatch, getData: () => ({}), seedFn: () => 7 });
  t.after(() => lobby.shutdown());
  const player = (name = 'Presence') => {
    const s = registry.create(name);
    s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send: (data, opts, cb) => { s.messages.push(JSON.parse(data)); (typeof opts === 'function' ? opts : cb)?.(); } };
    s.connected = true;
    s.matchmakingVersion = MATCHMAKING_VERSION;
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const presence = (s) => s.messages.filter((m) => m.t === 'presence.state');
  return { lobby, registry, player, presence, advance: (ms) => { clock += ms; } };
}

test('presence fan-out: the first slice is synchronous, the rest follow on later macrotasks, each session once', async (t) => {
  const h = lobbyHarness(t), players = Array.from({ length: PRESENCE_SLICE * 2 + 7 }, (_, i) => h.player(`P${i}`));
  for (const p of players) p.messages.length = 0;
  h.lobby.publishPresence();
  assert.equal(players.filter((p) => h.presence(p).length === 1).length, PRESENCE_SLICE, 'one slice in this turn');
  assert.notEqual(h.lobby.presenceBatch, null);
  for (let i = 0; i < 4 && h.lobby.presenceBatch; i++) await nextTurn();
  assert.equal(h.lobby.presenceBatch, null);
  assert.ok(players.every((p) => h.presence(p).length === 1));
  assert.ok(players.every((p) => h.presence(p)[0].online === players.length));
});

test('a newer presence publication supersedes an unfinished fan-out; nobody keeps the older count', async (t) => {
  const h = lobbyHarness(t), players = Array.from({ length: PRESENCE_SLICE + 50 }, (_, i) => h.player(`P${i}`));
  for (const p of players) p.messages.length = 0;
  h.lobby.publishPresence();
  const late = h.player('Late'); // seq++; its own hello reply carries the newer state
  h.lobby.publishPresence();
  for (let i = 0; i < 4 && h.lobby.presenceBatch; i++) await nextTurn();
  for (const p of [...players, late]) assert.equal(h.presence(p).at(-1).online, players.length + 1);
  assert.ok(players.slice(PRESENCE_SLICE).every((p) => h.presence(p).length === 1), 'not reached by the old batch: only the new frame');
});

test('sessions in a running match get presence every PRESENCE_IN_MATCH_MS; lobby and room sessions every publication', (t) => {
  const h = lobbyHarness(t), playing = h.player('Playing'), waiting = h.player('Waiting'), roomOnly = h.player('Room');
  assert.deepEqual(h.lobby.create(playing, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  assert.deepEqual(h.lobby.start(playing), { ok: true });
  assert.deepEqual(h.lobby.create(roomOnly, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  for (const p of [playing, waiting, roomOnly]) p.messages.length = 0;
  h.advance(1000); h.lobby.publishPresence();
  assert.equal(h.presence(playing).length, 0, 'the match screen shows no online count');
  assert.equal(h.presence(waiting).length, 1);
  assert.equal(h.presence(roomOnly).length, 1);
  h.advance(PRESENCE_IN_MATCH_MS - 1001); h.lobby.publishPresence();
  assert.equal(h.presence(playing).length, 0);
  h.advance(1); h.lobby.publishPresence();
  assert.equal(h.presence(playing).length, 1, 'bounded staleness');
  h.advance(1000); h.lobby.publishPresence();
  assert.equal(h.presence(playing).length, 1);
  h.lobby.roomOf(playing).match.opts.onEnd({});
  h.advance(1000); h.lobby.publishPresence();
  assert.equal(h.presence(playing).length, 2, 'back in the room (no match): every publication again');
  assert.equal(h.presence(waiting).length, 5);
});

function fakeSocket() {
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, pings: 0, terminated: 0, closed: null,
    ping() { this.pings++; }, terminate() { this.terminated++; this.readyState = 3; }, close(code) { this.closed = code; }, send() {} });
  return ws;
}

test('the heartbeat visits one round-robin slice per tick; each socket is pinged once per interval and dropped after a miss', (t) => {
  let clock = 1000;
  const registry = new SessionRegistry({ now: () => clock });
  const handler = { onMessage: () => ({ ok: true }) };
  const network = new Network({ registry, handler, now: () => clock, options: { heartbeatMs: 30_000, helloTimeoutMs: 30_000 } });
  t.after(() => network.close());
  assert.equal(network.heartbeatSlices.length, HEARTBEAT_SLICES_MAX);
  const sockets = Array.from({ length: 95 }, () => fakeSocket());
  for (const ws of sockets) network.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  const perTick = [];
  for (let i = 0; i < HEARTBEAT_SLICES_MAX; i++) {
    const before = sockets.reduce((n, ws) => n + ws.pings, 0);
    network.heartbeatTick();
    perTick.push(sockets.reduce((n, ws) => n + ws.pings, 0) - before);
  }
  assert.ok(Math.max(...perTick) <= Math.ceil(95 / HEARTBEAT_SLICES_MAX), `never a full sweep: ${perTick}`);
  assert.ok(sockets.every((ws) => ws.pings === 1), 'each socket pinged once per interval');
  for (const ws of sockets.slice(1)) ws.emit('pong');
  clock += 30_000;
  for (let i = 0; i < HEARTBEAT_SLICES_MAX; i++) network.heartbeatTick();
  assert.equal(sockets[0].terminated, 1, 'no pong since its previous ping');
  assert.ok(sockets.slice(1).every((ws) => ws.terminated === 0 && ws.pings === 2));
  // A socket that never said hello hits the hello timeout at its own slice; a closed one leaves its slice.
  sockets[1].emit('close');
  assert.ok(network.heartbeatSlices.every((slice) => ![...slice].some((conn) => conn.ws === sockets[1])));
  clock += 30_001;
  for (let i = 0; i < HEARTBEAT_SLICES_MAX; i++) network.heartbeatTick();
  assert.ok(sockets.slice(2).every((ws) => ws.closed === 4002));
});

test('a short heartbeat interval keeps one slice: every socket at each tick, as before', (t) => {
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage: () => ({ ok: true }) }, options: { heartbeatMs: 80 } });
  t.after(() => network.close());
  assert.equal(network.heartbeatSlices.length, 1);
  const sockets = [fakeSocket(), fakeSocket()];
  for (const ws of sockets) network.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  network.heartbeatTick();
  assert.deepEqual(sockets.map((ws) => ws.pings), [1, 1]);
});

test('phase metrics: fixed buckets, window rotation, peaks since start, bounded names; the disabled recorder is inert', () => {
  let at = 0;
  const phases = createPhaseMetrics({ gc: false, now: () => at });
  for (const ms of [0.02, 0.3, 0.3, 3, 40]) { const t0 = phases.start(); at += ms; phases.end('presence.publish', t0, 10); }
  phases.add('receipt.parse', 12.5, 2_000_000);
  const first = phases.rotate();
  assert.deepEqual(Object.keys(first), ['presence.publish', 'receipt.parse']);
  assert.deepEqual(first['presence.publish'], { count: 5, totalMs: 43.62, maxMs: 40, p50Ms: 0.5, p99Ms: 40, items: 50, peakMs: 40, totalCount: 5 });
  assert.deepEqual(first['receipt.parse'], { count: 1, totalMs: 12.5, maxMs: 12.5, p50Ms: 12.5, p99Ms: 12.5, items: 2_000_000, peakMs: 12.5, totalCount: 1 });
  phases.add('presence.publish', 1);
  assert.deepEqual(phases.rotate()['presence.publish'], { count: 1, totalMs: 1, maxMs: 1, p50Ms: 1, p99Ms: 1, items: 0, peakMs: 40, totalCount: 6 });
  assert.deepEqual(phases.rotate(), {});
  for (let i = 0; i < 300; i++) phases.add(`ws.synthetic${i}`, 0.1);
  const many = phases.rotate();
  assert.ok(Object.keys(many).length <= 257 && many.other.count >= 44);
  assert.equal(PHASE_BUCKETS_MS.at(-1), Infinity);
  assert.equal(NO_PHASES.start(), 0);
  assert.equal(NO_PHASES.end('x', 0), undefined);
  phases.dispose();
  phases.add('after', 1);
  assert.deepEqual(phases.rotate(), {});
});

test('health metrics keep their original shape without a phase recorder and add `phases` per window with one', () => {
  const hist = { count: 1, max: 5e6, percentile: () => 1e6, enable() {}, disable() {}, reset() {} };
  const common = (phases, ticks) => createHealthMetrics({ phases, now: () => ticks.at, wallNow: () => 1_800_000_000_000,
    cpuUsage: () => ({ user: 0, system: 0 }), eventLoopUtilization: () => ({ active: 0, idle: ticks.at }),
    memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 1, arrayBuffers: 1 }), createHistogram: () => hist,
    setInterval: (fn) => { ticks.fn = fn; return { unref() {} }; }, clearInterval: () => {} });
  const plainTicks = { at: 1 }, plain = common(null, plainTicks);
  assert.equal('phases' in plain.snapshot(), false);
  plain.start(); plainTicks.at += 10_000; plainTicks.fn();
  assert.equal('phases' in plain.snapshot(), false);
  const recorder = createPhaseMetrics({ gc: false }), ticks = { at: 1 }, metrics = common(recorder, ticks);
  assert.equal(metrics.snapshot().phases, null);
  metrics.start();
  recorder.add('net.heartbeat', 2, 60);
  ticks.at += 10_000; ticks.fn();
  assert.deepEqual(Object.keys(metrics.snapshot().phases), ['net.heartbeat']);
  assert.equal(metrics.snapshot().status, 'ready');
  ticks.at += 10_000; ticks.fn();
  assert.deepEqual(metrics.snapshot().phases, {});
  metrics.dispose();
  assert.equal(metrics.snapshot().phases, null);
});

test('coordinator /healthz carries performance.phases; node loss/restart map to the client close reasons', async (t) => {
  let tick;
  const coordinator = await startCoordinator({ nodes: [{ nodeId: 'offload-node', url: 'http://127.0.0.1:9/', key: randomBytes(32) }],
    build: 'offload-build', port: 0, quiet: true,
    healthMetricsFactory: (opts) => createHealthMetrics({ ...opts, setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {} }) });
  t.after(() => coordinator.close());
  const get = (path) => new Promise((resolve, reject) => {
    http.get(`${coordinator.url}${path}`, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
  });
  const cold = JSON.parse((await get('/healthz')).body);
  assert.equal(cold.performance.phases, null);
  assert.equal((await get('/shared/constants.js')).status, 200);
  assert.equal((await get('/data/tuning.json')).status, 200);
  // The client may see the body end before the handler's own promise settles and records the phase.
  await new Promise((resolve) => setTimeout(resolve, 100));
  tick();
  const warm = JSON.parse((await get('/healthz')).body);
  assert.equal(warm.performance.phases['static.shared'].count, 1);
  assert.equal(warm.performance.phases['static.data'].count, 1);
  assert.ok(warm.performance.phases['static.shared'].maxMs >= 0);
  assert.equal(closeReasonFor('NODE_RESTARTED'), 'node-restarted');
  for (const reason of ['NODE_LOST', 'PUBLICATION_FAILED', 'REVOCATION_FAILED']) assert.equal(closeReasonFor(reason), 'node-unavailable');
});
