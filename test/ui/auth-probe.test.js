// public/js/authProbe.js — a gate's expired sign-in behind repeated WebSocket failures (the owner's report of
// 2026-10-13): from the AUTH_PROBE_AFTER-th failed attempt on, one GET /client-build per attempt; a 401 asks once (until
// the next welcome) and signing in reloads the tab; any other answer, or a failed probe, asks nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthProbe, AUTH_PROBE_AFTER } from '../../public/js/authProbe.js';

function rig(status = 401, answer = true) {
  const calls = { fetch: [], ask: 0, reload: 0 };
  const probe = createAuthProbe({
    fetch: async (url, opts) => {
      calls.fetch.push({ url, cache: opts?.cache });
      if (status instanceof Error) throw status;
      return { status, body: null };
    },
    ask: async () => { calls.ask++; return answer; },
    reload: () => { calls.reload++; },
  });
  return { probe, calls };
}
const reconnecting = (attempt) => ({ status: 'reconnecting', attempt });

test('no probe before AUTH_PROBE_AFTER failed attempts, nor while connected', async () => {
  const { probe, calls } = rig();
  for (let a = 0; a < AUTH_PROBE_AFTER; a++) await probe.onStatus(reconnecting(a));
  await probe.onStatus({ status: 'online', attempt: 0 });
  await probe.onStatus({ status: 'handshaking', attempt: 5 });
  assert.deepEqual(calls.fetch, []);
});

test('a 401 asks once and signing in reloads; one probe per attempt; asked again only after a welcome', async () => {
  const { probe, calls } = rig(401, true);
  await probe.onStatus(reconnecting(AUTH_PROBE_AFTER));
  assert.deepEqual(calls.fetch, [{ url: '/client-build', cache: 'no-store' }]);
  assert.equal(calls.ask, 1);
  assert.equal(calls.reload, 1);
  await probe.onStatus(reconnecting(AUTH_PROBE_AFTER));
  await probe.onStatus(reconnecting(AUTH_PROBE_AFTER + 1));
  assert.equal(calls.ask, 1, 'not asked twice before a welcome');
  probe.onWelcome();
  await probe.onStatus(reconnecting(AUTH_PROBE_AFTER));
  assert.equal(calls.ask, 2);
});

test('declining keeps the page (no reload); a host without a gate or a failed probe never asks', async () => {
  const declined = rig(401, false);
  await declined.probe.onStatus(reconnecting(AUTH_PROBE_AFTER));
  assert.equal(declined.calls.ask, 1);
  assert.equal(declined.calls.reload, 0);
  for (const status of [200, 304, 403, 404, 502, new Error('offline')]) {
    const { probe, calls } = rig(status);
    await probe.onStatus(reconnecting(AUTH_PROBE_AFTER));
    await probe.onStatus(reconnecting(AUTH_PROBE_AFTER));
    assert.equal(calls.fetch.length, 1, `${status}: one probe for one attempt`);
    assert.equal(calls.ask, 0, String(status));
  }
});
