// The feedback board service (deploy/stardust/feedback): real HTTP against an in-process server on an ephemeral port,
// a temp SQLite file and an injected clock. Owner keys and sessions here are test-only values.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CSP, createFeedbackServer } from '../server.mjs';
import { clientKey } from '../policy.mjs';

const ORIGIN = 'https://ark-proto.example.test';
const KEY = 'test-only-owner-key-7f3a';
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 16, 12);
const quiet = { info() {}, warn() {}, error() {} };
const sha = (s) => createHash('sha256').update(s).digest('hex');
let serial = 0;
const sessionOf = (n) => `S${String(n).padStart(42, '0')}`;
const fresh = () => { serial++; return { session: sessionOf(serial), ip: `10.${(serial >> 16) & 255}.${(serial >> 8) & 255}.${serial & 255}` }; };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ark-feedback-'));
  const pub = join(dir, 'public');
  mkdirSync(join(pub, 'sub'), { recursive: true });
  writeFileSync(join(pub, 'index.html'), '<!doctype html><link rel="stylesheet" href="assets/app.css?v=__ASSET_VERSION__"><script type="module" src="assets/app.js?v=__ASSET_VERSION__"></script>');
  const files = { 'app.js': 'export {}', 'app.css': 'body{}', 'icon.svg': '<svg/>', 'a.png': 'png', 'b.webp': 'webp', 'f.woff2': 'font', 'favicon.ico': 'ico',
    '.secret.js': 'nope', 'notes.txt': 'nope', 'data.json': '{}' };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(pub, name), data);
  writeFileSync(join(pub, 'sub', 'x.js'), 'nope');
  writeFileSync(join(dir, 'server.mjs'), 'outside');
  mkdirSync(join(dir, 'owner'));
  return dir;
}
const writeOwner = (dir, doc) => writeFileSync(join(dir, 'owner', 'owner.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
const ownerDoc = (key = KEY) => ({ names: ['服主'], keySha256: sha(key) });

/** A running service; `dir` / `clock` are shared when a test restarts it. Cleanup closes it, then removes `dir`. */
async function start(t, { dir = null, clock = { t: START }, owner = true, keepDir = false, ...opts } = {}) {
  const own = !dir;
  dir ??= fixture();
  if (owner && !existsSync(join(dir, 'owner', 'owner.json'))) writeOwner(dir, ownerDoc());
  const service = createFeedbackServer({ db: join(dir, 'data', 'feedback.sqlite'), origin: ORIGIN, publicDir: join(dir, 'public'),
    ownerFile: join(dir, 'owner', 'owner.json'), now: () => clock.t, log: quiet, ...opts });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  await service.refreshOwner();
  const port = service.server.address().port;
  t.after(async () => { await service.close(); if (own && !keepDir) rmSync(dir, { recursive: true, force: true }); });
  return { service, dir, clock, port, call: (method, path, o) => call(port, method, path, o) };
}

/** One request on its own connection; the path is sent as written. */
function call(port, method, path, { headers = {}, json, body, chunks } = {}) {
  const h = { ...headers };
  let data = body;
  if (json !== undefined) { data = JSON.stringify(json); if (!('content-type' in h)) h['content-type'] = 'application/json'; }
  if (!['GET', 'HEAD'].includes(method) && !('origin' in h)) h.origin = ORIGIN;
  for (const [k, v] of Object.entries(h)) if (v === undefined) delete h[k];
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (chunks) { for (const c of chunks) req.write(c); req.end(); } else req.end(data);
  });
}

const item = (n, extra = {}) => ({ category: 'bug', title: `标题 ${n}`, body: `详细描述 ${n}`, ...extra });
/** POST an item as a fresh (or the given) session / address. */
function post(api, doc, { session, ip, headers = {} } = {}) {
  const who = fresh();
  return api.call('POST', '/feedback/api/items', { json: doc, headers: { 'x-ark-session': session ?? who.session, 'x-real-ip': ip ?? who.ip, ...headers } });
}
async function created(api, doc, opts) {
  const r = await post(api, doc, opts);
  assert.equal(r.status, 201, r.text);
  return r.body.item;
}
const admin = (api, id, patch, headers = {}) => api.call('POST', `/feedback/api/items/${id}/admin`, { json: patch, headers: { 'x-owner-key': KEY, ...headers } });
const list = (api, query = '', headers = {}) => api.call('GET', `/feedback/api/items${query}`, { headers });

