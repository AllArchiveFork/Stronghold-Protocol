// A restored remote match (docs/DEPLOY.md「断点续玩」, ClusterLobby.restoreRemoteMatch → RemoteGamePlatform.restore) and
// the seats that had left it: a departed player may sit in another restored match by now. Real ClusterLobby, platform and
// directory over a scripted game node; the lobby document is the one restoreLobby reads (server/persist/lobbyState.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { AllocationError, ClusterDirectory } from '../server/cluster/directory.js';
import { SessionRegistry } from '../server/net.js';
import { restoreLobby, LOBBY_DOC_VERSION } from '../server/persist/lobbyState.js';
import { modeIdFor } from '../shared/constants.js';
import { EXPERIMENTAL_DEFAULTS } from '../shared/experimental.js';

const BUILD = 'test-build';
const until = async (condition, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** One game node: `restore` rebuilds an actor, its members as of the checkpoint; leave / removeSpectator are recorded. */
function node(nodeId) {
  const state = { nodeId, key: randomBytes(32), generation: `${nodeId}-g2`, ready: true, actors: new Map(), calls: [] };
  const view = (a) => ({ assignmentId: a.assignmentId, roomCode: a.roomCode, generation: state.generation, build: BUILD, protocol: 1,
    actorGeneration: a.generation, state: 'committed', published: a.published });
  state.client = {
    async call(op, payload) {
      state.calls.push({ op, ...payload });
      if (op === 'status' && !payload.assignmentId) return { nodeId, generation: state.generation, build: BUILD, protocol: 1, ready: state.ready,
        counts: { matches: state.actors.size } };
      if (op === 'restore') {
        if (!state.ready) throw new AllocationError('NOT_READY');
        const actor = { assignmentId: payload.assignmentId, roomCode: payload.roomCode, generation: state.actors.size + 1, published: false };
        state.actors.set(payload.assignmentId, actor);
        return view(actor);
      }
      if (op === 'release') return state.actors.delete(payload.assignmentId);
      const actor = state.actors.get(payload.assignmentId);
      if (!actor) throw new AllocationError('STALE_ASSIGNMENT');
      if (op === 'publish') actor.published = true;
      if (op === 'leave' || op === 'removeSpectator') return { ok: true };
      return view(actor);
    },
    close() {},
  };
  return state;
}

const human = (seat, playerId, left = false) => ({ seat, playerId, name: playerId, isBot: false, ready: true, left, loadout: null });
const bot = (seat, code) => ({ seat, playerId: `ai_${code}${seat}`, name: `AI${seat}`, isBot: true, ready: true });
const token = () => randomBytes(16).toString('hex');

/** A room of the document in its match: `seats` as saved now, the match's assignment DTO with its original roster. */
function matchRoom(code, seats, spectators = []) {
  const spec = { roomCode: code, mode: 'coop', difficulty: 'NORMAL', modeId: modeIdFor('coop', 'NORMAL'), revivalEnabled: false,
    disableSharedPool: false, experimental: { ...EXPERIMENTAL_DEFAULTS }, aiPicksLast: false, seed: 7, matchNo: 1,
    seats: seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: !s.isBot, loadout: null,
      ops: null, notOwned: null, diy: null, skins: {} })), spectators: [] };
  return { code, mode: 'coop', difficulty: 'NORMAL', aiPicksLast: false, hostId: seats.find((s) => !s.isBot && !s.left).playerId,
    experimental: { ...EXPERIMENTAL_DEFAULTS }, source: 'private', ownerKey: null, ownerKeys: null, matchKey: null, matchKeys: null,
    matchCount: 0, createdAt: 1, seats: seats.map((s) => ({ ...s, skins: {} })),
    spectators: spectators.map((playerId) => ({ playerId, name: playerId })),
    match: { kind: 'remote', assignmentId: randomBytes(16).toString('hex'), nodeId: 'game-a', nodeGeneration: 'game-a-g1',
      actorGeneration: 1, matchNo: 1, spec } };
}

