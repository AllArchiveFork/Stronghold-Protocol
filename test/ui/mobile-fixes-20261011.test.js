// Pure helpers behind the 2026-10-11 mobile fixes: the side the lobby's 更多 menu opens toward (screens/lobby.js
// toolsMenuSide). Layout is checked in the browser (test/ui/multiplayer-mobile.e2e.test.js; SP_E2E=1). The folded
// roster's emotes became danmaku: test/ui/team-roster.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolsMenuSide } from '../../public/js/screens/lobby.js';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');

test('the 更多 menu opens leftward while that fits, rightward from a left-edge button, else toward the larger side', () => {
  assert.equal(toolsMenuSide({ left: 1700, right: 1780 }, 180, 1920), 'end');
  assert.equal(toolsMenuSide({ left: 16, right: 86 }, 180, 360), 'start'); // portrait phone: the button sits on the left
  assert.equal(toolsMenuSide({ left: 186, right: 196 }, 180, 400), 'end');
  assert.equal(toolsMenuSide({ left: 40, right: 90 }, 180, 200), 'start'); // neither fits: more room to the right
  assert.equal(toolsMenuSide({ left: 120, right: 170 }, 180, 200), 'end'); // neither fits: more room to the left
  for (const bad of [null, undefined]) assert.equal(toolsMenuSide(bad, 180, 360), 'end');
  assert.equal(toolsMenuSide({ left: 16, right: 86 }, 0, 360), 'end');
  assert.equal(toolsMenuSide({ left: 16, right: 86 }, 180, 0), 'end');
});

test('the fullscreen button sits in the lobby toolbar (right group, before 更多), outside 更多; 更多 closes on a choice and outside', () => {
  const lobby = source('../../public/js/screens/lobby.js');
  const button = lobby.indexOf('<${FullscreenButton} class="lobby-fullscreen"');
  assert.ok(button > lobby.indexOf('<div class="topbar__right">'));
  const menu = lobby.indexOf('<div class="lobby-tools__menu"');
  const menuEnd = lobby.indexOf('</details>', menu);
  assert.ok(button > 0 && menu > 0 && menuEnd > menu);
  assert.ok(button < menu, 'fullscreen precedes the menu');
  assert.equal(lobby.slice(menu, menuEnd).includes('FullscreenButton'), false);
  assert.equal(lobby.slice(menu, menuEnd).includes('openStats'), false, 'the avatar is the one 统计数据 entry');
  assert.match(lobby, /addEventListener\('pointerdown', onPress, true\)/);
  assert.match(lobby, /if \(e\.target\.closest\('button'\)\) closeTools\(\)/);
  assert.match(source('../../public/css/screens/lobby.css'), /\.lobby-tools--start \.lobby-tools__menu \{ left: 0; right: auto; \}/);
});

test('the lobby reads in step order: 01 模拟方式, 02 模拟难度, 03 出发, 04 加入同盟', () => {
  const lobby = source('../../public/js/screens/lobby.js');
  const at = (n) => lobby.indexOf(`<span class="section-label__idx num">${n}</span>`);
  assert.ok(at('01') > 0 && at('01') < at('02') && at('02') < at('03') && at('03') < at('04'));
  assert.ok(lobby.indexOf('class="create-box"') > at('03') && lobby.indexOf('class="create-box"') < at('04'));
  const css = source('../../public/css/screens/lobby.css');
  assert.match(css, /\.lobby-step--go \{ position: sticky; bottom:/, 'portrait: 出发 stays on the bottom edge');
  assert.match(css, /\.lobby-screen \.join-row \.field--code \.field__input \{ font-size: max\(\.34rem, 16px\); \}/, 'no iOS focus zoom');
});
