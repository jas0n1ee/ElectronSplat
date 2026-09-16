import { log } from './log';
import { APP_VERSION, APP_BUILD } from './version';
import { download, sceneBytes } from './files';
import { desktop, diskScene } from './desktop';
import { DESKTOP_LOD_BUDGETS } from './lod';
import { DISPLAY_ROTATION } from './coordinates';
import { Viewer } from './viewer';
import { WebGpuInitError } from './graphics';
import { previewCover } from './cover';
import { ConversionQueue, type ConversionJob } from './conversion-queue';
import type { ConvertOptions, SceneRecord, SceneManifest, CameraPose } from './types';

declare global {interface Window {PORTABLE_WORKER_SOURCE:string; portableDiagnostics: {snapshot:()=>unknown;download:()=>void};}}
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const input=(id:string)=>$<HTMLInputElement>(id);
const button=(id:string,fn:()=>unknown)=>$(id).addEventListener('click',()=>{Promise.resolve().then(fn).catch(report);});
const show=(id:string,visible:boolean)=>$(id).classList.toggle('hidden',!visible);
const bytes=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:n>=1024**2?`${(n/1024**2).toFixed(1)} MiB`:`${(n/1024).toFixed(1)} KiB`;
let scenes:SceneRecord[]=[],viewer:Viewer|null=null,foregroundFile:File|undefined,backgroundFile:File|undefined;
let worker:Worker|undefined,workerUrl:string|undefined;
let busy=false,generation=0,toastTimer:ReturnType<typeof setTimeout>|undefined;
let diskTransaction:string|undefined;
let scanning=false,diskRevision='';
let activePage='library',activeScene:SceneRecord|null=null;
let renameTarget:SceneRecord|undefined,renaming=false;
const coverUrls=new Set<string>();
type ConversionInput={foreground:File;background?:File;options:ConvertOptions};
const queue=new ConversionQueue<ConversionInput>(runConversion,renderQueue);
let queueLength=-1;
const queueRows=new Map<string,{row:HTMLLIElement;title:HTMLElement;status:HTMLElement;detail:HTMLElement;cancel:HTMLButtonElement;bar:HTMLProgressElement}>();
const initialScene=new URLSearchParams(location.hash.slice(1)).get('scene');

