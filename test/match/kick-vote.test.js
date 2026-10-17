// 投票移出 (server/match/match/kickVote.js, GitHub feedback #12): the connected humans vote out a teammate whose offline
// seat the AI plays (掉线由 AI 接管). A passed vote removes it exactly like a g.leave through the AFK rule's removal path
// (m.removed { reason: 'kicked' }, m.notice kickPassed, onLeave); rejected / timed out / cancelled votes change nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, ERR } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { KICK_VOTE_MS, kickNeed } from '../../server/match/match/kickVote.js';
import { canSnapshot, snapshotMatch, restoreMatch, MATCH_FIELDS } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { makeMatch } from './harness.js';

/** n humans (p_0 … p_{n-1}), the last one dropped at the start: in PREP R3 the AI plays its seat (offline 2 prep ends). */
function takenOver(n = 4, o = {}) {
  const h = makeMatch({ mode: 'coop', humans: n, seed: 65, fake: true, script: () => ({ duration: 4 }), ...o }).start();
  const target = h.ps(`p_${n - 1}`);
  h.m.onDisconnect(target.playerId);
  h.runToPhase(PHASE.PREP, 3);
  assert.ok(target.offlineAutoplay && target.autoplay && !target.connected);
  return { h, m: h.m, target };
}
const notices = (h, kind) => h.bc.filter((x) => x.t === 'm.notice' && x.kind === kind);
const ballot = (m, id, agree, voteId = m.kickVote.id) => m.handle(id, { t: 'g.kickBallot', voteId, agree });

test('protocol and thresholds: g.kickVote { targetId }, g.kickBallot { voteId, agree }; a strict majority', () => {
  assert.equal(validateC2S({ t: 'g.kickVote', targetId: 'ABCD-p1' }), null);
  assert.equal(validateC2S({ t: 'g.kickBallot', voteId: 1, agree: false }), null);
  for (const msg of [{ t: 'g.kickVote' }, { t: 'g.kickVote', targetId: '' }, { t: 'g.kickBallot', voteId: 0, agree: true },
    { t: 'g.kickBallot', voteId: 1 }, { t: 'g.kickBallot', voteId: 1, agree: 1 }]) {
    assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));
  }
  assert.deepEqual([1, 2, 3, 4, 5, 7, 19].map(kickNeed), [1, 2, 2, 3, 3, 4, 10]);
  assert.equal(KICK_VOTE_MS, 30_000);
  for (const k of ['kickVote', '_kickVoteSeq', '_kickFailed', '_kickVoteAt', '_setupProposals']) assert.ok(MATCH_FIELDS.transient.includes(k), k);
});

test('only an offline seat under the AI takeover, only in SP_DRAFT / PREP, never by spectators or for bots', (t) => {
  const h = makeMatch({ mode: 'coop', humans: 3, bots: 1, seed: 65, fake: true, spectators: ['viewer'], script: () => ({ duration: 4 }) }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.WRONG_PHASE, 'INFO_CHECK');
  m.onDisconnect('p_2');
  h.runToPhase(PHASE.PREP, 1);
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.BAD_TARGET, 'offline, not yet taken over');
  const flag = (id) => m.publicView().players.find((p) => p.playerId === id).offlineTakeover;
  assert.equal(flag('p_2'), undefined, 'm.public flags the seat only once the AI plays it');
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'ai_0' }).error, ERR.BAD_TARGET, 'a bot seat');
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_1' }).error, ERR.BAD_TARGET, 'a connected human');
  // its own AI 托管 while connected is not the offline takeover
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: true }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_1' }).error, ERR.BAD_TARGET);
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: false }), { ok: true });
  h.runToPhase(PHASE.COMBAT, 2);
  assert.ok(h.ps('p_2').offlineAutoplay);
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.WRONG_PHASE, 'COMBAT');
  h.runToPhase(PHASE.PREP, 3);
  assert.equal(flag('p_2'), true);
  assert.equal(flag('p_1'), undefined);
  assert.equal(m.handle('viewer', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.SPECTATOR);
  assert.equal(m.handle('p_2', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.NOT_IN_ROOM, 'the offline target itself');
  assert.equal(m.handle('p_0', { t: 'g.kickVote', targetId: 'stranger' }).error, ERR.BAD_TARGET);
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }), { ok: true });
  assert.equal(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_2' }).error, ERR.WRONG_PHASE, 'one vote at a time');
  assert.equal(m.handle('viewer', { t: 'g.kickBallot', voteId: m.kickVote.id, agree: true }).error, ERR.SPECTATOR);
});

