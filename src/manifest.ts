import type { SceneManifest, V3 } from './types';
export function safePath(path: unknown): string {
  if(typeof path!=='string' || !path || path.length>512 || path.startsWith('/') || /[\\\x00-\x1f:?#%]/.test(path) || path.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('场景中包含无效相对路径。');
  return path;
}
const finite3=(v:unknown):v is V3=>Array.isArray(v)&&v.length===3&&v.every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<1e12);
export function validateManifest(value:unknown): SceneManifest {
  const s=value as SceneManifest;
  if(s?.format==='portable-3dgs' && (s.version as number)===1) throw new Error('旧版场景需要从原始 PLY 重新转换为官方 LOD 格式；原文件已保留。');
  if(!s || s.format!=='portable-3dgs' || s.version!==2) throw new Error('不支持的场景格式/版本。');
  if(typeof s.name!=='string' || !s.name.trim() || s.name.length>200 || typeof s.id!=='string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(s.id)) throw new Error('场景名称或 ID 无效。');
  if(!finite3(s.bounds?.min)||!finite3(s.bounds?.max)||s.bounds.min.some((v,i)=>v>s.bounds.max[i])||!finite3(s.camera?.position)||!Number.isFinite(s.camera.yaw)||!Number.isFinite(s.camera.pitch)) throw new Error('场景范围/相机无效。');
  if(!Number.isSafeInteger(s.pointCount)||s.pointCount<1||!Number.isSafeInteger(s.sourceBytes)||s.sourceBytes<1||!Number.isSafeInteger(s.leafCount)||s.leafCount<1) throw new Error('场景点数或空间节点无效。');
  safePath(s.cover); safePath(s.collision);
  if(s.cameraSource!==undefined&&s.cameraSource!=='cover')throw new Error('场景相机来源无效。');
  if(s.collisionFormat!==undefined&&(s.collisionFormat!=='playcanvas-voxel'||!/^collision\/.+\.voxel\.json$/.test(s.collision)))throw new Error('碰撞格式或路径无效。');
  if(!finite3(s.conversion?.rotation))throw new Error('场景坐标旋转无效。');
  if(!Array.isArray(s.resources)||!s.resources.length||s.resources.length>200000)throw new Error('场景资源清单无效。');
  const paths=new Set<string>();
  for(const r of s.resources) {
    safePath(r.file);
    if(!/^(lod|background)\/.+\.(json|webp|sog)$/.test(r.file)||paths.has(r.file)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>128*1024**2)throw new Error('场景资源记录无效。');
    paths.add(r.file);
  }
  if(!Array.isArray(s.streams)||s.streams.length<1||s.streams.length>2||s.streams[0].background!==false)throw new Error('场景缺少官方 LOD 入口。');
  const indexes=new Set<string>();
  for(const stream of s.streams) {
    if(typeof stream.background!=='boolean'||stream.lodLevels!==(stream.background?1:3)||!Number.isSafeInteger(stream.pointCount)||stream.pointCount<1||!paths.has(stream.file)||!stream.file.endsWith('/lod-meta.json')||indexes.has(stream.file))throw new Error('官方 LOD 入口无效。');
    indexes.add(stream.file);
  }
  if(s.streams[0].pointCount!==s.pointCount||s.streams.slice(1).some(v=>!v.background))throw new Error('场景前景点数不一致。');
  return s;
}

export function manifestPaths(s:SceneManifest):string[] {
  return ['scene.json',s.cover,s.collision,...(s.collisionFormat==='playcanvas-voxel'?[s.collision.replace('.voxel.json','.voxel.bin')]:[]),...s.resources.map(r=>r.file)];
}

export type LodNode = { bound:{min:number[];max:number[]}; children?:LodNode[]; lods?:Record<string,{file:number;offset:number;count:number}> };
export type LodMeta = { version:number; lodLevels:number; filenames:string[]; tree:LodNode; counts:number[]; count:number; lodErrors:boolean; asset?:Record<string,unknown>; environment?:string };
// Validate the official index at the filesystem boundary, including every range.
export function validateLodMeta(value:unknown):LodMeta {
  const m=value as LodMeta;
  if(!m||m.version!==1||!Number.isInteger(m.lodLevels)||m.lodLevels<1||m.lodLevels>16||!Array.isArray(m.filenames)||!m.filenames.length||m.filenames.length>100000)throw new Error('官方 LOD 索引无效。');
  for(const f of m.filenames)if(!safePath(f).endsWith('/meta.json')&&!f.endsWith('.sog'))throw new Error('官方 LOD 文件路径无效。');
  if(new Set(m.filenames).size!==m.filenames.length)throw new Error('官方 LOD 文件重复。');
  if(m.environment)safePath(m.environment);
  let nodes=0;const counts=new Array(m.lodLevels).fill(0);
  const visit=(n:LodNode,depth:number)=>{
    if(++nodes>200000||depth>64||!finite3(n?.bound?.min)||!finite3(n?.bound?.max)||n.bound.min.some((v,i)=>v>n.bound.max[i]))throw new Error('官方 LOD 空间树无效。');
    if(n.lods) {
      if(n.children||!Object.keys(n.lods).length)throw new Error('官方 LOD 叶节点无效。');
      for(const [key,l] of Object.entries(n.lods)) {
        const level=Number(key);
        if(String(level)!==key||!Number.isInteger(level)||level<0||level>=m.lodLevels||!Number.isInteger(l.file)||l.file<0||l.file>=m.filenames.length||!Number.isSafeInteger(l.offset)||l.offset<0||!Number.isSafeInteger(l.count)||l.count<1||l.offset+l.count>0x7fffffff)throw new Error('官方 LOD 点范围无效。');
        counts[level]+=l.count;
      }
    } else {
      if(!Array.isArray(n.children)||!n.children.length)throw new Error('官方 LOD 空间树缺少子节点。');
      n.children.forEach(c=>visit(c,depth+1));
    }
  };
  visit(m.tree,0);
  if(!Array.isArray(m.counts)||m.counts.length!==m.lodLevels||m.counts.some((v,i)=>v!==counts[i])||m.count!==counts.reduce((a,b)=>a+b,0))throw new Error('官方 LOD 点数合计不一致。');
  return m;
}
