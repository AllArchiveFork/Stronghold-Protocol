// The 最终攻势 plate's layout (ui/matchPlates.js finalLayout, the 1240 × 400 design box): one column up to five survivors,
// past that (an 8–20-seat room) a grid of at most five rows — a single column of 20 rows left each avatar a few px and
// stacked the LP numbers over each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalLayout } from '../../public/js/ui/matchPlates.js';

test('up to five survivors: one column, an avatar beside its LP, a line from each row', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const L = finalLayout(n);
    assert.equal(L.grid, false, `${n}`);
    assert.equal(L.cells.length, n);
    assert.deepEqual(L.cells.map((c) => c.y), L.lines.map((l) => l.y), `${n}: a line per row`);
    assert.ok(L.cells.every((c) => c.x === 262 && c.av === 66), `${n}: the four-seat look`);
  }
  assert.deepEqual(finalLayout(0), { grid: false, cells: [], lines: [] });
});

test('six to twenty: a grid of at most five rows, column by column, every avatar readable and apart, inside the box', () => {
  for (let n = 6; n <= 20; n++) {
    const L = finalLayout(n);
    assert.equal(L.grid, true, `${n}`);
    assert.equal(L.cells.length, n);
    const ys = [...new Set(L.cells.map((c) => c.y))].sort((a, b) => a - b);
    const xs = [...new Set(L.cells.map((c) => c.x))].sort((a, b) => a - b);
    assert.ok(ys.length <= 5, `${n}: ${ys.length} rows`);
    assert.deepEqual(L.lines.map((l) => l.y), ys, `${n}: a line per grid row`);
    for (const c of L.cells) {
      assert.ok(c.av >= 50, `${n}: avatar ${c.av}`);
      // the chip: the avatar with its LP (16 px) under it, centred on the cell
      const h = c.av + 20;
      assert.ok(c.y - h / 2 >= 0 && c.y + h / 2 <= 400, `${n}: inside the box vertically (${c.y})`);
      assert.ok(c.x - c.av / 2 >= 0 && c.x + c.av / 2 <= 424, `${n}: left of the lines (${c.x})`);
    }
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= L.cells[0].av + 20, `${n}: rows apart`);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= L.cells[0].av + 20, `${n}: columns apart`);
    // column by column: the first column is full
    assert.ok(L.cells.slice(0, ys.length).every((c) => c.x === xs[0]), `${n}: the first column first`);
  }
});
