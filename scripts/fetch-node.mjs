// Download the official Node.js runtime (used by the conversion child process), fixed version + pinned SHA256.
// Why it is needed: Electron's V8 is compiled with sandbox enabled (v8_enable_sandbox=1),
// and the external ArrayBuffer that Dawn needs to read GPU results back is forbidden in that mode
// ("External buffers are not allowed"), so the conversion child process must use official Node.
// See the header comment in desktop/convert-child.mjs for the full reasoning.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

// `members` maps a path inside the archive to the name it gets in the staging directory, because
// a tarball keeps the binary at bin/node while the app expects a flat `node` next to `node.exe` on
// Windows.
const RUNTIMES = {
  'win32-x64': {
    version: 'v24.19.0',
    file: 'node-v24.19.0-win-x64.zip',
    sha256: '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73',
    members: [['node.exe', 'node.exe'], ['LICENSE', 'LICENSE']]
  },
  'darwin-arm64': {
    version: 'v24.19.0',
    file: 'node-v24.19.0-darwin-arm64.tar.gz',
    sha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    members: [['bin/node', 'node'], ['LICENSE', 'LICENSE']]
  },
  'linux-x64': {
    version: 'v24.19.0',
    file: 'node-v24.19.0-linux-x64.tar.xz',
    sha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
    members: [['bin/node', 'node'], ['LICENSE', 'LICENSE']]
  },
  'linux-arm64': {
    version: 'v24.19.0',
    file: 'node-v24.19.0-linux-arm64.tar.xz',
    sha256: '01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc',
    members: [['bin/node', 'node'], ['LICENSE', 'LICENSE']]
  }
};

const cache = '.build/node-runtime';

// unzip -p / tar -xO write the member straight to stdout, avoiding the few hundred MB of
// intermediate artifacts that unpacking the whole archive would leave behind.
const readMember = (archive, entry) =>
  /\.zip$/.test(archive)
    ? execFileSync('unzip', ['-p', archive, entry], { maxBuffer: 1 << 30 })
    : execFileSync('tar', ['-xOf', archive, entry], { maxBuffer: 1 << 30 });

export const fetchNodeRuntime = async (platform, arch) => {
  const spec = RUNTIMES[`${platform}-${arch}`];
  if (!spec) throw new Error(`No bundled Node runtime for ${platform}-${arch}.`);
  await mkdir(cache, { recursive: true });
  const archivePath = join(cache, spec.file);
  const digest = async p => createHash('sha256').update(await readFile(p)).digest('hex');
  const valid = await access(archivePath).then(() => digest(archivePath)).catch(() => null);
  if (valid !== spec.sha256) {
    const url = `https://nodejs.org/dist/${spec.version}/${spec.file}`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`);
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    const got = await digest(archivePath);
    if (got !== spec.sha256) throw new Error(`Node runtime SHA256 mismatch: got ${got}, want ${spec.sha256}`);
  }
  const dir = join(cache, `${platform}-${arch}`);
  await mkdir(dir, { recursive: true });
  const base = spec.file.replace(/\.(zip|tar\.gz|tar\.xz)$/, '');
  for (const [entry, as] of spec.members) {
    await writeFile(join(dir, as), readMember(archivePath, `${base}/${entry}`), { mode: entry.endsWith('node') ? 0o755 : 0o644 });
  }
  return dir;
};
