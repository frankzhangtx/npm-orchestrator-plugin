import assert from 'node:assert/strict';
import test from 'node:test';
import {sha256} from '../dist/queue/storage.js';
import {validateDelegationGrant,delegationRecord,bindDelegationSession,checkDelegatedDraft,sealDelegatedDraft,consumeDelegation} from '../dist/queue/delegation.js';
const now=Date.now();
function sample() {
 const policies={recovery:{version:1},execution:{maxRunMs:1000},stageRecovery:{version:1},continuity:{version:1},modelContinuation:{maxContinuations:1},maxFixLoops:1,deviceTestsRequired:false,verificationScope:{mode:'affected'},maxPreparationFixes:1,inventory:{mode:'focusedBaseline'}};
 const grant={version:1,id:'grant-1',runId:'batch-1',sourceRoot:'/fixture',originalHead:'a'.repeat(40),planningHead:'b'.repeat(40),targetBranch:'trial/candidate-1',upgradePaths:['automation/config.json'],requestSha256:sha256('exact requirement'),candidateSha256:'c'.repeat(64),configSha256:'d'.repeat(64),taskId:'TASK-PHONE',allowedPaths:['app/Phone.kt','app/PhoneTest.kt'],targetTests:[{gradleTask:':app:testDebugUnitTest',filter:'PhoneTest'}],workspaceStrategy:'isolatedWorktree',commitPolicy:'autoCommit',expiresAt:new Date(now+60000).toISOString(),cleanupExpiresAt:new Date(now+120000).toISOString(),policies};
 const record={grant,grantSha256:sha256(JSON.stringify(grant)),createdAt:new Date(now).toISOString(),sessionID:null,requestMessage:null,draft:null,consumedAt:null};
 const document={delegations:[record],runScope:{version:1,runId:'batch-1',taskKeys:['TASK-PHONE@1'],expiresAt:grant.expiresAt,cleanupExpiresAt:grant.cleanupExpiresAt}};
 const context={id:'grant-1',sessionID:'native-change-session',messageID:'planner-message'};
 const input={planningHead:grant.planningHead,targetBranch:grant.targetBranch,workspaceStrategy:grant.workspaceStrategy,commitPolicy:grant.commitPolicy,contract:{id:'TASK-PHONE',schemaVersion:8,allowedPaths:grant.allowedPaths,maxChangedFiles:2,targetTests:grant.targetTests,...policies,verification:{scope:policies.verificationScope,maxPreparationFixes:1,inventory:policies.inventory}}};
 const draft={key:'TASK-PHONE@1',version:1,digest:'e'.repeat(64),planSha256:'f'.repeat(64),contractSha256:'a'.repeat(64)};
 return {grant,record,document,context,input,draft};
}
test('native delegation binds exact requirement/session and emits a distinct single-use proof',()=>{
 const {grant,record,document,context,input,draft}=sample();validateDelegationGrant(grant);
 assert.equal(delegationRecord(document,grant.id,now),record);
 assert.throws(()=>bindDelegationSession(record,context.sessionID,'already approved'),/requirement/);
 bindDelegationSession(record,context.sessionID,'exact requirement');
 assert.throws(()=>bindDelegationSession(record,'another-session','exact requirement'),/bound/);
 checkDelegatedDraft(record,input,context);sealDelegatedDraft(record,draft,context);
 const proof=consumeDelegation(record,draft,context);
 assert.equal(proof.planSha256,draft.planSha256);assert.equal(proof.candidateSha256,grant.candidateSha256);
 assert.equal(Object.hasOwn(proof,'questionCallID'),false);
 assert.throws(()=>consumeDelegation(record,draft,context),/sealed draft/);
});
test('expired, altered, widened or unscoped grants are rejected',()=>{
 const {grant,record,document,context,input}=sample();bindDelegationSession(record,context.sessionID,'exact requirement');
 assert.throws(()=>delegationRecord(document,grant.id,now+60000),/expired/);
 for(const mutate of [d=>d.runScope.taskKeys=[],d=>d.runScope.runId='other',d=>d.delegations[0].grant.allowedPaths.push('app/Other.kt')]) {
  const d=structuredClone(document);mutate(d);assert.throws(()=>delegationRecord(d,grant.id,now));
 }
 for(const mutate of [v=>v.contract.allowedPaths=['app/**'],v=>v.contract.targetTests[0].filter='*',v=>v.contract.execution.maxRunMs=999999,
   v=>v.planningHead='0'.repeat(40),v=>v.commitPolicy='humanApproval',v=>v.dependsOn=['TASK-OTHER'],v=>v.contract.verification.supplementalTests={mode:'baselinePassingNewFiles'}]) {
  const changed=structuredClone(input);mutate(changed);assert.throws(()=>checkDelegatedDraft(record,changed,context));
 }
 for(const path of ['../escape','/absolute','app/**','app/./Phone.kt']) {
  const changed=structuredClone(grant);changed.allowedPaths=[path];assert.throws(()=>validateDelegationGrant(changed),/paths/);
 }
});
test('plan and contract hashes are sealed before grant consumption',()=>{
 const {record,context,draft}=sample();bindDelegationSession(record,context.sessionID,'exact requirement');sealDelegatedDraft(record,draft,context);
 for(const key of ['key','digest','planSha256','contractSha256']) assert.throws(()=>consumeDelegation(record,{...draft,[key]:'changed'},context));
 assert.equal(record.consumedAt,null);
 assert.throws(()=>sealDelegatedDraft(record,{...draft,version:2},context),/one task version/);
});

