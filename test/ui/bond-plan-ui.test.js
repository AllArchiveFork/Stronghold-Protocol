// 预选盟约 and AI 指定策略 on the client (ui/bondPlan.js, screens/bandDraft.js reservedBands): the plannable list mirrors
// the server's GameData.plannableBondIds(), the change window mirrors Match.bondPlanOpen(), other players' plans and a
// strategy the host reserved for an AI read as taken until that AI picks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { DATA } from '../match/harness.js';
import { GameData } from '../../server/match/gamedata.js';
import { plannableBonds, bondPlanOpen, bondPlanHolders } from '../../public/js/ui/bondPlan.js';
import { reservedBands } from '../../public/js/screens/bandDraft.js';

test('the plannable bonds are the server\'s: every core faction bond in data order, in every mode', () => {
  const ids = plannableBonds(Object.values(DATA.bonds)).map((b) => b.bondId);
  for (const modeId of ['mode_single_normal', 'mode_multi_normal', 'mode_multi_abyss']) {
    assert.deepEqual(ids, [...new GameData(DATA, modeId).plannableBondIds()], modeId);
  }
  assert.equal(ids.length, 8);
  assert.ok(ids.includes('lateranoShip') && !ids.includes('preciShip'));
  assert.deepEqual(plannableBonds(null), []);
});

test('the plan can change from 确认本局信息 until round 1\'s battle, as on the server', () => {
  for (const phase of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK]) assert.equal(bondPlanOpen({ phase, round: 0 }), true, phase);
  for (const phase of [PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP]) {
    assert.equal(bondPlanOpen({ phase, round: 1 }), true, `${phase} R1`);
    assert.equal(bondPlanOpen({ phase, round: 2 }), false, `${phase} R2`);
  }
  for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.SETTLE, PHASE.FINAL_ASSAULT, PHASE.RESULT]) assert.equal(bondPlanOpen({ phase, round: 1 }), false, phase);
  assert.equal(bondPlanOpen(null), false);
});

test('other players\' plans by bond, never the viewer\'s', () => {
  const players = [
    { playerId: 'me', name: 'A', bondPlan: 'yanShip' }, { playerId: 'p2', name: 'B', bondPlan: 'yanShip' },
    { playerId: 'p3', name: 'C', bondPlan: 'egirShip' }, { playerId: 'p4', name: 'D', bondPlan: null },
  ];
  assert.deepEqual([...bondPlanHolders(players, 'me')], [['yanShip', ['B']], ['egirShip', ['C']]]);
});

test('an AI\'s reserved strategy is taken until that AI picks; one reserved for the viewer never is', () => {
  const draft = { reserved: { band_a: 'ai_1', band_b: 'ai_2', band_c: 'me' } };
  const picks = new Map([['ai_2', 'band_b']]);
  assert.deepEqual([...reservedBands(draft, picks, 'me')], [['band_a', 'ai_1']]);
  assert.deepEqual([...reservedBands({}, new Map(), 'me')], []);
  assert.deepEqual([...reservedBands(null, new Map(), 'me')], []);
});
