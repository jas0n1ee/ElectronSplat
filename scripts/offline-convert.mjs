// Offline batch conversion (the fix branch's Windows workaround): uses exactly the same
// official pipeline call sequence as desktop/convert-child.mjs to convert <inputDir>/{point_cloud,environment}.ply
// under local Node into a <scenesRoot>/scene-offline-<name>/ scene directory (lod/ + collision/ + scene.json + placeholder cover.png);
// the user then re-sets the name and cover image in the editor.
//
// Two intentional differences from the online pipeline:
// 1. lodErrors:false — under Dawn-native the GPU error table's mapAsync never resolves (measured with a probe),
//    and the official CLI defaults it off too;
// 2. skips cover image point sampling (cover uses a placeholder PNG, since it gets re-shot in the editor anyway).
//
// Usage: node --max-old-space-size=24576 scripts/offline-convert.mjs <inputDir> <scenesRoot>
import { appendFileSync, closeSync, existsSync, openSync, readSync, renameSync, rmSync, statSync, writeSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [inputDir, scenesRoot] = process.argv.slice(2).map(p => resolve(p));
if (!inputDir || !scenesRoot) { console.error('usage: node scripts/offline-convert.mjs <inputDir> <scenesRoot>'); process.exit(2); }

const { globals, create } = await import('webgpu');
const st = await import('@playcanvas/splat-transform');
const { Transform, WebPCodec, WorkerQueue, writeLodSource, writeVoxel, bakeTransform, stackLods, createChunkDataPool, decimateSource, materializeToDataTable, logger, readPly, processSource, writeSource, ReadStream } = st;
const { Quat, Vec3 } = await import('playcanvas');

Object.assign(globalThis, globals);
globalThis.window = { navigator: { userAgent: 'node.js' } };
globalThis.document = { createElement: (type) => type === 'canvas' ? {
  getContext: () => null,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }),
  width: 300, height: 150
} : null };
// fileURLToPath, not URL.pathname: on Windows the latter yields "/H:/…" and path.resolve then
// treats the leading slash as the current drive's root, producing "C:\H:\…".
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// Node worker_threads' Worker constructor does not accept a file:// string, it must be a URL object.
WorkerQueue.workerUrl = new URL('../node_modules/@playcanvas/splat-transform/dist/worker.mjs', import.meta.url);
WorkerQueue.maxWorkers = null; // official CLI default scheduling
WebPCodec.wasmUrl = pathToFileURL(join(repoRoot, 'node_modules/@playcanvas/splat-transform/lib/webp.wasm')).href;

// Matches the UI defaults (the parameters actually run in the Windows logs). OFFLINE_LEVELS controls the LOD level count (default 3).
//
// OFFLINE_SH is the SH band count to keep (0-3). The default 0 matches the in-app converter and is
// what every scene converted so far used. Higher values keep the view-dependent colour that is
// otherwise discarded — PlayCanvas 2.22.2 renders it end-to-end, and the writer only emits shN when
// the source actually carries bands. Set it to run the SH0/SH1/SH2/SH3 comparison; the band count is
// part of the scene id so the variants can sit side by side.
const SH_BANDS = Math.max(0, Math.min(3, Number(process.env.OFFLINE_SH ?? 0) || 0));
const opts = { scale: 1, rotation: [90, 0, 180], cellSize: 0.5, opacity: 0.25, sh: SH_BANDS > 0, shBands: SH_BANDS, chunkSize: 32768 };
const LEVELS = Math.max(2, Math.min(16, Number(process.env.OFFLINE_LEVELS ?? 3) || 3));
const variant = (LEVELS === 3 ? '' : `-lod${LEVELS}`) + (SH_BANDS === 0 ? '' : `-sh${SH_BANDS}`);
const name = basename(inputDir) + (LEVELS === 3 ? '' : ` · LOD${LEVELS}`) + (SH_BANDS === 0 ? '' : ` · SH${SH_BANDS}`);
const id = `scene-offline-${basename(inputDir).toLowerCase()}${variant}`;
const finalDir = join(scenesRoot, id);
const buildDir = join(scenesRoot, `.converting-${id}`);
if (existsSync(join(finalDir, 'scene.json'))) { console.log(`[${name}] already converted, skip`); process.exit(0); }
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

