import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { nativeFixture } from './native-fixture.mjs';
const output = resolve('.build/library-test');
await mkdir(output, { recursive:true });
await build({entryPoints:['src/manifest.ts'],outfile:join(output,'manifest.cjs'),bundle:true,platform:'node',format:'cjs'});
await cp('desktop/library.cjs',join(output,'library.cjs'));
const {Library}=createRequire(import.meta.url)(join(output,'library.cjs'));
const fixture=await mkdtemp(join(tmpdir(),'portable-fixture-'));
after(()=>rm(fixture,{recursive:true,force:true}));
const source=await nativeFixture(fixture);
const paths=[source.cover,source.collision,...source.resources.map(r=>r.file)];
async function setup(t){const root=await realpath(await mkdtemp(join(tmpdir(),'portable-native-')));t.after(()=>rm(root,{recursive:true,force:true}));const lib=new Library(root);await lib.init();return{root,lib};}
test('shared scenes and legacy scenes are discovered and edited in their own directories; new scenes save to shared root',async t=>{
  const {root}=await setup(t),legacyRoot=join(root,'Linux');
  const lib=new Library(root,[legacyRoot]);await lib.init();
  assert.equal((await lib.scan()).errors.length,0); // Missing optional old folder is normal.
  const oldDir=join(legacyRoot,'scenes','old');await cp(fixture,oldDir,{recursive:true});
  const sharedDir=join(root,'scenes','shared');await cp(fixture,sharedDir,{recursive:true});
  await writeFile(join(sharedDir,'scene.json'),JSON.stringify({...source,id:'scene-shared'}));
  const scan=await lib.scan();assert.equal(scan.scenes.length,2);
  assert.deepEqual(scan.directories,[join(root,'scenes'),join(legacyRoot,'scenes')]);
  const old=scan.scenes.find(s=>s.manifest.id===source.id);
  assert.equal(await lib.sceneDirectory(old.token),oldDir);
  assert.equal(await lib.resource(old.token,source.cover),join(oldDir,source.cover));
  await lib.renameScene(old.token,'旧目录重命名');
  const saved=await lib.saveCover(old.token,new Uint8Array(await readFile(join(fixture,source.cover))),{position:[1,2,3],yaw:25,pitch:0});
  assert.equal(JSON.parse(await readFile(join(oldDir,'scene.json'),'utf8')).cover,saved.manifest.cover);
  assert.equal(await lib.resource(old.token,saved.manifest.cover),join(oldDir,saved.manifest.cover));
  const tx=await lib.begin('scene-new-shared');
  for(const file of paths)await lib.write(tx,file,new Uint8Array(await readFile(join(fixture,file))));
  const created=await lib.commit(tx,{...source,id:'scene-new-shared'});
  assert.equal(await lib.sceneDirectory(created.token),join(root,'scenes','scene-new-shared'));
  assert.equal((await lib.scan()).scenes.length,3);
  await lib.deleteScene(old.token);
  assert.deepEqual(await readdir(join(legacyRoot,'scenes')),[]);
  assert.equal((await lib.scan()).scenes.length,2);
});

