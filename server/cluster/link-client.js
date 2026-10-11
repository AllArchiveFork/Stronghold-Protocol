// Ingress end of the coordinator link (link.js). open() returns a LinkChannel that the ingress uses exactly like the
// per-browser coordinator WebSocket of the direct path ('open'/'message'/'error'/'close' events, readyState,
// bufferedAmount, send, close, terminate). Channels are spread round-robin over `count` links (1 or 2); a lost link
// closes its channels (their browsers reconnect normally) and is re-dialled with backoff. The coordinator must prove
// the same link key in its 101 response, so a browser stream is never handed to an unauthenticated peer.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { ABNORMAL, LINK_PATH, MAX_CONN_ID, MAX_LINK_FRAME, OP, createLinkAuthenticator, decodeFrame, encodeClose, encodeData, encodeOpen } from './link.js';

const CONNECTING = 0, OPEN = 1, CLOSED = 3;
export const LINK_HARD_BYTES = 64 * 1024 * 1024;

export class LinkChannel extends EventEmitter {
  constructor() {
    super();
    this.readyState = CONNECTING;
    this.pending = 0;
    this.link = null;
    this.connId = 0;
  }
  get bufferedAmount() { return this.pending; }
  send(data, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    if (this.readyState !== OPEN || !this.link) { done?.(new Error('link channel not open')); return; }
    this.link.write(encodeData(this.connId, data), this, done);
  }
  close() { this.finish(1000, true); }
  terminate() { this.finish(ABNORMAL, true); }
  /** Local end: tell the coordinator (when it knew this channel), then report 'close' like a socket would. */
  finish(code, notify) {
    if (this.readyState === CLOSED) return;
    const link = this.link, open = this.readyState === OPEN;
    this.readyState = CLOSED;
    if (link) { link.channels.delete(this.connId); if (notify && open) link.write(encodeClose(this.connId, code, ''), null); }
    setImmediate(() => this.emit('close', code, Buffer.alloc(0)));
  }
  /** Remote end (coordinator CLOSE, link loss): an abnormal end surfaces as 'error' first, like a failed socket. */
  remoteClose(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (code === ABNORMAL) this.emit('error', new Error('link channel closed'));
    this.emit('close', code, Buffer.from(reason ?? ''));
  }
}

/**
 * @param {{ url: string, ingressId: string, key: Buffer, count?: number, connectMs?: number, pingMs?: number,
 *   now?: () => number, hardBytes?: number }} options
 */