test('queue transaction consumes delegation with enqueue and repeats return the same task',async()=>{
 const {fixture,taskContract}=await import('./queue-fixture.mjs');
 const {delegationRecord}=await import('../dist/queue/delegation.js');
 const {assertAuthorized}=await import('../dist/queue/queue.js');
 const f=fixture({inventoryMode:true,workspaceStrategy:'isolatedWorktree',commitPolicy:'autoCommit'});
 try {
  const s=sample(), snapshot=f.queue.snapshot(), id=s.grant.taskId;
  const c={...taskContract(f,id),schemaVersion:8,maxChangedFiles:2,
   recovery:{version:1,scope:'baseline',maxEnvironmentRetries:0,maxManualRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
   execution:{version:1,maxRunMs:180000,maxStageMs:120000,terminationGraceMs:1000},
   stageRecovery:{version:1,maxEnvironmentRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
   continuity:{version:1,isolatedAutoIntegration:true,planningRefresh:'reject',planningInputs:['app/src/main/java/**']},
   modelContinuation:{version:1,maxContinuations:1,maxCalls:4,maxElapsedMs:170000,stepLimit:64}};
  const grant={...s.grant,sourceRoot:f.root,planningHead:snapshot.planningHead,targetBranch:snapshot.targetBranch,
   allowedPaths:c.allowedPaths,targetTests:c.targetTests,
   policies:{recovery:c.recovery,execution:c.execution,stageRecovery:c.stageRecovery,continuity:c.continuity,
    modelContinuation:c.modelContinuation,maxFixLoops:c.maxFixLoops,deviceTestsRequired:c.deviceTestsRequired,
    verificationScope:c.verification.scope ?? null,maxPreparationFixes:c.verification.maxPreparationFixes,inventory:c.verification.inventory}};
  const record={...s.record,grant,grantSha256:sha256(JSON.stringify(grant)),sessionID:s.context.sessionID};
  // Isolate queue persistence from the separately tested artifact loader. The
  // production checkedDelegation also verifies actual package/config/HEAD.
  f.queue.checkedDelegation=(document,id)=>delegationRecord(document,id);
  f.queue.control('pause');f.queue.setRunScope({...s.document.runScope});
  f.queue.storage.transaction(d=>{d.delegations=[record];});
  const input={contract:c,plan:'# Complete approved delegated behavior plan\n',...snapshot,workspaceStrategy:'isolatedWorktree',commitPolicy:'autoCommit'};
  const draft=f.queue.draft(input,undefined,s.context);
  assert.deepEqual(f.queue.draft(input,undefined,s.context),draft);
  assert.throws(()=>f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft)),/atomic grant consumption/);
  assert.equal(f.queue.storage.read().delegations[0].consumedAt,null);
  assert.throws(()=>f.queue.enqueue(draft.key,'changed',f.queue.approvalText(draft),undefined,s.context));
  assert.equal(f.queue.storage.read().delegations[0].consumedAt,null);
  const item=f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft),undefined,s.context);
  assert.equal(item.authorization.source,'delegatedApproval');assert.equal(item.authorization.proof,undefined);
  assertAuthorized(item);assert.equal(f.queue.storage.read().delegations[0].consumedAt!==null,true);
  assert.deepEqual(f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft),undefined,s.context),item);
  assert.equal(f.queue.storage.read().items.length,1);
 } finally {f.cleanup();}
});
