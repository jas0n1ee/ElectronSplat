import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { ConversionProcess } = createRequire(import.meta.url)('../desktop/conversion-process.cjs');

function setup() {
  const children = [], messages = [], closed = [], errors = [];
  const manager = new ConversionProcess(() => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.signals = [];
    child.kill = signal => { child.signals.push(signal ?? 'SIGTERM'); return true; };
    children.push(child);
    return child;
  });
  const callbacks = { onMessage: m => messages.push(m), onClose: (...args) => closed.push(args), onOutput: () => {}, onError: e => errors.push(e) };
  return { manager, children, messages, closed, errors, start: token => manager.start('node', [], {}, token, callbacks) };
}

test('cancellation retains ownership until close and suppresses old events before the next job', async () => {
  const { manager, messages, closed, start } = setup();
  const old = start('first');
  let stopped = false;
  const stopping = manager.stop('first').then(() => { stopped = true; });
  const repeated = manager.stop('first');
  old.emit('message', { type: 'manifest' });
  old.emit('exit', null, 'SIGTERM');
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.throws(() => start('second'), /已有转换进程/);
  assert.deepEqual(old.signals, ['SIGTERM']);
  assert.deepEqual(messages, []);
  old.emit('close', null, 'SIGTERM');
  await Promise.all([stopping, repeated]);
  const current = start('second');
  old.emit('message', { type: 'error' });
  old.emit('error', new Error('late error'));
  old.emit('close', 0, null);
  await manager.stop('first');
  assert.equal(manager.active.child, current);
  assert.deepEqual(current.signals, []);
  current.emit('message', { type: 'manifest' });
  current.emit('close', 0, null);
  assert.deepEqual(messages, [{ type: 'manifest' }]);
  assert.deepEqual(closed, [[null, 'SIGTERM', true], [0, null, false]]);
});

test('shutdown waits for child close before transaction cleanup', async () => {
  const { manager, start } = setup();
  const child = start('job');
  let removed = false;
  const cleanup = manager.stop().then(() => { removed = true; });
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(removed, false);
  child.emit('close', 0, null);
  await cleanup;
  assert.equal(removed, true);
  assert.equal(manager.active, null);
});

test('spawn failure is reported and close releases ownership', async () => {
  const { manager, errors, start } = setup();
  const child = start('failed');
  child.emit('error', new Error('ENOENT'));
  assert.equal(errors[0].message, 'ENOENT');
  const stopping = manager.stop('failed');
  child.emit('close', -2, null);
  await stopping;
  assert.equal(manager.active, null);
});
