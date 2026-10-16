import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {directoryIdentity,verifyDirectoryIdentity,restoreMissingPackageDirectory} from '../dist/installer/directory-identity.js';
test('missing original package restores from verified snapshot; changed caches are preserved',()=>{
 const root=mkdtempSync(join(tmpdir(),'orchestrator-package-backup-'));try{
  const backup=join(root,'backup'),target=join(root,'cache','package');mkdirSync(backup);writeFileSync(join(backup,'entry.js'),'original package bytes');
  const identity=directoryIdentity(backup);
  restoreMissingPackageDirectory(backup,target,identity,'trial-1');verifyDirectoryIdentity(target,identity);
  writeFileSync(join(target,'entry.js'),'user changed cache');
  assert.throws(()=>restoreMissingPackageDirectory(backup,target,identity,'trial-1'),/preserved identity/);
  assert.equal(readFileSync(join(target,'entry.js'),'utf8'),'user changed cache');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('staged original package copy recovers a recognized partial file without overwriting other data',()=>{
 const root=mkdtempSync(join(tmpdir(),'orchestrator-package-partial-'));try{
  const backup=join(root,'backup'),target=join(root,'package'),stage=target+'.restore-trial-1';mkdirSync(backup);writeFileSync(join(backup,'entry.js'),'original package bytes');
  const identity=directoryIdentity(backup);mkdirSync(stage);chmodSync(stage,identity.mode);writeFileSync(join(stage,'entry.js'),'original');
  restoreMissingPackageDirectory(backup,target,identity,'trial-1');verifyDirectoryIdentity(target,identity);
 }finally{rmSync(root,{recursive:true,force:true});}
});
