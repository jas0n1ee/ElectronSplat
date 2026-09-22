import { build } from 'esbuild';
import { writeAppLicenses } from './licenses.mjs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, cp, rm } from 'node:fs/promises';
const out = '.build/electron';
let revision='untracked';try{revision=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim()+(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()?'-dirty':'');}catch{}
const buildId=`${revision}@${new Date().toISOString()}`;
const { version, name, author, license, repository } = JSON.parse(await readFile('package.json', 'utf8'));
await rm(out, {recursive:true,force:true});
await mkdir(`${out}/ui/assets`, { recursive: true });
await mkdir(`${out}/desktop`, { recursive: true });
const shared = { bundle: true, minify: true, target: ['chrome140'], format: 'iife', platform: 'browser', logLevel: 'warning', external: ['node:*','module','fs','path','url','worker_threads','os','util'], define: { 'import.meta.url': '"portable://app/assets/app.js"', __APP_VERSION__: JSON.stringify(version), __APP_BUILD__:JSON.stringify(buildId) } };
await build({ ...shared, entryPoints: ['src/app.ts'], outfile: `${out}/ui/assets/app.js` });
// worker-src must allow blob:. PlayCanvas sorts splats in a Worker built from an in-memory Blob, and
// every non-WebGPU device is forced onto that CPU-sort renderer, so 'none' left the WebGL2 backend
// (and therefore the whole gpu.fallback path) rendering nothing, silently. Blob workers need the page
// to construct the source itself, so remote worker code stays impossible; src/index.html allows it too.
const html = (await readFile('src/index.html', 'utf8')).replace(/content="default-src[^\"]+"/, `content="default-src 'self'; script-src 'self'; worker-src blob:; connect-src 'self' blob: data:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'"`);
await writeFile(`${out}/ui/index.html`, html);
await copyFile('src/styles.css', `${out}/ui/assets/styles.css`);
await copyFile('assets/icons/app.png', `${out}/ui/assets/app-icon.png`);
for (const name of ['main.cjs','preload.cjs','library.cjs','paths.cjs','filelog.cjs','conversion-process.cjs']) await copyFile(`desktop/${name}`, `${out}/desktop/${name}`);
// fix branch: the conversion child process (pure Node, ELECTRON_RUN_AS_NODE). The official libraries stay real packages shipped with the app,
// so that path resolution for WorkerQueue.workerUrl / webp.wasm / the Dawn native library matches the official CLI.
// Together with the transitive dependencies (webgpu→debug→ms, splat-transform→@adobe/spz), the child process cannot read asar.
await copyFile('desktop/convert-child.mjs', `${out}/desktop/convert-child.mjs`);
for (const dep of ['@playcanvas/splat-transform', 'webgpu', 'playcanvas', 'debug', 'ms', '@adobe/spz']) await cp(`node_modules/${dep}`, `${out}/node_modules/${dep}`, { recursive: true });
await build({ entryPoints: ['src/manifest.ts'], outfile: `${out}/desktop/manifest.cjs`, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
await writeFile(`${out}/package.json`, JSON.stringify({ name, productName:'ElectronSplat', version, description:'Offline 3DGS viewer and converter', main:'desktop/main.cjs', buildId, author, license, repository }, null, 2));
await writeAppLicenses(out);
console.log(`Electron ${version}: ${out} (scene data stays outside the application)`);
