#!/usr/bin/env node
// tools/coordbench.mjs — local replay harness for the cluster coordinator's main thread (docs: deploy/stardust/cluster/README.md
// "协调器主线程测量"). Starts, on 127.0.0.1 with ephemeral ports only, one coordinator process, --ingress ingress processes,
// --nodes game-node processes (a synthetic BenchMatch, no combat Workers) and --drivers client processes that keep --clients
// WebSocket sessions through the ingresses: lobby presence and pings, 4-player public matchmaking, 20-player rooms with a large
// end receipt, reconnect churn with page loads (static /shared and /data from the coordinator). The coordinator reports, per
// --window, its event-loop delay (own 10 ms histogram and the /healthz one), ELU, CPU, the same externally timed hot calls
// (prototype wrappers + large JSON.parse/stringify, comparable across trees) and, when the tree has them, its /healthz phases.
//
// Usage: node tools/coordbench.mjs [--server-root <checkout>] [--clients 1400] [--ingress 2] [--nodes 4] [--drivers 4]
//          [--rooms20 3] [--queue-share 0.5] [--warmup 30] [--duration 120] [--window 10] [--match-sec 60-150] [--match20-sec 60]
//          [--receipt4-kb 200] [--receipt20-kb 1500] [--churn 4] [--page-load 0.5] [--storm] [--offload-static]
//          [--receipt-worker] [--out <file.json>] [--json]
//   --server-root  the checkout whose server/ is measured (default: this one), e.g. a pristine baseline export for "before"
//   --storm        halfway through, every session drops and resumes (an ingress restart / mass reload; page loads per --page-load)
//   --offload-static  page loads skip /shared/ and /data/ (what Nginx serves with cluster-private-code.py --runtime-static)
//   --receipt-worker  start the coordinator with its opt-in receipt Worker (trees without the option ignore it)
// Synthetic and local: no TLS/Nginx/password gate, no real battles, no WAN. Never point it at a shared or production host:
// every listener it starts binds 127.0.0.1 and every URL it dials is one of those listeners.
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const TOOL = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(TOOL), '..');
const ORIGIN = 'https://coordbench.invalid';
const BUILD = 'c0ffee'.padEnd(40, '0');

export function parseArgs(argv) {
  const opts = { serverRoot: ROOT, clients: 1400, ingress: 2, nodes: 4, drivers: 4, rooms20: 3, queueShare: 0.5, warmup: 30,
    duration: 120, window: 10, matchSec: [60, 150], match20Sec: 60, receipt4Kb: 200, receipt20Kb: 1500, churn: 4, pageLoad: 0.5,
    storm: false, offloadStatic: false, receiptWorker: false, out: null, json: false, role: null };
  const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    const take = () => { i++; return v; };
    if (a === '--server-root') opts.serverRoot = path.resolve(take());
    else if (a === '--clients') opts.clients = num(take(), 'clients');
    else if (a === '--ingress') opts.ingress = num(take(), 'ingress');
    else if (a === '--nodes') opts.nodes = num(take(), 'nodes');
    else if (a === '--drivers') opts.drivers = num(take(), 'drivers');
    else if (a === '--rooms20') opts.rooms20 = num(take(), 'rooms20');
    else if (a === '--queue-share') opts.queueShare = num(take(), 'queue-share');
    else if (a === '--warmup') opts.warmup = num(take(), 'warmup');
    else if (a === '--duration') opts.duration = num(take(), 'duration');
    else if (a === '--window') opts.window = num(take(), 'window');
    else if (a === '--match-sec') opts.matchSec = take().split('-').map((x) => num(x, 'match-sec'));
    else if (a === '--match20-sec') opts.match20Sec = num(take(), 'match20-sec');
    else if (a === '--receipt4-kb') opts.receipt4Kb = num(take(), 'receipt4-kb');
    else if (a === '--receipt20-kb') opts.receipt20Kb = num(take(), 'receipt20-kb');
    else if (a === '--churn') opts.churn = num(take(), 'churn');
    else if (a === '--page-load') opts.pageLoad = num(take(), 'page-load');
    else if (a === '--storm') opts.storm = true;
    else if (a === '--offload-static') opts.offloadStatic = true;
    else if (a === '--receipt-worker') opts.receiptWorker = true;
    else if (a === '--out') opts.out = path.resolve(take());
    else if (a === '--json') opts.json = true;
    else if (a === '--role') opts.role = take();
    else throw new Error(`unknown option ${a}`);
  }
  if (opts.matchSec.length === 1) opts.matchSec.push(opts.matchSec[0]);
  return opts;
}

