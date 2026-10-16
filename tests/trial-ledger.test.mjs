import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTrialLedger,trialBudget,recordTrialIntent,finishTrialIntent} from '../dist/trial/ledger.js';
import {atomicJson} from '../dist/queue/storage.js';
test('trial restart preserves execution and cleanup deadlines and rejects a changed specification',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orchestrator-trial-ledger-'));try{
  const ledger=openTrialLedger(dir,{request:'one task'},'a'.repeat(64),2000,3000,1000);
  assert.equal(openTrialLedger(dir,{request:'one task'},'a'.repeat(64),2000,3000,1500).startedAt,1000);
  assert.throws(()=>openTrialLedger(dir,{request:'two tasks'},'a'.repeat(64),2000,3000,1500),/binding/);
  assert.throws(()=>openTrialLedger(dir,{request:'one task'},'a'.repeat(64),2500,3500,1500),/binding/);
  assert.throws(()=>trialBudget(ledger,false,2000),/execution deadline/);trialBudget(ledger,true,2000);
  assert.throws(()=>trialBudget(ledger,true,3000),/cleanup deadline/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('an interrupted operation cannot be replayed as a fresh phase',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orchestrator-trial-intent-'));try{
  const now=Date.now(),spec={request:'one task'},ledger=openTrialLedger(dir,spec,'a'.repeat(64),now+10000,now+20000);
  recordTrialIntent(ledger,'PLANNED');atomicJson(join(dir,'trial.json'),ledger);
  const resumed=openTrialLedger(dir,spec,'a'.repeat(64),now+10000,now+20000);
  assert.throws(()=>recordTrialIntent(resumed,'PLANNED'),/Interrupted/);
  assert.throws(()=>finishTrialIntent(resumed,'INSTALLED'),/does not match/);
  finishTrialIntent(resumed,'PLANNED');assert.equal(resumed.intent,null);assert.equal(resumed.events.length,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
