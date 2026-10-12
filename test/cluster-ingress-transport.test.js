// Ingress transport: which relayed frames are compressed, byte-exact passthrough of game and control frames, order
// across compressed and plain frames, and per-turn write coalescing — over direct control sockets and over the
// multiplexed coordinator link. Small local fixtures for the coordinator and the game node; loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { startIngress } from '../server/cluster/ingress.js';
import { createLinkServer } from '../server/cluster/link-server.js';
import { Network, SessionRegistry, sendEncodedParts, sendRaw } from '../server/net.js';
import { PROTOCOL_VERSION } from '../shared/constants.js';

const ORIGIN = 'https://ingress-transport.invalid';
const ELIGIBLE = ['m.public', 'm.private', 'm.unitStats', 'm.field', 'm.damage', 'b.damage', 'b.snap', 'b.ev'];
const until = async (check, label, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() >= end) throw new Error(`transport fixture deadline: ${label}`); await new Promise(r => setTimeout(r, 5)); }
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const urlOf = server => `http://127.0.0.1:${server.address().port}`;
/** A large JSON text of one type with non-ASCII content (CJK, astral, U+2028) that compresses well. */
const big = (t, seq) => JSON.stringify({ t, seq, rows: Array.from({ length: 40 }, (_, i) => ({ i, name: `干员⭐\u2028${i % 4}`, hp: 1000 })) });

/** RFC 6455 metadata of the text frames read by a client socket, in order (payload skipped). */
function wireFrames(socket) {
  const frames = [];
  let header = Buffer.alloc(0), remaining = 0, current = null;
  socket.on('data', chunk => {
    let offset = 0;
    while (offset < chunk.length) {
      if (current) {
        const n = Math.min(remaining, chunk.length - offset);
        remaining -= n; offset += n;
        if (!remaining) { if (current.opcode === 1) frames.push(current); current = null; }
        continue;
      }
      const need = header.length < 2 ? 2 : 2 + ((header[1] & 127) === 126 ? 2 : (header[1] & 127) === 127 ? 8 : 0);
      const n = Math.min(need - header.length, chunk.length - offset);
      header = Buffer.concat([header, chunk.subarray(offset, offset + n)]); offset += n;
      if (header.length < need || header.length < 2) continue;
      const kind = header[1] & 127;
      if ((kind === 126 && header.length < 4) || (kind === 127 && header.length < 10)) continue;
      const payloadBytes = kind === 126 ? header.readUInt16BE(2) : kind === 127 ? Number(header.readBigUInt64BE(2)) : kind;
      current = { opcode: header[0] & 15, rsv1: !!(header[0] & 64), payloadBytes, wireBytes: header.length + payloadBytes };
      header = Buffer.alloc(0); remaining = payloadBytes;
      if (!remaining) { if (current.opcode === 1) frames.push(current); current = null; }
    }
  });
  return frames;
}