const load = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic end payloads: many small objects (like real settlement rows), not one long string, so parse cost is realistic.
// ---------------------------------------------------------------------------------------------------------------------
export function syntheticRows(bytes, seed) {
  const rows = [];
  let size = 2, i = 0;
  while (size < bytes) {
    const row = { id: `${seed}-${i}`, name: `干员${i % 97}`, hp: (i * 37) % 1000, dmg: [i % 11, (i * 7) % 13, (i * 3) % 17, 1.5],
      tags: ['phase', i % 2 ? 'boss' : 'normal'], ok: i % 3 === 0 };
    rows.push(row);
    size += JSON.stringify(row).length + 1;
    i++;
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Child: game node
// ---------------------------------------------------------------------------------------------------------------------
async function runGame(config) {
  const { startGameNode } = await load(config.serverRoot, 'server/cluster/game-node.js');
  const { createRpcAuthenticator, createRpcClient } = await load(config.serverRoot, 'server/cluster/rpc.js');
  const { sendEndReceipt } = await load(config.serverRoot, 'server/cluster/receipts.js');
  const key = Buffer.from(config.key, 'hex');
  let events = null;
  const stats = { started: 0, ended: 0, receiptOk: 0, receiptFailed: 0, receiptBytes: 0 };
  class BenchMatch {
    constructor(opts) { this.opts = opts; this.round = 0; this.timers = []; this.done = false; this.spectators = new Set(opts.spectators); }
    humans() { return this.opts.seats.filter((s) => !s.isBot).map((s) => s.playerId); }
    start() {
      stats.started++;
      const humans = this.humans();
      this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', round: 0, players: humans.length });
      for (const id of humans) this.opts.send(id, { t: 'm.private', playerId: id });
      const big = humans.length > 4;
      const [lo, hi] = config.matchSec;
      const seconds = big ? config.match20Sec : lo + Math.random() * (hi - lo);
      this.timers.push(setInterval(() => this.opts.broadcast({ t: 'm.public', phase: 'COMBAT', round: ++this.round }), 2000));
      this.timers.push(setTimeout(() => this.finish(big ? config.receipt20Kb : config.receipt4Kb), seconds * 1000));
    }
    finish(kb) {
      if (this.done) return;
      this.done = true;
      for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
      const members = [...this.humans(), ...this.spectators];
      const publicBytes = kb * 1024 * 0.3, resultBytes = (kb * 1024 * 0.7) / Math.max(1, members.length);
      this.opts.broadcast({ t: 'm.public', phase: 'RESULT', round: this.round, board: syntheticRows(publicBytes, 'public') });
      for (const id of members) this.opts.send(id, { t: 'm.result', playerId: id, victory: true, rows: syntheticRows(resultBytes, id) });
      stats.ended++;
      this.opts.onEnd({ victory: true, roundsPassed: this.round, players: members.length });
    }
    handle() { return { ok: true }; }
    onReconnect(id) { this.opts.send(id, { t: 'm.public', phase: 'COMBAT', round: this.round, resync: true }); }
    onDisconnect() {} onLeave() {}
    addSpectator(id) { this.spectators.add(id); }
    removeSpectator(id) { this.spectators.delete(id); }
    setLoadout() { return { ok: true }; }
    setSkins() { return { ok: true }; }
    dispose() { for (const t of this.timers) { clearInterval(t); clearTimeout(t); } }
  }
  const node = await startGameNode({ host: '127.0.0.1', port: 0, nodeId: config.nodeId, generation: config.generation, build: BUILD, key,
    streamMarkers: true, MatchClass: BenchMatch, shutdownMs: 200,
    onEnd: async (receipt) => {
      if (!events) { stats.receiptFailed++; return; }
      try {
        await sendEndReceipt({ client: events, nodeGeneration: config.generation, receipt });
        stats.receiptOk++; stats.receiptBytes += Buffer.byteLength(JSON.stringify(receipt));
      } catch { stats.receiptFailed++; }
    } });
  process.on('message', (message) => {
    if (message?.op === 'coordinator') events = createRpcClient({ url: message.privateUrl, authority: createRpcAuthenticator({ key, scope: config.nodeId }) });
    if (message?.op === 'stats') process.send({ event: 'stats', stats });
  });
  onStop(async () => { events?.close(); await node.close(); });
  process.send({ event: 'ready', url: node.url });
}

// ---------------------------------------------------------------------------------------------------------------------
// Child: coordinator (measured)
// ---------------------------------------------------------------------------------------------------------------------
function externalTimers() {
  const windows = new Map();
  const add = (name, ms, items = 0) => {
    let e = windows.get(name);
    if (!e) { e = { count: 0, totalMs: 0, maxMs: 0, items: 0, over5: 0, over20: 0 }; windows.set(name, e); }
    e.count++; e.totalMs += ms; e.items += items;
    if (ms > e.maxMs) e.maxMs = ms;
    if (ms > 5) e.over5++;
    if (ms > 20) e.over20++;
  };
  const wrap = (proto, method, name) => {
    const original = proto?.[method];
    if (typeof original !== 'function') return false;
    proto[method] = function timed(...args) {
      const t0 = performance.now();
      try { return original.apply(this, args); } finally { add(name, performance.now() - t0); }
    };
    return true;
  };
  const rotate = () => {
    const out = {};
    for (const [name, e] of [...windows].sort(([a], [b]) => a.localeCompare(b))) {
      out[name] = { count: e.count, totalMs: round(e.totalMs, 3), maxMs: round(e.maxMs, 3), items: e.items, over5ms: e.over5, over20ms: e.over20 };
    }
    windows.clear();
    return out;
  };
  return { add, wrap, rotate };
}

async function runCoordinator(config) {
  const timers = externalTimers();
  const [{ startCoordinator }, { Lobby }, { Network }, clusterLobby, { Matchmaking }, { RemoteGamePlatform }] = await Promise.all([
    load(config.serverRoot, 'server/cluster/coordinator.js'), load(config.serverRoot, 'server/lobby.js'), load(config.serverRoot, 'server/net.js'),
    load(config.serverRoot, 'server/cluster/lobby.js'), load(config.serverRoot, 'server/matchmaking.js'), load(config.serverRoot, 'server/cluster/platform.js')]);
  // The same external instruments for every tree: each wrapper times one synchronous call.
  const wrapped = [
    timers.wrap(Lobby.prototype, 'publishPresence', 'x.presence.publish'),
    timers.wrap(Lobby.prototype, 'presenceSlice', 'x.presence.slice'),
    timers.wrap(Lobby.prototype, 'onHello', 'x.lobby.onHello'),
    timers.wrap(Lobby.prototype, 'onDisconnect', 'x.lobby.onDisconnect'),
    timers.wrap(Network.prototype, 'heartbeat', 'x.net.heartbeat'),
    timers.wrap(Network.prototype, 'heartbeatTick', 'x.net.heartbeatTick'),
    timers.wrap(Network.prototype, 'onHelloMsg', 'x.net.hello'),
    timers.wrap(Network.prototype, 'onFrame', 'x.net.frame'),
    timers.wrap(clusterLobby.ClusterLobby.prototype, 'receiveEnd', 'x.end.receiveEnd'),
    timers.wrap(clusterLobby.ClusterLobby.prototype, 'receiveEncodedEnd', 'x.end.receiveEncodedEnd'),
    timers.wrap(clusterLobby.ClusterLobby.prototype, 'newPlan', 'x.match.newPlan'),
    timers.wrap(clusterLobby.ClusterLobby.prototype, 'commitPlan', 'x.match.commit'),
    timers.wrap(clusterLobby.ClusterLobby.prototype, 'publishPlan', 'x.match.publish'),
    timers.wrap(RemoteGamePlatform.prototype, 'valid', 'x.platform.valid'),
    timers.wrap(RemoteGamePlatform.prototype, 'deliverEnd', 'x.platform.deliverEnd'),
    timers.wrap(Matchmaking.prototype, 'pump', 'x.queue.pump'),
    timers.wrap(Matchmaking.prototype, 'notifyPopulation', 'x.queue.population'),
  ];
  // Large JSON work on the main thread (receipt parses, per-member terminal frames), whoever calls it.
  const LARGE = 64 * 1024, parse = JSON.parse, stringify = JSON.stringify;
  JSON.parse = function benchParse(text, reviver) {
    if (typeof text !== 'string' || text.length < LARGE) return parse(text, reviver);
    const t0 = performance.now();
    try { return parse(text, reviver); } finally { timers.add('x.json.parse>64k', performance.now() - t0, text.length); }
  };
  JSON.stringify = function benchStringify(value, replacer, space) {
    const t0 = performance.now(), out = stringify(value, replacer, space);
    if (typeof out === 'string' && out.length >= LARGE) timers.add('x.json.stringify>64k', performance.now() - t0, out.length);
    return out;
  };
  const nodes = config.nodes.map((n) => ({ nodeId: n.nodeId, url: n.url, key: Buffer.from(n.key, 'hex') }));
  const coordinator = await startCoordinator({ nodes, build: BUILD, host: '127.0.0.1', port: 0, privateHost: '127.0.0.1', privatePort: 0,
    heartbeatMs: 1000, quiet: true, ...(config.receiptWorker ? { receiptWorker: true } : {}) });
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let elu = performance.eventLoopUtilization(), cpu = process.cpuUsage(), at = performance.now();
  const seenHealth = new Set();
  const sample = () => {
    const nowElu = performance.eventLoopUtilization(elu), nowCpu = process.cpuUsage(cpu), now = performance.now();
    const ms = (ns) => round(ns / 1e6, 2);
    const health = coordinator.healthMetrics?.snapshot?.();
    const fresh = health?.sampledAt != null && !seenHealth.has(health.sampledAt);
    if (fresh) seenHealth.add(health.sampledAt);
    const stats = coordinator.lobby.stats();
    const out = { windowMs: round(now - at, 0), eld: { p50: ms(histogram.percentile(50)), p95: ms(histogram.percentile(95)),
      p99: ms(histogram.percentile(99)), max: ms(histogram.max), count: histogram.count },
    elu: round(nowElu.utilization, 3), cpuPercent: round((nowCpu.user + nowCpu.system) / 1000 / (now - at) * 100, 1),
    rssMiB: round(process.memoryUsage().rss / 1048576, 0), sockets: coordinator.network.connectionCount, online: stats.online,
    rooms: stats.rooms, matches: stats.matches, queued: stats.queued, external: timers.rotate(),
    health: fresh ? { eventLoopDelayMs: health.mainThread?.eventLoopDelayMs, phases: health.phases ?? null } : null };
    histogram.reset(); elu = performance.eventLoopUtilization(); cpu = process.cpuUsage(); at = performance.now();
    return out;
  };
  process.on('message', (message) => {
    if (message?.op === 'sample') process.send({ event: 'sample', sample: sample() });
  });
  onStop(async () => { histogram.disable(); await coordinator.close(); });
  process.send({ event: 'ready', url: coordinator.url, privateUrl: coordinator.privateUrl, wrapped: wrapped.filter(Boolean).length,
    phases: coordinator.healthMetrics?.snapshot?.() && 'phases' in coordinator.healthMetrics.snapshot() });
}

// ---------------------------------------------------------------------------------------------------------------------
// Child: ingress
// ---------------------------------------------------------------------------------------------------------------------
async function runIngress(config) {
  const { startIngress } = await load(config.serverRoot, 'server/cluster/ingress.js');
  const ingress = await startIngress({ host: '127.0.0.1', port: 0, coordinatorUrl: config.coordinatorUrl, nodes: config.nodes,
    origins: [ORIGIN], wsCompression: 'off', shutdownMs: 200 });
  onStop(() => ingress.close());
  process.send({ event: 'ready', url: ingress.url });
}

// ---------------------------------------------------------------------------------------------------------------------
// Child: client driver
// ---------------------------------------------------------------------------------------------------------------------
async function runClients(config) {
  const { WebSocket } = await import('ws');
  const [{ PROTOCOL_VERSION, MATCHMAKING_VERSION }, { PLAYER_CAPACITY_VERSION }, { cultivationCharIds }, { getData }] = await Promise.all([
    load(config.serverRoot, 'shared/constants.js'), load(config.serverRoot, 'shared/playerCapacity.js'),
    load(config.serverRoot, 'shared/protocol.js'), load(config.serverRoot, 'server/data.js')]);
  const data = getData({ log: { info() {}, warn() {}, error() {}, debug() {} } });
  const ops = Object.fromEntries([...cultivationCharIds(data.chess, data.backups)].slice(0, 72).map((id) => [id, { potential: 3, cultivate: 1 }]));
  const stats = { connected: 0, welcomes: 0, reconnects: 0, closes: 0, errors: {}, results: 0, matched: 0, roomStarts: 0, pageLoads: 0,
    staticRequests: 0, staticMs: [], requestMs: [] };
  let stopping = false;
  const codes = new Map(); // group → room code (all 20 members live in this driver)
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  class Bot {
    constructor(index, role, group) {
      Object.assign(this, { index, role, group, ws: null, token: null, playerId: null, rid: 0, pending: new Map(), room: null,
        inMatch: false, wasInMatch: false, queued: false, busy: false, open: false });
    }
    connect() {
      if (stopping) return;
      const ws = new WebSocket(`${pick(config.ingressUrls).replace(/^http/, 'ws')}/ws`, { origin: ORIGIN, perMessageDeflate: false });
      this.ws = ws;
      ws.on('error', () => {});
      ws.on('open', () => {
        this.open = true; stats.connected++;
        this.send({ t: 'hello', name: `Bench${this.index}`, ...(this.token ? { token: this.token } : {}), version: PROTOCOL_VERSION,
          matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
      });
      ws.on('message', (raw) => { try { this.onMessage(JSON.parse(raw.toString())); } catch { /* malformed: counted by the server */ } });
      ws.on('close', () => {
        this.open = false; stats.closes++;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ t: 'error', code: 'CLOSED' }); }
        this.pending.clear();
        if (ws === this.ws && !stopping && !this.leaving) setTimeout(() => { stats.reconnects++; this.connect(); }, 500 + Math.random() * 1500);
      });
    }
    send(message) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message)); }
    request(t, fields = {}) {
      const rid = ++this.rid, started = performance.now();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(rid); resolve({ t: 'error', code: 'TIMEOUT' }); }, 15_000);
        this.pending.set(rid, { resolve: (m) => { stats.requestMs.push(performance.now() - started); resolve(m); }, timer });
        this.send({ t, ...fields, rid });
      });
    }
    onMessage(m) {
      const p = m.rid != null ? this.pending.get(m.rid) : null;
      if (p && (m.t === 'ok' || m.t === 'error' || m.t === 'welcome' || m.t === 'pong')) { this.pending.delete(m.rid); clearTimeout(p.timer); p.resolve(m); }
      if (m.t === 'error' && m.code) stats.errors[m.code] = (stats.errors[m.code] || 0) + 1;
      if (m.t === 'welcome') { this.token = m.token; this.playerId = m.playerId; stats.welcomes++; void this.afterWelcome(m.resumed); }
      else if (m.t === 'room.state') {
        this.room = m;
        const ended = this.inMatch && !m.inMatch;
        this.inMatch = !!m.inMatch;
        if (m.inMatch && !this.wasInMatch) { this.wasInMatch = true; }
        if (ended) void this.afterMatch();
        if (this.role === 'host' && !m.inMatch) void this.maybeStart();
      } else if (m.t === 'room.closed') { this.room = null; this.inMatch = false; void this.afterMatch(); }
      else if (m.t === 'queue.state') {
        if (m.state === 'offered' && !m.accepted) void this.request('queue.accept', { ticketId: m.ticketId, offerId: m.offerId, revivalVote: false });
        if (m.state === 'matched') stats.matched++;
        if (m.state === 'idle') this.queued = false;
      } else if (m.t === 'm.result') stats.results++;
    }
    async afterWelcome(resumed) {
      if (!resumed) await this.request('room.loadout', { entries: {}, ops });
      if (this.role === 'queue' && !this.room && !this.queued) await this.queue();
      if (this.role === 'host' && !this.room) await this.hostRoom();
      if (this.role === 'member' && !this.room) await this.joinRoom();
    }
    async queue() {
      if (this.busy || stopping) return;
      this.busy = true;
      try {
        await pause(Math.random() * 3000);
        if (this.room) await this.request('room.leave');
        const reply = await this.request('queue.join', { difficulty: 'NORMAL' });
        this.queued = reply.t === 'ok';
      } finally { this.busy = false; }
    }
    async hostRoom() {
      const reply = await this.request('room.create', { mode: 'coop', difficulty: 'NORMAL',
        experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 } });
      if (reply.t === 'ok' && this.room) codes.set(this.group, this.room.code);
    }
    async joinRoom() {
      for (let i = 0; i < 200 && !codes.get(this.group) && !stopping; i++) await pause(100);
      const code = codes.get(this.group);
      if (!code) return;
      const reply = await this.request('room.join', { code });
      if (reply.t === 'ok') await this.request('room.ready', { ready: true });
    }
    async maybeStart() {
      const seats = (this.room?.seats || []).filter(Boolean);
      if (this.starting || seats.length < 20 || !seats.every((s) => s.playerId === this.playerId || s.ready)) return;
      this.starting = true;
      try {
        await pause(this.wasInMatch ? 5000 : 500);
        if (this.room && !this.room.inMatch) { const reply = await this.request('room.start'); if (reply.t === 'ok') stats.roomStarts++; }
      } finally { this.starting = false; }
    }
    async afterMatch() {
      if (this.role === 'queue') { this.queued = false; await pause(3000 + Math.random() * 5000); await this.queue(); }
      if (this.role === 'member' && this.room) { await pause(1000 + Math.random() * 2000); await this.request('room.ready', { ready: true }); }
    }
  }

  const bots = config.roles.map((r) => new Bot(r.index, r.role, r.group));
  for (const [i, bot] of bots.entries()) { setTimeout(() => bot.connect(), (i / bots.length) * config.rampMs); }
  // Client heartbeat like public/js/net.js (PING_INTERVAL_MS 4 s), spread over the interval.
  const pinger = setInterval(() => {
    const slot = Math.floor(Date.now() / 250) % 16;
    for (const bot of bots) if (bot.index % 16 === slot && bot.open) bot.send({ t: 'ping', c: Date.now() });
  }, 250);
  // Reconnect churn of lobby-only sessions; some resumes are page loads that fetch the static code/data from the coordinator.
  const idle = bots.filter((b) => b.role === 'idle');
  const staticPaths = config.staticPaths;
  const pageLoad = async () => {
    stats.pageLoads++;
    await Promise.all(staticPaths.map((p) => new Promise((resolve) => {
      const t0 = performance.now();
      const req = http.get(`${config.coordinatorUrl}${p}`, { headers: { 'accept-encoding': 'gzip' }, agent }, (res) => {
        res.resume(); res.on('end', () => { stats.staticRequests++; stats.staticMs.push(performance.now() - t0); resolve(); });
      });
      req.on('error', resolve);
    })));
  };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
  let churnTimer = null;
  const startChurn = () => {
    let carry = 0;
    churnTimer = setInterval(() => {
      carry += config.churnPerDriver / 4;
      for (; carry >= 1; carry--) {
        const bot = pick(idle);
        if (!bot?.open) continue;
        bot.ws.close();
        if (Math.random() < config.pageLoad) void pageLoad();
      }
    }, 250);
  };
  process.on('message', (message) => {
    if (message?.op === 'churn') startChurn();
    if (message?.op === 'storm') {
      for (const bot of bots) {
        if (!bot.open) continue;
        bot.ws.close();
        if (Math.random() < config.pageLoad) void pageLoad();
      }
    }
    if (message?.op === 'stats') {
      const q = (list, p) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return round(s[Math.min(s.length - 1, Math.floor(p * s.length))], 1); };
      process.send({ event: 'stats', stats: { ...stats, staticMs: { p50: q(stats.staticMs, 0.5), p99: q(stats.staticMs, 0.99) },
        requestMs: { p50: q(stats.requestMs, 0.5), p99: q(stats.requestMs, 0.99), max: q(stats.requestMs, 1) },
        open: bots.filter((b) => b.open).length, inMatch: bots.filter((b) => b.inMatch).length } });
      stats.staticMs = []; stats.requestMs = [];
    }
  });
  onStop(async () => {
    stopping = true; clearInterval(pinger); clearInterval(churnTimer); agent.destroy();
    for (const bot of bots) { bot.leaving = true; try { bot.ws?.terminate(); } catch { /* closing */ } }
  });
  process.send({ event: 'ready' });
}

