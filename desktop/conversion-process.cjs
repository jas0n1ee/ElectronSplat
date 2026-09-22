const { spawn } = require('node:child_process');

// A transaction owns its child until close, including the final IPC and stdio messages.
class ConversionProcess {
  constructor(spawnChild = spawn) { this.spawnChild = spawnChild; this.active = null; }

  start(command, args, options, token, callbacks) {
    if (this.active) throw new Error('已有转换进程在运行。');
    const child = this.spawnChild(command, args, options);
    const record = { child, token, cancelled: false, closed: null, timer: null };
    this.active = record;
    record.closed = new Promise(resolve => {
      child.once('close', (code, signal) => {
        clearTimeout(record.timer);
        try {
          if (this.active === record) {
            this.active = null;
            callbacks.onClose(code, signal, record.cancelled);
          }
        } finally { resolve(); }
      });
    });
    const current = () => this.active === record && !record.cancelled;
    child.on('message', message => { if (current()) callbacks.onMessage(message); });
    child.on('error', error => { if (current()) callbacks.onError(error); });
    child.stdout?.on('data', data => callbacks.onOutput('info', data));
    child.stderr?.on('data', data => callbacks.onOutput('warn', data));
    child.stdin.on('error', () => {});
    return child;
  }

  async stop(token) {
    const record = this.active;
    if (!record || (token !== undefined && token !== record.token)) return;
    if (!record.cancelled) {
      record.cancelled = true;
      record.child.kill();
      // A blocked native operation must not leave shutdown waiting indefinitely for SIGTERM.
      record.timer = setTimeout(() => record.child.kill('SIGKILL'), 5000);
      record.timer.unref();
    }
    await record.closed;
  }
}

module.exports = { ConversionProcess };
