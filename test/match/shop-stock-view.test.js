// Shop displays reserve no stock (server/match/pool.js): when another player takes the last copies of the equipment on a
// player's shop card, that player's m.private is re-sent with the card marked `soldOut` (economy.js outOfStock,
// messaging.js _markStockChanges), the bar refuses it as 库存不足 before any request, and the server still refuses it.
// An operator card is never marked: since 0.2.5 one already shown stays purchasable and overdraws its pool (#498).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, checkInvariants } from './harness.js';
import { shopBlockReason } from '../../public/js/ui/gameLogic/shop.js';

const COIN = 'chess_item_1_03_e_a'; // 盟约之币

test('equipment whose stock another player took is marked on the card, refused, and re-sent to its shop owner', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 11, fake: true }).start().toPrep();
  const m = h.m, a = h.ps('p_0'), b = h.ps('p_1');
  const i = Math.max(0, a.shop.slots.findIndex(s => s && s.kind === 'item'));
  a.shop.slots[i] = { kind: 'item', id: COIN, basePrice: 1, frozen: false, sold: false };
  assert.ok(m.itemPool.canGain(COIN));
  a.funds = 99; m.markPrivate(a); m.flush();
  const before = h.allTo('p_0', 'm.private').length;
  assert.equal(h.lastTo('p_0', 'm.private').shop.slots[i].soldOut, undefined, 'in stock: no flag');
  // the other player takes every remaining copy; nothing of p_0's own state changes
  const taken = [];
  while (m.itemPool.canGain(COIN)) taken.push(b.acquireItem(COIN, { source: 'test' }));
  m.markPrivate(b); m.flush();
  assert.equal(h.allTo('p_0', 'm.private').length, before + 1, "p_0's m.private is re-sent");
  const view = h.lastTo('p_0', 'm.private');
  assert.equal(view.shop.slots[i].soldOut, true);
  assert.equal(shopBlockReason('buy', { priv: view, editable: true, slot: view.shop.slots[i] }), '库存不足');
  const money = a.funds;
  assert.equal(a.buy(i).error, 'SOLD_OUT'); assert.equal(a.funds, money); assert.equal(a.shop.slots[i].sold, false);
  m.markPrivate(b); m.flush();
  assert.equal(h.allTo('p_0', 'm.private').length, before + 1, 'unchanged flags: nothing more is sent');
  const back = taken.find(p => p && b.find(p.uid));
  assert.deepEqual(b.destroy(back.uid), { ok: true }); m.markPrivate(b); m.flush();
  assert.equal(h.lastTo('p_0', 'm.private').shop.slots[i].soldOut, undefined, 'stock back: unmarked again');
  assert.ok(a.buy(i).ok);
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