const t0 = performance.now();
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)} +${Math.round((performance.now() - t0) / 1000)}s rss=${Math.round(process.memoryUsage.rss() / 1048576)}MB] ${msg}`);
setInterval(() => log('(heartbeat)'), 60000).unref();

// ---- local filesystem adapters ----
// Under Node the official writer uses node:path.resolve to produce derived file paths (absolute paths based on cwd),
// which are normalized uniformly to virtual paths relative to buildDir at the createWriter entry point.
const cwd = process.cwd();
const aliases = new Map(); // virtual name → absolute path (input files)
// POSIX-style virtual path: on Windows the official writer derives absolute paths with backslashes
// and path.relative preserves them, so the 'lod/lod-meta.json' comparisons below would never match.
const normalize = (vpath) => {
  const posix = (p) => p.replace(/\\/g, '/');
  if (!isAbsolute(vpath)) return posix(vpath);
  const rel = relative(cwd, vpath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`官方 writer 输出路径越界：${vpath}`);
  return posix(rel);
};
const real = (vpath) => aliases.get(vpath) ?? join(buildDir, vpath);
const fds = new Map();
const fdFor = (abs) => { let fd = fds.get(abs); if (fd === undefined) { fd = openSync(abs, 'r'); fds.set(abs, fd); } return fd; };

const readFs = {
  async createSource(filename) {
    const abs = real(normalize(filename)), size = statSync(abs).size;
    return { size, seekable: true, close() {}, read(start = 0, end = size) {
      return new class extends ReadStream {
        #pos = start;
        constructor() { super(end - start); }
        async pull(target) {
          const length = Math.min(target.length, end - this.#pos, 8 * 1024 ** 2);
          if (!length) return 0;
          const n = readSync(fdFor(abs), target, 0, length, this.#pos);
          this.#pos += n; this.bytesRead += n; return n;
        }
        close() { this.#pos = end; }
      }();
    } };
  }
};
const makeWriterFs = (onClose) => ({
  async mkdir() {},
  createWriter(filename) {
    const vpath = normalize(filename);
    const abs = real(vpath);
    mkdirSync(join(abs, '..'), { recursive: true });
    const fd = openSync(abs, 'w');
    let failed = null;
    const writer = {
      bytesWritten: 0,
      async write(data) { writeSync(fd, data); writer.bytesWritten += data.byteLength; },
      async close() { closeSync(fd); if (!failed) await onClose?.(vpath, writer.bytesWritten); },
      async abort() { failed = true; closeSync(fd); }
    };
    return writer;
  }
});
const workFs = makeWriterFs(null); // .work intermediate files: streamed to disk

aliases.set('foreground.ply', join(inputDir, 'point_cloud.ply'));
const hasBackground = existsSync(join(inputDir, 'environment.ply'));
if (hasBackground) aliases.set('background.ply', join(inputDir, 'environment.ply'));

// ---- pipeline (line for line corresponding to convert-child.mjs run()) ----
logger.setVerbosity('quiet');
let current = 'init', lastTick = 0;
logger.setRenderer({ handle(event) {
  if (event.kind === 'scopeStart') { current = event.name; log(`▸ ${event.name}${event.total ? ` (${event.total})` : ''}`); }
  if ((event.kind === 'barTick' || event.kind === 'barEnd') && event.total > 0) {
    const now = performance.now();
    if (event.kind === 'barEnd' || now - lastTick > 10000) { lastTick = now; log(`  ${event.name} ${Number(event.current).toLocaleString()} / ${event.total.toLocaleString()}`); }
  }
  if (event.kind === 'message') log(`  [official:${event.level}] ${event.text}`);
} });

window.navigator.gpu = create([]);
// high-performance: on dual-GPU machines Dawn may pick the integrated GPU by default (on this machine it picked the Intel iGPU rather than the RTX 3090).
const device = new (await import('playcanvas')).WebgpuGraphicsDevice(document.createElement('canvas'), { antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
await device.createDevice();
const adapterInfo = device.gpuAdapter?.info;
log(`gpu ready: ${device.deviceType} adapter=${JSON.stringify({ vendor: adapterInfo?.vendor, architecture: adapterInfo?.architecture, description: adapterInfo?.description })}`);

const pool = createChunkDataPool({ chunkSize: 1024 * 1024, maxPooledBytes: 512 * 1024 * 1024 });
const spill = { scratchDir: '.work', writeFs: workFs, readFs };

const openInput = async (vname) => {
  const src = await readPly(await readFs.createSource(vname), pool);
  // filterBands is a band drop only (it can never add bands), so this is the single line that decides
  // how much view-dependent colour survives into the scene.
  const stripped = await processSource(src, [{ kind: 'filterBands', value: SH_BANDS }], pool);
  log(`${vname}: SH bands in source = ${src.meta.shBands ?? 0}, keeping ${SH_BANDS}`);
  return { meta: { ...stripped.meta, transform: new Transform().fromEulers(...opts.rotation) }, read: (req) => stripped.read(req), close: () => stripped.close() };
};

log(`reading headers: ${name}`);
const level0 = await openInput('foreground.ply');
const totalPoints = level0.meta.numGaussians;
if (!totalPoints) throw new Error('前景没有有效 Gaussian。');
log(`foreground: ${totalPoints.toLocaleString()} points`);

const decimateLevel = async (source, target, level) => {
  log(`decimate level ${level} → ${target.toLocaleString()}`);
  const out = await decimateSource(source, pool, { targetCount: target, memoryBudgetBytes: 128 * 1024 * 1024, createDevice: () => device, spill });
  await writeSource({ filename: `.work/level-${level}.ply`, outputFormat: 'ply', source: out, pool, options: {} }, workFs);
  log(`level ${level} staged: ${(statSync(join(buildDir, '.work', `level-${level}.ply`)).size / 1024 ** 3).toFixed(2)}GB`);
  return readPly(await readFs.createSource(`.work/level-${level}.ply`), pool);
};
const levels = [level0];
for (let i = 1; i < LEVELS; i++) levels.push(await decimateLevel(levels[i - 1], Math.max(1, Math.ceil(totalPoints / 2 ** i)), i));
const envSource = hasBackground ? await openInput('background.ply') : null;
if (hasBackground) log(`background: ${envSource.meta.numGaussians.toLocaleString()} points`);

let streams = [], resources = [], leafCount = 0, bounds = null, voxelNodes = 0;
const plyQuat = new Quat().setFromEulerAngles(0, 0, 180);
const rotateBounds = (q, b) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const v = q.transformVector(new Vec3(b[c & 1 ? 'max' : 'min'][0], b[c & 2 ? 'max' : 'min'][1], b[c & 4 ? 'max' : 'min'][2]));
    const p = [v.x, v.y, v.z].map(n => Math.abs(n) < 1e-12 ? 0 : n);
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  }
  return { min, max };
};
const outFs = makeWriterFs(async (filename, bytes) => {
  if (bytes > 128 * 1024 ** 2) throw new Error(`输出文件超过 128 MiB：${filename}`);
  if (filename === 'lod/lod-meta.json') {
    const meta = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(buildDir, filename), 'utf8')));
    const visit = (n) => { if (n.lods) leafCount++; n.children?.forEach(visit); };
    visit(meta.tree);
    streams.push({ file: filename, lodLevels: meta.lodLevels, pointCount: meta.counts[0], background: false });
    bounds = rotateBounds(plyQuat, { min: [...meta.tree.bound.min], max: [...meta.tree.bound.max] });
  }
  resources.push({ file: filename, bytes });
});

log('writeLodSource (partition + sog encode)…');
await writeLodSource({ filename: 'lod/lod-meta.json', mainSource: stackLods([bakeTransform(level0, Transform.PLY), ...levels.slice(1)]), envSource, iterations: 4, chunkCount: 512, chunkExtent: 16, chunkMin: 8, lodErrors: false, createDevice: () => device }, outFs);
log(`lodWrite done: leaves=${leafCount} resources=${resources.length}`);

log('writeVoxel…');
// The official writeVoxel uploads all points in one go (64 bytes/point), and the storage buffer binding limit is ~2GiB,
// i.e. >33.5M points necessarily fails (measured on 0907A: 2.68GB > 2147483644). Voxels are only used for collision,
// so use the finest LOD level that fits — the simplified level is produced by the official merge algorithm, and the geometric coverage is equivalent.
const voxelLimit = (device.limits?.maxStorageBufferBindingSize ?? 2147483644) * 0.9;
const voxelLevel = levels.find(l => l.meta.numGaussians * 64 <= voxelLimit);
if (!voxelLevel) throw new Error('最粗 LOD 层也超出体素 GPU 上限。');
log(`voxel input: ${voxelLevel.meta.numGaussians.toLocaleString()} points（共 ${totalPoints.toLocaleString()}）`);
let geometry = await materializeToDataTable(bakeTransform(voxelLevel, Transform.IDENTITY), pool, new Set(['position', 'geometric']));
const voxelFs = makeWriterFs(async (filename) => {
  if (filename === 'collision/scene.voxel.json') {
    const meta = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(buildDir, filename), 'utf8')));
    if (meta.version !== '1.1' || meta.voxelResolution !== opts.cellSize) throw new Error('官方体素尺寸或格式与请求不一致。');
    voxelNodes = meta.nodeCount;
  }
});
await writeVoxel({ filename: 'collision/scene.voxel.json', dataTable: geometry, voxelResolution: opts.cellSize, opacityCutoff: opts.opacity, createDevice: () => device }, voxelFs);
geometry = null;
log(`voxel done: nodes=${voxelNodes}`);

// Placeholder cover image (1x1 PNG); the user re-sets it in the editor with "set as cover".
const COVER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(buildDir, 'cover.png'), COVER_PNG);
const manifest = {
  format: 'portable-3dgs', version: 2, id, name, createdAt: new Date().toISOString(),
  cover: 'cover.png', collision: 'collision/scene.voxel.json', collisionFormat: 'playcanvas-voxel',
  bounds, camera: { position: [0, 1.4, 0], yaw: 0, pitch: 0 },
  streams, resources, leafCount, pointCount: totalPoints,
  sourceBytes: statSync(aliases.get('foreground.ply')).size + (hasBackground ? statSync(aliases.get('background.ply')).size : 0),
  conversion: { method: 'official-streamed-decimate-lod-sog', chunkSize: opts.chunkSize, sh: opts.sh, scale: opts.scale, rotation: opts.rotation }
};
writeFileSync(join(buildDir, 'scene.json'), JSON.stringify(manifest, null, 2));
rmSync(join(buildDir, '.work'), { recursive: true, force: true });
renameSync(buildDir, finalDir);
for (const fd of fds.values()) closeSync(fd);
await WorkerQueue.destroy().catch(() => {});
log(`DONE ${id} → ${finalDir}`);
process.exit(0);
