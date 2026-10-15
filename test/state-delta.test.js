// State-delta transport (shared/stateDelta.js, server/stateTransport.js; after xinhai-ai/Stronghold-Protocol 2abc60f):
// exact JSON reconstruction, safe patches, per-socket negotiation and baselines, shared broadcast encodings, reliable
// ordering through send(), the browser decoder (a broken chain reconnects) and a whole scripted match decoded frame by frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffState, applyStatePatch, StateReceiver, STATE_DELTA_VERSION } from '../shared/stateDelta.js';
import { negotiateStateDelta, prepareStateFrame, stateDeltaEnabled } from '../server/stateTransport.js';
import { send, sendMessage, NET_DEFAULTS } from '../server/net.js';
import { isCompressibleType } from '../server/wsCompression.js';
import { Net } from '../public/js/net.js';
import { validateC2S } from '../shared/protocol.js';
import { makeMatch } from './match/harness.js';

const makeView = (extra = {}) => ({ t: 'm.private', playerId: 'p1', funds: 10,
  board: [{ uid: 1, row: 2, col: 3, items: [] }], padding: 'unchanged'.repeat(300), ...extra });
const socket = () => ({ readyState: 1, bufferedAmount: 0, frames: [], options: [],
  send(data, options) { this.frames.push(JSON.parse(data)); this.options.push(options); }, terminate() { this.readyState = 3; } });
const frame = (ws, view) => prepareStateFrame(ws, view, JSON.stringify(view));

test('diff/apply reproduces JSON exactly: deletes, adds, nulls, array length/type changes, random trees', () => {
  const before = { t: 'm.public', removed: 2, nullable: { x: 1 }, players: [{ hp: 12, board: [null, { col: 4 }] }], empty: [] };
  const after = { t: 'm.public', added: false, nullable: null, players: [{ hp: 8, board: [null, { col: 5, dir: 'UP' }] }], empty: [1] };
  const saved = structuredClone(before);
  assert.deepEqual(applyStatePatch(before, diffState(before, after)), after);
  assert.deepEqual(before, saved, 'copy-on-write');
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const value = (depth) => {
    const n = random();
    if (!depth) return [null, true, false, n, String(n)][n % 5];
    if (n % 3 === 0) return Array.from({ length: n % 5 }, () => value(depth - 1));
    if (n % 3 === 1) return Object.fromEntries(Array.from({ length: n % 5 }, (_, i) => ['k' + i, value(depth - 1)]));
    return value(0);
  };
  for (let i = 0; i < 500; i++) {
    const a = { t: 'm.private', data: value(4) }, b = { t: 'm.private', data: value(4) };
    assert.deepEqual(applyStatePatch(a, diffState(a, b)), b);
  }
  assert.equal(diffState({ t: 'm.public' }, { t: 'm.private' }), null, 'another kind is never a delta');
});

test('unsafe or malformed patches are rejected atomically; prototypes stay intact; oversized diffs fall back to full', () => {
  const base = makeView();
  for (const op of [
    [['__proto__', 'polluted'], true], [['constructor', 'prototype', 'polluted'], true],
    [['board', -1], null], [['board', '0'], null], [['board', 0]], [['absent', 'x'], 1],
    [['t'], 'm.public'], [[], null], [['funds'], 1, 2],
  ]) {
    assert.throws(() => applyStatePatch(base, [[['funds'], 0], op]));
    assert.equal(base.funds, 10);
    assert.equal({}.polluted, undefined);
  }
  assert.equal(diffState({}, JSON.parse('{"__proto__":{"x":1}}')), null);
  assert.equal(diffState({ t: 'm.private' }, {
    t: 'm.private', ...Object.fromEntries(Array.from({ length: 4097 }, (_, i) => ['k' + i, i])),
  }), null, 'bounded op count');
  const deep = (leaf) => { for (let i = 0; i < 70; i++) leaf = { value: leaf }; return { t: 'm.private', nested: leaf }; };
  assert.equal(diffState(deep(1), deep(2)), null, 'bounded path depth');
});

