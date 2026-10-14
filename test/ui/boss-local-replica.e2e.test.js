// Real-server browser E2E of the boss / hidden local display replicas under server-run combat (DESIGN §14 "Local
// display replicas", b.ext; unit counterparts: test/match/boss-local-replica.test.js). A co-op match jumped to the boss
// round (fastServer SP_START_ROUND=boss, SP_AUTO_PLACE) with SP_COMBAT=server and a combat Worker, 2 humans + 2 AI:
//   * each human's own pair field runs in its browser on the Worker's pool record (a ReplayBossPool), its digests
//     agree with the Worker's (no stream fallback), it never runs past the record, and the leader's HP moves;
//   * an eliminated guest follows the host's boss field the same way (a watching replica).
//
//   SP_E2E=1 node --test test/ui/boss-local-replica.e2e.test.js
//
// Screenshots: test/e2e/out/boss-local-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const HOST_KIT = ['chess_char_4_23_a', 'chess_char_4_24_a', 'chess_char_3_06_a', 'chess_char_3_13_a'];
const GUEST_KIT = ['chess_char_1_03_a', 'chess_char_1_09_a', 'chess_char_2_01_a', 'chess_char_3_21_a'];
const BOT_KIT = ['chess_char_4_01_a', 'chess_char_4_02_a', 'chess_char_3_01_a', 'chess_char_2_06_a'];
const SERVER_ENV = { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10' };

/** Start the fast server in server-run combat mode with a combat Worker (the production configuration). */
async function serverRun(fast) {
  const saved = Object.fromEntries(Object.keys(SERVER_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SERVER_ENV);
  try { return await startRealServer({ fast }); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** The runner's boss replicas in a page: what they replay and how far. */
const replicas = (c) => c.page.evaluate(() => {
  const r = globalThis.__SP_RUNNER__;
  const out = [];
  for (const e of r?._entries?.values() || []) {
    if (e.kind !== 'boss' && e.kind !== 'hidden') continue;
    out.push({ battleId: e.battleId, fieldId: e.fieldId, replica: !!e.replica, dropped: !!e.dropped, watch: !!e.watch,
      replay: !!e.replay, to: e.replay?.to ?? null, tick: e.battle?.tickCount ?? null, synced: e.synced, lag: e.lag,
      poolHp: e.replay?.hp ?? null, finished: !!e.battle?.finished });
  }
  const f = globalThis.__SP__.store.get().match.field;
  return { list: out, field: f ? { fieldId: f.fieldId, kind: f.kind, local: !!f.local } : null, phase: globalThis.__SP__.store.get().match.public?.phase };
});

async function coopAtBoss(P, base, prefix) {
  const host = new Client(P, base, 'host', { prefix: `${prefix}-host`, w: 1280, h: 720 });
  const guest = new Client(P, base, 'guest', { prefix: `${prefix}-guest`, w: 1280, h: 720 });
  await host.open();
  await host.enter('凯尔希');
  await host.click('.mode-card', '同盟模拟');
  await host.click('.diff-card', '标准模拟');
  await host.click('.create-box button', '创建同盟');
  const room = (await host.waitFor((s) => !!s.room?.code, 'room created')).room;
  for (let i = 0; i < 2; i++) { await host.click('button', '添加 AI 队友'); await sleep(600); }
  await guest.open(`?room=${room.code}`);
  await guest.enter('阿米娅');
  await guest.waitFor((s) => s.room?.code === room.code, 'guest joined');
  for (let i = 0; i < 6; i++) { await guest.click('.room-bar__right button', '准备就绪', { optional: true, timeout: 3000 }); await sleep(500); }
  await host.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  for (const c of [host, guest]) await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  for (const c of [host, guest]) await c.click('.brief__foot .btn--primary', '准备就绪');
  for (const c of [host, guest]) await c.waitFor((s) => s.phase !== 'INFO_CHECK', 'band draft', 40000);
  const picked = new Set();
  const t0 = Date.now();
  while (picked.size < 2 && Date.now() - t0 < 120000) {
    for (const c of [host, guest]) {
      const s = await c.st();
      if (s.phase !== 'BAND_DRAFT') { picked.add(c.label); continue; }
      if (picked.has(c.label) || s.draft?.turn !== s.me) continue;
      await c.click('.dband:not(.is-taken)', null, { nth: c === host ? 2 : 5 });
      await c.click('.draft-detail__btns .btn--primary', '确认选择');
      picked.add(c.label);
    }
    await sleep(250);
  }
  return { host, guest };
}

describe('boss / hidden fields as local display replicas (server-run combat, real server + Worker)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('each human runs its own pair field on the Worker\'s pool record: digests agree, never past the record, the leader\'s HP moves', { timeout: 8 * 60 * 1000 }, async () => {
    const srv = await serverRun({ timerScale: 1, combatSpeed: 2, startRound: 'boss', autoPlace: true, kits: [HOST_KIT, GUEST_KIT], botChess: BOT_KIT });
    const P = (await import('puppeteer-core')).default;
    let host = null;
    let guest = null;
    try {
      ({ host, guest } = await coopAtBoss(P, srv.base, 'boss-local'));
      await host.waitFor((s) => s.phase === 'PREP' && !s.ready, 'boss-round prep', 90000);
      await host.click('.readybtn');
      await guest.click('.readybtn');
      for (const c of [host, guest]) await c.waitFor((s) => s.phase === 'FINAL_ASSAULT', 'Final Assault', 90000);
      for (const c of [host, guest]) {
        await c.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.kind === 'boss' && e.replay && e.battle), { timeout: 30000 });
      }
      const first = { host: await replicas(host), guest: await replicas(guest) };
      await sleep(9000);
      const later = { host: await replicas(host), guest: await replicas(guest) };
      await host.shot('fight');
      await guest.shot('fight');
      for (const who of ['host', 'guest']) {
        const a = first[who], b = later[who];
        assert.equal(b.list.length, 1, `${who}: one boss replica ${JSON.stringify(b)}`);
        const e = b.list[0];
        assert.deepEqual([e.replica, e.replay, e.dropped, e.watch], [true, true, false, false], `${who}: ${JSON.stringify(e)}`);
        assert.deepEqual(b.field, { fieldId: e.fieldId, kind: 'boss', local: true }, `${who}: the field on screen is the replica`);
        assert.ok(e.tick <= e.to, `${who}: never past the record (${e.tick} > ${e.to})`);
        assert.ok(e.finished || e.tick > a.list[0].tick + 200, `${who}: it advanced (${a.list[0].tick} → ${e.tick})`);
        assert.ok(e.synced >= 3, `${who}: Worker digests compared and equal (${e.synced})`);
        assert.ok(e.poolHp < (a.list[0].poolHp ?? Infinity) || e.finished, `${who}: the leader lost HP (${a.list[0].poolHp} → ${e.poolHp})`);
      }
      assert.deepEqual(problemsOf([host, guest]), []);
    } finally {
      for (const c of [host, guest]) if (c?.problems.length) console.log(c.label, c.problems.slice(0, 20).join('\n'));
      await host?.close();
      await guest?.close();
      await srv.stop();
    }
  });

  test('an eliminated guest follows the host\'s boss field as a watching replica', { timeout: 8 * 60 * 1000 }, async () => {
    const srv = await serverRun({ timerScale: 1, combatSpeed: 2, startRound: 'boss', autoPlace: true, kits: [HOST_KIT, []], botChess: BOT_KIT, eliminate: [1] });
    const P = (await import('puppeteer-core')).default;
    let host = null;
    let guest = null;
    try {
      ({ host, guest } = await coopAtBoss(P, srv.base, 'boss-local-follow'));
      await host.waitFor((s) => s.phase === 'PREP' && !s.ready, 'boss-round prep', 90000);
      await host.click('.readybtn');
      for (const c of [host, guest]) await c.waitFor((s) => s.phase === 'FINAL_ASSAULT', 'Final Assault', 90000);
      await guest.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.kind === 'boss' && e.replay && e.battle), { timeout: 30000 });
      await sleep(8000);
      const g = await replicas(guest), h = await replicas(host);
      await guest.shot('follow');
      assert.equal((await guest.st()).alive, false, 'the guest is eliminated');
      assert.equal(g.list.length, 1, JSON.stringify(g));
      const e = g.list[0];
      assert.deepEqual([e.replica, e.replay, e.dropped, e.watch], [true, true, false, true], JSON.stringify(e));
      assert.equal(e.fieldId, h.list[0].fieldId, 'the host\'s field');
      assert.ok(e.synced >= 2 && e.tick <= e.to, JSON.stringify(e));
      assert.deepEqual(problemsOf([host, guest]), []);
    } finally {
      for (const c of [host, guest]) if (c?.problems.length) console.log(c.label, c.problems.slice(0, 20).join('\n'));
      await host?.close();
      await guest?.close();
      await srv.stop();
    }
  });
});
