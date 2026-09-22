import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(`${tmpdir()}/portable-tests-`);
await build({entryPoints:['src/manifest.ts','src/coordinates.ts','src/lod.ts','src/movement.ts','src/types.ts'],outdir:dir,platform:'node',format:'esm',bundle:true,outExtension:{'.js':'.mjs'},logLevel:'silent'});
const {safePath,validateManifest}=await import(pathToFileURL(`${dir}/manifest.mjs`));
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
const {moveDelta}=await import(pathToFileURL(`${dir}/movement.mjs`));
const {spawnPose}=await import(pathToFileURL(`${dir}/types.mjs`));
const {DESKTOP_LOD_BUDGETS}=await import(pathToFileURL(`${dir}/lod.mjs`));
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
test('desktop LOD budgets remain unchanged',()=>{
  assert.deepEqual(DESKTOP_LOD_BUDGETS,[3e6,4.5e6,6e6,9e6]);
});

test('movement never gains altitude from pitch',()=>{
  // The defect this replaced: PlayCanvas camera.forward is
  // (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)), so W climbed
  // in proportion to sin(pitch) and became near-vertical at the +-89 clamp.
  assert.ok(Math.abs(Math.sin(45*Math.PI/180))>0.7);
  for(const yaw of [0,30,-120,180]){
    for(const [fwd,strafe] of [[1,0],[-1,0],[0,1],[0,-1],[1,1]]){
      assert.equal(moveDelta(yaw,fwd,strafe,0,5)[1],0,`yaw=${yaw} forward=${fwd} strafe=${strafe} gained altitude`);
    }
  }
});
test('Q and E are the only height control',()=>{
  close3(moveDelta(0,0,0,1,2),[0,2,0]);
  close3(moveDelta(0,0,0,-1,2),[0,-2,0]);
  // height is independent of yaw
  close3(moveDelta(37,0,0,-1,2),[0,-2,0]);
});
test('yaw-only basis matches the camera vectors at level pitch',()=>{
  close3(moveDelta(0,1,0,0,1),[0,0,-1]);
  close3(moveDelta(0,0,1,0,1),[1,0,0]);
  close3(moveDelta(90,1,0,0,1),[-1,0,0]);
  close3(moveDelta(90,0,1,0,1),[0,0,-1]);
  close3(moveDelta(180,1,0,0,1),[0,0,1]);
});
test('combined axes stay normalized and released keys produce no drift',()=>{
  const length=v=>Math.hypot(v[0],v[1],v[2]);
  for(const args of [[1,0,0],[0,1,0],[1,1,0],[1,1,1],[1,0,-1]]){
    assert.ok(Math.abs(length(moveDelta(0,...args,3))-3)<1e-9,`not normalized: ${args}`);
  }
  // Tolerance, not deepEqual: float math yields -0 for the z axis, which is
  // numerically equal to 0 and harmless (0 + -0 === 0).
  close3(moveDelta(0,0,0,0,3),[0,0,0]);
});
