// The release's Studio copy of /sim, /shared and /data (public/js/codeSource.js, deploy/stardust/STUDIO-CODE-SOURCE.md):
// /code-source.json parsing, the data / asset-manifest fetches with their fallback to this host, and the simulation
// loader (one origin for the whole module graph, sticky fallback).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCodeSource, createCodeSource, LOCAL_ONLY_DATA } from '../public/js/codeSource.js';
import { createDataStore } from '../public/js/data.js';
import { createAssets } from '../public/js/assets.js';
import { loadSimFrom } from '../public/js/battle/runner.js';

const STUDIO = 'https://modelscope.cn/studio/Stardust/arknight-proto/resolve/0123456789abcdef0123456789abcdef01234567/releases/b1/';
const SOURCE = { version: 1, sim: `${STUDIO}server/sim/`, data: `${STUDIO}data/` };

const json = (v, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => v });

/** A fetch over a URL → response table; records [url, init] of each call. Unknown URLs answer 404. */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push([url, init]);
    const v = table[url];
    if (typeof v === 'function') return v(init);
    return v === undefined ? json({}, 404) : v;
  };
  fn.calls = calls;
  fn.urls = () => calls.map(([u]) => u);
  return fn;
}

/** Silence (and keep) console.warn for one test. */
async function quiet(fn) {
  const w = console.warn, seen = [];
  console.warn = (...a) => seen.push(a.join(' '));
  try { return await fn(seen); } finally { console.warn = w; }
}

describe('parseCodeSource', () => {
  test('accepts https directory bases (http on the loopback) only', () => {
    assert.deepEqual(parseCodeSource(SOURCE), { sim: SOURCE.sim, data: SOURCE.data });
    const loop = { version: 1, sim: 'http://127.0.0.1:8123/r/server/sim/', data: 'http://localhost:8123/r/data/' };
    assert.deepEqual(parseCodeSource(loop), { sim: loop.sim, data: loop.data });
    assert.equal(parseCodeSource({ ...loop, sim: 'http://10.0.0.1/r/server/sim/' }), null);
    for (const bad of [
      null, [], { ...SOURCE, version: 2 }, { ...SOURCE, sim: 'http://modelscope.cn/x/' }, { ...SOURCE, data: `${STUDIO}data` },
      { ...SOURCE, sim: `${STUDIO}server/sim/?x=1` }, { ...SOURCE, sim: `${STUDIO}server/sim/#a` }, { ...SOURCE, data: '/data/' },
      { ...SOURCE, data: 'https://u:p@modelscope.cn/d/' }, { version: 1, sim: SOURCE.sim },
    ]) assert.equal(parseCodeSource(bad), null, JSON.stringify(bad));
  });

  test('fork: an optional material profile (the service worker\'s art cache key), with or without the Studio copy', () => {
    assert.deepEqual(parseCodeSource({ ...SOURCE, material: '20261016-jinan-v030-r0' }), { sim: SOURCE.sim, data: SOURCE.data, material: '20261016-jinan-v030-r0' });
    assert.deepEqual(parseCodeSource({ version: 1, material: 'v030' }), { sim: null, data: null, material: 'v030' });
    for (const material of ['', '../x', 'a b', 'x'.repeat(65), 1]) {
      assert.deepEqual(parseCodeSource({ ...SOURCE, material }), { sim: SOURCE.sim, data: SOURCE.data }, String(material));
      assert.equal(parseCodeSource({ version: 1, material }), null);
    }
  });
});