function toast(message:string,error=false,timeout=7000) {
  clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);show('toast',true);
  toastTimer=setTimeout(()=>show('toast',false),timeout);
}
function report(e:unknown) {
  if(e instanceof DOMException&&e.name==='AbortError'){log.add('info','user.cancelled');return;}
  const message=e instanceof Error?e.message:String(e);log.add('error','action.failed',e);toast(message,true,12000);
}
function changeHash(hash:string){try{history.replaceState(null,'',hash);}catch{}}
function page(name:string) {
  activePage=name;
  for(const p of ['library','import','help']){show(`${p}-page`,p===name);$(`nav-${p}`).classList.toggle('active',p===name);}
  $('page-label').textContent=({library:'场景库',import:'导入与转换',help:'使用指南'} as Record<string,string>)[name];
  changeHash(`#${name}`);
}
function renderLibrary() {
  for(const url of coverUrls)URL.revokeObjectURL(url);coverUrls.clear();
  const grid=$('scene-grid');grid.replaceChildren();
  const query=input('search').value.trim().toLocaleLowerCase();
  const visible=scenes.filter(s=>s.manifest.name.toLocaleLowerCase().includes(query));
  $('scene-count').textContent=String(scenes.length).padStart(2,'0');$('sidebar-count').textContent=String(scenes.length);
  show('empty-library',!scenes.length);show('no-results',!!scenes.length&&!visible.length);
  for(const record of visible) {
    const s=record.manifest,card=document.createElement('article');card.className='scene-card';
    const open=document.createElement('button');open.className='scene-open';open.setAttribute('aria-label',`打开 ${s.name}`);
    const img=document.createElement('img');img.className='scene-cover';img.alt=s.name;img.loading='lazy';
    const cover=record.files.get(s.cover);
    if(cover){img.src=URL.createObjectURL(cover);coverUrls.add(img.src);}
    else if(record.sourceCoverUrl){const url=new URL(record.sourceCoverUrl);url.searchParams.set('refresh',crypto.randomUUID());img.src=url.href;}
    const enter=document.createElement('span');enter.className='enter-label';enter.textContent='↗';
    const content=document.createElement('div');content.className='scene-content';
    const title=document.createElement('h2');title.textContent=s.name;
    content.append(title);open.append(img,enter,content);open.addEventListener('click',()=>{void openScene(record).catch(report);});
    const meta=document.createElement('div');meta.className='scene-meta';const info=document.createElement('span');
    info.textContent=`${(s.pointCount/10000).toFixed(1)} 万点 · ${bytes(sceneBytes(record))}`;
    const actions=document.createElement('div');actions.className='scene-actions';
    for(const [label,css,action] of [
      ['打开数据文件夹','scene-folder',async()=>{if(desktop&&record.nativeToken)await desktop.openSceneFolder(record.nativeToken);}],
      ['重命名场景','scene-rename',async()=>openRename(record)],
      ['永久删除场景','scene-delete',async()=>{
        if(!desktop||!record.nativeToken)return;
        if(await desktop.deleteScene(record.nativeToken)){
          scenes=scenes.filter(scene=>scene.nativeToken!==record.nativeToken);diskRevision='';renderLibrary();
          log.add('info','scene.deleted',{id:s.id});toast(`已永久删除：${s.name}`);await refreshDisk();
        }
      }]
    ] as const){
      const control=document.createElement('button');control.className=`text-button ${css}`;control.textContent=label;
      control.setAttribute('aria-label',`${label}：${s.name}`);
      control.addEventListener('click',()=>{control.disabled=true;void action().catch(report).finally(()=>{control.disabled=false;});});actions.append(control);
    }
    meta.append(info);card.append(open,meta,actions);grid.append(card);
  }
}
function openRename(record:SceneRecord) {
  renameTarget=record;input('rename-name').value=record.manifest.name;$('rename-error').textContent='';
  $<HTMLDialogElement>('rename-dialog').showModal();input('rename-name').focus();input('rename-name').select();
}
function closeRename(){if(renaming)return;$<HTMLDialogElement>('rename-dialog').close();renameTarget=undefined;}
async function saveRename(){
  if(renaming||!renameTarget?.nativeToken||!desktop)return;
  const name=input('rename-name').value.trim();
  if(!name){$('rename-error').textContent='请填写场景名称。';input('rename-name').focus();return;}
  const target=renameTarget;renaming=true;$('rename-error').textContent='';
  for(const control of $('rename-form').querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button'))control.disabled=true;
  $('rename-save').textContent='正在保存…';
  try {
    const updated=diskScene(await desktop.renameScene(target.nativeToken!,name));
    scenes=scenes.map(record=>record.nativeToken===target.nativeToken?updated:record);diskRevision='';renderLibrary();
    log.add('info','scene.renamed',{id:updated.manifest.id,from:target.manifest.name,to:updated.manifest.name});
    $<HTMLDialogElement>('rename-dialog').close();renameTarget=undefined;toast(`已重命名为：${updated.manifest.name}`);
  }catch(error){$('rename-error').textContent=error instanceof Error?error.message:String(error);log.add('error','scene.renameFailed',error);}
  finally{renaming=false;for(const control of $('rename-form').querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button'))control.disabled=false;$('rename-save').textContent='保存名称';}
}
async function openScene(record:SceneRecord,forceWebgl=false,pose?:CameraPose, settings?:{mode:number;speed:number;collision:boolean}) {
  if(busy){toast('请等待转换结束，或先取消转换。');return;}
  if(viewer){viewer.destroy();viewer=null;}
  activeScene=record;
  show('shell',false);show('viewer-page',true);show('viewer-loading',true);$('viewer-stats').textContent='';
  $('viewer-title').textContent=record.manifest.name;
  $('render-auto').textContent='自动选择渲染';
  const old=$<HTMLCanvasElement>('viewer-canvas');const canvas=old.cloneNode(false) as HTMLCanvasElement;old.replaceWith(canvas);
  const current=new Viewer(canvas,record,DESKTOP_LOD_BUDGETS);viewer=current;
  if(pose)current.pose=structuredClone(pose);
  if(settings){current.setLod(settings.mode);current.speed=settings.speed;current.collision=settings.collision;}
  input('collision-toggle').checked=current.collision;input('move-speed').value=String(current.speed);
  $<HTMLSelectElement>('render-backend').value=forceWebgl?'webgl':'auto';
  for(const el of $('lod-buttons').querySelectorAll('button'))el.classList.toggle('selected',Number(el.dataset.lod)===current.mode);
  current.onError=message=>{if(viewer===current)toast(message,true,10000);};
  current.onFatal=message=>{
    if(viewer!==current)return;
    if(!forceWebgl&&current.app?.graphicsDevice.deviceType==='webgpu') {
      log.add('warn','gpu.runtimeFallback',{to:'webgl2',message});
      queueMicrotask(()=>{if(viewer===current)void openScene(record,true,current.pose,{mode:current.mode,speed:current.speed,collision:current.collision}).then(()=>toast('已切换到 WebGL2。WebGPU 错误已记录，可继续浏览。',false,10000)).catch(report);});
    }else{show('viewer-loading',false);toast(`${message} 请返回场景库重新打开，详情见诊断日志。`,true,15000);}
  };
  current.onStatus=s=>{
    if(viewer!==current)return;
    $('viewer-stats').textContent=`${s.renderer.toUpperCase()} · ${s.fps===0?'静止 · 按需渲染':`${s.fps} FPS`} · ${(s.points/10000).toFixed(1)} 万点 · ${s.chunks}/${s.total} 块 · LOD ${s.level||'默认'} · ${current.canvas.width}×${current.canvas.height}${s.omitted?` · 预算限制隐藏 ${s.omitted} 块`:''}`;
    $<HTMLOptionElement>('render-auto').textContent=`自动 · ${s.renderer.toUpperCase()}`;
    if(s.chunks)show('viewer-loading',false);
  };
  try {
    await current.init(forceWebgl);
    if(viewer!==current)return;
    input('collision-toggle').checked=current.collision;
    show('viewer-loading',false);canvas.focus();changeHash(`#scene=${encodeURIComponent(record.manifest.id)}`);
  }catch(e){if(viewer===current){
    if(e instanceof WebGpuInitError&&!forceWebgl){
      log.add('warn','gpu.fallback',{to:'webgl2',reason:'initialization-failed',message:e.message});
      await openScene(record,true,current.pose,{mode:current.mode,speed:current.speed,collision:current.collision});
    }else{show('viewer-loading',false);report(e);}
  }}
}
function closeViewer() {
  viewer?.destroy();viewer=null;activeScene=null;show('viewer-page',false);show('shell',true);page('library');renderLibrary();
  if(desktop)void refreshDisk().catch(report);
}
function selectedFile(file:File|undefined,background=false) {
  if(file&&!file.name.toLowerCase().endsWith('.ply')){toast('请选择 .ply 文件。',true);return;}
  if(background){backgroundFile=file;$('background-info').textContent=file?`${file.name} · ${bytes(file.size)}`:'独立呈现天空与远景，不参与碰撞';$('clear-background').hidden=!file;}
  else {foregroundFile=file;$('foreground-info').textContent=file?`${file.name} · ${bytes(file.size)} · 分块处理`:'支持大于 2 GB 的标准 binary / ASCII Gaussian PLY';if(file&&!input('scene-name').value)input('scene-name').value=file.name.replace(/\.ply$/i,'');}
}
function renderQueue() {
  busy=!!queue.active;
  show('conversion-panel',busy);
  show('conversion-queue',queue.jobs.length>0);
  const waiting=queue.jobs.filter(job=>job.state==='waiting').length;
  const done=queue.jobs.filter(job=>job.state==='completed').length;
  $('queue-count').textContent=`已完成 ${done} / ${queue.jobs.length} · 等待 ${waiting}`;
  const list=$('queue-list');
  for(const job of queue.jobs){
    let elements=queueRows.get(job.id);
    if(!elements){
      const row=document.createElement('li');row.className='queue-job';row.dataset.jobId=job.id;
      const info=document.createElement('div');info.className='queue-job-info';
      const title=document.createElement('strong'),status=document.createElement('span'),detail=document.createElement('p');
      status.className='queue-job-status';info.append(title,status,detail);
      const cancel=document.createElement('button');cancel.type='button';cancel.className='button danger';cancel.onclick=()=>queue.cancel(job.id);
      const bar=document.createElement('progress');bar.max=1;bar.setAttribute('aria-label',`${job.name} 整体进度`);
      row.append(info,cancel,bar);list.append(row);elements={row,title,status,detail,cancel,bar};queueRows.set(job.id,elements);
    }
    const {row,title,status,detail,cancel,bar}=elements;
    row.dataset.state=job.state;title.textContent=job.name;
    status.textContent=`${job.stage}${job.state==='running'?` · 整体进度约 ${Math.floor(job.progress*100)}%`:''}`;
    detail.textContent=job.error??(job.state==='running'?job.detail:'');detail.hidden=!detail.textContent;
    cancel.hidden=job.state!=='waiting'&&job.state!=='running';cancel.disabled=!job.cancellable;
    cancel.textContent=job.state==='waiting'?'移除':'取消';cancel.setAttribute('aria-label',`${cancel.textContent}：${job.name}`);
    bar.value=job.progress;
  }
  if(queue.active){
    const job=queue.active;
    $('progress-name').textContent=job.name;
    $('progress-stage').textContent=job.stage;
    $('progress-detail').textContent=job.detail;
    $('progress-percent').textContent=`整体进度约 ${Math.floor(job.progress*100)}%`;
    $<HTMLProgressElement>('progress-bar').value=job.progress;
    $<HTMLButtonElement>('cancel-conversion').disabled=!job.cancellable;
  }
  if(desktop&&queueLength!==queue.pending){queueLength=queue.pending;void desktop.setQueueLength(queueLength).catch(report);}
}
function stopWorker() {worker?.terminate();worker=undefined;if(workerUrl)URL.revokeObjectURL(workerUrl);workerUrl=undefined;}
async function startConversion() {
  if(!desktop)throw new Error('请通过 Electron 桌面应用打开。');
  const foreground=foregroundFile??input('foreground').files?.[0];
  const background=backgroundFile;
  if(!foreground)throw new Error('请先选择前景 Gaussian PLY。');
  if(!input('scene-name').value.trim())throw new Error('请填写场景名称。');
  if(!window.PORTABLE_WORKER_SOURCE||typeof Worker==='undefined'||typeof WebAssembly==='undefined')throw new Error('离线转换器缺失，或浏览器不支持 Worker / WebAssembly。请完整复制 portable 目录。');
  const id=`scene-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(4)),v=>v.toString(16).padStart(2,'0')).join('')}`;
  const cellSize=Number(document.querySelector<HTMLInputElement>('input[name="voxel-size"]:checked')?.value);
  if(![0.1,0.2,0.5].includes(cellSize))throw new Error('请选择提取尺寸。');
  const options:ConvertOptions={id,name:input('scene-name').value.trim(),scale:1,rotation:[...DISPLAY_ROTATION],cellSize,opacity:0.25,sh:false,chunkSize:32768};
  log.add('info','conversion.queued',{id,name:options.name,foreground:{name:foreground.name,size:foreground.size},background:background?{name:background.name,size:background.size}:null,cellSize});
  queue.enqueue(id,options.name,{foreground,background,options});
  input('foreground').value='';input('foreground').required=true;input('background').value='';input('scene-name').value='';
  selectedFile(undefined);selectedFile(undefined,true);
}
async function runConversion(job:ConversionJob<ConversionInput>,signal:AbortSignal) {
  const {foreground,background,options}=job.payload!;const {id}=options;const disk=desktop!;
  const current=++generation;const start=performance.now();let lastProgress=start;
  let resolveCompletion!:()=>void,rejectCompletion!:(error:unknown)=>void;
  const completion={promise:new Promise<void>((resolve,reject)=>{resolveCompletion=resolve;rejectCompletion=reject;}),resolve:()=>resolveCompletion(),reject:(error:unknown)=>rejectCompletion(error)};
  void completion.promise.catch(()=>{});
  let beginPending:Promise<string>|undefined;
  const update=(stage:string,detail:string,fraction?:number)=>{
    lastProgress=performance.now();
    if(job.stage!==stage)log.add('info','conversion.stage',{id,stage,detail});
    queue.update(job,stage,detail,fraction);
  };
  $('progress-time').textContent='正在准备本场景转换…';
  let bootTimeout:ReturnType<typeof setTimeout>|undefined;

  let outputBytes=0;
  const timer=setInterval(()=>{
    const secs=Math.round((performance.now()-start)/1000),idle=Math.round((performance.now()-lastProgress)/1000);
    $('progress-time').textContent=`已用时 ${Math.floor(secs/60)} 分 ${secs%60} 秒 · 已生成 ${bytes(outputBytes)}${idle>20?` · 当前步骤已计算 ${idle} 秒，可随时取消`:' · 请保持页面打开'}`;
  },1000);
  const fail=(error:unknown)=>{
    if(current!==generation)return;
    generation++;clearTimeout(bootTimeout);clearInterval(timer);stopWorker();job.cancellable=false;
    const cancelled=signal.aborted;
    update(cancelled?'正在取消':'转换失败，正在清理',error instanceof Error?error.message:String(error));
    if(!cancelled)report(error);
    log.add('warn',cancelled?'conversion.cancelled':'conversion.discarded',{id,outputBytes});
    // A late begin must settle and be aborted before the queue starts its next job.
    void (async()=>{
      const token=diskTransaction??await beginPending?.catch(()=>undefined);
      if(token)await disk.abort(token);
      diskTransaction=undefined;
    })().catch(cleanupError=>{report(cleanupError);}).finally(()=>completion.reject(error));
  };
  const cancel=()=>fail(new DOMException('转换已取消，未完成的结果已丢弃。','AbortError'));
  signal.addEventListener('abort',cancel,{once:true});
  const startup=(phase:string,stage:string,detail:string)=>{
    clearTimeout(bootTimeout);lastProgress=performance.now();
    update(stage,detail,phase==='prepare-output'?.01:.02);
    log.add('info','conversion.startup',{id,phase,elapsedMs:performance.now()-start});
    bootTimeout=setTimeout(()=>{
      log.add('error','conversion.startupTimeout',{id,phase,elapsedMs:performance.now()-start});
      void disk.info().then(info=>log.add('info','conversion.diskActivity',info)).catch(report);
      fail(new Error(phase==='prepare-output'?'准备保存目录超过 20 秒，转换尚未开始。请检查磁盘状态，详情见诊断日志。':'离线转换器启动超过 20 秒，已停止本次任务。请查看诊断日志。'));
    },20000);
  };
  startup('prepare-output','准备保存目录','正在创建本次转换的保存目录…');
  try {
    if(signal.aborted){cancel();return await completion.promise;}
    beginPending=disk.begin(id);
    const token=await beginPending;
    if(current!==generation)return await completion.promise;
    diskTransaction=token;
    startup('worker-boot','启动离线转换器','正在启动转换 Worker…');
    workerUrl=URL.createObjectURL(new Blob([window.PORTABLE_WORKER_SOURCE],{type:'text/javascript'}));
    worker=new Worker(workerUrl);const currentWorker=worker;
    log.add('info','conversion.start',{foregroundBytes:foreground.size,backgroundBytes:background?.size??0,options,output:'native-disk'});
    worker.onerror=e=>{clearTimeout(bootTimeout);fail(new Error(`转换 Worker 出错：${e.message}`));};
    worker.onmessage=e=>{
      if(current!==generation)return;
      const msg=e.data;
      if(msg.type==='ready'){clearTimeout(bootTimeout);log.add('info','conversion.workerBootReady',{id,elapsedMs:performance.now()-start});currentWorker.postMessage({type:'start',foreground:{name:foreground.name,size:foreground.size},background:background?{name:background.name,size:background.size}:undefined,options});return;}
      if(msg.type==='read') {
        void (async()=>{
          const file=msg.fileId===0?foreground:msg.fileId===1?background:undefined;
          if(!file||!Number.isSafeInteger(msg.start)||!Number.isSafeInteger(msg.end)||msg.start<0||msg.end<msg.start||msg.end-msg.start>8*1024*1024)throw new Error('转换器请求了无效的文件范围。');
          const begun=performance.now();let readTimeout:ReturnType<typeof setTimeout>|undefined;
          let data:ArrayBuffer;
          try {
            data=await Promise.race([file.slice(msg.start,msg.end).arrayBuffer(),new Promise<never>((_,reject)=>{
              readTimeout=setTimeout(()=>reject(new Error(`读取 ${file.name} 超过 30 秒（字节 ${msg.start}–${msg.end}）。请检查源文件所在磁盘。`)),30000);
            })]);
          } catch(error){if(current===generation)log.add('error','conversion.inputReadFailed',{file:file.name,start:msg.start,end:msg.end,durationMs:performance.now()-begun});throw error;}
          finally{clearTimeout(readTimeout);}
          if(current===generation)currentWorker.postMessage({type:'read-result',id:msg.id,bytes:data},[data]);
        })().catch(error=>{if(current===generation)currentWorker.postMessage({type:'read-result',id:msg.id,error:error instanceof Error?error.message:String(error)});});
        return;
      }
      if(msg.type==='work-read') {
        void disk.readWork(diskTransaction!,msg.path,msg.start,msg.end).then(bytes=>{
          const data=new Uint8Array(bytes).buffer;
          if(current===generation)currentWorker.postMessage({type:'read-result',id:msg.id,bytes:data},[data]);
        }).catch(error=>{if(current===generation)currentWorker.postMessage({type:'read-result',id:msg.id,error:error instanceof Error?error.message:String(error)});});
        return;
      }
      if(msg.type==='progress'){update(msg.stage,msg.detail,msg.fraction??undefined);return;}
      if(msg.type==='log'){log.add('info',msg.event,msg.data);return;}
      if(msg.type==='error'){log.add('error','conversion.worker',{message:msg.message,stack:msg.stack});fail(new Error(msg.message));return;}
      if(msg.type==='file') {
        void (async()=>{
          if(current!==generation)return;
          await disk.write(diskTransaction!,msg.path,new Uint8Array(msg.bytes));
          if(!msg.path.startsWith('.work/'))outputBytes+=msg.bytes.byteLength;
          if(current===generation)currentWorker.postMessage({type:'ack'});
        })().catch(fail);
        return;
      }
      if(msg.type==='complete') {
        clearInterval(timer);stopWorker();
        void (async()=>{
          const manifest=msg.manifest as SceneManifest;
          update('生成首图与场景索引','正在绘制本场景首图…',.97);
          const cover=await previewCover(manifest,msg.preview);
          if(current!==generation)return;
          let record:SceneRecord;
          if(desktop){
            const token=diskTransaction!;
            update('保存首图','正在将首图写入场景文件夹…',.98);
            const coverBytes=new Uint8Array(await cover.arrayBuffer());
            if(current!==generation)return;
            await desktop.write(token,manifest.cover,coverBytes);
            if(current!==generation)return;
            // Completion is now a short, indivisible disk commit.
            job.cancellable=false;
            update('保存场景索引','正在校验并完成场景保存…',.99);
            record=diskScene(await desktop.commit(token,manifest));diskTransaction=undefined;
          }else throw new Error('桌面保存接口不可用。');
          if(current!==generation)return;
          scenes.unshift(record);renderLibrary();
          log.add('info','conversion.complete',{id,...msg.stats});
          if(msg.stats.invalid||msg.stats.coarsenings||msg.stats.clippedSplats)log.add('warn','conversion.approximations',{invalidRows:msg.stats.invalid,voxelCoarsenings:msg.stats.coarsenings,clippedSplats:msg.stats.clippedSplats,effectiveCellSize:msg.stats.cellSize});
          toast(`场景已生成：${(manifest.pointCount/10000).toFixed(1)} 万点，${manifest.leafCount} 个空间块。已保存到 scenes 文件夹，可直接打开。`,false,14000);
          completion.resolve();
          $('library-info').textContent=`最近生成：${manifest.name} · 碰撞尺寸 ${msg.stats.cellSize} 米${msg.stats.invalid?` · 已移除 ${msg.stats.invalid} 个无效点`:''}`;
        })().catch(fail);
      }
    };
  }catch(e){fail(e);}
  try{await completion.promise;}finally{signal.removeEventListener('abort',cancel);clearTimeout(bootTimeout);clearInterval(timer);}
}

function refreshDiagnostics() {
  const grid=$('capabilities-grid');grid.replaceChildren();
  const caps=log.capabilities;
  for(const [key,value] of Object.entries({协议:caps.protocol,WebGPU入口:caps.webgpu,Worker:caps.worker,WebAssembly:caps.wasm,文件夹读取:caps.directoryInput,指针锁:caps.pointerLock})) {
    const div=document.createElement('div');div.textContent=key;const b=document.createElement('b');b.textContent=typeof value==='boolean'?(value?'可用':'未提供'):String(value);div.append(b);grid.append(div);
  }
  $('log-output').textContent=log.entries.slice(-120).map(e=>`${e.time.slice(11,23)} ${e.level.toUpperCase()} ${e.event}\n${e.data?JSON.stringify(e.data):''}`).join('\n');
}

button('rename-cancel',closeRename);
$('rename-dialog').addEventListener('cancel',event=>{event.preventDefault();closeRename();});
$('rename-form').addEventListener('submit',event=>{event.preventDefault();void saveRename().catch(report);});
input('rename-name').addEventListener('input',()=>{$('rename-error').textContent='';});
button('nav-library',async()=>{page('library');renderLibrary();if(desktop)await refreshDisk();});button('nav-import',()=>page('import'));button('nav-help',()=>page('help'));
for(const id of ['import-primary','empty-import'])button(id,()=>page('import'));
input('search').addEventListener('input',renderLibrary);
input('foreground').addEventListener('change',()=>selectedFile(input('foreground').files?.[0]));
input('background').addEventListener('change',()=>selectedFile(input('background').files?.[0],true));
button('clear-background',()=>{input('background').value='';selectedFile(undefined,true);});
$('foreground-zone').addEventListener('dragover',e=>{e.preventDefault();$('foreground-zone').classList.add('dragover');});
$('foreground-zone').addEventListener('dragleave',()=>$('foreground-zone').classList.remove('dragover'));
$('foreground-zone').addEventListener('drop',e=>{e.preventDefault();$('foreground-zone').classList.remove('dragover');selectedFile(e.dataTransfer?.files[0]);input('foreground').required=false;});
$('import-form').addEventListener('submit',e=>{e.preventDefault();void startConversion().catch(report);});
button('cancel-conversion',()=>{if(queue.active)queue.cancel(queue.active.id);});
button('back-library',closeViewer);
$('lod-buttons').addEventListener('click',e=>{const target=(e.target as HTMLElement).closest<HTMLButtonElement>('button[data-lod]');if(!target)return;viewer?.setLod(Number(target.dataset.lod));for(const el of $('lod-buttons').querySelectorAll('button'))el.classList.toggle('selected',el===target);$<HTMLCanvasElement>('viewer-canvas').focus();});
input('collision-toggle').addEventListener('change',()=>{if(viewer)input('collision-toggle').checked=viewer.setCollision(input('collision-toggle').checked);$<HTMLCanvasElement>('viewer-canvas').focus();});
input('move-speed').addEventListener('input',()=>{if(viewer)viewer.speed=Number(input('move-speed').value);});
input('render-backend').addEventListener('change',()=>{if(activeScene)void openScene(activeScene,input('render-backend').value==='webgl',viewer?.pose,viewer?{mode:viewer.mode,speed:viewer.speed,collision:viewer.collision}:undefined).catch(report);});
$('lock-pointer').addEventListener('click',()=>{void viewer?.lockPointer();});
button('reset-camera',()=>{viewer?.reset();if(viewer)input('collision-toggle').checked=viewer.collision;$<HTMLCanvasElement>('viewer-canvas').focus();});
button('capture-cover',async()=>{
  const current=viewer,record=activeScene;if(!current||!record)return;
  const control=$<HTMLButtonElement>('capture-cover');if(control.disabled)return;control.disabled=true;
  try {
  await current.settled();const {blob,pose}=await current.captureCover();
  if(current!==viewer)return;
  if(desktop&&record.nativeToken){
    const updated=await desktop.saveCover(record.nativeToken,new Uint8Array(await blob.arrayBuffer()),pose);
    Object.assign(record,diskScene(updated));
    log.add('info','cover.saved',{id:record.manifest.id,capturePose:pose,output:'native-disk'});toast('首图与起始视角已保存，下次打开从这里开始。');return;
  }
  throw new Error('场景已移除，请返回场景库重新打开。');
  } finally {control.disabled=false;}
});
$('fullscreen').addEventListener('click',()=>{const action=document.fullscreenElement?document.exitFullscreen?.():$('viewer-page').requestFullscreen?.();if(action)void action.catch(report);else toast('此浏览器未提供全屏接口，可使用浏览器自身的全屏功能。');});
button('open-diagnostics',()=>{refreshDiagnostics();$<HTMLDialogElement>('diagnostics-dialog').showModal();});
button('close-diagnostics',()=>$<HTMLDialogElement>('diagnostics-dialog').close());
button('export-logs',()=>download(log.blob({busy,queue:queue.jobs.map(({payload,...job})=>job)}),`portable-diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}.json`));
window.addEventListener('diagnostic',()=>{if($<HTMLDialogElement>('diagnostics-dialog').open)refreshDiagnostics();});
window.addEventListener('hashchange',()=>{if(location.hash==='#library'){if(viewer)closeViewer();else{page('library');renderLibrary();if(desktop)void refreshDisk().catch(report);}}});
window.portableDiagnostics={snapshot:()=>({version:APP_VERSION,build:APP_BUILD,capabilities:log.capabilities,busy,queue:queue.jobs.map(({payload,...job})=>job),page:activePage,scenes:scenes.map(s=>s.manifest),viewer:viewer?.snapshot()??null,logs:log.entries}),download:()=>download(log.blob({busy,queue:queue.jobs.map(({payload,...job})=>job)}),'portable-diagnostics.json')};
async function refreshDisk() {
  if(!desktop||scanning||busy||viewer)return;
  scanning=true;
  try {
    const result=await desktop.scan();
    const revision=JSON.stringify([result.scenes.map(s=>[s.token,s.revision]),result.errors]);
    if(revision===diskRevision)return;
    diskRevision=revision;
    scenes=result.scenes.map(diskScene);renderLibrary();
    $('library-info').textContent=result.scenes.length?`已自动载入 ${result.scenes.length} 个本地场景，点击首图进入。`:'scenes 中没有完整场景。请导入 PLY，或将已有的 scene 文件夹复制到 scenes 中。';
    if(result.errors.length)$('library-info').textContent+=` ${result.errors.map(e=>`${e.folder}：${e.message}`).join('；')}`;
    log.add('info','library.autoload',{source:'native-filesystem',directoryScanned:true,directory:result.directory,directories:result.directories,scenes:scenes.length,ids:scenes.map(s=>s.manifest.id)});
    for(const error of result.errors)log.add('warn','library.invalidScene',error);
  }finally{scanning=false;}
}
renderLibrary();
if(desktop){
  for(const el of $('lod-buttons').querySelectorAll<HTMLButtonElement>('button[data-lod]')){
    const mode=Number(el.dataset.lod);el.title=`${DESKTOP_LOD_BUDGETS[mode]/10000} 万点预算 · ${[1,1.5,2,3][mode]}×`;
  }
  const guide=$('help-page').querySelectorAll('p')[2];
  guide.textContent='右下角 LOD 从默认到 3 档逐步增加细节，点数预算依次为 300、450、600、900 万点。';
  void desktop.info().then(info=>log.add('info','desktop.environment',info)).catch(report);
  void refreshDisk().then(async()=>{if(initialScene){const record=scenes.find(s=>s.manifest.id===initialScene);if(record)await openScene(record);}}).catch(report);
  window.addEventListener('focus',()=>{void refreshDisk().catch(report);});
  setInterval(()=>{if(activePage==='library'&&!document.hidden)void refreshDisk().catch(report);},3000);
}else $('library-info').textContent='请通过 Electron 桌面应用打开 Portable。';

function setViewerPanelsHidden(hidden:boolean) {
  $('viewer-page').classList.toggle('panels-hidden',hidden);
  const panels=[$('viewer-controls-guide'),$('viewer-settings')];
  for(const panel of panels){panel.inert=hidden;panel.setAttribute('aria-hidden',String(hidden));}
  $('show-viewer-panels').tabIndex=hidden?0:-1;
  $('show-viewer-panels').setAttribute('aria-hidden',String(!hidden));
  // The opening panel is still translated offscreen at this point. Focusing it
  // must not scroll the entire viewer to reveal the animated button.
  (hidden?$('show-viewer-panels'):$('hide-viewer-panels')).focus({preventScroll:true});
}
button('hide-viewer-panels',()=>setViewerPanelsHidden(true));
button('show-viewer-panels',()=>setViewerPanelsHidden(false));
