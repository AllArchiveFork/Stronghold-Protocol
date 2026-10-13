// SESSION_IN_USE for a shared candidate with a match seat (identity.retryClaim, public/js/main.js; the owner's report of
// 2026-10-13): a new page of the same browser — an invitation link opened again, a relaunched app — adopts the closed
// page's token, but the server may still hold that page's socket for a heartbeat or two. The page asks again for
// CLAIM_RETRY_MS instead of taking a new identity at once (which left the seat behind: only watching remained).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { CLAIM_RETRY_MS, createIdentity, tokenHash, Net } from '../public/js/net.js';

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}
/** A browser that last played `token` in room `code` on a page now closed; nobody else answers on the channel. */
function newPage(token, { code = 'ABCD', seat = true, clock = { t: 1000 } } = {}) {
  const local = storage({
    'sp.tokens': JSON.stringify([token]),
    ...(seat ? { 'sp.matches': JSON.stringify({ [tokenHash(token)]: { name: 'Doctor', code } }) } : {}),
  });
  const channel = { postMessage() {}, addEventListener() {} };
  return createIdentity({ local, session: storage(), channel, queryMs: 0, setTimeout: (fn) => setTimeout(fn, 0), now: () => clock.t });
}

test('retryClaim: only a shared candidate holding a match seat, for CLAIM_RETRY_MS from its first refusal', async () => {
  const clock = { t: 1000 };
  const id = newPage('a'.repeat(32), { clock });
  assert.equal(await id.init(), 'a'.repeat(32));
  assert.deepEqual(id.getTokenClaim(), { noReplace: true }, 'a shared candidate never replaces a live holder');
  assert.equal(id.retryClaim(), true);
  clock.t += CLAIM_RETRY_MS - 1;
  assert.equal(id.retryClaim(), true);
  clock.t += 1;
  assert.equal(id.retryClaim(), false, 'then the page gives the seat up (rejectToken)');

  const noSeat = newPage('b'.repeat(32), { seat: false });
  await noSeat.init();
  assert.equal(noSeat.retryClaim(), false, 'no match seat at stake: a new identity at once, as before');

  const own = createIdentity({ local: storage(), session: storage(), channel: null });
  await own.init();
  own.saveToken('c'.repeat(32));
  assert.equal(own.retryClaim(), false, 'this tab\'s own token is never retried (a duplicated tab yields to the original)');
});

test('the retried hello gets the seat back once the old socket is gone: same player, resumed', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 0, trialWorkers: 0 });
  const nets = [];
  t.after(async () => { nets.forEach((n) => n.close()); await srv.close(); });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const next = (net, type) => new Promise((resolve, reject) => {
    const off = net.on(type, (v) => { clearTimeout(timer); off(); resolve(v); });
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${type}`)); }, 3000);
  });

  // the old page: its socket is still open as far as the server knows
  let oldToken = null;
  const old = new Net({ url, WebSocket, getToken: () => oldToken });
  nets.push(old);
  const first = next(old, 'welcome');
  old.setName('Doctor');
  const welcome = await first;
  oldToken = welcome.token;

  const id = newPage(oldToken);
  await id.init();
  const page = new Net({ url, WebSocket, getToken: () => id.getToken(), getTokenClaim: () => id.getTokenClaim() });
  nets.push(page);
  page.on('welcome', (w) => id.saveToken(w.token));
  const refused = next(page, 'helloError');
  page.setName('Doctor');
  assert.equal((await refused).code, 'SESSION_IN_USE');
  assert.equal(id.retryClaim(), true, 'main.js asks again instead of rejectToken');

  old.close();
  await new Promise((r) => setTimeout(r, 50));
  const back = next(page, 'welcome');
  page.reconnectNow('Doctor');
  const resumed = await back;
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.playerId, welcome.playerId, 'the same player, so the same seat');
  assert.equal(srv.network.helloStats().inUse, 1);
  assert.equal(srv.network.helloStats().resumed, 1);
});
