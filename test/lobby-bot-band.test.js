// test/lobby-bot-band.test.js — the co-op room option "an AI seat's strategy" (room.setBotBand {seat, bandId}): host-only,
// before the match, not while the party is queued, co-op rooms only, an AI seat only, a strategy the room's mode offers
// (checked with the GameData the match builds — 鸭爵 off in an expanded room included), one AI seat per strategy;
// room.state seats[].band on every AI seat; the match gets it as that AI seat's seats[].band (test/match/bot-band.test.js
// covers the draft). It lives on the AI seat: removing the AI clears it, the room keeps it across its matches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { getData } from '../server/data.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const CAP8 = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 };

/** Records each match's options; end() finishes it like a real match (onEnd → the room is back in LOBBY). */
class RecordingMatch {
  constructor(opts) { this.opts = opts; RecordingMatch.started.push(opts); }
  start() {}
  dispose() {}
  onLeave() {}
  onDisconnect() {}
  onReconnect() {}
  end() { this.opts.onEnd({}); }
}
RecordingMatch.started = [];

function fixture(t) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: RecordingMatch, getData: () => DATA, seedFn: () => 17 });
  t.after(() => lobby.shutdown());
  let count = 0;
  const player = () => {
    const s = registry.create(`Band${++count}`); s.connected = true; s.messages = [];
    s.matchmakingVersion = MATCHMAKING_VERSION; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const lastState = (s) => s.messages.filter((m) => m.t === 'room.state').at(-1);
  return { lobby, player, lastState };
}

const set = (f, s, seat, bandId) => f.lobby.onMessage(s, { t: 'room.setBotBand', seat, bandId });

test('protocol: room.setBotBand takes a seat and a band id, null / absent = automatic', () => {
  for (const msg of [{ seat: 1, bandId: 'band_amiya' }, { seat: 19, bandId: null }, { seat: 0 }]) {
    assert.equal(validateC2S({ t: 'room.setBotBand', ...msg }), null, JSON.stringify(msg));
  }
  for (const msg of [{ seat: -1, bandId: 'band_amiya' }, { seat: 20, bandId: null }, { seat: 1.5 }, { bandId: 'band_amiya' },
    { seat: 1, bandId: 5 }, { seat: 1, bandId: '' }, { seat: 1, bandId: 'band amiya' }, { seat: 1, bandId: {} }, { seat: '1' }]) {
    assert.notEqual(validateC2S({ t: 'room.setBotBand', ...msg }), null, JSON.stringify(msg));
  }
});

