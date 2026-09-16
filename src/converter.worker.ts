import { Column, DataTable, Transform, WebPCodec, WorkerQueue, writeLodSource, writeVoxel, bakeTransform, writeFile, readFile, concatSource, type ChunkSource, stackLods, createChunkDataPool, dataTableToChunkSource, decimateSource, materializeToDataTable, logger } from '@playcanvas/splat-transform';
import { Quat } from 'playcanvas';
import { readHeader, readChunks, required, type Columns } from './ply';
import { emptyBounds, extendBounds, spawnPose, type ConvertOptions, type V3, type SceneManifest } from './types';
import { ConversionGpu } from './conversion-gpu';
import { configureWorkers } from './conversion-workers';
import { OutputFileSystem, WorkFileSystem } from './conversion-io';
import { validateLodMeta, type LodNode } from './manifest';
import { ConversionProgress } from './conversion-progress';

declare const __WEBP_WASM__: string;
const scope = self as unknown as { postMessage: (value: unknown, transfer?: Transferable[]) => void; onmessage: ((event: MessageEvent) => void) | null };
const send = (value: unknown) => scope.postMessage(value);
let acknowledge: (()=>void) | undefined;
let running = false;
let nextRead=0;
let inputReadMs=0,outputAckMs=0;
const reads=new Map<number,{resolve:(buffer:ArrayBuffer)=>void;reject:(error:Error)=>void}>();
function remoteFile(meta:{name:string;size:number},fileId:number):File {
  const read=(start:number,end:number)=>new Promise<ArrayBuffer>((resolve,reject)=>{
    const begun=performance.now();
    const id=++nextRead;reads.set(id,{resolve:buffer=>{inputReadMs+=performance.now()-begun;resolve(buffer);},reject});send({type:'read',id,fileId,start,end});
  });
  // WebKit can deny disk-backed File reads after structured-cloning into a Blob worker.
  // Keep the user-granted File on the main thread and request bounded slices over IPC.
  return {name:meta.name,size:meta.size,slice:(start=0,end=meta.size)=>({arrayBuffer:()=>read(start,end),text:async()=>new TextDecoder().decode(await read(start,end))})} as File;
}
let pendingOutput=Promise.resolve();
function emitFile(path:string,bytes:Uint8Array):Promise<void> {
  pendingOutput=pendingOutput.then(()=>persistFile(path,bytes));return pendingOutput;
}
async function persistFile(path: string, bytes: Uint8Array) {
  const copy = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  const ack = new Promise<void>(resolve=>{ acknowledge = resolve; });
  const begun=performance.now();
  scope.postMessage({type:'file',path,bytes:copy},[copy]);
  await ack; // Backpressure: caller persists this file before the next chunk is encoded.
  outputAckMs+=performance.now()-begun;
}
const emitJson = (path:string, data:unknown) => emitFile(path,new TextEncoder().encode(JSON.stringify(data)));

function transformedPoint(c:Columns,i:number,q:Quat,scale:number): V3 {
  const x=c.x[i]*scale,y=c.y[i]*scale,z=c.z[i]*scale;
  const ix=q.w*x+q.y*z-q.z*y, iy=q.w*y+q.z*x-q.x*z, iz=q.w*z+q.x*y-q.y*x, iw=-q.x*x-q.y*y-q.z*z;
  return [ix*q.w+iw*-q.x+iy*-q.z-iz*-q.y, iy*q.w+iw*-q.y+iz*-q.x-ix*-q.z, iz*q.w+iw*-q.z+ix*-q.y-iy*-q.x];
}