test('shared duplicate IDs take priority; roots are deduplicated and stale legacy tokens cannot escape',async t=>{
  const {root}=await setup(t),legacyRoot=join(root,'Win');
  const sharedDir=join(root,'scenes','shared'),oldDir=join(legacyRoot,'scenes','old');
  await cp(fixture,sharedDir,{recursive:true});await cp(fixture,oldDir,{recursive:true});
  const lib=new Library(root,[root,legacyRoot]);await lib.init();
  const scan=await lib.scan();assert.equal(scan.scenes.length,1);assert.equal(scan.errors.length,1);
  assert.match(scan.errors[0].message,/重复场景 ID/);
  assert.equal(await lib.sceneDirectory(scan.scenes[0].token),sharedDir);
  await writeFile(join(oldDir,'scene.json'),JSON.stringify({...source,id:'scene-old'}));
  const old=(await lib.scan()).scenes.find(s=>s.manifest.id==='scene-old');
  await rm(oldDir,{recursive:true});await symlink(sharedDir,oldDir);
  await assert.rejects(lib.resource(old.token,source.cover),/目录已变化/);
  await assert.rejects(lib.deleteScene(old.token),/目录已变化/);
  assert.equal(JSON.parse(await readFile(join(sharedDir,'scene.json'),'utf8')).id,source.id);
});
test('native scan discovers copies after startup, rejects partial scenes and refreshes covers',async t=>{
  const {root,lib}=await setup(t);assert.equal((await lib.scan()).scenes.length,0);
  const dir=join(root,'scenes','中文 场景');await mkdir(dir);await writeFile(join(dir,'scene.json'),JSON.stringify(source));
  assert.equal((await lib.scan()).errors.length,1);
  await cp(fixture,dir,{recursive:true});const first=await lib.scan();assert.equal(first.scenes.length,1);
  const entry=first.scenes[0];await writeFile(join(dir,source.cover),Buffer.from([137,80,78,71,13,10,26,10,1]));
  const next=await lib.scan();assert.notEqual(next.scenes[0].revision,entry.revision);
  await rm(dir,{recursive:true});assert.equal((await lib.scan()).scenes.length,0);
});
test('native reads reject traversal, unlisted resources and symlinks escaping the scene',async t=>{
  const {root,lib}=await setup(t),dir=join(root,'scenes','space');await cp(fixture,dir,{recursive:true});
  const {scenes:[entry]}=await lib.scan();
  await assert.rejects(lib.resource(entry.token,'../secret'));
  await writeFile(join(dir,'private.txt'),'not a scene resource');await assert.rejects(lib.resource(entry.token,'private.txt'));
  const secret=join(root,'secret');await writeFile(secret,'secret');
  await rm(join(dir,source.cover));await symlink(secret,join(dir,source.cover));
  await assert.rejects(lib.resource(entry.token,source.cover),/目录外部/);
  assert.equal((await lib.scan()).scenes.length,0);
});
test('native conversion publishes only a complete scene, persists bytes, and cancels owned staging',async t=>{
  const {root,lib}=await setup(t),id='scene-native-test',manifest={...source,id};
  const token=await lib.begin(id);assert.equal((await lib.scan()).scenes.length,0);
  await assert.rejects(lib.write(token,'../escape',new Uint8Array([1])));
  for(const file of paths)await lib.write(token,file,new Uint8Array(await readFile(join(fixture,file))));
  const entry=await lib.commit(token,manifest);assert.equal((await lib.scan()).scenes.length,1);
  assert.equal(JSON.parse(await readFile(join(root,'scenes',id,'scene.json'),'utf8')).id,id);
  await assert.rejects(lib.begin(id),/已存在/);
  await assert.rejects(lib.write(token,'cover.png',new Uint8Array([1])),/取消/);
  const cover=new Uint8Array(await readFile(join(fixture,source.cover)));const saved=await lib.saveCover(entry.token,cover,{position:[1,2,3],yaw:45,pitch:-15});
  assert.deepEqual(saved.manifest.camera,{position:[1,2,3],yaw:45,pitch:-15});
  assert.equal(saved.manifest.cameraSource,'cover');
  assert.deepEqual(await readFile(join(root,'scenes',id,source.cover)),Buffer.from(cover));
  await assert.rejects(lib.saveCover(entry.token,new Uint8Array([1,2,3])),/PNG/);
  const cancelled=await lib.begin('scene-cancelled');await lib.write(cancelled,'cover.png',cover);await lib.abort(cancelled);
  assert.deepEqual(await readdir(join(root,'scenes')),[id]);
});
test('missing resources and wrong byte sizes cannot be committed',async t=>{
  const {lib}=await setup(t),id='scene-incomplete',token=await lib.begin(id);
  await assert.rejects(lib.commit(token,{...source,id}));assert.equal((await lib.scan()).scenes.length,0);
  await lib.abort(token);
});
test('scene folder actions reject stale directories and delete only the selected scene, without following links',async t=>{
  const {root,lib}=await setup(t),dir=join(root,'scenes','selected'),other=join(root,'scenes','other');
  await cp(fixture,dir,{recursive:true});await cp(fixture,other,{recursive:true});
  await writeFile(join(other,'scene.json'),JSON.stringify({...source,id:'scene-other'}));
  const entry=(await lib.scan()).scenes.find(s=>s.manifest.id===source.id);
  assert.equal(await lib.sceneDirectory(entry.token),dir);
  const secret=join(root,'keep.txt');await writeFile(secret,'keep');await symlink(secret,join(dir,'user-link'));
  await assert.rejects(lib.deleteScene('unknown'));
  await lib.deleteScene(entry.token);assert.equal(await readFile(secret,'utf8'),'keep');
  assert.equal((await lib.scan()).scenes[0].manifest.id,'scene-other');await assert.rejects(lib.sceneDirectory(entry.token));
  const token=(await lib.scan()).scenes[0].token;
  await rm(other,{recursive:true});await symlink(root,other);
  await assert.rejects(lib.deleteScene(token),/目录已变化/);assert.equal(await readFile(secret,'utf8'),'keep');
});
test('official default 512K file units are accepted, but ranges beyond actual SOG counts are rejected',async t=>{
  const {root,lib}=await setup(t),dir=join(root,'scenes','large-unit');await cp(fixture,dir,{recursive:true});
  const manifest=structuredClone(source),meta=JSON.parse(await readFile(join(dir,'lod/lod-meta.json'),'utf8'));
  const sog=JSON.parse(await readFile(join(dir,'lod/0_0/meta.json'),'utf8'));
  sog.count=524288;meta.counts[0]=524288;meta.count=524291;meta.tree.lods[0].count=524288;
  manifest.pointCount=524288;manifest.streams[0].pointCount=524288;
  const save=async(file,data)=>{const bytes=Buffer.from(JSON.stringify(data));await writeFile(join(dir,file),bytes);manifest.resources.find(r=>r.file===file).bytes=bytes.length;};
  await save('lod/0_0/meta.json',sog);await save('lod/lod-meta.json',meta);await writeFile(join(dir,'scene.json'),JSON.stringify(manifest));
  assert.equal((await lib.scan()).scenes.length,1);
  meta.tree.lods[0].offset=1;await save('lod/lod-meta.json',meta);await writeFile(join(dir,'scene.json'),JSON.stringify(manifest));
  const result=await lib.scan();assert.equal(result.scenes.length,0);assert.match(result.errors[0].message,/超过 SOG 点数/);
});
test('optional official environment must reference registered SOG and texture dependencies',async t=>{
  const {root,lib}=await setup(t),dir=join(root,'scenes','environment');await cp(fixture,dir,{recursive:true});
  const manifest=structuredClone(source),meta=JSON.parse(await readFile(join(dir,'lod/lod-meta.json'),'utf8'));meta.environment='env/meta.json';
  const data=Buffer.from(JSON.stringify(meta));await writeFile(join(dir,'lod/lod-meta.json'),data);manifest.resources.find(r=>r.file==='lod/lod-meta.json').bytes=data.length;
  await writeFile(join(dir,'scene.json'),JSON.stringify(manifest));
  const result=await lib.scan();assert.equal(result.scenes.length,0);assert.match(result.errors[0].message,/未登记/);
});

