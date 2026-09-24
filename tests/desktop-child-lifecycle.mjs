import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareFixtures } from './fixtures.mjs';

const root = resolve('test-results/desktop-child-lifecycle');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await prepareFixtures();
const executable = resolve(process.env.PORTABLE_TEST_EXECUTABLE ?? 'desktop-dist/ElectronSplat-darwin-arm64/ElectronSplat.app/Contents/MacOS/ElectronSplat');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const checks = [];
for (const mode of ['cancel-next', 'quit', 'renderer-crash']) {
  const data = join(root, mode);
  const app = await electron.launch({ executablePath: executable, chromiumSandbox: true, args: [`--data-dir=${data}`] });
  let closed = false;
  app.on('close', () => { closed = true; });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.portableDesktop);
    await app.evaluate(({ dialog }) => { dialog.showErrorBox = () => {}; dialog.showMessageBoxSync = () => 1; });
    const start = id => page.evaluate(async ({ id, foreground }) => {
      const token = await window.portableDesktop.begin(id);
      // lodCeiling is required by the child; without it the conversion dies immediately and this test
      // would still pass while no longer exercising a real child process.
      const result = await window.portableDesktop.runConversion({ token, id, name: id, foreground, options: { cellSize: 0.1, chunkSize: 65536, sh: 'sh0', scale: 1, rotation: [0, 0, 0], opacity: 0.1, lodCeiling: 9000000 } });
      return { token, pid: result.pid };
    }, { id, foreground: resolve('test-results/fixtures/render.ply') });
    const first = await start('scene-first');
    assert.ok(Number.isInteger(first.pid));
    if (mode === 'cancel-next') {
      await page.evaluate(async token => { await window.portableDesktop.cancelConversion(token); await window.portableDesktop.abort(token); }, first.token);
      assert.equal(alive(first.pid), false);
      const second = await start('scene-second');
      await page.evaluate(async token => { await window.portableDesktop.cancelConversion(token); await window.portableDesktop.abort(token); }, second.token);
      assert.equal(alive(second.pid), false);
    } else if (mode === 'quit') {
      await app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
      await expect.poll(() => closed, { timeout: 15000 }).toBe(true);
      assert.equal(alive(first.pid), false);
    } else {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
      await expect.poll(() => alive(first.pid), { timeout: 15000 }).toBe(false);
    }
    await expect.poll(async () => (await readdir(join(data, 'scenes'))).filter(name => name.startsWith('.converting-')), { timeout: 15000 }).toEqual([]);
    checks.push(mode);
  } finally { if (!closed) await app.close(); }
}
await writeFile(join(root, 'results.json'), JSON.stringify({ passed: true, checks }, null, 2));
console.log(`PASS child lifecycle: ${checks.join(', ')}`);