test('negotiation: other versions keep the exact plain JSON; v1 gets full, then a small delta naming its base', () => {
  const a = makeView(), b = makeView({ funds: 9 });
  for (const version of [undefined, 0, 2, '1']) {
    const ws = socket();
    negotiateStateDelta(ws, version);
    assert.equal(stateDeltaEnabled(ws), false);
    assert.equal(frame(ws, a).data, JSON.stringify(a));
  }
  const ws = socket();
  negotiateStateDelta(ws, STATE_DELTA_VERSION);
  const first = frame(ws, a);
  assert.deepEqual(JSON.parse(first.data).full, a);
  first.commit();
  negotiateStateDelta(ws, STATE_DELTA_VERSION); // a repeated hello keeps the baselines
  const next = frame(ws, b), wire = JSON.parse(next.data);
  assert.deepEqual(wire.patch, [[['funds'], 9]]);
  assert.equal(wire.base, JSON.parse(first.data).seq);
  assert.ok(Buffer.byteLength(next.data) < Buffer.byteLength(first.data) / 10);
  const rx = new StateReceiver();
  assert.deepEqual(rx.receive(JSON.parse(first.data)).message, a);
  assert.deepEqual(rx.receive(wire).message, b);
  assert.equal(isCompressibleType('m.state'), true, 'm.state shares the deflate context like the frames it carries');
  negotiateStateDelta(ws, undefined);
  assert.equal(frame(ws, b).data, JSON.stringify(b), 'a hello without stateDelta turns it off');
});

test('a broadcast shares one encoding per transition; mutating the source after sending cannot corrupt the baseline', () => {
  const sockets = [socket(), socket(), socket(), socket()];
  const a = makeView();
  for (const ws of sockets) { negotiateStateDelta(ws, 1); frame(ws, a).commit(); }
  a.board[0].col = 7; // like a view borrowing a mutable game array
  const b = makeView({ funds: 8 });
  const encodings = sockets.map((ws) => frame(ws, b).data);
  assert.ok(encodings.every((s) => s === encodings[0]));
  assert.deepEqual(JSON.parse(encodings[0]).patch, [[['funds'], 8]]);
});

test('send(): a failed send does not move the baseline; state is reliable (never dropped) and keeps FIFO with other frames', () => {
  const ws = socket();
  negotiateStateDelta(ws, 1);
  assert.equal(send(ws, makeView()), true);
  assert.deepEqual(ws.options[0], { compress: true });
  const ok = ws.send;
  ws.send = () => { throw new Error('send failure'); };
  assert.equal(send(ws, makeView({ funds: 9 })), false);
  ws.send = ok;
  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  assert.equal(send(ws, makeView({ funds: 8 })), true, 'never droppable like b.snap');
  assert.equal(ws.frames[1].base, ws.frames[0].seq, 'the failed frame never became a base');
  assert.deepEqual(ws.frames[1].patch, [[['funds'], 8]]);
  assert.equal(send(ws, { t: 'ok', rid: 1 }), true);
  assert.equal(ws.frames[2].t, 'ok');
  ws.bufferedAmount = NET_DEFAULTS.hardBufferBytes + 1;
  assert.equal(send(ws, makeView({ funds: 7 })), false);
  assert.equal(ws.readyState, 3);
});

test('public/private and sockets are isolated; a large change and a result-phase m.public go out plain', () => {
  const ws = socket(), other = socket();
  for (const s of [ws, other]) negotiateStateDelta(s, 1);
  send(ws, makeView());
  send(ws, { t: 'm.public', phase: 'PREP', players: ['public'], padding: 'x'.repeat(2000) });
  send(other, makeView({ playerId: 'p2', funds: 77 }));
  send(ws, makeView({ funds: 9 }));
  assert.equal(ws.frames[2].base, ws.frames[0].seq);
  assert.equal(other.frames[0].full.funds, 77);
  send(ws, { t: 'm.private', entirely: 'different' });
  assert.ok(ws.frames.at(-1).full, 'a delta larger than the frame is sent full');
  for (const phase of ['RESULT', 'ENDED']) {
    const msg = { t: 'm.public', phase, players: ['public'], padding: 'x'.repeat(2000) };
    assert.equal(sendMessage(ws, msg, JSON.stringify(msg)), true);
    assert.deepEqual(ws.frames.at(-1), msg, 'the cluster ingress filters terminal frames by type');
  }
  send(ws, { t: 'm.public', phase: 'PREP', players: ['public', 'again'], padding: 'x'.repeat(2000) });
  assert.equal(ws.frames.at(-1).base, ws.frames[1].seq, 'a plain frame is not a base');
});