test('rename atomically persists only scene display name and preserves data and identity',async t=>{
  const {root,lib}=await setup(t),dir=join(root,'scenes','unchanged-directory');await cp(fixture,dir,{recursive:true});
  const original={...source,customMetadata:{keep:true}};await writeFile(join(dir,'scene.json'),JSON.stringify(original));
  const before=new Map(await Promise.all(paths.map(async file=>[file,await readFile(join(dir,file))])));
  const entry=(await lib.scan()).scenes[0];
  for(const name of ['', '  ', 'x'.repeat(101), 'line\nbreak', null])await assert.rejects(lib.renameScene(entry.token,name),/名称/);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'scene.json'),'utf8')),original);
  const renamed=await lib.renameScene(entry.token,'  新场景 · 门厅  ');
  assert.equal(renamed.token,entry.token);assert.equal(renamed.manifest.id,original.id);assert.equal(renamed.manifest.name,'新场景 · 门厅');
  assert.deepEqual(JSON.parse(await readFile(join(dir,'scene.json'),'utf8')),{...original,name:'新场景 · 门厅'});
  for(const [file,bytes] of before)assert.deepEqual(await readFile(join(dir,file)),bytes,file);
  assert.deepEqual(await readdir(join(root,'scenes')),['unchanged-directory']);assert.ok(!(await readdir(dir)).some(file=>file.endsWith('.tmp')));
  const reopened=new Library(root);await reopened.init();assert.equal((await reopened.scan()).scenes[0].manifest.name,'新场景 · 门厅');
});

test('rename rejects deleted/replaced scenes and escaping manifest symlinks',async t=>{
  const {root,lib}=await setup(t),dir=join(root,'scenes','space');await cp(fixture,dir,{recursive:true});
  const entry=(await lib.scan()).scenes[0],secret=join(root,'secret.json');await writeFile(secret,JSON.stringify(source));
  await rm(join(dir,'scene.json'));await symlink(secret,join(dir,'scene.json'));await assert.rejects(lib.renameScene(entry.token,'new'),/目录外部/);
  assert.equal(JSON.parse(await readFile(secret,'utf8')).name,source.name);
  await rm(join(dir,'scene.json'));await writeFile(join(dir,'scene.json'),JSON.stringify({...source,id:'scene-replaced'}));await assert.rejects(lib.renameScene(entry.token,'new'),/场景已变化/);
  await rm(dir,{recursive:true});await assert.rejects(lib.renameScene(entry.token,'new'));
});

test('cover and exact camera pose publish together and survive a new Library instance',async t=>{
 const {root,lib}=await setup(t);const dir=join(root,'scenes',source.id);await cp(fixture,dir,{recursive:true});
 const entry=(await lib.scan()).scenes[0],png=new Uint8Array(await readFile(join(dir,source.cover)));
 const pose={position:[-2,1.75,9],yaw:143.25,pitch:-17.5};
 const saved=await lib.saveCover(entry.token,png,pose);
 const disk=JSON.parse(await readFile(join(dir,'scene.json'),'utf8'));
 assert.deepEqual(disk.camera,pose);assert.equal(disk.cover,saved.manifest.cover);
 assert.deepEqual(await readFile(join(dir,disk.cover)),Buffer.from(png));
 const before=await readFile(join(dir,'scene.json'));
 await assert.rejects(()=>lib.saveCover(entry.token,png,{position:[NaN,0,0],yaw:0,pitch:0}),/相机/);
 assert.deepEqual(await readFile(join(dir,'scene.json')),before);
 const restarted=new Library(root);await restarted.init();assert.deepEqual((await restarted.scan()).scenes[0].manifest.camera,pose);
 const second=await lib.saveCover(entry.token,png,{...pose,yaw:12});
 assert.notEqual(second.manifest.cover,disk.cover);
 assert.ok(!(await readdir(dir)).includes(disk.cover));
});
