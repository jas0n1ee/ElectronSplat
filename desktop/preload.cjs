const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`portable:${name}`, ...args);
contextBridge.exposeInMainWorld('portableDesktop', {
  setQueueLength: count => invoke('queue-length', count),
  scan: () => invoke('scan'),
  info: () => invoke('info'),
  openSceneFolder: token => invoke('open-scene-folder', token),
  renameScene: (token, name) => invoke('rename-scene', token, name),
  deleteScene: token => invoke('delete-scene', token),
  begin: id => invoke('begin', id),
  write: (token, path, bytes) => invoke('write', token, path, bytes),
  commit: (token, manifest) => invoke('commit', token, manifest),
  abort: token => invoke('abort', token),
  saveCover: (token, bytes, pose) => invoke('save-cover', token, bytes, pose),
  // Child-process conversion. The renderer only needs a real path for a picked File, the ability
  // to start/cancel the child, and the message stream coming back from it.
  pathForFile: file => webUtils.getPathForFile(file),
  runConversion: payload => invoke('run-child', payload),
  cancelConversion: token => invoke('cancel-child', token),
  onConversionEvent: cb => ipcRenderer.on('portable:conversion-event', (_event, message) => cb(message)),
  // fix branch only: renderer logs land on disk in real time, see desktop/filelog.cjs.
  logLine: entry => ipcRenderer.send('portable:log', entry)
});
