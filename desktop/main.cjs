const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const { Library } = require('./library.cjs');
const { safePath } = require('./manifest.cjs');
const { desktopPaths } = require('./paths.cjs');
const { ConversionProcess } = require('./conversion-process.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'portable', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const override = process.argv.find(a => a.startsWith('--data-dir='))?.slice(11);
const { dataRoot, sceneDataRoot, legacySceneDataRoots } = desktopPaths({
  platform: process.platform, execPath: process.execPath, isPackaged: app.isPackaged,
  developmentRoot: path.resolve(__dirname, '../../../portable'), override
});
// Keep Chromium caches and settings with the portable application as well.
app.setPath('userData', path.join(dataRoot, '.portable-profile'));
app.setPath('sessionData', path.join(dataRoot, '.portable-profile'));
const library = new Library(sceneDataRoot, legacySceneDataRoots);
const uiRoot = path.join(__dirname, '../ui');
const assets = new Set(['index.html', 'assets/app.js', 'assets/styles.css', 'assets/app-icon.png']);
const mime = { '.mjs':'text/javascript; charset=utf-8', '.webp':'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
let window, quitting = false, queueLength = 0;

// Conversion runs in an official Node child process, and there is no other path. Electron's own JS
// runtimes cannot host it: the V8 memory cage forbids the external ArrayBuffers dawn.node needs
// ("External buffers are not allowed"), and utilityProcess does not survive startup on at least one
// machine this ships to. A packaged build carries the runtime beside its resources; a dev run uses
// the node on PATH, which is there by construction because npm start needs it.
const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
const nodeRuntime = app.isPackaged ? path.join(process.resourcesPath, 'node', nodeBin) : 'node';
const conversion = new ConversionProcess();
let quitCleanup;

app.whenReady().then(async () => {
  await library.init();
  // A packaged build without its runtime cannot convert anything, and saying so once beats every
  // conversion failing with a spawn error later. tests/platform-portability.mjs asserts the runtime
  // is present, so reaching this means the install itself is damaged.
  if (app.isPackaged && !require('node:fs').existsSync(nodeRuntime)) {
    dialog.showErrorBox('ElectronSplat 缺少转换运行时', `内置的 Node 运行时未找到：\n${nodeRuntime}\n\n安装包不完整，请重新解压或重新安装。`);
    app.exit(1);
    return;
  }
  protocol.handle('portable', async request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      const relative = safePath(decodeURIComponent(url.pathname.slice(1)));
      let file;
      if (relative.startsWith('scene/')) {
        const [, token, ...parts] = relative.split('/');
        file = await library.resource(token, parts.join('/'));
      } else {
        if (!assets.has(relative)) return new Response('Not found', { status: 404 });
        file = path.join(uiRoot, relative);
      }
      const response = await net.fetch(pathToFileURL(file).href);
      return new Response(response.body, { status: response.status, headers: {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      } });
    } catch (e) {
      console.error('[portable.resource]', e.message);
      return new Response('Local resource unavailable', { status: 404 });
    }
  });
  const handle = (name, fn, serial = true) => ipcMain.handle(`portable:${name}`, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith('portable://app/index.html')) throw new Error('无效的本地请求。');
    return serial ? library.run(() => fn(...args), name) : fn(...args);
  });
  handle('queue-length', count => { if (!Number.isSafeInteger(count) || count < 0 || count > 100000) throw new Error('无效的队列长度。'); queueLength = count; }, false);
  handle('scan', () => library.scan());
  handle('info', () => ({ version: app.getVersion(), build:require('../package.json').buildId, platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, scenesDirectory: library.root, sceneScanDirectories: library.scanRoots, gpu: app.getGPUFeatureStatus(), diskActivity:library.activity() }), false);
  // Opening the OS file manager may remain pending; it must never hold the disk transaction queue.
  handle('open-scene-folder', async token => { const dir = await library.run(() => library.sceneDirectory(token), 'scene-directory'); const error = await shell.openPath(dir); if (error) throw new Error(error); }, false);
  handle('rename-scene', (token, name) => library.renameScene(token, name));
  handle('delete-scene', async token => {
    const dir = await library.sceneDirectory(token), record = library.records.get(token);
    const { response } = await dialog.showMessageBox(window, { type:'warning', buttons:['取消','永久删除'], defaultId:0, cancelId:0,
      message:`永久删除“${record.manifest.name}”？`, detail:`将删除此场景的数据文件夹及其中所有文件，无法撤销。\n\n${dir}` });
    if (response !== 1) return false;
    await library.deleteScene(token);
    return true;
  });
  handle('begin', id => library.begin(id));
  handle('write', (token, file, data) => library.write(token, file, data));
  handle('commit', (token, manifest) => library.commit(token, manifest));
  handle('abort', async token => { await conversion.stop(token); return library.abort(token); });
  handle('save-cover', (token, data, pose) => library.saveCover(token, data, pose));
  const createWindow = () => {
    window = new BrowserWindow({ width: 1360, height: 900, minWidth: 860, minHeight: 600, backgroundColor: '#111c15', title: 'ElectronSplat · 3DGS Viewer', icon: path.join(uiRoot,'assets/app-icon.png'), show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { const target = new URL(url); if (target.protocol !== 'portable:' || target.host !== 'app' || target.pathname !== '/index.html') event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window.webContents && ['pointerLock', 'fullscreen'].includes(permission)));
    window.webContents.session.on('will-download', (_event, item) => item.setSaveDialogOptions({ defaultPath: path.join(dataRoot, item.getFilename()) }));
    window.webContents.on('render-process-gone', (_event, details) => {
      queueLength = 0;
      console.error('[portable.renderer]', details);
      void library.run(async () => { await conversion.stop(); await library.abort(); }).catch(error => console.error('[portable.cleanup]', error));
      dialog.showErrorBox('ElectronSplat 页面异常退出', '未完成的转换已取消。请重新打开应用，完整保存的场景仍在 scenes 文件夹中。');
    });
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
      if (!library.transaction && !queueLength && !conversion.active) return;
      const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['继续转换', '取消任务并退出'], defaultId: 0, cancelId: 0, message: '转换队列尚未完成，是否退出？', detail: `尚有 ${Math.max(queueLength, library.transaction ? 1 : 0)} 个任务。退出将取消当前转换并清空等待队列，已完成的场景会保留。` });
      if (choice === 0) event.preventDefault();
    });
    void window.loadURL('portable://app/index.html');
  };
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  createWindow();
  // Conversion in a child process. The child reads and writes the staging directory itself, so no
  // bytes cross IPC -- which also lifts the 128 MiB per-write cap that the in-renderer path needs.
  // Everything the renderer still owns is the transaction lifecycle: begin, cover, commit, abort.
  const childEntry = () => {
    const entry = path.join(__dirname, 'convert-child.mjs');
    const unpacked = entry.replace('app.asar', 'app.asar.unpacked');
    return require('node:fs').existsSync(unpacked) ? unpacked : entry;
  };
  handle('run-child', payload => {
    if (quitting || quitCleanup) throw new Error('应用正在退出，无法启动转换。');
    if (!payload || typeof payload !== 'object') throw new Error('转换参数无效。');
    const tx = library.tx(payload.token); // rejects a token that is not the live transaction
    const sender = window.webContents;
    const toRenderer = message => {
      if (sender.isDestroyed() || sender !== window?.webContents) return;
      try { sender.send('portable:conversion-event', message); }
      catch (error) { console.error('[portable.child.delivery]', error); }
    };
    const child = conversion.start(nodeRuntime, ['--max-old-space-size=24576', childEntry()], {
      // Deliberately not the staging directory. On Windows a process's current directory is an open
      // handle, and any handle inside the tree makes the commit's rename fail with EBUSY. The
      // writer's derived paths resolve against cwd wherever it is, and the child maps them back
      // into staging, so the working directory does not need to be there.
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    }, payload.token, {
      onMessage: toRenderer,
      onOutput: (level, data) => { if (level === 'warn') console.error('[portable.child]', String(data).slice(0, 2000)); },
      onError: error => { toRenderer({ type: 'error', message: `无法启动转换进程：${error.message}` }); },
      onClose: (code, signal, cancelled) => {
        if (!cancelled) toRenderer({ type: 'exit', code, signal });
      }
    });
    child.stdin.end(JSON.stringify({ ...payload, dir: tx.dir }));
    return { pid: child.pid };
  }, false);
  handle('cancel-child', async token => { await conversion.stop(token); return true; }, false);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(e => { dialog.showErrorBox('ElectronSplat 无法启动', `${e.message}\n请将应用放在可写的文件夹中。`); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  if (quitCleanup) { event.preventDefault(); return; }
  if (!library.transaction && !conversion.active && !queueLength) return;
  event.preventDefault();
  // The window close handler owns the user's choice; only clean after it closes.
  if (BrowserWindow.getAllWindows().length) { window.close(); return; }
  quitCleanup = library.run(async () => { await conversion.stop(); await library.abort(); });
  void quitCleanup.catch(error => console.error('[portable.cleanup]', error)).finally(() => { quitting = true; app.quit(); });
});
