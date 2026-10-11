// GitHub #488: a named free grant (「<获得时>获得N件X」 特质, a strategy's fixed-round item, 画卷's copied equipment) is
// not refused by the shared shop-equipment stock — as in 0.2.2, and like an operator granted beyond stock (拟态物质). Its
// copies still occupy stock: the shop, reward offers and default grants keep the check, and ownership leaving never
// returns stock above the cap. Real registry and dispatcher (server/sim/content/garrisons/meta.js, bands/meta.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, checkInvariants, legalTileFor, DATA } from '../match/harness.js';
import { createRegistry } from '../../server/match/effectsMeta.js';

const QUIET = { warn() {}, error() {}, info() {} };
const REG = createRegistry({ log: QUIET });
const OK = { ok: true };
const ISO = 'chess_item_6_09_e_a'; // 变形同构体 (Ⅵ, shared stock 3)
const MUEL = 'chess_char_6_11_a'; // 缪尔赛思: garrison_76_a 获得1个 / elite garrison_76_b 获得2个
const STOCK_WARN = '装备库存不足，未获得该装备';

function setup({ seed = 70, band = null } = {}) {
  const h = makeMatch({ mode: 'solo', seed, registry: REG, fake: true }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
  ps.funds = 50; ps.layers = {}; ps.pendingFunds = 0; ps.shop.freeRefreshes = 0; ps.counters = {};
  ps.bandId = band;
  ps.recompute();
  const warns = [];
  const toast = m.toast.bind(m);
  m.toast = (who, kind, text) => { if (kind === 'warn') warns.push(text?.msgid ?? text); return toast(who, kind, text); };
  /** Put `id` into a shop slot and buy it through the protocol. */
  const buyItem = (id) => {
    const i = Math.max(0, ps.shop.slots.findIndex((s) => s?.kind === 'item'));
    ps.shop.slots[i] = { kind: 'item', id, basePrice: 1, sold: false, frozen: true };
    return m.handle('p_0', { t: 'g.buy', slot: i });
  };
  const roundStart = (r) => { m.round = r; m.dispatch(ps, 'onRoundStart', { round: r }); };
  const owned = (id) => [...ps.hand, ...ps.temp].filter((p) => p && p.kind === 'item' && m.gd.baseIdOf(p.id) === id);
  return { h, m, ps, warns, buyItem, roundStart, owned };
}

function muelsyseRun({ invest }) {
  const s = setup();
  const { m, ps } = s;
  assert.equal(m.itemPool.cap(ISO), 3);
  assert.equal(m.pool.cap(MUEL), 5, 'five 缪尔赛思 in a solo pool');
  if (invest) {
    ps.bondCountBonus.investShip = 20;
    ps.recompute();
    assert.equal(m.dispatcher.investRepeat(ps), 2, '投资人 active below 100 layers: 获得时 ×2');
  }
  const totals = [];
  for (let k = 0; k < 5; k++) {
    assert.ok(ps.acquireChess(MUEL, { source: 'test' }), `缪尔赛思 #${k + 1}`);
    totals.push(m.itemPool.held(ISO));
    checkInvariants(m);
  }
  return { ...s, totals };
}

test('#488 缪尔赛思 <获得时>: 变形同构体 keeps coming after the shared stock (3) is exhausted', () => {
  const { m, ps, warns, totals, owned } = muelsyseRun({ invest: false });
  // 1, 1, the third merges into the elite (获得2个), 1, 1
  assert.deepEqual(totals, [1, 2, 4, 5, 6]);
  assert.equal(owned(ISO).length, 6);
  assert.equal(m.itemPool.left(ISO), 0, 'the copies still occupy stock');
  assert.equal(owned(ISO).filter((p) => p.overStock).length, 3, 'only the copies beyond the cap are marked');
  assert.ok(!warns.includes(STOCK_WARN), 'no 「装备库存不足」 toast for a 特质');
  assert.ok(ps.allChess().some((c) => c.id === 'chess_char_6_11_b'));
});

test('#488 缪尔赛思 with 投资人 ×2: 2, 4, 8, 10, 12', () => {
  const { m, warns, totals, owned } = muelsyseRun({ invest: true });
  assert.deepEqual(totals, [2, 4, 8, 10, 12]);
  assert.equal(owned(ISO).length, 12);
  assert.equal(m.itemPool.left(ISO), 0);
  assert.ok(!warns.includes(STOCK_WARN));
});

test('#488 the shop and default grants still respect the stock while free-granted copies hold it', () => {
  const { m, ps, warns, buyItem, owned } = muelsyseRun({ invest: false });
  ps.funds = 20;
  const funds = ps.funds;
  assert.equal(buyItem(ISO).error, 'SOLD_OUT', 'a purchase is refused');
  assert.equal(ps.funds, funds, 'nothing charged');
  assert.equal(ps.acquireItem(ISO, { source: 'reward' }), null, 'a reward / choice grant (requirePool default) is refused');
  assert.ok(warns.includes(STOCK_WARN));
  assert.equal(ps.pushItemOffer([ISO]), null, 'no offer of an exhausted item');
  // ownership leaving: stock reappears only below the cap and never exceeds it
  const left = [];
  for (const p of owned(ISO)) { assert.deepEqual(ps.destroy(p.uid), OK); left.push(m.itemPool.left(ISO)); checkInvariants(m); }
  assert.deepEqual(left, [0, 0, 0, 1, 2, 3]);
  assert.deepEqual(buyItem(ISO), OK, 'buyable again once a copy is free');
  assert.equal(owned(ISO).at(-1).overStock, undefined, 'a purchase is never marked');
  checkInvariants(m);
});

test('#488 变形者集群: the round 5 / 10 / 15 变形同构体 arrive with the stock already exhausted', () => {
  const { m, ps, warns, roundStart, buyItem, owned } = setup({ seed: 5, band: 'band_damaztic' });
  for (let k = 0; k < 3; k++) assert.deepEqual(buyItem(ISO), OK, `purchase ${k + 1}`);
  assert.equal(m.itemPool.left(ISO), 0);
  assert.equal(buyItem(ISO).error, 'SOLD_OUT');
  const got = [];
  for (let r = 1; r <= 15; r++) { roundStart(r); if (owned(ISO).length > 3 + got.length) got.push(r); }
  assert.deepEqual(got, [5, 10, 15]);
  assert.equal(m.itemPool.held(ISO), 6);
  assert.equal(m.itemPool.left(ISO), 0);
  assert.ok(!warns.includes(STOCK_WARN));
  checkInvariants(m);
  assert.equal(ps.bandId, 'band_damaztic');
});

test('#488 画卷 copies the equipment of its target beyond the stock, like the operator', () => {
  const { m, ps, warns } = setup({ seed: 8 });
  const cid = Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier === 2
    && (c.garrisonIds || []).every((g) => DATA.garrisons[g].eventType === 'IN_BATTLE')).chessId;
  const at = legalTileFor(m, ps, cid);
  const target = give(m, ps, cid, 'board', at);
  for (let k = 0; k < 3; k++) assert.ok(ps.acquireItem(ISO));
  const worn = ps.hand.find((p) => p && p.id === ISO);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: worn.uid, targetUid: target.uid }), OK);
  assert.equal(m.itemPool.left(ISO), 0);
  const art = giveItem(m, ps, 'chess_item_6_02_m');
  assert.deepEqual(m.handle('p_0', { t: 'g.art', itemUid: art.uid, row: at[0], col: at[1] }), OK);
  assert.equal([...ps.hand, ...ps.temp].filter((p) => p && p.id === ISO).length, 3, 'the copied 变形同构体 is in the hand');
  assert.equal(m.itemPool.held(ISO), 4);
  assert.ok(!warns.includes(STOCK_WARN));
  checkInvariants(m);
});

test('#488 elite 佩佩 draws only items with stock left (the normal draw already did)', () => {
  const COIN = 'chess_item_1_03_e_a', TEA = 'chess_item_2_04_e_a', COMPASS = 'chess_item_6_07_e_a';
  for (let seed = 1; seed <= 4; seed++) {
    const { m, ps, warns, roundStart } = setup({ seed });
    for (const id of [COIN, TEA]) while (m.itemPool.canGain(id)) assert.ok(ps.acquireItem(id));
    give(m, ps, 'chess_char_6_06_b', 'board', legalTileFor(m, ps, 'chess_char_6_06_b'));
    roundStart(1);
    assert.equal(m.itemPool.held(COMPASS), 2, `seed ${seed}: both draws give 黄沙罗盘`);
    assert.ok(!warns.includes(STOCK_WARN), `seed ${seed}`);
    checkInvariants(m);
  }
});
