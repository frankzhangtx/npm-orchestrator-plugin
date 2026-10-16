import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync,statSync} from 'node:fs';
import {fixture} from './queue-fixture.mjs';
import {captureInstallationRestorePoint,sealInstallationSwitch,restoreInstallation} from '../dist/installer/restore.js';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function setup(){const f=fixture();f.queue.control('pause');
 mkdirSync(join(f.root,'.automation-plugin'));
 writeFileSync(join(f.root,'.automation-plugin/manifest.json'),JSON.stringify({files:[{path:'.opencode/agents/scheduled-coder.md'},{path:'automation/config.json'},{path:'opencode.json'}]}));
 return {...f,snapshot:join(f.base,'restore-point')};}
function switchFiles(f){
 const file=join(f.root,'.opencode/agents/scheduled-coder.md');writeFileSync(file,'candidate agent\n');chmodSync(file,0o700);
 writeFileSync(join(f.root,'automation/verification/new-helper.cjs'),'candidate helper\n');
 const history=join(f.root,'.automation-plugin/history/candidate.json');mkdirSync(join(f.root,'.automation-plugin/history'),{recursive:true});writeFileSync(history,'{}');
}
test('exact restoration removes candidate additions, preserves queue audit, and is idempotent',()=>{
 const f=setup();try{
  const file=join(f.root,'.opencode/agents/scheduled-coder.md'), original=readFileSync(file),mode=statSync(file).mode&0o777;
  captureInstallationRestorePoint(f.root,f.snapshot,['automation/verification/new-helper.cjs']);switchFiles(f);sealInstallationSwitch(f.snapshot);
  const audit=join(f.queue.storage.runtime,'trial-audit.json');writeFileSync(audit,'keep trial evidence');
  assert.equal(restoreInstallation(f.snapshot).state,'RESTORED');assert.deepEqual(readFileSync(file),original);assert.equal(statSync(file).mode&0o777,mode);
  assert.equal(existsSync(join(f.root,'automation/verification/new-helper.cjs')),false);
  assert.equal(existsSync(join(f.root,'.automation-plugin/history/candidate.json')),false);
  assert.equal(readFileSync(audit,'utf8'),'keep trial evidence');assert.equal(restoreInstallation(f.snapshot).state,'RESTORED');
 }finally{f.cleanup();}
});
test('unregistered edits or corrupted backup stop before any restoration write',()=>{
 const f=setup();try{
  const file=join(f.root,'.opencode/agents/scheduled-coder.md');captureInstallationRestorePoint(f.root,f.snapshot,[]);
  writeFileSync(file,'candidate');sealInstallationSwitch(f.snapshot);writeFileSync(file,'user edited candidate');
  assert.throws(()=>restoreInstallation(f.snapshot),/outside the sealed switch/);assert.equal(readFileSync(file,'utf8'),'user edited candidate');
  writeFileSync(file,'candidate');const point=read(join(f.snapshot,'snapshot.json'));
  writeFileSync(join(f.snapshot,'blobs',point.before['.opencode/agents/scheduled-coder.md'].sha256),'corrupt backup');
  assert.throws(()=>restoreInstallation(f.snapshot),/backup content changed/);assert.equal(readFileSync(file,'utf8'),'candidate');
 }finally{f.cleanup();}
});
test('interrupted restoration resumes only registered absent or partial original files',()=>{
 const f=setup();try{
  const path='.opencode/agents/scheduled-coder.md',file=join(f.root,path),original=readFileSync(file);
  captureInstallationRestorePoint(f.root,f.snapshot,[]);writeFileSync(file,'candidate');sealInstallationSwitch(f.snapshot);
  const transaction=join(f.snapshot,'transaction.json'),record=read(transaction);
  record.state='RESTORING';record.pendingPaths=[path];writeFileSync(transaction,JSON.stringify(record));
  writeFileSync(file,original.subarray(0,17));
  assert.equal(restoreInstallation(f.snapshot).state,'RESTORED');assert.deepEqual(readFileSync(file),original);
 }finally{f.cleanup();}
});
test('restoration requires paused idle queue and does not snapshot runtime task evidence',()=>{
 const f=setup();try{
  f.queue.control('resume');assert.throws(()=>captureInstallationRestorePoint(f.root,f.snapshot),/paused queue/);
  f.queue.control('pause');const point=captureInstallationRestorePoint(f.root,f.snapshot);
  assert.equal(point.paths.some(p=>p.includes('.git')),false);
  sealInstallationSwitch(f.snapshot);f.queue.control('resume');assert.throws(()=>restoreInstallation(f.snapshot),/paused queue/);
 }finally{f.cleanup();}
});
