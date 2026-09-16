import { WebgpuGraphicsDevice, type GraphicsDevice } from 'playcanvas';

type Report = (event:string,data:unknown)=>void;
// Conversion cannot resume an in-flight compute dispatch on a replacement GPU.
// Keep device loss terminal; the owning block is retried from its original input.
class ConversionDevice extends WebgpuGraphicsDevice {
  override async handleDeviceLost(info:GPUDeviceLostInfo) { this.fire('devicelost',info); }
}
export class ConversionGpu {
  private device?:ConversionDevice;
  private disabled=false;
  private failure?:Error;
  private rejectLoss?:(error:Error)=>void;
  private lost?:Promise<never>;
  constructor(private report:Report) {}
  private dispose() {
    const device=this.device;this.device=undefined;
    if(device){try{device.destroy();}catch{} (device as unknown as {wgpu?:GPUDevice}).wgpu?.destroy();}
  }
  private fail(error:Error) {this.failure=error;this.rejectLoss?.(error);}
  async get():Promise<GraphicsDevice> {
    if(this.failure)throw this.failure;
    if(this.device)return this.device;
    if(!navigator.gpu)throw new Error('当前设备未提供 WebGPU 转换接口。');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter)throw new Error('没有可用的 WebGPU 适配器。');
    // Engine 2.22.2 accesses window.navigator even with a real OffscreenCanvas.
    // Alias the worker global; keep the actual worker navigator and GPU API.
    if(typeof window==='undefined')Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
    // PlayCanvas accepts OffscreenCanvas at runtime; its public type still names HTMLCanvasElement.
    const device=this.device=new ConversionDevice(new OffscreenCanvas(1,1) as unknown as HTMLCanvasElement,{antialias:false});
    device.on('devicelost',(info:GPUDeviceLostInfo)=>this.fail(new Error(`GPU device lost: ${info.message||info.reason}`)));
    await device.initWebGpu(undefined,undefined); // Official compute shaders are WGSL; no CDN compiler.
    (device as unknown as {wgpu:GPUDevice}).wgpu.addEventListener('uncapturederror',(event:GPUUncapturedErrorEvent)=>this.fail(new Error(`GPU ${event.error.constructor.name}: ${event.error.message}`)));
    this.report('conversion.gpu.ready',{renderer:device.deviceType,adapter:adapter.info?.description||adapter.info?.vendor});
    return device;
  }
  async required<T>(run:()=>Promise<T>):Promise<T> {
    const lost=new Promise<never>((_,reject)=>{this.rejectLoss=reject;});
    try {const result=await Promise.race([run(),lost]);if(this.failure)throw this.failure;return result;}
    finally {this.rejectLoss=undefined;}
  }
  async block<T>(id:string,run:(createDevice?:()=>Promise<GraphicsDevice>)=>Promise<T>):Promise<T> {
    if(this.disabled)return run();
    this.lost=new Promise<never>((_,reject)=>{this.rejectLoss=reject;});
    try {
      const result=await Promise.race([run(()=>this.get()),this.lost]);
      if(this.failure)throw this.failure;
      return result;
    } catch(error) {
      // Input has already passed finite-geometry checks. A CPU retry is also a
      // validation: if it fails, propagate that error rather than claiming success.
      this.disabled=true;
      this.report('conversion.gpu.fallback',{block:id,reason:error instanceof Error?error.message:String(error),retry:'current-block',remaining:'cpu'});
      this.dispose();
      return run();
    } finally {this.rejectLoss=undefined;}
  }
  destroy(){this.rejectLoss=undefined;this.dispose();}
}
