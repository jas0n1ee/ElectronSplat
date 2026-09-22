import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {desktopPaths}=createRequire(import.meta.url)('../desktop/paths.cjs');

test('USB Win/Linux folders and root-level Mac app share one scene data root',()=>{
  for(const [platform,execPath,expected,dataRoot] of [
    ['win32','E:\\U 盘\\Win\\ElectronSplat.exe','E:\\U 盘','E:\\U 盘\\Win'],
    ['linux','/media/U 盘/Linux/ElectronSplat','/media/U 盘','/media/U 盘/Linux'],
    ['darwin','/Volumes/U 盘/ElectronSplat.app/Contents/MacOS/ElectronSplat','/Volumes/U 盘','/Volumes/U 盘']
  ]){
    const result=desktopPaths({platform,execPath,isPackaged:true});
    assert.equal(result.sceneDataRoot,expected);
    assert.equal(result.dataRoot,dataRoot);
    assert.deepEqual(result.legacySceneDataRoots,platform==='darwin'?[]:[dataRoot]);
  }
});

test('explicit data-dir and development runs remain isolated from parent scene directories',()=>{
  const result=desktopPaths({platform:'linux',execPath:'/usb/Linux/ElectronSplat',isPackaged:true,override:'/tmp/test isolated'});
  assert.deepEqual(result,{dataRoot:'/tmp/test isolated',sceneDataRoot:'/tmp/test isolated',legacySceneDataRoots:[]});
  const dev=desktopPaths({platform:'linux',execPath:'/node_modules/electron',isPackaged:false,developmentRoot:'/project/portable'});
  assert.equal(dev.sceneDataRoot,'/project/portable');assert.deepEqual(dev.legacySceneDataRoots,[]);
});
