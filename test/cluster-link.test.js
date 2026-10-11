// Ingress ↔ coordinator link: framing/validation, authentication, and the in-process Network over a real link
// (ordering, close/admission semantics, fanout, backpressure, malformed frames, link loss). Local loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { ABNORMAL, LINK_PATH, MAX_CLIENT_TEXT, MAX_CONN_ID, MAX_FANOUT_TARGETS, MAX_LINK_FRAME, OP, LinkProtocolError,
  createLinkAuthenticator, decodeFrame, encodeClose, encodeData, encodeFanout, encodeOpen } from '../server/cluster/link.js';
import { createLinkServer } from '../server/cluster/link-server.js';
import { createLinkClient } from '../server/cluster/link-client.js';
import { CLOSE, Network, SessionRegistry, sendEncodedMany, sendEncodedParts, sendRaw } from '../server/net.js';

const until = async (check, label, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() >= end) throw new Error(`link fixture deadline: ${label}`); await new Promise(r => setTimeout(r, 5)); }
};
const protocol = code => error => error instanceof LinkProtocolError && error.code === code;
const info = { ip: '203.0.113.7', origin: 'https://link.invalid', proto: 'https' };

test('frames round-trip and every field is strictly validated; the sender direction is fixed per op', () => {
  assert.deepEqual(decodeFrame(encodeOpen(1, info), 'ingress'), { op: OP.OPEN, connId: 1, info });
  const data = decodeFrame(encodeData(MAX_CONN_ID, '{"t":"ping","c":1,"s":"⭐"}'), 'coordinator');
  assert.equal(data.connId, MAX_CONN_ID); assert.equal(data.data.toString(), '{"t":"ping","c":1,"s":"⭐"}');
  assert.deepEqual(decodeFrame(encodeClose(9, 4001, 'session replaced'), 'coordinator'), { op: OP.CLOSE, connId: 9, code: 4001, reason: 'session replaced' });
  assert.equal(decodeFrame(encodeClose(9, 99, 'x'.repeat(500)), 'ingress').code, ABNORMAL, 'an invalid code is sent as abnormal, the reason bounded');
  const fan = decodeFrame(encodeFanout([{ connId: 3 }, { connId: 5, prefix: '{"a":', suffix: '}' }], '"shared"'), 'coordinator');
  assert.deepEqual(fan.targets.map(t => [t.connId, t.prefix.toString(), t.suffix.toString()]), [[3, '', ''], [5, '{"a":', '}']]);
  assert.equal(fan.shared.toString(), '"shared"');
  const raw = (op, connId, payload = Buffer.alloc(0)) => { const head = Buffer.alloc(5); head[0] = op; head.writeUInt32BE(connId, 1); return Buffer.concat([head, payload]); };
  const cases = [
    [Buffer.alloc(4), 'ingress', 'BAD_FRAME'], ['not a buffer', 'ingress', 'BAD_FRAME'],
    [raw(9, 1, Buffer.from('x')), 'ingress', 'UNKNOWN_OP'], [raw(0, 1), 'ingress', 'UNKNOWN_OP'],
    [raw(OP.DATA, 0, Buffer.from('x')), 'ingress', 'BAD_CONN'], [raw(OP.DATA, MAX_CONN_ID + 1, Buffer.from('x')), 'ingress', 'BAD_CONN'],
    [raw(OP.DATA, 1), 'ingress', 'BAD_DATA'], [raw(OP.DATA, 1, Buffer.from([0xff, 0xfe])), 'ingress', 'BAD_DATA'],
    [raw(OP.DATA, 1, Buffer.alloc(MAX_CLIENT_TEXT + 1, 0x61)), 'ingress', 'BAD_DATA'],
    [encodeOpen(1, info), 'coordinator', 'BAD_OPEN'], [raw(OP.OPEN, 1, Buffer.from('{')), 'ingress', 'BAD_OPEN'],
    [raw(OP.OPEN, 1, Buffer.from(JSON.stringify({ ...info, extra: 1 }))), 'ingress', 'BAD_OPEN'],
    [raw(OP.OPEN, 1, Buffer.from(JSON.stringify({ ...info, proto: 'ftp' }))), 'ingress', 'BAD_OPEN'],
    [raw(OP.CLOSE, 1, Buffer.from([0x03])), 'ingress', 'BAD_CLOSE'], [raw(OP.CLOSE, 1, Buffer.from([0x00, 0x10])), 'ingress', 'BAD_CLOSE'],
    [raw(OP.CLOSE, 1, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.alloc(124, 0x61)])), 'ingress', 'BAD_CLOSE'],
    [encodeFanout([{ connId: 1 }], 'x'), 'ingress', 'BAD_FANOUT'], [raw(OP.FANOUT, 0), 'coordinator', 'BAD_FANOUT'],
    [raw(OP.FANOUT, MAX_FANOUT_TARGETS + 1, Buffer.alloc(12 * (MAX_FANOUT_TARGETS + 1))), 'coordinator', 'BAD_FANOUT'],
    [raw(OP.FANOUT, 2, Buffer.alloc(12)), 'coordinator', 'BAD_FANOUT'],
    [encodeFanout([{ connId: 1 }, { connId: 1 }], 'x'), 'coordinator', 'BAD_FANOUT'],
    [encodeFanout([{ connId: 1, prefix: Buffer.from([0xc3]) }], 'x'), 'coordinator', 'BAD_UTF8'],
  ];
  const huge = Buffer.alloc(12); huge.writeUInt32BE(1, 0); huge.writeUInt32BE(0xffffffff, 4);
  cases.push([raw(OP.FANOUT, 1, huge), 'coordinator', 'BAD_FANOUT']);
  for (const [frame, from, code] of cases) assert.throws(() => decodeFrame(frame, from), protocol(code), `${code} from ${from}`);
  assert.throws(() => decodeFrame(Buffer.alloc(MAX_LINK_FRAME + 1), 'coordinator'), protocol('BAD_FRAME'));
  assert.throws(() => encodeData(0, 'x'), protocol('BAD_CONN'));
  assert.throws(() => encodeFanout([], 'x'), protocol('BAD_FANOUT'));
});

