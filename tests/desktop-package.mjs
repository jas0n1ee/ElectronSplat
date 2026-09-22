import { listPackage, extractFile } from '@electron/asar';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const packages=[];let reference;
const targets=process.argv.slice(2);
// Read the expected version from package.json: a hardcoded value here goes stale on every version bump.
const {version:expectedVersion}=JSON.parse(await readFile('package.json','utf8'));
for(const name of targets.length?targets:['win32-x64','darwin-arm64']){
  const root=join('desktop-dist',`ElectronSplat-${name}`),mac=name.startsWith('darwin');
  const asar=join(root,mac?'ElectronSplat.app/Contents/Resources/app.asar':'resources/app.asar'),files=listPackage(asar);
  // The conversion child process runs as plain Node and cannot read asar, so node_modules is bundled
  // and unpacked on purpose. Keep forbidding private material, and pin the dependency set separately
  // so an accidentally bundled package still fails.
  assert.ok(!files.some(f=>/goal\.md|TEST_REPORT|scene-resources|\.ply$|\.sog$|logs\/|scenes\.js/.test(f)));
  const bundledDeps=new Set();
  for(const file of files){const found=/^\/node_modules\/(@[^/]+\/[^/]+|[^@][^/]*)/.exec(file);if(found)bundledDeps.add(found[1]);}
  assert.deepEqual([...bundledDeps].sort(),['@adobe/spz','@playcanvas/splat-transform','debug','ms','playcanvas','webgpu']);
  assert.equal(JSON.parse(extractFile(asar,'package.json')).version,expectedVersion);
  if(reference){
    assert.deepEqual(JSON.parse(extractFile(asar,'package.json')),JSON.parse(extractFile(reference,'package.json')));
    // The in-renderer conversion worker is gone (612fe91): converter.js and splat-worker.mjs no longer
    // ship, and filelog.cjs plus the child-process entry point took their place.
    for(const file of ['desktop/main.cjs','desktop/preload.cjs','desktop/manifest.cjs','desktop/library.cjs','desktop/paths.cjs','desktop/filelog.cjs','desktop/conversion-process.cjs','desktop/convert-child.mjs','ui/index.html','ui/assets/app.js','ui/assets/styles.css','ui/assets/app-icon.png'])assert.ok(extractFile(asar,file).equals(extractFile(reference,file)),`${name}: ${file} differs`);
  }else reference=asar;
  const licenseRoot=join(root,mac?'ElectronSplat.app/Contents/Resources/licenses':'licenses');
  for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md','THIRD-PARTY-LICENSES.txt','LIBWEBP-LICENSE.txt']){
    assert.deepEqual(await readFile(join(licenseRoot,file)),extractFile(asar,file),`${name}: ${file}`);
  }
  assert.deepEqual(await readFile(join(licenseRoot,'ELECTRON-LICENSE.txt')),await readFile(join(root,'LICENSE')));
  assert.deepEqual(await readFile(join(licenseRoot,'LICENSES.chromium.html')),await readFile(join(root,'LICENSES.chromium.html')));
  for(const component of ['pathe 2.0.3','fzstd 0.1.1','SplatTransform 3.4.2','SPZ','libwebp','Emscripten','musl'])assert.ok(extractFile(asar,'THIRD-PARTY-LICENSES.txt').toString().includes(component));
  const html=extractFile(asar,'ui/index.html').toString();
  assert.ok(!/crosshair|export-viewer|open-folder|import-summary|ZIP/.test(html));
  assert.ok(html.includes('ElectronSplat<span class="brand-dot">.</span>'));assert.ok(html.includes('id="hide-viewer-panels"'));assert.ok(html.includes('id="show-viewer-panels"'));
  assert.ok(extractFile(asar,'THIRD-PARTY-LICENSES.txt').toString().includes('SuperSplat Viewer'));
  assert.ok(html.includes('id="convert-button"'));assert.ok(html.includes('加入转换队列'));assert.ok(html.includes('id="queue-list"'));assert.ok(html.includes('id="progress-percent"'));
  const preload=extractFile(asar,'desktop/preload.cjs').toString();
  assert.ok(preload.includes('openSceneFolder'));assert.ok(preload.includes('deleteScene'));assert.ok(preload.includes('renameScene'));assert.ok(html.includes('id="rename-dialog"'));assert.ok(preload.includes('setQueueLength'));assert.ok(!preload.includes('openScenes:'));
  packages.push({name,files});
}
await mkdir('test-results/desktop-package',{recursive:true});await writeFile('test-results/desktop-package/results.json',JSON.stringify({passed:true,packages},null,2));
console.log(`PASS ${packages.length} runtime archives: current UI/bridge, no scene/docs/logs/static index`);
