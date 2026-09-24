import * as pc from 'playcanvas';
import type { SceneRecord, V3, CameraPose } from './types';
import { spawnPose } from './types';
import { VoxelCollision } from '../vendor/supersplat-viewer/collision/voxel-collision';
import { SphereMover } from '../vendor/supersplat-viewer/cameras/sphere-mover';
import { loadCollision } from './collision';
import { log } from './log';
import { readSceneFile } from './files';
import { displayRotation, rotatePoint } from './coordinates';
import { createViewerDevice } from './graphics';
import { moveDelta } from './movement';
import { lodBudgetVerdict } from './lod';
import type { LodAdvice } from './lod';

type StreamResource={octree:{environmentUrl?:string|null;lodLevels:number;files:{url:string;lodLevel:number}[];fileResources:Map<number,unknown>;nodes:{lods?:{fileIndex:number;count:number}[]}[];assetLoader:{hasFailed?:(url:string)=>boolean}|null}};
type Loaded = {asset:pc.Asset;entity:pc.Entity;levels:number};
export type ViewerStatus = {fps:number;points:number;chunks:number;total:number;renderer:string;level:number;omitted:number;levels:number;coarsest:number;pinned:boolean;advice:LodAdvice;detailedFrom:number};
export class Viewer {
  app!:pc.Application;
  camera!:pc.Entity;
  private sceneRoot!:pc.Entity;
  private coordinateRotation:pc.Quat;
  private inverseCoordinateRotation:pc.Quat;

  collider:VoxelCollision|null=null;
  private mover=new SphereMover(0.1);
  private renderedFrames=0;
  collision=true;
  readonly radius=0.1; // Camera collision sphere: 0.2 m diameter.
  speed=2;
  mode=0;
  get budget(){return this.budgets[this.mode];}
  pose:CameraPose;
  private alive=true;
  private loaded:Loaded[]=[];
  private streamError='';
  private coarse=true;
  private frameReady=false;
  private loadingCount=0;
  private startedAt=0;
  private firstFrame=false;
  private readyLogged=false;
  private keys=new Set<string>();
  private events=new AbortController();
  private observer?:ResizeObserver;
  private pending=new Set<()=>void>();

  private indexesLoading=true;
  private streamLevels=0;
  private streamCoarsest=0;
  private lastVerdict='';
  private dragging=false;
  private lastX=0; private lastY=0;
  private elapsed=0; private frames=0;private fps=60;

