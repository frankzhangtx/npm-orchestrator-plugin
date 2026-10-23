import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture,taskContract,run} from './queue-fixture.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function setup(options={}) {
  const f=fixture({inventoryMode:true,...options});
  const modules=['app','other'].map(id=>({gradlePath:`:${id}`,directory:id,buildFile:`${id}/build.gradle.kts`,type:'application',namespace:`example.${id}`,applicationId:`example.${id}`,dependencies:[],
    sources:['main','test','androidTest'].map(name=>({name,kind:name==='main'?'production':'test',paths:[`${id}/src/${name}/**`]})),
    tasks:['Debug','Release'].flatMap(variant=>['unit','assemble','lint','device'].map(kind=>({path:`:${id}:${kind==='unit'?`test${variant}UnitTest`:kind==='device'?`connected${variant}AndroidTest`:kind+variant}`,kind,variant})))}));
  f.config.androidProject.capabilities={version:1,buildRoot:'.',modules};
  f.config.androidProject.modules=modules.map(m=>({gradlePath:m.gradlePath,directory:m.directory,buildFile:m.buildFile,dsl:'kotlin',type:m.type,namespace:m.namespace,applicationId:m.applicationId}));
  for(const [key,kind] of [['productionPaths','production'],['testPaths','test']])f.config.androidProject[key]=modules.flatMap(m=>m.sources.filter(s=>s.kind===kind).flatMap(s=>s.paths));
  for(const [group,kind] of Object.entries({fullUnitTestTasks:'unit',focusedTestTasks:'unit',assembleTasks:'assemble',lintTasks:'lint',deviceTestTasks:'device'}))f.config.gradleVerification[group]=modules.flatMap(m=>m.tasks.filter(t=>t.kind===kind).map(t=>t.path));
  writeFileSync(join(f.root,'automation/config.json'),JSON.stringify(f.config,null,2)+'\n');
  execFileSync('git',['add','automation/config.json'],{cwd:f.root});execFileSync('git',['commit','-m','Record discovered task capabilities'],{cwd:f.root});
  return f;
}
function approve(f,maxEnvironmentRetries=1,extraPolicy={}) {
  const stageRecovery={version:1,maxEnvironmentRetries,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:2,...extraPolicy};
  const contract={...taskContract(f,'TASK-IMPACT'),schemaVersion:7,stageRecovery,
    recovery:{...stageRecovery,scope:'baseline',maxManualRetries:1},execution:{version:1,maxRunMs:360000,maxStageMs:240000,terminationGraceMs:1000}};
  contract.verification.scope={version:1,mode:'affected',variants:'debug',maxManualRetries:1};
  const draft=f.queue.draft({contract,verificationFallbackReason:'Explicitly exercise the previously approved legacy verification and recovery protocol.',plan:'# Apply scoped verification with immutable retry checkpoints\n',...f.queue.snapshot()});
  return f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft));
}
const evidence=f=>join(f.queue.storage.runtime,'evidence/TASK-IMPACT');
test('affected verification completes review and integration using only affected Debug tasks',{timeout:360000},async()=>{
  const f=setup({commitPolicy:'autoCommit'});try{
    approve(f);const result=await run(f,{timeoutMs:330000});
    assert.equal(result.item.state,'COMPLETED',result.output+result.item.waitingReason);
    const calls=readFileSync(join(f.base,'gradle-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(!calls.some(c=>c.args.some(a=>a.includes('Release')||a.startsWith(':other:'))));
    for(const phase of ['green','review','integration']){
      const record=read(join(evidence(f),`stage-recovery/verification-${phase}.json`));
      assert.equal(record.state,'PASSED');assert.deepEqual(record.plan.tasks.fullUnitTestTasks,[':app:testDebugUnitTest']);
      assert.deepEqual(record.plan.tasks.assembleTasks,[':app:assembleDebug']);
    }
    assert(read(join(evidence(f),'full-test-verification.json')).affectedTestsExecuted);
  }finally{f.cleanup();}
});
test('dependency download retry repeats only assembly and preserves unit test checkpoints',{timeout:300000},async()=>{
 const f=setup({stageFaults:[{phase:'green',part:'assemble',failures:1,message:"Could not GET 'https://repo.example.org/library.aar'\nRemote host terminated the handshake"}]});try{
   approve(f);const result=await run(f,{timeoutMs:270000});
   assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
   const record=read(join(evidence(f),'stage-recovery/verification-green.json'));
   assert.equal(record.retriesUsed,1);
   assert.equal(record.attempts.filter(a=>a.part==='focused').length,1);
   assert.equal(record.attempts.filter(a=>a.part==='unit').length,1);
   assert.equal(record.attempts.filter(a=>a.part==='assemble').length,2);
 }finally{f.cleanup();}
});
test('approved candidate recovery skips passed phases and retains the implementation budget',{timeout:360000},async()=>{
 const f=setup({stageFaults:[{phase:'green',part:'assemble',failures:1,message:'Could not GET artifact: Remote host terminated the handshake'}]});try{
   approve(f,0);const failed=await run(f,{timeoutMs:160000});
   assert.equal(failed.item.state,'BLOCKED',failed.output+failed.item.waitingReason);
   assert(!existsSync(join(evidence(f),'gate-attempts-cycle-0.json')));
   assert.equal(f.queue.reserve(),null);
   f.queue.request('TASK-IMPACT','resume',f.config.approvalPhrases.resume);
   const recovered=await run(f,{timeoutMs:160000});
   assert.equal(recovered.item.state,'AWAITING_HUMAN',recovered.output+recovered.item.waitingReason);
   const record=read(join(evidence(f),'stage-recovery/verification-green.json'));
   assert.equal(record.manualRetriesUsed,1);assert.equal(record.attempts.filter(a=>a.part==='unit').length,1);
   const agents=readFileSync(join(f.base,'agent-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(agents.filter(a=>a.role==='scheduled-coder').length,1);
 }finally{f.cleanup();}
});
test('paused queue reserves approved abort maintenance while ordinary work remains paused',()=>{
 const f=fixture();try{
   const contract=taskContract(f,'TASK-PAUSED');const d=f.queue.draft({contract,plan:'# Test paused queue maintenance authorization\n',...f.queue.snapshot()});
   f.queue.enqueue(d.key,d.digest,f.queue.approvalText(d));
   f.queue.storage.transaction(doc=>{const i=doc.items[0];i.state='BLOCKED';i.taskRoot=f.root;});
   f.queue.control('pause');assert.equal(f.queue.reserve(),null);
   f.queue.request(d.key,'abort',f.config.approvalPhrases.abort);
   assert.equal(f.queue.reserve().kind,'abort');assert.equal(f.queue.storage.read().paused,true);
 }finally{f.cleanup();}
});

test('Review corrections start fresh verification without invalidating archived checkpoints',{timeout:300000},async()=>{
 const f=setup({reviewChanges:1});try{
   approve(f);const result=await run(f,{timeoutMs:270000});
   assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
   const record=read(join(evidence(f),'stage-recovery/verification-green.json'));
   assert.equal(record.attempts.filter(a=>a.part==='unit').length,2);assert.equal(record.state,'PASSED');
 }finally{f.cleanup();}
});
test('Review environment recovery invokes a fresh Reviewer and rejects stale recovery approvals',{timeout:300000},async()=>{
 const f=setup({stageFaults:[{phase:'review',part:'assemble',failures:1,message:'Could not GET artifact: Remote host terminated the handshake'}]});try{
   approve(f,0);const failed=await run(f,{timeoutMs:160000});assert.equal(failed.item.state,'BLOCKED',failed.output);
   const item=f.queue.item('TASK-IMPACT'),binding=f.queue.operationBinding(item,'resume-task');
   const recordFile=join(evidence(f),'stage-recovery/verification-review.json'),original=readFileSync(recordFile);
   writeFileSync(recordFile,Buffer.concat([original,Buffer.from(' ')]));
   assert.throws(()=>f.queue.operationBinding(item,'resume-task'),/ledger changed/);writeFileSync(recordFile,original);
   assert.equal(f.queue.operationBinding(item,'resume-task'),binding);
   f.queue.request(item.key,'resume',f.config.approvalPhrases.resume);
   const result=await run(f,{timeoutMs:130000});assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
   const record=read(recordFile);assert.equal(record.manualRetriesUsed,1);assert.equal(record.attempts.filter(a=>a.part==='unit').length,1);
   const agents=readFileSync(join(f.base,'agent-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(agents.filter(a=>a.role==='scheduled-reviewer').length,2);
 }finally{f.cleanup();}
});
test('integration recovery retries the same committed candidate and failed subphase',{timeout:300000},async()=>{
 const f=setup({commitPolicy:'autoCommit',stageFaults:[{phase:'integration',part:'assemble',failures:1,message:'Could not GET artifact: Remote host terminated the handshake'}]});try{
   approve(f,0);const failed=await run(f,{timeoutMs:170000});assert.equal(failed.item.state,'INTEGRATION_BLOCKED',failed.output);
   const transaction=read(join(evidence(f),'commit-transaction.json'));
   f.queue.request('TASK-IMPACT','recover');const result=await run(f,{timeoutMs:120000});
   assert.equal(result.item.state,'COMPLETED',result.output+result.item.waitingReason);assert.equal(result.item.completedCommit,transaction.commit);
   const record=read(join(evidence(f),'stage-recovery/verification-integration.json'));
   assert.equal(record.manualRetriesUsed,1);assert.equal(record.attempts.filter(a=>a.part==='unit').length,1);
 }finally{f.cleanup();}
});

for(const change of ['input','attempt-log'])test(`impact backoff rejects changed ${change} before another build`,{timeout:220000},async()=>{
 const f=setup({stageFaults:[{phase:'green',part:'assemble',failures:1,message:'Could not GET artifact: Remote host terminated the handshake'}]});try{
   approve(f,1,{initialDelayMs:8000,maxDelayMs:8000});const running=run(f,{timeoutMs:190000});
   const file=join(evidence(f),'stage-recovery/verification-green.json'),deadline=Date.now()+150000;
   while(Date.now()<deadline && (!existsSync(file)||read(file).state!=='WAITING'))await new Promise(r=>setTimeout(r,100));
   assert.equal(read(file).state,'WAITING');const waiting=read(file);
   const changed=change==='input'?join(f.root,'app/src/main/java/TASK-IMPACT.kt'):join(evidence(f),'stage-recovery',waiting.attempts.at(-1).log);
   appendFileSync(changed,'// unexpected change\n');
   const result=await running;assert.equal(result.item.state,'BLOCKED',result.output);
   const record=read(file);assert.equal(record.state,'BLOCKED');assert.equal(record.attempts.filter(a=>a.part==='assemble').length,1);
 }finally{f.cleanup();}
});
test('focused inventory failures preserve their structured reason and never retry as network faults',{timeout:180000},async()=>{
 const f=setup({inventoryFailure:'missing-green'});try{
   approve(f);const result=await run(f,{timeoutMs:160000});
   assert(['BLOCKED','TEST_FAILED'].includes(result.item.state),result.output);
   const record=read(join(evidence(f),'stage-recovery/verification-green.json'));
   assert.equal(record.retriesUsed,0);assert.notEqual(record.lastFailure.reasonCode,'UNKNOWN_FAILURE');
   assert.equal(record.attempts.every(a=>a.part==='focused'),true);
 }finally{f.cleanup();}
});
