// The state-delta transport over real sockets: a single-process server (lobby → browser) and the deployed cluster
// topology (browser → ingress → game node → GameHost → the real Match). A browser that offered stateDelta: 1 decodes
// m.state back into exactly the m.public stream a legacy browser in the same match receives; a legacy browser never
// sees m.state; a resumed session starts again from full frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { startServer } from '../server/index.js';
import { startIngress } from '../server/cluster/ingress.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { Match } from '../server/match/Match.js';
import { getData } from '../server/data.js';
import { StateReceiver } from '../shared/stateDelta.js';
import { MATCHMAKING_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const strip = ({ serverNow: _now, ...rest }) => rest;
/** Decode a client's whole log: [m.public…] in arrival order, plain or m.state alike. */
function publicStream(log) {
  const rx = new StateReceiver(), out = [];
  for (const frame of log) {
    if (frame.t === 'm.public') out.push(frame);
    else if (frame.t === 'm.state') {
      const decoded = rx.receive(frame);
      assert.ok(decoded && 'message' in decoded, `decodable m.state seq ${frame.seq}`);
      if (decoded.message.t === 'm.public') out.push(decoded.message);
    }
  }
  return out;
}

test('single process: delta and legacy browsers share one match; decoded public stream is identical; resume restarts full', { timeout: 60_000 }, async t => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0, resyncMinGapMs: 50 });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  const connect = async (name, delta, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    c.welcome = await c.request({ t: 'hello', name, token, version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION,
      ...(delta ? { stateDelta: 1 } : {}) });
    return c;
  };
  const modern = await connect('Modern', true), legacy = await connect('Legacy', false);
  assert.equal((await modern.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await modern.waitFor('room.state');
  assert.equal((await legacy.request({ t: 'room.join', code: room.code })).t, 'ok');
  assert.equal((await legacy.request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await modern.request({ t: 'room.start' })).t, 'ok');
  const first = await modern.waitFor('m.state', m => m.kind === 'm.public');
  assert.ok(first.full, 'a new baseline starts full');
  assert.equal((await modern.waitFor('m.state', m => m.kind === 'm.private')).full.playerId, modern.welcome.playerId);
  assert.equal((await legacy.waitFor('m.private')).playerId, legacy.welcome.playerId);
  for (const c of [modern, legacy]) assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
  await modern.waitFor('m.state', m => m.kind === 'm.public' && m.patch);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(legacy.log.some(m => m.t === 'm.state'), false, 'a legacy browser never sees m.state');
  const decoded = publicStream(modern.log).map(strip), plain = publicStream(legacy.log).map(strip);
  assert.ok(decoded.length >= 2);
  assert.deepEqual(decoded, plain.slice(0, decoded.length), 'the same broadcasts, decoded');
  // a resumed session on a new socket: full frames again
  await modern.terminate();
  const back = await connect('Modern', true, modern.welcome.token);
  assert.equal(back.welcome.resumed, true);
  assert.ok((await back.waitFor('m.state', m => m.kind === 'm.public')).full);
  assert.ok((await back.waitFor('m.state', m => m.kind === 'm.private')).full);
});

