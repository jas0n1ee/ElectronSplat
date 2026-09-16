import { packager } from '@electron/packager';
import { writeRuntimeLicenses } from './licenses.mjs';
import { readFile, mkdir, writeFile, cp, rename, chmod } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { copyRuntimeDirectory } from './runtime-copy.mjs';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
if (!['win32','darwin','linux'].includes(platform) || !['x64','arm64'].includes(arch)) throw new Error('Use win32/darwin/linux and x64/arm64.');
if(platform==='linux')throw new Error('Linux desktop releases are paused. Release targets: win32 x64 or darwin arm64.');
if(platform==='darwin'&&arch!=='arm64')throw new Error('Intel Mac is no longer supported. Use darwin arm64.');
const icon = platform==='darwin'?'assets/icons/app.icns':platform==='win32'?'assets/icons/app.ico':undefined;
const paths = await packager({ icon, dir: '.build/electron', out: '.build/packages', name: 'Portable-3DGS-Viewer', executableName: 'Portable-3DGS-Viewer', appBundleId: 'org.portable3dgs.viewer', platform, arch, electronVersion: pkg.devDependencies.electron, appVersion: pkg.version, asar: true, overwrite: true, prune: false, download: { quiet: true } });
for (const staged of paths) {
  await writeRuntimeLicenses(staged, platform === 'darwin');
  // Update runtime files only. Rebuilding must never remove the user's scenes/profile.
  const output=join('desktop-dist',basename(staged));
  await copyRuntimeDirectory(staged,output);
  if(platform==='linux'){
    await rename(join(output,'Portable-3DGS-Viewer'),join(output,'portable-runtime'));
    await cp('desktop/linux-launcher.sh',join(output,'Portable-3DGS-Viewer'));
    await chmod(join(output,'Portable-3DGS-Viewer'),0o755);
  }
  const sceneRoot=platform==='darwin'?join(output,'scenes'):join(output,'..','scenes');
  await mkdir(sceneRoot, { recursive: true });
  await writeFile(join(sceneRoot,'README.txt'), '共享场景目录：与 Win/、Linux/ 和 Portable-3DGS-Viewer.app 同级。将整个 scene-… 文件夹复制到这里，打开应用即可自动显示；新转换也保存在这里。Windows/Linux 还会扫描可执行文件同级的旧 scenes，但新场景默认写入上一级共享 scenes。Mac 请在本机解压，保留 .app 与 scenes 同级关系。\n');
  console.log(`Ready: ${output}`);
}