test('room.state: every AI seat shows band (null by default), human seats do not; the host sets and clears it', (t) => {
  const f = fixture(t), host = f.player(), guest = f.player();
  assert.deepEqual(f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const room = f.lobby.roomOf(host);
  assert.deepEqual(f.lobby.join(guest, { code: room.code }), { ok: true });
  assert.deepEqual(f.lobby.addBot(host), { ok: true });
  assert.deepEqual(f.lobby.addBot(host), { ok: true });
  let st = f.lastState(guest);
  assert.deepEqual(st.seats.map((s) => s && Object.hasOwn(s, 'band') ? s.band : 'none'), ['none', 'none', null, null]);
  assert.deepEqual(set(f, host, 2, 'band_amiya'), { ok: true });
  st = f.lastState(guest);
  assert.equal(st.seats[2].band, 'band_amiya');
  assert.equal(st.seats[3].band, null);
  assert.deepEqual(set(f, host, 2, null), { ok: true });
  assert.equal(f.lastState(guest).seats[2].band, null);
  assert.deepEqual(f.lobby.onMessage(host, { t: 'room.setBotBand', seat: 3, bandId: 'band_bldsk' }), { ok: true });
  assert.deepEqual(f.lobby.onMessage(host, { t: 'room.setBotBand', seat: 3 }), { ok: true }, 'absent bandId = automatic');
  assert.equal(f.lastState(host).seats[3].band, null);
});

test('refusals: not host, not an AI seat, outside capacity, unknown strategy, designated twice, solo room', (t) => {
  const f = fixture(t), host = f.player(), guest = f.player();
  f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' });
  const room = f.lobby.roomOf(host);
  f.lobby.join(guest, { code: room.code });
  f.lobby.addBot(host);
  f.lobby.addBot(host);
  const before = JSON.stringify(room.toState());
  assert.equal(set(f, guest, 2, 'band_amiya').error, ERR.NOT_HOST);
  for (const seat of [0, 1]) assert.equal(set(f, host, seat, 'band_amiya').error, ERR.BAD_TARGET, `human seat ${seat}`);
  f.lobby.removeBot(host, { seat: 3 });
  assert.equal(set(f, host, 3, 'band_amiya').error, ERR.BAD_TARGET, 'empty seat');
  assert.equal(set(f, host, 7, 'band_amiya').error, ERR.BAD_TARGET, 'outside the room capacity');
  assert.equal(set(f, host, 2, 'band_nope').error, ERR.BAD_TARGET, 'unknown strategy');
  f.lobby.addBot(host);
  assert.deepEqual(set(f, host, 2, 'band_amiya'), { ok: true });
  assert.deepEqual(set(f, host, 2, 'band_amiya'), { ok: true }, 'the same seat again is fine');
  assert.deepEqual(set(f, host, 3, 'band_amiya'), { error: ERR.BAD_TARGET, detail: 'strategy designated to another AI' });
  assert.equal(room.seats[3].band, null);
  assert.deepEqual(set(f, host, 2, 'band_bldsk'), { ok: true });
  assert.deepEqual(set(f, host, 3, 'band_amiya'), { ok: true }, 'free again once the first AI moved on');
  assert.notEqual(JSON.stringify(room.toState()), before);
  const solo = f.player();
  f.lobby.create(solo, { mode: 'solo', difficulty: 'NORMAL' });
  assert.deepEqual(set(f, solo, 0, 'band_amiya'), { error: ERR.BAD_TARGET, detail: 'solo rooms have no AI teammates' });
  assert.equal(set(f, f.player(), 0, 'band_amiya').error, ERR.NOT_IN_ROOM);
});

test('a change un-readies the other humans (like the difficulty); the same value changes nothing', (t) => {
  const f = fixture(t), host = f.player(), guest = f.player();
  f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' });
  const room = f.lobby.roomOf(host);
  f.lobby.join(guest, { code: room.code });
  f.lobby.addBot(host);
  f.lobby.ready(guest, { ready: true });
  assert.deepEqual(set(f, host, 2, 'band_amiya'), { ok: true });
  assert.equal(room.seatOf(guest.playerId).ready, false);
  f.lobby.ready(guest, { ready: true });
  const sent = guest.messages.length;
  assert.deepEqual(set(f, host, 2, 'band_amiya'), { ok: true });
  assert.equal(room.seatOf(guest.playerId).ready, true);
  assert.equal(guest.messages.length, sent, 'no broadcast without a change');
});

test('the match gets it as the AI seat\'s band; locked during the match; kept for the next match; removing the AI clears it', (t) => {
  const f = fixture(t), host = f.player();
  f.lobby.create(host, { mode: 'coop', difficulty: 'HARD' });
  const room = f.lobby.roomOf(host);
  f.lobby.addBot(host);
  f.lobby.addBot(host);
  assert.deepEqual(set(f, host, 1, 'band_kirara'), { ok: true });
  const n = RecordingMatch.started.length;
  assert.deepEqual(f.lobby.start(host), { ok: true });
  const seats = RecordingMatch.started[n].seats;
  assert.equal(seats[1].band, 'band_kirara');
  assert.equal(Object.hasOwn(seats[0], 'band'), false, 'a human seat carries none');
  assert.equal(Object.hasOwn(seats[2], 'band'), false, 'an automatic AI seat carries none (the options stay as without it)');
  assert.equal(set(f, host, 1, 'band_amiya').error, ERR.ROOM_STARTED);
  room.match.end();
  assert.equal(room.match, null);
  assert.equal(f.lastState(host).seats[1].band, 'band_kirara');
  assert.deepEqual(f.lobby.start(host), { ok: true });
  assert.equal(RecordingMatch.started.at(-1).seats[1].band, 'band_kirara', 'the next match too');
  room.match.end();
  assert.deepEqual(f.lobby.removeBot(host, { seat: 1 }), { ok: true });
  assert.deepEqual(f.lobby.addBot(host), { ok: true });
  assert.equal(room.seats[1].band, null);
  assert.equal(f.lastState(host).seats[1].band, null);
  assert.deepEqual(set(f, host, 2, 'band_kirara'), { ok: true }, 'the removed AI\'s strategy is free again');
});

test('not while the party is queued', (t) => {
  const f = fixture(t), host = f.player();
  f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' });
  const room = f.lobby.roomOf(host);
  assert.deepEqual(f.lobby.queue.join(host, { difficulty: room.difficulty, party: true }), { ok: true });
  assert.equal(set(f, host, 1, 'band_amiya').error, ERR.QUEUED);
});

test('the match\'s own GameData decides: 鸭爵 switched off in an expanded room is refused, and a switch-off drops it', (t) => {
  const f = fixture(t), host = f.player();
  assert.deepEqual(f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', experimental: CAP8 }), { ok: true });
  const room = f.lobby.roomOf(host);
  f.lobby.addBot(host);
  f.lobby.addBot(host);
  assert.deepEqual(set(f, host, 1, 'band_ducklord'), { ok: true });
  assert.deepEqual(set(f, host, 2, 'band_amiya'), { ok: true });
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: { ...CAP8, disableDuckLord: true } }), { ok: true });
  assert.equal(room.seats[1].band, null, 'no longer offered: back to automatic');
  assert.equal(room.seats[2].band, 'band_amiya');
  assert.deepEqual(f.lastState(host).seats.slice(1, 3).map((s) => s.band), [null, 'band_amiya']);
  assert.equal(set(f, host, 1, 'band_ducklord').error, ERR.BAD_TARGET);
  assert.deepEqual(f.lobby.setDifficulty(host, { difficulty: 'HARD' }), { ok: true });
  assert.equal(room.seats[2].band, 'band_amiya', 'a difficulty change keeps what the mode still offers');
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: CAP8 }), { ok: true });
  assert.deepEqual(set(f, host, 1, 'band_ducklord'), { ok: true });
  assert.deepEqual(f.lobby.start(host), { ok: true });
  assert.deepEqual(RecordingMatch.started.at(-1).seats.map((s) => s.band ?? null), [null, 'band_ducklord', 'band_amiya']);
});