test('link authentication: HMAC request with single-use nonces, bounded clock, fixed scope; the 101 proof binds the nonce', () => {
  let time = 1_000_000;
  const key = randomBytes(32), now = () => time;
  const ingress = createLinkAuthenticator({ key, scope: 'ingress-a', now }), coordinator = createLinkAuthenticator({ key, scope: 'ingress-a', now });
  const headers = ingress.sign(), nonce = coordinator.verify(headers);
  assert.equal(nonce, headers['x-ark-cluster-nonce']);
  assert.equal(coordinator.verify(headers), null, 'replay refused');
  assert.equal(ingress.verifyProof(nonce, coordinator.proof(nonce)), true);
  assert.equal(ingress.verifyProof(nonce, createLinkAuthenticator({ key: randomBytes(32), scope: 'ingress-a', now }).proof(nonce)), false);
  assert.equal(ingress.verifyProof('0'.repeat(32), coordinator.proof(nonce)), false);
  assert.equal(ingress.verifyProof(nonce, undefined), false);
  assert.equal(createLinkAuthenticator({ key: randomBytes(32), scope: 'ingress-a', now }).verify(ingress.sign()), null, 'wrong key');
  assert.equal(createLinkAuthenticator({ key, scope: 'ingress-b', now }).verify(ingress.sign()), null, 'wrong scope');
  const stale = ingress.sign(); time += 10_000;
  assert.equal(coordinator.verify(stale), null, 'expired');
  const future = ingress.sign(); time -= 1001;
  assert.equal(coordinator.verify(future), null, 'from the future');
  time += 1001;
  const bad = ingress.sign();
  for (const [name, value] of [['x-ark-cluster-signature', 'f'.repeat(64)], ['x-ark-cluster-nonce', 'xyz'], ['x-ark-cluster-time', '01']]) {
    assert.equal(coordinator.verify({ ...bad, [name]: value }), null, name);
  }
  assert.throws(() => createLinkAuthenticator({ key: randomBytes(16), scope: 'ingress-a' }), TypeError);
  assert.throws(() => createLinkAuthenticator({ key, scope: 'bad scope' }), TypeError);
});

