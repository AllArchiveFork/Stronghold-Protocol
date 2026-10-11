// Worker-mode lean replies (field meta on demand, terminal frames once, no second DTO clone) against the original
// engine output: every client frame, effect and result stays the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { RemoteBattle, WorkerFieldRunner } from '../../server/match/combat/runner.js';
import { emptyPerPlayer } from '../../server/match/fields.js';
import { TICK } from '../../server/sim/constants.js';
import { DATA, QUIET, phase } from './combat-fixtures.js';

const LEAN = { metaOnDemand: true, terminalOnce: true };

function wired(input) {
  return { ...input, wireFrames: true, coalesceFrames: true, damageBoard: true, snapshotHz: 5 };
}

function adapter(input, clock, { solo = false } = {}) {
  let completions = 0;
  const sent = [], effects = [];
  const fields = input.specs.map((spec) => ({ spec, fieldId: spec.fieldId, kind: spec.kind,
    players: spec.players.map(p => p.playerId), live: true, battle: new RemoteBattle(spec) }));
  const m = {
    disposed: false, ended: false, paused: false, gameSpeed: 2, isSolo: solo,
    players: new Map(fields.map((f, i) => [`p${i}`, { connected: true }])),
    spectators: new Map(), watchers: new Map(fields.map((f, i) => [`p${i}`, f.fieldId])),
    sched: { now: clock, clearInterval() {}, setInterval() {} },
    watchersOf(id) { return [...this.watchers].filter(([, fid]) => fid === id).map(([pid]) => pid); },
    sendEncoded(pid, type, wire) { sent.push([pid, type, wire]); return true; },
    sendTo(pid, msg) { return this.sendEncoded(pid, msg.t, JSON.stringify(msg)); },
    markPublic() {}, guard(fn) { fn(); }, reportError(label, e) { throw new Error(`${label}: ${e}`); },
    _onDamageRows() { return false; },
    bossPool: { hp: 0, byPlayer: new Map(), damage(pid, amount) { effects.push({ type: 'bossDamage', playerId: pid, amount }); } },
    _teamLpLoss(amount) { effects.push({ type: 'lpLoss', amount }); }, _syncTeamLp() {},
  };
  const runner = new WorkerFieldRunner(m, fields, { onDone() { completions++; } });
  m.runner = runner;
  return { m, runner, fields, sent, effects, get completions() { return completions; } };
}

