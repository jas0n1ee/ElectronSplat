import { validateManifest, safePath } from './manifest';
import type { SceneManifest, SceneRecord, CameraPose } from './types';

export type DiskScene = { token: string; manifest: SceneManifest; resourceSizes: Record<string,number>; revision: string };
type DesktopAPI = {
  scan: () => Promise<{scenes: DiskScene[]; errors: {folder:string;message:string}[]; directory:string; directories:string[]}>;
  setQueueLength: (count:number) => Promise<void>;
  info: () => Promise<unknown>;
  openSceneFolder: (token:string) => Promise<void>;
  renameScene: (token:string,name:string) => Promise<DiskScene>;
  deleteScene: (token:string) => Promise<boolean>;
  begin: (id:string) => Promise<string>;
  write: (token:string,path:string,bytes:Uint8Array) => Promise<void>;
  commit: (token:string,manifest:SceneManifest) => Promise<DiskScene>;
  abort: (token:string) => Promise<void>;
  saveCover: (token:string,bytes:Uint8Array,pose:CameraPose) => Promise<DiskScene>;
  // Child-process conversion: the renderer hands over real paths, the child does its own disk I/O.
  pathForFile: (file:File) => string;
  runConversion: (payload:ChildJob) => Promise<{childLog:string}>;
  cancelConversion: (token:string) => Promise<boolean>;
  onConversionEvent: (cb:(message:ChildMessage)=>void) => void;
  // fix branch only: renderer-process logs land on disk in real time.
  logLine?: (entry:{time:string;level:string;event:string;data?:unknown}) => void;
};
export type ChildJob = {
  token:string; id:string; name:string;
  foreground:string; background?:string;
  options: { scale:number; rotation:[number,number,number]; cellSize:number; shBands:number; chunkSize:number };
};
export type ChildMessage =
  // The child reports which phase it is in and how far through that phase it is. Turning that into
  // one whole-scene bar is the renderer's job -- see ConversionProgress.byPhase.
  | {type:'progress'; phase:'read'|'decimate'|'partition'|'errors'|'encode'|'voxel'; stage:string; fraction:number; detail?:string}
  | {type:'log'; event:string; data?:unknown}
  | {type:'manifest'; manifest:SceneManifest; preview:number[][]; stats:Record<string,unknown>}
  | {type:'error'; message:string; stack?:string}
  | {type:'exit'; code:number|null; signal:string|null};
declare global { interface Window { portableDesktop?: DesktopAPI } }
export const desktop = window.portableDesktop;
export function diskScene(entry:DiskScene):SceneRecord {
  const manifest = validateManifest(entry.manifest);
  if (!/^[a-f0-9]{32}$/.test(entry.token)) throw new Error('磁盘场景标识无效。');
  const url = (path:string) => `portable://app/scene/${entry.token}/${safePath(path).split('/').map(encodeURIComponent).join('/')}`;
  return { manifest, files:new Map(), saved:true, nativeToken:entry.token, resourceSizes:entry.resourceSizes,
    assetUrl:url, sourceCoverUrl:url(manifest.cover), loadFile:async path => {
      const response=await fetch(url(path),{cache:'no-store'});
      if(!response.ok)throw new Error(`本地文件无法读取：${path}`);
      return response.blob();
    }
  };
}
