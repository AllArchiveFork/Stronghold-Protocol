// The online cap (server/onlineLimit.js): a JSON file re-read while the server runs; Network.onHelloMsg refuses a NEW
// session with SERVER_FULL at the cap and always lets an existing session resume; the client reads the refusal's numbers
// and retries after the server's interval (public/js/net.js serverFull).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Network, SessionRegistry } from '../server/net.js';
import { createOnlineLimit, parseLimits, parseOnlineLimit, serverFullDetail, SERVER_FULL_RETRY_MS } from '../server/onlineLimit.js';
import { serverFull } from '../public/js/net.js';
import { ERR, ERR_TEXT } from '../shared/constants.js';

test('the cap file: a limit 0..1e6 (0 or no key = none); anything else is invalid', () => {
  assert.equal(parseOnlineLimit({ limit: 3000 }), 3000);
  assert.equal(parseOnlineLimit({ limit: 0 }), 0);
  assert.equal(parseOnlineLimit({}), 0);
  for (const bad of [null, [], 'x', { limit: -1 }, { limit: 1.5 }, { limit: '3000' }, { limit: 1_000_001 }]) assert.equal(parseOnlineLimit(bad), null, JSON.stringify(bad));
});

test('the file may also set the lobby room / AI caps; an unknown key or a bad value invalidates the whole file', () => {
  assert.deepEqual(parseLimits({ limit: 3000, maxRoomsPerAddr: 24, maxBotsPerAddr: 60 }), { limit: 3000, caps: { maxRoomsPerAddr: 24, maxBotsPerAddr: 60 } });
  assert.deepEqual(parseLimits({ maxRooms: 0, maxMatchesPerAddr: 24, maxBots: 6000 }), { limit: 0, caps: { maxRooms: 0, maxMatchesPerAddr: 24, maxBots: 6000 } });
  for (const bad of [{ limit: 10, maxRoomPerAddr: 3 }, { maxBots: -1 }, { maxBotsPerAddr: '60' }, { maxRooms: 1.5 }]) {
    assert.equal(parseLimits(bad), null, JSON.stringify(bad));
    assert.equal(parseOnlineLimit(bad), null, JSON.stringify(bad));
  }
});

test('the room caps follow the file too: a bad edit keeps every previous value, a removed file clears them', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-limit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'online-limit.json');
  const logs = [];
  const limit = createOnlineLimit({ file, pollMs: 60_000, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  t.after(() => limit.close());
  await limit.refresh();
  assert.deepEqual(limit.caps(), {}, 'no file: no caps');
  writeFileSync(file, '{ "limit": 0, "maxRoomsPerAddr": 24, "maxBotsPerAddr": 60 }\n');
  assert.equal(await limit.refresh(), 0);
  assert.deepEqual(limit.caps(), { maxRoomsPerAddr: 24, maxBotsPerAddr: 60 });
  writeFileSync(file, '{ "limit": 500, "maxRoomsPerAdr": 8 }\n');
  assert.equal(await limit.refresh(), 0, 'a typo keeps the online cap');
  assert.deepEqual(limit.caps(), { maxRoomsPerAddr: 24, maxBotsPerAddr: 60 }, 'and the room caps');
  writeFileSync(file, '{ "limit": 500, "maxRoomsPerAddr": 16 }\n');
  assert.equal(await limit.refresh(), 500);
  assert.deepEqual(limit.caps(), { maxRoomsPerAddr: 16 }, 'a key left out goes back to the lobby option');
  rmSync(file);
  assert.equal(await limit.refresh(), 0);
  assert.deepEqual(limit.caps(), {});
  assert.ok(logs.some((m) => /room caps options → \{"maxRoomsPerAddr":24,"maxBotsPerAddr":60\}/.test(m)), logs.join('\n'));
  assert.ok(logs.some((m) => /maxRoomsPerAdr|not \{"limit"/.test(m)));
});

test('the cap follows its file: missing = none, a change is picked up, a bad edit keeps the previous value', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-limit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'online-limit.json');
  const logs = [];
  const limit = createOnlineLimit({ file, pollMs: 60_000, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  t.after(() => limit.close());
  assert.equal(await limit.refresh(), 0, 'no file: no cap');
  writeFileSync(file, '{ "limit": 3000 }\n');
  assert.equal(await limit.refresh(), 3000);
  assert.equal(limit.limit(), 3000);
  writeFileSync(file, '{ "limit": "lots" }\n');
  assert.equal(await limit.refresh(), 3000, 'a bad edit keeps the cap');
  writeFileSync(file, '{ "limit": 250 }\n');
  assert.equal(await limit.refresh(), 250);
  rmSync(file);
  assert.equal(await limit.refresh(), 0, 'removed: no cap');
  assert.ok(logs.some((m) => /3000/.test(m)) && logs.some((m) => /not \{"limit"/.test(m)));
  assert.equal(createOnlineLimit().limit(), 0, 'no file configured: no cap');
});

function harness(t, cap) {
  const registry = new SessionRegistry();
  const state = { online: 0 };
  const network = new Network({ registry, handler: { onMessage() {}, onlineCount: () => state.online }, onlineLimit: { limit: () => cap } });
  t.after(() => network.close());
  const hello = (msg) => {
    const frames = [];
    const conn = { session: null, ip: '203.0.113.9', key: null, closing: false, pendingHandlers: 0,
      ws: { readyState: 1, bufferedAmount: 0, send: (raw) => frames.push(JSON.parse(raw)), close() {}, terminate() {} } };
    network.onHelloMsg(conn, { t: 'hello', rid: 7, ...msg }, Date.now());
    return frames.at(-1);
  };
  return { registry, state, hello };
}

test('at the cap a NEW session is refused with the numbers, an existing one still resumes', (t) => {
  const { registry, state, hello } = harness(t, 2);
  const away = registry.create('Away'); // e.g. a player whose page reloads mid-match
  state.online = 2;
  const refused = hello({ name: 'Newcomer' });
  assert.equal(refused.t, 'error');
  assert.equal(refused.code, ERR.SERVER_FULL);
  assert.equal(refused.msg, ERR_TEXT.SERVER_FULL);
  assert.equal(refused.detail, serverFullDetail(2, 2));
  assert.equal(refused.rid, 7);
  assert.equal(registry.byToken(away.token), away);
  const back = hello({ name: 'Away', token: away.token });
  assert.equal(back.t, 'welcome');
  assert.equal(back.resumed, true);
  state.online = 1;
  assert.equal(hello({ name: 'Newcomer' }).t, 'welcome', 'below the cap again');
});

test('no cap (0) admits everyone', (t) => {
  const { state, hello } = harness(t, 0);
  state.online = 100_000;
  assert.equal(hello({ name: 'Anyone' }).t, 'welcome');
});

test('the client reads the refusal and waits the server interval (bounded)', () => {
  assert.deepEqual(serverFull(serverFullDetail(3001, 3000)), { online: 3001, limit: 3000, retryMs: SERVER_FULL_RETRY_MS });
  assert.deepEqual(serverFull('online=1 limit=1 retry=5'), { online: 1, limit: 1, retryMs: 20_000 }, 'an out-of-range interval falls back');
  assert.deepEqual(serverFull(null), { online: null, limit: null, retryMs: 20_000 });
});
