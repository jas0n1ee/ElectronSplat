// Manual harness (not part of `npm test`): runs the real conversion child process and needs a GPU.
//
// The whole point of planning levels from the ceiling is that a large scene gets more of them, and no
// checked-in fixture is anywhere near the 9,000,000-point ceiling. So this drives the real child with
// a deliberately tiny ceiling instead: the 8,192-point fixture must then produce five levels, which
// exercises the multi-level path (plan, loop, staged PLYs, official writer, manifest) end to end.
//
//   node tests/conversion-levels.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareFixtures } from './fixtures.mjs';

const root = resolve('test-results/conversion-levels');
const staging = join(root, 'staging');
const CEILING = 1000;
await rm(root, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await prepareFixtures();

const payload = {
  dir: staging, id: 'scene-levels', name: 'levels',
  foreground: resolve('test-results/fixtures/render.ply'),
  background: resolve('test-results/fixtures/background.ply'),
  options: { scale: 1, rotation: [90, 0, 180], cellSize: 0.5, shBands: 0, chunkSize: 4096, lodCeiling: CEILING }
};
const child = spawn(process.execPath, ['--max-old-space-size=4096', 'desktop/convert-child.mjs'], {
  cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe', 'ipc']
});
const messages = [];
child.on('message', message => messages.push(message));
child.stdout.on('data', data => process.stdout.write(`[child] ${data}`));
child.stderr.on('data', data => process.stderr.write(`[child] ${data}`));
const exited = new Promise((resolveExit, rejectExit) => { child.on('error', rejectExit); child.on('exit', code => resolveExit(code)); });
child.stdin.end(JSON.stringify(payload));
const code = await exited;

const manifest = messages.find(message => message.type === 'manifest')?.manifest;
if (!manifest) {
  const failure = messages.find(message => message.type === 'error');
  assert.fail(`child produced no manifest (exit ${code}): ${failure ? failure.message : 'no error message'}`);
}
assert.equal(code, 0, 'child must exit cleanly');
assert.equal(manifest.streams[0].lodLevels, 5, 'manifest level count');

const meta = JSON.parse(await readFile(join(staging, 'lod', 'lod-meta.json'), 'utf8'));
assert.equal(meta.lodLevels, 5);
// The fixture decimates exactly onto its targets, so the whole chain is predictable: level 4 is the
// first that lands strictly below the 1000-point ceiling.
assert.deepEqual(meta.counts, [8192, 4096, 2048, 1024, 512]);
// `filenames` is discovery order, not level order.
assert.deepEqual([...meta.filenames].sort(), ['0_0/meta.json', '1_0/meta.json', '2_0/meta.json', '3_0/meta.json', '4_0/meta.json']);

// The level index has to reach the UI on the decimation *stage* line: the official library emits a bar
// tick every few hundred milliseconds and each one replaces the detail line.
const progress = messages.filter(message => message.type === 'progress');
for (const level of [2, 3, 4, 5]) {
  assert.ok(progress.some(message => message.stage === `生成 LOD（第 ${level} 层 / 共 5 层）`),
    `decimation stage must name level ${level} of 5: ${[...new Set(progress.map(m => m.stage))].join(' | ')}`);
}
const stages = messages.filter(message => message.type === 'log').map(message => ({ stage: message.event.slice(6), data: message.data }));
const staged = stages.filter(entry => entry.stage === 'level.staged');
assert.deepEqual(staged.map(entry => entry.data.level), [1, 2, 3, 4], 'every planned decimation ran');
assert.ok(staged.every(entry => entry.data.of === 5), 'each level reports the planned count');
assert.ok(!stages.some(entry => entry.stage === 'lod.noProgress'), 'the chain must not stop early');
assert.equal(stages.find(entry => entry.stage === 'foreground').data.lodLevels, 5);
console.log(`PASS 5 levels from a 8,192-point fixture with ceiling ${CEILING}: ${meta.counts.join(' / ')}`);
