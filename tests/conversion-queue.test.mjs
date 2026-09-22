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
 // The model divides by the summed byte count, so the result carries float error; compare with a
 // tolerance rather than demanding bit-exact results from expressions written a different way.
 const close=(expected,label)=>assert.ok(Math.abs(progress.value-expected)<1e-9,`${label}: ${progress.value} != ${expected}`);
 values.push(progress.input(0,0,0),progress.input(0,1,.2),progress.input(0,1,1));
 close(.02+.30*.75,'after foreground');
 values.push(progress.input(1,0,0),progress.input(1,1,0),progress.input(1,1,1));
 close(.32,'after background');
 values.push(progress.partition(0),progress.partition(.5),progress.partition(1));
 values.push(progress.encoded(0,4),progress.encoded(1,4),progress.encoded(0,4),progress.encoded(4,4));
 close(.89,'after encode');
 values.push(progress.voxel(.5),progress.voxel(0),progress.voxel(1));
 close(.96,'after voxel');
 values.push(progress.workerComplete(),progress.advance(NaN),progress.advance(1));
 close(.97,'after completion');assert.deepEqual(values,[...values].sort((a,b)=>a-b));
});

test('phase-relative reports from the converter compose into one non-resetting bar',()=>{
 const progress=new ConversionProgress([300]);const seen=[];
 const step=(phase,fraction)=>seen.push(progress.byPhase(phase,fraction));
 // A whole conversion in the order the converter reports it, each phase running 0 -> 1.
 step('decimate',0);step('decimate',.5);step('decimate',1);
 step('partition',0);step('partition',.5);step('partition',1);
 step('encode',0);step('encode',.5);step('encode',1);
 step('voxel',0);step('voxel',.5);step('voxel',1);
 assert.deepEqual(seen,[...seen].sort((a,b)=>a-b),'the bar must never move backwards');
 assert.equal(progress.value,.96);
 // The regression this guards: finishing an early phase must not land near the top. Feeding raw
 // per-phase ratios in as if they were whole-scene values put the bar at 99% when partitioning
 // ended, and queue.update's Math.max then pinned it there for the rest of the conversion.
 // Asserted as a property rather than against the band numbers, so re-tuning the widths to match
 // new measurements cannot silently break it.
 const fresh=new ConversionProgress([300]);
 const marks=['decimate','partition','errors','encode','voxel'].map(p=>fresh.byPhase(p,1));
 assert.deepEqual(marks,[...marks].sort((a,b)=>a-b),'each phase must end above the last');
 assert.ok(marks[0]<.5,`decimation completing left no room: ${marks[0]}`);
 assert.ok(marks[marks.length-1]<.97,`the last phase ran into completion: ${marks[marks.length-1]}`);
 // A phase that restarts -- a new decimation level, a new encoding unit -- must not pull it down.
 const at=progress.value;
 assert.equal(progress.byPhase('encode',0),at);
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
