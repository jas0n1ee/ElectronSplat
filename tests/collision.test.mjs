import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('.build/collision-test',{recursive:true});
await build({stdin:{contents:"export {decodeCollision} from './src/collision';export {SphereMover} from './vendor/supersplat-viewer/cameras/sphere-mover';export {Vec3} from 'playcanvas';",resolveDir:process.cwd()},outfile:'.build/collision-test/runtime.mjs',bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const {decodeCollision,SphereMover,Vec3}=await import('../.build/collision-test/runtime.mjs');
const meta={version:'1.1',gridBounds:{min:[0,0,0],max:[.4,.4,.4]},voxelResolution:.1,leafSize:4,treeDepth:0,nodeCount:1,leafDataCount:0,numMixedLeaves:0,numInteriorNodes:0};
test('official voxel 1.1 and SphereMover stop a 0.2m sphere during a fast sweep',()=>{
 const collider=decodeCollision(meta,new Uint32Array([0xff000000]).buffer);
 const out={x:0,y:0,z:0};assert.equal(collider.querySphere(.2,.2,.2,.1,out),true);assert.equal(collider.querySphere(-.5,.2,.2,.1,out),false);
 const mover=new SphereMover(.1);mover.collision=collider;const p=new Vec3(-1,.2,.2);mover.reset(p);mover.move(p,new Vec3(2,.05,0));
 assert.ok(p.x<-.099&&p.x>-.15,JSON.stringify(p));assert.ok(p.y>.2);assert.equal(mover.radius,.1);
});
test('official file boundary rejects truncated data, invalid resolution and cyclic nodes',()=>{
 assert.throws(()=>decodeCollision(meta,new ArrayBuffer(0)),/长度/);
 assert.throws(()=>decodeCollision({...meta,voxelResolution:0},new Uint32Array([0xff000000]).buffer),/无效/);
 assert.throws(()=>decodeCollision(meta,new Uint32Array([0x01000000]).buffer),/子节点/);
 assert.throws(()=>decodeCollision(meta,new Uint32Array([0]).buffer),/叶节点/);
});