// ---------------------------------------------------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------------------------------------------------
let stopHandler = null;
function onStop(fn) { stopHandler = fn; }
async function childMain(role) {
  const stop = async () => { try { await stopHandler?.(); } catch { /* best effort */ } process.exit(0); };
  process.on('SIGTERM', stop); process.on('disconnect', stop);
  process.once('message', async (config) => {
    try {
      if (role === 'game') await runGame(config);
      else if (role === 'coordinator') await runCoordinator(config);
      else if (role === 'ingress') await runIngress(config);
      else if (role === 'clients') await runClients(config);
    } catch (e) { process.send({ event: 'failed', message: String(e?.stack || e).slice(0, 2000) }); process.exit(1); }
  });
}

function spawnRole(role, config, children) {
  const child = fork(TOOL, ['--role', role], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, TZ: 'UTC' } });
  children.push(child);
  const ready = new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m?.event === 'ready') { child.off('message', onMessage); resolve(m); }
      if (m?.event === 'failed') reject(new Error(`${role} failed: ${m.message}`));
    };
    child.on('message', onMessage);
    child.once('exit', (code) => reject(new Error(`${role} exited ${code}`)));
  });
  child.send(config);
  return { child, ready };
}
const ask = (child, op, event) => new Promise((resolve) => {
  const onMessage = (m) => { if (m?.event === event) { child.off('message', onMessage); resolve(m); } };
  child.on('message', onMessage);
  child.send({ op });
});

