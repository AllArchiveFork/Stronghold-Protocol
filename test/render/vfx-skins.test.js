// Skin effects (feedback #22, index.json skins[<catalogue id>]): a unit wearing a catalogue skin of its operator takes
// that skin's points, plays its `replace` keys (on itself and, for its hits, on its targets) and flies its fake
// projectiles' graphic shot with the logic projectile's hits; anything else keeps the default effects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';

const IDX = {
  units: { char_a: { skin: 'char_a', modes: [] }, char_b: { skin: 'char_b', modes: [] } },
  skins: {
    char_a: { points: { HitPoint: {} } },
    char_b: { points: {} },
    char_a_x_1: { char: 'char_a', points: { HitPoint: { all: { pos: [0, 1, 0] } } }, replace: { a_hit: 'a_hit_x#1', a_gone: 'a_gone_x#1' },
      fakeProjectiles: [{ origin: 'proj_a', graphic: 'proj_a_graphic', logic: 'proj_a_logic', muzzle: 'SPECIAL_2' }] },
  },
  projectiles: {
    proj_a: { main: 'a_trail', onHit: ['a_hit'] },
    proj_a_graphic: { main: 'a_trail_x#1', onHit: null, effects: ['a_trail_x#1'] },
    proj_a_logic: { main: null, onHit: ['a_hit'], effects: ['a_hit'] },
  },
};
const HAVE = new Set(['a_hit', 'a_hit_x#1', 'a_trail', 'a_trail_x#1']);
function wiring() {
  const w = new FxWiring({ lib: { has: (k) => HAVE.has(k), index: async () => IDX }, active: true }, {});
  w.idx = IDX;
  return w;
}
const view = (id, def, skinId) => ({ id, info: { id, spine: def, defId: def, ...(skinId ? { skinId } : {}) } });

test('skinOf: the catalogue skin only for its own operator, else the default skin', () => {
  const w = wiring();
  assert.equal(w.skinOf(IDX.units.char_a, view(1, 'char_a', 'char_a_x_1')), IDX.skins.char_a_x_1);
  assert.equal(w.skinOf(IDX.units.char_a, view(2, 'char_a')), IDX.skins.char_a);
  assert.equal(w.skinOf(IDX.units.char_b, view(3, 'char_b', 'char_a_x_1')), IDX.skins.char_b, "another operator's skin");
  assert.equal(w.skinOf(IDX.units.char_a, view(4, 'char_a', 'char_zz_1')), IDX.skins.char_a);
});

test('swap: the skin owner\'s replace target when the library has it; unknown or unskinned keys stay', () => {
  const w = wiring();
  const skinned = view(1, 'char_a', 'char_a_x_1'), plain = view(2, 'char_a');
  assert.equal(w.swap('A_HIT', skinned), 'a_hit_x#1');
  assert.equal(w.swap('a_hit', plain), 'a_hit');
  assert.equal(w.swap('a_gone', skinned), 'a_gone', 'a target the library lacks: the default');
  assert.equal(w.swap('a_trail', skinned), 'a_trail');
});

test('_fakeShot: the graphic projectile flies from the skin muzzle, with the logic projectile\'s hits', () => {
  const w = wiring();
  const f = w._fakeShot(IDX.projectiles.proj_a, view(1, 'char_a', 'char_a_x_1'));
  assert.equal(f.kind, 's2');
  assert.equal(f.proj.main, 'a_trail_x#1');
  assert.deepEqual(f.proj.onHit, ['a_hit']);
  assert.equal(w._fakeShot(IDX.projectiles.proj_a, view(2, 'char_a')), null, 'the default skin flies the origin');
});

test('keysFor preloads a skinned unit\'s swapped-in effects and its own shots', () => {
  const w = wiring();
  w.skills = { keys: () => [] }; w.talents = { keys: () => [] }; w.funnels = { keys: () => [] };
  const keys = w.keysFor([view(1, 'char_a', 'char_a_x_1')], false);
  assert.ok(keys.includes('a_hit_x#1'));
  assert.ok(keys.includes('a_trail_x#1'));
  assert.deepEqual(w.keysFor([view(2, 'char_a')], false), []);
});