test('a passed vote removes the seat exactly like a leave: m.removed kicked, kickPassed, pool / pairing / boss share', (t) => {
  const { h, m, target } = takenOver(4);
  t.after(() => m.dispose());
  const removals = [];
  m.opts.onRemove = (id, removal) => removals.push([id, removal]);
  const now = h.sched.now();
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  const view = h.lastBc('m.public').kickVote;
  assert.deepEqual(view, { id: 1, proposerId: 'p_0', targetId: 'p_3', voters: ['p_0', 'p_1', 'p_2'], agreed: ['p_0'], rejected: [],
    need: 2, deadline: now + m.scaled(KICK_VOTE_MS) });
  assert.equal(ballot(m, 'p_3', true).error, ERR.NOT_IN_ROOM);
  assert.deepEqual(ballot(m, 'p_1', true), { ok: true });
  assert.equal(m.kickVote, null);
  assert.ok(target.left && !target.alive, 'eliminated like a quitter');
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_3').status, 'left');
  assert.equal(m.publicView().kickVote, null);
  const rounds = target.offlineRounds;
  assert.ok(rounds >= 2);
  assert.deepEqual(h.lastTo('p_3', 'm.removed'), { t: 'm.removed', reason: 'kicked', rounds });
  assert.deepEqual(removals, [['p_3', { reason: 'kicked', rounds }]]);
  const passed = { t: 'm.notice', kind: 'kickPassed', voteId: 1, targetId: 'p_3', name: 'P3', agreed: 2, need: 2 };
  for (const id of ['p_0', 'p_1', 'p_2']) assert.deepEqual(h.lastTo(id, 'm.notice'), passed);
  assert.equal(h.lastTo('p_3', 'm.notice'), null);
  assert.equal(notices(h, 'afkRemoved').length, 0);
  if (m.bossWaves) assert.ok(m.bossWaves.every((w) => !w.players.includes('p_3')), 'out of the Final Assault pairing');
  // its copies are back in the shared pool (the engine invariants check pool + holdings)
  h.invariants();
  // the match goes on for the three left
  h.runToPhase(PHASE.COMBAT, 3);
  assert.ok(!m.fields.some((f) => f.players.includes('p_3')));
});

