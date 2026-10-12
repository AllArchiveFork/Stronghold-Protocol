// Bounded, opt-in WS compression. Credentials and unknown/control messages stay uncompressed.
// Server→browser frames share one deflate context per connection (context takeover, 32 KiB window, ~144 KiB of zlib
// state per socket): a state snapshot or battle frame mostly repeats the previous one, so it costs a fraction of its
// own size. Only allowlisted frames ever enter that context — never welcome (credential) or control messages.
const OPTIONS = Object.freeze({
  threshold: 0,
  serverNoContextTakeover: false,
  clientNoContextTakeover: true,
  serverMaxWindowBits: 15,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

// State frames and the battle stream. Deflating each small b.snap/b.ev on its own cost more CPU than it saved; with the
// shared context they shrink several-fold for little CPU.
const COMPRESSIBLE = new Set(['m.public', 'm.private', 'm.unitStats', 'm.field', 'm.damage', 'b.damage', 'b.start', 'b.snap', 'b.ev']);

export function resolveWsCompression(mode = 'off') {
  if (mode === 'off') return false;
  if (mode === 'on') return OPTIONS;
  throw new TypeError('SP_WS_COMPRESSION must be on or off');
}

export function isCompressibleType(type) {
  return typeof type === 'string' && COMPRESSIBLE.has(type);
}
