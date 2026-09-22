import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Explicit inventory: splat-transform bundles some dependencies into dist/.
// Reading every required file is intentional: a missing notice fails the build.
export const licenseSources = [
  ['PlayCanvas Engine 2.22.2', 'node_modules/playcanvas/LICENSE'],
  ['SplatTransform 3.4.2', 'node_modules/@playcanvas/splat-transform/LICENSE'],
  ['SPZ / @adobe/spz 0.2.3 (distributed LICENSE)', 'node_modules/@adobe/spz/LICENSE'],
  ['SuperSplat Viewer collision sources (96f62515)', 'vendor/supersplat-viewer/LICENSE'],
  ['SuperSplat Viewer 1.31.2 (bundled by SplatTransform)', 'vendor/licenses/supersplat-viewer-package-LICENSE'],
  ['pathe 2.0.3 (bundled by SplatTransform)', 'vendor/licenses/pathe-LICENSE'],
  ['fzstd 0.1.1 (bundled by SplatTransform)', 'vendor/licenses/fzstd-LICENSE'],
  ['libwebp / libsharpyuv (WebP WASM)', 'vendor/libwebp-COPYING'],
  ['libwebp patent grant', 'vendor/licenses/libwebp-PATENTS'],
  ['zlib (SPZ WASM)', 'vendor/licenses/zlib-LICENSE'],
  ['Zstandard (SPZ WASM)', 'vendor/licenses/zstd-LICENSE'],
  ['Emscripten (WASM runtime)', 'vendor/licenses/emscripten-LICENSE'],
  ['musl (WASM C runtime)', 'vendor/licenses/musl-COPYRIGHT']
];

export async function writeAppLicenses(out) {
  const sections = [];
  for (const [name, source] of licenseSources) {
    const license = await readFile(source, 'utf8');
    if (!license.trim()) throw new Error(`Empty third-party license: ${source}`);
    sections.push(`${name}\n${'='.repeat(name.length)}\n${license}`);
  }
  await copyFile('LICENSE', join(out, 'LICENSE'));
  await copyFile('THIRD_PARTY_NOTICES.md', join(out, 'THIRD_PARTY_NOTICES.md'));
  await writeFile(join(out, 'THIRD-PARTY-LICENSES.txt'), sections.join('\n\n'));
  await copyFile('vendor/libwebp-COPYING', join(out, 'LIBWEBP-LICENSE.txt'));
}

export async function writeRuntimeLicenses(staged, mac) {
  const out = join(staged, mac ? 'ElectronSplat.app/Contents/Resources/licenses' : 'licenses');
  await mkdir(out, { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD-PARTY-LICENSES.txt', 'LIBWEBP-LICENSE.txt']) {
    await copyFile(join('.build/electron', file), join(out, file));
  }
  // Electron's notices live outside .app in the packager output. Keep a copy
  // inside the application so copying/zipping only .app retains all notices.
  await copyFile(join(staged, 'LICENSE'), join(out, 'ELECTRON-LICENSE.txt'));
  await copyFile(join(staged, 'LICENSES.chromium.html'), join(out, 'LICENSES.chromium.html'));
}
