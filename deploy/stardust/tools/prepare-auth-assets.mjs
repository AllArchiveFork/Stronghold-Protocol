// Rebuild ignored PRTS dependencies from the root lockfile and the already installed local font.
import { readFile, writeFile, copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const three = resolve(root, 'node_modules/three');
const altcha = resolve(root, 'node_modules/altcha');
const altchaLib = resolve(root, 'node_modules/altcha-lib');
const output = resolve(root, 'deploy/stardust/auth/public');
// The gate imports altcha-lib by package name; the image carries only its ESM build, manifest and license.
const libOutput = resolve(root, 'deploy/stardust/auth/node_modules/altcha-lib');
const license = (await readFile(resolve(three, 'LICENSE'), 'utf8')).trimEnd();
const header = `/*\n${license}\n\n*/\n`;
const font = resolve(root, 'public/fonts/bender-regular.woff2');
// Read all prerequisites before writing generated output; this command never downloads assets.
const [moduleSource, coreSource, css3dSource, fontData, workerSource, altchaLicense] = await Promise.all([
  readFile(resolve(three, 'build/three.module.js'), 'utf8'),
  readFile(resolve(three, 'build/three.core.js'), 'utf8'),
  readFile(resolve(three, 'examples/jsm/renderers/CSS3DRenderer.js'), 'utf8'),
  readFile(font),
  readFile(resolve(altcha, 'dist/workers/pbkdf2.js'), 'utf8'),
  readFile(resolve(altcha, 'LICENSE.txt'), 'utf8'),
]);
if (css3dSource.split("from 'three'").length !== 2) throw new Error('Unexpected CSS3D import; review this deployment adapter before updating');
if (/^\s*(?:import|export)\b/m.test(workerSource)) throw new Error('The ALTCHA worker is no longer a classic script; review this deployment adapter before updating');
if (!fontData.length) throw new Error('The local Bender font is empty; complete the asset setup first');
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, 'three.module.js'), header + moduleSource),
  writeFile(resolve(output, 'three.core.js'), header + coreSource),
  writeFile(resolve(output, 'css3d.js'), header + css3dSource.replace("from 'three'", "from './three.module.js'")),
  copyFile(font, resolve(output, 'bender-regular.woff2')),
  writeFile(resolve(output, 'altcha-pbkdf2.js'), `/*\n${altchaLicense.trimEnd()}\n\n*/\n` + workerSource),
]);
await rm(libOutput, { recursive: true, force: true });
await cp(resolve(altchaLib, 'dist/esm'), resolve(libOutput, 'dist/esm'), { recursive: true, filter: source => !source.endsWith('.d.ts') });
await Promise.all(['package.json', 'LICENSE.txt'].map(name => copyFile(resolve(altchaLib, name), resolve(libOutput, name))));
console.log('Prepared PRTS runtime libraries/font from local dependencies; no secrets or network access used.');
