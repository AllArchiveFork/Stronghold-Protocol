// test/reconnect-stats.test.js — /healthz `reconnect` (the owner's report of 2026-10-13: some reconnects ended on a
// spectator seat): the first hellos since start by outcome (net.js helloStats — resumed / fresh / unknownToken / inUse)
// and the human seats that left a running match by cause (lobby.js departureStats; test/lobby-afk.test.js drives those).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { ERR } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';

test('/healthz reconnect.hello counts every first hello of a socket by its outcome', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 0, trialWorkers: 0 });
  const open = [];
  t.after(async () => {
    await Promise.all(open.map((c) => c.terminate().catch(() => {})));
    await srv.close();
  });
  const connect = async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    open.push(c);
    return c;
  };
  const report = async () => (await (await fetch(`${srv.url}/healthz`)).json()).reconnect;
  assert.deepEqual(await report(), {
    hello: { resumed: 0, fresh: 0, unknownToken: 0, inUse: 0 },
    matchSeats: { afkOnline: 0, afkOffline: 0, expired: 0 },
  });

  const a = await connect();
  const first = await a.hello('Alpha');
  await a.hello('Alpha'); // a repeat hello on the same socket is not a new outcome
  const b = await connect();
  const refused = await b.request({ t: 'hello', name: 'Alpha', version: 1, token: first.token, noReplace: true });
  assert.equal(refused.t, 'error');
  assert.equal(refused.code, ERR.SESSION_IN_USE, 'live on the first socket, and asked not to replace it');
  const c = await connect();
  assert.equal((await c.hello('Alpha', first.token)).resumed, true);
  const d = await connect();
  const stranger = await d.hello('Delta', 'f'.repeat(32));
  assert.equal(stranger.resumed, false, 'a token no session has gets a new identity');
  assert.notEqual(stranger.playerId, first.playerId);
  assert.deepEqual((await report()).hello, { resumed: 1, fresh: 1, unknownToken: 1, inUse: 1 });
});
