import { packager } from '@electron/packager';
import { writeRuntimeLicenses } from './licenses.mjs';
import { fetchNodeRuntime } from './fetch-node.mjs';
import { readFile, mkdir, writeFile, cp, copyFile, rename, chmod, readdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { copyRuntimeDirectory } from './runtime-copy.mjs';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
if (!['win32','darwin','linux'].includes(platform) || !['x64','arm64'].includes(arch)) throw new Error('Use win32/darwin/linux and x64/arm64.');
// Linux was paused because its default Chrome WebGPU needs experimental flags. That is a constraint
// on the browser renderer, which the conversion no longer uses: the child process drives Dawn
// directly, and Dawn on Linux has been measured converting a 94.3M-point capture. The viewer still
// needs WebGPU or the WebGL2 fallback, as on every other platform.
if(platform==='darwin'&&arch!=='arm64')throw new Error('Intel Mac is no longer supported. Use darwin arm64.');
const icon = platform==='darwin'?'assets/icons/app.icns':platform==='win32'?'assets/icons/app.ico':undefined;
// The conversion child process runs as pure Node (ELECTRON_RUN_AS_NODE) and cannot read asar,
// so the child process entry point and the three packages it imports must be unpacked wholesale; the Dawn native library ships only the target platform.
const dawnDist='.build/electron/node_modules/webgpu/dist';
const dawnSrc='node_modules/webgpu/dist';
const wanted=`${platform}-${platform==='darwin'?'universal':arch}.dawn.node`;
const keep=new Set([wanted,...(platform==='win32'?['d3dcompiler_47.dll']:[])]);
// Pruning is destructive and the build tree is shared, so restore this target's native library first:
// packaging win32 then darwin would otherwise find darwin's library already deleted by the win32 run
// and ship a macOS app with no Dawn at all.
await mkdir(dawnDist,{recursive:true});
await copyFile(join(dawnSrc,wanted),join(dawnDist,wanted));
for (const f of await readdir(dawnDist)) if (!keep.has(f)) await rm(join(dawnDist,f),{force:true});
const paths = await packager({ icon, dir: '.build/electron', out: '.build/packages', name: 'ElectronSplat', executableName: 'ElectronSplat', appBundleId: 'com.electronsplat.desktop', platform, arch, electronVersion: pkg.devDependencies.electron, appVersion: pkg.version, asar: { unpack: '**/{convert-child,lod-levels}.mjs', unpackDir: 'node_modules' }, overwrite: true, prune: false, download: { quiet: true } });
for (const staged of paths) {
  // Official Node runtime for the conversion child process (Electron's V8 sandbox forbids Dawn's GPU
  // readback, see the header comment in fetch-node.mjs). Placed beside the app resources, not inside
  // asar, because the child cannot read asar. process.resourcesPath resolves to Contents/Resources
  // inside a .app and to resources/ everywhere else, so those are the two destinations.
  {
    const nodeDir = await fetchNodeRuntime(platform, arch);
    const resources = platform === 'darwin' ? join(staged, 'ElectronSplat.app', 'Contents', 'Resources') : join(staged, 'resources');
    const binName = platform === 'win32' ? 'node.exe' : 'node';
    await mkdir(join(resources, 'node'), { recursive: true });
    await copyFile(join(nodeDir, binName), join(resources, 'node', binName));
    await copyFile(join(nodeDir, 'LICENSE'), join(resources, 'node', 'LICENSE-node.txt'));
    // copyFile does not carry the mode across, and a Node that cannot be executed is no runtime.
    if (platform !== 'win32') await chmod(join(resources, 'node', binName), 0o755);
  }
  await writeRuntimeLicenses(staged, platform === 'darwin');
  // Update runtime files only. Rebuilding must never remove the user's scenes/profile.
  const output=join('desktop-dist',basename(staged));
  await copyRuntimeDirectory(staged,output);
  if(platform==='linux'){
    await rename(join(output,'ElectronSplat'),join(output,'portable-runtime'));
    await cp('desktop/linux-launcher.sh',join(output,'ElectronSplat'));
    await chmod(join(output,'ElectronSplat'),0o755);
  }
  const sceneRoot=platform==='darwin'?join(output,'scenes'):join(output,'..','scenes');
  await mkdir(sceneRoot, { recursive: true });
  await writeFile(join(sceneRoot,'README.txt'), '共享场景目录：与 Win/、Linux/ 和 ElectronSplat.app 同级。将整个 scene-… 文件夹复制到这里，打开应用即可自动显示；新转换也保存在这里。Windows/Linux 还会扫描可执行文件同级的旧 scenes，但新场景默认写入上一级共享 scenes。Mac 请在本机解压，保留 .app 与 scenes 同级关系。\n');
  console.log(`Ready: ${output}`);
}
