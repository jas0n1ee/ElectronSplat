import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {FileLog}=createRequire(import.meta.url)('../desktop/filelog.cjs');

test('file log appends every entry synchronously as JSONL',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'filelog-'));
  const log=new FileLog(dir);
  assert.ok(log.path.startsWith(dir));
  assert.ok(log.path.endsWith('.jsonl'));
  log.write('info','test.event',{a:1});
  log.write('error','test.crash',{b:'x'});
  const lines=fs.readFileSync(log.path,'utf8').trim().split('\n');
  assert.equal(lines.length,2);
  const first=JSON.parse(lines[0]);
  assert.equal(first.level,'info');assert.equal(first.event,'test.event');assert.deepEqual(first.data,{a:1});assert.ok(first.time);
  assert.equal(JSON.parse(lines[1]).level,'error');
  assert.equal(log.count,2);
});

test('file log normalizes invalid levels, caps oversized lines and survives circular data',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'filelog-'));
  const log=new FileLog(dir);
  const circular={};circular.self=circular;
  log.write('verbose','test.circular',circular);
  log.write('info','test.oversized',{blob:'x'.repeat(20000)});
  const lines=fs.readFileSync(log.path,'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).level,'info');
  assert.equal(JSON.parse(lines[0]).data,'[object Object]');
  assert.ok(lines[1].length<=8192);
});
