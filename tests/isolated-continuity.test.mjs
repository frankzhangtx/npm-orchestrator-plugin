import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertAuthorized, planningInputsDigest, validateContract } from '../dist/queue/queue.js';
import { fixture, taskContract, command, run } from './queue-fixture.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function isolatedFixture() {
  return fixture({inventoryMode:true,workspaceStrategy:'isolatedWorktree',commitPolicy:'autoCommit',autoCleanupWorktrees:true});
}
function contract(f, id, overrides = {}) {
  return {...taskContract(f,id),schemaVersion:8,
    recovery:{version:1,scope:'baseline',maxEnvironmentRetries:0,maxManualRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
    execution:{version:1,maxRunMs:180000,maxStageMs:120000,terminationGraceMs:1000},
    stageRecovery:{version:1,maxEnvironmentRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
    continuity:{version:1,isolatedAutoIntegration:true,planningRefresh:'completedQueueTasks',
      planningInputs:['app/src/main/java/Baseline.kt',`app/src/main/java/${id}.kt`,`app/src/test/java/${id}Test.kt`,'app/src/test/java/LegacyTest.kt']},
    ...overrides};
}
function approve(f,id,overrides={},draftOptions={}) {
  const draft=f.queue.draft({contract:contract(f,id,overrides),plan:'# Implement approved independent behavior and retain all regression checks\n',
    ...f.queue.snapshot(),...draftOptions});
  return f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft));
}
const execute = (f, options={}) => run(f,{timeoutMs:180000,...options});

test('V8 continuity is shared by queue and Shell validation and requires exact new approval',()=>{
  const f=isolatedFixture();try {
    const valid=contract(f,'TASK-POLICY');
    validateContract(valid,f.config);
    for(const change of [c=>{delete c.continuity;},c=>{c.schemaVersion=7;},c=>{c.continuity.extra=true;},
      c=>{c.continuity.planningInputs=['../outside'];},c=>{c.continuity.planningInputs=['./app'];},c=>{c.continuity.planningInputs=[];},
      c=>{c.continuity.planningRefresh='always';}]) {
      const value=structuredClone(valid);change(value);
      assert.throws(()=>validateContract(value,f.config));
      const path=join(f.base,'invalid.json');writeFileSync(path,JSON.stringify(value));
      const shell=spawnSync(process.execPath,[join(f.root,'automation/verification/contract.cjs'),path,join(f.root,'automation/config.json')]);
      assert.notEqual(shell.status,0);
    }
    const legacy=taskContract(f,'TASK-LEGACY');
    assert.throws(()=>f.queue.draft({contract:legacy,plan:'# Approved old contract behavior\n',...f.queue.snapshot()}),/explicit V8 approval/);
    const item=approve(f,'TASK-POLICY');assert.match(f.queue.approvalText(item),/隔离工作区自动集成已授权/);
    assertAuthorized(item);
    const changed=structuredClone(item);changed.planningInputsSha256='0'.repeat(64);
    assert.throws(()=>assertAuthorized(changed),/fresh approval/);
    f.queue.control('revoke',item.key);assert.equal(f.queue.reserve(),null);
  } finally {f.cleanup();}
});

test('planning input fingerprints bind file additions, deletions and executable modes',()=>{
  const f=isolatedFixture();try {
    const initial=command(f.root,['rev-parse','HEAD']), patterns=['app/src/main/**'];
    const before=planningInputsDigest(f.root,initial,patterns);
    chmodSync(join(f.root,'app/src/main/java/Baseline.kt'),0o755);
    command(f.root,['add','.']);command(f.root,['commit','-qm','Change executable mode']);
    assert.notEqual(planningInputsDigest(f.root,command(f.root,['rev-parse','HEAD']),patterns),before);
    writeFileSync(join(f.root,'app/src/main/java/Added.kt'),'class Added\n');
    command(f.root,['add','.']);command(f.root,['commit','-qm','Add planning input']);
    assert.notEqual(planningInputsDigest(f.root,command(f.root,['rev-parse','HEAD']),['app/src/main/java/Added.kt']),
      planningInputsDigest(f.root,initial,['app/src/main/java/Added.kt']));
    command(f.root,['rm','app/src/main/java/Baseline.kt']);command(f.root,['commit','-qm','Remove planning input']);
    assert.notEqual(planningInputsDigest(f.root,command(f.root,['rev-parse','HEAD']),patterns),before);
  } finally {f.cleanup();}
});

