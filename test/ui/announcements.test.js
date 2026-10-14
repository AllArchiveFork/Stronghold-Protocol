import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAnnouncements, announcementRevision, announcementDismissed, dismissAnnouncement } from '../../public/js/ui/announcements.js';
import { createDataStore } from '../../public/js/data.js';

const notice = () => ({ title: '本地测试公告', date: '2026-10-05', paragraphs: ['第一段。', '第二段\n保留换行。'] });
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('announcement list preserves editorial order, optional date, text and input isolation', () => {
  const first = notice(), second = { title: '无日期测试', paragraphs: ['<img src=x onerror="alert(1)">'] };
  Object.freeze(first.paragraphs); Object.freeze(first); Object.freeze(second.paragraphs); Object.freeze(second);
  const input = Object.freeze([first, second]);
  const entries = parseAnnouncements(input);
  assert.deepEqual(entries, [{ ...first }, { ...second, date: '' }]);
  assert.notEqual(entries[0], first); assert.notEqual(entries[0].paragraphs, first.paragraphs);
  entries[0].paragraphs.push('只改变返回值'); assert.equal(first.paragraphs.length, 2);
  assert.deepEqual(parseAnnouncements([]), []);
});

test('invalid or oversized announcements are unavailable, never truncated or disguised as empty', () => {
  for (const value of [null, {}, 'text', [null], [{ ...notice(), title: ' ' }], [{ ...notice(), date: 1 }],
    [{ ...notice(), paragraphs: [] }], [{ ...notice(), paragraphs: [' '] }], [{ ...notice(), paragraphs: [1] }],
    [{ ...notice(), title: 'x'.repeat(121) }], [{ ...notice(), date: 'x'.repeat(41) }],
    [{ ...notice(), paragraphs: ['x'.repeat(10001)] }], [{ ...notice(), paragraphs: Array(41).fill('p') }],
    Array(51).fill(notice()), [{ ...notice(), paragraphs: Array(21).fill('x'.repeat(10000)) }]]) {
    assert.equal(parseAnnouncements(value), null, JSON.stringify(value).slice(0, 100));
  }
});

test('announcement content revision is stable, and title/date/text/order updates create a new unread revision', async () => {
  const a = notice(), version = await announcementRevision([a]);
  assert.equal(await announcementRevision([{ paragraphs: a.paragraphs, date: a.date, title: a.title }]), version);
  assert.equal(announcementDismissed(version), false);
  dismissAnnouncement(version);
  assert.equal(announcementDismissed(version), true);
  for (const changed of [{ ...a, title: a.title + '更新' }, { ...a, date: '2026-10-06' }, { ...a, paragraphs: ['更新正文'] }, { ...a, paragraphs: [...a.paragraphs].reverse() }]) {
    const next = await announcementRevision([changed]);
    assert.notEqual(next, version); assert.equal(announcementDismissed(next), false);
  }
  assert.equal(await announcementRevision([]), null);
  assert.equal(await announcementRevision({}), null);
  const fallback = await announcementRevision([a], null);
  assert.equal(fallback, await announcementRevision([a], null));
  assert.notEqual(fallback, await announcementRevision([{ ...a, title: '不同内容' }], null));
});

test('announcement acknowledgement remains effective in-page when browser storage is blocked', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try {
    const version = await announcementRevision([{ title: '无存储测试', paragraphs: ['仍可关闭'] }]);
    dismissAnnouncement(version); assert.equal(announcementDismissed(version), true);
    assert.equal(announcementDismissed(await announcementRevision([notice()])), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage;
  }
});

test('announcement data reuses same-origin optional loading, request deduplication and explicit retry', async () => {
  const calls = [];
  const store = createDataStore({ retryDelays: [], fetch: async (url, opts) => {
    calls.push({ url, cache: opts.cache });
    return calls.length === 1 ? { ok: false, status: 404 } : { ok: true, json: async () => [notice()] };
  } });
  const a = store.load('announcements'), b = store.load('announcements');
  assert.equal(a, b); assert.equal(store.status('announcements'), 'loading');
  assert.equal(await a, null); assert.equal(store.status('announcements'), 'missing');
  assert.deepEqual(await store.invalidate('announcements'), [notice()]);
  assert.equal(store.status('announcements'), 'ready');
  assert.deepEqual(calls, [{ url: '/data/announcements.json', cache: 'no-cache' }, { url: '/data/announcements.json', cache: 'no-cache' }]);
});

