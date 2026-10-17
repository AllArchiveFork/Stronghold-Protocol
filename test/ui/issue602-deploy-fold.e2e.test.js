// Browser check that deploying leaves the shop bar and the camera alone (GitHub #602's deploy fold, removed by the
// owner on 2026-10-16), on the in-match mock harness:
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/issue602-deploy-fold.e2e.test.js
//
// On the own prep board (DOM fallback field), picking up a hand piece — an operator or equipment — keeps the player's
// 收起/展开 state (the screen's `is-collapsed`, the 展开商店 tab) through the drag and the dropped operator's direction
// wheel. On the render engine the camera holds still through the pickup and the drop target is the tile under the
// resting finger.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('deploying a piece leaves the shop and the camera as they are (#602 removed)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  /** Open the mock PREP match with a free deploy slot (one board operator sold, like facing.e2e.test.js). */
  async function openPage(viewport) {
    const page = await browser.newPage();
    if (viewport) await page.setViewport(viewport);
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${base}/dev/game-mock.html?shot=1&render=fallback&phase=PREP`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('.ff-piece');
    const initial = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__MOCK__.S().priv)));
    const sell = initial.board.find((p) => p.kind === 'chess' && !p.golden);
    await page.click(`.ff-piece[data-uid="${sell.uid}"]`);
    await page.waitForSelector('.uframe__btn--sell');
    await page.click('.uframe__btn--sell');
    await page.waitForFunction((uid) => !globalThis.__MOCK__.S().priv.board.some((p) => p.uid === uid), {}, sell.uid);
    const ready = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__MOCK__.S().priv)));
    const chess = ready.hand.find((p) => p?.kind === 'chess');
    const item = ready.hand.find((p) => p?.kind === 'item');
    const tile = [[9, 9], [9, 8], [12, 6], [11, 7], [10, 7], [9, 7]].find(([r, c]) => !ready.board.some((p) => p.row === r && p.col === c));
    assert.ok(chess && item && tile, 'a hand operator, a hand item and a free tile exist');
    const center = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const folded = () => page.evaluate(() => ({
      cls: document.querySelector('.gm')?.classList.contains('is-collapsed') ?? null,
      tab: !!document.querySelector('.shopbar-tab'),
    }));
    /** Press the piece and nudge it: the drag starts (facing.e2e.test.js uses the same gesture). */
    const pickup = async (piece) => {
      const from = await center(`.ff-piece[data-uid="${piece.uid}"]`);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y, { steps: 4 });
      await sleep(120);
    };
    const cancelDrag = async () => { await page.mouse.up(); await sleep(200); };
    const dropOn = async (row, col) => {
      const to = await center(`.ff-tile[data-row="${row}"][data-col="${col}"]`);
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await sleep(80);
      await page.mouse.up();
    };
    return { page, problems, chess, item, tile, folded, pickup, cancelDrag, dropOn };
  }

  test('picking up an operator keeps the shop open, or folded when the player folded it (phone viewport)', async () => {
    const h = await openPage({ width: 390, height: 844 });
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'the shop starts open');

    await h.pickup(h.chess);
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'the shop stays open while the operator is carried');
    await h.cancelDrag();
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'and after a cancelled drag');

    // the player folds by hand: a drag does not undo it
    await h.page.click('.funds__collapse');
    await h.page.waitForSelector('.shopbar-tab');
    await h.pickup(h.chess);
    assert.deepEqual(await h.folded(), { cls: true, tab: true }, 'folded by hand, then picked up: still folded');
    await h.cancelDrag();
    assert.deepEqual(await h.folded(), { cls: true, tab: true }, 'the hand-made fold survives the cancelled drag');
    await h.page.click('.shopbar-tab__btn');
    await sleep(200);

    assert.deepEqual(h.problems, []);
    await h.page.close();
  });

  test('the shop stays open through the direction wheel and after it is cancelled', async () => {
    const h = await openPage({ width: 1600, height: 900 });
    await h.pickup(h.chess);
    assert.equal((await h.folded()).cls, false, 'open on pickup');
    await h.dropOn(...h.tile);
    await h.page.waitForSelector('.fwheel__dia', { timeout: 5000 });
    await sleep(200);
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'the direction wheel leaves the shop open');
    await h.page.keyboard.press('Escape');
    await h.page.waitForFunction(() => !document.querySelector('.fwheel'));
    await sleep(200);
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'still open after the wheel');
    assert.deepEqual(h.problems, []);
    await h.page.close();
  });

  // on the render engine: the camera holds still through the pickup, the drop target is the tile under the resting
  // finger, and the wheel / the end of the drag leave the exact shop camera.
  test('engine (touch): the pickup does not move the camera, the target is the tile under the resting finger', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, hasTouch: true });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${base}/dev/game-mock.html?shot=1&phase=PREP`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.raw?.stats?.().mode === 'prep', { timeout: 30000 });
    await sleep(1500);
    const cam = () => page.evaluate(() => JSON.stringify(globalThis.__SP_VIEW__.raw.debug.cam.params()));
    const shopCam = await cam();
    const priv = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__MOCK__.S().priv)));
    const chess = priv.hand.find((p) => p?.kind === 'chess');
    const from = await page.evaluate((uid) => { const r = globalThis.__SP_VIEW__.pieceScreenRect(uid); return r && { x: r.left + r.width / 2, y: r.top + r.height * 0.7 }; }, chess.uid);
    // where the pointer comes to rest: board tile (10, 6) as the shop camera shows it
    const P = await page.evaluate(() => { const t = globalThis.__SP_VIEW__.tileScreen(10, 6); return { x: t.x, y: t.y }; });
    assert.ok(from && P, 'the hand piece and the tile are on screen');
    const t = page.touchscreen;
    await t.touchStart(from.x, from.y);
    // one move: the drag starts with the finger already on P (its target judged under the shop camera), then it rests
    await t.touchMove(P.x, P.y);
    await sleep(800); // longer than a fold flight (FOLD_CAMERA_MS): nothing may fly
    const s = await page.evaluate((P, uid) => {
      const d = globalThis.__SP_VIEW__.raw.debug;
      const rect = d.app.view.getBoundingClientRect();
      const g = d.pick.groundTile(P.x - rect.left, P.y - rect.top);
      const v = d.views.get('p:' + uid);
      return {
        under: g ? [g.row, g.col] : null, target: d.tiles.highlights.get('dragTarget')?.tiles?.[0] || null,
        stands: v ? [Math.round(v.y), Math.round(v.x)] : null, dragging: d.drag.dragging,
        folded: document.querySelector('.gm')?.classList.contains('is-collapsed') ?? null, cam: JSON.stringify(d.cam.params()),
      };
    }, P, chess.uid);
    assert.equal(s.dragging, true);
    assert.equal(s.folded, false, 'the shop stays open');
    assert.equal(s.cam, shopCam, 'the camera did not move');
    assert.deepEqual(s.under, [10, 6], 'the board did not move under the resting finger');
    assert.deepEqual(s.target, s.under, 'the drop target is the tile under the finger');
    await t.touchEnd();
    await sleep(400);
    if (await page.$('.fwheel')) {
      assert.equal(await cam(), shopCam, 'the wheel does not zoom either');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.fwheel'));
    }
    await sleep(700);
    assert.equal(await cam(), shopCam, 'back on exactly the shop camera');
    assert.equal(await page.evaluate(() => document.querySelector('.gm')?.classList.contains('is-collapsed')), false);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('picking up equipment keeps the shop open too', async () => {
    const h = await openPage({ width: 1600, height: 900 });
    await h.pickup(h.item);
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'equipment pickup leaves the shop open');
    await h.cancelDrag();
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'released without equipping: still open');
    assert.deepEqual(h.problems, []);
    await h.page.close();
  });
});
