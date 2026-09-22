import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import {nativeFixture} from './native-fixture.mjs';
const root=resolve('test-results/scene-rename');await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
const sceneDir=join(root,'scenes','scene-native-fixture'),source=await nativeFixture(sceneDir);
const xvfb=process.env.DISPLAY?null:spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':193','-screen','0','1360x1000x24','-nolisten','tcp'],{stdio:'ignore'});if(xvfb)await new Promise(r=>setTimeout(r,500));
let app;const result={checks:[],errors:[]};
const launch=()=>electron.launch({executablePath:resolve(process.env.PORTABLE_TEST_EXECUTABLE||'desktop-dist/ElectronSplat-linux-x64/ElectronSplat'),chromiumSandbox:true,args:[`--data-dir=${root}`],env:{...process.env,DISPLAY:process.env.DISPLAY||':193'}});
try {
 app=await launch();let page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));await expect(page.locator('.scene-card')).toHaveCount(1);
 assert.deepEqual(await page.locator('.scene-actions button').allTextContents(),['打开数据文件夹','重命名场景','永久删除场景']);
 for(const width of [1360,860]){
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);
  await expect.poll(()=>page.evaluate(()=>window.outerWidth)).toBe(width);
  const sizes=await page.locator('.scene-actions button').evaluateAll(buttons=>buttons.map(b=>({width:b.getBoundingClientRect().width,overflow:b.scrollWidth>b.clientWidth})));
  assert.ok(Math.max(...sizes.map(s=>s.width))-Math.min(...sizes.map(s=>s.width))<1);assert.ok(sizes.every(s=>!s.overflow));
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1360,900));
 await page.locator('.scene-rename').click();await expect(page.locator('#rename-name')).toHaveValue(source.name);
 await page.locator('#rename-name').fill('不会保存');await page.locator('#rename-cancel').click();await expect(page.locator('.scene-content h2')).toHaveText(source.name);
 await page.locator('.scene-rename').click();await page.locator('#rename-name').fill('   ');await page.locator('#rename-save').click();await expect(page.locator('#rename-error')).toContainText('请填写');
 await page.locator('#rename-name').fill('新场景 · 门厅');await page.locator('#rename-save').click();await expect(page.locator('#rename-dialog')).not.toBeVisible();await expect(page.locator('.scene-content h2')).toHaveText('新场景 · 门厅');
 assert.deepEqual(JSON.parse(await readFile(join(sceneDir,'scene.json'),'utf8')),{...source,name:'新场景 · 门厅'});
 await page.locator('#search').fill('新场景');await expect(page.locator('.scene-card')).toHaveCount(1);await page.locator('#search').fill(source.name);await expect(page.locator('.scene-card')).toHaveCount(0);await page.locator('#search').fill('');
 result.checks.push('three ordered equal-width buttons fit at 1360px and 860px; prefilled rename, cancellation, blank input, save and search work');
 await app.evaluate(({ipcMain})=>{globalThis.renameHandler=ipcMain._invokeHandlers.get('portable:rename-scene');ipcMain.removeHandler('portable:rename-scene');ipcMain.handle('portable:rename-scene',()=>{throw new Error('模拟磁盘只读');});});
 await page.locator('.scene-rename').click();await page.locator('#rename-name').fill('保留输入');await page.locator('#rename-save').click();await expect(page.locator('#rename-error')).toContainText('模拟磁盘只读');await expect(page.locator('#rename-name')).toHaveValue('保留输入');await expect(page.locator('.scene-content h2')).toHaveText('新场景 · 门厅');await page.locator('#rename-cancel').click();
 result.checks.push('write failure preserves dialog input and existing displayed name');
 await page.screenshot({path:join(root,'library.png')});await app.close();app=await launch();page=await app.firstWindow();await expect(page.locator('.scene-content h2')).toHaveText('新场景 · 门厅');
 assert.deepEqual(await readdir(join(root,'scenes')),['scene-native-fixture']);
 await app.evaluate(({shell,dialog})=>{globalThis.opened=[];shell.openPath=async path=>{globalThis.opened.push(path);return '';};globalThis.deleteQuestion=null;dialog.showMessageBox=async(_window,options)=>{globalThis.deleteQuestion=options;return {response:0};};});
 await page.locator('.scene-folder').click();await expect.poll(()=>app.evaluate(()=>globalThis.opened)).toEqual([sceneDir]);
 await page.locator('.scene-delete').click();await expect.poll(()=>app.evaluate(()=>globalThis.deleteQuestion?.message)).toContain('新场景 · 门厅');
 assert.equal((await readdir(join(root,'scenes'))).length,1);result.checks.push('restart retains name; folder action targets same directory; deletion confirmation uses new name');
 assert.deepEqual(result.errors,[]);result.passed=true;
}catch(error){result.failure=error.stack;throw error;}
finally{if(app)await app.close();xvfb?.kill();await writeFile(join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
