const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Library } = require('./library.cjs');
const { safePath } = require('./manifest.cjs');
const { desktopPaths } = require('./paths.cjs');

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
const assets = new Set(['index.html', 'assets/app.js', 'assets/converter.js', 'assets/styles.css', 'assets/splat-worker.mjs']);
const mime = { '.mjs':'text/javascript; charset=utf-8', '.webp':'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
let window, quitting = false, queueLength = 0;

app.whenReady().then(async () => {
  await library.init();
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
  handle('read-work', (token, file, start, end) => library.readWork(token, file, start, end));
  handle('begin', id => library.begin(id));
  handle('write', (token, file, data) => library.write(token, file, data));
  handle('commit', (token, manifest) => library.commit(token, manifest));
  handle('abort', token => library.abort(token));
  handle('save-cover', (token, data, pose) => library.saveCover(token, data, pose));
  const createWindow = () => {
    window = new BrowserWindow({ width: 1360, height: 900, minWidth: 860, minHeight: 600, backgroundColor: '#111c15', title: 'Portable · 3DGS Viewer', icon: path.join(uiRoot,'assets/app-icon.png'), show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { const target = new URL(url); if (target.protocol !== 'portable:' || target.host !== 'app' || target.pathname !== '/index.html') event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window.webContents && ['pointerLock', 'fullscreen'].includes(permission)));
    window.webContents.session.on('will-download', (_event, item) => item.setSaveDialogOptions({ defaultPath: path.join(dataRoot, item.getFilename()) }));
    window.webContents.on('render-process-gone', (_event, details) => {
      queueLength = 0;
      console.error('[portable.renderer]', details);
      void library.run(() => library.abort());
      dialog.showErrorBox('Portable 页面异常退出', '未完成的转换已取消。请重新打开应用，完整保存的场景仍在 scenes 文件夹中。');
    });
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
      if (!library.transaction && !queueLength) return;
      const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['继续转换', '取消任务并退出'], defaultId: 0, cancelId: 0, message: '转换队列尚未完成，是否退出？', detail: `尚有 ${Math.max(queueLength, library.transaction ? 1 : 0)} 个任务。退出将取消当前转换并清空等待队列，已完成的场景会保留。` });
      if (choice === 0) event.preventDefault();
    });
    void window.loadURL('portable://app/index.html');
  };
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(e => { dialog.showErrorBox('Portable 无法启动', `${e.message}\n请将应用放在可写的文件夹中。`); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !library.transaction) return;
  event.preventDefault();
  // The window close handler owns the user's choice; only clean after it closes.
  if (BrowserWindow.getAllWindows().length) { window.close(); return; }
  quitting = true;
  void library.run(() => library.abort()).finally(() => app.quit());
});
