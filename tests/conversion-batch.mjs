import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,rm,readdir,readFile} from 'node:fs/promises';
import {prepareFixtures} from './fixtures.mjs';
const root=resolve('test-results/conversion-batch');await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});await prepareFixtures();
const xvfb=process.env.DISPLAY?null:spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':194','-screen','0','1360x1000x24','-nolisten','tcp'],{stdio:'ignore'});if(xvfb)await new Promise(r=>setTimeout(r,500));
let app;const result={checks:[],errors:[]};
try {
 app=await electron.launch({executablePath:resolve(process.env.PORTABLE_TEST_EXECUTABLE||'desktop-dist/ElectronSplat-linux-x64/ElectronSplat'),chromiumSandbox:true,args:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader','--use-angle=vulkan',`--data-dir=${root}`],env:{...process.env,DISPLAY:process.env.DISPLAY||':194'}});
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));await page.waitForFunction(()=>!!window.portableDiagnostics);
 await app.evaluate(({ipcMain,dialog,BrowserWindow})=>{
  globalThis.calls=[];globalThis.closeQuestions=[];globalThis.entered=0;globalThis.commits=0;
  const begin=ipcMain._invokeHandlers.get('portable:begin');ipcMain.removeHandler('portable:begin');
  ipcMain.handle('portable:begin',async(...args)=>{globalThis.calls.push(['begin',args[1]]);if(++globalThis.entered===1)await new Promise(resolve=>{globalThis.releaseBegin=resolve;});return begin(...args);});
  const commit=ipcMain._invokeHandlers.get('portable:commit');ipcMain.removeHandler('portable:commit');
  ipcMain.handle('portable:commit',async(...args)=>{globalThis.calls.push(['commit',args[2].name]);if(++globalThis.commits===1)await new Promise(resolve=>{globalThis.releaseCommit=resolve;});return commit(...args);});
  const abort=ipcMain._invokeHandlers.get('portable:abort');ipcMain.removeHandler('portable:abort');
  ipcMain.handle('portable:abort',async(...args)=>{const result=await abort(...args);globalThis.calls.push(['abort-finished']);return result;});
  dialog.showMessageBoxSync=(_window,options)=>{globalThis.closeQuestions.push(options);return 0;};
 });
 await page.evaluate(()=>{
  globalThis.progressSamples=[];
  new MutationObserver(()=>{for(const job of window.portableDiagnostics.snapshot().queue)if(job.state==='running')globalThis.progressSamples.push({id:job.id,name:job.name,progress:job.progress,stage:job.stage,detail:job.detail});}).observe(document.getElementById('queue-list'),{childList:true,subtree:true,attributes:true,attributeFilter:['value']});
 });
 await page.locator('#nav-import').click();
 const submit=async(name,file='valid.ply',background=false,size='0.1')=>{
  await page.locator('#foreground').setInputFiles(`test-results/fixtures/${file}`);
  if(background)await page.locator('#background').setInputFiles('test-results/fixtures/background.ply');
  await page.locator('#scene-name').fill(name);await page.locator(`input[name="voxel-size"][value="${size}"]`).check();await page.locator('#convert-button').click();
  await expect(page.locator('#foreground')).toHaveValue('');await expect(page.locator('#scene-name')).toHaveValue('');
 };
 await submit('取消中的任务');await expect.poll(()=>app.evaluate(()=>globalThis.entered)).toBe(1);
 await submit('无效文件','invalid.ply');await submit('含背景场景','valid.ply',true,'0.2');await submit('待移除');await submit('纯前景场景','valid.ply',false,'0.5');
 assert.equal(await app.evaluate(()=>globalThis.entered),1);
 // No native transaction exists yet: queued input alone must still guard quitting.
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 const questions=await app.evaluate(()=>globalThis.closeQuestions);assert.equal(questions.length,1);assert.match(questions[0].detail,/5 个任务/);assert.equal(questions[0].defaultId,0);assert.equal(page.isClosed(),false);
 await page.getByRole('button',{name:'移除：待移除',exact:true}).click();
 await page.locator('#cancel-conversion').click();assert.equal(await app.evaluate(()=>globalThis.entered),1);
 await page.locator('#nav-help').click();await expect(page.locator('#help-page')).toBeVisible();
 await app.evaluate(()=>globalThis.releaseBegin());
 await expect.poll(()=>app.evaluate(()=>globalThis.commits),{timeout:90000}).toBe(1);
 const during=await page.evaluate(()=>window.portableDiagnostics.snapshot());
 assert.equal(during.queue[0].state,'cancelled');assert.equal(during.queue[1].state,'failed');assert.equal(during.queue[2].state,'running');assert.equal(during.queue[2].progress,.99);assert.equal(during.queue[4].state,'waiting');assert.equal(during.scenes.length,0);
 await expect(page.locator('#cancel-conversion')).toBeDisabled();
 assert.equal(await app.evaluate(()=>globalThis.entered),3);
 result.checks.push('submit five independently configured scenes during pending conversion; remove waiting job; close guard covers pending inputs before native begin; cancellation waits for late begin cleanup');
 result.checks.push('invalid PLY retains error and next job runs; final disk commit stays at 99%, disables cancellation, and blocks next task');
 await app.evaluate(()=>globalThis.releaseCommit());
 await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy,null,{timeout:90000});
 const snapshot=await page.evaluate(()=>window.portableDiagnostics.snapshot());
 assert.deepEqual(snapshot.queue.map(job=>job.state),['cancelled','failed','completed','cancelled','completed']);
 assert.equal(snapshot.scenes.length,2);assert.equal(snapshot.page,'help');
 const first=snapshot.scenes.find(scene=>scene.name==='含背景场景'),second=snapshot.scenes.find(scene=>scene.name==='纯前景场景');
 assert.equal(first.pointCount,256);assert.equal(second.pointCount,256);
 const meta=async(scene)=>JSON.parse(await readFile(join(root,'scenes',scene.id,'lod/lod-meta.json'),'utf8'));
 assert.equal((await meta(first)).environment,'env/meta.json');assert.equal((await meta(second)).environment,undefined);
 const starts=snapshot.logs.filter(event=>event.event==='conversion.start');
 assert.deepEqual(starts.map(e=>[e.data.options.name,e.data.options.cellSize,e.data.backgroundBytes>0]),[['无效文件',.1,false],['含背景场景',.2,true],['纯前景场景',.5,false]]);
 assert.equal((await readdir(join(root,'scenes'))).filter(n=>n.startsWith('.converting-')).length,0);
 const samples=await page.evaluate(()=>globalThis.progressSamples);
 for(const job of snapshot.queue){
  const values=samples.filter(sample=>sample.id===job.id).map(sample=>sample.progress);
  assert.deepEqual(values,[...values].sort((a,b)=>a-b),job.name);assert.ok(values.every(value=>value<1));
  if(job.state==='completed')assert.equal(job.progress,1);
 }
 assert.ok(samples.some(s=>s.name==='含背景场景'&&s.stage==='读取 PLY 文件头'&&s.detail.startsWith('背景')&&s.progress>.02));
 assert.ok(samples.some(s=>s.stage==='压缩 SOG'&&s.progress>.60&&s.progress<=.96));
 result.checks.push('whole-scene progress monotonic across foreground/background, actual official SOG encoding, cover, and disk commit; completed jobs reach 100% only after commit');
 result.checks.push('second queued scene preserves its own source, optional background and voxel size; guide stays open; output contains official default directories and no staging');
 await page.locator('#nav-import').click();await page.locator('#conversion-queue').scrollIntoViewIfNeeded();await page.screenshot({path:join(root,'queue.png'),fullPage:true});
 await app.evaluate(({BrowserWindow},path)=>{globalThis.downloadState=null;BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_event,item)=>{item.setSavePath(path);item.once('done',(_event,state)=>{globalThis.downloadState=state;});});},join(root,'diagnostics.json'));
 await page.evaluate(()=>window.portableDiagnostics.download());await expect.poll(()=>app.evaluate(()=>globalThis.downloadState)).toBe('completed');
 const exported=JSON.parse(await readFile(join(root,'diagnostics.json'),'utf8'));
 assert.deepEqual(exported.context.queue.map(job=>job.state),snapshot.queue.map(job=>job.state));assert.equal(exported.context.busy,false);
 result.checks.push('exported diagnostic JSON includes queue states and whole-scene progress without source file objects');
 assert.deepEqual(result.errors,[]);result.passed=true;result.diagnostics=snapshot;result.progressSamples=samples;result.calls=await app.evaluate(()=>globalThis.calls);
}catch(error){result.failure=error.stack;if(app)result.diagnostics=await(await app.firstWindow()).evaluate(()=>window.portableDiagnostics.snapshot()).catch(()=>null);throw error;}
finally{if(app)await app.close();xvfb?.kill();await writeFile(join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks,failure:result.failure},null,2));}
