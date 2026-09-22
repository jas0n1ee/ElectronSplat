const fs = require('node:fs');
const path = require('node:path');

// fix branch only: every log line is appended to disk synchronously. Even in the instant before a whole-machine
// hang or a power loss, the lines already written survive, and the last line of the file is the stage the hang happened in.
class FileLog {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.path = path.join(dir, `portable-log-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    this.count = 0;
  }
  write(level, event, data) {
    const normalized = ['info', 'warn', 'error'].includes(level) ? level : 'info';
    let line;
    try {
      line = JSON.stringify({ time: new Date().toISOString(), level: normalized, event: String(event).slice(0, 120), data });
    } catch {
      line = JSON.stringify({ time: new Date().toISOString(), level: normalized, event: String(event).slice(0, 120), data: String(data) });
    }
    if (line.length > 8192) line = line.slice(0, 8192);
    try {
      fs.appendFileSync(this.path, line + '\n');
      this.count++;
    } catch (error) {
      console.error('[portable.filelog]', error.message);
    }
  }
}

module.exports = { FileLog };
