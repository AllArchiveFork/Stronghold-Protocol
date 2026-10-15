// The in-match notice line (public/js/ui/matchNotice.js; fork 2026-10-16): maintenance first, else the newest
// announcement's banner, and it is mounted only on the match route, with its own place under the in-match top bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchNoticeText, replayingRound, MATCH_NOTICE_REFRESH_MS } from '../../public/js/ui/matchNotice.js';

test('maintenance outranks the announcement banner; no line without either', () => {
  const notices = [{ title: 'x', paragraphs: ['y'], banner: ' 今晚 0:00 起维护 ' }];
  assert.equal(matchNoticeText({ maintenance: true }, notices), '服务器即将维护，暂停开启新的模拟');
  assert.equal(matchNoticeText(null, notices), '今晚 0:00 起维护');
  assert.equal(matchNoticeText({ maintenance: false }, [{ title: 'x', paragraphs: ['y'] }]), null);
  assert.equal(matchNoticeText(null, [{ title: 'x', paragraphs: ['y'], banner: 'x'.repeat(161) }]), null);
  assert.equal(matchNoticeText(null, null), null);
  assert.ok(MATCH_NOTICE_REFRESH_MS >= 60_000, 'no more often than the lobby');
});

test('a round restored from its prep end says so first, during that prep only', () => {
  const notices = [{ title: 'x', paragraphs: ['y'], banner: '今晚 0:00 起维护' }];
  const replay = '服务器重启后已恢复对局：本回合回到休整期，战斗将重新进行';
  assert.equal(matchNoticeText({ maintenance: true }, notices, { replay: true }), replay);
  assert.equal(matchNoticeText({ maintenance: true }, notices, { replay: false }), '服务器即将维护，暂停开启新的模拟');
  assert.equal(replayingRound({ phase: 'PREP', round: 4, replayRound: 4 }), true);
  for (const pub of [null, undefined, { phase: 'PREP', round: 4 }, { phase: 'COMBAT', round: 4, replayRound: 4 },
    { phase: 'PREP', round: 5, replayRound: 4 }, { phase: 'PREP', round: 0, replayRound: 0 }, { phase: 'PREP', round: 4, replayRound: '4' }]) {
    assert.equal(replayingRound(pub), false, JSON.stringify(pub));
  }
  const main = fs.readFileSync('public/js/main.js', 'utf8');
  assert.match(main, /useStore\(\(s\) => replayingRound\(s\.match\?\.public\)\)/);
  assert.match(main, /data\.get\('announcements'\), \{ replay \}\)/);
  for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
    assert.ok(JSON.parse(fs.readFileSync(`public/i18n/${lang}.json`, 'utf8'))[replay], lang);
  }
});

test('mounted on the match route only; placed under the in-match top bar and the connection banner', () => {
  const main = fs.readFileSync('public/js/main.js', 'utf8');
  assert.match(main, /route === 'game' \? html`<\$\{MatchNoticeHost\} \/>` : null/);
  assert.match(main, /function MatchNoticeHost\(\) \{\n  useData\('announcements'\);/, 'the optional file is loaded outside the match UI');
  const css = fs.readFileSync('public/css/components.css', 'utf8');
  for (const rule of ['.sp-in-match .match-notice', '.sp-in-match.sp-conn .match-notice', '.sp-in-match.sp-notice .toast-host']) assert.ok(css.includes(rule), rule);
  assert.match(css, /\.match-notice \{[^}]*pointer-events: none;/, 'the line never takes the board\'s input');
  assert.match(css, /\.match-notice \{\n  display: none;/, 'not on the briefing / draft screens');
  assert.ok(css.includes('.sp-in-match .match-notice { display: flex;'), 'the match screen shows it');
  assert.match(css, /\.match-notice__close \{[^}]*pointer-events: auto;/);
});
