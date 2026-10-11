// tools/coordbench.mjs pure helpers only (the replay itself spawns processes and is run by hand, see the tool header).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, summarize, syntheticRows } from '../tools/coordbench.mjs';

test('coordbench options: production-like defaults, explicit overrides, unknown options refused', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.clients, 1400);
  assert.equal(defaults.ingress, 2);
  assert.deepEqual(defaults.matchSec, [60, 150]);
  assert.equal(defaults.storm, false);
  const opts = parseArgs(['--clients', '200', '--match-sec', '30', '--storm', '--offload-static', '--receipt20-kb', '900']);
  assert.equal(opts.clients, 200);
  assert.deepEqual(opts.matchSec, [30, 30]);
  assert.equal(opts.storm && opts.offloadStatic, true);
  assert.equal(opts.receipt20Kb, 900);
  assert.throws(() => parseArgs(['--production', 'host']), /unknown option/);
  assert.throws(() => parseArgs(['--clients', 'many']), /needs a number/);
});

test('coordbench synthetic end payloads reach their size with many small rows', () => {
  const rows = syntheticRows(64 * 1024, 'seed');
  const bytes = Buffer.byteLength(JSON.stringify(rows));
  assert.ok(bytes >= 64 * 1024 && bytes < 70 * 1024, `${bytes}`);
  assert.ok(rows.length > 300);
  assert.deepEqual(syntheticRows(64 * 1024, 'seed'), rows, 'deterministic');
});

test('coordbench summary merges windows: event-loop extremes, external timers and /healthz phases', () => {
  const window = (p99, max, phases) => ({ eld: { p50: 10, p99, max }, health: phases ? { eventLoopDelayMs: { p99: p99 + 1, max: max + 1 }, phases } : null,
    elu: 0.1, cpuPercent: 5, online: 1400, matches: 100,
    external: { 'x.presence.publish': { count: 1, totalMs: 2, maxMs: 2, items: 0, over5ms: 0, over20ms: 0 } } });
  const s = summarize([window(11, 12, { 'receipt.apply': { count: 2, totalMs: 4, maxMs: 3, p99Ms: 4, items: 10 } }), window(15, 40, null), window(12, 13, null)]);
  assert.deepEqual(s.eld, { p99Median: 12, p99Max: 15, maxMax: 40, p50Median: 10 });
  assert.deepEqual(s.healthEld, { p99Max: 12, maxMax: 13 });
  assert.deepEqual(s.external['x.presence.publish'], { count: 3, totalMs: 6, maxMs: 2, items: 0, over5ms: 0, over20ms: 0 });
  assert.deepEqual(s.phases['receipt.apply'], { count: 2, totalMs: 4, maxMs: 3, p99MsMax: 4, items: 10 });
});
