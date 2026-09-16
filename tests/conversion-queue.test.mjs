import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(`${tmpdir()}/portable-queue-tests-`);
await build({entryPoints:['src/conversion-queue.ts','src/conversion-progress.ts'],outdir:dir,platform:'node',format:'esm',bundle:true,outExtension:{'.js':'.mjs'},logLevel:'silent'});
const {ConversionQueue}=await import(pathToFileURL(`${dir}/conversion-queue.mjs`));
const {ConversionProgress}=await import(pathToFileURL(`${dir}/conversion-progress.mjs`));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('whole-scene estimate weights foreground/background and never restarts between phases',()=>{
 const progress=new ConversionProgress([300,100]);const values=[];
 values.push(progress.input(0,0,0),progress.input(0,1,.2),progress.input(0,1,1));
 assert.equal(progress.value,.02+.53*.75);
 values.push(progress.input(1,0,0),progress.input(1,1,0),progress.input(1,1,1));
 assert.equal(progress.value,.55);
 values.push(progress.partition(0),progress.partition(.5),progress.partition(1));
 values.push(progress.encoded(0,4),progress.encoded(1,4),progress.encoded(0,4),progress.encoded(4,4));
 assert.equal(progress.value,.86);
 values.push(progress.voxel(.5),progress.voxel(0),progress.voxel(1));
 assert.equal(progress.value,.96);
 values.push(progress.workerComplete(),progress.advance(NaN),progress.advance(1));
 assert.equal(progress.value,.97);assert.deepEqual(values,[...values].sort((a,b)=>a-b));
});

test('queue serializes jobs through commit; submitted payload stays attached to its job',async()=>{
 const gates=[gate(),gate()];const started=[];
 const queue=new ConversionQueue(async job=>{started.push(job.payload.file);await gates[started.length-1].promise;},()=>{});
 const first=queue.enqueue('a','first',{file:'foreground-a',cellSize:.1});
 const second=queue.enqueue('b','second',{file:'foreground-b',cellSize:.5});
 await tick();assert.deepEqual(started,['foreground-a']);assert.equal(queue.pending,2);
 queue.update(first,'编码','',.85);queue.update(first,'背景','',.1);queue.update(first,'提交','',1);
 assert.equal(first.progress,.99);assert.equal(second.progress,0);
 gates[0].resolve();await tick();assert.equal(first.progress,1);assert.equal(first.state,'completed');assert.equal(first.payload,undefined);
 assert.deepEqual(started,['foreground-a','foreground-b']);assert.equal(second.payload.cellSize,.5);
 gates[1].resolve();await tick();assert.equal(queue.pending,0);assert.equal(queue.active,undefined);
});

test('active cancellation waits for cleanup; waiting removal never executes; failures continue',async()=>{
 const cleanup=gate(),started=[];let aborted=false;
 const queue=new ConversionQueue(async(job,signal)=>{
  started.push(job.id);
  if(job.id==='a'){
   await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
   await cleanup.promise;throw new DOMException('cancelled','AbortError');
  }
  if(job.id==='c')throw new Error('bad PLY');
 },()=>{});
 const a=queue.enqueue('a','a',{}),b=queue.enqueue('b','b',{}),c=queue.enqueue('c','c',{}),d=queue.enqueue('d','d',{});
 await tick();queue.cancel('b');queue.cancel('a');await tick();
 assert.equal(aborted,true);assert.deepEqual(started,['a']);assert.equal(b.payload,undefined);
 cleanup.resolve();await tick();assert.deepEqual(started,['a','c','d']);
 assert.equal(a.state,'cancelled');assert.equal(c.state,'failed');assert.equal(c.error,'bad PLY');assert.equal(d.state,'completed');
 assert.equal(queue.pending,0);assert.ok(a.progress<1&&c.progress<1);
});

test('final commit cannot be cancelled',async()=>{
 const commit=gate();let signal;
 const queue=new ConversionQueue(async(job,s)=>{signal=s;job.cancellable=false;await commit.promise;},()=>{});
 const job=queue.enqueue('a','a',{});await tick();queue.cancel('a');assert.equal(signal.aborted,false);
 commit.resolve();await tick();assert.equal(job.state,'completed');
});

test.after(()=>rm(dir,{recursive:true,force:true}));