export function summarize(windows) {
  const pick = (f) => windows.map(f).filter((v) => Number.isFinite(v));
  const median = (list) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const external = {}, phases = {};
  for (const w of windows) {
    for (const [name, e] of Object.entries(w.external || {})) {
      const t = external[name] ||= { count: 0, totalMs: 0, maxMs: 0, items: 0, over5ms: 0, over20ms: 0 };
      t.count += e.count; t.totalMs += e.totalMs; t.maxMs = Math.max(t.maxMs, e.maxMs); t.items += e.items; t.over5ms += e.over5ms; t.over20ms += e.over20ms;
    }
    for (const [name, e] of Object.entries(w.health?.phases || {})) {
      const t = phases[name] ||= { count: 0, totalMs: 0, maxMs: 0, p99MsMax: 0, items: 0 };
      t.count += e.count; t.totalMs += e.totalMs; t.maxMs = Math.max(t.maxMs, e.maxMs); t.p99MsMax = Math.max(t.p99MsMax, e.p99Ms); t.items += e.items;
    }
  }
  for (const t of [...Object.values(external), ...Object.values(phases)]) t.totalMs = round(t.totalMs, 1);
  return {
    windows: windows.length,
    eld: { p99Median: median(pick((w) => w.eld.p99)), p99Max: Math.max(...pick((w) => w.eld.p99)), maxMax: Math.max(...pick((w) => w.eld.max)),
      p50Median: median(pick((w) => w.eld.p50)) },
    healthEld: { p99Max: Math.max(...pick((w) => w.health?.eventLoopDelayMs?.p99)), maxMax: Math.max(...pick((w) => w.health?.eventLoopDelayMs?.max)) },
    eluMedian: median(pick((w) => w.elu)), cpuPercentMedian: median(pick((w) => w.cpuPercent)),
    online: median(pick((w) => w.online)), matches: median(pick((w) => w.matches)), external, phases,
  };
}

