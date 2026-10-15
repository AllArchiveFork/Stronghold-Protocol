// State-delta transport v1 (opt-in per socket; after xinhai-ai/Stronghold-Protocol 2abc60f, GPL-3.0-or-later).
// Only m.public / m.private ride it: the server wraps them as m.state { kind, seq, full } or { kind, seq, base, patch };
// every other message keeps its wire format. A socket that never negotiated (hello.stateDelta) gets plain frames.
// Arrays of equal length are patched by index; a length or type change replaces the subtree (no splice ambiguity).
// Applying a patch is copy-on-write: an emitted view, a baseline and the previous view are never changed.
export const STATE_DELTA_VERSION = 1;
export const isStateKind = (kind) => kind === 'm.public' || kind === 'm.private';
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeKey = (k) => typeof k === 'string' && k !== '__proto__' && k !== 'prototype' && k !== 'constructor';
const MAX_OPS = 4096;
const MAX_DEPTH = 64;

/**
 * Diff two JSON values. Ops: [path, value] sets, [path] deletes an object key. null: send a full frame instead
 * (too many ops, too deep, or an unsafe key).
 * @returns {Array<[Array<string|number>, any] | [Array<string|number>]> | null}
 */
export function diffState(before, after) {
  const ops = [], path = [];
  let overflow = false;
  const emit = (value, remove = false) => {
    if (ops.length >= MAX_OPS || path.length > MAX_DEPTH) { overflow = true; return; }
    ops.push(remove ? [path.slice()] : [path.slice(), value]);
  };
  const child = (key, a, b) => {
    path.push(key);
    walk(a, b);
    path.pop();
  };
  const walk = (a, b) => {
    if (overflow || a === b) return;
    if (path.length > MAX_DEPTH) { overflow = true; return; }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      for (let i = 0; i < b.length && !overflow; i++) child(i, a[i], b[i]);
    } else if (record(a) && record(b)) {
      for (const key of Object.keys(a)) {
        if (Object.hasOwn(b, key)) continue;
        if (!safeKey(key)) { overflow = true; return; }
        path.push(key); emit(undefined, true); path.pop();
        if (overflow) return;
      }
      for (const key of Object.keys(b)) {
        if (!safeKey(key)) { overflow = true; return; }
        if (Object.hasOwn(a, key)) child(key, a[key], b[key]);
        else { path.push(key); emit(b[key]); path.pop(); }
        if (overflow) return;
      }
    } else {
      emit(b);
    }
  };
  // The top level is always a record carrying `t`, never replaced as a whole.
  if (!record(before) || !record(after) || before.t !== after.t) return null;
  walk(before, after);
  return overflow ? null : ops;
}

/** Apply diffState ops copy-on-write. Throws on a malformed op or path; a failure changes nothing. */
export function applyStatePatch(base, ops) {
  if (!record(base) || !Array.isArray(ops) || ops.length > MAX_OPS) throw new Error('bad patch');
  let next = base;
  const update = (node, path, index, op) => {
    const key = path[index];
    const array = Array.isArray(node);
    if (array ? !Number.isInteger(key) || key < 0 || key >= node.length : !record(node) || !safeKey(key)) {
      throw new Error('bad path');
    }
    const copy = array ? node.slice() : { ...node };
    if (index + 1 < path.length) {
      if (!Object.hasOwn(node, key)) throw new Error('missing path');
      copy[key] = update(node[key], path, index + 1, op);
    } else if (op.length === 1) {
      if (array || !Object.hasOwn(node, key)) throw new Error('bad delete');
      delete copy[key];
    } else {
      copy[key] = op[1];
    }
    return copy;
  };
  for (const op of ops) {
    if (!Array.isArray(op) || (op.length !== 1 && op.length !== 2) || !Array.isArray(op[0])
      || !op[0].length || op[0].length > MAX_DEPTH || op[0][0] === 't') throw new Error('bad op');
    next = update(next, op[0], 0, op);
  }
  return next;
}

/**
 * Browser decoder, one per socket (reset with the socket: the server keeps its baselines per socket too).
 * receive() answers the decoded m.public / m.private, `null` for a duplicate, or `{ failed: true }` when the chain is
 * broken (a delta without its base, a malformed frame) — the caller then reconnects, which restarts both sides with
 * full frames. The view handed out is a private copy: the UI may mutate it without touching the next baseline.
 */
export class StateReceiver {
  constructor() {
    /** @type {Map<string, { seq: number, view: any }>} */
    this.states = new Map();
  }

  reset() { this.states.clear(); }

  /** @returns {{ message: any } | { failed: true } | null} */
  receive(frame) {
    const kind = frame?.kind, seq = frame?.seq;
    if (!isStateKind(kind) || !Number.isSafeInteger(seq) || seq <= 0) return { failed: true };
    let view;
    if (Object.hasOwn(frame, 'full')) {
      if (!record(frame.full) || frame.full.t !== kind) return { failed: true };
      view = frame.full;
    } else {
      const previous = this.states.get(kind);
      if (previous?.seq === seq) return null; // a duplicate is never emitted twice
      if (!previous || frame.base !== previous.seq) { this.states.delete(kind); return { failed: true }; }
      try { view = applyStatePatch(previous.view, frame.patch); } catch { this.states.delete(kind); return { failed: true }; }
    }
    this.states.set(kind, { seq, view });
    // The stored view is the next baseline (and shares subtrees with the previous one): hand out a copy.
    // JSON round trip, not structuredClone (missing in some supported Safari versions).
    return { message: JSON.parse(JSON.stringify(view)) };
  }
}
