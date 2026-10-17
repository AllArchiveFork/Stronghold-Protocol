// Checkpoints in the cluster (server/persist/, docs/DEPLOY.md「断点续玩」): real coordinator, game nodes, ingress and
// Match over native HTTP/WS, one in-memory store shared by every process lifetime of a test. The whole stack restarting
// (a release), the coordinator alone restarting (its matches are taken over where they run) and a game node restarting
// under a running coordinator (its matches are rebuilt from their checkpoints).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryValkey, memoryStore } from './helpers/memoryStore.js';
import { stack, stop, nodeConfigs, actorOf, playToPrep, client, until } from './helpers/clusterStack.js';

test('the whole stack restarts (a release): the match comes back on a node from its checkpoint and the player resumes it', { timeout: 120_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store), configs = nodeConfigs();
  const first = await stack(storeFor, { configs });
  const { c, code, ps, ctx: before } = await playToPrep(first, 2);
  const funds = ps.funds, lp = ps.lp, oldId = before.spec.assignmentId;
  await stop(first);
  await c.closed;
  assert.ok(store.keys('sp:cp:').length >= 1, 'the node wrote the checkpoint');
  const second = await stack(storeFor, { configs });
  t.after(() => stop(second));
  const room = second.coordinator.lobby.getRoom(code);
  assert.ok(room?.match, 'the room is back in its match');
  await until(() => second.coordinator.lobby.restoreStats.rebuilt === 1, 15_000, 'rebuilt');
  const back = await client(second.ingress.url, 'Doctor', c.token);
  assert.equal(back.playerId, c.playerId);
  await until(() => back.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP'), 10_000, 'resync');
  assert.equal(back.last('m.public').round, 2);
  assert.equal(back.last('m.public').replayRound, undefined, 'stopped during the prep: nothing is fought again');
  const ctx = actorOf(second, code);
  assert.notEqual(ctx.spec.assignmentId, oldId, 'rebuilt as a new assignment');
  assert.equal(ctx.match.players.get(c.playerId).funds, funds);
  assert.equal(ctx.match.players.get(c.playerId).lp, lp);
  // plays on: Ready → the round's battle
  await back.request('g.ready', { ready: true });
  await until(() => ctx.match.phase !== 'PREP' || ctx.match.round > 2, 15_000, 'plays on');
  // the restored actor wrote its own checkpoint at once; the one it came from goes once its publication is long settled
  const owner = second.games.find((g) => g.gameHost.contexts.has(ctx.spec.assignmentId)).checkpoints;
  assert.ok(store.data.has(`sp:cp:${ctx.spec.assignmentId}`));
  assert.ok(store.data.has(`sp:cp:${oldId}`));
  owner.supersedes.get(ctx.spec.assignmentId).at -= 60_000;
  // (only once the new actor's latest write is confirmed: a deflate on a busy host can take a moment)
  await until(() => owner.written.get(ctx.spec.assignmentId)?.ok, 10_000, 'own checkpoint confirmed');
  await owner.tick('tick');
  assert.equal(store.data.has(`sp:cp:${oldId}`), false);
  back.socket.close();
});

test('a stack stopped during a battle rebuilds the match in that round\'s prep, which says the battle is fought again', { timeout: 120_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store), configs = nodeConfigs();
  // the round's checkpoint (written as its prep ended) is still on its way when the node stops: the shutdown waits for it
  store.checkpointWriteMs = 2000;
  const first = await stack(storeFor, { configs });
  const { c, code, ctx: before } = await playToPrep(first, 2);
  await c.request('g.ready', { ready: true });
  await until(() => before.match.phase !== 'PREP', 15_000, 'past the prep');
  assert.equal(before.match.round, 2);
  await stop(first);
  await c.closed;
  store.checkpointWriteMs = 0;
  const second = await stack(storeFor, { configs });
  t.after(() => stop(second));
  await until(() => second.coordinator.lobby.restoreStats.rebuilt === 1, 15_000, 'rebuilt');
  const back = await client(second.ingress.url, 'Doctor', c.token);
  await until(() => back.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP'), 10_000, 'resync');
  assert.equal(back.last('m.public').round, 2);
  assert.equal(back.last('m.public').replayRound, 2);
  await back.request('g.ready', { ready: true });
  await until(() => back.last('m.public').phase !== 'PREP', 15_000, 'the battle again');
  assert.equal(back.last('m.public').replayRound, undefined);
  back.socket.close();
});

test('the coordinator alone restarts: its matches are taken over where they run, nothing is rebuilt', { timeout: 120_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store), configs = nodeConfigs();
  const first = await stack(storeFor, { configs });
  t.after(() => Promise.all(first.games.map((g) => g.close())));
  const { c, code, ctx } = await playToPrep(first, 1);
  const assignmentId = ctx.spec.assignmentId;
  await stop(first, { games: false });
  await c.closed;
  assert.equal(ctx.state, 'committed', 'the actor kept running');
  const second = await stack(storeFor, { configs, coordinatorOnly: first });
  t.after(async () => { await second.ingress.close(); await second.coordinator.close(); for (const e of second.events.values()) e.close(); });
  await until(() => second.coordinator.lobby.restoreStats.adopted === 1, 15_000, 'adopted');
  assert.equal(second.coordinator.lobby.restoreStats.rebuilt, 0);
  assert.equal(second.coordinator.platform.directory.byRoom(code).assignmentId, assignmentId);
  const back = await client(second.ingress.url, 'Doctor', c.token);
  await until(() => back.frames.some((f) => f.t === 'm.private'), 10_000, 'resync');
  assert.equal(actorOf(second, code), ctx, 'the very same actor');
  back.socket.close();
});

test('a game node restarts under a running coordinator: its match is rebuilt on a node from its checkpoint instead of closing', { timeout: 120_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store), configs = nodeConfigs();
  const s = await stack(storeFor, { configs });
  t.after(() => stop(s));
  const { c, code, ctx } = await playToPrep(s, 1);
  const i = s.games.findIndex((g) => g.gameHost.contexts.get(ctx.spec.assignmentId) === ctx);
  const port = Number(new URL(s.games[i].url).port);
  await s.games[i].close();
  const [fresh] = (await stack(storeFor, { configs: [configs[i]], ports: [port], nodesOnly: true, events: s.events })).games;
  s.games[i] = fresh;
  await until(() => s.coordinator.lobby.restoreStats.rebuilt === 1, 20_000, 'rebuilt after the node restart');
  const room = s.coordinator.lobby.getRoom(code);
  assert.ok(room?.match && !room.disposed);
  const again = actorOf(s, code);
  assert.ok(again && again !== ctx);
  assert.equal(again.match.round, 1);
  await until(() => c.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP' && f.round === 1) && again.members.get(c.playerId)?.binding, 15_000, 'the player is moved over');
  c.socket.close();
});