async function orchestrate(opts) {
  const children = [], log = (...a) => { if (!opts.json) console.log(...a); };
  const stopAll = async () => {
    for (const c of children.reverse()) if (c.exitCode === null) c.kill('SIGTERM');
    await pause(1500);
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  };
  process.on('SIGINT', () => { void stopAll().then(() => process.exit(130)); });
  const serverRoot = opts.serverRoot;
  const staticPaths = [
    ...(opts.offloadStatic ? [] : [
      ...readdirSync(path.join(serverRoot, 'shared')).filter((f) => f.endsWith('.js')).map((f) => `/shared/${f}`),
      ...readdirSync(path.join(serverRoot, 'data')).filter((f) => f.endsWith('.json') && f !== 'local-assets.json').map((f) => `/data/${f}`),
      '/data/i18n/en.json']),
    '/data.js', '/client-build', '/packs/index.json',
  ];
  try {
    const games = [];
    for (let i = 0; i < opts.nodes; i++) {
      const nodeId = `bench-${String(i + 1).padStart(2, '0')}`, key = randomBytes(32).toString('hex'); // ephemeral, never printed
      const { child, ready } = spawnRole('game', { serverRoot, nodeId, generation: `${nodeId}-${randomBytes(4).toString('hex')}`, key,
        matchSec: opts.matchSec, match20Sec: opts.match20Sec, receipt4Kb: opts.receipt4Kb, receipt20Kb: opts.receipt20Kb }, children);
      games.push({ child, nodeId, key, ...(await ready) });
    }
    const coordinator = spawnRole('coordinator', { serverRoot, receiptWorker: opts.receiptWorker,
      nodes: games.map(({ nodeId, url, key }) => ({ nodeId, url, key })) }, children);
    const coord = await coordinator.ready;
    for (const g of games) g.child.send({ op: 'coordinator', privateUrl: coord.privateUrl });
    const ingresses = [];
    for (let i = 0; i < opts.ingress; i++) {
      const { ready } = spawnRole('ingress', { serverRoot, coordinatorUrl: coord.url, nodes: games.map(({ nodeId, url }) => ({ nodeId, url })) }, children);
      ingresses.push(await ready);
    }
    log(`[coordbench] ${serverRoot}: coordinator ${coord.url} (${coord.wrapped} wrappers, phases ${coord.phases ? 'yes' : 'no'}), ${games.length} nodes, ${ingresses.length} ingresses`);
    // Roles: per driver, its first rooms20*20 sessions are 20-player rooms, then queue/idle shares.
    const perDriver = Math.ceil(opts.clients / opts.drivers), drivers = [];
    let index = 0, group = 0;
    for (let d = 0; d < opts.drivers; d++) {
      const roles = [], count = Math.min(perDriver, opts.clients - index);
      const rooms = Math.floor(opts.rooms20 / opts.drivers) + (d < opts.rooms20 % opts.drivers ? 1 : 0);
      for (let r = 0; r < rooms && roles.length + 20 <= count; r++, group++) {
        for (let m = 0; m < 20; m++) roles.push({ index: index++, role: m === 0 ? 'host' : 'member', group });
      }
      const rest = count - roles.length, queueCount = Math.round(rest * opts.queueShare);
      for (let k = 0; k < rest; k++) roles.push({ index: index++, role: k < queueCount ? 'queue' : 'idle', group: null });
      const { child, ready } = spawnRole('clients', { serverRoot, ingressUrls: ingresses.map((x) => x.url), coordinatorUrl: coord.url, roles,
        rampMs: Math.max(5000, opts.warmup * 1000 * 0.6), churnPerDriver: opts.churn / opts.drivers, pageLoad: opts.pageLoad, staticPaths }, children);
      await ready;
      drivers.push(child);
    }
    log(`[coordbench] ${opts.clients} clients ramping over ${Math.round(Math.max(5, opts.warmup * 0.6))} s; warm-up ${opts.warmup} s`);
    await pause(opts.warmup * 1000);
    await ask(coordinator.child, 'sample', 'sample'); // discard the warm-up window
    for (const d of drivers) { await ask(d, 'stats', 'stats'); d.send({ op: 'churn' }); }
    const windows = [];
    const rounds = Math.max(1, Math.round(opts.duration / opts.window));
    for (let i = 0; i < rounds; i++) {
      if (opts.storm && i === Math.floor(rounds / 2)) { log('[coordbench] storm: every session drops and resumes'); for (const d of drivers) d.send({ op: 'storm' }); }
      await pause(opts.window * 1000);
      const { sample } = await ask(coordinator.child, 'sample', 'sample');
      windows.push(sample);
      log(`[coordbench] w${i + 1}: eld p50 ${sample.eld.p50} p99 ${sample.eld.p99} max ${sample.eld.max} ms · elu ${sample.elu} · cpu ${sample.cpuPercent}% · online ${sample.online} · matches ${sample.matches} · sockets ${sample.sockets}`);
    }
    const clientStats = [];
    for (const d of drivers) clientStats.push((await ask(d, 'stats', 'stats')).stats);
    const gameStats = [];
    for (const g of games) gameStats.push((await ask(g.child, 'stats', 'stats')).stats);
    const sum = (list, key) => list.reduce((n, s) => n + (s[key] || 0), 0);
    const result = { tool: 'coordbench', serverRoot, node: process.version, at: new Date().toISOString(),
      options: { ...opts, out: undefined, json: undefined, role: undefined, serverRoot: undefined },
      summary: summarize(windows),
      clients: { open: sum(clientStats, 'open'), inMatch: sum(clientStats, 'inMatch'), reconnects: sum(clientStats, 'reconnects'), results: sum(clientStats, 'results'),
        pageLoads: sum(clientStats, 'pageLoads'), staticRequests: sum(clientStats, 'staticRequests'), roomStarts: sum(clientStats, 'roomStarts'),
        errors: clientStats.reduce((all, s) => { for (const [k, v] of Object.entries(s.errors)) all[k] = (all[k] || 0) + v; return all; }, {}),
        requestP99Ms: Math.max(...clientStats.map((s) => s.requestMs.p99 ?? 0)) },
      games: { started: sum(gameStats, 'started'), ended: sum(gameStats, 'ended'), receiptOk: sum(gameStats, 'receiptOk'), receiptFailed: sum(gameStats, 'receiptFailed'),
        receiptMiB: round(sum(gameStats, 'receiptBytes') / 1048576, 1) },
      windows };
    if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
    if (opts.json) console.log(JSON.stringify(result));
    else {
      const s = result.summary;
      console.log(`[coordbench] ELD p99 median ${s.eld.p99Median} / max ${s.eld.p99Max} ms, max ${s.eld.maxMax} ms (healthz p99 max ${s.healthEld.p99Max}, max ${s.healthEld.maxMax}); ELU ${s.eluMedian}; CPU ${s.cpuPercentMedian}%`);
      console.log(`[coordbench] clients ${JSON.stringify(result.clients)}`);
      console.log(`[coordbench] games ${JSON.stringify(result.games)}`);
      for (const [name, e] of Object.entries(s.external)) console.log(`  ${name.padEnd(28)} n=${String(e.count).padStart(7)} total=${String(e.totalMs).padStart(9)}ms max=${String(round(e.maxMs, 2)).padStart(8)}ms >5ms=${e.over5ms} >20ms=${e.over20ms}`);
      for (const [name, e] of Object.entries(s.phases)) console.log(`  [phase] ${name.padEnd(20)} n=${String(e.count).padStart(7)} total=${String(e.totalMs).padStart(9)}ms max=${String(round(e.maxMs, 2)).padStart(8)}ms p99<=${e.p99MsMax}`);
    }
    return result;
  } finally { await stopAll(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === TOOL) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.role) void childMain(opts.role);
  else orchestrate(opts).then(() => process.exit(0), (e) => { console.error(`[coordbench] ${e?.message || e}`); process.exit(1); });
}
