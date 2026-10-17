// The AFK rule (挂机移出) on the cluster path: the game actor (GameHost._removed, Match opts.onRemove) ends the removed
// player's membership like a leave and tells its owner; the node's member.removed event (receipts.js sendMemberRemoved →
// the receipt sink, same node / epoch authority as an end receipt) reaches the coordinator lobby
// (ClusterLobby.receiveRemoved: m.removed on the control path, then the seat departs like a g.leave — test/cluster-lobby).
// Actor and sink only: no Worker pools, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { GameHost } from '../server/cluster/game-host.js';
import { AFK_REMOVE_ROUNDS } from '../server/match/Match.js';
import { createReceiptSink, sendMemberRemoved } from '../server/cluster/receipts.js';
import { RpcError, createRpcAuthenticator, createRpcClient, createRpcHandler } from '../server/cluster/rpc.js';
import { ERR } from '../shared/constants.js';

const seat = (seat, playerId, extra = {}) => ({ seat, playerId, name: playerId, isBot: false, connected: true, ...extra });
const spec = () => ({ assignmentId: 'assignment-1', roomCode: 'ABCD', build: 'test-build', protocol: 1,
  seed: 71, matchNo: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal',
  seats: [seat(0, 'p1'), seat(2, 'p2'), seat(3, 'ai_1', { isBot: true })], spectators: ['s1'], revivalEnabled: true, snapshotHz: 10 });
const channel = () => ({ sent: [], closed: [],
  send(msg) { this.sent.push(msg); return true; },
  sendEncoded() { return true; },
  close(code, reason) { this.closed.push([code, reason]); } });
const rpcCode = code => error => error instanceof RpcError && error.code === code;

/** A Match stand-in that removes p2 the way MatchPlatform._removeIdle does (m.removed, m.notice, onRemove, onLeave). */
function actor(t, options = {}) {
  const matches = [], removals = [];
  class FakeMatch {
    constructor(opts) { this.opts = opts; this.calls = []; matches.push(this); }
    start() { return undefined; }
    handle(id, msg) { this.calls.push(['handle', id, msg.t]); return { ok: true }; }
    onReconnect() {} onDisconnect() {} addSpectator() {} removeSpectator() {}
    onLeave(id) { this.calls.push(['onLeave', id]); }
    dispose() {}
    removeIdle(id) {
      this.opts.send(id, { t: 'm.removed', reason: 'afk', rounds: 2 });
      for (const other of ['p1', 's1']) this.opts.send(other, { t: 'm.notice', kind: 'afkRemoved', playerId: id, name: id, rounds: 2 });
      this.opts.onRemove(id, { reason: 'afk', rounds: 2 });
      this.onLeave(id);
      this.opts.send(id, { t: 'm.public', after: true });
      this.opts.broadcast({ t: 'm.public', after: true });
    }
  }
  const host = new GameHost({ data: {}, MatchClass: FakeMatch, now: () => 1000, prepareMs: 100, log: { error() {} },
    onRemoved: removal => { removals.push(removal); return options.reply; }, ...options.host });
  t.after(() => host.close());
  const handle = host.prepare(spec());
  const channels = { p1: channel(), p2: channel(), s1: channel() };
  for (const [id, transport] of Object.entries(channels)) host.bind(handle.assignmentId, id, transport);
  host.commit(handle.assignmentId);
  return { host, matches, removals, channels, handle };
}

test('GameHost: the Match gets the AFK option; a removal ends the membership like a leave and tells the owner', t => {
  const f = actor(t, { host: { terminalControl: true } });
  const m = f.matches[0];
  assert.equal(m.opts.afkRemoveRounds, AFK_REMOVE_ROUNDS, 'the default reaches every actor');
  assert.equal(typeof m.opts.onRemove, 'function');
  m.removeIdle('p2');
  assert.deepEqual(f.removals, [{ assignmentId: 'assignment-1', generation: f.handle.generation, playerId: 'p2', reason: 'afk', rounds: 2 }]);
  // coordinator topology: m.removed goes out on the control path (ClusterLobby.receiveRemoved), never on the game stream
  assert.deepEqual(f.channels.p2.sent, []);
  assert.deepEqual(f.channels.p2.closed, [[1000, 'MEMBER_LEFT']]);
  for (const id of ['p1', 's1']) {
    assert.deepEqual(f.channels[id].sent.map(x => x.t), ['m.notice', 'm.public'], `${id}: the notice, spectator seats included`);
    assert.deepEqual(f.channels[id].sent[0], { t: 'm.notice', kind: 'afkRemoved', playerId: 'p2', name: 'p2', rounds: 2 });
  }
  assert.equal(f.host.member('assignment-1', 'p2'), null);
  assert.ok(f.host.member('assignment-1', 'p1'));
  assert.deepEqual(f.host.handle('assignment-1', 'p2', { t: 'g.ready', ready: true }), { error: ERR.NOT_IN_ROOM });
  assert.deepEqual(f.host.leave('assignment-1', 'p2'), { error: ERR.NOT_IN_ROOM }, 'the coordinator leave that follows finds it gone');
  assert.deepEqual(m.calls.filter(c => c[0] === 'onLeave'), [['onLeave', 'p2']], 'the Match quit the seat once');
  // a second removal of the same player, a spectator or a stranger is ignored
  m.opts.onRemove('p2', { reason: 'afk', rounds: 2 });
  m.opts.onRemove('s1', { reason: 'afk', rounds: 2 });
  m.opts.onRemove('nobody', { reason: 'afk', rounds: 2 });
  assert.equal(f.removals.length, 1);
  assert.ok(f.host.member('assignment-1', 's1'));
});