async function coordinator(t, rooms, sessions) {
  const clock = { time: 1_000_000 }, games = [node('game-a')], warnings = [];
  const platform = new RemoteGamePlatform({ nodes: games, build: BUILD, protocol: 1, sendControl: () => true, now: () => clock.time });
  const registry = new SessionRegistry({ now: () => clock.time });
  const lobby = new ClusterLobby({ registry, platform, options: {}, getData: () => ({}), now: () => clock.time,
    log: { info() {}, warn: (line) => warnings.push(line), error() {}, debug() {} }, MatchClass: class { constructor() { throw new Error('no local match'); } } });
  t.after(async () => { lobby.shutdown(); await platform.close({ release: false }); });
  await platform.refresh();
  const doc = { v: LOBBY_DOC_VERSION, kind: 'cluster', savedAt: clock.time,
    sessions: Object.entries(sessions).map(([playerId, roomCode]) => ({ playerId, token: token(), name: playerId, roomCode, notice: null,
      connected: true, disconnectedAt: null, resumeWindowMs: null, matchHeld: false, skins: {} })), rooms };
  const out = restoreLobby({ doc, registry, lobby, now: clock.time });
  assert.equal(out.rooms, rooms.length);
  const matches = new Map(out.matches.map((m) => [m.room.code, m]));
  return { clock, games, platform, lobby, matches, warnings, place: (code) => {
    const { room, ref, departed } = matches.get(code);
    assert.equal(lobby.restoreRemoteMatch(room, ref, departed), true);
  } };
}
const assignmentOf = (c, code) => c.lobby.getRoom(code).match.plan.spec.assignmentId;
/** @returns {number} the placements still waiting after 200 ms (a failed attempt is retried after RESTORE_RETRY_MS) */
async function settle(c) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const waiting = c.lobby.restoreStats.pending;
  // a placement that waits (SESSION_BUSY is retried for RESTORE_WAIT_MS) gives up at its next retry
  c.clock.time += 200_000;
  await c.platform.refresh(); // (the node's heartbeat stays fresh)
  await until(() => c.lobby.restoreStats.pending === 0, 10_000, 'placements settled');
  return waiting;
}

for (const order of [['AAAA', 'BBBB'], ['BBBB', 'AAAA']]) {
  test(`a player who left match AAAA and sits in match BBBB: both come back, placed ${order.join(' then ')}`, async (t) => {
    const c = await coordinator(t, [
      matchRoom('AAAA', [human(0, 'quinn'), human(1, 'xia', true), bot(2, 'a'), bot(3, 'a')]),
      matchRoom('BBBB', [human(0, 'xia'), human(1, 'rose'), bot(2, 'b'), bot(3, 'b')]),
    ], { quinn: 'AAAA', xia: 'BBBB', rose: 'BBBB' });
    assert.deepEqual(c.matches.get('AAAA').departed, ['xia']);
    for (const code of order) c.place(code);
    assert.equal(await settle(c), 0, 'each placed at its first attempt');
    assert.deepEqual(c.lobby.restoreStats, { pending: 0, adopted: 0, rebuilt: 2, failed: 0 }, c.warnings.join('; '));
    const a = assignmentOf(c, 'AAAA'), b = assignmentOf(c, 'BBBB'), dir = c.platform.directory;
    // the session stays BBBB's; AAAA keeps it in its roster only, departed as before the restart
    assert.equal(dir.bySession('xia').assignmentId, b);
    assert.equal(dir.bySession('quinn').assignmentId, a);
    assert.deepEqual(dir.assignments.get(a).sessionIds, ['quinn', 'xia']);
    assert.equal(c.lobby.getRoom('AAAA').seatOf('xia').left, true);
    assert.equal(c.lobby.getRoom('BBBB').seatOf('xia').left, false);
    const ctxA = c.platform.contexts.get(a), ctxB = c.platform.contexts.get(b);
    assert.equal(ctxA.members.has('xia'), false, 'no game channel into the match it left');
    assert.equal(ctxA.revokedMembers.get('xia'), 'player');
    assert.equal(ctxB.members.get('xia'), 'player');
    assert.equal(c.platform.resume(a, 'xia'), false);
    // AAAA's node hears the leave (the checkpoint may predate it), BBBB's does not
    await until(() => c.games[0].calls.some((x) => x.op === 'leave' && x.assignmentId === a && x.sessionId === 'xia'), 5000, 'leave');
    assert.equal(c.games[0].calls.some((x) => x.op === 'leave' && x.assignmentId === b), false);
    // releasing AAAA later never frees BBBB's player
    await c.platform.release(a);
    assert.equal(dir.bySession('xia').assignmentId, b);
  });

  test(`a player who left match AAAA and watches match BBBB: both come back, placed ${order.join(' then ')}`, async (t) => {
    const c = await coordinator(t, [
      matchRoom('AAAA', [human(0, 'quinn'), human(1, 'yuki', true), bot(2, 'a'), bot(3, 'a')]),
      matchRoom('BBBB', [human(0, 'rose'), bot(1, 'b'), bot(2, 'b'), bot(3, 'b')], ['yuki']),
    ], { quinn: 'AAAA', yuki: 'BBBB', rose: 'BBBB' });
    for (const code of order) c.place(code);
    assert.equal(await settle(c), 0, 'each placed at its first attempt');
    assert.deepEqual(c.lobby.restoreStats, { pending: 0, adopted: 0, rebuilt: 2, failed: 0 }, c.warnings.join('; '));
    const b = assignmentOf(c, 'BBBB');
    assert.equal(c.platform.directory.bySession('yuki').assignmentId, b);
    assert.deepEqual(c.platform.directory.bySession('yuki').spectatorIds, ['yuki']);
    assert.equal(c.platform.contexts.get(assignmentOf(c, 'AAAA')).members.has('yuki'), false);
  });
}