async function fixture(t, mode) {
  // Game node stand-in: binds the ingress' game channel and lets the test push raw frames down it.
  const gameServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const gameWss = new WebSocketServer({ server: gameServer, path: '/_cluster/game', perMessageDeflate: false });
  let gameSocket = null; const toGame = [];
  gameWss.on('connection', socket => {
    socket.on('error', () => {});
    socket.once('message', raw => {
      const bind = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ t: 'cluster.bound', assignmentId: bind.assignmentId, sessionId: bind.sessionId }));
      socket.send(JSON.stringify({ t: 'cluster.started', assignmentId: bind.assignmentId, sessionId: bind.sessionId }));
      socket.on('message', data => toGame.push(Buffer.from(data)));
      gameSocket = socket;
    });
  });
  await listen(gameServer);
  // Coordinator: a fixture control socket per browser (direct), or a real Network behind a real link server.
  const controlServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  let toSession, link = null, session = null, network = null, linkServer = null, controlWss = null;
  if (mode === 'link') {
    const key = randomBytes(32);
    network = new Network({ registry: new SessionRegistry(), options: { heartbeatMs: 60_000 },
      handler: { onHello: s => { session = s; }, onMessage: () => ({ ok: true }), onDisconnect() {} } });
    linkServer = createLinkServer({ network, ingresses: [{ ingressId: 'ingress-a', key }] });
    controlServer.on('upgrade', (req, socket, head) => { if (!linkServer.handleUpgrade(req, socket, head)) socket.destroy(); });
    await listen(controlServer);
    link = { url: `${urlOf(controlServer)}/`, ingressId: 'ingress-a', key };
    toSession = data => sendRaw(session.ws, data);
  } else {
    controlWss = new WebSocketServer({ server: controlServer, path: '/ws', perMessageDeflate: false });
    let control = null;
    controlWss.on('connection', socket => {
      socket.on('error', () => {});
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.t === 'hello') { control = socket; session = { playerId: 'p1' }; socket.send(JSON.stringify({ t: 'welcome', playerId: 'p1', token: 'fixture-only-token' })); }
      });
    });
    await listen(controlServer);
    toSession = data => { control.send(data); return true; };
  }
  const ingress = await startIngress({ coordinatorUrl: urlOf(controlServer), nodes: [{ nodeId: 'game-a', url: urlOf(gameServer) }],
    origins: [ORIGIN], shutdownMs: 100, ...(link ? { link } : {}) });
  if (ingress.link) assert.equal(await ingress.link.whenReady(), true);
  const browser = new WebSocket(`${ingress.url.replace(/^http/, 'ws')}/ws`, { origin: ORIGIN, perMessageDeflate: true });
  const received = [];
  browser.on('message', (data, binary) => { assert.equal(binary, false); received.push(Buffer.from(data)); });
  browser.on('error', () => {});
  const closed = new Promise(resolve => browser.once('close', code => resolve(code)));
  await new Promise((resolve, reject) => { browser.once('open', resolve); browser.once('error', reject); });
  const wire = wireFrames(browser._socket);
  t.after(async () => {
    browser.terminate();
    await ingress.close();
    for (const socket of gameWss.clients) socket.terminate();
    await new Promise(resolve => gameWss.close(resolve));
    gameServer.closeAllConnections(); await new Promise(resolve => gameServer.close(resolve));
    if (linkServer) { await linkServer.close(50); network.close(); }
    if (controlWss) { for (const socket of controlWss.clients) socket.terminate(); await new Promise(resolve => controlWss.close(resolve)); }
    controlServer.closeAllConnections(); await new Promise(resolve => controlServer.close(resolve));
  });
  browser.send(JSON.stringify({ t: 'hello', name: 'Transport', version: PROTOCOL_VERSION }));
  await until(() => received.some(b => JSON.parse(b).t === 'welcome'), 'welcome');
  assert.equal(toSession(JSON.stringify({ t: 'cluster.prepare', assignmentId: 'a-1', nodeId: 'game-a', sessionId: session.playerId,
    ticket: 'fixture-ticket', published: true })), true);
  await until(() => gameSocket, 'game channel bound');
  await new Promise(r => setTimeout(r, 20)); // let cluster.bound/started reach the ingress
  const serverSide = [...ingress.wss.clients][0];
  return { ingress, browser, received, wire, closed, toGame, serverSide, session,
    game: data => gameSocket.send(data), control: toSession,
    fanout: (shared, prefix, suffix) => sendEncodedParts([{ ws: session.ws, prefix: Buffer.from(prefix), suffix: Buffer.from(suffix) }], shared),
    /** Wait for the next n frames after `from` and return them with their wire metadata. */
    async next(from, n) { await until(() => received.length >= from + n && wire.length >= from + n, `${n} frames`); return received.slice(from, from + n).map((data, i) => ({ data, frame: wire[from + i] })); } };
}

