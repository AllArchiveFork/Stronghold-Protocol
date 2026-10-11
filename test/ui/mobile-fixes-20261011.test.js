// Pure helpers behind the 2026-10-11 mobile fixes: the folded roster's emote strip (ui/teamPanel.js foldedEmotes) and
// the side the lobby's 更多 menu opens toward (screens/lobby.js toolsMenuSide). Layout is checked in the browser
// (test/ui/multiplayer-mobile.e2e.test.js, test/ui/emotes.e2e.test.js; SP_E2E=1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOLDED_EMOTES, foldedEmotes } from '../../public/js/ui/teamPanel.js';
import { toolsMenuSide } from '../../public/js/screens/lobby.js';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const players = ['a', 'b', 'c', 'd', 'e', 'f'].map((playerId, seat) => ({ playerId, seat, name: playerId.toUpperCase() }));

test('a folded roster shows the newest senders first, at most four, only seats still in the match', () => {
  const bubbles = new Map([['a', { id: 'x', seq: 3 }], ['b', { id: 'y', seq: 9 }], ['gone', { id: 'z', seq: 10 }],
    ['c', { id: 'x', seq: 5 }], ['d', { id: 'x', seq: 1 }], ['e', { id: 'x', seq: 7 }]]);
  const shown = foldedEmotes(bubbles, players);
  assert.equal(FOLDED_EMOTES, 4);
  assert.deepEqual(shown.map(row => [row.player.playerId, row.bubble.seq]), [['b', 9], ['e', 7], ['c', 5], ['a', 3]]);
  assert.deepEqual(foldedEmotes(bubbles, players, 1).map(row => row.player.playerId), ['b']);
  assert.deepEqual(foldedEmotes(new Map(), players), []);
  assert.deepEqual(foldedEmotes(null, players), []);
  assert.deepEqual(foldedEmotes(bubbles, []), []);
});

test('the emote strip is rendered outside the folded roster and the rows keep their bubbles inside on phones', () => {
  const panel = source('../../public/js/ui/teamPanel.js');
  assert.ok(panel.indexOf('class="team__emotes"') < panel.indexOf('class="team__players"'), 'strip precedes the hidden roster');
  assert.match(panel, /rosterOpen \? null : html`<div class="team__emotes">/);
  assert.match(source('../../public/css/screens/game.css'), /\.team__emotes \{[^}]*--ebubble-unit/);
  assert.match(source('../../public/css/devices.css'), /\.gm \.team:not\(\.team--expanded\) \.team__bubble \{ left: auto; right: 4px; \}/);
});

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

test('the fullscreen button sits in the lobby toolbar (its left group, so portrait phones keep one row of tools), outside 更多', () => {
  const lobby = source('../../public/js/screens/lobby.js');
  const button = lobby.indexOf('<${FullscreenButton} class="lobby-fullscreen"');
  assert.ok(button > lobby.indexOf('<div class="topbar__left">') && button < lobby.indexOf('<div class="topbar__center">'));
  const menu = lobby.indexOf('<div class="lobby-tools__menu">');
  const menuEnd = lobby.indexOf('</details>', menu);
  assert.ok(button > 0 && menu > 0 && menuEnd > menu);
  assert.ok(button < menu, 'fullscreen precedes the menu');
  assert.equal(lobby.slice(menu, menuEnd).includes('FullscreenButton'), false);
  assert.match(source('../../public/css/screens/lobby.css'), /\.lobby-tools--start \.lobby-tools__menu \{ left: 0; right: auto; \}/);
});