test('over the WebSocket: the host designates, everybody sees room.state seats[].band, a malformed message is BAD_MSG', async (t) => {
  const errors = [];
  const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
  const srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: RecordingMatch, lobbyGraceMs: 60_000 });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate().catch(() => {}))); await srv.close(); });
  const connect = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    c.id = (await c.hello(name)).playerId;
    return c;
  };
  const reply = async (c, msg) => { const r = await c.request(msg); return r.t === 'ok' ? 'ok' : r.code; };
  const host = await connect('Host'), guest = await connect('Guest');
  assert.equal(await reply(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }), 'ok');
  const { code } = await host.waitFor('room.state', (s) => s.hostId === host.id);
  assert.equal(await reply(guest, { t: 'room.join', code }), 'ok');
  assert.equal(await reply(host, { t: 'room.addBot' }), 'ok');
  const added = await guest.waitFor('room.state', (s) => !!s.seats[2]?.isBot);
  assert.equal(added.seats[2].band, null);
  assert.equal(await reply(guest, { t: 'room.setBotBand', seat: 2, bandId: 'band_amiya' }), ERR.NOT_HOST);
  assert.equal(await reply(host, { t: 'room.setBotBand', seat: 2, bandId: 42 }), ERR.BAD_MSG);
  assert.equal(await reply(host, { t: 'room.setBotBand', seat: 2, bandId: 'band_amiya' }), 'ok');
  const st = await guest.waitFor('room.state', (s) => s.seats[2]?.band === 'band_amiya');
  assert.equal(Object.hasOwn(st.seats[0], 'band'), false);
  assert.equal(await reply(host, { t: 'room.setBotBand', seat: 2, bandId: null }), 'ok');
  await guest.waitFor('room.state', (s) => s.seats[2]?.band === null);
  assert.deepEqual(errors, [], 'no server errors logged');
});
