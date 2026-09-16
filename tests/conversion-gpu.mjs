import { _electron as electron, expect } from '@playwright/test';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
const dest=resolve('test-results/conversion-gpu');await mkdir(dest,{recursive:true});
const input=join(dest,'input.ply');await writeFile(input,Buffer.from(await fixture({count:1024,width:32}).arrayBuffer()));
const xvfb=process.env.DISPLAY?null:spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':199','-screen','0','1360x900x24','-nolisten','tcp'],{stdio:'ignore'});
if(xvfb)await new Promise(r=>setTimeout(r,500));
let app;const results=[];
try {
  for(const fault of ['none','device-lost','adapter-null','cancel']) {
    const root=join(dest,fault);await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
    app=await electron.launch({executablePath:resolve(process.env.PORTABLE_TEST_EXECUTABLE||'desktop-dist/Portable-3DGS-Viewer-linux-x64/Portable-3DGS-Viewer'),chromiumSandbox:true,args:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader','--use-angle=vulkan',`--data-dir=${root}`],env:{...process.env,DISPLAY:process.env.DISPLAY||':199'}});
    const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>typeof window.PORTABLE_WORKER_SOURCE==='string'&&!!window.portableDiagnostics);
    // Fault injection exists only in the test's worker source prefix.
    await page.evaluate(fault=>{
      const prefix=`{
        const fault=${JSON.stringify(fault)};
        if(fault==='adapter-null')GPU.prototype.requestAdapter=async()=>null;
        if(fault==='device-lost'){
          let completed=false,triggered=false,device;
          const create=GPUAdapter.prototype.requestDevice;
          GPUAdapter.prototype.requestDevice=async function(...args){device=await create.apply(this,args);return device;};
          const send=self.postMessage.bind(self);
          self.postMessage=(message,...args)=>{if(message.type==='log'&&message.event==='chunk.complete')completed=true;return send(message,...args);};
          const submit=GPUQueue.prototype.submit;
          GPUQueue.prototype.submit=function(...args){const result=submit.apply(this,args);if(completed&&!triggered){triggered=true;send({type:'log',event:'test.deviceLost',data:{afterCompletedBlock:true}});device.destroy();}return result;};
        }
      }\n`;
      window.PORTABLE_WORKER_SOURCE=prefix+window.PORTABLE_WORKER_SOURCE;
    },fault);
    await page.locator('#nav-import').click();await page.locator('#foreground').setInputFiles(input);await page.locator('#scene-name').fill(`GPU ${fault}`);await page.locator('#convert-button').click();
    if(fault==='cancel') {
      await page.waitForFunction(()=>window.portableDiagnostics.snapshot().logs.some(e=>e.event==='conversion.worker.ready'),null,{timeout:30000});
      await page.locator('#cancel-conversion').click();await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy);
      await expect.poll(()=>page.workers().length).toBe(0);
      assert.equal((await readdir(join(root,'scenes'))).filter(n=>n.startsWith('.converting-')).length,0);
      results.push({fault,passed:true,checks:['active worker cancellation destroys parent and nested worker targets; staging removed']});
      await app.close();app=null;console.log('PASS conversion active cancellation');continue;
    }
    await page.waitForFunction(()=>!window.portableDiagnostics.snapshot().busy,null,{timeout:180000});
    const snapshot=await page.evaluate(()=>window.portableDiagnostics.snapshot());
    const record={fault,snapshot,errors};results.push(record);await writeFile(join(dest,'results.json'),JSON.stringify(results,null,2));
    assert.deepEqual(errors,[]);
    if(fault==='adapter-null'||fault==='device-lost'){
      assert.equal(snapshot.scenes.length,0,'official voxel must not silently fall back to custom CPU voxels');
      assert.ok(snapshot.logs.some(e=>e.event==='conversion.worker'),JSON.stringify(snapshot.logs.slice(-8)));
      assert.equal((await readdir(join(root,'scenes'))).filter(n=>n.startsWith('.converting-')).length,0);
      record.passed=true;console.log(`PASS official conversion ${fault}: clear failure and staging cleanup`);await app.close();app=null;continue;
    }
    assert.equal(snapshot.scenes.length,1,JSON.stringify(snapshot.logs.slice(-8)));
    assert.equal(snapshot.scenes[0].collisionFormat,'playcanvas-voxel');
    const logs=snapshot.logs,ready=logs.filter(e=>e.event==='conversion.gpu.ready'),fallback=logs.filter(e=>e.event==='conversion.gpu.fallback'),chunks=logs.filter(e=>e.event==='chunk.complete');
    assert.equal(snapshot.scenes[0].pointCount,1024);assert.ok(chunks.length>1);
    assert.equal(new Set(chunks.map(e=>e.data.id)).size,chunks.length,'completed chunks not regenerated');
    if(fault==='none'){assert.equal(ready.length,1);assert.equal(fallback.length,0,JSON.stringify(fallback));}
    else {
      assert.equal(fallback.length,1,JSON.stringify(fallback));
      if(fault==='device-lost'){assert.equal(ready.length,1);assert.ok(logs.indexOf(chunks[0])<logs.indexOf(fallback[0]));assert.notEqual(fallback[0].data.block,chunks[0].data.id);}
      else assert.equal(ready.length,0);
    }
    record.passed=true;console.log(`PASS conversion GPU ${fault}`);
    await app.close();app=null;
  }
}finally {if(app)await app.close();xvfb?.kill();await writeFile(join(dest,'results.json'),JSON.stringify(results,null,2));}
