import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,taskContract,run} from './queue-fixture.mjs';
import {validateContract,assertAuthorized} from '../dist/queue/queue.js';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function contract(f,id) {return {...taskContract(f,id),schemaVersion:8,
 recovery:{version:1,scope:'baseline',maxEnvironmentRetries:0,maxManualRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
 execution:{version:1,maxRunMs:180000,maxStageMs:120000,terminationGraceMs:1000},
 stageRecovery:{version:1,maxEnvironmentRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
 continuity:{version:1,isolatedAutoIntegration:false,planningRefresh:'reject',planningInputs:['app/src/main/java/**']},
 modelContinuation:{version:1,maxContinuations:1,maxCalls:4,maxElapsedMs:170000,stepLimit:1}};}
test('model continuation requires explicit bounded V8 approval',()=>{
 const f=fixture({inventoryMode:true});try {
  const value=contract(f,'TASK-MODEL');validateContract(value,f.config);
  for(const mutate of [v=>v.schemaVersion=7,v=>v.modelContinuation.maxContinuations=2,v=>v.modelContinuation.maxCalls=0,
    v=>v.modelContinuation.maxElapsedMs=999999,v=>v.modelContinuation.extra=true]) {
   const bad=structuredClone(value);mutate(bad);assert.throws(()=>validateContract(bad,f.config));
  }
 } finally {f.cleanup();}
});
test('supervised coder budget stop resumes once with sealed RED and completes review', {timeout:240000},async()=>{
 const f=fixture({inventoryMode:true});try {
  const host=join(f.bin,'opencode');let script=readFileSync(host,'utf8');
  script=script.replace("stdio:'inherit'","stdio:['ignore',2,2]");
  const start={type:'step_start',sessionID:'fixture',part:{id:'s',type:'step-start',messageID:'m',sessionID:'fixture'}};
  const end={type:'step_finish',sessionID:'fixture',part:{id:'f',type:'step-finish',messageID:'m',sessionID:'fixture'}};
  script=script.replace("  fs.writeFileSync('app/src/main/java/'+id+'.kt'",`  process.stdout.write(${JSON.stringify(JSON.stringify(start)+'\n'+JSON.stringify(end)+'\n')});\n  setInterval(()=>{},1000);\n  return;\n  fs.writeFileSync('app/src/main/java/'+id+'.kt'`);
  writeFileSync(host,script);
  const id='TASK-MODEL', draft=f.queue.draft({contract:contract(f,id),plan:'# Approved model continuation with immutable RED evidence\n',...f.queue.snapshot()});
  f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft));
  const result=await run(f,{timeoutMs:210000});
  assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
  const ledger=result.item.modelLedger;
  assert.equal(ledger.continuations,1);assert.equal(ledger.calls.length,3);
  assert.equal(ledger.calls[0].result.reason,'STEP_BUDGET');assert.equal(ledger.calls[1].continuationOf,1);
  assert.equal(ledger.calls[0].stoppedCheckpoint,ledger.calls[1].checkpoint);
  assert.equal(ledger.calls[2].role,'scheduled-reviewer');
  assertAuthorized(result.item);
  const evidence=join(f.queue.storage.runtime,'evidence',id);
  assert.deepEqual(read(join(evidence,'model-continuation.json')),ledger);
 } finally {f.cleanup();}
});
