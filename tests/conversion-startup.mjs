import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {nativeFixture} from './native-fixture.mjs';
import {prepareFixtures} from './fixtures.mjs';
const root=resolve('test-results/conversion-startup');await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});await prepareFixtures();await nativeFixture(join(root,'scenes','scene-native-fixture'));
const xvfb=process.env.DISPLAY?null:spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':195','-screen','0','1360x900x24','-nolisten','tcp'],{stdio:'ignore'});if(xvfb)await new Promise(r=>setTimeout(r,500));let app;
const result={checks:[],errors:[]};
try {
 app=await electron.launch({executablePath:resolve(process.env.PORTABLE_TEST_EXECUTABLE||'desktop-dist/Portable-3DGS-Viewer-linux-x64/Portable-3DGS-Viewer'),chromiumSandbox:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader',`--data-dir=${root}`],env:{...process.env,DISPLAY:process.env.DISPLAY||':195'}});
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));await page.locator('.scene-card').waitFor();await page.clock.install();
 await app.evaluate(({shell})=>{shell.openPath=()=>new Promise(()=>{});});
 await page.locator('.scene-folder').click();await page.locator('#nav-import').click();await page.locator('#foreground').setInputFiles('test-results/fixtures/valid.ply');await page.locator('#convert-button').click();
 await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy,null,{timeout:45000});
 assert.equal((await page.evaluate(()=>window.portableDiagnostics.snapshot())).scenes.length,2);
 result.checks.push('OS folder opener never resolves: conversion still completes and disk queue remains usable');
 await page.locator('#nav-import').click();
 const gate=async()=>app.evaluate(({ipcMain})=>{
  const key='portable:begin';globalThis.originalBegin=ipcMain._invokeHandlers.get(key);
  globalThis.beginGate=new Promise(resolve=>{globalThis.releaseBegin=resolve;});globalThis.beginEntered=false;globalThis.beginReturned=false;
  ipcMain.removeHandler(key);ipcMain.handle(key,async(...args)=>{globalThis.beginEntered=true;await globalThis.beginGate;try{return await globalThis.originalBegin(...args);}finally{globalThis.beginReturned=true;}});
 });
 const restore=async()=>{await app.evaluate(({ipcMain})=>{globalThis.releaseBegin();ipcMain.removeHandler('portable:begin');ipcMain.handle('portable:begin',globalThis.originalBegin);});await expect.poll(()=>app.evaluate(()=>globalThis.beginReturned)).toBe(true);};
 const submit=async()=>{await page.locator('#foreground').setInputFiles('test-results/fixtures/valid.ply');await page.locator('#convert-button').click();};
 const noStaging=async()=>expect.poll(async()=>(await readdir(join(root,'scenes'))).filter(n=>n.startsWith('.converting-')).length).toBe(0);
 await gate();await submit();await expect.poll(()=>app.evaluate(()=>globalThis.beginEntered)).toBe(true);
 await expect(page.locator('#progress-stage')).toHaveText('准备保存目录');assert.equal(Number(await page.locator('#progress-bar').getAttribute('value')),.01);
 await page.clock.fastForward(21000);await expect(page.locator('#toast')).toContainText('准备保存目录超过 20 秒');await expect(page.locator('#convert-button')).toBeEnabled();
 await restore();await noStaging();
 result.checks.push('delayed output preparation times out; late transaction is aborted and not published');
 await gate();await submit();await expect.poll(()=>app.evaluate(()=>globalThis.beginEntered)).toBe(true);await page.locator('#cancel-conversion').click();await restore();await noStaging();await expect(page.locator('#convert-button')).toBeEnabled();
 result.checks.push('cancel before begin returns clears timers and discards the late transaction');
 const workerSource=await page.evaluate(()=>window.PORTABLE_WORKER_SOURCE);await page.evaluate(()=>{window.PORTABLE_WORKER_SOURCE='/* no ready event */';});
 await submit();await expect(page.locator('#progress-stage')).toHaveText('启动离线转换器');await page.clock.fastForward(21000);
 await expect(page.locator('#toast')).toContainText('离线转换器启动超过 20 秒');await expect(page.locator('#convert-button')).toBeEnabled();await noStaging();
 result.checks.push('missing worker ready signal times out and cleans staging');
 await page.evaluate(source=>{window.PORTABLE_WORKER_SOURCE=source;globalThis.originalArrayBuffer=Blob.prototype.arrayBuffer;Blob.prototype.arrayBuffer=()=>new Promise(()=>{});},workerSource);
 await submit();await expect(page.locator('#progress-stage')).toHaveText('读取 PLY 文件头');await page.clock.fastForward(31000);
 await expect(page.locator('#toast')).toContainText('超过 30 秒');await expect(page.locator('#convert-button')).toBeEnabled();await noStaging();await page.evaluate(()=>{Blob.prototype.arrayBuffer=globalThis.originalArrayBuffer;});
 result.checks.push('stalled first PLY range read reports filename/range and cleans staging');
 await submit();await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy,null,{timeout:45000});
 const snapshot=await page.evaluate(()=>window.portableDiagnostics.snapshot());assert.equal(snapshot.scenes.length,3);assert.ok(snapshot.build.includes('@'));assert.deepEqual(result.errors,[]);
 result.checks.push('new conversion succeeds after failures; diagnostics carry build identity');result.passed=true;result.diagnostics=snapshot;
}catch(error){result.failure=error.stack;throw error;}
finally{if(app)await app.close();xvfb?.kill();await writeFile(join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks,failure:result.failure},null,2));}
