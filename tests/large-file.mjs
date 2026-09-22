import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,rm,readdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { sparseLargeFixture } from './fixtures.mjs';
const root=resolve('test-results/large-file-desktop');await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
const input=await sparseLargeFixture(),result={input,errors:[],network:[]};
const xvfb=process.env.DISPLAY?null:spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':196','-screen','0','1360x900x24','-nolisten','tcp'],{stdio:'ignore'});
if(xvfb)await new Promise(r=>setTimeout(r,500));let app;
try {
 app=await electron.launch({executablePath:resolve(process.env.PORTABLE_TEST_EXECUTABLE||'desktop-dist/ElectronSplat-linux-x64/ElectronSplat'),chromiumSandbox:true,args:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader','--use-angle=vulkan',`--data-dir=${root}`],env:{...process.env,DISPLAY:process.env.DISPLAY||':196'}});
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))result.network.push(r.url());});
 await page.locator('#nav-import').click();await page.locator('#foreground').setInputFiles(input.path);await page.locator('#convert-button').click();
 await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy,null,{timeout:300000});
 const snapshot=await page.evaluate(()=>window.portableDiagnostics.snapshot());result.diagnostics=snapshot;
 assert.equal(snapshot.scenes.length,1,JSON.stringify(snapshot.logs.slice(-10)));assert.equal(snapshot.scenes[0].pointCount,input.valid);assert.equal(snapshot.scenes[0].sourceBytes,input.bytes);
 const complete=snapshot.logs.find(e=>e.event==='conversion.complete').data;
 assert.equal(complete.invalid,input.count-input.valid);assert.equal((await readdir(join(root,'scenes'))).filter(n=>n.startsWith('.')).length,0);
 await page.locator('#nav-library').click();await page.locator('.scene-open').click();await page.waitForFunction(()=>window.portableDiagnostics.snapshot().logs.some(e=>e.event==='scene.ready'),null,{timeout:60000});
 assert.deepEqual(result.errors,[]);assert.deepEqual(result.network,[]);result.passed=true;
 console.log(JSON.stringify({passed:true,inputBytes:input.bytes,rows:input.count,valid:input.valid,durationMs:complete.durationMs}));
}finally{if(app)await app.close();xvfb?.kill();await writeFile(join(root,'results.json'),JSON.stringify(result,null,2));}
