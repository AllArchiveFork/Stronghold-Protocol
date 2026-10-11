// g.bondPlan over the deployed topology (browser → private ingress → game node → GameHost → the real Match): the intent
// is a game intent end to end (shared/protocol.js C2S; the ingress validates it and relays it straight to the assigned
// node, never to the coordinator), and its m.public players[].bondPlan reaches the teammate, the spectator seat on
// another ingress and a player resumed through another ingress. The coordinator here is the small protocol fixture of
// test/cluster-ingress.test.js; the match rules themselves: test/match/bond-plan.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { startIngress } from '../server/cluster/ingress.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { Match } from '../server/match/Match.js';
import { getData } from '../server/data.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';

const ORIGIN = 'https://cluster-fixture.invalid';
const wait = (fn, ms = 4000) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const poll = () => { if (fn()) resolve(); else if (Date.now() >= end) reject(new Error('bond plan fixture deadline')); else setTimeout(poll, 5); };
  poll();
});
async function connect(url) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN });
  const frames = [];
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', code => resolve(code)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, frames, closed, send: message => socket.send(JSON.stringify(message)) };
}
const planOf = (frame, id) => frame.players.find(p => p.playerId === id)?.bondPlan;
const reply = (c, rid) => c.frames.find(frame => (frame.t === 'ok' || frame.t === 'error') && frame.rid === rid);

