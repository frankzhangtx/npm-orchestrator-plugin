import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { assertAuthorized, publicRun, validateContract } from '../dist/queue/queue.js';
import { queueCli } from '../dist/queue/cli.js';
import { fixture, taskContract, run } from './queue-fixture.mjs';
const { validateStageRecoveryPolicy, stageRetryDecision, classifyFailure } = createRequire(import.meta.url)('../templates/automation/verification/recovery.cjs');
const stageRecovery = { version: 1, maxEnvironmentRetries: 2, maxElapsedMs: 600000, initialDelayMs: 1000, maxDelayMs: 1000, maxSameFailureRetries: 2 };
const recovery = { ...stageRecovery, scope: 'baseline', maxManualRetries: 0 };
const execution = { version: 1, maxRunMs: 180000, maxStageMs: 120000, terminationGraceMs: 1000 };
const read = p => JSON.parse(readFileSync(p, 'utf8'));
function approve(f, policy = stageRecovery, allowedPaths = []) {
  const contract = { ...taskContract(f, 'TASK-STAGES'), schemaVersion: 7, recovery, execution, stageRecovery: policy };
  contract.allowedPaths.push(...allowedPaths);
  contract.verification.maxPreparationFixes = 0;
  const draft = f.queue.draft({ contract, plan: '# Approved stage verification with separate environment budgets\n', ...f.queue.snapshot() });
  return f.queue.enqueue(draft.key, draft.digest, f.queue.approvalText(draft));
}
test('stage recovery requires V7 approval and bounded policy without changing older contracts', () => {
  validateStageRecoveryPolicy(stageRecovery);
  for (const patch of [{version:2},{maxEnvironmentRetries:4},{maxSameFailureRetries:-1},{maxElapsedMs:0},{extra:true}])
    assert.throws(() => validateStageRecoveryPolicy({...stageRecovery,...patch}));
  const f = fixture({inventoryMode:true});
  try {
    const value = {...taskContract(f,'TASK-BOUNDS'), schemaVersion:7, recovery, execution, stageRecovery};
    validateContract(value,f.config);
    assert.throws(() => validateContract({...value,stageRecovery:undefined},f.config));
    assert.throws(() => validateContract({...value,schemaVersion:6},f.config));
    const old={...value,schemaVersion:6};delete old.stageRecovery;validateContract(old,f.config);
  } finally {f.cleanup();}
});
test('runtime stage checkpoints preserve contract approval while policy edits remain rejected', () => {
  const f = fixture({inventoryMode:true});
  try {
    approve(f);
    f.queue.storage.transaction(document => {
      document.items[0].stageRecovery = {red:{sha256:'a'.repeat(64)},green:{sha256:'b'.repeat(64)}};
    });
    const item = f.queue.item('TASK-STAGES');
    assert.doesNotThrow(() => assertAuthorized(item));
    for (const mutate of [value => {value.contract.stageRecovery.maxEnvironmentRetries += 1;},
      value => {value.dependsOn.push('TASK-UNAPPROVED');}, value => {value.commitPolicy = 'autoCommit';}]) {
      const changed = structuredClone(item);
      mutate(changed);
      assert.throws(() => assertAuthorized(changed), /fresh approval required/);
    }
  } finally {f.cleanup();}
});
test('stage checkpoint bridge rejects callers without the active supervised Worker identity', async () => {
  const f=fixture({inventoryMode:true});
  try {
    approve(f);f.queue.reserve();
    await assert.rejects(queueCli(['_stage-record',f.root,'red','','a'.repeat(64)]),/supervised Worker/);
    assert.equal(f.queue.item('TASK-STAGES').stageRecovery,undefined);
  } finally {f.cleanup();}
});
test('phase retry budgets survive reload and reject unknown failures, clock rollback and no progress', () => {
  const failure=classifyFailure({phase:'green',log:'HTTP 429',exitCode:1});
  const record={startedAt:10000,lastObservedAt:11000,retriesUsed:0,sameFailureCount:1,lastFailure:failure};
  assert.equal(stageRetryDecision(stageRecovery,JSON.parse(JSON.stringify(record)),11000,()=>0).nextRunAt,11750);
  assert.match(stageRetryDecision(stageRecovery,{...record,retriesUsed:2},11000).reason,/budget exhausted/);
  assert.match(stageRetryDecision(stageRecovery,{...record,sameFailureCount:3},11000).reason,/without verification progress/);
  assert.match(stageRetryDecision(stageRecovery,record,10999).reason,/clock moved backwards/);
  assert.equal(stageRetryDecision(stageRecovery,{...record,lastFailure:{retryable:false}},11000).allowed,false);
  assert.match(stageRetryDecision({...stageRecovery,maxElapsedMs:2000},record,11900).reason,/Backoff exceeds/);
});
test('RED, GREEN and Reviewer retry transient commands with independent budgets and no extra model or fix cycles', {timeout:180000}, async () => {
  const f=fixture({inventoryMode:true,deleteProduction:true,stageFaults:[
    {phase:'red',part:'inventory',failures:1,message:'java.net.ConnectException'},
    {phase:'green',part:'full',failures:1,message:'Received status code 429'},
    {phase:'review',part:'assemble',failures:1,message:'ECONNRESET'}]});
  try {
    approve(f,stageRecovery,['app/src/main/java/Baseline.kt']);const result=await run(f);
    assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
    assert.equal(existsSync(join(f.root,'app/src/main/java/Baseline.kt')),false);
    const evidence=join(f.queue.storage.runtime,'evidence/TASK-STAGES');
    for(const phase of ['red','green','review']) {
      const record=read(join(evidence,'stage-recovery',phase+'.json'));
      assert.equal(record.state,'PASSED');assert.equal(record.retriesUsed,1);
      assert.equal(record.attempts.length,2);assert.equal(record.attempts[0].failure.category,'environment');
    }
    const calls=readFileSync(join(f.base,'agent-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(c=>c.role==='scheduled-coder').length,1);
    assert.equal(calls.filter(c=>c.role==='scheduled-reviewer').length,1);
    assert.equal(read(join(evidence,'gate-attempts-cycle-0.json')).attempts,1);
    assert.equal(read(join(evidence,'red.json')).structuredCasesVerified,true);
    assert.equal(f.queue.storage.read().fault,null);
  } finally {f.cleanup();}
});
test('a Review correction cannot reset the GREEN environment budget', {timeout:180000}, async () => {
  const f=fixture({inventoryMode:true,reviewChanges:1,stageFaults:[
    {phase:'green',part:'full',calls:[1,3],failures:2,message:'HTTP 429'}]});
  try {
    approve(f,{...stageRecovery,maxEnvironmentRetries:1});
    const result=await run(f);
    assert.equal(result.item.state,'BLOCKED',result.output+result.item.waitingReason);
    const evidence=join(f.queue.storage.runtime,'evidence/TASK-STAGES');
    const record=read(join(evidence,'stage-recovery/green.json'));
    assert.equal(record.state,'EXHAUSTED');
    assert.equal(record.retriesUsed,1);
    assert.deepEqual(record.attempts.map(a=>a.state),['FAILED','PASSED','FAILED']);
    assert.equal(read(join(evidence,'gate-attempts-cycle-0.json')).attempts,1);
    assert.equal(existsSync(join(evidence,'gate-attempts-cycle-1.json')),false);
    const calls=readFileSync(join(f.base,'agent-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(c=>c.role==='scheduled-coder').length,2);
    assert.equal(calls.filter(c=>c.role==='scheduled-reviewer').length,1);
    assert.equal(f.queue.storage.read().fault,null);
  } finally {f.cleanup();}
});
for(const phase of ['green','review']) test(`${phase} exhaustion blocks without spending an implementation fix or requesting changes`,{timeout:180000},async()=>{
  const f=fixture({inventoryMode:true,stageFaults:[{phase,part:'full',failures:10,message:'HTTP 429'}]});
  try {
    approve(f,{...stageRecovery,maxEnvironmentRetries:1});const result=await run(f);
    assert.equal(result.item.state,'BLOCKED',result.output+result.item.waitingReason);
    const evidence=join(f.queue.storage.runtime,'evidence/TASK-STAGES');
    const record=read(join(evidence,'stage-recovery',phase+'.json'));
    assert.equal(record.state,'EXHAUSTED');assert.equal(record.retriesUsed,1);assert.equal(record.attempts.length,2);
    assert.equal(existsSync(join(evidence,'review.json')),false);
    if(phase==='green')assert.equal(existsSync(join(evidence,'gate-attempts-cycle-0.json')),false);
    assert.equal(f.queue.reserve(),null);assert.equal(f.queue.storage.read().fault,null);
  } finally {f.cleanup();}
});

async function until(check, timeout=60000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { if(check())return;await new Promise(r=>setTimeout(r,100)); }
  throw new Error('Timed out waiting for a durable stage backoff');
}
for(const tamper of ['input','attempt','ledger']) test(`durable backoff rejects ${tamper} changes before another command`,{timeout:180000},async()=>{
  const {writeFileSync,appendFileSync}=await import('node:fs');
  const f=fixture({inventoryMode:true,stageFaults:[{phase:'red',part:'inventory',failures:1,message:'HTTP 429'}]});
  try {
    approve(f,{...stageRecovery,initialDelayMs:4000,maxDelayMs:4000});
    const running=run(f);
    const file=join(f.queue.storage.runtime,'evidence/TASK-STAGES/stage-recovery/red.json');
    await until(()=>existsSync(file)&&read(file).state==='WAITING');
    const waiting=read(file);
    // A separate reader sees the same persisted deadline and counters.
    assert.equal(read(file).nextRunAt,waiting.nextRunAt);assert.equal(waiting.retriesUsed,0);
    if(tamper==='input')appendFileSync(join(f.root,'app/src/test/java/TASK-STAGESTest.kt'),'// unexpected mutation\n');
    else if(tamper==='attempt')appendFileSync(join(f.queue.storage.runtime,'evidence/TASK-STAGES/stage-recovery',waiting.attempts[0].log),'tampered log\n');
    else writeFileSync(file,JSON.stringify({...waiting,retriesUsed:-1}));
    const result=await running;
    assert.equal(result.item.state,'BLOCKED',result.output + JSON.stringify(publicRun(f.queue.storage.read().active)));
    if(tamper!=='ledger')assert.equal(read(file).state,'BLOCKED');
    else assert.equal(f.queue.item('TASK-STAGES').stageRecovery.red.sha256.length,64);
    assert.equal(read(file).attempts.length,1);
    assert.equal(Number(readFileSync(join(f.base,'stage-fault-red'),'utf8')),1);
    assert.equal(f.queue.reserve(),null);
  } finally {f.cleanup();}
});
for(const message of ['Compilation failed. HTTP 429','unknown tool failure']) test(`non-environment failures never retry: ${message}`,{timeout:180000},async()=>{
  const f=fixture({inventoryMode:true,stageFaults:[{phase:'green',part:'full',failures:5,message}]});
  try {
    approve(f);const result=await run(f);
    assert.equal(result.item.state,'BLOCKED',result.output);
    const record=read(join(f.queue.storage.runtime,'evidence/TASK-STAGES/stage-recovery/green.json'));
    assert.equal(record.retriesUsed,0);assert.equal(record.attempts.length,1);
    assert.equal(record.lastFailure.retryable,false);
    assert.equal(record.lastFailure.category,message.startsWith('Compilation')?'buildFailure':'unknown');
  } finally {f.cleanup();}
});
