import { _electron as electron } from '@playwright/test';
import { mkdir,writeFile,readFile,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Data } from 'resedit';
import assert from 'node:assert/strict';
// Deterministic resizing/format conversion of the supplied artwork. No redraw.
const input=resolve(process.argv[2]||'assets/icons/source.png');
const output=resolve('assets/icons');await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'portable-icon-tool-'));
const xvfb=process.env.DISPLAY?null:spawn(resolve('.tools/xvfb/root/usr/bin/Xvfb'),[':192','-screen','0','1024x768x24','-nolisten','tcp'],{stdio:'ignore'});
if(xvfb)await new Promise(r=>setTimeout(r,500));
let app;
try {
 app=await electron.launch({executablePath:resolve(process.env.PORTABLE_ICON_EXECUTABLE||'desktop-dist/Portable-3DGS-Viewer-linux-x64/Portable-3DGS-Viewer'),chromiumSandbox:true,args:[`--data-dir=${root}`],env:{...process.env,DISPLAY:process.env.DISPLAY||':192'}});
 const sizes=[16,20,24,32,40,48,64,128,256,512,1024];
 const result=await app.evaluate(({nativeImage},{input,sizes})=>{
  const source=nativeImage.createFromPath(input);if(source.isEmpty())throw new Error('Source icon could not be decoded');
  const size=source.getSize();if(size.width!==size.height)throw new Error('Expected square artwork; do not stretch the original');
  const bitmap=source.toBitmap();let transparent=0;for(let i=3;i<bitmap.length;i+=4)if(bitmap[i]===0)transparent++;
  return {size,transparent,images:sizes.map(width=>({width,png:source.resize({width,height:width,quality:'best'}).toPNG().toString('base64')}))};
 },{input,sizes});
 assert.ok(result.transparent>0,'Transparent background required');
 const pngs=new Map(result.images.map(({width,png})=>[width,Buffer.from(png,'base64')]));
 await writeFile(join(output,'app.png'),pngs.get(1024));
 const ico=new Data.IconFile();
 for(const width of sizes.filter(s=>s<=256))ico.icons.push({data:new Data.RawIconItem(pngs.get(width),width,width,32)});
 await writeFile(join(output,'app.ico'),Buffer.from(ico.generate()));
 const chunks=[];
 for(const [type,size] of Object.entries({icp4:16,icp5:32,icp6:64,ic07:128,ic08:256,ic09:512,ic10:1024,ic11:32,ic12:64,ic13:256,ic14:512})){
  const png=pngs.get(size),header=Buffer.alloc(8);header.write(type);header.writeUInt32BE(png.length+8,4);chunks.push(header,png);
 }
 const body=Buffer.concat(chunks),header=Buffer.alloc(8);header.write('icns');header.writeUInt32BE(body.length+8,4);
 await writeFile(join(output,'app.icns'),Buffer.concat([header,body]));
 await writeFile(join(output,'provenance.json'),JSON.stringify({sourceFile:'source.png',originalFilename:'0b4dfe62-f910-425d-ba8a-72b2a9fe3615.png',sourceSha256:createHash('sha256').update(await readFile(input)).digest('hex'),sourceSize:result.size,sourceTransparentPixels:result.transparent,masterSize:1024,icoSizes:sizes.filter(s=>s<=256),method:'Electron nativeImage.resize best; proportional downscaling, original margins and alpha retained; PNG payloads in ICO/ICNS'},null,2)+'\n');
 console.log(JSON.stringify({source:result.size,transparentPixels:result.transparent,output,icoSizes:sizes.filter(s=>s<=256)}));
} finally {if(app)await app.close();xvfb?.kill();await rm(root,{recursive:true,force:true});}
