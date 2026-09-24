import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditRuntimeLinks, copyRuntimeDirectory } from '../scripts/runtime-copy.mjs';

// Windows returns a symlink target with backslashes even when the link was created with a POSIX one
// (Node normalizes on read), so the expected target is compared in POSIX form: the product preserves
// whatever the bundle carried, and a macOS framework link is written POSIX.
const posixTarget=value=>value.split('\\').join('/');

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'portable-runtime-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const src=join(root,'build'),out=join(root,'USB 中文目录');
  const framework=join('Viewer.app','Contents','Frameworks','Example.framework');
  await mkdir(join(src,framework,'Versions','A'),{recursive:true});
  await writeFile(join(src,framework,'Versions','A','Example'),'runtime bytes');
  await symlink('A',join(src,framework,'Versions','Current'));
  await symlink('Versions/Current/Example',join(src,framework,'Example'));
  return{root,src,out,framework};
}

test('runtime copy remains readable after the build directory is removed and the app is moved',async t=>{
  const {root,src,out,framework}=await fixture(t);
  await copyRuntimeDirectory(src,out);
  assert.equal(await readlink(join(out,framework,'Versions','Current')),'A');
  assert.equal(posixTarget(await readlink(join(out,framework,'Example'))),'Versions/Current/Example');
  await rm(src,{recursive:true});
  const moved=join(root,'Another Mac');await rename(out,moved);
  assert.equal(await readFile(join(moved,framework,'Example'),'utf8'),'runtime bytes');
  assert.equal((await auditRuntimeLinks(moved)).length,2);
});

test('runtime update replaces old absolute links without touching their targets or user scenes',async t=>{
  const {root,src,out,framework}=await fixture(t);
  await cp(src,out,{recursive:true}); // Reproduce the former Node cp default.
  assert.ok((await readlink(join(out,framework,'Example'))).startsWith(root));
  await mkdir(join(out,'scenes'),{recursive:true});await writeFile(join(out,'scenes','keep'),'user data');
  await mkdir(join(out,'.portable-profile'));await writeFile(join(out,'.portable-profile','keep'),'user settings');
  await writeFile(join(out,'Viewer.app','obsolete'),'old runtime');
  await copyRuntimeDirectory(src,out);
  assert.equal(await readFile(join(src,framework,'Example'),'utf8'),'runtime bytes');
  assert.equal(posixTarget(await readlink(join(out,framework,'Example'))),'Versions/Current/Example');
  assert.equal(await readFile(join(out,'scenes','keep'),'utf8'),'user data');
  assert.equal(await readFile(join(out,'.portable-profile','keep'),'utf8'),'user settings');
  await assert.rejects(readFile(join(out,'Viewer.app','obsolete')));
});

test('runtime validation rejects absolute, dangling and escaping framework links',async t=>{
  const {root,src,out}=await fixture(t);
  await symlink(join(root,'missing'),join(src,'absolute'));
  await assert.rejects(copyRuntimeDirectory(src,out),/escapes/);
  await rm(join(src,'absolute'));await symlink('missing',join(src,'dangling'));
  await assert.rejects(copyRuntimeDirectory(src,out));
  await rm(join(src,'dangling'));await writeFile(join(root,'external'),'outside');await symlink('../external',join(src,'escape'));
  await assert.rejects(copyRuntimeDirectory(src,out),/escapes/);
});

test('replacing a top-level helper symlink does not overwrite the external file',async t=>{
  const {root,src,out}=await fixture(t);await mkdir(out);
  await writeFile(join(src,'chrome-sandbox'),'bundled helper');
  const external=join(root,'system-helper');await writeFile(external,'system helper');
  await symlink(external,join(out,'chrome-sandbox'));
  await copyRuntimeDirectory(src,out);
  assert.equal(await readFile(external,'utf8'),'system helper');
  assert.equal(await readFile(join(out,'chrome-sandbox'),'utf8'),'bundled helper');
});
