// Conversion executor, run on official Node (the Windows package bundles resources/node/node.exe).
//
// Why a separate process on official Node rather than Electron's own runtimes:
//   - utilityProcess dies during Chromium/crashpad init on this Windows machine (exit 0xFFFF7003,
//     not a single line of JS ran);
//   - Dawn's Node-API bindings (dawn.node) create external ArrayBuffers, which Electron's
//     V8 memory cage forbids ("External buffers are not allowed"), so the GPU pipeline cannot run
//     inside Electron at all.
// Measured result: the same 41.8M-point input that is killed at 58% of partitioning inside the
// app's Chrome worker completes here in 29.9 minutes with rss flat at ~3 GB.
//
// The conversion itself is entirely the official library -- readPly, processSource/filterBands,
// decimateSource, writeSource, stackLods, writeLodSource, writeVoxel. What lives here is only the
// file I/O adapter and the call order.
//
// Wire protocol: the payload arrives as JSON on stdin; progress goes back over process.send.
import { openSync, closeSync, readSync, writeSync, statSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIN_LOD_LEVELS, coarsestAt, planLodLevels } from './lod-levels.mjs';

// If the app crashes, do not keep processing an orphaned transaction.
if (process.send) process.once('disconnect', () => process.exit(1));
// process.send is asynchronous: the message sits on the IPC channel until the loop writes it out.
// Exiting on a timer that does not keep the loop alive can therefore discard a queued message, which
// is how the manifest went missing while the child still reported a clean exit. Callers that are
// about to exit pass a callback and wait for the flush.
const send = (message, flushed) => {
  if (typeof process.send === 'function') { try { process.send(message, err => { void err; flushed?.(); }); return; } catch {} }
  flushed?.();
};
const stage = (name, data) => {
  if (name !== 'progress') send({ type: 'log', event: `child.${name}`, data });
};
process.on('uncaughtException', e => { stage('uncaught', String(e?.stack || e)); send({ type: 'error', message: `转换进程异常：${e?.message ?? e}`, stack: String(e?.stack || '') }); setTimeout(() => process.exit(1), 50).unref?.(); });
process.on('unhandledRejection', e => { stage('unhandledRejection', String(e?.stack || e)); });

const readStdin = () => new Promise((resolve, reject) => {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`转换参数无效：${e.message}`)); } });
  process.stdin.on('error', reject);
});