test('isolated automatic A then dependent B refreshes only unchanged declared inputs and completes two local commits', {timeout:360000},async()=>{
  const f=isolatedFixture();try {
    const baseline=command(f.root,['rev-parse','main']);
    approve(f,'TASK-A');
    const b=approve(f,'TASK-B',{allowedPaths:['app/src/main/java/**','app/src/test/java/**']},{dependsOn:['TASK-A']});
    const dependent=contract(f,'TASK-INPUT-DEPENDENT');
    dependent.continuity.planningInputs=['app/src/main/java/**'];
    approve(f,'TASK-INPUT-DEPENDENT',dependent,{dependsOn:['TASK-A']});
    assert.equal(b.planningHead,baseline);
    f.queue.control('pause');assert.equal(f.queue.reserve(),null);f.queue.control('resume');
    for(const id of ['TASK-A','TASK-B']) {
      const result=await execute(f);
      assert.equal(result.item.taskId,id);assert.equal(result.item.state,'COMPLETED',result.output+result.item.waitingReason);
      assert.equal(existsSync(result.item.taskRoot),false,'completed worktree was safely cleaned');
      const evidence=join(f.queue.storage.runtime,'evidence',id);
      assert.equal(existsSync(join(evidence,'acceptance.json')),false);
      assert.equal(read(join(evidence,'integration.json')).authorizationSource,'contractAutoCommit');
      assert.equal(read(join(evidence,'commit-transaction.json')).stage,'COMPLETED');
    }
    const refresh=read(join(f.queue.storage.runtime,'evidence/TASK-B/planning-baseline.json'));
    assert.deepEqual(refresh.refresh.integratedTasks,['TASK-A@1']);assert.equal(refresh.refresh.reason,null);
    assert.notEqual(refresh.executionHead,refresh.planningHead);
    assert.equal(f.queue.item('TASK-B').planningHead,baseline,'original approval was not rewritten');
    assert.equal(command(f.root,['rev-list','--count',`${baseline}..main`]),'2');
    assert.equal(command(f.root,['status','--porcelain']),'');assert.equal(command(f.root,['remote']), '');
    const blocked=await execute(f);
    assert.equal(blocked.item.taskId,'TASK-INPUT-DEPENDENT');assert.equal(blocked.item.state,'BASELINE_REVIEW',blocked.output);
    assert.equal(blocked.item.taskRoot,null);
    assert.match(read(join(f.queue.storage.runtime,'evidence/TASK-INPUT-DEPENDENT/planning-baseline.json')).refresh.reason,/planning inputs changed/);
    assert.equal(f.queue.reserve(),null);
  } finally {f.cleanup();}
});

test('failed isolated A retains evidence while B auto-integrates and C remains dependent on A', {timeout:300000},async()=>{
  const f=isolatedFixture();try {
    const agent=readFileSync(join(f.bin,'opencode'),'utf8');
    approve(f,'TASK-A');approve(f,'TASK-B');approve(f,'TASK-C',{}, {dependsOn:['TASK-A']});
    writeFileSync(join(f.bin,'opencode'),'#!/bin/sh\necho "agent fixture failed" >&2\nexit 7\n');
    const a=await execute(f);assert.equal(a.item.state,'BLOCKED',a.output);
    writeFileSync(join(f.bin,'opencode'),agent);
    const b=await execute(f);assert.equal(b.item.taskId,'TASK-B');assert.equal(b.item.state,'COMPLETED',b.output+b.item.waitingReason);
    assert.equal(f.queue.storage.read().fault,null);assert.equal(f.queue.reserve(),null);
    assert.match(f.queue.item('TASK-C').waitingReason,/dependency TASK-A/);
    assert(existsSync(a.item.taskRoot));assert(existsSync(join(f.queue.storage.runtime,'evidence/TASK-A/queue-seal.json')));
  } finally {f.cleanup();}
});

for(const kind of ['input','external','configuration','refresh-disabled']) test(`planning refuses ${kind} drift before creating a workspace or invoking a model`,{timeout:90000},async()=>{
  const f=isolatedFixture();try {
    const value=contract(f,'TASK-STALE');
    if(kind==='refresh-disabled')value.continuity.planningRefresh='reject';
    approve(f,'TASK-STALE',value);
    const path=kind==='input'?'app/src/main/java/Baseline.kt':kind==='configuration'?'gradlew':'unrelated.txt';
    writeFileSync(join(f.root,path),'\n// baseline changed\n',{flag:'a'});
    command(f.root,['add',path]);command(f.root,['commit','-qm','Unapproved planning drift']);
    const result=await execute(f);assert.equal(result.item.state,'BASELINE_REVIEW',result.output+result.item.waitingReason);
    assert.equal(result.item.taskRoot,null);assert.equal(existsSync(join(f.base,'agent-calls.jsonl')),false);
    const reason=read(join(f.queue.storage.runtime,'evidence/TASK-STALE/planning-baseline.json')).refresh.reason;
    assert.equal(result.item.waitingReason,reason);
    assert.match(reason,kind==='input'?/planning inputs/:kind==='configuration'?/configuration/:kind==='refresh-disabled'?/not approved/:/outside completed queue/);
  } finally {f.cleanup();}
});