test('shipped announcement data validates; optional board is mounted from the lobby only', () => {
  assert.notEqual(parseAnnouncements(JSON.parse(source('../../data/announcements.json'))), null);
  const lobby = source('../../public/js/screens/lobby.js'), board = source('../../public/js/ui/announcements.js');
  assert.match(lobby, /overlay === 'announcements' \? html`<\$\{LobbyAnnouncements\}/);
  assert.match(lobby, /function LobbyAnnouncements\([\s\S]*?useData\('announcements'\)/);
  assert.match(lobby, /data\.status\('announcements'\)/);
  assert.doesNotMatch(board, /useData\(|data\.(?:get|status|load|invalidate)\(/);
  assert.match(board, /暂无公告/); assert.match(board, /暂时无法显示公告/); assert.match(board, /正在读取公告/);
  assert.match(lobby, /data\.invalidate\('announcements'\)/);
  assert.match(board, /onClick=\$\{onRetry\}/);
  assert.doesNotMatch(board, /dangerouslySetInnerHTML|innerHTML|setInterval|net\.request/);
  assert.match(board, /ariaLabel=\$\{t\('大厅公告板'\)\} trapFocus=\$\{true\}/);
});

test('today is one notice: the new interface with its design credit, what it adds where, the access rule live since 10-13 and the maintenance; the introduction is retained with the credit and a first-visit guide', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, '新版界面上线：大厅、房间与干员调配全新改版');
  assert.equal(entries[1].title, '欢迎游玩卫戍协议！卫来！');
  assert.equal(entries[1].date, '2026-10-06');
  const today = entries[0].paragraphs.join('\n');
  for (const phrase of ['Bilibili@雨千代chiyo', '请刷新页面重新进入', '成就统计', '名片干员', '名片底图', '大厅音乐', '只保存在本机', '卡片视图',
    '「异形屏适配」', '「实验性选项」', '多人匹配', '只向中国大陆网络开放']) assert.ok(today.includes(phrase), phrase);
  assert.doesNotMatch(today, /保证不卡顿|带宽无限|固定比例下降|会话重置.*已修复|正在进行服务器扩容|不[^。；]{0,100}，也不/);
  assert.match(entries[1].paragraphs.join('\n'), /纯公益.*非官方/);
  assert.match(entries[1].paragraphs.join('\n'), /github\.com\/sganggs\/Stronghold-Protocol/);
  assert.match(entries[1].paragraphs.join('\n'), /界面致谢：.*Bilibili@雨千代chiyo/);
  assert.match(entries[1].paragraphs.join('\n'), /第一次来的博士：.*「玩法说明」/);
  // the owner asked for a fuller notice on 2026-10-14 (was < 800): the board scrolls, but the two together stay readable
  assert.ok(entries.flatMap(entry => entry.paragraphs).join('\n').length < 1600, 'the notices stay readable');
});

test('announcements omit contacts and infrastructure; the lobby owns the copyable group number', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  const text = entries.flatMap(entry => entry.paragraphs).join('\n');
  // the one contact a notice carries is the interface author's (the owner's request of 2026-10-14); the group number stays the lobby's
  assert.deepEqual([...text.matchAll(/QQ\s*(\d+)/g)].map(m => m[1]), ['374360968']);
  assert.doesNotMatch(text.replace('QQ 374360968', ''), /QQ|群号|243859707|815818430|2225664821|coordinator|ingress|Worker|WireGuard|ModelScope|OpenI|\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  assert.match(source('../../public/js/ui/lobbyFeedback.js'), /FEEDBACK_GROUP = '243859707'/);
});

test('topmost modal traps and restores focus and compact matching explains room-owned experimental rules', () => {
  const modal = source('../../public/js/ui/components.js'), matching = source('../../public/js/ui/matchmaking.js');
  const experimental = source('../../public/js/ui/experimental.js'), revival = source('../../public/js/ui/revival.js');
  assert.match(modal, /aria-label=\$\{ariaLabel\}/);
  assert.match(modal, /if \(!topmost\(\)\) return/);
  assert.match(modal, /else if \(e\.key === 'Tab'\)/); assert.match(modal, /prevFocus\?\.focus/);
  assert.match(modal, /window\.addEventListener\('focusin', onFocus\)/);
  assert.match(matching, /compact = false/); assert.match(matching, /compact \? null : html`<small>\$\{t\(MATCHING_RULES\)\}/);
  assert.match(matching, /\$\{t\(MATCHING_RULES\)\}<\/p><p class="modal__text">\$\{t\(EXPERIMENTAL_RULES\)\}/);
  assert.match(matching, /未完成确认者不自动回队/); assert.match(matching, /单人匹配跟随所加入房间/);
  assert.doesNotMatch(matching, /revivalVote|开启复活并确认|赞成开启/);
  assert.match(experimental, /title=\$\{t\('实验性选项'\)\}/); assert.match(experimental, /revivalEnabled/); assert.match(experimental, /disableSharedPool/);
  assert.match(revival, /me\.lp >= 11/); assert.match(revival, /至少 11 生命，可支付 10 点救援/);
});
