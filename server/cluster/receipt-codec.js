// One decode + parse + shape check of an end receipt body, shared by the coordinator main thread and its
// receipt worker (receipt-worker.js). The result keeps only what the lobby forwards, already JSON-encoded:
// each member's m.result frame, the final m.public frame and the summary. JSON.stringify of a parsed value is
// deterministic, so these strings are byte-identical to encoding the parsed objects later on the main thread.
// No Node-only API beyond TextDecoder; nothing here logs a receipt.

export const RECEIPT_KEYS = Object.freeze(['assignmentId', 'generation', 'summary', 'lastPublic', 'results']);
const plain = v => !!v && typeof v === 'object'
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keys = (v, allowed) => plain(v) && Reflect.ownKeys(v).length === allowed.length
  && Reflect.ownKeys(v).every(k => allowed.includes(k));
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 128
  && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;

export class ReceiptFormatError extends Error {
  constructor() { super('BAD_REQUEST'); this.name = 'ReceiptFormatError'; this.code = 'BAD_REQUEST'; }
}

export function receiptShape(receipt, assignmentId, actorGeneration) {
  return keys(receipt, RECEIPT_KEYS) && id(receipt.assignmentId) && integer(receipt.generation, 1)
    && receipt.assignmentId === assignmentId && receipt.generation === actorGeneration
    && (receipt.lastPublic === null || (plain(receipt.lastPublic) && receipt.lastPublic.t === 'm.public')) && plain(receipt.results)
    && Object.values(receipt.results).every(v => plain(v) && v.t === 'm.result');
  // summary is the host's JSON DTO, not an invented settlement. Full message
  // schemas, replay own-keys and membership remain lobby.receiveEnd's authority.
}

/** @param {Uint8Array} bytes @param {{ assignmentId: string, actorGeneration: number }} meta */
export function decodeReceipt(bytes, meta) {
  let receipt;
  try {
    // Fatal decoding rejects malformed UTF-8; keeping a BOM makes JSON reject it
    // instead of silently treating a different wire document as valid JSON.
    receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch { throw new ReceiptFormatError(); }
  if (!receiptShape(receipt, meta.assignmentId, meta.actorGeneration)) throw new ReceiptFormatError();
  return receipt;
}

/**
 * @param {Uint8Array} bytes @param {{ assignmentId: string, actorGeneration: number }} meta
 * @returns {{ summary: string, lastPublic: string | null, results: [string, string][] }} JSON texts; results in
 *   the parsed object's own-key order
 */
export function encodeReceipt(bytes, meta) {
  const receipt = decodeReceipt(bytes, meta);
  return {
    summary: JSON.stringify(receipt.summary ?? null),
    lastPublic: receipt.lastPublic === null ? null : JSON.stringify(receipt.lastPublic),
    results: Object.entries(receipt.results).map(([member, result]) => [member, JSON.stringify(result)]),
  };
}
