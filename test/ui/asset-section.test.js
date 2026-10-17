// 设置 → 素材下载 (fork, 2026-10-16): the two tiers of the download queue, the slow-load hint and the section's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAssetDownload, selectAssetTier } from '../../public/js/assetDownload.js';
import { withMaterialFallback, onMaterialSlow } from '../../public/js/materialFallback.js';
import { installAssetHints, keepsArt, ASSET_TIER_GB } from '../../public/js/ui/assetSection.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const URLS = ['/assets/char/a.png', '/assets/skins/x/b.png', '/assets/spine/c.skel', '/media/voice/cn/a/1', '/media/voice/jp/a/1',
  '/media/voice/en/a/1', '/media/voice/kr/a/1', '/media/voice/native/a/1', '/media/sfx/player/hit', '/media/bgm/m_x_loop'];

test('对局素材 leaves out skins and the dubs the player does not hear; 全部素材 is the upstream list', () => {
  assert.equal(selectAssetTier(URLS, { tier: 'all' }), URLS);
  assert.equal(selectAssetTier(URLS), URLS);
  assert.deepEqual(selectAssetTier(URLS, { tier: 'match', voice: 'cn' }),
    ['/assets/char/a.png', '/assets/spine/c.skel', '/media/voice/cn/a/1', '/media/sfx/player/hit', '/media/bgm/m_x_loop']);
  assert.deepEqual(selectAssetTier(URLS, { tier: 'match', voice: 'jp', native: true }).filter((u) => u.includes('/voice/')),
    ['/media/voice/cn/a/1', '/media/voice/jp/a/1', '/media/voice/native/a/1']);
  assert.deepEqual(selectAssetTier(['/assets/~0123456789abcdef/skins/x/b.png', '/media/~0123456789abcdef/voice/kr/a/1',
    '/assets/~0123456789abcdef/char/a.png'], { tier: 'match', voice: 'cn' }), ['/assets/~0123456789abcdef/char/a.png']);
  assert.deepEqual(Object.keys(ASSET_TIER_GB), ['match', 'all']);
});

test('a tier is chosen at start; files done in one tier count in the other and are not fetched again', async () => {
  const fetched = [];
  const manifest = Object.fromEntries(URLS.filter((u) => u.startsWith('/assets/')).map((u) => [u, u]));
  manifest.audio = { cn: '/assets/audio/voice/cn/a/1.mp3', jp: '/assets/audio/voice/jp/a/1.mp3' };
  const queue = createAssetDownload({ concurrency: 1, lookupImported: async () => new Set(), fetch: async (url) => {
    if (url === '/data/assets.json') return json(manifest);
    if (url.startsWith('/data/')) return new Response('', { status: 404 });
    fetched.push(url);
    return new Response('asset', { headers: { 'content-type': 'application/octet-stream' } });
  } });
  await queue.start({ tier: 'match', voice: 'cn' });
  assert.deepEqual([queue.get().phase, queue.get().total, queue.get().done], ['complete', 3, 3]);
  assert.ok(!fetched.some((u) => u.includes('/skins/') || u.includes('/voice/jp/')));
  fetched.length = 0;
  // a completed check starts over (upstream: it revalidates), so a new choice after completion lists again
  await queue.start({ tier: 'all' });
  assert.deepEqual([queue.get().phase, queue.get().total, queue.get().done], ['complete', 5, 5]);
});

test('a material load without a sign of life is reported; the hint shows once, only where art is kept and nothing runs', async () => {
  let slow = 0;
  const off = onMaterialSlow(() => { slow++; });
  await assert.rejects(withMaterialFallback('/assets/char/a.png', () => new Promise(() => {}), { origin: 'http://localhost', timeoutMs: 5, retryMs: [], fallback: false }));
  assert.equal(slow, 1);
  off();
  const shown = [];
  globalThis.sessionStorage = new Map(Object.entries({})); // getItem/setItem shim below
  globalThis.sessionStorage.getItem = (k) => globalThis.sessionStorage.get(k) ?? null;
  globalThis.sessionStorage.setItem = (k, v) => globalThis.sessionStorage.set(k, v);
  const offNoKeep = installAssetHints({ notify: (...a) => shown.push(a), keeps: () => false });
  await assert.rejects(withMaterialFallback('/assets/char/a.png', () => new Promise(() => {}), { origin: 'http://localhost', timeoutMs: 5, retryMs: [], fallback: false }));
  assert.equal(shown.length, 0);
  offNoKeep();
  const offKeep = installAssetHints({ notify: (...a) => shown.push(a), keeps: () => true });
  for (let i = 0; i < 2; i++) await assert.rejects(withMaterialFallback('/assets/char/a.png', () => new Promise(() => {}), { origin: 'http://localhost', timeoutMs: 5, retryMs: [], fallback: false }));
  assert.equal(shown.length, 1);
  assert.match(shown[0][0], /「设置 → 素材下载」/);
  assert.equal(globalThis.sessionStorage.get('sp.assetHint'), '1');
  offKeep();
  delete globalThis.sessionStorage;
});

test('the art is kept only under a worker registered with the material profile', () => {
  assert.equal(keepsArt({ serviceWorker: { controller: { scriptURL: 'https://x.test/sw.js?material=20261016-jinan-v030-r0' } } }), true);
  assert.equal(keepsArt({ serviceWorker: { controller: { scriptURL: 'https://x.test/sw.js' } } }), false);
  assert.equal(keepsArt({ serviceWorker: { controller: null } }), false);
  assert.equal(keepsArt({}), false);
});

test('settings mount 素材下载 with the player\'s dubs; boot installs the hint; no import of hashed packs is offered', () => {
  const settings = source('../../public/js/ui/settings.js'), main = source('../../public/js/main.js'), section = source('../../public/js/ui/assetSection.js');
  assert.match(settings, /<\$\{AssetSection\} voice=\$\{s\.voiceLang\} native=\$\{s\.voiceNative\} \/>/);
  assert.match(main, /installAssetHints\(\);/);
  assert.doesNotMatch(section, /AssetImportButton|assetImport/);
  assert.match(section, /ModelScope/);
  assert.match(section, /next === 'game' && BUSY\.includes\(assetDownload\.get\(\)\.phase\)/);
  assert.match(source('../../public/css/screens/game.css'), /\.set-assets \{[^}]*border-top/);
});