for (const kind of ['normal', 'unite']) {
  test(`lean ${kind} replies deliver the original client frames, effects and results`, () => {
    const input = wired(phase(kind));
    if (kind === 'normal') { input.specs[0].timeLimit = 1; input.specs[1].timeLimit = 4; }
    let now = 1000;
    const clock = () => now;
    const original = new CombatEngine(input, { data: DATA, log: QUIET, now: clock });
    const lean = new CombatEngine({ ...input, ...LEAN }, { data: DATA, log: QUIET, now: clock, cloneOutput: false });
    const a = adapter(input, clock), b = adapter(input, clock);
    const ids = input.specs.map(s => s.fieldId);
    let bytes = [0, 0], terminalFrames = [0, 0];
    try {
      a.runner._apply(original.state({ snapshotFields: ids }));
      b.runner._apply(lean.state({ snapshotFields: ids }));
      let out, leanOut;
      do {
        now += 50;
        out = original.advance(2, { snapshotFields: ids });
        leanOut = lean.advance(2, { snapshotFields: ids, metaFields: b.runner._metaFields(ids) });
        for (const frame of leanOut.frames) {
          if (!frame.snapshotWire) continue;
          const live = leanOut.fields.find(f => f.fieldId === frame.fieldId).live;
          if (live) assert.equal(frame.metaWire, null, 'a live frame carries no field meta');
          else assert.ok(frame.metaWire, 'a terminal frame keeps its meta');
        }
        terminalFrames[0] += out.frames.filter(f => f.snapshotWire && !out.fields.find(v => v.fieldId === f.fieldId).live).length;
        terminalFrames[1] += leanOut.frames.filter(f => f.snapshotWire && !leanOut.fields.find(v => v.fieldId === f.fieldId).live).length;
        bytes[0] += v8.serialize(out).length; bytes[1] += v8.serialize(leanOut).length;
        a.runner._apply(out);
        b.runner._apply(leanOut);
        assert.deepEqual(leanOut.effects, out.effects);
        assert.deepEqual(leanOut.fields.map(({ result, damageRows, ...view }) => { void result; void damageRows; return view; }),
          out.fields.map(({ result, damageRows, ...view }) => { void result; void damageRows; return view; }));
      } while (!out.done);
      assert.equal(leanOut.done, true);
      // Each watcher's own stream is identical; only the interleaving of different sockets within one reply may differ.
      const perViewer = (sent) => Object.fromEntries(['p0', 'p1'].map((pid) => [pid, sent.filter(([to]) => to === pid)]));
      assert.deepEqual(perViewer(b.sent), perViewer(a.sent), 'identical frames, order, 1s terminal retries and phase-final resends');
      assert.equal(b.sent.length, a.sent.length);
      assert.deepEqual(b.fields.map(f => f.battle.result()), a.fields.map(f => f.battle.result()));
      assert.deepEqual(b.effects, a.effects);
      assert.equal(a.completions, 1); assert.equal(b.completions, 1);
      if (kind === 'normal') {
        assert.ok(terminalFrames[1] < terminalFrames[0], 'the early final is not rebuilt on every reply');
        assert.ok(a.sent.filter(([pid, type]) => pid === 'p0' && type === 'b.snap').length > 2, 'the fixture covers terminal retries');
      }
      assert.ok(bytes[1] < bytes[0], `lean replies are smaller (${bytes[1]} < ${bytes[0]})`);
    } finally { a.runner.stop(); b.runner.stop(); original.dispose(); lean.dispose(); }
  });
}

test('a rejoin during a lean live phase is answered by the next state turn with a complete pair', () => {
  const input = wired(phase('normal'));
  let now = 1000;
  const engine = new CombatEngine({ ...input, ...LEAN }, { data: DATA, log: QUIET, now: () => now, cloneOutput: false });
  const h = adapter(input, () => now);
  const ids = input.specs.map(s => s.fieldId);
  try {
    h.runner._apply(engine.state({ snapshotFields: ids }));
    for (let i = 0; i < 6; i++) { now += 50; h.runner._apply(engine.advance(2, { snapshotFields: ids, metaFields: h.runner._metaFields(ids) })); }
    assert.equal(h.fields[0].battle._metaWire, null);
    h.runner.requestField('p0', ids[0]);
    assert.deepEqual(h.runner._metaFields(ids), [ids[0]], 'a pending rejoin asks for its field meta');
    const before = h.sent.length;
    for (let i = 0; i < 12 && h.runner.resync.size; i++) {
      now += 50;
      h.runner._apply(engine.advance(2, { snapshotFields: ids, metaFields: h.runner._metaFields(ids) }));
    }
    assert.deepEqual(h.sent.slice(before).filter(([pid]) => pid === 'p0').map(([, type]) => type).slice(0, 2), ['m.field', 'b.snap'],
      'served by the first snapshot boundary of a turn that knew about the rejoin');
    assert.equal(h.runner.resync.size, 0);
    assert.ok(h.fields[0].battle._metaWire);
  } finally { h.runner.stop(); engine.dispose(); }
});

