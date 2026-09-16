import { VoxelCollision } from '../vendor/supersplat-viewer/collision/voxel-collision';
import type { SceneRecord } from './types';
import { readSceneFile } from './files';

type Metadata=ConstructorParameters<typeof VoxelCollision>[0];
/** Validate the file boundary; traversal and contact resolution remain upstream code. */
export function decodeCollision(metadata:Metadata, buffer:ArrayBuffer):VoxelCollision {
  const m=metadata;
  const bounds=(b:Metadata['gridBounds'])=>b&&[b.min,b.max].every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite))&&b.min.every((v,i)=>v<=b.max[i]);
  if(!m||m.version!=='1.1'||!bounds(m.gridBounds)||!Number.isFinite(m.voxelResolution)||m.voxelResolution<=0||m.leafSize!==4||!Number.isInteger(m.treeDepth)||m.treeDepth<0||m.treeDepth>24||![m.nodeCount,m.leafDataCount,m.numMixedLeaves,m.numInteriorNodes].every(n=>Number.isSafeInteger(n)&&n>=0)||m.leafDataCount!==m.numMixedLeaves*2||buffer.byteLength!==(m.nodeCount+m.leafDataCount)*4||buffer.byteLength>128*1024**2)throw new Error('官方体素元数据或二进制长度无效。');
  const words=new Uint32Array(buffer),nodes=words.subarray(0,m.nodeCount),leaves=words.subarray(m.nodeCount);
  for(let i=0;i<nodes.length;i++){
    const value=nodes[i],mask=value>>>24,offset=value&0xffffff;
    if(value===0xff000000)continue;
    if(!mask){if(offset*2+1>=leaves.length)throw new Error('官方体素叶节点越界。');}
    else {
      let count=0;for(let bits=mask;bits;bits>>>=1)count+=bits&1;
      if(offset<=i||offset+count>nodes.length)throw new Error('官方体素子节点越界。');
    }
  }
  return new VoxelCollision(m,nodes,leaves);
}
export async function loadCollision(scene:SceneRecord):Promise<VoxelCollision> {
  if(scene.manifest.collisionFormat!=='playcanvas-voxel')throw new Error('旧自研碰撞数据需重新转换。');
  const json=await readSceneFile(scene,scene.manifest.collision);
  if(!json||json.size>1024**2)throw new Error('官方体素元数据缺失或过大。');
  const binary=await readSceneFile(scene,scene.manifest.collision.replace('.voxel.json','.voxel.bin'));
  if(!binary||binary.size>128*1024**2)throw new Error('官方体素二进制缺失或过大。');
  return decodeCollision(JSON.parse(await json.text()),await binary.arrayBuffer());
}