test('GameHost without a coordinator: m.removed goes out on the game channel before it closes; a rejected owner reply is only logged', async t => {
  const f = actor(t, { host: { afkRemoveRounds: 3 }, reply: Promise.reject(new Error('owner offline')) });
  const m = f.matches[0];
  assert.equal(m.opts.afkRemoveRounds, 3);
  m.removeIdle('p2');
  assert.deepEqual(f.channels.p2.sent, [{ t: 'm.removed', reason: 'afk', rounds: 2 }]);
  assert.deepEqual(f.channels.p2.closed, [[1000, 'MEMBER_LEFT']]);
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => new GameHost({ onRemoved: 'x' }), TypeError);
  assert.throws(() => new GameHost({ afkRemoveRounds: -1 }), RangeError);
});

function sinkFixture() {
  const infos = new Map([['assignment-1', Object.freeze({ assignmentId: 'assignment-1', roomCode: 'ABCD', nodeId: 'game-a',
    generation: 'node-gen', actorGeneration: 4, build: 'test-build', protocol: 1, state: 'published' })]]);
  const calls = [];
  const lobby = { assignments: new Map([['assignment-1', {}]]), receiveEnd: () => false,
    receiveRemoved(...args) { calls.push(args); return args[1] !== 'gone-room'; } };
  const sink = createReceiptSink({ platform: { assignmentInfo: id => infos.get(id) ?? null }, lobby });
  return { sink, calls, infos, ops: sink.opsForNode('game-a') };
}
const event = (extra = {}) => ({ assignmentId: 'assignment-1', nodeGeneration: 'node-gen', actorGeneration: 4, sessionId: 'p2', reason: 'afk', rounds: 2, ...extra });

test('receipt sink member.removed: node / epoch authority, strict shape, one lobby call', t => {
  const f = sinkFixture();
  t.after(() => f.sink.close());
  assert.deepEqual(f.ops['member.removed'](event()), { accepted: true });
  assert.deepEqual(f.calls, [['assignment-1', 'p2', 'afk', 2]]);
  // a passed 投票移出 takes the same path (rounds: the seat's offline rounds)
  assert.deepEqual(f.ops['member.removed'](event({ reason: 'kicked', rounds: 3 })), { accepted: true });
  assert.deepEqual(f.calls.at(-1), ['assignment-1', 'p2', 'kicked', 3]);
  f.calls.pop();
  for (const bad of [{ reason: 'idle' }, { rounds: 0 }, { rounds: 1.5 }, { sessionId: '' }, { extra: true }]) {
    assert.throws(() => f.ops['member.removed'](event(bad)), rpcCode('BAD_REQUEST'), JSON.stringify(bad));
  }
  for (const stale of [{ nodeGeneration: 'old-gen' }, { actorGeneration: 3 }, { assignmentId: 'assignment-2' }, { sessionId: 'gone-room' }]) {
    assert.throws(() => f.ops['member.removed'](event(stale)), rpcCode('STALE_ASSIGNMENT'), JSON.stringify(stale));
  }
  assert.throws(() => f.sink.opsForNode('game-b')['member.removed'](event()), rpcCode('STALE_ASSIGNMENT'), 'another node cannot speak for it');
  f.infos.set('assignment-1', { ...f.infos.get('assignment-1'), state: 'committed' });
  assert.throws(() => f.ops['member.removed'](event()), rpcCode('STALE_ASSIGNMENT'), 'only a published assignment');
  assert.equal(f.calls.length, 2, 'only the gone-room call reached the lobby besides the first');
});

test('sendMemberRemoved crosses the real HMAC RPC to the sink, retrying a lost reply', async t => {
  const f = sinkFixture(), key = randomBytes(32);
  let lose = true;
  const handler = createRpcHandler({ authority: createRpcAuthenticator({ key, scope: 'game-a' }), operations: {
    'member.removed': payload => { const value = f.ops['member.removed'](payload); if (lose) { lose = false; throw new RpcError('TRANSPORT'); } return value; },
  } });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = createRpcClient({ url: `http://127.0.0.1:${server.address().port}`, authority: createRpcAuthenticator({ key, scope: 'game-a' }) });
  t.after(async () => { client.close(); f.sink.close(); server.close(); server.closeAllConnections(); await once(server, 'close'); });
  const removal = { assignmentId: 'assignment-1', generation: 4, playerId: 'p2', reason: 'afk', rounds: 2 };
  assert.deepEqual(await sendMemberRemoved({ client, nodeGeneration: 'node-gen', removal }), { accepted: true });
  assert.deepEqual(f.calls, [['assignment-1', 'p2', 'afk', 2], ['assignment-1', 'p2', 'afk', 2]], 'a retry reaches the idempotent lobby again');
  assert.deepEqual(await sendMemberRemoved({ client, nodeGeneration: 'node-gen', removal: { ...removal, reason: 'kicked' } }), { accepted: true });
  assert.deepEqual(f.calls.at(-1), ['assignment-1', 'p2', 'kicked', 2]);
  await assert.rejects(sendMemberRemoved({ client, nodeGeneration: 'node-gen', removal: { ...removal, reason: 'other' } }), rpcCode('BAD_REQUEST'));
  await assert.rejects(sendMemberRemoved({ client, nodeGeneration: 'node-gen', removal: { ...removal, rounds: 0 } }), rpcCode('BAD_REQUEST'));
});
