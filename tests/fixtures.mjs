import {mkdir,open,writeFile} from 'node:fs/promises';
export const baseNames=['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
export function fixture({count=256,sh=false,bigEndian=false,ascii=false,offset=0,unicode=false,width=16,depth=-15}={}) {
  const names=[...baseNames,...(sh?Array.from({length:9},(_,i)=>`f_rest_${i}`):[])];
  const header=`ply\nformat ${ascii?'ascii':bigEndian?'binary_big_endian':'binary_little_endian'} 1.0\n${unicode?'comment 中文场景 UTF-8\n':''}element vertex ${count}\n${names.map(n=>`property float ${n}`).join('\n')}\nend_header\n`;
  const rows=Array.from({length:count},(_,i)=>[offset+(i%width)*0.07-0.5,depth,Math.floor(i/width)*0.07,0.7,-0.2,-0.8,3,-3,-3,-3,1,0,0,0,...(sh?Array.from({length:9},(_,j)=>Math.sin(i+j)*0.01):[])]);
  if(ascii)return new Blob([header,rows.map(r=>r.join(' ')).join('\n')+'\n']);
  const binary=new ArrayBuffer(count*names.length*4),view=new DataView(binary);
  rows.forEach((row,i)=>row.forEach((v,j)=>view.setFloat32((i*names.length+j)*4,v,!bigEndian)));
  return new Blob([header,binary]);
}
export async function prepareFixtures() {
  await mkdir('test-results/fixtures',{recursive:true});
  for(const [name,opts] of [['render.ply',{count:8192,width:128}],['valid.ply',{}],['background.ply',{count:64,offset:20}],['sh.ply',{count:128,sh:true}],['big-endian.ply',{bigEndian:true}],['ascii.ply',{ascii:true}]])await writeFile(`test-results/fixtures/${name}`,Buffer.from(await fixture(opts).arrayBuffer()));
  await writeFile('test-results/fixtures/invalid.ply','ply\nformat binary_little_endian 1.0\nelement vertex 100\nend_header\n');
}
export async function sparseLargeFixture(path='test-results/fixtures/large-2gib.ply') {
  await mkdir('test-results/fixtures',{recursive:true});
  const names=[...baseNames,...Array.from({length:45},(_,i)=>`f_rest_${i}`)];
  const stride=names.length*4,count=Math.ceil((2**31+1024*1024)/stride);
  const header=Buffer.from(`ply\nformat binary_little_endian 1.0\ncomment sparse regression fixture; middle rows have invalid zero quaternions\nelement vertex ${count}\n${names.map(n=>`property float ${n}`).join('\n')}\nend_header\n`);
  const file=await open(path,'w');
  try {
    await file.write(header,0,header.length,0);await file.truncate(header.length+stride*count);
    const points=Buffer.alloc(stride*128);
    for(let i=0;i<128;i++){
      const row=[(i%16)*0.08,Math.floor(i/16)*0.08,0,0.1,0.3,0.5,3,-3,-3,-3,1,0,0,0];
      row.forEach((v,j)=>points.writeFloatLE(v,i*stride+j*4));
    }
    await file.write(points,0,points.length,header.length);
    await file.write(points,0,points.length,header.length+(count-128)*stride);
  }finally{await file.close();}
  return {path,count,valid:256,bytes:header.length+stride*count};
}
