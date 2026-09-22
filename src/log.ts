import { APP_VERSION, APP_BUILD } from './version';
export type LogEntry = { time: string; level: 'info'|'warn'|'error'; event: string; data?: unknown };
function clean(data: unknown): unknown {
  if (data instanceof Error) return { name:data.name, message:data.message, stack:data.stack?.slice(0,4000) };
  try { const s = JSON.stringify(data); return s && s.length > 5000 ? s.slice(0,5000) : JSON.parse(s ?? 'null'); } catch { return String(data); }
}
export class Diagnostics {
  entries: LogEntry[] = [];
  capabilities = {
    userAgent: navigator.userAgent, platform: navigator.platform, protocol: location.protocol,
    secureContext: window.isSecureContext, webgpu: 'gpu' in navigator,
    worker: typeof Worker !== 'undefined', wasm: typeof WebAssembly !== 'undefined',
    pointerLock: 'requestPointerLock' in HTMLElement.prototype,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: (navigator as Navigator & {deviceMemory?:number}).deviceMemory ?? null
  };
  constructor() {
    this.add('info','boot',{version:APP_VERSION,build:APP_BUILD,capabilities:this.capabilities});
    if(!this.capabilities.webgpu)this.add('info','gpu.unavailable',{reason:'api-not-exposed',plannedRenderer:'webgl2',message:'当前环境未提供 WebGPU 入口，将尝试 WebGL2；实际渲染结果以 gpu.created 为准。'});
    window.addEventListener('error',e=>this.add('error','window.error', e.error ?? e.message));
    window.addEventListener('unhandledrejection',e=>this.add('error','unhandledrejection',e.reason));
  }
  add(level:LogEntry['level'],event:string,data?:unknown) {
    const entry = {time:new Date().toISOString(),level,event,data:clean(data)};
    this.entries.push(entry);
    if (this.entries.length>800) this.entries.splice(0,this.entries.length-800);
    console[level === 'info' ? 'info' : level](`[ElectronSplat] ${event}`,entry.data ?? '');
    window.dispatchEvent(new CustomEvent('diagnostic',{detail:entry}));
    // fix branch only: forwarded synchronously to the main process for real-time disk writes, so a hang leaves the last stage on disk.
    try { window.portableDesktop?.logLine?.(entry); } catch {}
  }
  blob(context?:unknown): Blob { return new Blob([JSON.stringify({app:'electronsplat',version:APP_VERSION,build:APP_BUILD,exportedAt:new Date().toISOString(),capabilities:this.capabilities,entries:this.entries,context},null,2)],{type:'application/json'}); }
}
export const log = new Diagnostics();
