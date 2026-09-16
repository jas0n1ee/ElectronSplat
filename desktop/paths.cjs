const path = require('node:path');

// Scene data is shared across OS distributions; Chromium profiles stay local.
function desktopPaths({ platform, execPath, isPackaged, developmentRoot, override }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const appRoot = isPackaged
    ? (platform === 'darwin' ? p.resolve(p.dirname(execPath), '../../..') : p.dirname(execPath))
    : p.resolve(developmentRoot);
  const dataRoot = override ? p.resolve(override) : appRoot;
  const shared = isPackaged && !override && platform !== 'darwin';
  return {
    dataRoot,
    sceneDataRoot: shared ? p.dirname(appRoot) : dataRoot,
    legacySceneDataRoots: shared ? [appRoot] : []
  };
}

module.exports = { desktopPaths };