export function createLinkClient({ url, ingressId, key, count = 1, connectMs = 5000, pingMs = 10_000, now = Date.now, hardBytes = LINK_HARD_BYTES }) {
  const target = new URL(url);
  if (!['http:', 'ws:'].includes(target.protocol) || target.username || target.password || target.search || target.hash
    || !['/', LINK_PATH].includes(target.pathname)) throw new TypeError('invalid link URL');
  target.protocol = 'ws:'; target.pathname = LINK_PATH;
  if (![1, 2].includes(count)) throw new RangeError('invalid link count');
  const authority = createLinkAuthenticator({ key, scope: ingressId, now });
  const links = [];
  let closed = false, cursor = 0;
  const waiters = new Set();

  function connect(slot) {
    if (closed) return;
    const headers = authority.sign(), nonce = headers['x-ark-cluster-nonce'];
    const ws = new WebSocket(target.toString(), { headers, perMessageDeflate: false, maxPayload: MAX_LINK_FRAME, handshakeTimeout: connectMs });
    const link = { ws, slot, ready: false, alive: true, channels: new Map(), nextConnId: 1, failed: false, attempts: slot.attempts,
      write(frame, channel, done) {
        if (!link.ready || link.failed) { done?.(new Error('link down')); return; }
        if (channel) channel.pending += frame.length;
        ws.send(frame, { binary: true }, error => { if (channel) channel.pending -= frame.length; done?.(error); });
        if (ws.bufferedAmount > hardBytes) fail();
      } };
    slot.link = link;
    const fail = () => {
      if (link.failed) return;
      link.failed = true; link.ready = false;
      try { ws.terminate(); } catch { /* gone */ }
      const channels = [...link.channels.values()];
      link.channels.clear();
      for (const channel of channels) channel.remoteClose(ABNORMAL, '');
      if (!closed) {
        slot.attempts = Math.min(slot.attempts + 1, 6);
        const timer = setTimeout(() => connect(slot), Math.min(5000, 100 * 2 ** slot.attempts));
        timer.unref?.();
      }
    };
    link.fail = fail;
    ws.on('upgrade', response => {
      if (!authority.verifyProof(nonce, response.headers['x-ark-cluster-link-proof'])) fail();
    });
    ws.on('open', () => {
      if (link.failed) return;
      link.ready = true; slot.attempts = 0;
      for (const resolve of [...waiters]) if (links.every(s => s.link?.ready)) { waiters.delete(resolve); resolve(true); }
    });
    ws.on('message', (data, isBinary) => {
      link.alive = true;
      try { receive(link, data, isBinary); } catch { fail(); }
    });
    ws.on('pong', () => { link.alive = true; });
    ws.on('error', fail);
    ws.on('close', fail);
  }

  function receive(link, data, isBinary) {
    if (link.failed) return;
    if (!isBinary) throw new Error('text frame');
    const message = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.concat(data), 'coordinator');
    if (message.op === OP.FANOUT) {
      for (const { connId, prefix, suffix } of message.targets) {
        if (connId >= link.nextConnId) throw new Error('unopened connId');
        const channel = link.channels.get(connId);
        if (channel?.readyState !== OPEN) continue;
        channel.emit('message', prefix.length || suffix.length ? Buffer.concat([prefix, message.shared, suffix]) : message.shared, false);
      }
      return;
    }
    if (message.connId >= link.nextConnId) throw new Error('unopened connId');
    const channel = link.channels.get(message.connId);
    if (!channel) return; // closed here already
    if (message.op === OP.DATA) { if (channel.readyState === OPEN) channel.emit('message', message.data, false); return; }
    if (message.op === OP.CLOSE) { link.channels.delete(message.connId); channel.remoteClose(message.code, message.reason); return; }
    throw new Error('unexpected op');
  }

  for (let i = 0; i < count; i++) { const slot = { link: null, attempts: 0 }; links.push(slot); connect(slot); }
  const pinger = setInterval(() => {
    for (const slot of links) {
      const link = slot.link;
      if (!link?.ready) continue;
      if (!link.alive) { link.fail(); continue; }
      link.alive = false;
      try { link.ws.ping(); } catch { link.fail(); }
    }
  }, pingMs);
  pinger.unref?.();

  return {
    /** A channel for one browser session; 'open' (or 'error' + 'close') follows asynchronously. */
    open(info) {
      const channel = new LinkChannel();
      const ready = links.map((_, i) => links[(cursor + i) % links.length].link).filter(link => link?.ready && !link.failed);
      cursor = (cursor + 1) % links.length;
      const link = ready[0];
      if (closed || !link || link.nextConnId > MAX_CONN_ID) {
        if (link && link.nextConnId > MAX_CONN_ID) link.fail(); // a fresh link restarts the id space
        setImmediate(() => channel.remoteClose(ABNORMAL, ''));
        return channel;
      }
      channel.link = link;
      channel.connId = link.nextConnId++;
      link.channels.set(channel.connId, channel);
      link.write(encodeOpen(channel.connId, info), null);
      channel.readyState = OPEN;
      setImmediate(() => { if (channel.readyState === OPEN) channel.emit('open'); });
      return channel;
    },
    /** Resolves true once every link is up (false after ms). */
    whenReady(ms = 5000) {
      if (links.every(slot => slot.link?.ready)) return Promise.resolve(true);
      return new Promise(resolve => {
        const done = value => { waiters.delete(done); clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => done(false), ms);
        timer.unref?.();
        waiters.add(done);
      });
    },
    stats: () => ({ links: links.filter(slot => slot.link?.ready).length, channels: links.reduce((n, slot) => n + (slot.link?.channels.size ?? 0), 0) }),
    /** Test/ops hook: drop every link now (their sessions close; links re-dial). */
    dropLinks() { for (const slot of links) slot.link?.fail(); },
    close() {
      closed = true;
      clearInterval(pinger);
      for (const resolve of [...waiters]) resolve(false);
      for (const slot of links) slot.link?.fail();
    },
  };
}
