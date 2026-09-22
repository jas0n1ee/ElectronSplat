import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, cp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { prepareFixtures } from './fixtures.mjs';
import { nativeFixture } from './native-fixture.mjs';
const dest=resolve('test-results/desktop'),root=join(dest,'U 盘 中文目录');
await rm(root,{recursive:true,force:true});await mkdir(join(root,'scenes'),{recursive:true});await prepareFixtures();
const fixture=join(dest,'copied-fixture');await nativeFixture(fixture);
// A version-1 manifest is all scan() needs to reject a scene and the library to ask for a
// re-conversion. Generating it keeps this suite runnable from a clean checkout; the old form copied
// a real scene out of the developer's gitignored portable/ directory, so it only ever ran on one machine.
const legacy='scene-legacy-fixture';
await mkdir(join(root,'scenes',legacy),{recursive:true});
await writeFile(join(root,'scenes',legacy,'scene.json'),JSON.stringify({format:'portable-3dgs',version:1}));
// Xvfb and the software-GPU flags exist to give Linux a working adapter at all. On any other platform
// they would force the viewer back onto software rendering -- the one environment this suite must not
// measure, and where the WebGL2 stall (KNOWN_ISSUES #15) hid precisely because of them.
const linux=process.platform==='linux';
const xvfb=linux&&!process.env.DISPLAY?spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':198','-screen','0','1360x900x24','-nolisten','tcp'],{stdio:'ignore'}):null;
if(xvfb)await new Promise(r=>setTimeout(r,500));
const flags=linux?['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader','--use-angle=vulkan']:[];
// Paths verified by a real run; anything else has to be pointed at explicitly rather than guessed.
const defaultExecutable=process.platform==='darwin'?'desktop-dist/ElectronSplat-darwin-arm64/ElectronSplat.app/Contents/MacOS/ElectronSplat':process.platform==='linux'?'desktop-dist/ElectronSplat-linux-x64/ElectronSplat':null;
const executable=process.env.PORTABLE_TEST_EXECUTABLE||defaultExecutable;
if(!executable)throw new Error('PORTABLE_TEST_EXECUTABLE must be set: no default packaged path for this platform.');
const launch=()=>electron.launch({
  executablePath:resolve(executable),chromiumSandbox:true,
  args:[...flags,`--data-dir=${root}`],env:{...process.env,...(linux?{DISPLAY:process.env.DISPLAY||':198'}:{})},timeout:30000
});
const result={checks:[],errors:[],network:[]};let app;
try {
  app=await launch();let page=await app.firstWindow();
  page.on('pageerror',e=>result.errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))result.network.push(r.url());});
  page.on('console',m=>{if(m.type()==='error')console.log('renderer:',m.text().slice(0,350));});
  await expect(page.locator('#library-info')).toContainText('重新转换',{timeout:20000});
  await expect(page.locator('.scene-card')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.locator('.crosshair').count(),0);
  result.environment=await page.evaluate(()=>window.portableDesktop.info());result.launchArgs=app.process().spawnargs;
  const small='scene-native-fixture';await cp(fixture,join(root,'scenes',small),{recursive:true});
  await expect(page.locator('.scene-card')).toHaveCount(1,{timeout:15000});await rm(join(root,'scenes',small),{recursive:true});
  await expect(page.locator('.scene-card')).toHaveCount(0,{timeout:15000});
  result.checks.push('legacy PLY reconversion message; official scene copied after build auto-discovered; sandbox bridge; no crosshair');
  assert.equal(await page.locator('#open-folder,.import-summary,.scene-export').count(),0);
  await page.locator('#nav-import').click();
  await expect(page.locator('.import-main > #convert-button')).toBeVisible();
  await page.locator('#foreground').setInputFiles('test-results/fixtures/invalid.ply');await page.locator('#convert-button').click();
  // The library's own message is English and stays in the detail; what the UI must lead with is the
  // product's wording. Asserting the prefix keeps the check honest without pinning the library text.
  await expect(page.locator('#toast')).toContainText('转换失败',{timeout:30000});await expect(page.locator('#convert-button')).toBeEnabled();
  await page.locator('#foreground').setInputFiles('test-results/fixtures/render.ply');await page.locator('#scene-name').fill('官方 LOD 验证');
  await page.locator('#convert-button').click();await page.locator('#cancel-conversion').click();await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy);
  assert.equal((await readdir(join(root,'scenes'))).filter(n=>n.startsWith('.converting-')).length,0);
  await page.locator('#foreground').setInputFiles('test-results/fixtures/render.ply');await page.locator('#scene-name').fill('官方 LOD 验证');
  await page.locator('#background').setInputFiles('test-results/fixtures/background.ply');
  await page.locator('#convert-button').click();await page.locator('#nav-help').click();
  await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy,null,{timeout:180000});
  const snapshot=await page.evaluate(()=>window.portableDiagnostics.snapshot());
  assert.equal(snapshot.scenes.length,1,JSON.stringify(snapshot.logs.slice(-12)));
  const manifest=snapshot.scenes[0];assert.equal(manifest.version,2);assert.equal(manifest.streams.length,1);
  const stats=snapshot.logs.find(e=>e.event==='conversion.complete').data;
  // The child runs the official worker pool. isInline flips to true the moment maxWorkers is 0 or
  // the worker bundle cannot be resolved, which silently drops every conversion to one thread, so
  // that is the failure worth pinning. It states the pool is enabled -- not how many workers ran.
  assert.equal(stats.runner,'node',JSON.stringify(stats));
  assert.equal(stats.workers.inline,false,JSON.stringify(stats));
  assert.equal(JSON.parse(await readFile(join(root,'scenes',manifest.id,'scene.json'),'utf8')).id,manifest.id);
  const meta=JSON.parse(await readFile(join(root,'scenes',manifest.id,'lod/lod-meta.json'),'utf8'));
  // The writer's per-level totals must equal what the decimator produced for each level.
  // Take the last, not the first: the invalid-input and cancelled attempts earlier in this suite
  // also reach the child and log their own foreground count.
  const foreground=snapshot.logs.filter(e=>e.event==='child.foreground').at(-1).data.points;
  const staged=snapshot.logs.filter(e=>e.event==='child.level.staged').map(e=>e.data.points);
  assert.deepEqual([foreground,...staged],[8192,4096,2048],'decimated level counts');
  // `filenames` comes back in traversal order: the writer pushes each unit the first time it meets it
  // and never sorts (vendor/splat-transform/write-lod.ts:717), which is not the order `counts` uses.
  // No consumer reads it positionally -- src/manifest.ts and desktop/library.cjs resolve through
  // lod.file -- so compare the set it is, not the order it happens to arrive in. macOS stably produces
  // 0_0,2_0,1_0 where Linux produces 0_0,1_0,2_0, which is what made this assert look like a failure.
  assert.deepEqual(meta.counts,[foreground,...staged],'writer totals must match what was decimated');assert.deepEqual([...meta.filenames].sort(),['0_0/meta.json','1_0/meta.json','2_0/meta.json'],'writer file units');assert.equal(meta.environment,'env/meta.json');
  assert.ok(!(await readdir(join(root,'scenes',manifest.id))).includes('.work'));
  assert.equal((await readdir(join(root,'scenes'))).filter(n=>n.startsWith('.converting-')).length,0);
  await expect(page.locator('#help-page')).toBeVisible();result.conversion=stats;
  result.checks.push('invalid input and cancellation clean up; official foreground/background output; official worker pool enabled; guide remains usable');
  await page.locator('#nav-library').click();await page.getByRole('button',{name:'打开 官方 LOD 验证',exact:true}).click();
  await page.waitForFunction(()=>window.portableDiagnostics.snapshot().logs.some(e=>e.event==='scene.ready'),null,{timeout:60000});
  await page.waitForFunction(()=>window.portableDiagnostics.snapshot().viewer?.points===8256,null,{timeout:60000});
  const view=await page.evaluate(()=>window.portableDiagnostics.snapshot());
  assert.deepEqual(view.viewer.pose.position,[0,1.4,0]);assert.equal(view.viewer.collisionRadius,0.1);assert.equal(view.viewer.budget,3e6);
  assert.ok(view.logs.findIndex(e=>e.event==='stream.coarseReady')<view.logs.findIndex(e=>e.event==='scene.ready'));
  await page.locator('[data-lod="3"]').click();await expect(page.locator('#viewer-stats')).toContainText('LOD 3');
  assert.equal(await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.budget),9e6);
  const canvas=await page.locator('#viewer-canvas').evaluate(c=>({width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight,dpr:devicePixelRatio}));
  assert.equal(canvas.width,Math.floor(canvas.cssWidth*canvas.dpr));assert.equal(canvas.height,Math.floor(canvas.cssHeight*canvas.dpr));
  await page.locator('#render-backend').selectOption('webgl');
  // The WebGL2 reload runs the CPU sort path under software rendering, which is far slower than
  // the WebGPU one; give it room. A stall rather than slowness shows up as this same timeout.
  await page.waitForFunction(()=>window.portableDiagnostics.snapshot().viewer?.points===8256&&!window.portableDiagnostics.snapshot().viewer?.loading,null,{timeout:240000});
  assert.equal(await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.budget),9e6);
  assert.deepEqual(await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.pose.position),[0,1.4,0]);
  result.checks.push('reinitializing renderer preserves selected budget and pose before device initialization');
  await page.screenshot({path:join(dest,'viewer.png')});
  let cover=join(root,'scenes',manifest.id,'cover.png');const oldCover=await readFile(cover);
  await page.locator('#viewer-canvas').click();await page.keyboard.down('KeyE');await page.waitForTimeout(200);await page.keyboard.up('KeyE');
  await page.mouse.move(600,400);await page.mouse.down();await page.mouse.move(635,410);await page.mouse.up();
  const savedPose=await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.pose);
  await page.locator('#capture-cover').click();await expect(page.locator('#toast')).toContainText('首图与起始视角已保存',{timeout:45000});
  const savedManifest=JSON.parse(await readFile(join(root,'scenes',manifest.id,'scene.json'),'utf8'));cover=join(root,'scenes',manifest.id,savedManifest.cover);
  assert.notDeepEqual(await readFile(cover),oldCover);assert.deepEqual(savedManifest.camera,savedPose);assert.equal(savedManifest.cameraSource,'cover');
  assert.equal(await page.locator('#export-viewer').count(),0);
  result.checks.push('native official queue renders all 8256 points; coarse before final; fixed spawn/radius/budget/DPR; settled cover saved; no scene export');
  await expect(page.locator('.brand img')).toHaveCount(1);
  await expect(page.locator('.brand img')).toHaveAttribute('src','assets/app-icon.png');
  await expect(page.locator('.brand')).toContainText('ElectronSplat.');
  await page.locator('#hide-viewer-panels').click();await page.waitForTimeout(350);
  await expect(page.locator('#show-viewer-panels')).toBeVisible();
  assert.equal(await page.locator('#viewer-settings').evaluate(el=>el.inert),true);
  await page.screenshot({path:join(dest,'viewer-collapsed.png')});
  const poseBeforePanels=await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.pose);
  await page.evaluate(()=>{
    window.panelFrames=[];window.watchPanels=true;
    const sample=()=>{
      const c=document.getElementById('viewer-canvas'),v=document.getElementById('viewer-page'),r=c.getBoundingClientRect();
      window.panelFrames.push({x:r.x,y:r.y,w:r.width,h:r.height,bufferWidth:c.width,bufferHeight:c.height,scrollLeft:v.scrollLeft,scrollTop:v.scrollTop});
      if(window.watchPanels)requestAnimationFrame(sample);
    };sample();
  });
  await page.locator('#show-viewer-panels').click();await page.waitForTimeout(350);
  const panelFrames=await page.evaluate(()=>{window.watchPanels=false;return window.panelFrames;});
  assert.ok(panelFrames.length>2);
  for(const frame of panelFrames)assert.deepEqual(frame,panelFrames[0],'opening toolbar moved or resized the canvas');
  assert.deepEqual(await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.pose),poseBeforePanels);
  result.panelAnimation={frames:panelFrames.length,canvas:panelFrames[0],unchanged:true};
  assert.equal(await page.locator('#viewer-settings').evaluate(el=>el.inert),false);
  await page.waitForTimeout(2000);const beforeIdle=await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.renderedFrames);
  await page.waitForTimeout(1000);const afterIdle=await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.renderedFrames);
  assert.ok(afterIdle-beforeIdle<5,`idle renders ${afterIdle-beforeIdle}`);
  const centers=await page.locator('#back-library').evaluate(el=>{const a=el.querySelector('svg').getBoundingClientRect(),b=el.querySelector('span').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2);});assert.ok(centers<1);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,760));
  await expect.poll(()=>page.locator('#viewer-canvas').evaluate(c=>c.width===Math.floor(c.clientWidth*devicePixelRatio))).toBe(true);
  await page.screenshot({path:join(dest,'viewer-restored.png')});
  result.checks.push('exact capture frame pose persisted; bottom panels collapse and restore; idle render count <5/sec');
  result.diagnostics=await page.evaluate(()=>window.portableDiagnostics.snapshot());
  await page.locator('#back-library').click();
  await writeFile(cover,await readFile(join(fixture,'cover.png')));
  await expect.poll(()=>page.locator('.scene-cover').evaluate(img=>img.naturalWidth),{timeout:15000}).toBe(1);
  await page.getByRole('button',{name:'打开 官方 LOD 验证',exact:true}).click();
  await page.waitForFunction(()=>window.portableDiagnostics.snapshot().viewer?.loading);
  await page.locator('#back-library').click();
  await expect(page.locator('#library-page')).toBeVisible();
  result.checks.push('return to library while official resources are still loading');
  await app.close();app=await launch();page=await app.firstWindow();await expect(page.locator('.scene-card')).toHaveCount(1,{timeout:20000});
  await page.getByRole('button',{name:'打开 官方 LOD 验证',exact:true}).click();
  await page.waitForFunction(()=>window.portableDiagnostics.snapshot().viewer?.pose);assert.deepEqual(await page.evaluate(()=>window.portableDiagnostics.snapshot().viewer.pose),savedPose);
  await page.locator('#back-library').click();
  result.checks.push('external cover refresh; restart restores converted scene; original legacy files preserved');
  // Exercise real IPC routes; stub only the native file manager/dialog to avoid opening OS windows in CI.
  await app.evaluate(({shell,dialog})=>{
    globalThis.testSceneActions={opened:[],dialogs:[],response:0};
    shell.openPath=async path=>{globalThis.testSceneActions.opened.push(path);return '';};
    dialog.showMessageBox=async(_window,options)=>{globalThis.testSceneActions.dialogs.push(options);return {response:globalThis.testSceneActions.response};};
  });
  await page.getByRole('button',{name:'打开数据文件夹：官方 LOD 验证',exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>globalThis.testSceneActions.opened.length)).toBe(1);
  assert.equal(await app.evaluate(()=>globalThis.testSceneActions.opened[0]),join(root,'scenes',manifest.id));
  await page.getByRole('button',{name:'永久删除场景：官方 LOD 验证',exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>globalThis.testSceneActions.dialogs.length)).toBe(1);
  await expect(page.locator('.scene-card')).toHaveCount(1);
  const confirmation=await app.evaluate(()=>globalThis.testSceneActions.dialogs[0]);
  assert.equal(confirmation.cancelId,0);assert.equal(confirmation.defaultId,0);assert.match(confirmation.message,/官方 LOD 验证/);assert.ok(confirmation.detail.includes(join(root,'scenes',manifest.id)));
  await app.evaluate(()=>{globalThis.testSceneActions.response=1;});
  await page.getByRole('button',{name:'永久删除场景：官方 LOD 验证',exact:true}).click();
  await expect(page.locator('.scene-card')).toHaveCount(0);assert.ok(!(await readdir(join(root,'scenes'))).includes(manifest.id));
  assert.ok((await readdir(join(root,'scenes'))).includes(legacy));
  result.checks.push('per-scene file manager path; deletion dialog names scene and directory; cancel preserves files; confirm permanently removes only selected scene');
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.network,[]);result.passed=true;
} catch(e){result.failure=e.stack;if(app)try{result.failureDiagnostics=await (await app.firstWindow()).evaluate(()=>window.portableDiagnostics.snapshot());}catch{}throw e;}
finally {if(app)await app.close();xvfb?.kill();await writeFile(join(dest,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks,failure:result.failure},null,2));}
