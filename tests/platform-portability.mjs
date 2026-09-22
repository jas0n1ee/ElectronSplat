import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { auditRuntimeLinks } from '../scripts/runtime-copy.mjs';

const result={platforms:[],nativeExecution:'Not run: this host is Linux; Mac/Windows require real-device acceptance.'};
for(const [platform,arch] of [['darwin','arm64'],['win32','x64']]){
  const name=`ElectronSplat-${platform}-${arch}`,src=resolve('desktop-dist',name);
  const temporary=await mkdtemp(join(tmpdir(),'portable-relocation-'));
  try{
    const copied=join(temporary,'USB 中文 空格',name);await mkdir(join(temporary,'USB 中文 空格'));
    await cp(src,copied,{recursive:true,verbatimSymlinks:true,filter:p=>!['scenes','.portable-profile'].includes(relative(src,p).split('/')[0])});
    const moved=join(temporary,'Moved app');await rename(copied,moved);
    const links=await auditRuntimeLinks(moved);
    let executable,asar,minimumOS;
    if(platform==='darwin'){
      const app=join(moved,'ElectronSplat.app'),plist=await readFile(join(app,'Contents','Info.plist'),'utf8');
      assert.match(plist,/<key>CFBundleExecutable<\/key>\s*<string>ElectronSplat<\/string>/);
      // Renaming the bundle identifier makes macOS treat this as a different application; pin it so a silent change is caught.
      assert.match(plist,/<key>CFBundleIdentifier<\/key>\s*<string>com\.electronsplat\.desktop<\/string>/);
      minimumOS=plist.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      executable=join(app,'Contents','MacOS','ElectronSplat');
      const files=[executable,join(app,'Contents','Frameworks','Electron Framework.framework','Electron Framework')];
      const cpu=arch==='arm64'?0x0100000c:0x01000007;
      for(const file of files){const bytes=await readFile(file);assert.equal(bytes.readUInt32LE(0),0xfeedfacf);assert.equal(bytes.readUInt32LE(4),cpu);assert.ok((await stat(file)).mode&0o111);}
      assert.equal(links.length,14);
      asar=join(app,'Contents','Resources','app.asar');
    }else{
      assert.equal(links.length,0);
      executable=join(moved,'ElectronSplat.exe');
      const bytes=await readFile(executable),offset=bytes.readUInt32LE(0x3c);
      assert.equal(bytes.toString('ascii',0,2),'MZ');assert.equal(bytes.toString('ascii',offset,offset+4),'PE\0\0');assert.equal(bytes.readUInt16LE(offset+4),0x8664);
      asar=join(moved,'resources','app.asar');
    }
    // Every package must carry its own Dawn native library. Packaging prunes the shared build tree per
    // platform, so a second platform packaged in the same build would silently ship without one
    // (asar bytes are recorded for evidence, but they legitimately differ per platform).
    const dawn=platform==='darwin'?'darwin-universal.dawn.node':'win32-x64.dawn.node';
    const unpacked=asar.replace(/app\.asar$/,'app.asar.unpacked');
    assert.ok(await stat(join(unpacked,'node_modules','webgpu','dist',dawn)).then(()=>true,()=>false),`${name}: missing ${dawn}`);
    // Conversion runs in a bundled Node process on every platform, so the runtime has to be there
    // and has to be executable. process.resourcesPath resolves inside .app on macOS and to
    // resources/ elsewhere, so those are the two places to look.
    const nodeRoot=platform==='darwin'?join(moved,'ElectronSplat.app','Contents','Resources','node'):join(moved,'resources','node');
    const nodeBin=platform==='win32'?'node.exe':'node';
    const bundled=await stat(join(nodeRoot,nodeBin)).catch(()=>null);
    assert.ok(bundled,`${name}: missing bundled Node runtime at ${join(nodeRoot,nodeBin)}`);
    if(platform!=='win32')assert.ok(bundled.mode&0o111,`${name}: bundled Node is not executable`);
    result.platforms.push({name,architecture:arch,minimumOS,linkCount:links.length,links,dawn,asarSha256:createHash('sha256').update(await readFile(asar)).digest('hex'),relocatedResourcesReadable:true});
  }finally{await rm(temporary,{recursive:true,force:true});}
}
await mkdir('test-results/platform-portability',{recursive:true});await writeFile('test-results/platform-portability/results.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result.platforms.map(({name,architecture,minimumOS,linkCount,relocatedResourcesReadable})=>({name,architecture,minimumOS,linkCount,relocatedResourcesReadable})),null,2));