test('create returns the public item and stores cleaned text', async (t) => {
  const api = await start(t);
  const r = await post(api, { category: 'gameplay', title: '  建议 \t\n 增加\u0007 模式  ', body: 'line1\r\nline2\rline3\u0000\u001b\u0085\tend\n', author: '  博士  ', client: 'Chrome 141 / Windows' });
  assert.equal(r.status, 201);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body.item, { id: 1, category: 'gameplay', title: '建议 增加 模式', body: 'line1\nline2\nline3\tend', author: '博士', client: 'Chrome 141 / Windows',
    status: 'unassigned', reply: '', replyAt: null, createdAt: START, updatedAt: START });
  const one = await api.call('GET', '/feedback/api/items/1');
  assert.deepEqual(one.body.item, r.body.item);
  // optional fields may be missing or null
  assert.equal((await created(api, { category: 'other', title: '无名', body: '匿名反馈内容', author: null })).author, '');
});

test('validation counts code points after NFC and names the field only', async (t) => {
  const api = await start(t);
  const bad = async (doc, field) => {
    const r = await post(api, doc);
    assert.equal(r.status, 400, JSON.stringify(doc));
    assert.deepEqual(r.body, { error: 'INVALID', field });
  };
  await bad(item(1, { title: '😀' }), 'title');
  assert.equal((await created(api, item(2, { title: '😀😀' }))).title, '😀😀');
  assert.equal((await created(api, item(3, { title: '字'.repeat(80) }))).title.length, 80);
  await bad(item(4, { title: '字'.repeat(81) }), 'title');
  await bad(item(5, { title: '\u0001\u0002a\u0003' }), 'title');
  // 'e' + combining acute ×5 is 10 code points raw, 5 after NFC
  assert.equal((await created(api, item(6, { body: 'é'.repeat(5) }))).body, 'é'.repeat(5));
  await bad(item(7, { body: 'é'.repeat(4) }), 'body');
  await bad(item(8, { body: '\u0000\u0001\u0002\u0003\u0004ab \r\n ' }), 'body');
  assert.equal((await created(api, item(9, { body: '字'.repeat(4000) }))).body.length, 4000);
  await bad(item(10, { body: '字'.repeat(4001) }), 'body');
  assert.equal((await created(api, item(11, { author: 'a'.repeat(24) }))).author.length, 24);
  await bad(item(12, { author: 'a'.repeat(25) }), 'author');
  await bad(item(13, { author: 7 }), 'author');
  assert.equal((await created(api, item(14, { client: 'c'.repeat(160) }))).client.length, 160);
  await bad(item(15, { client: 'c'.repeat(161) }), 'client');
  await bad(item(16, { category: 'feature' }), 'category');
  await bad({ title: '标题', body: '内容内容内容' }, 'category');
  await bad({ category: 'ui', body: '内容内容内容' }, 'title');
  await bad({ category: 'ui', title: '标题', body: 12345 }, 'body');
  // the error never echoes input
  const r = await post(api, item(17, { title: '<script>x</script>'.repeat(10) }));
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.text, /script/);
});