test('cluster: the ingress relays the browser\'s stateDelta to the game node; m.state crosses untouched and decodes exactly', { timeout: 120_000 }, async t => {
  const ORIGIN = 'https://cluster-fixture.invalid';
  const wait = (fn, ms = 60_000, label = 'state-delta cluster deadline') => new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const poll = () => { if (fn()) resolve(); else if (Date.now() >= end) reject(new Error(label)); else setTimeout(poll, 10); };
    poll();
  });
  // the coordinator is the small protocol fixture of test/cluster-local-replica.test.js
  const controlServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const controlWss = new WebSocketServer({ server: controlServer, path: '/ws', perMessageDeflate: false });
  const sessions = new Map();
  controlWss.on('connection', socket => {
    socket.on('error', () => {});
    let uid;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.t === 'hello') {
        uid = message.name; sessions.set(uid, socket);
        socket.send(JSON.stringify({ t: 'welcome', playerId: uid, token: 'fixture-only-token', name: uid, serverNow: Date.now(), version: 1 }));
      } else if (message.t === 'ping') socket.send(JSON.stringify({ t: 'pong', c: message.c, s: Date.now(), rid: message.rid }));
      else socket.send(JSON.stringify({ t: 'ok', rid: message.rid }));
    });
    socket.on('close', () => { if (sessions.get(uid) === socket) sessions.delete(uid); });
  });
  await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve));
  const key = randomBytes(32), data = getData({ log: QUIET });
  const game = await startGameNode({ nodeId: 'game-a', generation: 'generation-a', build: 'test-build', key, data,
    MatchClass: Match, streamMarkers: true, afkRemoveRounds: 0 });
  const nodes = [{ nodeId: 'game-a', url: game.url, key }];
  const entry = await startIngress({ coordinatorUrl: `http://127.0.0.1:${controlServer.address().port}`, nodes, origins: [ORIGIN], shutdownMs: 100 });
  const platform = new RemoteGamePlatform({ nodes, build: 'test-build', protocol: 1,
    sendControl: (id, message) => {
      const socket = sessions.get(id); if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(message)); return true;
    } });
  const clients = [];
  t.after(async () => {
    await platform.close();
    for (const c of clients) c.socket.terminate();
    await entry.close(); await game.close();
    for (const socket of controlWss.clients) socket.terminate();
    await new Promise(resolve => controlWss.close(resolve));
    controlServer.closeAllConnections(); await new Promise(resolve => controlServer.close(resolve));
  });
  await platform.refresh();
  const client = async (id, delta) => {
    const socket = new WebSocket(entry.url.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN });
    const frames = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const c = { socket, frames, send: m => socket.send(JSON.stringify(m)) };
    clients.push(c);
    c.send({ t: 'hello', name: id, version: 1, matchmakingVersion: MATCHMAKING_VERSION, ...(delta ? { stateDelta: 1 } : {}) });
    await wait(() => frames.some(f => f.t === 'welcome'));
    return c;
  };
  const p1 = await client('p1', true), p2 = await client('p2', false);
  const seat = (i, id) => ({ seat: i, playerId: id, name: id, isBot: false, connected: true, loadout: null });
  const staged = await platform.prepare({ roomCode: 'DLTA', build: 'test-build', protocol: 1, mode: 'coop', modeId: 'mode_multi_normal',
    difficulty: 'NORMAL', seed: 11, matchNo: 1, snapshotHz: 10, revivalEnabled: false,
    seats: [seat(0, 'p1'), seat(1, 'p2')], spectators: [] });
  staged.commit();
  for (const id of ['p1', 'p2']) sessions.get(id)?.send(JSON.stringify({ t: 'room.state', code: 'DLTA', inMatch: true }));
  staged.publish();
  await platform.contexts.get(staged.assignmentId).publication;
  const last = c => publicStream(c.frames).at(-1);
  await wait(() => last(p1)?.phase === 'INFO_CHECK' && last(p2)?.phase === 'INFO_CHECK', 30_000, 'info check');
  for (const c of [p1, p2]) c.send({ t: 'g.infoReady', rid: 7, setupRevision: last(c).setupRevision ?? 0 });
  await wait(() => p1.frames.some(f => f.t === 'm.state' && f.kind === 'm.public' && f.patch), 30_000, 'a public delta');
  await wait(() => publicStream(p2.frames).length >= publicStream(p1.frames).length, 10_000, 'p2 caught up');
  assert.ok(p1.frames.some(f => f.t === 'm.state' && f.kind === 'm.private'), 'private views ride it too');
  assert.equal(p1.frames.some(f => f.t === 'm.public'), false, 'nothing plain for p1 before the result');
  assert.equal(p2.frames.some(f => f.t === 'm.state'), false, 'a legacy browser behind the same ingress gets plain frames');
  const decoded = publicStream(p1.frames).map(strip), plain = publicStream(p2.frames).map(strip);
  assert.deepEqual(decoded, plain.slice(0, decoded.length));
});
