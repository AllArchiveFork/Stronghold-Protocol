// deploy/stardust/tools/studio-code-source.mjs nginx --carry: which art a new material profile carries over (public/sw.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { carryDrop, changedMaterial } from '../deploy/stardust/tools/studio-code-source.mjs';

const ms = (rev, file) => `https://modelscope.cn/datasets/Stardust/arknight-assets/resolve/${rev}/releases/${file}`;

test('changedMaterial: a new dataset revision alone is no change; another object, OpenI or ModelScope, is', () => {
  const old = {
    '/assets/a.png': { fileName: 'releases/r1/assets/a.png', modelscope: ms('1'.repeat(40), 'r1/assets/a.png') },
    '/assets/b.png': { fileName: 'releases/r1/assets/b.png', modelscope: ms('1'.repeat(40), 'r1/assets/b.png') },
    '/assets/c.png': { fileName: 'releases/r1/assets/c.png', modelscope: ms('1'.repeat(40), 'r1/assets/c.png') },
    '/assets/gone.png': { fileName: 'releases/r1/assets/gone.png' },
  };
  const next = {
    '/assets/a.png': { fileName: 'releases/r1/assets/a.png', modelscope: ms('2'.repeat(40), 'r1/assets/a.png') },
    '/assets/b.png': { fileName: 'releases/r2/assets/b.png', modelscope: ms('2'.repeat(40), 'r1/assets/b.png') },
    '/assets/c.png': { fileName: 'releases/r1/assets/c.png', modelscope: ms('2'.repeat(40), 'r2/assets/c.png') },
    '/assets/new.png': { fileName: 'releases/r2/assets/new.png' },
  };
  assert.deepEqual(changedMaterial(old, next), ['/assets/b.png', '/assets/c.png']);
});

test('carryDrop: exact paths when they fit, else coarser directories, else nothing', () => {
  const changed = ['/assets/local/scene/m01/lm0.png', '/assets/local/scene/m01/lm1.png', '/assets/local/scene/m02/lm0.png', '/media/voice/x/1'];
  assert.deepEqual(carryDrop(changed, () => true), changed);
  assert.deepEqual(carryDrop(changed, (d) => d.length <= 3),
    ['/assets/local/scene/m01/', '/assets/local/scene/m02/', '/media/voice/x/']);
  assert.deepEqual(carryDrop(changed, (d) => d.length <= 2), ['/assets/local/scene/', '/media/voice/']);
  assert.deepEqual(carryDrop(changed, (d) => d.length <= 2 && d.every((p) => p.split('/').length <= 3)), ['/assets/', '/media/']);
  assert.equal(carryDrop(changed, (d) => d.length <= 1), null);
  assert.deepEqual(carryDrop([], (d) => d.length === 0), []);
});

test('nginx --carry writes materialCarry into /code-source.json and stays under the nginx token limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carry-'));
  try {
    const write = (name, entries) => { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'header-data.json'), JSON.stringify({ entries })); };
    const old = {}, next = {};
    for (let i = 0; i < 200; i++) {
      const p = `/assets/local/scene/m${i % 7}/file${i}.png`;
      old[p] = { fileName: `releases/r1${p}` };
      next[p] = { fileName: i % 2 ? `releases/r1${p}` : `releases/r2${p}` };
    }
    old['/assets/char/a.png'] = next['/assets/char/a.png'] = { fileName: 'releases/r1/assets/char/a.png' };
    write('v030', old); write('rel21', next);
    const tool = resolve('deploy/stardust/tools/studio-code-source.mjs');
    const out = execFileSync(process.execPath, [tool, 'nginx', '--base', 'https://studio.example/releases/b1/', '--material', 'rel21',
      '--carry', join(dir, 'v030'), '--material-dir', join(dir, 'rel21')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const body = out.match(/return 200 '(.*)';/)[1];
    assert.ok(body.length <= 3500);
    const json = JSON.parse(body);
    assert.equal(json.material, 'rel21');
    assert.equal(json.materialCarry.from, 'v030');
    assert.deepEqual(json.materialCarry.drop, [0, 1, 2, 3, 4, 5, 6].map((m) => `/assets/local/scene/m${m}/`));
    assert.throws(() => execFileSync(process.execPath, [tool, 'nginx', '--base', 'https://studio.example/releases/b1/', '--material', 'rel22',
      '--carry', join(dir, 'v030'), '--material-dir', join(dir, 'rel21')], { stdio: 'ignore' }), 'the material dir must be the profile');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