test('session, origin, media type, size and method are checked', async (t) => {
  const api = await start(t);
  const p = (headers, extra = {}) => api.call('POST', '/feedback/api/items', { json: item(1), headers: { 'x-ark-session': sessionOf(1), ...headers }, ...extra });
  assert.deepEqual((await p({ 'x-ark-session': undefined })).body, { error: 'NO_SESSION' });
  assert.equal((await p({ 'x-ark-session': 'a'.repeat(42) })).status, 403);
  assert.equal((await p({ 'x-ark-session': 'a'.repeat(42) + '=' })).status, 403);
  assert.deepEqual((await p({ origin: undefined })).body, { error: 'ORIGIN' });
  assert.equal((await p({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await p({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await p({ 'sec-fetch-site': 'same-origin' })).status, 201);
  assert.deepEqual((await p({ 'content-type': 'text/plain' })).body, { error: 'UNSUPPORTED_MEDIA_TYPE' });
  assert.equal((await p({ 'content-type': undefined })).status, 415);
  assert.equal((await p({ 'content-type': 'application/json; charset=utf-8' }, { json: item(2) })).status, 201);
  const big = JSON.stringify(item(3, { body: 'x'.repeat(17 * 1024) }));
  const r413 = await api.call('POST', '/feedback/api/items', { body: big, headers: { 'content-type': 'application/json', 'x-ark-session': sessionOf(2) } });
  assert.deepEqual([r413.status, r413.body], [413, { error: 'TOO_LARGE' }]);
  const chunked = await api.call('POST', '/feedback/api/items', { chunks: [big.slice(0, 9000), big.slice(9000)],
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', 'x-ark-session': sessionOf(2) } });
  assert.equal(chunked.status, 413);
  for (const body of ['{', '[1]', 'null', '"x"']) {
    assert.deepEqual((await api.call('POST', '/feedback/api/items', { body, headers: { 'content-type': 'application/json', 'x-ark-session': sessionOf(3) } })).body, { error: 'BAD_JSON' });
  }
  const put = await api.call('PUT', '/feedback/api/items', { json: item(4) });
  assert.deepEqual([put.status, put.headers.allow, put.body], [405, 'GET, HEAD, POST', { error: 'METHOD_NOT_ALLOWED' }]);
  assert.equal((await api.call('POST', '/feedback/api/health', { json: {} })).status, 405);
  assert.equal((await api.call('PATCH', '/feedback/api/items/1', { json: {} })).status, 405);
  assert.equal((await api.call('GET', '/feedback/api/items/1/admin')).status, 405);
  assert.equal((await api.call('POST', '/feedback/', { json: {} })).status, 405);
  // DELETE needs the origin too (before the owner key is even looked at)
  assert.deepEqual((await api.call('DELETE', '/feedback/api/items/1', { headers: { origin: 'null', 'x-owner-key': KEY } })).body, { error: 'ORIGIN' });
  assert.deepEqual((await api.call('POST', '/feedback/api/items/1/admin', { json: {}, headers: { origin: undefined, 'x-owner-key': KEY } })).body, { error: 'ORIGIN' });
  assert.equal((await api.call('GET', '/feedback/api/nope')).status, 404);
  assert.equal((await api.call('GET', '/elsewhere')).status, 404);
  assert.equal((await api.call('GET', '/feedback/api/items/0')).status, 404);
  assert.equal((await api.call('GET', '/feedback/api/items/99999999999999999')).status, 404);
});

test('per-session limits: 3 per 10 minutes and 15 per day', async (t) => {
  const api = await start(t);
  const me = { session: sessionOf(100), ip: '10.9.0.1' };
  let n = 0;
  for (let i = 0; i < 3; i++) { await created(api, item(n++), me); api.clock.t += 1000; }
  const r = await post(api, item(n++), me);
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error: 'RATE_LIMITED', retryAfter: 597 });
  assert.equal(r.headers['retry-after'], '597');
  // another session from another address is not affected
  await created(api, item(n++));
  api.clock.t = START + 10 * MINUTE + 1;
  await created(api, item(n++), me);
  // up to 15 in a day, three per ten minutes
  for (let made = 4; made < 15; made++) {
    let res = await post(api, item(n++), me);
    if (res.status === 429) { api.clock.t += 10 * MINUTE; res = await post(api, item(n++), me); }
    assert.equal(res.status, 201);
  }
  api.clock.t += 20 * MINUTE;
  const day = await post(api, item(n++), me);
  assert.equal(day.status, 429);
  assert.ok(day.body.retryAfter > 600 && day.body.retryAfter <= 86400, String(day.body.retryAfter));
  api.clock.t = START + DAY + 1;
  await created(api, item(n), me);
});

test('per-address limit: 30 per day, IPv6 by /64', async (t) => {
  const api = await start(t);
  for (let i = 0; i < 30; i++) await created(api, item(i), { ip: '10.8.0.1' });
  const r = await post(api, item(30), { ip: '10.8.0.1' });
  assert.deepEqual([r.status, r.body.retryAfter], [429, 86400]);
  await created(api, item(31), { ip: '10.8.0.2' });
  for (let i = 0; i < 30; i++) await created(api, item(100 + i), { ip: `2001:db8:1:2::${(i + 1).toString(16)}` });
  assert.equal((await post(api, item(200), { ip: '2001:db8:1:2:ffff::9' })).status, 429);
  await created(api, item(201), { ip: '2001:db8:1:3::1' });
  assert.equal(clientKey('2001:DB8:1:2::1'), '2001:0db8:0001:0002::/64');
  assert.equal(clientKey('::ffff:10.0.0.1'), '10.0.0.1');
});

test('global limit: 120 per hour', async (t) => {
  const api = await start(t);
  for (let i = 0; i < 120; i++) await created(api, item(i));
  const r = await post(api, item(120));
  assert.deepEqual([r.status, r.body.retryAfter], [429, 3600]);
  api.clock.t += HOUR;
  await created(api, item(121));
});

test('a duplicate within a day answers 409 with the id and costs no quota', async (t) => {
  const api = await start(t);
  const me = { session: sessionOf(200), ip: '10.7.0.1' };
  const first = await created(api, item(1, { body: '同一个问题\r\n第二行' }), me);
  const dup = await post(api, item(1, { title: ' 标题   1 ', body: '同一个问题\n第二行  ', category: 'ui', author: '别人' }), me);
  assert.deepEqual([dup.status, dup.body], [409, { error: 'DUPLICATE', id: first.id }]);
  await created(api, item(2), me);
  await created(api, item(3), me);
  assert.equal((await post(api, item(4), me)).status, 429);
  api.clock.t += DAY + 1;
  await created(api, item(1, { body: '同一个问题\n第二行' }));
});

test('list: newest first, keyset pages, filters, counts and bad parameters', async (t) => {
  const api = await start(t);
  const cats = ['bug', 'gameplay', 'ui', 'other'];
  for (let i = 1; i <= 25; i++) await created(api, item(i, { category: cats[i % 4] }));
  for (const [id, status] of [[1, 'planned'], [2, 'planned'], [3, 'updated'], [4, 'unplanned'], [8, 'updated']]) assert.equal((await admin(api, id, { status })).status, 200);
  const first = await list(api);
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.deepEqual(first.body.items.map((x) => x.id), Array.from({ length: 20 }, (_, i) => 25 - i));
  assert.equal(first.body.next, 6);
  assert.deepEqual(first.body.counts, { all: 25, unassigned: 20, unplanned: 1, planned: 2, updated: 2 });
  assert.equal('hidden' in first.body.items[0], false);
  const second = await list(api, `?before=${first.body.next}`);
  assert.deepEqual([second.body.items.map((x) => x.id), second.body.next], [[5, 4, 3, 2, 1], null]);
  assert.equal((await list(api, '?limit=500')).body.items.length, 25);
  const five = await list(api, '?limit=5&before=20');
  assert.deepEqual([five.body.items.map((x) => x.id), five.body.next], [[19, 18, 17, 16, 15], 15]);
  // counts follow category and q, not status
  const planned = await list(api, '?status=planned&category=gameplay');
  assert.deepEqual(planned.body.items.map((x) => x.id), [1]);
  assert.deepEqual(planned.body.counts, { all: 7, unassigned: 6, unplanned: 0, planned: 1, updated: 0 });
  assert.deepEqual((await list(api, '?status=updated')).body.items.map((x) => x.id), [8, 3]);
  assert.equal((await list(api, '?status=&category=all')).body.items.length, 20);
  for (const [query, field] of [['?status=open', 'status'], ['?category=Bug', 'category'], ['?limit=0', 'limit'], ['?limit=x', 'limit'],
    ['?before=-1', 'before'], ['?before=1.5', 'before'], ['?status=planned&status=updated', 'status'], [`?q=${encodeURIComponent('字'.repeat(65))}`, 'q']]) {
    const r = await list(api, query);
    assert.deepEqual([r.status, r.body], [400, { error: 'INVALID', field }], query);
  }
  assert.equal((await list(api, `?q=${encodeURIComponent('字'.repeat(64))}`)).status, 200);
  assert.equal((await api.call('HEAD', '/feedback/api/items')).text, '');
});

test('search: Chinese terms, AND, literal % _ \\ and ASCII case', async (t) => {
  const api = await start(t);
  const ids = {};
  for (const [key, doc] of Object.entries({
    crash: { title: '卫戍协议崩溃', body: 'Hello WORLD 在第三波' },
    ui: { title: '界面太小', body: '手机上按钮看不清', category: 'ui' },
    pct: { title: '进度 100%', body: '显示错误的百分比' },
    pct2: { title: '进度 1000', body: '显示另一个数字' },
    us: { title: '变量 a_b', body: '下划线测试内容' },
    us2: { title: '变量 axb', body: '普通字符测试内容' },
    bs: { title: '路径 c\\d', body: '反斜杠测试内容' },
    bs2: { title: '路径 cd', body: '没有反斜杠的内容' },
    author: { title: '署名测试', body: '看作者能否搜到', author: 'Amiya' },
  })) ids[key] = (await created(api, item(0, doc))).id;
  const q = async (term, headers) => (await list(api, `?q=${encodeURIComponent(term)}`, headers)).body.items.map((x) => x.id).sort((a, b) => a - b);
  assert.deepEqual(await q('崩'), [ids.crash]);
  assert.deepEqual(await q('界面'), [ids.ui]);
  assert.deepEqual(await q('  hello\t崩 '), [ids.crash]);
  assert.deepEqual(await q('hello 界面'), []);
  assert.deepEqual(await q('wOrLd'), [ids.crash]);
  assert.deepEqual(await q('100%'), [ids.pct]);
  assert.deepEqual(await q('%'), [ids.pct]);
  assert.deepEqual(await q('a_b'), [ids.us]);
  assert.deepEqual(await q('_'), [ids.us]);
  assert.deepEqual(await q('c\\d'), [ids.bs]);
  assert.deepEqual(await q('\\'), [ids.bs]);
  assert.deepEqual(await q('amiya'), [ids.author]);
  // only the first five terms count
  assert.deepEqual(await q('进 度 1 0 % 不存在'), [ids.pct]);
  assert.equal((await admin(api, ids.ui, { reply: '已在 0.3.1 修复' })).status, 200);
  assert.deepEqual(await q('0.3.1'), [ids.ui]);
  const counted = await list(api, '?q=%E6%B5%8B%E8%AF%95&status=planned');
  assert.deepEqual([counted.body.items, counted.body.counts.all, counted.body.counts.unassigned], [[], 4, 4]);
});

test('owner: status, reply, hidden, delete; hidden items stay out of public views', async (t) => {
  const api = await start(t);
  const a = await created(api, item(1)), b = await created(api, item(2));
  assert.equal((await api.call('GET', '/feedback/api/admin', { headers: { 'x-owner-key': KEY } })).status, 204);
  assert.deepEqual((await api.call('GET', '/feedback/api/admin')).body, { error: 'OWNER' });
  assert.deepEqual((await admin(api, a.id, { status: 'planned' }, { 'x-owner-key': 'wrong' })).body, { error: 'OWNER' });
  assert.equal((await admin(api, a.id, { status: 'planned' }, { 'x-owner-key': undefined })).status, 403);
  api.clock.t += 1000;
  let r = await admin(api, a.id, { status: 'planned', reply: '  收到，\r\n下个版本处理  ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.item, { ...a, status: 'planned', reply: '收到，\n下个版本处理', replyAt: START + 1000, updatedAt: START + 1000, hidden: false });
  api.clock.t += 1000;
  r = await admin(api, a.id, { status: 'planned' });
  assert.equal(r.body.item.updatedAt, START + 1000, 'no change, no update');
  r = await admin(api, a.id, { reply: '' });
  assert.deepEqual([r.body.item.reply, r.body.item.replyAt, r.body.item.updatedAt], ['', null, START + 2000]);
  for (const [patch, field] of [[{ status: 'done' }, 'status'], [{ reply: 'x'.repeat(2001) }, 'reply'], [{ reply: null }, 'reply'], [{ hidden: 'yes' }, 'hidden']]) {
    assert.deepEqual((await admin(api, a.id, patch)).body, { error: 'INVALID', field });
  }
  assert.equal((await admin(api, a.id, { reply: '字'.repeat(2000) })).status, 200);
  assert.equal((await admin(api, 999, { status: 'planned' })).status, 404);
  assert.equal((await admin(api, b.id, { hidden: true })).body.item.hidden, true);
  // public: gone from list, detail, counts, health and search
  const pub = await list(api);
  assert.deepEqual([pub.body.items.map((x) => x.id), pub.body.counts.all], [[a.id], 1]);
  assert.equal((await api.call('GET', `/feedback/api/items/${b.id}`)).status, 404);
  assert.deepEqual((await api.call('GET', '/feedback/api/health')).body, { ok: true, items: 1 });
  assert.deepEqual((await list(api, '?q=%E6%A0%87%E9%A2%98%202')).body.items, []);
  // owner: visible with the flag
  const own = await list(api, '', { 'x-owner-key': KEY });
  assert.deepEqual(own.body.items.map((x) => [x.id, x.hidden]), [[b.id, true], [a.id, false]]);
  assert.equal(own.body.counts.all, 2);
  assert.equal((await api.call('GET', `/feedback/api/items/${b.id}`, { headers: { 'x-owner-key': KEY } })).body.item.hidden, true);
  // a wrong key on a GET is just the public view
  assert.equal((await list(api, '', { 'x-owner-key': 'wrong' })).body.items.length, 1);
  assert.equal((await admin(api, b.id, { hidden: false })).body.item.hidden, false);
  const del = await api.call('DELETE', `/feedback/api/items/${b.id}`, { headers: { 'x-owner-key': KEY } });
  assert.deepEqual([del.status, del.text], [204, '']);
  assert.equal((await api.call('DELETE', `/feedback/api/items/${b.id}`, { headers: { 'x-owner-key': KEY } })).status, 404);
  assert.equal((await api.call('DELETE', `/feedback/api/items/${a.id}`)).status, 403);
  assert.equal((await api.call('GET', `/feedback/api/items/${b.id}`, { headers: { 'x-owner-key': KEY } })).status, 404);
});

test('owner file: missing, invalid, replaced (mtime) and removed', async (t) => {
  const api = await start(t, { owner: false });
  const check = async (key = KEY) => (await api.call('GET', '/feedback/api/admin', { headers: { 'x-owner-key': key } })).status;
  assert.equal(await check(), 503);
  assert.deepEqual((await api.call('GET', '/feedback/api/admin')).body, { error: 'OWNER_DISABLED' });
  assert.equal((await api.call('DELETE', '/feedback/api/items/1', { headers: { 'x-owner-key': KEY } })).status, 503);
  const file = join(api.dir, 'owner', 'owner.json');
  let mtime = Date.now() / 1000;
  const put = async (doc) => { writeOwner(api.dir, doc); utimesSync(file, mtime, mtime += 10); return api.service.refreshOwner(); };
  for (const doc of ['{', '[]', { keySha256: sha(KEY) }, { names: ['服主'], keySha256: sha(KEY), extra: 1 }, { names: ['服主'], keySha256: 'ab' },
    { names: 'x', keySha256: sha(KEY) }, { names: [''], keySha256: sha(KEY) }, { names: ['​'], keySha256: sha(KEY) }]) {
    assert.equal(await put(doc), false, JSON.stringify(doc));
    assert.equal(await check(), 503);
  }
  assert.equal(await put(ownerDoc()), true);
  assert.equal(await check(), 204);
  assert.equal(await put({ names: [], keySha256: sha('next-test-key').toUpperCase() }), true);
  assert.equal(await check(), 403);
  assert.equal(await check('next-test-key'), 204);
  rmSync(file);
  assert.equal(await api.service.refreshOwner(), false);
  assert.equal(await check('next-test-key'), 503);
});

test('wrong owner keys: 10 per 10 minutes per address', async (t) => {
  const api = await start(t);
  await created(api, item(1));
  assert.equal((await admin(api, 1, { hidden: true })).status, 200);
  const ip = { 'x-real-ip': '10.6.0.1' };
  const check = (key, headers = ip) => api.call('GET', '/feedback/api/admin', { headers: { 'x-owner-key': key, ...headers } });
  for (let i = 0; i < 9; i++) assert.equal((await check(`wrong-${i}`)).status, 403);
  // a wrong key on a public GET counts too
  assert.equal((await list(api, '', { 'x-owner-key': 'wrong-9', ...ip })).body.items.length, 0);
  const r = await check(KEY);
  assert.deepEqual([r.status, r.body, r.headers['retry-after']], [429, { error: 'RATE_LIMITED', retryAfter: 600 }, '600']);
  assert.equal((await admin(api, 1, { hidden: false }, ip)).status, 429);
  assert.equal((await api.call('DELETE', '/feedback/api/items/1', { headers: { 'x-owner-key': KEY, ...ip } })).status, 429);
  // while limited, a GET with the right key is just public
  const pub = await list(api, '', { 'x-owner-key': KEY, ...ip });
  assert.deepEqual([pub.status, pub.body.items], [200, []]);
  assert.equal((await check(KEY, { 'x-real-ip': '10.6.0.2' })).status, 204);
  api.clock.t += 10 * MINUTE;
  assert.equal((await check(KEY)).status, 204);
});

test('data survives a restart, ids are not reused, nothing identifying is stored', async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { t: START };
  const one = await start(t, { dir, clock });
  const who = { session: sessionOf(4242), ip: '198.51.100.77' };
  await created(one, item(1), who);
  const b = await created(one, item(2), who);
  assert.equal((await admin(one, 1, { status: 'updated', reply: '已修复' })).status, 200);
  assert.equal((await one.call('DELETE', `/feedback/api/items/${b.id}`, { headers: { 'x-owner-key': KEY } })).status, 204);
  await one.service.close();
  const files = readdirSync(join(dir, 'data'));
  assert.deepEqual(files, ['feedback.sqlite']);
  const raw = readFileSync(join(dir, 'data', 'feedback.sqlite')).toString('latin1');
  for (const secret of [who.session, who.ip, sha(who.session), KEY, sha(KEY)]) assert.equal(raw.includes(secret), false);
  const two = await start(t, { dir, clock });
  const items = (await list(two)).body.items;
  assert.deepEqual(items.map((x) => [x.id, x.status, x.reply]), [[1, 'updated', '已修复']]);
  assert.equal((await created(two, item(3))).id, 3);
  await two.service.close();
  const db = new DatabaseSync(join(dir, 'data', 'feedback.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().map((r) => r.version), [1]);
  } finally { db.close(); }
});

test('backups: today at startup, then one per day, newest 14 kept', async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  writeFileSync(join(backups, 'keep-me.txt'), 'x');
  const api = await start(t, { dir, backupDir: backups });
  assert.ok(existsSync(join(backups, 'feedback-2026-10-16.sqlite')));
  await created(api, item(1));
  assert.deepEqual(api.service.backup(), { name: 'feedback-2026-10-16.sqlite', created: false, removed: 0 });
  for (let day = 1; day <= 20; day++) {
    api.clock.t += DAY;
    assert.equal(api.service.backup().created, true);
  }
  const kept = readdirSync(backups).sort();
  assert.equal(kept.length, 15);
  assert.equal(kept[0], 'feedback-2026-10-23.sqlite');
  assert.equal(kept[13], 'feedback-2026-11-05.sqlite');
  assert.equal(kept[14], 'keep-me.txt');
  const copy = new DatabaseSync(join(backups, 'feedback-2026-11-05.sqlite'), { readOnly: true });
  try { assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1); } finally { copy.close(); }
  await api.service.close();
});

test('page and assets: version hash, CSP, cache headers, allowlist, traversal', async (t) => {
  const api = await start(t);
  const redirect = await api.call('GET', '/feedback?x=1');
  assert.deepEqual([redirect.status, redirect.headers.location], [301, '/feedback/?x=1']);
  assert.equal((await api.call('HEAD', '/feedback')).status, 301);
  const page = await api.call('GET', '/feedback/');
  const version = api.service.version;
  assert.match(version, /^[0-9a-f]{12}$/);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.equal(CSP, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.ok(page.text.includes(`assets/app.js?v=${version}`) && !page.text.includes('__ASSET_VERSION__'));
  const head = await api.call('HEAD', '/feedback/');
  assert.deepEqual([head.status, head.text, head.headers['content-length']], [200, '', page.headers['content-length']]);
  assert.equal((await api.call('GET', '/feedback/', { headers: { 'if-none-match': `W/${page.headers.etag}` } })).status, 304);
  const types = { 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8', 'icon.svg': 'image/svg+xml', 'a.png': 'image/png',
    'b.webp': 'image/webp', 'f.woff2': 'font/woff2', 'favicon.ico': 'image/x-icon' };
  for (const [name, type] of Object.entries(types)) {
    const r = await api.call('GET', `/feedback/assets/${name}?v=${version}`);
    assert.deepEqual([r.status, r.headers['content-type'], r.headers['cache-control']], [200, type, 'private, max-age=31536000, immutable'], name);
  }
  assert.equal((await api.call('GET', '/feedback/assets/app.js')).headers['cache-control'], 'private, no-cache');
  assert.equal((await api.call('GET', '/feedback/assets/app.js?v=000000000000')).headers['cache-control'], 'private, no-cache');
  const js = await api.call('GET', '/feedback/assets/app.js');
  assert.equal((await api.call('GET', '/feedback/assets/app.js', { headers: { 'if-none-match': js.headers.etag } })).status, 304);
  for (const path of ['/feedback/assets/index.html', '/feedback/assets/.secret.js', '/feedback/assets/notes.txt', '/feedback/assets/data.json',
    '/feedback/assets/sub/x.js', '/feedback/assets/sub', '/feedback/assets/', '/feedback/assets/app.js/', '/feedback/assets/../server.mjs',
    '/feedback/assets/%2e%2e/server.mjs', '/feedback/assets/..%2fserver.mjs', '/feedback/assets/..%2F..%2Fserver.mjs', '/feedback/assets/%2e%2e%2f%2e%2e%2fserver.mjs',
    '/feedback/assets/..\\server.mjs', '/feedback/assets/app.js%00', '/feedback/../feedback/assets/../../server.mjs', '/feedback/index.html']) {
    const r = await api.call('GET', path);
    assert.equal(r.status, 404, path);
    assert.deepEqual(r.body, { error: 'NOT_FOUND' }, path);
  }
  assert.equal((await api.call('POST', '/feedback/assets/app.js', { json: {} })).status, 405);
  assert.equal((await api.call('GET', '//feedback/')).status, 400);
  // the version follows the contents of public/
  writeFileSync(join(api.dir, 'public', 'app.js'), 'export const changed = 1;');
  const again = await start(t, { dir: api.dir, db: join(api.dir, 'data', 'second.sqlite') });
  assert.notEqual(again.service.version, version);
  await again.service.close();
});

test('health and the factory contract', async (t) => {
  const api = await start(t);
  assert.deepEqual((await api.call('GET', '/feedback/api/health')).body, { ok: true, items: 0 });
  await created(api, item(1));
  assert.deepEqual((await api.call('GET', '/feedback/api/health')).body, { ok: true, items: 1 });
  assert.throws(() => createFeedbackServer({ db: ':memory:', origin: 'https://x.example/path', publicDir: join(api.dir, 'public'), log: quiet }), /FEEDBACK_ORIGIN/);
  assert.throws(() => createFeedbackServer({ db: ':memory:', origin: undefined, publicDir: join(api.dir, 'public'), log: quiet }), /FEEDBACK_ORIGIN/);
  const empty = mkdtempSync(join(tmpdir(), 'ark-feedback-empty-'));
  try { assert.throws(() => createFeedbackServer({ db: ':memory:', origin: ORIGIN, publicDir: empty, log: quiet }), /index\.html/); }
  finally { rmSync(empty, { recursive: true, force: true }); }
});
