import assert from 'node:assert/strict';
import test from 'node:test';
import {reserveModelCall, completeModelCall} from '../dist/queue/model-ledger.js';
const policy={version:1,maxContinuations:1,maxCalls:4,maxElapsedMs:10000,stepLimit:64};
const input={binding:'approved',checkpoint:'original',role:'scheduled-coder',cycle:0,attempt:0,continuationOf:null,now:1000,deadline:20000};
const result={reason:'STEP_BUDGET',steps:64,exitCode:null,signal:'SIGTERM',processesExited:true,sessionID:'s',startedAt:1001,endedAt:2000};
const copy=x=>JSON.parse(JSON.stringify(x));
function stopped(reason='STEP_BUDGET') {
 const {ledger}=reserveModelCall(undefined,policy,input);
 completeModelCall(ledger,1,{...result,reason},'sealed');return ledger;
}
test('durable model reservation survives restart without resetting time or counts',()=>{
 const ledger=stopped();
 const resumed=reserveModelCall(copy(ledger),policy,{...input,checkpoint:'sealed',continuationOf:1,now:3000,deadline:99999});
 assert.equal(resumed.ledger.deadline,11000);assert.equal(resumed.ledger.continuations,1);assert.equal(resumed.call.id,2);
 completeModelCall(resumed.ledger,2,{...result,startedAt:3001,endedAt:4000},'sealed2');
 assert.throws(()=>reserveModelCall(copy(resumed.ledger),policy,{...input,checkpoint:'sealed2',continuationOf:2,now:5000}),/continuation budget/);
 assert.throws(()=>reserveModelCall(copy(ledger),policy,{...input,cycle:1,now:11000}),/elapsed budget/);
});
test('unknown ownership, drift, forged continuation and replay are rejected',()=>{
 const {ledger}=reserveModelCall(undefined,policy,input);
 assert.throws(()=>reserveModelCall(copy(ledger),policy,{...input,cycle:1}),/ownership recovery/);
 const sealed=stopped();
 assert.throws(()=>reserveModelCall(copy(sealed),policy,input),/already consumed/);
 assert.throws(()=>reserveModelCall(copy(sealed),policy,{...input,binding:'changed',continuationOf:1}),/binding/);
 assert.throws(()=>reserveModelCall(copy(sealed),policy,{...input,checkpoint:'changed',continuationOf:1}),/checkpoint/);
 for(const reason of ['EXITED','INVALID_EVENTS','DEADLINE','HOST_ERROR','OUTPUT_LIMIT'])
  assert.throws(()=>reserveModelCall(stopped(reason),policy,{...input,checkpoint:'sealed',continuationOf:1}),/owned coder budget stop/);
 assert.throws(()=>completeModelCall(sealed,1,result,'sealed'),/already recorded/);
});
test('coder and reviewer share cumulative model-call budget across cycles',()=>{
 const p={...policy,maxCalls:2};const ledger=stopped();
 reserveModelCall(ledger,p,{...input,role:'scheduled-reviewer',now:3000});
 completeModelCall(ledger,2,{...result,reason:'EXITED',startedAt:3001,endedAt:4000},'reviewed');
 assert.throws(()=>reserveModelCall(copy(ledger),p,{...input,cycle:1,now:5000}),/call budget/);
});