for(const kind of ['revocation','target-drift']) test(`automatic integration refuses ${kind} after review without creating a commit intent`,{timeout:240000},async()=>{
  const f=isolatedFixture();try {
    const agent=join(f.bin,'opencode'),baseline=command(f.root,['rev-parse','main']);
    const hook=kind==='revocation'
      ? `const p=${JSON.stringify(f.queue.storage.path)}; const d=JSON.parse(fs.readFileSync(p)); d.items[0].authorization.revoked=true; fs.writeFileSync(p,JSON.stringify(d));`
      : `fs.writeFileSync(${JSON.stringify(join(f.root,'external.txt'))},'outside edit'); cp.execFileSync('git',['-C',${JSON.stringify(f.root)},'add','external.txt']); cp.execFileSync('git',['-C',${JSON.stringify(f.root)},'commit','-qm','Outside integration']);`;
    // Execute only after Reviewer has recorded passing independent verification.
    writeFileSync(agent,readFileSync(agent,'utf8')+`\nif(role==='scheduled-reviewer') { ${hook} }\n`);
    approve(f,'TASK-RACE');
    const result=await execute(f);assert.equal(result.item.state,'BLOCKED',result.output+result.item.waitingReason);
    assert.match(result.item.waitingReason,kind==='revocation'?/revoked/:/Target branch advanced/);
    assert.equal(existsSync(join(f.queue.storage.runtime,'evidence/TASK-RACE/commit-transaction.json')),false);
    assert.equal(command(f.root,['rev-list','--count',`${baseline}..main`]),kind==='revocation'?'0':'1');
    assert(existsSync(result.item.taskRoot));
  } finally {f.cleanup();}
});

for(const stage of ['COMMITTED','INTEGRATED']) test(`isolated automatic transaction recovers ${stage} crash without creating a second commit`,{timeout:300000},async()=>{
  const f=isolatedFixture();try {
    const baseline=command(f.root,['rev-parse','main']);
    approve(f,'TASK-RECOVER');
    const marker=join(f.base,'crashed.json'),preload=join(f.base,'interrupt.mjs');
    writeFileSync(preload,`import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const rename=fs.renameSync;
fs.renameSync=(...args)=>{
  rename(...args);
  if(String(args[1]).endsWith('/commit-transaction.json')&&!fs.existsSync(${JSON.stringify(marker)})) {
    const transaction=JSON.parse(fs.readFileSync(args[1]));
    if(transaction.stage===${JSON.stringify(stage)}) {
      fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(transaction));
      process.kill(process.pid,'SIGKILL');
    }
  }
};
syncBuiltinESMExports();\n`);
    f.env.NODE_OPTIONS=`--import=${preload}`;
    const interrupted=await execute(f,{allowCrash:true});
    assert(existsSync(marker),interrupted.output);
    assert(['BLOCKED','INTEGRATION_BLOCKED'].includes(interrupted.item.state),interrupted.output+interrupted.item.waitingReason);
    delete f.env.NODE_OPTIONS;
    f.queue.request('TASK-RECOVER','recover');
    const recovered=await execute(f);assert.equal(recovered.item.state,'COMPLETED',recovered.output+recovered.item.waitingReason);
    const transaction=read(join(f.queue.storage.runtime,'evidence/TASK-RECOVER/commit-transaction.json'));
    assert.equal(transaction.id,read(marker).id);assert.equal(transaction.commit,read(marker).commit);
    assert.equal(transaction.stage,'COMPLETED');assert.equal(command(f.root,['rev-list','--count',`${baseline}..main`]),'1');
    assert.equal(command(f.root,['status','--porcelain']),'');assert.equal(existsSync(recovered.item.taskRoot),false);
  } finally {f.cleanup();}
});

test('an abort received during final scope verification stops before commit intent publication',{timeout:240000},async()=>{
  const f=isolatedFixture();try {
    const hook=join(f.base,'request-abort.cjs');
    writeFileSync(hook,`const fs=require('node:fs'); const path=${JSON.stringify(f.queue.storage.path)};
const doc=JSON.parse(fs.readFileSync(path));
doc.items[0].request={kind:'abort',approval:${JSON.stringify(f.config.approvalPhrases.abort)},candidate:null};
fs.writeFileSync(path,JSON.stringify(doc));\n`);
    const script=join(f.root,'scripts/automation/scope-gate.sh');
    writeFileSync(script,readFileSync(script,'utf8')+`\nif [[ "$(automation_read_state "$task_id")" == "READY_TO_COMMIT" ]]; then node '${hook}'; fi\n`);
    command(f.root,['add','.']);command(f.root,['commit','-qm','Inject final scope abort']);
    const baseline=command(f.root,['rev-parse','main']);approve(f,'TASK-ABORT');
    const result=await execute(f);assert.equal(result.item.state,'BLOCKED',result.output+result.item.waitingReason);
    assert.match(result.item.waitingReason,/abort requested/);
    assert.equal(command(f.root,['rev-parse','main']),baseline);
    assert.equal(existsSync(join(f.queue.storage.runtime,'evidence/TASK-ABORT/commit-transaction.json')),false);
  } finally {f.cleanup();}
});