const run = async (job) => {
  const { dir, id, name, foreground, background, options } = job;
  if (!dir || !foreground) throw new Error('转换参数缺少输出目录或前景文件。');
  const cellSize = [0.1, 0.2, 0.5].includes(options?.cellSize) ? options.cellSize : 0.1;
  const rotation = options?.rotation ?? [90, 0, 180];
  const shBands = Math.max(0, Math.min(3, Number(options?.shBands ?? 0) || 0));
  // Required rather than defaulted: this is the viewer's largest splat budget, and a wrong value here
  // silently ships a scene that the allocator pins at every preset. The renderer owns the number
  // (src/lod.ts LOD_CEILING) and passes it per job, so the child keeps no copy of its own.
  const lodCeiling = options?.lodCeiling;
  if (!Number.isSafeInteger(lodCeiling) || lodCeiling < 1) throw new Error('转换参数缺少有效的 LOD 预算上限。');
  const opts = { scale: 1, rotation, cellSize, opacity: 0.25, sh: shBands > 0, chunkSize: 32768 };

  stage('boot', { node: process.version, platform: process.platform, arch: process.arch, id });

  const { globals, create } = await import('webgpu');
  const st = await import('@playcanvas/splat-transform');
  const { Transform, WebPCodec, WorkerQueue, writeLodSource, writeVoxel, bakeTransform, stackLods,
    createChunkDataPool, decimateSource, materializeToDataTable, logger, readPly, processSource,
    writeSource, ReadStream } = st;
  const { Quat, Vec3 } = await import('playcanvas');

  // Same globals the official CLI installs (initializeGlobals in cli.mjs).
  Object.assign(globalThis, globals);
  globalThis.window = { navigator: { userAgent: 'node.js' } };
  globalThis.document = { createElement: (type) => type === 'canvas' ? {
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }),
    width: 300, height: 150
  } : null };
  // worker_threads' Worker takes a URL object, not a file:// string; a string throws and the
  // official WorkerQueue then retries spawn forever.
  WorkerQueue.workerUrl = new URL('../node_modules/@playcanvas/splat-transform/dist/worker.mjs', import.meta.url);
  WorkerQueue.maxWorkers = null;
  // fileURLToPath, not URL.pathname: the latter yields "/H:/..." on Windows and path.resolve then
  // treats the leading slash as the current drive's root.
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  WebPCodec.wasmUrl = pathToFileURL(join(packageRoot, 'node_modules/@playcanvas/splat-transform/lib/webp.wasm')).href;
  logger.setVerbosity('quiet');

  // ---- local filesystem adapters: the child reads and writes the disk directly ----
  // Resolve writer paths relative to the child's cwd, then map them into staging. Keeping cwd
  // outside staging avoids a Windows directory handle blocking the final transaction rename.
  const cwd = process.cwd();
  const aliases = new Map();
  // Returns a POSIX-style virtual path. On Windows the official writer derives absolute paths with
  // backslashes, and path.relative keeps them, so every prefix comparison below would silently fail
  // -- e.g. 'lod\\lod-meta.json' is not 'lod/lod-meta.json'. join(dir, ...) accepts either separator.
  const normalize = (vpath) => {
    const posix = (p) => p.replace(/\\/g, '/');
    if (!isAbsolute(vpath)) return posix(vpath);
    const rel = relative(cwd, vpath);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`官方 writer 输出路径越界：${vpath}`);
    return posix(rel);
  };
  const fds = new Map();
  const real = (vpath) => aliases.get(vpath) ?? join(dir, vpath);
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
      const vpath = normalize(filename), abs = real(vpath);
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
  const workFs = makeWriterFs(null);

  aliases.set('foreground.ply', foreground);
  const hasBackground = !!background && existsSync(background);
  if (hasBackground) aliases.set('background.ply', background);

  // Progress is reported as phase + fraction-within-phase, never as an overall number: the
  // renderer owns the work-weighted model that turns phases into one bar, because that bar is UI.
  let phase = 'decimate', levelBase = 0, levelSpan = 1, plannedLevels = 0, currentLevel = 0;
  const phaseOf = (name) => {
    if (name === 'chunking') return 'partition';
    if (name === 'lod errors') return 'errors';
    if (name === 'env' || /^[0-9]+_[0-9]+$/.test(name)) return 'encode';
    return 'decimate';
  };
  // The stage label stays the product's own wording; the library's internal name for the bar
  // becomes the detail line, where it is useful rather than a replacement for the Chinese label.
  const LABEL = { decimate: '生成 LOD', partition: '划分 LOD 空间', errors: '评估 LOD 图像误差', encode: '压缩 SOG', voxel: '生成官方体素' };
  // The level index rides on the decimation headline rather than the detail line: the official library
  // emits a bar tick every few hundred milliseconds and each of those replaces the detail, so a level
  // note there is only ever visible for an instant. Both are 0 until the source header is read.
  const stageLabel = (phase) => (phase === 'decimate' && plannedLevels > 0 && currentLevel > 0)
    ? `${LABEL.decimate}（第 ${currentLevel} 层 / 共 ${plannedLevels} 层）` : LABEL[phase];
  const report = (name, fraction, detail) => {
    phase = phaseOf(name);
    const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    send({ type: 'progress', phase, stage: stageLabel(phase), detail: detail ?? name, fraction: levelSpan < 1 ? levelBase + value * levelSpan : value });
  };
  logger.setRenderer({ handle(event) {
    if (event.kind === 'scopeStart') {
      stage('scope', { name: event.name, total: event.total ?? null });
      if (phaseOf(event.name) === 'encode' && event.index && event.total) report(event.name, (event.index - 1) / event.total, `编码单元 ${event.index - 1} / ${event.total}`);
    }
    if (event.kind === 'scopeEnd' && (event.name === 'env' || /^[0-9]+_[0-9]+$/.test(event.name)) && event.index && event.total) {
      report(event.name, event.index / event.total, `编码单元 ${event.index} / ${event.total}`);
    }
    if ((event.kind === 'barTick' || event.kind === 'barEnd') && event.total > 0) {
      report(event.name, event.current / event.total, `${event.current.toLocaleString()} / ${event.total.toLocaleString()}`);
    }
    if (event.kind === 'message') send({ type: 'log', event: 'conversion.official.message', data: { level: event.level, text: event.text } });
  } });

  report('启动 GPU', 0);
  window.navigator.gpu = create([]);
  let device = new (await import('playcanvas')).WebgpuGraphicsDevice(document.createElement('canvas'),
    { antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  await device.createDevice();
  // The official operations take an optional device and fall back to CPU without one
  // ("Optional GPU device factory; CPU fallback without it" in decimate-source.ts). That is the
  // whole recovery story: a lost device is dropped, never recreated, and the work is redone on the
  // CPU. Omitting the key rather than returning null is what selects the CPU path.
  const gpuOpts = () => (device ? { createDevice: () => device } : {});
  const adapter = device.gpuAdapter?.info;
  stage('gpu.ready', { deviceType: device.deviceType, adapter: { vendor: adapter?.vendor, architecture: adapter?.architecture, description: adapter?.description } });

  const pool = createChunkDataPool({ chunkSize: 1024 * 1024, maxPooledBytes: 512 * 1024 * 1024 });
  const spill = { scratchDir: '.work', writeFs: workFs, readFs };

  const openInput = async (vname) => {
    const src = await readPly(await readFs.createSource(vname), pool);
    const stripped = await processSource(src, [{ kind: 'filterBands', value: shBands }], pool);
    return { meta: { ...stripped.meta, transform: new Transform().fromEulers(...rotation) }, read: (req) => stripped.read(req), close: () => stripped.close() };
  };

  report('读取 PLY 文件头', 0);
  const level0 = await openInput('foreground.ply');
  const totalPoints = level0.meta.numGaussians;
  if (!totalPoints) throw new Error('前景没有有效 Gaussian，无法创建场景。');
  // The level count follows the source size: the chain halves until the coarsest level lands strictly
  // below the largest preset's budget, which is what leaves the allocator room to upgrade nodes there.
  const lodLevels = planLodLevels(totalPoints, lodCeiling);
  const plannedCoarsest = coarsestAt(totalPoints, lodLevels);
  plannedLevels = lodLevels;
  stage('foreground', { points: totalPoints, shBands, lodLevels, lodCeiling, coarsestPoints: plannedCoarsest });
  // Defensive: only a source beyond ~2.9e11 points can exhaust MAX_LOD_LEVELS, but a scene that cannot
  // fit the ceiling must be recorded rather than shipped silently -- the viewer flags it as needing a
  // re-conversion.
  if (plannedCoarsest >= lodCeiling) stage('lod.ceilingUnreachable', { points: totalPoints, ceiling: lodCeiling, levels: lodLevels, coarsest: plannedCoarsest });

  const decimateLevel = async (source, target, level) => {
    const budget = 128 * 1024 * 1024;
    let out;
    try {
      out = await decimateSource(source, pool, { targetCount: target, memoryBudgetBytes: budget, spill, ...gpuOpts() });
    } catch (error) {
      if (!device) throw error;
      // Only reached while a device is held, and the CPU run below raises the same error if the
      // cause was not the device -- so this cannot quietly turn a real failure into a success.
      stage('gpu.fallback', { level, reason: String(error?.message ?? error) });
      try { device.destroy(); } catch {}
      device = null;
      out = await decimateSource(source, pool, { targetCount: target, memoryBudgetBytes: budget, spill });
    }
    await writeSource({ filename: `.work/level-${level}.ply`, outputFormat: 'ply', source: out, pool, options: {} }, workFs);
    return readPly(await readFs.createSource(`.work/level-${level}.ply`), pool);
  };
  const levels = [level0];
  const decimations = lodLevels - 1;
  for (let i = 1; i <= decimations; i++) {
    const previous = levels[i - 1].meta.numGaussians;
    const target = coarsestAt(totalPoints, i + 1);
    // A decimation that cannot shrink the level any further stops being a level. Giving up on the
    // ceiling is only allowed once the minimum chain exists, so small scenes keep the 3 levels --
    // and the 100/50/25 ratios -- they have today.
    if (i > MIN_LOD_LEVELS - 1 && target >= previous) { stage('lod.noProgress', { level: i + 1, of: lodLevels, points: previous, target }); break; }
    levelBase = (i - 1) / decimations; levelSpan = 1 / decimations; currentLevel = i + 1;
    report('生成 LOD', 0, `第 ${i + 1}/${lodLevels} 层 → ${target.toLocaleString()} 点`);
    const level = await decimateLevel(levels[i - 1], target, i);
    levels.push(level);
    stage('level.staged', { level: i, of: lodLevels, points: level.meta.numGaussians });
  }
  levelBase = 0; levelSpan = 1;
  const envSource = hasBackground ? await openInput('background.ply') : null;

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
  const fsPromises = await import('node:fs/promises');
  // The scene manifest's resource list accepts only lod/ and background/ paths, so the writer is
  // fenced the same way the in-renderer path fences it.
  const outFs = makeWriterFs(async (filename, bytes) => {
    if (!filename.startsWith('lod/')) throw new Error('官方 writer 输出路径异常。');
    if (filename === 'lod/lod-meta.json') {
      const meta = JSON.parse(await fsPromises.readFile(join(dir, filename), 'utf8'));
      const visit = (n) => { if (n.lods) leafCount++; n.children?.forEach(visit); };
      visit(meta.tree);
      streams.push({ file: filename, lodLevels: meta.lodLevels, pointCount: meta.counts[0], background: false });
      bounds = rotateBounds(plyQuat, { min: [...meta.tree.bound.min], max: [...meta.tree.bound.max] });
    }
    resources.push({ file: filename, bytes });
  });
  // The voxel is deliberately a separate writer: it must not enter the resource list, and its
  // metadata is checked here so a wrong resolution cannot be committed silently.
  const voxelFs = makeWriterFs(async (filename) => {
    if (filename === 'collision/scene.voxel.json') {
      const meta = JSON.parse(await fsPromises.readFile(join(dir, filename), 'utf8'));
      if (meta.version !== '1.1' || meta.voxelResolution !== cellSize) throw new Error('官方体素尺寸或格式与请求不一致。');
      voxelNodes = meta.nodeCount;
    }
  });

  report('chunking', 0);
  await writeLodSource({ filename: 'lod/lod-meta.json', mainSource: stackLods([bakeTransform(level0, Transform.PLY), ...levels.slice(1)]), envSource, iterations: 4, chunkCount: 512, chunkExtent: 16, chunkMin: 8, lodErrors: false, ...gpuOpts() }, outFs);
  stage('lodWrite.done', { leaves: leafCount, resources: resources.length });

  send({ type: 'progress', phase: 'voxel', stage: '生成官方体素', fraction: 0 });
  // writeVoxel uploads every point at 64 bytes; the storage-buffer binding cap (~2 GiB) means
  // >~33.5M points cannot fit, so voxelise the finest LOD level that does. Voxels only drive
  // collision, and that level comes from the official merge, so coverage is equivalent.
  if (!device) throw new Error('官方体素生成需要可用的 GPU，而本次转换的图形设备已丢失。请重新转换。');
  const voxelLimit = (device.limits?.maxStorageBufferBindingSize ?? 2147483644) * 0.9;
  const voxelLevel = levels.find(l => l.meta.numGaussians * 64 <= voxelLimit);
  if (!voxelLevel) throw new Error('最粗 LOD 层也超出体素 GPU 上限。');
  stage('voxel.input', { points: voxelLevel.meta.numGaussians, total: totalPoints });
  let geometry = await materializeToDataTable(bakeTransform(voxelLevel, Transform.IDENTITY), pool, new Set(['position', 'geometric']));
  await writeVoxel({ filename: 'collision/scene.voxel.json', dataTable: geometry, voxelResolution: cellSize, opacityCutoff: opts.opacity, createDevice: () => device }, voxelFs);
  geometry = null;
  stage('voxel.done', { nodes: voxelNodes });

  // Cover preview: the same 12k-point projection the in-renderer path produced, so the converted
  // scene still gets a real cover instead of a placeholder the user has to replace by hand.
  send({ type: 'progress', phase: 'voxel', stage: '生成首图与场景索引', fraction: 1 });
  stage('preview.start', { totalPoints });
  const preview = [];
  {
    const displayQuat = new Quat().setFromEulerAngles(...rotation);
    let randomState = 0x12345678;
    const sampleCount = Math.min(12000, totalPoints);
    const sampleIdx = new Uint32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; sampleIdx[i] = Math.floor((i + randomState / 2 ** 32) * totalPoints / sampleCount); }
    const layouts = level0.meta.layouts;
    for (let off = 0; off < sampleCount; off += opts.chunkSize) {
      const count = Math.min(opts.chunkSize, sampleCount - off);
      const pos = pool.acquire('position', layouts.position, count);
      const geo = pool.acquire('geometric', layouts.geometric, count);
      const color = level0.meta.availableLayers.has('color') ? pool.acquire('color', layouts.color, count) : undefined;
      try {
        await level0.read({ indices: sampleIdx, indexOffset: off, count, position: pos, geometric: geo, color });
        const p = pos.field('position'), o = geo.field('opacity'), c = color?.field('dc');
        for (let i = 0; i < count; i++) {
          const v = displayQuat.transformVector(new Vec3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
          preview.push([v.x, v.y, v.z, c ? c[i * 3] : 0, c ? c[i * 3 + 1] : 0, c ? c[i * 3 + 2] : 0, o[i]]);
        }
      } finally { pos.release(); geo.release(); color?.release(); }
    }
  }

  stage('preview.done', { points: preview.length });

  rmSync(join(dir, '.work'), { recursive: true, force: true });
  for (const fd of fds.values()) closeSync(fd);

  // WorkerQueue.destroy() is NOT called, and that is deliberate. It terminates the worker threads,
  // and a Node process whose event loop then drains exits 0 -- taking with it the continuation that
  // was going to send the manifest. Awaiting it has the same effect, and calling it without awaiting
  // does too: destroy() reaches its first await (Promise.allSettled on the outstanding set) before
  // run() returns, so its continuation is queued ahead of the manifest send and terminates the
  // threads first. The process exits moments later regardless, and that is what tears the threads
  // down. This was intermittently silent: it depends on whether anything was outstanding.
  const workers = { inline: WorkerQueue.isInline, maxWorkers: WorkerQueue.maxWorkers };
  // levels.length, not lodLevels: the no-progress guard can end the chain early, and the reported
  // count has to be the one that was actually written.
  const coarsestPoints = levels[levels.length - 1].meta.numGaussians;

  return { stats: { workers, lodLevels: levels.length, lodCeiling, coarsestPoints }, manifest: {
    format: 'portable-3dgs', version: 2, id, name, createdAt: new Date().toISOString(),
    cover: 'cover.png', collision: 'collision/scene.voxel.json', collisionFormat: 'playcanvas-voxel',
    bounds, camera: { position: [0, 1.4, 0], yaw: 0, pitch: 0 },
    streams, resources, leafCount, pointCount: totalPoints,
    sourceBytes: statSync(foreground).size + (hasBackground ? statSync(background).size : 0),
    conversion: { method: 'official-streamed-decimate-lod-sog', chunkSize: opts.chunkSize, sh: opts.sh, shBands, scale: opts.scale, rotation, lodCeiling }
  }, preview };
};

// The exit code must carry failure even if IPC is unavailable, so the parent cannot
// mistake a failed conversion for a completed one.
// The timer keeps the loop alive on purpose: exiting on an unref'd one is what discarded the
// manifest. The callback normally wins the race; this is the backstop.
const finish = code => setTimeout(() => process.exit(code), 2000);
readStdin()
  .then(job => run(job))
  .then(r => send({ type: 'manifest', manifest: r.manifest, preview: r.preview, stats: r.stats }, () => finish(0)))
  .catch(e => {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    stage('failed', { message, stack });
    send({ type: 'error', message, stack }, () => finish(1));
  });