test('decoder: a gap or a malformed delta yields no partial state; duplicates are not re-emitted; views are private copies', () => {
  const rx = new StateReceiver(), a = makeView();
  assert.deepEqual(rx.receive({ kind: a.t, seq: 1, full: a }).message, a);
  assert.deepEqual(rx.receive({ kind: a.t, seq: 3, base: 2, patch: [[['funds'], 8]] }), { failed: true });
  assert.deepEqual(rx.receive({ kind: a.t, seq: 5, base: 3, patch: [] }), { failed: true }, 'stays broken until a full frame');
  const full = rx.receive({ kind: a.t, seq: 6, full: makeView({ funds: 8 }) }).message;
  full.board[0].col = 99; // the UI may mutate what it gets
  const next = rx.receive({ kind: a.t, seq: 7, base: 6, patch: [[['funds'], 7]] }).message;
  assert.equal(next.board[0].col, 3);
  assert.equal(rx.receive({ kind: a.t, seq: 7, base: 6, patch: [[['funds'], 7]] }), null);
  const bad = rx.receive({ kind: a.t, seq: 8, base: 7, patch: [[['board', 0, 'col'], 1], [['absent', 'x'], 1]] });
  assert.deepEqual(bad, { failed: true });
  assert.equal(a.board[0].col, 3);
  assert.deepEqual(rx.receive({ kind: 'm.field', seq: 9, full: {} }), { failed: true });
  rx.reset();
  assert.equal(rx.states.size, 0);
});

test('browser Net: hello offers stateDelta, m.state dispatches as the original event, a broken chain reconnects', () => {
  const net = new Net({ url: 'ws://test/ws' }), ws = socket(), events = [];
  let reconnects = 0;
  net.reconnectNow = () => { reconnects++; };
  net.on('m.private', (msg) => events.push(msg));
  negotiateStateDelta(ws, 1);
  send(ws, makeView());
  send(ws, makeView({ funds: 9 }));
  for (const f of ws.frames) net._onMessage(JSON.stringify(f));
  net._onMessage(JSON.stringify(ws.frames[1]));
  assert.deepEqual(events.map((e) => e.funds), [10, 9]);
  assert.equal(events[1].t, 'm.private');
  const warn = console.warn; console.warn = () => {};
  try { net._onMessage(JSON.stringify({ t: 'm.state', kind: 'm.private', seq: 100, base: 99, patch: [] })); }
  finally { console.warn = warn; }
  assert.equal(reconnects, 1);
  assert.equal(events.length, 2);
  net._teardownSocket();
  assert.equal(net._states.states.size, 0);
  let hello = null;
  net.name = 'Doctor';
  net._sendRaw = (msg) => { hello = msg; return true; };
  net._sendHello();
  net._clearTimer('_helloTimer', 'clearTimeout');
  assert.equal(hello.stateDelta, STATE_DELTA_VERSION);
  assert.equal(validateC2S(hello), null);
  assert.notEqual(validateC2S({ t: 'hello', name: 'test', stateDelta: '1' }), null);
});

test('a whole scripted match: every decoded m.public / m.private equals the original, most of them as deltas', () => {
  const h = makeMatch({ humans: 4, seed: 7, fake: true, captureFrames: false,
    script: () => ({ duration: 2, leaks: {}, bossDps: 1e9 }) });
  const peers = new Map(h.m.order.map((ps) => {
    const ws = socket(); negotiateStateDelta(ws, 1);
    return [ps.playerId, { ws, rx: new StateReceiver() }];
  }));
  const phases = new Set();
  let checked = 0, patches = 0, plain = 0;
  const deliver = (id, msg, encoded = JSON.stringify(msg)) => {
    if (msg.t !== 'm.public' && msg.t !== 'm.private') return;
    const { ws, rx } = peers.get(id);
    assert.equal(sendMessage(ws, msg, encoded), true);
    const wire = ws.frames.pop();
    if (wire.t !== 'm.state') { assert.equal(wire.phase === 'RESULT' || wire.phase === 'ENDED', true); plain++; return; }
    const decoded = rx.receive(wire);
    assert.ok(decoded && 'message' in decoded, `${msg.t} R${h.m.round} ${h.m.phase}`);
    assert.deepEqual(decoded.message, JSON.parse(encoded), `${msg.t} R${h.m.round} ${h.m.phase}`);
    checked++; if (wire.patch) patches++;
    if (msg.phase) phases.add(msg.phase);
  };
  h.onSend.push(deliver);
  h.onBroadcast.push((msg) => {
    const encoded = JSON.stringify(msg);
    for (const id of peers.keys()) deliver(id, msg, encoded);
  });
  try {
    h.start();
    assert.ok(h.drive(() => h.ended !== null));
    assert.ok(checked > 100 && patches > checked / 2, `${patches}/${checked} deltas`);
    assert.ok(phases.has('PREP') && phases.has('INFO_CHECK'));
    assert.ok(plain > 0, 'the result screen arrived plain');
    assert.equal(h.m.errorCount ?? 0, 0);
  } finally { h.m.dispose?.(); }
});
