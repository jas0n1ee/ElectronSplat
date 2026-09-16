import * as pc from 'playcanvas';
import { log } from './log';

export class WebGpuInitError extends Error {}

export async function createViewerDevice(canvas:HTMLCanvasElement,forceWebgl:boolean) {
  const options={antialias:false,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance' as const};
  if(!forceWebgl&&navigator.gpu) {
    let adapter:GPUAdapter|null=null;
    try {
      adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      const info=adapter?.info;
      log.add(adapter?'info':'warn','gpu.adapter',{available:!!adapter,info:info?{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description}:null});
    } catch(error) {log.add('warn','gpu.adapterFailed',error);}
    if(adapter) {
      const device=new pc.WebgpuGraphicsDevice(canvas,options);
      try {
        // All viewer shaders are WGSL; no remote shader compiler is needed.
        await device.initWebGpu(undefined,undefined);
        return device;
      } catch(error) {
        log.add('warn','gpu.initializationFailed',error);
        // Initialization may have stopped before renderer helpers were constructed.
        try {device.destroy();}catch{}
        (device as unknown as {wgpu?:GPUDevice}).wgpu?.destroy();
        throw new WebGpuInitError(error instanceof Error?error.message:String(error));
      }
    }
    log.add('warn','gpu.fallback',{to:'webgl2',reason:'adapter-unavailable'});
  } else if(!forceWebgl)log.add('warn','gpu.fallback',{to:'webgl2',reason:'api-not-exposed'});
  return pc.createGraphicsDevice(canvas,{...options,deviceTypes:[pc.DEVICETYPE_WEBGL2]});
}
