import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Column, DataTable, Transform, WorkerQueue, MemoryFileSystem, dataTableToChunkSource, stackLods, writeLodSource, writeFile, readFile as readPly, readPly as readPlySource, processSource, bakeTransform, MemoryReadFileSystem, concatSource, createChunkDataPool, logger } from '@playcanvas/splat-transform';
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

test('streaming readPly with declared display transform matches byte for byte',async()=>{
  WorkerQueue.maxWorkers=0;
  try {
    const R=new Transform().fromEulers(90,0,180);
    const reference=new MemoryFileSystem();
    await writeLodSource({filename:'/lod/lod-meta.json',mainSource:stackLods([dataTableToChunkSource(table(256,R.clone()),128),dataTableToChunkSource(table(128,R.clone()),128)]),envSource:null,iterations:4,chunkCount:512,chunkExtent:16},reference);
    const disk=new MemoryFileSystem();
    await writeFile({filename:'input.ply',outputFormat:'ply',dataTable:table(256,Transform.PLY),options:{}},disk);
    const reader=new MemoryReadFileSystem();reader.set('input.ply',disk.results.get('input.ply'));
    const pool=createChunkDataPool({chunkSize:128});
    const src=await readPlySource(await reader.createSource('input.ply'),pool);
    const stripped=await processSource(src,[{kind:'filterBands',value:0}],pool);
    const level0={meta:{...stripped.meta,transform:new Transform().fromEulers(90,0,180)},read:req=>stripped.read(req),close:()=>stripped.close()};
    // level1 goes through the production staging path: write the PLY out and read it back (the tag returns to PLY space),
    // and when it is mixed with level0 whose tag is the display orientation, stackLods requires agreement — level0 must be baked first.
    await writeFile({filename:'level-1.ply',outputFormat:'ply',dataTable:table(128,R.clone()),options:{}},disk);
    reader.set('level-1.ply',disk.results.get('level-1.ply'));
    const level1=await readPlySource(await reader.createSource('level-1.ply'),pool);
    const out=new MemoryFileSystem();
    await writeLodSource({filename:'/lod/lod-meta.json',mainSource:stackLods([bakeTransform(level0,Transform.PLY),level1]),envSource:null,iterations:4,chunkCount:512,chunkExtent:16},out);
    assert.deepEqual([...out.results.keys()].sort(),[...reference.results.keys()].sort());
    for(const [path,bytes] of reference.results)assert.deepEqual(out.results.get(path),bytes,path);
  } finally {await WorkerQueue.destroy();}
});

// fix branch: consistency of StreamWorkFileSystem chunked append writes + WorkFileSystem read-back.