test('rejected and timed-out votes fail (no repeat on the target this round); withdraw, reconnect and prep end cancel', (t) => {
  const { h, m, target } = takenOver(4);
  t.after(() => m.dispose());
  // two of three say no: 3 − 2 < 2, failed at once
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  assert.deepEqual(ballot(m, 'p_1', false), { ok: true });
  assert.ok(m.kickVote, 'one no: still possible');
  assert.deepEqual(ballot(m, 'p_2', false), { ok: true });
  assert.equal(m.kickVote, null);
  assert.deepEqual(notices(h, 'kickFailed').at(-1), { t: 'm.notice', kind: 'kickFailed', voteId: 1, targetId: 'p_3', reason: 'rejected' });
  assert.ok(!target.left);
  h.sched.advance(300);
  assert.deepEqual(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_3' }), { error: ERR.ALREADY, detail: 'kick-failed-this-round' });
  // next round: allowed again; the proposer withdraws
  h.runToPhase(PHASE.PREP, 4);
  assert.deepEqual(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  assert.equal(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_3' }).error, ERR.WRONG_PHASE);
  assert.deepEqual(ballot(m, 'p_1', false), { ok: true });
  assert.deepEqual(notices(h, 'kickCancelled').at(-1), { t: 'm.notice', kind: 'kickCancelled', voteId: 2, targetId: 'p_3', reason: 'withdrawn' });
  // a 300 ms burst guard per proposing player; a cancelled vote does not block the target
  assert.deepEqual(m.handle('p_1', { t: 'g.kickVote', targetId: 'p_3' }), { error: ERR.RATE });
  assert.deepEqual(m.handle('p_2', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  // nobody answers: it times out after 30 s (this prep runs longer)
  assert.ok(m.deadline - h.sched.now() > m.scaled(KICK_VOTE_MS));
  h.sched.advance(m.scaled(KICK_VOTE_MS) - 1);
  assert.ok(m.kickVote);
  h.sched.advance(1);
  assert.equal(m.kickVote, null);
  assert.deepEqual(notices(h, 'kickFailed').at(-1), { t: 'm.notice', kind: 'kickFailed', voteId: 3, targetId: 'p_3', reason: 'timeout' });
  assert.ok(!target.left);
  // the prep ending (everyone ready) cancels an open vote
  h.runToPhase(PHASE.PREP, 5);
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  for (const id of ['p_0', 'p_1', 'p_2']) m.handle(id, { t: 'g.ready', ready: true });
  h.run(() => m.phase !== PHASE.PREP);
  assert.equal(m.kickVote, null);
  assert.equal(notices(h, 'kickCancelled').at(-1).reason, 'prepEnd');
  assert.ok(!target.left);
  // the target reconnecting hands the seat back and cancels the vote
  h.runToPhase(PHASE.PREP, 6);
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  m.onReconnect('p_3');
  assert.equal(m.kickVote, null);
  assert.equal(notices(h, 'kickCancelled').at(-1).reason, 'reconnected');
  assert.ok(!target.autoplay && !target.left);
});

test('a voter who disconnects or leaves is dropped and the vote recounted; a checkpoint drops the vote', (t) => {
  const { h, m, target } = takenOver(4);
  t.after(() => m.dispose());
  // the AI finishes the taken-over seat's prep first (a checkpoint waits for AI-driven seats)
  h.run(() => canSnapshot(m) || m.phase !== PHASE.PREP);
  assert.ok(canSnapshot(m));
  assert.deepEqual(m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  assert.deepEqual(ballot(m, 'p_2', false), { ok: true });
  // the no-voter drops: voters p_0, p_1, need 2 — still open
  m.onDisconnect('p_2');
  assert.deepEqual(m.kickVote.voters, ['p_0', 'p_1']);
  assert.deepEqual([...m.kickVote.rejected], []);
  assert.equal(m.kickVote.need, 2);
  m.onReconnect('p_2');
  assert.equal(ballot(m, 'p_2', true).error, ERR.NOT_IN_ROOM, 'not a voter of this vote any more');
  // a checkpoint taken now restores without the vote (transient)
  const doc = JSON.parse(JSON.stringify(snapshotMatch(m)));
  const r = makeMatch({ mode: 'coop', seats: doc.seats, seed: doc.seed, fake: true });
  t.after(() => r.m.dispose());
  assert.equal(restoreMatch(r.m, doc, { createRngFromState }), true);
  assert.equal(r.m.kickVote, null);
  assert.equal(r.m.publicView().kickVote, null);
  // p_1 leaves: one voter left, need 1, the proposer's yes passes it
  m.onLeave('p_1');
  assert.equal(m.kickVote, null);
  assert.ok(target.left);
  assert.equal(h.lastTo('p_0', 'm.notice').kind, 'kickPassed', 'sent to each player still in (MatchPlatform._removeIdle)');
});

test('small matches: the only voter passes it alone; recounts after a drop; the proposer dropping takes its yes', (t) => {
  const a = takenOver(2);
  t.after(() => a.m.dispose());
  assert.deepEqual(a.m.handle('p_0', { t: 'g.kickVote', targetId: 'p_1' }), { ok: true });
  assert.ok(a.target.left);
  const b = takenOver(3);
  t.after(() => b.m.dispose());
  assert.deepEqual(b.m.handle('p_0', { t: 'g.kickVote', targetId: 'p_2' }), { ok: true });
  assert.equal(b.m.kickVote.need, 2);
  b.m.onDisconnect('p_1');
  assert.equal(b.m.kickVote, null, 'p_1 dropped: one voter, need 1, p_0 agreed');
  assert.ok(b.target.left);
  const c = takenOver(3);
  t.after(() => c.m.dispose());
  assert.deepEqual(c.m.handle('p_1', { t: 'g.kickVote', targetId: 'p_2' }), { ok: true });
  c.m.onDisconnect('p_0');
  assert.ok(c.target.left, 'the proposer alone still agrees');
  const d = takenOver(4);
  t.after(() => d.m.dispose());
  assert.deepEqual(d.m.handle('p_0', { t: 'g.kickVote', targetId: 'p_3' }), { ok: true });
  d.m.onDisconnect('p_0');
  assert.deepEqual(d.m.kickVote.voters, ['p_1', 'p_2']);
  assert.deepEqual(d.m.kickVote.agreed.size, 0);
  d.m.onDisconnect('p_1');
  d.m.onDisconnect('p_2');
  assert.equal(d.m.kickVote, null);
  assert.equal(notices(d.h, 'kickCancelled').at(-1).reason, 'empty');
  assert.ok(!d.target.left);
});
