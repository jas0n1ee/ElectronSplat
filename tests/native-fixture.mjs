import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
// Filesystem-only fixture. SOG payloads are deliberately tiny; rendering tests
// use the real converter's output instead.
export async function nativeFixture(dir) {
  const bounds={min:[-1,-1,-1],max:[1,1,1]};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=','base64');
  const files=new Map([['cover.png',png],['collision/scene.voxel.json',Buffer.from(JSON.stringify({format:'portable-voxel',version:1,cellSize:0.1,requestedCellSize:0.1,opacity:0.25,cells:[],clippedSplats:0,coarsenings:0}))]]);
  const counts=[4,2,1],filenames=counts.map((_,i)=>`${i}_0/meta.json`);
  const meta={version:1,lodLevels:3,lodErrors:false,count:7,counts,filenames,tree:{bound:bounds,lods:Object.fromEntries(counts.map((count,i)=>[i,{file:i,offset:0,count}]))}};
  files.set('lod/lod-meta.json',Buffer.from(JSON.stringify(meta)));
  for(let i=0;i<3;i++) {
    const sog={version:2,count:counts[i],means:{files:['means_l.webp','means_u.webp']},quats:{files:['quats.webp']},scales:{files:['scales.webp']},sh0:{files:['sh0.webp']}};
    files.set(`lod/${filenames[i]}`,Buffer.from(JSON.stringify(sog)));
    for(const name of ['means_l','means_u','quats','scales','sh0'])files.set(`lod/${i}_0/${name}.webp`,Buffer.from([1,2,3,4]));
  }
  const manifest={format:'portable-3dgs',version:2,id:'scene-native-fixture',name:'磁盘测试',createdAt:new Date(0).toISOString(),cover:'cover.png',collision:'collision/scene.voxel.json',bounds,camera:{position:[0,1.4,0],yaw:0,pitch:0},streams:[{file:'lod/lod-meta.json',lodLevels:3,pointCount:4,background:false}],resources:[...files].filter(([file])=>file.startsWith('lod/')).map(([file,data])=>({file,bytes:data.length})),leafCount:1,pointCount:4,sourceBytes:224,conversion:{rotation:[90,0,180],method:'official-uniform-merge-streamed-sog',chunkSize:32768,sh:false,scale:1}};
  files.set('scene.json',Buffer.from(JSON.stringify(manifest)));
  for(const [file,data] of files){await mkdir(dirname(join(dir,file)),{recursive:true});await writeFile(join(dir,file),data);}
  return manifest;
}
