import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,rm,readFile,readdir,cp} from 'node:fs/promises';
import {nativeFixture} from './native-fixture.mjs';
// A copied runtime is essential: this test intentionally omits --data-dir.
if(!process.env.PORTABLE_TEST_EXECUTABLE)throw new Error('Set PORTABLE_TEST_EXECUTABLE to an isolated packaged Linux runtime.');
const source=resolve(process.env.PORTABLE_TEST_EXECUTABLE,'..');
const output=resolve('test-results/shared-scenes'),usb=join(output,'USB-共享'),runtime=join(usb,'Linux');
await rm(usb,{recursive:true,force:true});await mkdir(usb,{recursive:true});
await cp(source,runtime,{recursive:true,verbatimSymlinks:true,filter:file=>!['scenes','.portable-profile'].some(part=>file.slice(source.length).split('/').includes(part))});
const shared=join(usb,'scenes','scene-shared'),legacy=join(runtime,'scenes','scene-legacy');
const fixture=await nativeFixture(shared);
await writeFile(join(shared,'scene.json'),JSON.stringify({...fixture,id:'scene-shared',name:'共享场景'}));
await cp(shared,legacy,{recursive:true});await writeFile(join(legacy,'scene.json'),JSON.stringify({...fixture,id:'scene-legacy',name:'旧目录场景'}));
const xvfb=process.env.DISPLAY?null:spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':187','-screen','0','1360x1000x24','-nolisten','tcp'],{stdio:'ignore'});
if(xvfb)await new Promise(r=>setTimeout(r,500));
let app;const result={};
try{
 app=await electron.launch({executablePath:join(runtime,'Portable-3DGS-Viewer'),chromiumSandbox:true,env:{...process.env,DISPLAY:process.env.DISPLAY||':187'}});
 const page=await app.firstWindow();await expect(page.locator('.scene-card')).toHaveCount(2);
 const info=await page.evaluate(()=>window.portableDesktop.info());
 assert.equal(info.scenesDirectory,join(usb,'scenes'));
 assert.deepEqual(info.sceneScanDirectories,[join(usb,'scenes'),join(runtime,'scenes')]);
 const token=await page.evaluate(()=>window.portableDesktop.begin('scene-created'));
 const staging=await readdir(join(usb,'scenes'));
 assert.ok(staging.some(name=>name.startsWith('.converting-')));
 for(const file of [fixture.cover,fixture.collision,...fixture.resources.map(r=>r.file)]){
   await page.evaluate(({token,file,bytes})=>window.portableDesktop.write(token,file,new Uint8Array(bytes)),{token,file,bytes:[...await readFile(join(shared,file))]});
 }
 await page.evaluate(({token,manifest})=>window.portableDesktop.commit(token,manifest),{token,manifest:{...fixture,id:'scene-created',name:'新保存场景'}});
 await expect(page.locator('.scene-card')).toHaveCount(3,{timeout:10000});
 assert.equal(JSON.parse(await readFile(join(usb,'scenes','scene-created','scene.json'),'utf8')).name,'新保存场景');
 const legacyCard=page.locator('.scene-card').filter({hasText:'旧目录场景'});
 await legacyCard.locator('.scene-rename').click();await page.locator('#rename-name').fill('旧目录已改名');await page.locator('#rename-save').click();
 await expect(legacyCard).toHaveCount(0);
 assert.equal(JSON.parse(await readFile(join(legacy,'scene.json'),'utf8')).name,'旧目录已改名');
 const snapshot=await page.evaluate(()=>window.portableDiagnostics.snapshot());
 result.directory=info.scenesDirectory;result.directories=info.sceneScanDirectories;
 result.defaultSaveVerified=true;result.legacyRenameVerified=true;result.diagnostics=snapshot.logs.filter(e=>e.event==='library.autoload');result.passed=true;
}finally{if(app)await app.close();xvfb?.kill();await writeFile(join(output,'native-default.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