async function convert(foreground: File, background: File | undefined, opts: ConvertOptions) {
  const started = performance.now();
  const overall=new ConversionProgress(background?[foreground.size,background.size]:[foreground.size]);
  const progress=(stage:string,detail:string)=>send({type:'progress',stage,fraction:overall.value,detail});
  inputReadMs=0;outputAckMs=0;let lodMergeMs=0,sogEncodeMs=0;
  WebPCodec.wasmUrl = __WEBP_WASM__;
  const report=(event:string,data:unknown)=>send({type:'log',event,data});
  const workerStats=configureWorkers(report);
  const gpu=new ConversionGpu(report);
  try {
  logger.setVerbosity('quiet');
  const q=new Quat().setFromEulerAngles(...opts.rotation);
  let voxelNodes=0;
  const bounds=emptyBounds(); const streams:SceneManifest['streams']=[],resources:SceneManifest['resources']=[];
  let blockCount=0,leafCount=0;
  const work=new WorkFileSystem((path,start,end)=>new Promise((resolve,reject)=>{
    const id=++nextRead;reads.set(id,{resolve,reject});send({type:'work-read',id,path,start,end});
  }));
  const staged:string[][][]=[[],[]];
  const staging=new OutputFileSystem(async(path,data)=>{await emitFile(path,data);work.files.set(path,data.length);});
  const preview:number[][]=[];let randomState=0x12345678;
  let pointCount=0, invalid=0, totalOutput=0;
  const inputs = background ? [foreground,background] : [foreground];
  for(let inputIndex=0;inputIndex<inputs.length;inputIndex++) {
    const file=inputs[inputIndex], isBackground=inputIndex>0, invalidBefore=invalid;
    progress('读取 PLY 文件头',`${isBackground?'背景':'前景'} · ${file.name}`);
    const header=await readHeader(file);
    if(inputIndex===0){
      progress('检查官方体素 GPU','官方体素生成需要 WebGPU，正在检查设备…');
      try {await gpu.required(()=>gpu.get());}
      catch(error){throw new Error(`官方体素生成需要可用的 WebGPU：${error instanceof Error?error.message:String(error)}`);}
    }
    const names=header.properties.filter(p=>required.includes(p.name)||(opts.sh && /^f_rest_\d+$/.test(p.name))).map(p=>p.name);
    const shCount=names.filter(n=>n.startsWith('f_rest_')).length;
    if (opts.sh && (![0,9,24,45].includes(shCount)||Array.from({length:shCount},(_,i)=>`f_rest_${i}`).some(n=>!names.includes(n)))) throw new Error(`球谐属性不完整：找到 ${shCount} 个 f_rest 属性。`);
    const inputBounds=emptyBounds();
    progress('分析空间范围',`${isBackground?'背景':'前景'} · ${header.count.toLocaleString()} 点`);
    for await(const part of readChunks(file,header,opts.chunkSize,['x','y','z'])) {
      for(let i=0;i<part.count;i++) {
        const p=transformedPoint(part.columns,i,q,opts.scale);
        if(p.every(v=>Number.isFinite(v)&&Math.abs(v)<1e9)) extendBounds(inputBounds,p);
      }
      overall.input(inputIndex,(part.start+part.count)/header.count,0);
      progress('分析空间范围',`${isBackground?'背景':'前景'} · 分块读取 ${(part.start+part.count).toLocaleString()} / ${header.count.toLocaleString()}`);
    }
    if(!inputBounds.min.every(Number.isFinite)) throw new Error('PLY 中没有有效坐标。');
    const center=inputBounds.min.map((v,a)=>(v+inputBounds.max[a])/2);
    // Eight spatial octants, each capped at chunkSize rows. Resident input does not grow with file size.
    const buckets=Array.from({length:8},()=>({count:0,columns:Object.fromEntries(names.map(n=>[n,new Float32Array(opts.chunkSize)])) as Columns,bounds:emptyBounds()}));
    let encoded=0;

    const flush=async(b:typeof buckets[number])=>{
      if(!b.count) return;
      const id=`${isBackground?'bg':'fg'}-${String(blockCount++).padStart(6,'0')}`;
      const table=new DataTable(names.map(n=>new Column(n,b.columns[n].slice(0,b.count))),new Transform(undefined,q.clone(),opts.scale));
      const makeLevels=async(createDevice?:()=>Promise<import('playcanvas').GraphicsDevice>)=>{
        const levels=[table];
        for(let level=1;level<(isBackground?1:3);level++) {
          progress('生成 LOD',`${isBackground?'背景':'前景'} · 正在处理 ${b.count.toLocaleString()} 点 · ${createDevice?'GPU':'CPU'} Gaussian 合并`);
          const begun=performance.now();
          const pool=createChunkDataPool({chunkSize:opts.chunkSize,maxPooledBytes:32*1024*1024});
          const input=dataTableToChunkSource(table,opts.chunkSize);
          let src:Awaited<ReturnType<typeof decimateSource>>|undefined;
          try {
            src=await decimateSource(input,pool,{targetCount:Math.max(1,Math.ceil(table.numRows/(2**level))),memoryBudgetBytes:128*1024*1024,createDevice});
            const result=await materializeToDataTable(src,pool);
            if(result.numRows!==Math.max(1,Math.ceil(table.numRows/(2**level))))throw new Error('官方简化未达到目标点数。');
            levels.push(result);
          } finally {await src?.close();await input.close();pool.destroy();lodMergeMs+=performance.now()-begun;}
        }
        return levels;
      };
      const levels=isBackground?await makeLevels():await gpu.block(id,makeLevels);
      progress('暂存 LOD 数据',`${isBackground?'背景':'前景'} · 各层 ${levels.map(t=>t.numRows.toLocaleString()).join(' / ')} 点`);
      for(let level=0;level<levels.length;level++){
        const path=`.work/${isBackground?'bg':'fg'}/${level}/${blockCount}.ply`;
        await writeFile({filename:path,outputFormat:'ply',dataTable:levels[level],options:{}},staging);
        (staged[inputIndex][level]??=[]).push(path);
      }
      encoded+=b.count; b.count=0; b.bounds=emptyBounds();
      overall.input(inputIndex,1,(encoded+invalid-invalidBefore)/header.count);
      progress('生成 LOD',`${isBackground?'背景':'前景'} · 已处理 ${(encoded+invalid-invalidBefore).toLocaleString()} / ${header.count.toLocaleString()} 点`);
      report('chunk.complete',{id,counts:levels.map(t=>t.numRows),totalOutput,workers:workerStats()});
    };
    for await(const part of readChunks(file,header,opts.chunkSize,names)) {
      const c=part.columns;
      for(let i=0;i<part.count;i++) {
        let valid=true;
        for(const n of names) if(!Number.isFinite(c[n][i])) { valid=false; break; }
        const norm=Math.hypot(c.rot_0[i],c.rot_1[i],c.rot_2[i],c.rot_3[i]);
        const p=transformedPoint(c,i,q,opts.scale);
        if(!valid || norm<1e-8 || p.some(v=>Math.abs(v)>=1e9)) {invalid++;continue;}
        const bucket=buckets[(p[0]>=center[0]?1:0)|(p[1]>=center[1]?2:0)|(p[2]>=center[2]?4:0)];
        for(const n of names) bucket.columns[n][bucket.count]=c[n][i];
        for(const n of ['rot_0','rot_1','rot_2','rot_3']) bucket.columns[n][bucket.count]/=norm;
        // Invalid/extreme scales otherwise generate infinite GPU bounds. Log the rejected rows.
        if(['scale_0','scale_1','scale_2'].some(n=>Math.abs(c[n][i])>40)) {invalid++;continue;}
        bucket.count++;
        const support=Math.min(1000,Math.exp(Math.max(c.scale_0[i],c.scale_1[i],c.scale_2[i]))*opts.scale*3);
        extendBounds(bucket.bounds,p.map(v=>v-support) as V3); extendBounds(bucket.bounds,p.map(v=>v+support) as V3);
        if(!isBackground) {
          pointCount++; extendBounds(bounds,p);
          randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;
          const sample=pointCount<=12000?pointCount-1:Math.floor(randomState/2**32*pointCount);
          if(sample<12000) preview[sample]=[...p,c.f_dc_0[i],c.f_dc_1[i],c.f_dc_2[i],c.opacity[i]];
        }
        if(bucket.count===opts.chunkSize) await flush(bucket);
      }
      overall.input(inputIndex,1,(encoded+invalid-invalidBefore)/header.count);
      progress('空间分块',`${isBackground?'背景':'前景'} · ${(part.start+part.count).toLocaleString()} / ${header.count.toLocaleString()}`);
    }
    for(const b of buckets) await flush(b);
    overall.input(inputIndex,1,1);
  }
  if(!pointCount) throw new Error('前景没有有效 Gaussian，无法创建场景。');
  overall.partition(0);
  progress('划分 LOD 空间','正在整理场景并划分空间…');
  const opened:ChunkSource[]=[];
  let pool:ReturnType<typeof createChunkDataPool>|undefined;
  const encodeStarted=performance.now();
  try {
    const combine=async(paths:string[])=>{
      const sources:ChunkSource[]=[];
      for(const filename of paths){
        const loaded=await readFile({filename,inputFormat:'ply',options:{},fileSystem:work});
        opened.push(...loaded);sources.push(...loaded);
      }
      pool??=createChunkDataPool({chunkSize:sources[0].meta.chunkSize,maxPooledBytes:32*1024**2});
      return concatSource(sources,pool);
    };
    const levels:ChunkSource[]=[];
    for(const paths of staged[0])levels.push(await combine(paths));
    const mainSource=stackLods(levels),envSource=staged[1][0]?.length?await combine(staged[1][0]):null;
    const output=new OutputFileSystem(async(path,data)=>{
      if(!path.startsWith('lod/'))throw new Error('官方 writer 输出路径异常。');
      if(path==='lod/lod-meta.json'){
        const meta=validateLodMeta(JSON.parse(new TextDecoder().decode(data)));
        const visit=(node:LodNode)=>{if(node.lods)leafCount++;node.children?.forEach(visit);};visit(meta.tree);
        streams.push({file:path,lodLevels:meta.lodLevels,pointCount:meta.counts[0],background:false});
      }
      await emitFile(path,data);resources.push({file:path,bytes:data.length});totalOutput+=data.length;

    });
    logger.setRenderer({handle(event){
      if(event.kind==='message')report('conversion.official.message',event);
      if((event.kind==='barStart'||event.kind==='barTick'||event.kind==='barEnd')&&event.name==='lod errors'){
        const completed=event.kind==='barStart'?0:event.current;
        overall.errors(event.total>0?completed/event.total:0);progress('评估 LOD 图像误差',`GPU 官方误差表 ${completed} / ${event.total} 个叶节点`);
      }
      if((event.kind==='barTick'||event.kind==='barEnd')&&event.name==='chunking'&&event.total>0){
        overall.partition(event.current/event.total);progress('划分 LOD 空间','正在划分场景空间…');
      }
      if((event.kind==='scopeStart'||event.kind==='scopeEnd')&&event.index&&event.total&&(/^[0-9]+_[0-9]+$/.test(event.name)||event.name==='env')){
        const completed=event.kind==='scopeEnd'&&!event.failed?event.index:event.index-1;
        overall.encoded(completed,event.total);
        progress('压缩 SOG',`已完成 ${completed} / ${event.total} 个编码单元`);
      }
    }});
    // One whole-scene call; these are the pinned official CLI's default partition parameters.
    await gpu.required(()=>writeLodSource({filename:'lod/lod-meta.json',mainSource,envSource,iterations:4,chunkCount:512,chunkExtent:16,chunkMin:8,lodErrors:true,createDevice:()=>gpu.get()},output));
    overall.encodedAll();
    progress('生成官方体素','读取前景 LOD 0 的位置与几何属性…');
    // The public official writer takes a DataTable. Materialize only its 11
    // geometry/opacity columns (44 bytes/point); omit color and all SH data.
    let geometry:DataTable|null=await materializeToDataTable(bakeTransform(levels[0],Transform.IDENTITY),pool!,new Set(['position','geometric']));
    report('conversion.voxel.input',{points:geometry.numRows,geometryBytes:geometry.numRows*44,resolution:opts.cellSize,opacityCutoff:opts.opacity});
    logger.setRenderer({handle(event){
      if((event.kind==='barTick'||event.kind==='barEnd')&&event.name==='Voxelizing'&&event.total>0){
        overall.voxel(event.current/event.total);
        progress('生成官方体素',`GPU 体素化 ${event.current} / ${event.total} 批 · ${opts.cellSize} 米`);
      } else if(event.kind==='scopeStart')progress('生成官方体素',`官方 ${event.name} · ${opts.cellSize} 米`);
      else if(event.kind==='message')report('conversion.official.message',event);
    }});
    try {
      await gpu.required(()=>writeVoxel({filename:'collision/scene.voxel.json',dataTable:geometry!,voxelResolution:opts.cellSize,opacityCutoff:opts.opacity,createDevice:()=>gpu.get()},new OutputFileSystem(async(path,data)=>{
        if(path==='collision/scene.voxel.json'){
          const metadata=JSON.parse(new TextDecoder().decode(data));
          if(metadata.version!=='1.1'||metadata.voxelResolution!==opts.cellSize)throw new Error('官方体素尺寸或格式与请求不一致。');
          voxelNodes=metadata.nodeCount;report('conversion.voxel.complete',metadata);
        }
        await emitFile(path,data);totalOutput+=data.length;
      })));
    } finally {geometry=null;}

  } finally {
    logger.setRenderer({handle(){}});
    for(const source of opened)await source.close();pool?.destroy();work.clear();sogEncodeMs+=performance.now()-encodeStarted;
  }
  const manifest:SceneManifest={format:'portable-3dgs',version:2,id:opts.id,name:opts.name,createdAt:new Date().toISOString(),cover:'cover.png',collision:'collision/scene.voxel.json',collisionFormat:'playcanvas-voxel',bounds,camera:spawnPose(),streams,resources,leafCount,pointCount,sourceBytes:foreground.size+(background?.size??0),conversion:{method:'official-uniform-merge-streamed-sog',chunkSize:opts.chunkSize,sh:opts.sh,scale:opts.scale,rotation:opts.rotation}};
  overall.workerComplete();progress('生成首图与场景索引','场景编码完成，正在准备首图…');
  send({type:'complete',manifest,preview,stats:{workers:workerStats(),durationMs:performance.now()-started,timings:{inputReadMs,lodMergeMs,sogEncodeMs,outputAckMs},invalid,voxelNodes,voxelFormat:'playcanvas-voxel',cellSize:opts.cellSize,totalOutput}});
  } finally {gpu.destroy();await WorkerQueue.destroy();}
}
scope.onmessage=event=>{
  if(event.data.type==='read-result') {
    const request=reads.get(event.data.id);reads.delete(event.data.id);
    if(event.data.error)request?.reject(new Error(event.data.error));else request?.resolve(event.data.bytes);
    return;
  }
  if(event.data.type==='ack') { const ack=acknowledge;acknowledge=undefined;ack?.();return; }
  if(event.data.type==='start'&&!running) {
    running=true;
    convert(remoteFile(event.data.foreground,0),event.data.background?remoteFile(event.data.background,1):undefined,event.data.options).catch(error=>send({type:'error',message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:undefined}));
  }
};
send({type:'ready'});
