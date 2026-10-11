// Coordinator receipt worker: verifies the SHA-256 of one large end receipt, then decodes, parses and
// re-encodes it off the main thread (receipt-codec.js). Pure function of the copied bytes; no sockets,
// timers, files or logs. The main thread keeps its bytes and runs the same steps inline when this worker is
// unavailable, so a reply here never decides anything the inline path would not.
import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { encodeReceipt } from './receipt-codec.js';

parentPort.on('message', ({ id, bytes, meta }) => {
  let reply;
  try {
    if (bytes.length !== meta.totalBytes || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error('digest');
    reply = { id, ok: true, value: encodeReceipt(bytes, meta) };
  } catch { reply = { id, ok: false }; }
  parentPort.postMessage(reply);
});
