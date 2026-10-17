// The release's public copy of /sim, /shared and /data on the ModelScope Studio (STUDIO-CODE-SOURCE.md).
// Run from a checkout of the release commit (the browser data.js stand-in comes from its server/http/static.js).
//
//   stage  --localcode <dir> --build <id> --repo <studio checkout>
//          copy <dir>/{sim,shared,data} (the edge's localcode of this release, cluster-private-code.py --runtime-static)
//          to <repo>/releases/<id>/{server/sim,shared,data} plus server/data.js and SHA256SUMS. Never overwrites.
//   verify --repo <studio checkout> --build <id> --base <https URL of releases/<id>/ at the pushed commit>
//          GET every file of SHA256SUMS from the Studio: status, bytes, CORS and the JavaScript MIME of modules.
//   nginx  --base <https URL of releases/<id>/> [--material <profile>]
//          print the edge's `location = /code-source.json` for this release's private-code include. --material names
//          the active material profile: the page's service worker then keeps the art it fetches (public/sw.js).
//          Print it again with the new profile when the profile changes.
//          --carry <previous profile dir> --material-dir <this profile dir> (the edge's material-lb/<profile>/ copies,
//          both with header-data.json): add `materialCarry`, so the worker keeps the previous profile's art whose bytes
//          did not change and refetches only the rest (public/sw.js).
//
// No network access except `verify`'s GETs; no Git operation (commit / push stay manual, after authorization).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** localcode root → path under releases/<id>/ (the repository layout, so the modules' relative imports resolve). */
const TREES = [['sim', 'server/sim'], ['shared', 'shared'], ['data', 'data']];
const BUILD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function args(argv) {
  const out = { _: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function need(o, ...keys) {
  for (const k of keys) if (!o[k]) throw new Error(`--${k} is required`);
  if (o.build !== undefined && !BUILD_RE.test(o.build)) throw new Error(`--build ${o.build}: letters, digits, . _ - (6–64)`);
  if (o.base !== undefined) {
    const u = new URL(o.base);
    if (u.protocol !== 'https:' || !o.base.endsWith('/') || u.search || u.hash) throw new Error('--base: an https directory URL (trailing slash, no query)');
  }
}

/** Regular files under `dir` (relative paths, sorted); links and anything else refuse. */
async function files(dir, rel = '') {
  const out = [];
  for (const ent of (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    const st = await lstat(join(dir, r));
    if (st.isDirectory()) out.push(...await files(dir, r));
    else if (st.isFile()) out.push(r);
    else throw new Error(`${join(dir, r)}: not a regular file`);
  }
  return out;
}

async function stage(o) {
  need(o, 'localcode', 'build', 'repo');
  const src = resolve(o.localcode), repo = resolve(o.repo);
  if (!existsSync(join(repo, '.git'))) throw new Error(`${repo}: not a Git checkout`);
  const out = join(repo, 'releases', o.build);
  if (existsSync(out)) throw new Error(`${out} exists: a published release is never rewritten`);
  const plan = [];
  for (const [from, to] of TREES) {
    if (!existsSync(join(src, from))) throw new Error(`${join(src, from)} missing (generate the localcode with --runtime-static)`);
    for (const f of await files(join(src, from))) plan.push([join(src, from, f), `${to}/${f}`]);
  }
  if (plan.some(([, to]) => to === 'server/data.js')) throw new Error('localcode carries server/data.js');
  const { DATA_SHIM_JS } = await import(pathToFileURL(join(ROOT, 'server/http/static.js')).href);
  // a file Git would store through LFS is not served by the Studio's resolve as the file itself
  const lfs = execFileSync('git', ['-C', repo, 'check-attr', 'filter', '--', ...plan.map(([, to]) => `releases/${o.build}/${to}`)], { encoding: 'utf8' })
    .split('\n').filter((l) => / filter: lfs$/.test(l));
  if (lfs.length) throw new Error(`the Studio repository would store ${lfs.length} file(s) through LFS, e.g. ${lfs[0]}`);
  const sums = [];
  for (const [from, to] of plan) {
    await mkdir(dirname(join(out, to)), { recursive: true });
    await copyFile(from, join(out, to));
    sums.push([sha256(await readFile(join(out, to))), to]);
  }
  await writeFile(join(out, 'server/data.js'), DATA_SHIM_JS);
  sums.push([sha256(Buffer.from(DATA_SHIM_JS)), 'server/data.js']);
  sums.sort((a, b) => (a[1] < b[1] ? -1 : 1));
  await writeFile(join(out, 'SHA256SUMS'), sums.map(([h, p]) => `${h}  ${p}\n`).join(''));
  let bytes = 0;
  for (const [, p] of sums) bytes += (await lstat(join(out, p))).size;
  console.log(JSON.stringify({ staged: relative(repo, out).split(sep).join('/'), files: sums.length, bytes }));
}

async function verify(o) {
  need(o, 'repo', 'build', 'base');
  const dir = join(resolve(o.repo), 'releases', o.build);
  const sums = (await readFile(join(dir, 'SHA256SUMS'), 'utf8')).trim().split('\n').map((l) => l.split('  '));
  const bad = [];
  let next = 0;
  const one = async () => {
    for (let i = next++; i < sums.length; i = next++) {
      const [want, p] = sums[i];
      try {
        const res = await fetch(o.base + p, { headers: { Origin: 'https://example.invalid' }, redirect: 'manual' });
        const body = Buffer.from(await res.arrayBuffer());
        const why = res.status !== 200 ? `HTTP ${res.status}`
          : sha256(body) !== want ? 'content differs'
            : res.headers.get('access-control-allow-origin') !== '*' ? 'no Access-Control-Allow-Origin: *'
              : p.endsWith('.js') && !/javascript/i.test(res.headers.get('content-type') || '') ? `MIME ${res.headers.get('content-type')}`
                : null;
        if (why) bad.push(`${p}: ${why}`);
      } catch (err) { bad.push(`${p}: ${err.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, one));
  console.log(JSON.stringify({ checked: sums.length, failed: bad.length, examples: bad.slice(0, 10) }));
  if (bad.length) process.exitCode = 1;
}

/** nginx refuses a config token longer than its 4 KiB read buffer; the whole `return` body must stay below it. */
const CODE_SOURCE_BODY_MAX = 3500;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What an alias serves: its OpenI object and its ModelScope object without the dataset revision (release paths are immutable). */
const materialIdentity = (entry) => JSON.stringify([entry.fileName,
  typeof entry.modelscope === 'string' ? entry.modelscope.replace(/^https:\/\/modelscope\.cn\/datasets\/[^/]+\/[^/]+\/resolve\/[0-9a-f]+\//, '') : null]);

/** Aliases of both profiles whose bytes may differ (sorted). Removed aliases are never requested; added ones were never kept. */
export function changedMaterial(oldEntries, newEntries) {
  return Object.keys(newEntries).filter((p) => Object.hasOwn(oldEntries, p)
    && materialIdentity(oldEntries[p]) !== materialIdentity(newEntries[p])).sort();
}

/** The parent directory of a path or directory (`/a/b/c.png` → `/a/b/`, `/a/b/` → `/a/`). */
const parentDir = (p) => p.slice(0, p.slice(0, -1).lastIndexOf('/') + 1);

/**
 * `drop` for materialCarry within `fits(drop)`: the changed paths, else their directories, coarser until it fits; null
 * when even /assets/ and /media/ themselves do not (then nothing is carried, as before).
 */
export function carryDrop(changed, fits) {
  let drop = [...changed];
  for (;;) {
    if (fits(drop)) return drop;
    if (drop.every((p) => /^\/(?:assets|media)\/$/.test(p))) return null;
    const next = [...new Set(drop.map((p) => (/^\/(?:assets|media)\/$/.test(p) ? p : parentDir(p))))].sort();
    drop = next.filter((p) => !next.some((q) => q !== p && p.startsWith(q)));
  }
}

async function materialCarry(o) {
  if (o.carry === undefined && o['material-dir'] === undefined) return null;
  if (!o.carry || !o['material-dir'] || !o.material) throw new Error('--carry needs --material and --material-dir');
  const from = basename(resolve(o.carry));
  if (!PROFILE_RE.test(from) || from === o.material) throw new Error('--carry: the directory of another profile');
  if (basename(resolve(o['material-dir'])) !== o.material) throw new Error('--material-dir: the directory of --material');
  const read = async (dir) => JSON.parse(await readFile(join(dir, 'header-data.json'), 'utf8')).entries;
  const changed = changedMaterial(await read(o.carry), await read(o['material-dir']));
  return { from, changed };
}

function codeSourceBody(o, carry) {
  const base = { version: 1, sim: `${o.base}server/sim/`, data: `${o.base}data/`, ...(o.material ? { material: o.material } : {}) };
  if (!carry) return JSON.stringify(base);
  const withDrop = (drop) => JSON.stringify({ ...base, materialCarry: { from: carry.from, drop } });
  const drop = carryDrop(carry.changed, (d) => withDrop(d).length <= CODE_SOURCE_BODY_MAX);
  console.error(JSON.stringify({ carryFrom: carry.from, changed: carry.changed.length, drop: drop ? drop.length : null }));
  return drop ? withDrop(drop) : JSON.stringify(base);
}

async function nginx(o) {
  need(o, 'base');
  if (o.material !== undefined && !PROFILE_RE.test(o.material)) throw new Error('--material: a profile id (letters, digits, . _ -)');
  const body = codeSourceBody(o, await materialCarry(o));
  if (body.includes("'") || body.includes('$')) throw new Error('unexpected quote or $ in --base or a material path');
  process.stdout.write(`location = /code-source.json {
    auth_request /_gate/check;
    if ($request_method !~ ^(GET|HEAD)$) { return 405; }
    default_type application/json;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options $ark_proto_frame always;
    add_header Referrer-Policy same-origin always;
    add_header Cache-Control "private, no-store" always;
    add_header Content-Security-Policy $ark_proto_csp always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    return 200 '${body}';
}
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const o = args(process.argv.slice(2));
  const commands = { stage, verify, nginx };
  if (!commands[o._]) {
    console.error('usage: studio-code-source.mjs stage|verify|nginx … (see the header)');
    process.exit(2);
  }
  await commands[o._](o);
}
