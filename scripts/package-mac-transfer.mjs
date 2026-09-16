import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { auditRuntimeLinks } from './runtime-copy.mjs';

// Transport only: zip -y stores the Mac framework links and executable modes.
// Unpack on a filesystem that supports them; this does not make an .app work
// directly from a filesystem without symbolic links.
const arch = process.argv[2] || 'arm64';
if (arch !== 'arm64') throw new Error('Intel Mac is no longer supported. Use arm64.');
const run = promisify(execFile);
const name = `Portable-3DGS-Viewer-darwin-${arch}`;
const source = resolve('desktop-dist', name);
const appName = 'Portable-3DGS-Viewer.app';
const sourceApp = join(source, appName);
const sourceLinks = await auditRuntimeLinks(sourceApp);
assert.equal(sourceLinks.length, 14);
const output = resolve('desktop-transfer');
await mkdir(output, { recursive: true });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const archiveName = `ElectronSplat-${version}-mac-arm64.zip`;
const archive = join(output, archiveName);
const incoming = join(output, `.incoming-${randomUUID()}.zip`);
const temporary = await mkdtemp(join(tmpdir(), 'portable-mac-transfer-'));
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
try {
  await run('zip', ['-q', '-r', '-y', incoming, appName, join('scenes', 'README.txt')], { cwd: source });
  const unpacked=join(temporary,'unpacked');await mkdir(unpacked);
  await run('unzip', ['-q', incoming, '-d', unpacked]);
  const moved = join(temporary, 'Mac 中文 空格');
  await rename(unpacked, moved);
  const extractedApp = join(moved, appName);
  const links = await auditRuntimeLinks(extractedApp);
  assert.deepEqual(links.sort((a,b)=>a.path.localeCompare(b.path)), sourceLinks.sort((a,b)=>a.path.localeCompare(b.path)));
  const files = [
    'Contents/MacOS/Portable-3DGS-Viewer',
    'Contents/Frameworks/Electron Framework.framework/Electron Framework',
    'Contents/Resources/app.asar'
  ];
  for (const file of files) {
    assert.equal(await digest(join(extractedApp, file)), await digest(join(sourceApp, file)));
    assert.equal((await stat(join(extractedApp, file))).mode & 0o777, (await stat(join(sourceApp, file))).mode & 0o777);
  }
  const sha256 = await digest(incoming);
  await rename(incoming, archive);
  await writeFile(`${archive}.sha256`, `${sha256}  ${archiveName}\n`);
  const result = { archive, sha256, bytes: (await stat(archive)).size, layout:[appName,'scenes/'], linkCount: links.length, relocatedResourcesReadable: true, executableModesPreserved: true, nativeExecution: 'Not run; requires a Mac.' };
  await mkdir('test-results/platform-portability', { recursive: true });
  await writeFile(`test-results/platform-portability/mac-${arch}-transfer.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(incoming, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