  private changedAt=0;
  private renderFailed=false;
  onStatus:(status:ViewerStatus)=>void=()=>{};
  onError:(message:string)=>void=()=>{};
  onFatal:(message:string)=>void=message=>this.onError(message);
  constructor(public canvas:HTMLCanvasElement, public scene:SceneRecord, private readonly budgets:readonly number[]) {
    this.pose=scene.manifest.cameraSource==='cover'?structuredClone(scene.manifest.camera):spawnPose();
    this.coordinateRotation=displayRotation(scene.manifest.conversion?.rotation??[0,0,180]);
    this.inverseCoordinateRotation=this.coordinateRotation.clone().invert();

  }
  async init(forceWebgl=false) {
    const start=this.startedAt=performance.now();
    if(!this.scene.assetUrl)throw new Error('官方 Streamed SOG 场景请使用 Electron 桌面版打开。');
    const device=await createViewerDevice(this.canvas,forceWebgl);
    if(!this.alive) {device.destroy();throw new Error('Viewer 已关闭。');}
    if(device.deviceType==='null') {device.destroy();throw new Error('无法创建 WebGPU / WebGL2。请检查浏览器硬件加速，然后重新打开场景。');}
    const gpuInfo=device as pc.GraphicsDevice & {unmaskedVendor?:string;unmaskedRenderer?:string};
    log.add('info','gpu.created',{renderer:device.deviceType,vendor:gpuInfo.unmaskedVendor,device:gpuInfo.unmaskedRenderer,durationMs:performance.now()-start});
    if(device.deviceType==='webgpu') {
      // Version-pinned adapter: production PlayCanvas currently consumes validation events
      // without forwarding them. Observe the underlying device for useful offline diagnostics.
      (device as unknown as {wgpu?:GPUDevice}).wgpu?.addEventListener('uncapturederror',(event:GPUUncapturedErrorEvent)=>{
        if(this.alive)this.failRender('WebGPU 校验失败。',new Error(event.error.message));
      });
    }
    this.app=new pc.Application(this.canvas,{graphicsDevice:device});
    device.maxPixelRatio=window.devicePixelRatio;
    this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
    const render=this.app.render.bind(this.app),update=this.app.update.bind(this.app);
    this.app.render=()=>{if(!this.renderFailed)try{render();this.frames++;this.renderedFrames++;}catch(e){this.failRender('场景渲染失败。',e);}};
    this.app.update=(dt:number)=>{if(!this.renderFailed)try{update(dt);}catch(e){this.failRender('渲染状态更新失败。',e);}};
    const gsplat=this.app.scene.gsplat;
    this.app.scene.gsplatCentersEnabled=gsplat.currentRenderer!==pc.GSPLAT_RENDERER_RASTER_GPU_SORT;
    gsplat.lodMode=pc.GSPLAT_LODMODE_ERROR;
    gsplat.lodBehindPenalty=5;
    gsplat.lodUpdateAngle=90;
    gsplat.radialSorting=true;
    log.add('info','render.policy',{lodMode:'error',lodBehindPenalty:5,lodUpdateAngle:90,radialSorting:true,centersEnabled:this.app.scene.gsplatCentersEnabled,sortRenderer:gsplat.currentRenderer});
    this.app.systems.gsplat!.on('frame:request',()=>{if(this.alive)this.app.renderNextFrame=true;});
    this.app.scene.gsplat.splatBudget=this.budget;
    this.app.scene.gsplat.lodUnderfillLimit=2;
    this.app.systems.gsplat!.on('frame:ready',(_camera:unknown,_layer:unknown,ready:boolean,loading:number)=>this.onFrameReady(ready,loading));
    this.app.assets.on('error',(error:unknown,asset:pc.Asset)=>{
      if(!this.alive)return;
      log.add('warn','stream.assetRetry',{file:(asset?.file as {url?:string})?.url,message:String(error)});
    });
    this.app.scene.on('gsplat:sorted',(durationMs:number)=>{if(!this.firstFrame)log.add('info','stream.initialSort',{durationMs});});
    this.sceneRoot=new pc.Entity('scene-coordinate-frame');this.sceneRoot.setLocalRotation(this.coordinateRotation);this.app.root.addChild(this.sceneRoot);
    this.camera=new pc.Entity('camera');
    this.camera.addComponent('camera',{fov:65,nearClip:0.02,farClip:100000,clearColor:new pc.Color(0.025,0.032,0.039),toneMapping:pc.TONEMAP_LINEAR});
    this.app.root.addChild(this.camera);this.applyPose();
    log.add('info','camera.spawn',{sceneId:this.scene.manifest.id,pose:structuredClone(this.pose),source:this.scene.manifest.cameraSource==='cover'?'saved-cover':'z-up-eye-height',sourcePosition:[0,0,1.4],displayRotation:[90,0,180],storedCamera:this.scene.manifest.camera});
    try {
      this.collider=await loadCollision(this.scene);
      this.mover.collision=this.collider;
      this.mover.reset(new pc.Vec3(...rotatePoint(this.inverseCoordinateRotation,this.pose.position)));
      if(this.collides(this.pose.position)) { this.collision=false;log.add('warn','collision.spawnBlocked',{message:'初始相机处于占用体素内，已关闭碰撞，可移到空处后开启。'}); }
      log.add('info','collision.loaded',{format:'playcanvas-voxel',nodes:this.collider.nodes.length,cellSize:this.collider.voxelResolution,cameraRadius:this.radius,cameraDiameter:this.radius*2,enabled:this.collision});
    } catch(e) {this.collision=false;log.add('warn','collision.unavailable',e);this.onError(this.scene.manifest.collisionFormat?'官方碰撞体加载失败，当前可自由飞行；详情已记入诊断日志。':'此场景使用旧碰撞数据，请重新转换生成官方体素；当前可自由飞行。');}
    if(!this.alive)return;
    const resize=()=>{
      const rect=this.canvas.getBoundingClientRect();
      if(rect.width&&rect.height) {
        device.maxPixelRatio=window.devicePixelRatio;
        // Resize the drawing buffer, not the CSS box. Application.resizeCanvas()
        // defaults to fixed 300x150 resolution and only changes the CSS dimensions.
        device.resizeCanvas(rect.width,rect.height);this.requestRender();
        log.add('info','render.resolution',{cssWidth:rect.width,cssHeight:rect.height,width:this.canvas.width,height:this.canvas.height,pixelRatio:devicePixelRatio,renderer:device.deviceType});
      }
    };
    this.observer=new ResizeObserver(resize);this.observer.observe(this.canvas);resize();
    window.addEventListener('resize',resize,{signal:this.events.signal});
    device.on('devicelost',()=>{if(this.alive)this.failRender('图形设备已丢失。',new Error('GPU device lost'));});
    device.on('devicerestored',()=>{log.add('info','gpu.deviceRestored');});
    this.canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();log.add('error','gpu.contextLost');this.onError('WebGL 上下文丢失，等待恢复或返回重试。');},{signal:this.events.signal});
    this.bindControls();
    this.app.on('update',(dt:number)=>this.update(dt));
    this.app.start();
    try {await Promise.all(this.scene.manifest.streams.map(stream=>this.loadStream(stream)));}
    finally {this.indexesLoading=false;}
    this.reportLod('index');
    log.add('info','scene.indexReady',{id:this.scene.manifest.id,streams:this.loaded.length,levels:this.streamLevels,coarsest:this.streamCoarsest,durationMs:performance.now()-start});
  }
  private collides(position:V3):boolean {return !!this.collider?.querySphere(...rotatePoint(this.inverseCoordinateRotation,position),this.radius,{x:0,y:0,z:0});}
  private requestRender() {if(this.app){this.app.renderNextFrame=true;this.changedAt=performance.now();}}
  private applyPose() {this.camera.setPosition(...this.pose.position);this.camera.setEulerAngles(this.pose.pitch,this.pose.yaw,0);this.requestRender();}
  private failRender(message:string,error:unknown) {
    if(this.renderFailed||!this.alive)return;
    this.renderFailed=true;this.keys.clear();log.add('error','renderer.failed',error);this.onFatal(message);
  }
  setLod(mode:number) {
    if(!Number.isInteger(mode)||mode<0||mode>3)return;
    this.mode=mode;this.frameReady=false;this.readyLogged=false;this.changedAt=performance.now();
    if(this.app){this.app.scene.gsplat.splatBudget=this.budget;this.app.autoRender=true;this.requestRender();}
    log.add('info','lod.mode',{mode,budget:this.budget,foregroundPointCount:this.scene.manifest.pointCount});
    this.reportLod('mode');
  }
  /** The scene's coarsest level, as the allocator computes it (GSplatLodTable.totalStartCount). */
  private verdict() {
    return lodBudgetVerdict({coarsest:this.streamCoarsest,budget:this.budget,ceiling:this.budgets[this.budgets.length-1],budgets:this.budgets});
  }
  /**
   * One diagnostics line per (reason, mode, verdict), so the log shows whether a preset could actually
   * upgrade this scene. `renderedPoints` is the only empirical evidence: a pinned preset draws the
   * coarsest level, an upgrading one draws more than that.
   */
  private reportLod(reason:'index'|'mode'|'ready') {
    if(!this.alive||!this.streamLevels||!this.streamCoarsest)return;
    const v=this.verdict(),key=`${reason}:${this.mode}:${v.advice}`;
    if(key===this.lastVerdict)return;
    this.lastVerdict=key;
    const settled=this.frameReady&&!this.loadingCount;
    log.add(v.advice==='reconvert'?'warn':'info','lod.budget',{reason,mode:this.mode,budget:v.budget,ceiling:v.ceiling,levels:this.streamLevels,coarsest:v.coarsest,pinned:v.pinned,advice:v.advice,detailedFrom:v.detailedFrom,renderedPoints:settled?this.app?.stats.frame.gsplats??null:null});
  }
  private resident() {
    return this.loaded.flatMap(item=>{
      const octree=(item.asset.resource as StreamResource)?.octree;
      return octree?[...octree.fileResources.keys()].map(i=>({id:octree.files[i].url,lod:octree.files[i].lodLevel,position:[item.entity.getPosition().x,item.entity.getPosition().y,item.entity.getPosition().z]})):[];
    });
  }
  private residentLeaves() {
    return this.loaded.reduce((total,item)=>{
      const tree=(item.asset.resource as StreamResource)?.octree;
      return total+(tree?.nodes.filter(n=>n.lods?.some(l=>tree.fileResources.has(l.fileIndex))).length??0);
    },0);
  }
  snapshot() {
    const v=this.verdict();
    return {
      onDemand:this.app?.autoRender===false,renderedFrames:this.renderedFrames,centersEnabled:this.app?.scene.gsplatCentersEnabled,lodMode:this.app?.scene.gsplat.lodMode,
      pose:structuredClone(this.pose),collision:this.collision,collisionRadius:this.radius,renderer:this.app?.graphicsDevice.deviceType,
      loading:this.indexesLoading||this.coarse||!this.frameReady||this.loadingCount>0,loadingCount:this.loadingCount,coarse:this.coarse,mode:this.mode,budget:this.budget,
      levels:this.streamLevels,coarsest:this.streamCoarsest,pinned:v.pinned,advice:v.advice,detailedFrom:v.detailedFrom,
      renderResolution:{width:this.canvas.width,height:this.canvas.height,cssWidth:this.canvas.clientWidth,cssHeight:this.canvas.clientHeight,pixelRatio:devicePixelRatio},sourceUp:'z',displayRotation:[90,0,180],points:this.app?.stats.frame.gsplats??0,
      loaded:this.resident(),format:'playcanvas-streamed-sog',error:this.streamError
    };
  }
  private onFrameReady(ready:boolean,loading:number) {
    if(!this.alive||this.indexesLoading)return;
    if(!this.streamError)for(const item of this.loaded){
      const tree=(item.asset.resource as StreamResource).octree;
      const failed=tree.files.find(file=>tree.assetLoader?.hasFailed?.(file.url))??(tree.environmentUrl&&tree.assetLoader?.hasFailed?.(tree.environmentUrl)?{url:tree.environmentUrl}:null);
      if(failed){
        this.streamError=failed.url;log.add('error','stream.assetFailed',{file:failed.url});
        this.onError('场景资源加载失败，请返回场景库重新打开；详情已记入诊断日志。');
      }
    }
    this.frameReady=ready;this.loadingCount=loading;
    if(!this.firstFrame&&(this.app.stats.frame.gsplats??0)>0) {
      this.firstFrame=true;log.add('info','stream.firstFrame',{durationMs:performance.now()-this.startedAt,points:this.app.stats.frame.gsplats});
    }
    if(!ready||loading||this.streamError){this.changedAt=performance.now();return;}
    if(this.coarse) {
      this.coarse=false;this.frameReady=false;this.changedAt=performance.now();
      log.add('info','stream.coarseReady',{durationMs:performance.now()-this.startedAt});
      for(const item of this.loaded){item.entity.gsplat!.lodRangeMin=0;item.entity.gsplat!.lodRangeMax=item.levels-1;}
      this.app.scene.gsplat.dirty=true;
    } else if(!this.readyLogged&&performance.now()-this.changedAt>=600) {
      this.readyLogged=true;this.app.autoRender=false;
      log.add('info','scene.ready',{id:this.scene.manifest.id,durationMs:performance.now()-this.startedAt,mode:this.mode,budget:this.budget,points:this.app.stats.frame.gsplats,levels:this.streamLevels,coarsest:this.streamCoarsest,residentFiles:this.resident().length});
      this.reportLod('ready');
    }
  }
  reset() {
    this.keys.clear();this.pose=spawnPose();
    if(this.collision&&this.collides(this.pose.position)) {
      this.collision=false;
      log.add('warn','collision.spawnBlocked',{message:'出生点与碰撞体重叠，已关闭碰撞并保持指定位置。'});
    }
    this.mover.reset(new pc.Vec3(...rotatePoint(this.inverseCoordinateRotation,this.pose.position)));
    this.applyPose();
    log.add('info','camera.reset',{pose:structuredClone(this.pose)});
  }
  setCollision(enabled:boolean):boolean {
    if(enabled&&(!this.collider||this.collides(this.pose.position))) {this.onError('当前位置与碰撞体重叠，请先移到空处再开启碰撞。');return false;}
    if(enabled)this.mover.reset(new pc.Vec3(...rotatePoint(this.inverseCoordinateRotation,this.pose.position)));
    this.collision=enabled;log.add('info','collision.toggle',{enabled});return enabled;
  }
  private bindControls() {
    const signal=this.events.signal;
    const editing=()=>document.activeElement instanceof HTMLElement && (!!document.activeElement.closest('input,select,textarea,button,dialog') && document.activeElement!==this.canvas);
    window.addEventListener('keydown',e=>{
      if(!this.alive||editing()||e.ctrlKey||e.metaKey||e.altKey) return;
      if(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ShiftLeft','ShiftRight'].includes(e.code)) {e.preventDefault();this.keys.add(e.code);}
    },{signal});
    window.addEventListener('keyup',e=>this.keys.delete(e.code),{signal});
    window.addEventListener('blur',()=>{this.keys.clear();this.dragging=false;},{signal});
    document.addEventListener('visibilitychange',()=>{this.keys.clear();this.dragging=false;},{signal});
    document.addEventListener('pointerlockchange',()=>{this.keys.clear();},{signal});
    this.canvas.addEventListener('pointerdown',e=>{
      if(e.button!==0&&e.button!==2)return;
      this.canvas.focus();this.dragging=true;this.lastX=e.clientX;this.lastY=e.clientY;
      try {this.canvas.setPointerCapture(e.pointerId);}catch{}
    },{signal});
    this.canvas.addEventListener('contextmenu',e=>e.preventDefault(),{signal});
    window.addEventListener('pointerup',()=>{this.dragging=false;},{signal});
    window.addEventListener('pointermove',e=>{
      const locked=document.pointerLockElement===this.canvas;
      if(!locked&&!this.dragging)return;
      const dx=locked?e.movementX:e.clientX-this.lastX,dy=locked?e.movementY:e.clientY-this.lastY;
      this.lastX=e.clientX;this.lastY=e.clientY;
      this.pose.yaw-=dx*0.14;this.pose.pitch=Math.max(-89,Math.min(89,this.pose.pitch-dy*0.14));this.applyPose();
    },{signal});
    document.addEventListener('pointerlockerror',()=>log.add('warn','input.pointerLockDenied',{fallback:'drag'}),{signal});
  }
  async lockPointer() {
    try {await this.canvas.requestPointerLock?.();}catch(e){log.add('warn','input.pointerLockFallback',e);this.onError('指针锁定不可用，请按住鼠标拖动转向。');}
  }
  private update(dt:number) {
    if(!this.alive)return;
    this.elapsed+=dt;dt=Math.min(dt,0.05);
    if(this.keys.size&&!document.hidden) {
      const forward=(this.keys.has('KeyW')?1:0)-(this.keys.has('KeyS')?1:0);
      const right=(this.keys.has('KeyD')?1:0)-(this.keys.has('KeyA')?1:0);
      const up=(this.keys.has('KeyE')?1:0)-(this.keys.has('KeyQ')?1:0);
      const shift=this.keys.has('ShiftLeft')||this.keys.has('ShiftRight');
      // Yaw-only basis: pitch must not leak into altitude, so Q/E stay the only height control.
      const delta=moveDelta(this.pose.yaw,forward,right,up,dt*this.speed*(shift?3:1));
      if(this.collision&&this.collider){
        const position=new pc.Vec3(...rotatePoint(this.inverseCoordinateRotation,this.pose.position));
        this.mover.move(position,new pc.Vec3(...rotatePoint(this.inverseCoordinateRotation,delta)));
        this.pose.position=rotatePoint(this.coordinateRotation,[position.x,position.y,position.z]);
      } else this.pose.position=this.pose.position.map((v,i)=>v+delta[i]) as V3;
      this.applyPose();
    }
    if(this.elapsed>=1) {
      this.fps=Math.round(this.frames/this.elapsed);this.elapsed=0;this.frames=0;
      const v=this.verdict();
      this.onStatus({fps:this.fps,points:this.app.stats.frame.gsplats,chunks:this.residentLeaves(),total:this.scene.manifest.leafCount,renderer:this.app.graphicsDevice.deviceType,level:this.mode,omitted:0,levels:this.streamLevels,coarsest:this.streamCoarsest,pinned:v.pinned,advice:v.advice,detailedFrom:v.detailedFrom});
    }

  }
  private async loadStream(stream:SceneRecord['manifest']['streams'][number]) {
    const url=this.scene.assetUrl!(stream.file);
    const asset=new pc.Asset(stream.file,'gsplat',{url,filename:stream.file});
    this.app.assets.add(asset);
    try {
      await new Promise<void>((resolve,reject)=>{
        let done=false;
        const finish=(error?:unknown)=>{if(done)return;done=true;clearTimeout(timer);this.pending.delete(cancel);asset.off('load',loaded);asset.off('error',failed);error?reject(error):resolve();};
        const loaded=()=>finish(),failed=(e:unknown)=>finish(new Error(String(e))),cancel=()=>finish(new Error('场景已关闭。'));
        const timer=setTimeout(()=>finish(new Error(`索引加载超时：${stream.file}`)),45000);
        this.pending.add(cancel);asset.once('load',loaded);asset.once('error',failed);this.app.assets.load(asset);
      });
      if(!this.alive||!asset.resource)throw new Error('场景已关闭或索引为空。');
      const resource=asset.resource as StreamResource;
      const response=await readSceneFile(this.scene,stream.file);
      const meta=response?JSON.parse(await response.text()):null;
      log.add('info','lod.errors',{file:stream.file,measured:meta?.lodErrors===true,mode:'error',fallback:meta?.lodErrors?'none':'official-count-derived'});
      if(resource.octree?.lodLevels!==stream.lodLevels)throw new Error('官方 LOD 层数与场景清单不一致。');
      // The allocator pins a scene when the per-node coarsest-level counts sum to the budget; a node with
      // no splats at that level contributes 0, so this sum is that total (GSplatLodTable.totalStartCount).
      const coarsestLevel=stream.lodLevels-1;
      this.streamLevels=Math.max(this.streamLevels,stream.lodLevels);
      this.streamCoarsest+=resource.octree.nodes.reduce((total,node)=>total+(node.lods?.[coarsestLevel]?.count??0),0);
      const entity=new pc.Entity(stream.background?'background':'foreground');
      entity.setEulerAngles(0,0,180); // Official writer bakes geometry and tree into PLY space.
      entity.addComponent('gsplat',{asset,unified:true,lodRangeMin:stream.lodLevels-1,lodRangeMax:stream.lodLevels-1});
      this.sceneRoot.addChild(entity);
      this.loaded.push({asset,entity,levels:stream.lodLevels});
      log.add('info','stream.indexLoaded',{file:stream.file,leaves:resource.octree.nodes.length,files:resource.octree.files.length,levels:stream.lodLevels,queue:'official-default'});
    } catch(error){this.app.assets.remove(asset);asset.unload();throw error;}
  }
  async screenshot():Promise<Blob> { return (await this.captureCover()).blob; }
  async captureCover():Promise<{blob:Blob;pose:CameraPose}> {
    if(!this.alive||this.renderFailed||!this.loaded.length)throw new Error('场景未完成渲染，暂时无法截图。');
    return new Promise((resolve,reject)=>{
      const capture=()=>{
        clearTimeout(timer);
        try {
          const pose=structuredClone(this.pose);
          const dest=document.createElement('canvas');dest.width=1280;dest.height=720;
          const ctx=dest.getContext('2d')!;
          ctx.fillStyle='#080b0e';ctx.fillRect(0,0,1280,720);
          const s=Math.max(1280/this.canvas.width,720/this.canvas.height);
          ctx.drawImage(this.canvas,(1280-this.canvas.width*s)/2,(720-this.canvas.height*s)/2,this.canvas.width*s,this.canvas.height*s);
          dest.toBlob(b=>b?resolve({blob:b,pose}):reject(new Error('截图编码失败。')),'image/png');
        }catch(e){reject(e);}
      };
      const timer=setTimeout(()=>{this.app.off('frameend',capture);reject(new Error('截图等待渲染超时。'));},10000);
      this.app.once('frameend',capture);this.app.renderNextFrame=true;
    });
  }
  async settled():Promise<void> {
    const deadline=performance.now()+120000;
    while(this.alive&&!this.renderFailed&&performance.now()<deadline) {
      if(this.streamError)throw new Error('当前档位存在加载失败的资源，请返回重新打开后再截图。');
      if(!this.indexesLoading&&!this.coarse&&this.frameReady&&this.loadingCount===0&&performance.now()-this.changedAt>=600)return;
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error('当前档位尚未完成加载，首图未保存。请等待场景加载完成后重试。');
  }
  destroy() {
    this.alive=false;this.events.abort();this.observer?.disconnect();this.keys.clear();
    if(document.pointerLockElement===this.canvas)void document.exitPointerLock?.();
    for(const cancel of this.pending)cancel();
    // Let rejected asset promises clean up against the still-live registry before app teardown.
    queueMicrotask(()=>queueMicrotask(()=>{
      for(const {entity,asset} of this.loaded){entity.destroy();this.app.assets.remove(asset);asset.unload();}
      this.loaded=[];this.app?.destroy();
    }));
  }
}
