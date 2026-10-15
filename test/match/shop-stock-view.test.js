// Shop displays reserve no stock (server/match/pool.js). Since 0.3.0 (#624) a card already shown stays purchasable when
// another player takes the last copies of its equipment: the purchase is recorded as debt (SharedItemPool.owe), the card
// is never marked — like an operator card since 0.2.5, which overdraws its pool (#498).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, checkInvariants } from './harness.js';
import { shopBlockReason } from '../../public/js/ui/gameLogic/shop.js';

const COIN = 'chess_item_1_03_e_a'; // 盟约之币

test('equipment whose stock another player took stays unmarked and purchasable, recorded as debt (#624)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 11, fake: true }).start().toPrep();
  const m = h.m, a = h.ps('p_0'), b = h.ps('p_1');
  const i = Math.max(0, a.shop.slots.findIndex(s => s && s.kind === 'item'));
  a.shop.slots[i] = { kind: 'item', id: COIN, basePrice: 1, frozen: false, sold: false };
  assert.ok(m.itemPool.canGain(COIN));
  a.funds = 99; m.markPrivate(a); m.flush();
  // the other player takes every remaining copy
  while (m.itemPool.canGain(COIN)) assert.ok(b.acquireItem(COIN, { source: 'test' }));
  m.markPrivate(b); m.flush();
  const view = h.lastTo('p_0', 'm.private');
  assert.equal(view.shop.slots[i].soldOut, undefined);
  assert.equal(shopBlockReason('buy', { priv: view, editable: true, slot: view.shop.slots[i] }), null);
  assert.ok(a.buy(i).ok, 'bought on the deficit');
  assert.ok(m.itemPool.debtOf(COIN) > 0, 'the stock records the debt');
  checkInvariants(m);
  m.dispose();
});

test('an operator card stays unmarked and purchasable after another player took its stock (#498)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 11, fake: true }).start().toPrep();
  const m = h.m, a = h.ps('p_0'), b = h.ps('p_1');
  const i = a.shop.slots.findIndex(s => s && s.kind === 'chess' && !s.sold);
  assert.ok(i >= 0);
  const id = a.shop.slots[i].id, base = m.gd.baseIdOf(id), pool = a.poolOf(base);
  assert.ok(pool.has(base) && pool.left(base) > 0);
  a.funds = 99; m.markPrivate(a); m.flush();
  pool.take(base, pool.left(base)); m.markPrivate(b); m.flush();
  assert.equal(pool.left(base), 0);
  const view = h.lastTo('p_0', 'm.private');
  assert.equal(view.shop.slots[i].soldOut, undefined);
  assert.equal(shopBlockReason('buy', { priv: view, editable: true, slot: view.shop.slots[i] }), null);
  assert.ok(a.buy(i).ok, 'bought on the deficit');
  assert.ok(pool.entries.get(base).left < 0, 'the pool records the debt');
  m.dispose();
});