// ---- the real Network behind a real link ----
async function linkFixture(t, { options = {}, hardBytes, pingMs } = {}) {
  const key = randomBytes(32), messages = [], closes = [], hellos = [];
  const registry = new SessionRegistry();
  const handler = {
    onHello: (session, info) => hellos.push({ session, info }),
    onMessage: (session, msg) => { messages.push({ playerId: session.playerId, msg }); return { ok: true }; },
    onDisconnect: session => closes.push(session.playerId),
  };
  const network = new Network({ registry, handler, options: { heartbeatMs: 60_000, ...options } });
  const server = createLinkServer({ network, ingresses: [{ ingressId: 'ingress-a', key }], ...(hardBytes ? { hardBytes } : {}), ...(pingMs ? { pingMs } : {}) });
  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  httpServer.on('upgrade', (req, socket, head) => { if (!server.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}/`;
  const client = createLinkClient({ url, ingressId: 'ingress-a', key, ...(pingMs ? { pingMs } : {}) });
  t.after(async () => {
    client.close(); await server.close(50); network.close();
    httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve));
  });
  assert.equal(await client.whenReady(), true);
  const channel = () => {
    const ch = client.open(info), frames = [], events = [];
    ch.on('message', (raw, binary) => { assert.equal(binary, false); frames.push(JSON.parse(raw.toString())); });
    ch.on('open', () => events.push('open'));
    ch.on('error', () => events.push('error'));
    ch.on('close', code => events.push(`close:${code}`));
    return Object.assign(ch, { frames, events, json: value => ch.send(JSON.stringify(value)) });
  };
  return { key, url, network, registry, server, client, channel, messages, closes, hellos };
}
const helloOn = async (f, ch, name = 'Linked') => {
  await until(() => ch.events.includes('open'), 'channel open');
  ch.json({ t: 'hello', name, rid: 1 });
  await until(() => ch.frames.some(m => m.t === 'welcome'), 'welcome');
  return ch.frames.find(m => m.t === 'welcome');
};

test('linked sessions keep their own order; the coordinator sees the same forwarding facts and real sessions', async t => {
  const f = await linkFixture(t), channels = [f.channel(), f.channel(), f.channel()];
  const welcomes = [];
  for (const [i, ch] of channels.entries()) welcomes.push(await helloOn(f, ch, `Linked${i}`));
  assert.equal(new Set(welcomes.map(w => w.playerId)).size, 3);
  const sessions = welcomes.map(w => f.registry.byId(w.playerId));
  assert.ok(sessions.every(s => s.ws.linked === true && s.addr === info.ip && s.limitKey === '203.0.113.7'));
  // Interleaved across sessions, within each session's 40-message rate bucket.
  for (let k = 0; k < 35; k++) for (const ch of channels) ch.json({ t: 'ping', c: k, rid: 10 + k });
  await until(() => channels.every(ch => ch.frames.filter(m => m.t === 'pong').length === 35), 'all pongs');
  for (const ch of channels) assert.deepEqual(ch.frames.filter(m => m.t === 'pong').map(m => m.c), Array.from({ length: 35 }, (_, k) => k));
  assert.deepEqual(f.server.stats(), { links: 1, sessions: 3 });
});

test('closes in both directions: browser gone → onDisconnect; replaced session → 4001 to the ingress; refused admission → error + close', async t => {
  const f = await linkFixture(t, { options: { maxConnections: 2 } });
  const a = f.channel(), welcome = await helloOn(f, a, 'Closer');
  a.close();
  await until(() => f.closes.includes(welcome.playerId), 'disconnect seen by the coordinator');
  assert.equal(f.registry.byId(welcome.playerId).connected, false);
  const first = f.channel(), firstWelcome = await helloOn(f, first, 'Twice');
  const second = f.channel();
  await until(() => second.events.includes('open'), 'second open');
  const refused = f.channel();
  await until(() => refused.events.includes(`close:${ABNORMAL}`), 'admission refusal');
  assert.deepEqual(refused.events, ['open', 'error', `close:${ABNORMAL}`], 'like a refused upgrade: the optimistic open, then the failure');
  assert.equal(f.network.connectionCount, 2);
  second.json({ t: 'hello', name: 'Twice', token: firstWelcome.token, rid: 1 });
  await until(() => first.events.includes(`close:${CLOSE.REPLACED}`), 'old channel replaced');
  await until(() => second.frames.some(m => m.t === 'welcome' && m.resumed), 'resumed on the new channel');
});

test('one fanout frame per link for many sessions; per-session prefix/suffix parts; direct sockets still get their own frame', async t => {
  const f = await linkFixture(t), channels = [f.channel(), f.channel(), f.channel()];
  for (const [i, ch] of channels.entries()) await helloOn(f, ch, `Fan${i}`);
  const sockets = [...f.network.conns.keys()];
  const link = sockets[0].link, sent = [], original = link.ws.send.bind(link.ws);
  link.ws.send = (frame, ...rest) => { sent.push(frame[0]); return original(frame, ...rest); };
  const direct = { readyState: 1, bufferedAmount: 0, frames: [], send(data, opts, cb) { this.frames.push(String(data)); cb?.(); } };
  assert.equal(sendEncodedMany([...sockets, direct], '{"t":"presence.state","online":3}'), 4);
  assert.deepEqual(sent, [OP.FANOUT]);
  assert.deepEqual(direct.frames, ['{"t":"presence.state","online":3}']);
  await until(() => channels.every(ch => ch.frames.some(m => m.t === 'presence.state')), 'fanout delivered');
  sent.length = 0;
  const entries = sockets.map((ws, i) => ({ ws, prefix: Buffer.from(`{"t":"cluster.x","i":${i},"shared":`), suffix: Buffer.from(`,"own":"${'⭐'.repeat(i)}"}`) }));
  assert.equal(sendEncodedParts([...entries, { ws: direct, prefix: Buffer.from('{"t":"cluster.x","shared":'), suffix: Buffer.from('}') }], '{"big":true}'), 4);
  assert.deepEqual(sent, [OP.FANOUT]);
  assert.equal(direct.frames.at(-1), '{"t":"cluster.x","shared":{"big":true}}');
  await until(() => channels.every(ch => ch.frames.some(m => m.t === 'cluster.x')), 'parts delivered');
  channels.forEach(ch => {
    const frame = ch.frames.find(m => m.t === 'cluster.x'), i = frame.i;
    assert.deepEqual(frame, { t: 'cluster.x', i, shared: { big: true }, own: '⭐'.repeat(i) });
  });
  // A closed or saturated session is skipped/terminated exactly like sendRaw would.
  sockets[1].pending = 17 * 1024 * 1024;
  assert.equal(sendEncodedMany(sockets, '{"t":"presence.state","online":2}'), 2);
  await until(() => channels[1].events.includes(`close:${ABNORMAL}`), 'over-hard session terminated');
});

test('per-session backpressure accounting drains to zero; a link that is not being read is dropped with all its sessions', async t => {
  const f = await linkFixture(t, { hardBytes: 512 * 1024 }), ch = f.channel(), other = f.channel();
  const welcome = await helloOn(f, ch, 'Slow'); await helloOn(f, other, 'Other');
  const session = f.registry.byId(welcome.playerId);
  assert.equal(sendRaw(session.ws, JSON.stringify({ t: 'room.state', pad: 'x'.repeat(100_000) })), true);
  assert.ok(session.ws.bufferedAmount >= 100_000);
  await until(() => session.ws.bufferedAmount === 0, 'drained');
  // The ingress stops reading: the coordinator's link queue passes its bound on the next write.
  Object.defineProperty(session.ws.link.ws, 'bufferedAmount', { get: () => 600 * 1024, configurable: true });
  sendRaw(session.ws, JSON.stringify({ t: 'room.state', pad: 'y'.repeat(1000) }));
  await until(() => f.closes.length === 2, 'both sessions on the dropped link disconnect');
  await until(() => ch.events.includes(`close:${ABNORMAL}`) && other.events.includes(`close:${ABNORMAL}`), 'ingress side closed');
  assert.equal(await f.client.whenReady(5000), true, 'the ingress re-dials');
});

test('malformed, reused or unopened connIds and unknown ops drop the link; the sessions reconnect through a new one', async t => {
  const f = await linkFixture(t);
  for (const bad of [Buffer.from([OP.DATA, 0, 0, 0, 99, 0x7b, 0x7d]), encodeOpen(1, info), Buffer.from([42, 0, 0, 0, 1]), 'text']) {
    await f.client.whenReady();
    const ch = f.channel(), welcome = await helloOn(f, ch, 'Victim');
    ch.link.ws.send(bad, { binary: typeof bad !== 'string' }); // as if the ingress itself were broken
    await until(() => ch.events.includes(`close:${ABNORMAL}`), 'ingress channel closed');
    await until(() => !f.registry.byId(welcome.playerId).connected, 'coordinator session disconnected');
    assert.equal(await f.client.whenReady(5000), true);
  }
});

test('the link path refuses unsigned, wrong-key, replayed and over-limit upgrades and requires the coordinator proof', async t => {
  const f = await linkFixture(t);
  const held = [];
  t.after(() => { for (const ws of held) ws.terminate(); });
  const status = headers => new Promise(resolve => {
    const ws = new WebSocket(f.url.replace(/^http/, 'ws') + LINK_PATH.slice(1), { headers });
    ws.on('error', () => {});
    ws.once('unexpected-response', (req, res) => { res.resume(); resolve(res.statusCode); });
    ws.once('open', () => { held.push(ws); resolve(101); });
    ws.once('error', () => resolve('error'));
  });
  const good = createLinkAuthenticator({ key: f.key, scope: 'ingress-a' });
  assert.equal(await status({}), 401);
  assert.equal(await status(createLinkAuthenticator({ key: randomBytes(32), scope: 'ingress-a' }).sign()), 401);
  assert.equal(await status(createLinkAuthenticator({ key: f.key, scope: 'ingress-z' }).sign()), 401);
  const signed = good.sign();
  assert.equal(await status(signed), 101, 'a second link per ingress is allowed');
  assert.equal(await status(signed), 401, 'replayed nonce');
  assert.equal(await status(good.sign()), 503, 'beyond the per-ingress link bound');
  // An ingress never hands sessions to a peer that cannot prove the key.
  const impostor = http.createServer();
  impostor.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '
      + (awaitAccept(req.headers['sec-websocket-key'])) + '\r\n\r\n');
  });
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
  t.after(() => { impostor.closeAllConnections(); impostor.close(); });
  const client = createLinkClient({ url: `http://127.0.0.1:${impostor.address().port}/`, ingressId: 'ingress-a', key: f.key });
  t.after(() => client.close());
  assert.equal(await client.whenReady(600), false);
  const ch = client.open(info), events = [];
  ch.on('error', () => events.push('error')); ch.on('close', code => events.push(code));
  await until(() => events.length === 2, 'no-link channel fails');
  assert.deepEqual(events, ['error', ABNORMAL]);
});

function awaitAccept(key) {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC11B85').digest('base64');
}

test('heartbeats of linked sessions belong to the ingress: no pings, no terminate, but the hello timeout still applies', async t => {
  const f = await linkFixture(t, { options: { helloTimeoutMs: 50 } });
  const ch = f.channel(), named = f.channel();
  await helloOn(f, named, 'Named');
  await until(() => ch.events.includes('open'), 'silent open');
  const conns = [...f.network.conns.values()];
  for (const conn of conns) conn.alive = false;
  await new Promise(resolve => setTimeout(resolve, 80));
  f.network.heartbeat();
  await until(() => ch.events.includes(`close:${CLOSE.HELLO_TIMEOUT}`), 'hello timeout');
  assert.equal(named.events.some(e => e.startsWith('close')), false, 'a silent link session is never terminated for a missed ping');
});

test('a frame larger than any link message fails only its own session; oversized fanouts degrade to per-session frames', async t => {
  const f = await linkFixture(t), big = f.channel(), c1 = f.channel(), c2 = f.channel();
  const a = await helloOn(f, big, 'Big'), b1 = await helloOn(f, c1, 'One'), b2 = await helloOn(f, c2, 'Two');
  sendRaw(f.registry.byId(a.playerId).ws, `{"t":"room.state","pad":"${'x'.repeat(MAX_LINK_FRAME)}"}`);
  await until(() => big.events.includes(`close:${ABNORMAL}`), 'only the oversized session closes');
  // Two 5 MiB prefixes + a 7 MiB shared part exceed one link message; each member's own frame does not.
  const parts = [b1, b2].map((w, i) => ({ ws: f.registry.byId(w.playerId).ws, prefix: Buffer.from(`{"t":"cluster.x","i":${i},"p":"${'y'.repeat(5 * 1024 * 1024)}","s":`), suffix: Buffer.from('}') }));
  assert.equal(sendEncodedParts(parts, Buffer.from('"' + 'z'.repeat(7 * 1024 * 1024) + '"')), 2);
  await until(() => [c1, c2].every(ch => ch.frames.some(m => m.t === 'cluster.x')), 'delivered as per-session data frames', 8000);
  assert.deepEqual([c1, c2].map(ch => ch.frames.find(m => m.t === 'cluster.x').i), [0, 1]);
  assert.equal([c1, c2].some(ch => ch.events.some(e => e.startsWith('close'))), false);
});
