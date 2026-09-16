const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`portable:${name}`, ...args);
contextBridge.exposeInMainWorld('portableDesktop', {
  setQueueLength: count => invoke('queue-length', count),
  scan: () => invoke('scan'),
  info: () => invoke('info'),
  openSceneFolder: token => invoke('open-scene-folder', token),
  renameScene: (token, name) => invoke('rename-scene', token, name),
  deleteScene: token => invoke('delete-scene', token),
  readWork: (token, path, start, end) => invoke('read-work', token, path, start, end),
  begin: id => invoke('begin', id),
  write: (token, path, bytes) => invoke('write', token, path, bytes),
  commit: (token, manifest) => invoke('commit', token, manifest),
  abort: token => invoke('abort', token),
  saveCover: (token, bytes, pose) => invoke('save-cover', token, bytes, pose)
});
