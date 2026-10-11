// One pacing interval per pool and one Worker wire turn for every phase command of that tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatWorkerPool, PACE_MS } from '../../server/match/combat/pool.js';
import { RemoteBattle, WorkerFieldRunner } from '../../server/match/combat/runner.js';
import { INTERVAL_MS } from '../../server/match/fields.js';
import { RealScheduler } from '../../server/match/scheduler.js';
import { DATA, QUIET, phase, until } from './combat-fixtures.js';

test('the shared pace keeps the per-phase pacing interval', () => {
  assert.equal(PACE_MS, INTERVAL_MS);
});

test('pace: one timer for every subscriber, isolated callbacks, cleared with the last subscriber and on close', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  const calls = [];
  const a = pool.pace(() => calls.push('a'));
  const timer = pool.paceTimer;
  const b = pool.pace(() => { calls.push('b'); throw new Error('isolated'); });
  const c = pool.pace(() => calls.push('c'));
  assert.equal(pool.paceTimer, timer, 'one interval regardless of subscribers');
  pool._paceTick();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  a(); b();
  assert.ok(pool.paceTimer);
  c();
  assert.equal(pool.paceTimer, null);
  pool.pace(() => {});
  assert.ok(pool.paceTimer);
  await pool.close();
  assert.equal(pool.paceTimer, null);
  assert.equal(pool.pacers.size, 0);
});

function phaseRunner(pool, input, sent) {
  const sched = new RealScheduler();
  const fields = input.specs.map((spec) => ({ spec, fieldId: spec.fieldId, kind: spec.kind,
    players: spec.players.map(p => p.playerId), live: true, battle: new RemoteBattle(spec) }));
  const failures = [];
  const m = {
    combatPool: pool, sched, gameSpeed: 2, snapshotHz: 10, paused: false, disposed: false, ended: false, isSolo: false,
    players: new Map(fields.map((f) => [f.players[0], { connected: true }])), spectators: new Map(),
    watchers: new Map(fields.map((f) => [f.players[0], f.fieldId])),
    watchersOf(id) { return [...this.watchers].filter(([, fid]) => fid === id).map(([pid]) => pid); },
    sendEncoded: (pid, type, wire) => { sent.push([pid, type, wire]); return true; },
    sendTo(pid, msg) { return this.sendEncoded(pid, msg.t, JSON.stringify(msg)); },
    markPublic() {}, guard(fn) { try { fn(); } catch (e) { failures.push(e); } }, reportError: (label, e) => failures.push(e),
    _onDamageRows() { return false; }, tickerText() {}, finish() { this.ended = true; },
  };
  let done = 0;
  const runner = new WorkerFieldRunner(m, fields, { onDone() { done++; } });
  m.runner = runner;
  return { m, runner, sched, failures, get done() { return done; } };
}

test('real-time phases share the pool tick: one batched wire turn per Worker carries every phase command', { timeout: 20_000 }, async (t) => {
  const pool = new CombatWorkerPool({ size: 2, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const turns = [];
  const reply = pool._reply.bind(pool), batchReply = pool._batchReply.bind(pool);
  pool._reply = (slot, message) => { turns.push([slot.index, 1]); reply(slot, message); };
  pool._batchReply = (slot, message) => { turns.push([slot.index, message.replies.length]); batchReply(slot, message); };
  const sent = [];
  const hs = Array.from({ length: 8 }, () => phaseRunner(pool, { ...phase('normal'), snapshotHz: 10 }, sent));
  t.after(() => hs.forEach((h) => { h.runner.stop(); h.sched.dispose?.(); }));
  for (const h of hs) h.runner.start();
  assert.ok(hs.every((h) => h.runner.unpace && !h.runner.interval), 'no per-phase interval');
  assert.equal(pool.pacers.size, 8);
  await until(() => hs.every((h) => h.done === 1), 'all phases finished in real time');
  assert.deepEqual(hs.flatMap((h) => h.failures), []);
  assert.ok(turns.some(([, n]) => n > 1), 'several phases per wire turn');
  assert.ok(turns.every(([, n]) => n <= 8));
  assert.equal(pool.pacers.size, 0, 'finished phases leave the shared tick');
  assert.equal(pool.paceTimer, null);
  assert.ok(sent.some(([, type]) => type === 'b.snap'));
});

test('a batched command failure closes only its own session; a disposed phase leaves the tick by itself', { timeout: 20_000 }, async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const input = { ...phase('normal'), wireFrames: true };
  const good = pool.create(input), bad = pool.create(input);
  await Promise.all([good.ready, bad.ready]);
  let failed = null;
  const results = [];
  const stop = pool.pace(() => {
    results.push(good.request('advance', { ticks: 2, snapshotFields: [] }));
    results.push(bad.request('advance', { ticks: -1 }).catch((e) => { failed = e; return null; }));
  });
  const batches = [];
  const batchReply = pool._batchReply.bind(pool);
  pool._batchReply = (slot, message) => { batches.push(message.replies.length); batchReply(slot, message); };
  pool._paceTick();
  stop();
  const [out] = await Promise.all(results);
  assert.deepEqual(batches, [2]);
  assert.equal(out.ticks, 2);
  assert.equal(failed?.code, 'WORKER_COMMAND');
  assert.equal((await good.request('advance', { ticks: 1, snapshotFields: [] })).ticks, 3, 'the other session still runs');
  await assert.rejects(bad.request('advance', { ticks: 1 }), { code: 'SESSION_CLOSED' });
  assert.equal(pool.stats().replacements, 0);

  const sent = [];
  const h = phaseRunner(pool, { ...phase('normal'), snapshotHz: 10 }, sent);
  h.runner.start();
  await until(() => h.runner.ready, 'ready');
  assert.equal(pool.pacers.size, 1);
  h.m.disposed = true;
  pool._paceTick();
  assert.equal(pool.pacers.size, 0);
  assert.equal(h.runner.session, null);
  good.close();
});
