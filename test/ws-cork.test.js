import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { NET_DEFAULTS, corkTurn, sendRaw } from '../server/net.js';

async function pair(t) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(wss, 'listening');
  const accepted = once(wss, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`, { perMessageDeflate: false });
  const received = [];
  client.on('message', (data) => received.push(JSON.parse(data.toString())));
  await once(client, 'open');
  const [server] = await accepted;
  t.after(() => { client.terminate(); server.terminate(); return new Promise((resolve) => wss.close(resolve)); });
  const writes = [];
  const socket = server._socket;
  const writev = socket._writev.bind(socket), write = socket._write.bind(socket);
  socket._writev = (chunks, cb) => { writes.push(chunks.length); return writev(chunks, cb); };
  socket._write = (chunk, encoding, cb) => { writes.push(1); return write(chunk, encoding, cb); };
  const arrived = async (n) => { while (received.length < n) await new Promise((resolve) => setTimeout(resolve, 2)); };
  return { server, socket, received, writes, arrived };
}
const tick = () => new Promise((resolve) => process.nextTick(resolve));
const frames = ['{"t":"b.ev","n":1}', '{"t":"b.snap","n":2}', '{"t":"m.damage","n":3}'];

test('without corkTurn each frame is its own socket write', async (t) => {
  const { server, writes, received, arrived } = await pair(t);
  for (const wire of frames) assert.equal(sendRaw(server, wire), true);
  await tick();
  assert.equal(writes.length, 3);
  await arrived(3);
  assert.deepEqual(received.map((m) => m.n), [1, 2, 3]);
});

test('corkTurn: one turn of frames leaves in one ordered socket write; the socket uncorks on nextTick', async (t) => {
  const { server, socket, writes, received, arrived } = await pair(t);
  corkTurn(server);
  corkTurn(server); // already corked this turn: no nesting
  for (const wire of frames) assert.equal(sendRaw(server, wire), true);
  assert.equal(socket.writableCorked, 1);
  assert.equal(writes.length, 0);
  assert.ok(server.bufferedAmount > 0, 'sendRaw backpressure still counts the corked bytes');
  await tick();
  assert.equal(socket.writableCorked, 0);
  assert.equal(writes.length, 1, 'header/payload chunks of all three frames in one writev');
  await arrived(3);
  assert.deepEqual(received.map((m) => m.n), [1, 2, 3]);
  corkTurn(server); // a later turn corks again
  assert.equal(sendRaw(server, frames[0]), true);
  await tick();
  assert.equal(writes.length, 2);
});

test('corkTurn keeps sendRaw soft-drop / reliable semantics and tolerates closed sockets', async (t) => {
  const { server, received, arrived } = await pair(t);
  corkTurn(server);
  assert.equal(sendRaw(server, JSON.stringify({ t: 'm.big', n: 1, pad: 'x'.repeat(NET_DEFAULTS.snapDropBytes) })), true);
  assert.equal(sendRaw(server, '{"t":"b.snap","n":2}', { droppable: true }), false, 'queued bytes above the soft limit skip b.snap');
  assert.equal(sendRaw(server, '{"t":"b.ev","n":3}'), true, 'reliable frames are still queued');
  await tick();
  await arrived(2);
  assert.deepEqual(received.map((m) => m.n), [1, 3]);
  server.terminate();
  assert.doesNotThrow(() => corkTurn(server));
  assert.doesNotThrow(() => corkTurn(null));
  assert.doesNotThrow(() => corkTurn({}));
});
