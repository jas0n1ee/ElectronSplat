import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {fixture,baseNames} from './fixtures.mjs';
const dir=await mkdtemp(`${tmpdir()}/portable-tests-`);
await build({entryPoints:['src/ply.ts','src/manifest.ts','src/coordinates.ts','src/lod.ts','src/types.ts'],outdir:dir,platform:'node',format:'esm',bundle:true,outExtension:{'.js':'.mjs'},logLevel:'silent'});
const {readHeader,readChunks}=await import(pathToFileURL(`${dir}/ply.mjs`));
const {safePath,validateManifest}=await import(pathToFileURL(`${dir}/manifest.mjs`));
for(const [name,options] of [['little-endian',{}],['big-endian',{bigEndian:true}],['ASCII',{ascii:true}],['UTF-8 header',{unicode:true}],['SH',{sh:true}]]){
  test(`streams ${name} Gaussian PLY with exact final chunk`,async()=>{
    const blob=fixture({...options,count:257});const h=await readHeader(blob);let total=0;const starts=[];
    for await(const part of readChunks(blob,h,64)){total+=part.count;starts.push(part.start);assert.ok(Math.abs(part.columns.x[0]-((part.start%16)*0.07-0.5))<1e-6);assert.equal(part.columns.rot_0[0],1);}
    assert.equal(total,257);assert.deepEqual(starts,[0,64,128,192,256]);
  });
}
test('rejects truncated, missing-field and compressed PLY inputs',async()=>{
  const valid=fixture();await assert.rejects(()=>readHeader(valid.slice(0,valid.size-1)),/截断/);
  await assert.rejects(()=>readHeader(new Blob(['ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n'])),/缺少/);
  await assert.rejects(()=>readHeader(new Blob(['ply\nformat binary_little_endian 1.0\nelement chunk 1\nend_header\n'])),/compressed/);
});
test('byte addressing works beyond 2 GiB without allocating a full source',async()=>{
  const count=40_000_001,stride=baseNames.length*4;
  const header=`ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${baseNames.map(n=>`property float ${n}`).join('\n')}\nend_header\n`;
  let maxSlice=0,lastStart=0;
  const source={size:header.length+count*stride,slice(start=0,end=this.size){maxSlice=Math.max(maxSlice,end-start);lastStart=start;assert.ok(end-start<=1024*1024);if(start===0)return new Blob([header,new Uint8Array(100)]);const row=new ArrayBuffer(stride),v=new DataView(row);v.setFloat32(0,123.5,true);v.setFloat32(40,1,true);return new Blob([row]);}};
  const h=await readHeader(source);const last={...h,count:1,offset:h.offset+(count-1)*stride};
  for await(const part of readChunks(source,last,1))assert.equal(part.columns.x[0],123.5);
  assert.ok(lastStart>2**31);assert.ok(maxSlice<=1024*1024);
});
test('manifest paths cannot escape the selected scene directory',()=>{
  for(const path of ['../secret','/etc/passwd','a/../../b','a\\b','file:/a','a/%2e%2e/b','a//b','a/./b','a\u0000b'])assert.throws(()=>safePath(path),/无效/);
  assert.equal(safePath('lod/fg-000001/lod1.sog'),'lod/fg-000001/lod1.sog');
});
test('manifest rejects legacy scenes and validates official stream/resource records',async()=>{
  const {nativeFixture}=await import('./native-fixture.mjs');
  const s=await nativeFixture(dir+'/fixture');
  assert.equal(validateManifest(s).version,2);
  assert.throws(()=>validateManifest({...s,version:1}),/重新转换/);
  for(const alter of [x=>x.streams=[],x=>x.camera.position[0]=NaN,x=>x.resources.push({...x.resources[0]}),x=>x.resources[0].bytes=2e9,x=>x.resources[0].file='../bad.sog']){
    const copy=structuredClone(s);alter(copy);assert.throws(()=>validateManifest(copy));
  }
});

const {displayRotation,rotatePoint,rotateBounds,DISPLAY_ROTATION}=await import(pathToFileURL(`${dir}/coordinates.mjs`));
const {spawnPose}=await import(pathToFileURL(`${dir}/types.mjs`));
const {LOD_BUDGETS,DESKTOP_LOD_BUDGETS}=await import(pathToFileURL(`${dir}/lod.mjs`));
const close3=(actual,expected)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-9,`${actual} != ${expected}`));
test('Z-up eye height and legacy SOG/voxel coordinates agree without translating or double rotating',()=>{
  close3(rotatePoint(displayRotation([0,0,0]),[2,3,1.4]),[-2,1.4,3]);
  const rotation=displayRotation([0,0,180]);
  close3(rotatePoint(rotation,[-2,-3,1.4]),[-2,1.4,3]);
  close3(rotatePoint(rotation,[0,0,0]),[0,0,0]);
  close3(rotatePoint(displayRotation(DISPLAY_ROTATION),[2,3,4]),[2,3,4]);
  assert.deepEqual(spawnPose(),{position:[0,1.4,0],yaw:0,pitch:0});
  const box=rotateBounds(rotation,{min:[0,-2,0],max:[1,0,1]});
  close3(box.min,[0,0,0]);close3(box.max,[1,1,2]);

});
test('viewer grade budgets remain unchanged',()=>{
  assert.deepEqual(LOD_BUDGETS,[1e6,1.5e6,2e6,3e6]);
  assert.deepEqual(DESKTOP_LOD_BUDGETS,[3e6,4.5e6,6e6,9e6]);
});
