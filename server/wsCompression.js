// Bounded, opt-in WS compression. Credentials and unknown/control messages stay uncompressed.
const OPTIONS = Object.freeze({
  threshold: 512,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  serverMaxWindowBits: 12,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

// Only the large, low-rate state frames. The high-rate battle stream (b.snap/b.ev, ~15 frames per watcher per second,
// mostly under 1 KiB) stays plain: per-message deflate of those cost more CPU than the few bytes it saved.
const COMPRESSIBLE = new Set(['m.public', 'm.private', 'm.unitStats', 'm.field', 'm.damage', 'b.damage']);

export function resolveWsCompression(mode = 'off') {
  if (mode === 'off') return false;
  if (mode === 'on') return OPTIONS;
  throw new TypeError('SP_WS_COMPRESSION must be on or off');
}

export function isCompressibleType(type) {
  return typeof type === 'string' && COMPRESSIBLE.has(type);
}
