import type { SceneManifest } from './types';
export async function previewCover(scene:SceneManifest,points:number[][]):Promise<Blob> {
  const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
  const ctx=canvas.getContext('2d')!;
  const gradient=ctx.createLinearGradient(0,0,1280,720);gradient.addColorStop(0,'#17252c');gradient.addColorStop(1,'#091012');ctx.fillStyle=gradient;ctx.fillRect(0,0,1280,720);
  // A cover may frame the whole scene; it never determines where the viewer spawns.
  const b=scene.bounds,center=b.min.map((v,a)=>(v+b.max[a])/2);
  const extent=Math.max(0.5,...b.max.map((v,a)=>v-b.min[a]));
  const p=[center[0],center[1]+extent*0.2,center[2]+extent*1.2];
  const pitch=-9.46*Math.PI/180, cp=Math.cos(pitch),sp=Math.sin(pitch);
  const factor=360/Math.tan(65*Math.PI/360);
  const projected=points.map(v=>{
    const dx=v[0]-p[0],dy=v[1]-p[1],dz=v[2]-p[2];
    const cy=cp*dy+sp*dz,depth=sp*dy-cp*dz;
    return {x:640+factor*dx/depth,y:360-factor*cy/depth,depth,v};
  }).filter(v=>v.depth>0.01).sort((a,b)=>b.depth-a.depth);
  const srgb=(v:number)=>Math.round(255*Math.pow(Math.max(0,Math.min(1,v*0.28209479+0.5)),1/2.2));
  for(const q of projected) {
    if(q.x<0||q.y<0||q.x>1280||q.y>720)continue;
    ctx.fillStyle=`rgba(${srgb(q.v[3])},${srgb(q.v[4])},${srgb(q.v[5])},0.85)`;
    ctx.beginPath();ctx.arc(q.x,q.y,2.8,0,Math.PI*2);ctx.fill();
  }
  ctx.fillStyle='rgba(255,255,255,.55)';ctx.font='16px sans-serif';ctx.fillText('点云预览 · 可在 Viewer 中设定首图',28,688);
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('首图生成失败。')),'image/png'));
}