test('solo keeps a complete cached pair for a paused rejoin; co-op without one waits for state', () => {
  for (const solo of [true, false]) {
    const input = wired(phase('normal'));
    let now = 1000;
    const engine = new CombatEngine({ ...input, ...LEAN }, { data: DATA, log: QUIET, now: () => now, cloneOutput: false });
    const h = adapter(input, () => now, { solo });
    const ids = input.specs.map(s => s.fieldId);
    try {
      h.runner._apply(engine.state({ snapshotFields: ids }));
      for (let i = 0; i < 6; i++) { now += 50; h.runner._apply(engine.advance(2, { snapshotFields: ids, metaFields: h.runner._metaFields(ids) })); }
      h.m.paused = true;
      const before = h.sent.length;
      h.runner.requestField('p0', ids[0]);
      const types = h.sent.slice(before).filter(([pid]) => pid === 'p0').map(([, type]) => type);
      if (solo) {
        assert.deepEqual(types.slice(0, 2), ['m.field', 'b.snap'], 'paused solo rejoin is answered from the cached pair at once');
        assert.equal(h.runner.resync.size, 0);
        assert.equal(JSON.parse(h.fields[0].battle._metaWire).fieldId, ids[0]);
      } else {
        assert.deepEqual(types, []);
        assert.equal(h.runner.resync.get('p0'), ids[0]);
        h.m.paused = false;
        h.runner._apply(engine.state({ snapshotFields: [ids[0]] }), true);
        assert.deepEqual(h.sent.slice(before).filter(([pid]) => pid === 'p0').map(([, type]) => type).slice(0, 2), ['m.field', 'b.snap']);
        assert.equal(h.runner.resync.size, 0);
      }
    } finally { h.runner.stop(); engine.dispose(); }
  }
});

class BossProbe {
  constructor(opts) {
    this.opts = opts; this.fieldId = opts.fieldId; this.kind = opts.kind; this.sharedBoss = opts.sharedBoss;
    this.time = 0; this.tickCount = 0; this.finished = false; this.errors = [];
  }
  on(name) { return name; }
  off() {}
  step() {
    this.time = ++this.tickCount * TICK;
    if (this.opts.flags.hit) this.sharedBoss.damage(this.opts.players[0].playerId, this.opts.flags.hit);
    if (this.opts.flags.end) this.forceEnd('cleared');
  }
  forceEnd(reason) { this.finished = true; this.reason = reason; }
  result() { return { reason: this.reason, time: this.time, errors: 0,
    perPlayer: Object.fromEntries(this.opts.players.map(p => [p.playerId, emptyPerPlayer()])) }; }
  snapshot() { return { fieldId: this.fieldId, t: this.time, hp: this.sharedBoss.hp, units: [] }; }
  fieldMeta() { return { fieldId: this.fieldId, units: [] }; }
  drainEvents() { return []; }
}

test('a finished shared-Boss field keeps sending its changing final view and result every reply', () => {
  const input = { wireFrames: true, coalesceFrames: true, ...LEAN, boss: { maxHp: 100, hp: 100, teamLp: 100, bossOvertimeAfterReal: 100 },
    specs: [{ end: true }, { hit: 3 }].map((flags, i) => ({ fieldId: `b${i}`, kind: 'boss', flags, players: [{ playerId: `p${i}` }], spawns: [] })) };
  const engine = new CombatEngine(input, { BattleClass: BossProbe, log: QUIET, cloneOutput: false });
  try {
    const hp = [];
    for (let i = 0; i < 3; i++) {
      const out = engine.advance(1, { snapshotFields: ['b0'] });
      const frame = out.frames.findLast(f => f.fieldId === 'b0' && f.snapshotWire);
      assert.ok(frame?.metaWire, 'terminal Boss frame with meta on every reply');
      assert.ok(out.fields[0].result);
      hp.push(JSON.parse(frame.snapshotWire).hp);
    }
    assert.deepEqual(hp, [97, 94, 91]);
  } finally { engine.dispose(); }
});

test('cloneOutput:false returns the same DTO as the isolated copy', () => {
  const input = wired(phase('boss'));
  const copied = new CombatEngine(input, { data: DATA, log: QUIET, now: () => 0 });
  const direct = new CombatEngine(input, { data: DATA, log: QUIET, now: () => 0, cloneOutput: false });
  try {
    const ids = input.specs.map(s => s.fieldId);
    assert.deepEqual(v8.deserialize(v8.serialize(direct.state({ snapshotFields: ids }))), copied.state({ snapshotFields: ids }));
    for (let i = 0; i < 40; i++) {
      assert.deepEqual(v8.deserialize(v8.serialize(direct.advance(3, { snapshotFields: ids }))), copied.advance(3, { snapshotFields: ids }));
    }
  } finally { copied.dispose(); direct.dispose(); }
});
