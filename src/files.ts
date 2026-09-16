import type { SceneRecord } from './types';

import { safePath, manifestPaths } from './manifest';
export { safePath, validateManifest } from './manifest';

export function scenePaths(scene:SceneRecord):string[] {
  const s=scene.manifest;
  return manifestPaths(s);
}
export function sceneBytes(scene:SceneRecord):number {
  return scenePaths(scene).reduce((sum,path)=>sum+(scene.files.get(path)?.size??scene.resourceSizes?.[path]??0),0);
}
export async function readSceneFile(scene:SceneRecord,path:string):Promise<Blob> {
  const existing=scene.files.get(path);
  if(existing)return existing;
  if(scene.loadFile)return scene.loadFile(safePath(path));
  throw new Error(`场景缺少文件：${path}`);
}

export function download(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),120000);
}
