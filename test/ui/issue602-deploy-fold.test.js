// Public issue #602: "[Feature] 操作体验优化：部署干员、装备时棋盘缩放". 0.3.0 took PR #646: picking a piece up on the
// own prep board (and a legal drop's direction wheel) folded the shop and zoomed the board to issue #5's
// shop-collapsed camera. The owner removed it on 2026-10-16 (「移除准备期拖动部署干员时的自动地图缩放」): a drag and the
// direction wheel leave the shop bar and the camera as the player set them. What the 0.3.0 port added on top of the PR
// stays — setCam remembers a framing without its flight time, and a drag follows any camera flight under it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const gameLogic = await import('../../public/js/ui/gameLogic.js');
const { foldCamera } = gameLogic;

// ---- the choice: nothing folds or zooms for a drag ------------------------------------------------------------------

describe('a deploy interaction leaves the shop and the camera alone (the owner\'s decision of 2026-10-16)', () => {
  const pl = (id, seat) => ({ playerId: id, seat, alive: true });
  const pub = { round: 6, bossRound: 14, hiddenRound: 15, players: [pl('a', 0), pl('b', 1)] };
  const shopCam = { kind: 'prep', opts: { rect: { ...GEO.NORMAL_RECT }, side: 'L' } };

  test('gameLogic no longer offers the deploy fold', () => {
    assert.equal('deployFoldsShop' in gameLogic, false);
  });

  test('while a piece is carried or its direction is chosen no camera is requested, folded shop or not', () => {
    for (const folded of [false, true]) {
      const s = { pub, myId: 'a', ownPrep: true, folded, current: shopCam };
      assert.equal(foldCamera({ ...s, busy: true }), null, `folded=${folded}: a drag / the wheel defers any fold`);
    }
    // with the shop open and nothing carried, the shop camera in use is already right: nothing to fly
    assert.equal(foldCamera({ pub, myId: 'a', ownPrep: true, folded: false, current: shopCam }), null);
  });
});

// ---- the wiring (screens/game.js) ---------------------------------------------------------------------------------

describe('game.js wiring', () => {
  const game = read('public/js/screens/game.js');

  test('the shop state is the player\'s own (or the pen\'s): no temporary deploy fold', () => {
    assert.doesNotMatch(game, /deployFold|barCollapsed|deployFoldsShop/);
    assert.match(game, /const shopFolded = showShop && \(pen \? penRef\.current\.collapsed : collapsed\);/);
    assert.match(game, /const shopOpen = showShop && !collapsed;/);
    assert.match(game, /drag && 'is-dragging', collapsed && 'is-collapsed',/);
    assert.match(game, /<\$\{ShopBar\}[^\n]*collapsed=\$\{collapsed\}[^\n]*onCollapse=\$\{setCollapsed\}/);
    assert.match(game, /<\$\{RewardOverlay\} priv=\$\{priv\} minimized=\$\{rewardMin \|\| collapsed\}/);
  });

  test('the camera effect only follows a hand-made fold, deferred while a piece is carried', () => {
    assert.match(game, /useEffect\(\(\) => \{\n\s+const next = foldCamera\(\{\n\s+pub, myId, folded: shopFolded, ownPrep: !!view && viewModeRef\.current === 'prep' && showPrep,\n\s+pen, busy: !!drag \|\| !!facing, current: camRef\.current,\n\s+\}\);\n\s+if \(next\) setCam\(next\.kind, \{ \.\.\.next\.opts, ms: FOLD_CAMERA_MS \}\);\n\s+\}, \[view, shopFolded, showPrep, pen, !!drag, !!facing, prepCamKey\]\);/);
    assert.equal((game.match(/ms: FOLD_CAMERA_MS/g) || []).length, 1, 'the 收起 / 展开 flight only');
  });
});

// ---- the 0.3.0 port: what the merge added on top of the PR (kept) ----------------------------------------------------

describe('0.3.0 port of PR #646 (kept after the removal)', () => {
  const game = read('public/js/screens/game.js');
  const app = read('public/js/render/app.js');

  test('the camera the pen returns to is remembered without its flight time (a fold\'s 350 ms is not replayed)', () => {
    // togglePen(false) repeats camRef's opts: with `ms: FOLD_CAMERA_MS` kept there, the way back from the pen after a
    // 收起 flew 350 ms instead of the pen's own 0.25 s (render/app.js PEN_CAMERA_MS)
    assert.match(game, /const setCam = useCallback\(\(kind, opts\) => \{[\s\S]{0,400}?const \{ ms: _ms, instant: _instant, \.\.\.framing \} = opts \|\| \{\};\n\s+camRef\.current = \{ kind, opts: framing \};/);
    assert.match(game, /const c = camRef\.current;\n\s+view\.setCamera\(c\.kind, c\.opts\);/, 'the pen\'s way back repeats the remembered framing');
  });

  test('a drag under a still pointer follows a camera flight: the view judges it again every flying frame', () => {
    assert.match(app, /const flying = !!camTo;\n\s+stepCamera\(now\);\n[\s\S]{0,300}?if \(flying && mode === 'prep' && drag\.dragging\) drag\.refresh\(\);/);
  });
});
