const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { safePath, validateManifest, manifestPaths, validateLodMeta } = require('./manifest.cjs');

const pathsFor = manifestPaths;
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const sceneId = id => { if (typeof id !== 'string' || !/^scene-[a-z0-9-]{1,110}$/i.test(id)) throw new Error('场景 ID 无效。'); return id; };

class Library {
  constructor(root, additionalRoots = []) {
    this.root = path.resolve(root, 'scenes');
    this.scanRoots = [...new Set([this.root, ...additionalRoots.map(root => path.resolve(root, 'scenes'))])];
    this.records = new Map();
    this.transaction = null;
    this.queue = Promise.resolve();
    this.activeOperation = null; this.queuedOperations = 0;
  }
  // Disk writes and scans cannot race a commit or cancellation.
  run(fn, name = 'disk-operation') {
    this.queuedOperations++;
    const result = this.queue.then(async () => {
      this.queuedOperations--; this.activeOperation = {name,startedAt:Date.now()};
      try { return await fn(); } finally { this.activeOperation = null; }
    });
    this.queue = result.catch(() => {}); return result;
  }
  activity() { return {active:this.activeOperation,queued:this.queuedOperations,converting:!!this.transaction}; }
  async init() { await fs.mkdir(this.root, { recursive: true }); this.root = await fs.realpath(this.root); }
  async checked(root, relative) {
    const file = await fs.realpath(path.join(root, safePath(relative)));
    if (!within(root, file)) throw new Error('场景文件指向目录外部。');
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('场景资源不是文件。');
    return { file, stat };
  }
  async inspect(dir) {
    const { file, stat } = await this.checked(dir, 'scene.json');
    if (stat.size > 16 * 1024 ** 2) throw new Error('scene.json 超过 16 MiB。');
    const manifest = validateManifest(JSON.parse(await fs.readFile(file, 'utf8')));
    const directoryStat = await fs.stat(dir);
    const directoryIdentity = `${directoryStat.dev}:${directoryStat.ino}:${directoryStat.birthtimeMs}`;
    const sizes = {}, fingerprint = [directoryIdentity,stat.mtimeMs];
    for (const relative of pathsFor(manifest)) {
      const resource = await this.checked(dir, relative);
      sizes[relative] = resource.stat.size;
      fingerprint.push(relative, resource.stat.size, resource.stat.mtimeMs);
    }
    for (const resource of manifest.resources) {
      if (sizes[resource.file] !== resource.bytes) throw new Error(`文件尚未复制完整：${resource.file}`);
    }
    const token = createHash('sha256').update(dir).digest('hex').slice(0, 32);
    const revision=createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
    const cached=this.records.get(token);
    // Every file/path was rechecked above. Avoid reopening all the unchanged
    // SOG JSON files at each three-second library scan on USB storage.
    if(cached?.revision===revision)return {token,manifest,resourceSizes:sizes,revision,directoryIdentity};
    const json = async relative => {
      const {file,stat}=await this.checked(dir,relative);
      if(stat.size>16*1024**2)throw new Error('官方索引超过 16 MiB。');
      return JSON.parse(await fs.readFile(file,'utf8'));
    };
    const resolveResource=(base,relative)=>{
      const file=path.posix.join(path.posix.dirname(base),safePath(relative));
      if(!sizes[file])throw new Error(`官方索引引用了未登记的资源：${file}`);
      return file;
    };
    let leaves=0;
    for(const stream of manifest.streams) {
      const meta=validateLodMeta(await json(stream.file));
      if(meta.lodLevels!==stream.lodLevels||meta.counts[0]!==stream.pointCount)throw new Error('官方索引与场景点数不一致。');
      const counts=[];
      for(const filename of [...meta.filenames,...(meta.environment?[meta.environment]:[])]) {
        const file=resolveResource(stream.file,filename);
        if(file.endsWith('.sog'))throw new Error('当前转换格式应使用官方独立 SOG 贴图。');
        const sog=await json(file);
        if(sog.version!==2||!Number.isSafeInteger(sog.count)||sog.count<1||sog.count>0x7fffffff)throw new Error('官方 SOG 元数据无效。');
        counts.push(sog.count);
        for(const name of ['means','quats','scales','sh0',...(sog.shN?['shN']:[])]) {
          const textures=sog[name]?.files;
          if(!Array.isArray(textures)||!textures.length)throw new Error('官方 SOG 缺少贴图。');
          for(const texture of textures)if(!resolveResource(file,texture).endsWith('.webp'))throw new Error('SOG 贴图格式无效。');
        }
      }
      const visit=node=>{if(node.lods){leaves++;for(const lod of Object.values(node.lods))if(lod.offset+lod.count>counts[lod.file])throw new Error('LOD 点范围超过 SOG 点数。');}node.children?.forEach(visit);};
      visit(meta.tree);
    }
    if(leaves!==manifest.leafCount)throw new Error('LOD 空间节点合计不一致。');
    if (!sizes[manifest.cover] || !sizes[manifest.collision]) throw new Error('首图或碰撞文件为空。');
    return { token, manifest, resourceSizes: sizes, revision, directoryIdentity };
  }
  async scan() {
    const scenes = [], errors = [], records = new Map(), ids = new Set(), visited = new Set();
    for (const candidate of this.scanRoots) {
      let root, entries;
      try {
        root = await fs.realpath(candidate);
        if (visited.has(root)) continue;
        entries = await fs.readdir(root, { withFileTypes: true });
        visited.add(root);
      } catch (e) {
        if (e.code !== 'ENOENT') errors.push({ folder: candidate, message: e.message });
        continue;
      }
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          const dir = await fs.realpath(path.join(root, entry.name));
          if (path.dirname(dir) !== root) throw new Error('场景目录指向外部。');
          const record = await this.inspect(dir);
          if (ids.has(record.manifest.id)) throw new Error('重复场景 ID，已优先显示前一个扫描目录中的场景。');
          ids.add(record.manifest.id); scenes.push(record);
          records.set(record.token, { ...record, dir, root, paths: new Set(pathsFor(record.manifest)) });
        } catch (e) { errors.push({ folder: path.join(candidate, entry.name), message: e.message }); }
      }
    }
    this.records = records;
    return { scenes, errors, directory: this.root, directories: this.scanRoots };
  }
  async resource(token, relative) {
    const record = this.records.get(token);
    if (!record || !record.paths.has(safePath(relative))) throw new Error('未登记的场景资源。');
    // Re-check after copies/replacements, including a scene directory changed to a symlink.
    const dir = await this.sceneDirectory(token);
    return (await this.checked(dir, relative)).file;
  }
  async sceneDirectory(token) {
    const record = this.records.get(token);
    if (!record) throw new Error('场景已移除，请刷新场景库。');
    const dir = record.dir, stat = await fs.lstat(dir);
    if (path.dirname(dir) !== record.root || path.basename(dir).startsWith('.') || !stat.isDirectory() || stat.isSymbolicLink()
      || await fs.realpath(dir) !== dir || `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== record.directoryIdentity) throw new Error('场景目录已变化，请刷新场景库。');
    return dir;
  }
  async renameScene(token, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('场景名称须为1–100个字符，不能包含控制字符。');
    const dir = await this.sceneDirectory(token), original = this.records.get(token);
    const {file,stat} = await this.checked(dir,'scene.json');
    if (stat.size > 16 * 1024 ** 2) throw new Error('scene.json 超过16 MiB。');
    const manifest = validateManifest(JSON.parse(await fs.readFile(file,'utf8')));
    if (manifest.id !== original.manifest.id) throw new Error('场景已变化，请刷新场景库。');
    manifest.name = name.trim();
    const temp = path.join(dir,`.scene-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp,JSON.stringify(manifest,null,2),{flag:'wx'});
      await this.sceneDirectory(token);
      await fs.rename(temp,path.join(dir,'scene.json'));
    } finally { await fs.rm(temp,{force:true}); }
    const record = await this.inspect(dir);
    this.records.set(token,{...record,dir,root:original.root,paths:new Set(pathsFor(record.manifest))});
    return record;
  }
  async deleteScene(token) {
    const dir = await this.sceneDirectory(token);
    // Node removes links inside this directory themselves, never their targets.
    await fs.rm(dir, { recursive:true });
    this.records.delete(token);
  }
  async readWork(token, relative, start, end) {
    const tx = this.tx(token); safePath(relative);
    const size = tx.workFiles.get(relative);
    if (size === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size || end-start > 8*1024**2) throw new Error('临时文件读取范围无效。');
    const {file,stat} = await this.checked(tx.dir,relative);
    if(stat.size !== size) throw new Error('临时文件已变化。');
    const handle = await fs.open(file,'r'), data = Buffer.alloc(end-start);
    try {
      let offset=0;
      while(offset<data.length) {
        const {bytesRead}=await handle.read(data,offset,data.length-offset,start+offset);
        if(!bytesRead) throw new Error('临时文件读取不完整。');
        offset+=bytesRead;
      }
      return data;
    } finally { await handle.close(); }
  }
  async begin(id) {
    if (this.transaction) throw new Error('已有转换正在保存。');
    sceneId(id);
    const dest = path.join(this.root, id);
    try { await fs.lstat(dest); throw new Error('场景目录已存在。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const token = randomUUID(), dir = await fs.mkdtemp(path.join(this.root, '.converting-'));
    this.transaction = { token, id, dir, dest, workFiles:new Map() };
    return token;
  }
  tx(token) { if (!this.transaction || this.transaction.token !== token) throw new Error('转换已取消或保存任务无效。'); return this.transaction; }
  data(bytes, max = 128 * 1024 ** 2) {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > max) throw new Error('写入数据大小无效。');
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  async write(token, relative, bytes) {
    const tx = this.tx(token); safePath(relative);
    if (relative === 'scene.json' || !(/^(lod|background)\/.+\.(json|webp|sog)$/.test(relative) || ['collision/scene.voxel.json','collision/scene.voxel.bin'].includes(relative) || relative === 'cover.png' || /^\.work\/(fg|bg)\/[0-2]\/\d+\.ply$/.test(relative))) throw new Error('不允许写入此文件。');
    const data = relative==='collision/scene.voxel.bin'&&bytes instanceof Uint8Array&&bytes.byteLength===0?Buffer.alloc(0):this.data(bytes), dest = path.join(tx.dir, relative), parent = path.dirname(dest);
    await fs.mkdir(parent, { recursive: true });
    if (!within(tx.dir, await fs.realpath(parent))) throw new Error('保存目录已变化。');
    await fs.writeFile(dest, data, { flag: 'wx' });
    if(relative.startsWith('.work/'))tx.workFiles.set(relative,data.length);
  }
  async commit(token, value) {
    const tx = this.tx(token), manifest = validateManifest(value);
    if (manifest.id !== tx.id || manifest.cover !== 'cover.png' || manifest.collision !== 'collision/scene.voxel.json') throw new Error('转换清单与保存任务不符。');
    const json = JSON.stringify(manifest, null, 2);
    if (Buffer.byteLength(json) > 16 * 1024 ** 2) throw new Error('场景清单过大。');
    await fs.writeFile(path.join(tx.dir, 'scene.json'), json, { flag: 'wx' });
    await this.inspect(tx.dir);
    await fs.rm(path.join(tx.dir,'.work'),{recursive:true,force:true});
    try { await fs.lstat(tx.dest); throw new Error('场景目录已存在，未覆盖。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.rename(tx.dir, tx.dest);
    this.transaction = null;
    const record = await this.inspect(tx.dest);
    this.records.set(record.token, { ...record, dir: tx.dest, root: this.root, paths: new Set(pathsFor(manifest)) });
    return record;
  }
  async abort(token) {
    if (!this.transaction || (token && this.transaction.token !== token)) return;
    const tx = this.transaction; this.transaction = null;
    await fs.rm(tx.dir, { recursive: true, force: true });
  }
  async saveCover(token, bytes, pose) {
    const dir = await this.sceneDirectory(token), original = this.records.get(token);
    const data = this.data(bytes, 32 * 1024 ** 2);
    if (!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('首图必须是 PNG。');
    const {file,stat} = await this.checked(dir,'scene.json');
    if(stat.size > 16*1024**2)throw new Error('场景配置过大。');
    const manifest = validateManifest(JSON.parse(await fs.readFile(file,'utf8')));
    if(manifest.id !== original.manifest.id)throw new Error('场景已变化，请刷新场景库。');
    const oldCover = manifest.cover;
    // Publish the image and its exact frame pose together with one manifest rename.
    // A failed write leaves the previous cover/pose pair intact.
    manifest.camera = pose;
    manifest.cameraSource = 'cover';
    manifest.cover = `cover-${randomUUID()}.png`;
    validateManifest(manifest);
    if(Math.abs(pose.pitch)>89)throw new Error('相机俯仰角无效。');
    const dest = path.join(dir,manifest.cover), temp = path.join(dir,`.scene-${randomUUID()}.tmp`);
    let published = false;
    try {
      await fs.writeFile(dest,data,{flag:'wx'});
      await fs.writeFile(temp,JSON.stringify(manifest,null,2),{flag:'wx'});
      await this.sceneDirectory(token);
      await fs.rename(temp,path.join(dir,'scene.json'));
      published = true;
    } finally {
      await fs.rm(temp,{force:true});
      if(!published)await fs.rm(dest,{force:true});
    }
    const record = await this.inspect(dir);
    this.records.set(token,{...record,dir,root:original.root,paths:new Set(pathsFor(record.manifest))});
    // Only remove our own generated thumbnails, never arbitrary scene resources.
    if(/^cover-[a-f0-9-]{36}\.png$/.test(oldCover))await fs.rm(path.join(dir,oldCover),{force:true}).catch(()=>{});
    return record;
  }
}
module.exports = { Library };
