import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Column, DataTable, Transform, WorkerQueue, MemoryFileSystem, dataTableToChunkSource, stackLods, writeLodSource, writeFile, readFile as readPly, concatSource, createChunkDataPool, logger } from '@playcanvas/splat-transform';
import { baseNames } from './fixtures.mjs';
import { Quat } from 'playcanvas';
logger.setVerbosity('quiet');
const table=(count,transform=Transform.PLY)=>new DataTable(baseNames.map((name,col)=>new Column(name,Float32Array.from({length:count},(_,i)=>[i%16/10,Math.floor(i/16)/10,0,.2,.3,.4,2,-3,-3,-3,1,0,0,0][col]))),transform);
async function encode(workers,transform=Transform.PLY) {
  WorkerQueue.maxWorkers=workers;
  const source=stackLods([128,64,32].map(n=>dataTableToChunkSource(table(n,transform),128))),fs=new MemoryFileSystem();
  try {await writeLodSource({filename:'/lod/lod-meta.json',mainSource:source,envSource:null,iterations:4,chunkCount:512,chunkExtent:16},fs);return fs.results;}
  finally {await source.close();await WorkerQueue.destroy();}
}
test('official parallel SOG writer preserves inline output bytes and structural LOD counts',async()=>{
  const inline=await encode(0),parallel=await encode(4);
  assert.deepEqual([...inline.keys()].sort(),[...parallel.keys()].sort());
  for(const [file,bytes] of inline)assert.deepEqual(parallel.get(file),bytes,file);
  const meta=JSON.parse(new TextDecoder().decode(parallel.get('/lod/lod-meta.json')));
  assert.deepEqual(meta.counts,[128,64,32]);assert.equal(meta.lodLevels,3);
});
test('official default directory and index validation reject unsafe paths and invalid offsets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'portable-lod-'));
  try {
    await build({entryPoints:['src/manifest.ts'],outdir:dir,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},logLevel:'silent'});
    const {validateLodMeta}=await import(pathToFileURL(join(dir,'manifest.mjs')));
    const files=await encode(0),meta=JSON.parse(new TextDecoder().decode(files.get('/lod/lod-meta.json')));
    assert.deepEqual(meta.filenames,['0_0/meta.json','1_0/meta.json','2_0/meta.json']);
    validateLodMeta(meta);
    for(const alter of [m=>m.filenames[0]='https://remote/secret',m=>m.filenames[0]='../secret/meta.json',m=>m.tree.lods[0].file=999,m=>m.tree.lods[0].offset=-1,m=>m.counts[0]++]){
      const copy=structuredClone(meta);alter(copy);assert.throws(()=>validateLodMeta(copy));
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('disk-staged lazy inputs produce the same official whole-scene output as direct inputs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'portable-staging-'));
  try {
    await build({entryPoints:['src/conversion-io.ts'],outfile:join(dir,'io.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
    // Resolve this dependency from the repository instead of the OS temp directory.
    const {symlink}=await import('node:fs/promises');await symlink(join(process.cwd(),'node_modules'),join(dir,'node_modules'));
    const {WorkFileSystem,OutputFileSystem}=await import(pathToFileURL(join(dir,'io.mjs')));
    const storage=new Map(),ranges=[];
    const work=new WorkFileSystem(async(path,start,end)=>{ranges.push([start,end]);return storage.get(path).slice(start,end).buffer;},4096);
    const staging=new OutputFileSystem(async(path,bytes)=>{storage.set(path,bytes.slice());work.files.set(path,bytes.length);});
    const opened=[],levels=[],transform=new Transform(undefined,new Quat().setFromEulerAngles(90,0,180),1);let pool;
    for(const [lod,count] of [128,64,32].entries()){
      const t=table(count,transform),sources=[];
      for(let half=0;half<2;half++){
        const part=new DataTable(t.columns.map(c=>new Column(c.name,c.data.slice(half*count/2,(half+1)*count/2))),transform);
        const filename=`.work/fg/${lod}/${half}.ply`;
        await writeFile({filename,outputFormat:'ply',dataTable:part,options:{}},staging);
        const input=await readPly({filename,inputFormat:'ply',options:{},fileSystem:work});sources.push(...input);opened.push(...input);
      }
      pool??=createChunkDataPool({chunkSize:sources[0].meta.chunkSize});levels.push(concatSource(sources,pool));
    }
    const output=new Map(),fs=new OutputFileSystem(async(path,bytes)=>{output.set('/'+path,bytes.slice());});
    WorkerQueue.maxWorkers=0;
    try{await writeLodSource({filename:'/lod/lod-meta.json',mainSource:stackLods(levels),envSource:null,iterations:4,chunkCount:512,chunkExtent:16,chunkMin:8},fs);}
    finally{for(const source of opened)await source.close();pool.destroy();work.clear();await WorkerQueue.destroy();}
    const direct=await encode(0,transform);assert.deepEqual([...output.keys()].sort(),[...direct.keys()].sort());
    for(const [path,bytes] of direct)assert.deepEqual(output.get(path),bytes,path);
    assert.ok(ranges.length>0);assert.ok(ranges.every(([start,end])=>end-start<=8*1024**2));
  } finally {await rm(dir,{recursive:true,force:true});}
});