for (const mode of ['direct', 'link']) {
  test(`[${mode}] state frames and the battle stream are compressed, control frames stay plain, bytes arrive unchanged`, async t => {
    const f = await fixture(t, mode);
    assert.equal(f.browser.extensions, 'permessage-deflate');
    const welcome = f.received.findIndex(b => JSON.parse(b).t === 'welcome');
    assert.equal(f.wire[welcome].rsv1, false, 'the credential-bearing welcome stays plain');
    let at = f.received.length, seq = 0;
    const sent = [];
    for (const type of [...ELIGIBLE, 'b.sync']) { const text = big(type, ++seq); sent.push([type, text]); f.game(text); }
    const got = await f.next(at, sent.length);
    sent.forEach(([type, text], i) => {
      const { data, frame } = got[i], bytes = Buffer.from(text);
      assert.ok(data.equals(bytes), `${type}: the exact UTF-8 bytes`);
      const compress = ELIGIBLE.includes(type);
      assert.equal(frame.rsv1, compress, `${type} compression`);
      if (compress) assert.ok(frame.wireBytes < bytes.length * 0.5, `${type} is deflated on the wire`);
      else assert.equal(frame.payloadBytes, bytes.length, `${type} is sent as is`);
    });
    // Control frames (direct socket / link DATA and FANOUT) are relayed unchanged and stay plain.
    at = f.received.length;
    const room = big('room.state', seq + 1);
    assert.equal(f.control(room), true);
    const expected = [Buffer.from(room)];
    if (mode === 'link') {
      assert.equal(f.fanout('"共享⭐\u2028"', '{"t":"presence.state","online":', ',"x":"é"}'), 1);
      expected.push(Buffer.from('{"t":"presence.state","online":"共享⭐\u2028","x":"é"}'));
    }
    const control = await f.next(at, expected.length);
    control.forEach(({ data, frame }, i) => { assert.ok(data.equals(expected[i]), 'control bytes'); assert.equal(frame.rsv1, false); });
    // Browser intents reach the game node byte for byte.
    const intent = JSON.stringify({ t: 'ping', c: 1.5, rid: 7, note: '中文' });
    f.browser.send(intent);
    await until(() => f.toGame.length, 'intent at the game node');
    assert.ok(f.toGame[0].equals(Buffer.from(intent)));
  });

  test(`[${mode}] order holds across compressed and plain frames, and a plain burst leaves in few socket writes`, async t => {
    const f = await fixture(t, mode);
    const socket = f.serverSide._socket;
    let writes = 0;
    for (const name of ['_write', '_writev']) {
      const original = socket[name];
      socket[name] = function (...args) { writes++; return original.apply(this, args); };
    }
    let at = f.received.length;
    const burst = Array.from({ length: 40 }, (_, i) => JSON.stringify({ t: i % 2 ? 'b.sync' : 'm.ticker', seq: i, units: [[i, 1, 2, 3]] }));
    for (const text of burst) f.game(text);
    const plain = await f.next(at, burst.length);
    assert.deepEqual(plain.map(x => JSON.parse(x.data).seq), burst.map((_, i) => i));
    assert.ok(writes <= 5, `40 frames of one turn were coalesced (${writes} writes)`);
    at = f.received.length;
    const mixed = Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? big('m.public', i) : JSON.stringify({ t: ['b.ev', 'b.sync', 'm.ticker'][i % 3], seq: i })));
    for (const text of mixed) f.game(text);
    const got = await f.next(at, mixed.length);
    assert.deepEqual(got.map(x => JSON.parse(x.data).seq), mixed.map((_, i) => i), 'delivery order is the send order');
    assert.deepEqual(got.map(x => x.frame.rsv1), mixed.map((_, i) => i % 7 === 3 || i % 3 === 0));
    assert.equal(f.serverSide.bufferedAmount, 0);
  });

  test(`[${mode}] node end frames stay filtered and a node cluster.* frame still closes the browser`, async t => {
    const f = await fixture(t, mode);
    const at = f.received.length;
    f.game(JSON.stringify({ t: 'm.public', phase: 'RESULT', seq: 1 }));
    f.game(JSON.stringify({ t: 'm.result', seq: 2 }));
    f.game(JSON.stringify({ t: 'm.public', phase: 'PREP', seq: 3 }));
    const [next] = await f.next(at, 1);
    assert.equal(JSON.parse(next.data).seq, 3);
    f.game(JSON.stringify({ t: 'cluster.bound', assignmentId: 'other', sessionId: 'other' }));
    assert.equal(await f.closed, 1011);
  });
}