test('g.bondPlan crosses ingress → game node → Match; teammates, a spectator on another ingress and a resumed player see it', async t => {
  const controlServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const controlWss = new WebSocketServer({ server: controlServer, path: '/ws', perMessageDeflate: false });
  const sessions = new Map(), controlRequests = [];
  controlWss.on('connection', socket => {
    socket.on('error', () => {});
    let uid;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); controlRequests.push(message.t);
      if (message.t === 'hello') {
        uid = message.name;
        const previous = sessions.get(uid); if (previous && previous !== socket) previous.close(4001, 'session replaced');
        sessions.set(uid, socket);
        socket.send(JSON.stringify({ t: 'welcome', playerId: uid, token: 'fixture-only-token', name: uid, serverNow: Date.now(), version: 1 }));
      } else if (message.t === 'ping') socket.send(JSON.stringify({ t: 'pong', c: message.c, s: Date.now(), rid: message.rid }));
      else socket.send(JSON.stringify({ t: 'ok', rid: message.rid }));
    });
    socket.on('close', () => { if (sessions.get(uid) === socket) sessions.delete(uid); });
  });
  await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve));
  const coordinatorUrl = `http://127.0.0.1:${controlServer.address().port}`;
  const key = randomBytes(32);
  const data = getData({ log: { info() {}, warn() {}, error() {} } });
  const game = await startGameNode({ nodeId: 'game-a', generation: 'generation-a', build: 'test-build', key, data,
    MatchClass: Match, streamMarkers: true });
  const nodes = [{ nodeId: 'game-a', url: game.url, key }];
  const entries = await Promise.all([0, 1].map(() => startIngress({ coordinatorUrl, nodes, origins: [ORIGIN], shutdownMs: 100 })));
  const platform = new RemoteGamePlatform({ nodes, build: 'test-build', protocol: 1,
    sendControl: (id, message) => {
      const socket = sessions.get(id); if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(message)); return true;
    } });
  const clients = [];
  t.after(async () => {
    await platform.close();
    for (const client of clients) client.socket.terminate();
    await Promise.all(entries.map(entry => entry.close()));
    await game.close();
    for (const socket of controlWss.clients) socket.terminate();
    await new Promise(resolve => controlWss.close(resolve));
    controlServer.closeAllConnections(); await new Promise(resolve => controlServer.close(resolve));
  });
  await platform.refresh();
  const client = async (id, entry) => {
    const c = await connect(entries[entry].url); clients.push(c);
    c.send({ t: 'hello', name: id, version: 1, matchmakingVersion: MATCHMAKING_VERSION });
    await wait(() => c.frames.some(frame => frame.t === 'welcome'));
    return c;
  };
  const members = ['p1', 'p2', 'watcher'];
  const p1 = await client('p1', 0), p2 = await client('p2', 0), viewer = await client('watcher', 1);
  const seat = (i, id) => ({ seat: i, playerId: id, name: id, isBot: false, connected: true, loadout: null });
  const staged = await platform.prepare({ roomCode: 'ABCD', build: 'test-build', protocol: 1, mode: 'coop', modeId: 'mode_multi_funny',
    difficulty: 'FUNNY', seed: 7, matchNo: 1, snapshotHz: 10, revivalEnabled: false,
    seats: [seat(0, 'p1'), seat(1, 'p2'), { seat: 2, playerId: 'ai_1', name: 'AI', isBot: true, connected: true, loadout: null }],
    spectators: ['watcher'] });
  staged.commit();
  for (const id of members) sessions.get(id)?.send(JSON.stringify({ t: 'room.state', code: 'ABCD', inMatch: true }));
  staged.publish();
  for (const id of members) sessions.get(id)?.send(JSON.stringify({ t: 'queue.state', state: 'matched', code: 'ABCD' }));
  await platform.contexts.get(staged.assignmentId).publication;
  for (const c of [p1, p2, viewer]) await wait(() => c.frames.some(frame => frame.t === 'm.public' && frame.phase === 'INFO_CHECK'));
  for (const c of [p1, p2, viewer]) {
    const first = c.frames.find(frame => frame.t === 'm.public');
    assert.deepEqual(first.players.map(p => p.bondPlan), [null, null, null], 'nobody planned yet');
  }

  // a player's plan: ok, relayed to the node directly, broadcast to everyone (标准模拟 switches 阿戈尔 off: still plannable)
  p1.send({ t: 'g.bondPlan', bondId: 'egirShip', rid: 7 });
  await wait(() => reply(p1, 7));
  assert.equal(reply(p1, 7).t, 'ok');
  for (const c of [p1, p2, viewer]) await wait(() => c.frames.some(frame => frame.t === 'm.public' && planOf(frame, 'p1') === 'egirShip'));
  assert.equal(controlRequests.includes('g.bondPlan'), false, 'a game intent never reaches the coordinator');

  // refusals keep their codes over the wire: a trait bond, a spectator seat (GameHost's fence), a malformed id (the ingress)
  p2.send({ t: 'g.bondPlan', bondId: 'preciShip', rid: 8 });
  viewer.send({ t: 'g.bondPlan', bondId: 'yanShip', rid: 9 });
  p2.send({ t: 'g.bondPlan', bondId: 5, rid: 10 });
  await wait(() => reply(p2, 8) && reply(viewer, 9) && reply(p2, 10));
  assert.equal(reply(p2, 8).code, ERR.BAD_TARGET);
  assert.equal(reply(viewer, 9).code, ERR.SPECTATOR);
  assert.equal(reply(p2, 10).code, ERR.BAD_MSG);
  // clearing with null
  p2.send({ t: 'g.bondPlan', bondId: 'yanShip', rid: 11 });
  await wait(() => reply(p2, 11));
  p2.send({ t: 'g.bondPlan', bondId: null, rid: 12 });
  await wait(() => reply(p2, 12));
  assert.equal(reply(p2, 12).t, 'ok');
  await wait(() => {
    const last = viewer.frames.filter(frame => frame.t === 'm.public').at(-1);
    return last && planOf(last, 'p1') === 'egirShip' && planOf(last, 'p2') === null && planOf(last, 'ai_1') === null;
  });

  // p2 leaves its socket and resumes through the other ingress: the resync m.public carries the plans
  p2.socket.close(); await p2.closed;
  const resumed = await client('p2', 1);
  assert.equal(platform.resume(staged.assignmentId, 'p2'), true);
  await wait(() => resumed.frames.some(frame => frame.t === 'm.public' && planOf(frame, 'p1') === 'egirShip'));
  assert.equal(resumed.frames.some(frame => frame.t.startsWith('cluster.')), false);
});