describe('createCodeSource', () => {
  test('fetches /code-source.json once, with the page credentials and no cache', async () => {
    const fetch = fakeFetch({ '/code-source.json': json(SOURCE) });
    const src = createCodeSource({ fetch });
    assert.equal(await src.base('sim'), SOURCE.sim);
    assert.equal(await src.base('data'), SOURCE.data);
    assert.deepEqual(fetch.urls(), ['/code-source.json']);
    assert.equal(fetch.calls[0][1].cache, 'no-store');
    assert.equal(fetch.calls[0][1].credentials, 'same-origin');
  });

  test('no copy: a 404, a bad body, an invalid source or a hang leave this host', async () => {
    for (const answer of [json({}, 404), { ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }, json({ version: 1 })]) {
      const src = createCodeSource({ fetch: fakeFetch({ '/code-source.json': answer }) });
      assert.equal(await src.base('sim'), null);
      assert.equal(await src.base('data'), null);
    }
    const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const src = createCodeSource({ fetch: fakeFetch({ '/code-source.json': hang }), timeoutMs: 20 });
    assert.equal(await src.base('sim'), null);
  });

  test('fetchData: the Studio copy without credentials, local-only files from this host', async () => {
    const fetch = fakeFetch({ '/code-source.json': json(SOURCE), [`${SOURCE.data}chess.json`]: json({ a: 1 }), '/data/announcements.json': json([]) });
    const src = createCodeSource({ fetch });
    const res = await src.fetchData('chess.json', '/data/chess.json', { cache: 'no-cache' });
    assert.deepEqual(await res.json(), { a: 1 });
    const [, init] = fetch.calls.find(([u]) => u === `${SOURCE.data}chess.json`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-cache');
    for (const name of LOCAL_ONLY_DATA) await src.fetchData(name, `/data/${name}`);
    assert.ok(fetch.urls().includes('/data/announcements.json') && fetch.urls().includes('/data/local-assets.json'));
    assert.ok(!fetch.urls().some((u) => u === `${SOURCE.data}announcements.json` || u === `${SOURCE.data}local-assets.json`));
  });

  test('fetchData: a failed or slow Studio file falls back to this host, and later files skip the Studio', async () => {
    await quiet(async (warns) => {
      const fetch = fakeFetch({
        '/code-source.json': json(SOURCE),
        '/data/chess.json': json({ local: true }), '/data/items.json': json({ local: true }),
      });
      const src = createCodeSource({ fetch });
      assert.deepEqual(await (await src.fetchData('chess.json', '/data/chess.json')).json(), { local: true });
      assert.deepEqual(await (await src.fetchData('items.json', '/data/items.json')).json(), { local: true });
      assert.deepEqual(fetch.urls(), ['/code-source.json', `${SOURCE.data}chess.json`, '/data/chess.json', '/data/items.json']);
      assert.equal(warns.length, 1, 'warned once');
      assert.equal(await src.base('data'), null);
      assert.equal(await src.base('sim'), SOURCE.sim, 'the simulation copy is judged on its own');

      const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      const slow = createCodeSource({ fetch: fakeFetch({ '/code-source.json': json(SOURCE), [`${SOURCE.data}chess.json`]: hang, '/data/chess.json': json({ local: 1 }) }), dataTimeoutMs: 20 });
      assert.deepEqual(await (await slow.fetchData('chess.json', '/data/chess.json')).json(), { local: 1 });
    });
  });

  test('fetchData: the caller aborting is not a Studio failure', async () => {
    const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const src = createCodeSource({ fetch: fakeFetch({ '/code-source.json': json(SOURCE), [`${SOURCE.data}chess.json`]: hang }) });
    const controller = new AbortController();
    const p = src.fetchData('chess.json', '/data/chess.json', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(p);
    assert.equal(await src.base('data'), SOURCE.data);
  });
});

describe('data store and asset manifest', () => {
  test('createDataStore({ source }) reads the Studio copy; the store fetch stays the fallback', async () => {
    await quiet(async () => {
      const remote = fakeFetch({ '/code-source.json': json(SOURCE), [`${SOURCE.data}chess.json`]: json({ chess_a: { name: 'A' } }) });
      const local = fakeFetch({ '/data/chess.json': json({ chess_a: { name: 'local' } }), '/data/items.json': json({ version: 2, items: [{ id: 'it1', name: 'I' }] }) });
      const d = createDataStore({ fetch: local, source: createCodeSource({ fetch: remote }) });
      await d.load('chess');
      assert.equal(d.lookup('chess', 'chess_a').name, 'A');
      await d.load('items');
      assert.equal(d.lookup('items', 'it1').name, 'I', 'Studio 404 → this host');
      assert.deepEqual(local.urls(), ['/data/items.json']);
    });
  });

  test('createAssets({ source }) fetches assets.json from the Studio copy; a custom url never does', async () => {
    const remote = fakeFetch({ '/code-source.json': json(SOURCE), [`${SOURCE.data}assets.json`]: json({ version: 7, chars: {} }) });
    const local = fakeFetch({});
    const a = createAssets({ fetch: local, source: createCodeSource({ fetch: remote }) });
    assert.equal((await a.ready()).version, 7);
    assert.deepEqual(local.urls(), []);
    const own = fakeFetch({ '/x/assets.json': json({ version: 8, chars: {} }) });
    const b = createAssets({ url: '/x/assets.json', fetch: own, source: createCodeSource({ fetch: remote }) });
    assert.equal((await b.ready()).version, 8);
  });
});

describe('loadSimFrom', () => {
  test('loads the whole simulation from the Studio copy', async () => {
    const calls = [];
    const load = async (o) => { calls.push(o); return { from: o ? 'studio' : 'host' }; };
    const src = createCodeSource({ fetch: fakeFetch({ '/code-source.json': json(SOURCE) }) });
    assert.deepEqual(await loadSimFrom(src, { load }), { from: 'studio' });
    assert.deepEqual(calls, [{ base: SOURCE.sim, dataBase: SOURCE.data }]);
  });

  test('no copy, a failure or a hang: this host, and the next load skips the Studio', async () => {
    await quiet(async () => {
      const none = [];
      await loadSimFrom(createCodeSource({ fetch: fakeFetch({}) }), { load: async (o) => { none.push(o); } });
      assert.deepEqual(none, [undefined]);

      const calls = [];
      const src = createCodeSource({ fetch: fakeFetch({ '/code-source.json': json(SOURCE) }) });
      const failing = async (o) => { calls.push(o); if (o) throw new Error('import failed'); return { from: 'host' }; };
      assert.deepEqual(await loadSimFrom(src, { load: failing }), { from: 'host' });
      assert.deepEqual(await loadSimFrom(src, { load: failing }), { from: 'host' });
      assert.deepEqual(calls, [{ base: SOURCE.sim, dataBase: SOURCE.data }, undefined, undefined]);

      const slow = createCodeSource({ fetch: fakeFetch({ '/code-source.json': json(SOURCE) }) });
      const hanging = (o) => (o ? new Promise(() => {}) : Promise.resolve({ from: 'host' }));
      assert.deepEqual(await loadSimFrom(slow, { load: hanging, timeoutMs: 20 }), { from: 'host' });
      assert.equal(await slow.base('sim'), null);
    });
  });

  test('a failed data copy leaves the simulation on the Studio with this host\'s data', async () => {
    await quiet(async () => {
      const src = createCodeSource({ fetch: fakeFetch({ '/code-source.json': json(SOURCE) }) });
      src.fail('data', new Error('x'));
      const calls = [];
      await loadSimFrom(src, { load: async (o) => { calls.push(o); } });
      assert.deepEqual(calls, [{ base: SOURCE.sim }]);
    });
  });
});
