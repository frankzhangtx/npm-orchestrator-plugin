import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {fixture} from './queue-fixture.mjs';
import {recordRestoration,assertRestorationOwner,assertRestorationScope,pendingRestoration} from '../dist/trial/restoration.js';
test('pending restoration survives queue cleanup and rejects another validation baseline',()=>{
 const f=fixture();try{
  const owner={version:1,repository:f.root,runId:'first',taskKey:'TASK-FIRST@1',specificationSha256:'a'.repeat(64),candidateSha256:'b'.repeat(64),evidence:join(f.base,'trial'),originalBranch:'main',originalHead:'original',state:'PENDING'};
  recordRestoration(f.queue.storage.runtime,owner);
  f.queue.storage.transaction(d=>{delete d.runScope;});
  assert.throws(()=>assertRestorationOwner(f.queue.storage.runtime,'c'.repeat(64)),/Unfinished trial restoration/);
  assert.throws(()=>assertRestorationScope(f.queue.storage.runtime,'new',['TASK-NEW@1']),/new validation baseline/);
  assert.throws(()=>assertRestorationScope(f.queue.storage.runtime,'first',['TASK-OTHER@1']),/new validation baseline/);
  assertRestorationOwner(f.queue.storage.runtime,owner.specificationSha256);
  assertRestorationScope(f.queue.storage.runtime,'first',['TASK-FIRST@1']);
  recordRestoration(f.queue.storage.runtime,{...owner,state:'VERIFIED'});
  assert.equal(pendingRestoration(f.queue.storage.runtime),null);
 }finally{f.cleanup();}
});