test('a match the coordinator takes over where it still runs leaves its departed player\'s session to the other match', async (t) => {
  const c = await coordinator(t, [
    matchRoom('AAAA', [human(0, 'quinn'), human(1, 'xia', true), bot(2, 'a'), bot(3, 'a')]),
    matchRoom('BBBB', [human(0, 'xia'), human(1, 'rose'), bot(2, 'b'), bot(3, 'b')]),
  ], { quinn: 'AAAA', xia: 'BBBB', rose: 'BBBB' });
  for (const code of ['BBBB', 'AAAA']) {
    const { ref } = c.matches.get(code);
    Object.assign(ref, { nodeGeneration: c.games[0].generation });
    c.games[0].actors.set(ref.assignmentId, { assignmentId: ref.assignmentId, roomCode: code, generation: c.games[0].actors.size + 1, published: true });
    c.place(code);
  }
  assert.equal(await settle(c), 0, 'each placed at its first attempt');
  assert.deepEqual(c.lobby.restoreStats, { pending: 0, adopted: 2, rebuilt: 0, failed: 0 }, c.warnings.join('; '));
  assert.equal(c.platform.directory.bySession('xia').assignmentId, c.matches.get('BBBB').ref.assignmentId);
});

test('a seat or an observer gone while its match is still being placed claims nothing once it is placed', async (t) => {
  const c = await coordinator(t, [
    matchRoom('AAAA', [human(0, 'quinn'), human(1, 'wen'), bot(2, 'a'), bot(3, 'a')], ['sol']),
  ], { quinn: 'AAAA', wen: 'AAAA', sol: 'AAAA' });
  c.games[0].ready = false; // no node takes it yet: the placement waits
  c.place('AAAA');
  const room = c.lobby.getRoom('AAAA');
  await until(() => c.games[0].calls.some((x) => x.op === 'restore'), 5000, 'first attempt');
  c.lobby.removeMember(room, 'wen'); // left (and may queue for another match meanwhile)
  c.lobby.removeMember(room, 'sol');
  c.games[0].ready = true;
  await until(() => c.lobby.restoreStats.pending === 0, 10_000, 'placed');
  assert.deepEqual(c.lobby.restoreStats, { pending: 0, adopted: 0, rebuilt: 1, failed: 0 }, c.warnings.join('; '));
  const a = assignmentOf(c, 'AAAA'), dir = c.platform.directory;
  assert.equal(dir.bySession('wen'), null, 'free for its next match');
  assert.equal(dir.bySession('sol'), null);
  assert.equal(dir.bySession('quinn').assignmentId, a);
  assert.equal(room.seatOf('wen').left, true);
  await until(() => c.games[0].calls.some((x) => x.op === 'leave' && x.assignmentId === a && x.sessionId === 'wen'), 5000, 'leave');
  assert.equal(c.platform.contexts.get(a).members.has('sol'), false);
});

test('directory: a departed roster seat claims no session; every seat departed, or one outside the roster, is refused', () => {
  const dir = new ClusterDirectory({ now: () => 1000 });
  dir.register({ nodeId: 'n1', generation: 'g1', build: BUILD, protocol: 1 });
  dir.heartbeat('n1', { generation: 'g1', ready: true, matches: 0 });
  const base = { build: BUILD, protocol: 1, mode: 'coop' };
  const b = dir.prepare({ ...base, roomCode: 'BBBB', sessionIds: ['xia', 'rose'] });
  assert.throws(() => dir.prepare({ ...base, roomCode: 'AAAA', sessionIds: ['quinn', 'xia'] }), { code: 'SESSION_BUSY' });
  for (const departed of [['quinn', 'xia'], ['zed'], 'xia']) {
    assert.throws(() => dir.prepare({ ...base, roomCode: 'AAAA', sessionIds: ['quinn', 'xia'], departed }), TypeError);
  }
  const a = dir.prepare({ ...base, roomCode: 'AAAA', sessionIds: ['quinn', 'xia'], departed: ['xia'] });
  assert.deepEqual(a.sessionIds, ['quinn', 'xia'], 'the roster is kept');
  dir.commit(a.assignmentId); dir.commit(b.assignmentId);
  assert.equal(dir.bySession('xia').assignmentId, b.assignmentId);
  assert.equal(dir.detachPlayer(a.assignmentId, 'xia'), false);
  dir.release(a.assignmentId);
  assert.equal(dir.bySession('xia').assignmentId, b.assignmentId);
});
