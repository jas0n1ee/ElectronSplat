import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,cp,rename,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {promisify} from 'node:util';
const run=promisify(execFile),name='ElectronSplat-win32-x64',folder='Win';
// The packager staging directory contains runtime files only, never user data.
const staged=resolve('.build/packages',name),output=resolve('desktop-transfer');
await mkdir(output,{recursive:true});
const {version}=JSON.parse(await readFile('package.json','utf8'));
const archiveName=`ElectronSplat-${version}-win-x64.zip`;
const archive=join(output,archiveName),incoming=join(output,`.incoming-${randomUUID()}.zip`);
const tmp=await mkdtemp(join(tmpdir(),'portable-win-transfer-'));
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
async function files(root){
 const result=[];
 const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){
  const file=join(dir,entry.name);assert.ok(!entry.isSymbolicLink(),'Windows runtime must not need symlinks');
  if(entry.isDirectory())await walk(file);else result.push(relative(root,file));
 }};await walk(root);return result.sort();
}
try {
 const source=join(tmp,folder);await cp(staged,source,{recursive:true});
 assert.ok(!(await readdir(source)).some(n=>['scenes','.portable-profile','logs'].includes(n)));
 await mkdir(join(tmp,'scenes'));
 await cp('desktop-dist/scenes/README.txt',join(tmp,'scenes/README.txt'));
 const expected=await files(source);
 await run('zip',['-q','-r',incoming,folder,'scenes'],{cwd:tmp});
 const unpacked=join(tmp,'unpacked');await mkdir(unpacked);
 await run('unzip',['-q',incoming,'-d',unpacked]);
 const moved=join(unpacked,'Windows 中文 空格');await rename(join(unpacked,folder),moved);
 assert.deepEqual(await files(moved),expected);
 for(const file of expected)assert.equal(await digest(join(moved,file)),await digest(join(source,file)),file);
 assert.equal(await digest(join(unpacked,'scenes/README.txt')),await digest(join(tmp,'scenes/README.txt')));
 const sha256=await digest(incoming);await rename(incoming,archive);
 await writeFile(`${archive}.sha256`,`${sha256}  ${archiveName}\n`);
 const result={archive,sha256,bytes:(await stat(archive)).size,files:expected.length+1,allFilesMatch:true,layout:['Win/','scenes/'],relocatedResourcesReadable:true,nativeExecution:'Not run; requires Windows.'};
 await mkdir('test-results/platform-portability',{recursive:true});await writeFile('test-results/platform-portability/win-x64-transfer.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await rm(incoming,{force:true});await rm(tmp,{recursive:true,force:true});}
