import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, draft, enqueue, command, run } from './queue-fixture.mjs';
import { TaskQueue, assertAuthorized } from '../dist/queue/queue.js';
import { QueueExecutor, helper } from '../dist/queue/executor.js';
import { atomicJson, processIdentity, isAlive } from '../dist/queue/storage.js';
import { ApprovalLedger } from '../dist/queue/approvals.js';
import { assertQueueIdle } from '../dist/queue/lifecycle.js';
import { serviceStatus, startService } from '../dist/queue/service.js';
import { compactTaskDetails, readTaskEvidence } from '../dist/queue/presentation.js';
const { changes } = createRequire(import.meta.url)('../templates/automation/verification/worktree.cjs');
const prefix = 'automation/automation-commit-prefix';
const commit = f => { command(f.root, ['add','-A']); command(f.root,['commit','-qm','Commit reviewed fixture configuration']); };
const shellClean = f => helper(f.root, 'automation_worktree_is_clean', [f.root]);

for (const staged of [false,true]) test(`prefix exception passes intake, fingerprint, Shell and reservation staged=${staged}`, () => {
 const f=fixture(); try {
  const d=draft(f,'TASK-PREFIX'); const initial=f.queue.readiness(d);
  writeFileSync(join(f.root,prefix),'new prefix\n'); if(staged) command(f.root,['add',prefix]);
  assert.equal(f.queue.snapshot().planningHead,d.planningHead);
  assert.equal(f.queue.readiness(d).fingerprint,initial.fingerprint);
  shellClean(f); f.queue.enqueue(d.key,d.digest,f.queue.approvalText(d));
  assert.equal(f.queue.reserve().key,d.key);
 } finally { f.cleanup(); }
});

test('upgrade drift blocks snapshot and direct draft even at the same package version',()=>{
 const f=fixture();try {
  const d=draft(f,'TASK-DRIFT'); writeFileSync(join(f.root,prefix),'changed\n');
  writeFileSync(join(f.root,'opencode.json'),' { "plugin": [] }\n');
  assert.throws(()=>f.queue.snapshot(),/EXECUTION_CONFIG_CHANGED/);
  assert.throws(()=>f.queue.draft({contract:d.contract,plan:d.plan,planningHead:d.planningHead,targetBranch:d.targetBranch}),/EXECUTION_CONFIG_CHANGED/);
  const ready=f.queue.readiness(d);assert.deepEqual(ready.paths.map(p=>p.path),['opencode.json']);
  assert.throws(()=>f.queue.enqueue(d.key,d.digest,f.queue.approvalText(d)),/EXECUTION_CONFIG_CHANGED/);
  assert.equal(f.queue.storage.read().items.length,0);
 }finally{f.cleanup();}
});

test('NUL parser retains spaces, Unicode, newlines, staged deletion and both rename sides',()=>{
 const f=fixture();try{
  const unusual=['space name','中文文件','line\nbreak','automation/elsewhere-prefix'];
  for(const path of unusual) writeFileSync(join(f.root,path),'x');
  assert.deepEqual(changes(f.root).map(p=>p.path).sort(),unusual.sort());
  for(const path of unusual) unlinkSync(join(f.root,path));
  writeFileSync(join(f.root,prefix),'prefix\n');commit(f);
  command(f.root,['mv',prefix,'automation/other-prefix']);
  assert.deepEqual(changes(f.root).map(p=>p.path),['automation/other-prefix']);
  assert.throws(()=>shellClean(f),/WORKTREE_DIRTY/);
  command(f.root,['reset','--hard','HEAD']);
  command(f.root,['mv','app/src/main/java/Baseline.kt',prefix+'-other']);
  const rows=changes(f.root);assert.equal(rows.length,2);assert.ok(rows.some(row=>row.destination));
  assert.throws(()=>shellClean(f),/WORKTREE_DIRTY/);
 }finally{f.cleanup();}
});

test('external dirty changes after review retain draft and receipt until durable enqueue',()=>{
 const f=fixture();try{
  const d=draft(f,'TASK-APPROVAL'),ledger=new ApprovalLedger(),ctx={sessionID:'s',messageID:'m'},binding=`${d.key}:${d.digest}`;
  const question=ledger.prepare('s','enqueue',binding,'confirm','Confirm exact contract?',f.queue.approvalText(d));
  ledger.before({tool:'question',sessionID:'s',callID:'q'},{args:question});
  ledger.after({tool:'question',sessionID:'s',callID:'q'},{metadata:{answers:[[f.queue.approvalText(d)]]}});
  writeFileSync(join(f.root,'external'),'x');
  const proof=ledger.peek(ctx,'enqueue',binding);
  assert.throws(()=>f.queue.enqueue(d.key,d.digest,f.queue.approvalText(d),proof),/WORKTREE_DIRTY/);
  assert.equal(ledger.peek(ctx,'enqueue',binding).id,proof.id);
  assert.equal(f.queue.storage.read().items.length,0); assert.equal(f.queue.storage.read().drafts.length,1);
  unlinkSync(join(f.root,'external'));
  // Inject transaction failure before publication, then retry the same receipt.
  const transaction=f.queue.storage.transaction.bind(f.queue.storage);
  f.queue.storage.transaction=action=>{throw new Error('injected write failure');};
  assert.throws(()=>f.queue.enqueue(d.key,d.digest,f.queue.approvalText(d),proof),/injected/);
  f.queue.storage.transaction=transaction;
  f.queue.enqueue(d.key,d.digest,f.queue.approvalText(d),ledger.peek(ctx,'enqueue',binding));
  ledger.consume(ctx,'enqueue',binding);
  assert.throws(()=>ledger.peek(ctx,'enqueue',binding),/fresh/);
  // Crash after durable publication loses the ledger, exact replay is still idempotent.
  new TaskQueue(f.root).enqueue(d.key,d.digest,f.queue.approvalText(d));
  assert.equal(f.queue.storage.read().items.length,1);
 }finally{f.cleanup();}
});

test('unstarted waiting releases slot, preserves authorization, deduplicates writes, resumes once',()=>{
 const f=fixture();try{
  const item=enqueue(f,'TASK-WAIT');enqueue(f,'TASK-NEXT');writeFileSync(join(f.root,'external'),'x');
  assert.equal(f.queue.reserve(),null);const first=f.queue.storage.read();
  assert.equal(first.active,null);assert.equal(first.runs.length,0);
  assert.equal(first.items[0].state,'WAITING_PRECONDITION');assertAuthorized(first.items[0]);
  const serialized=readFileSync(f.queue.storage.path,'utf8'),mtime=statSync(f.queue.storage.path).mtimeMs;
  assert.equal(f.queue.reserve(),null);assert.equal(readFileSync(f.queue.storage.path,'utf8'),serialized);assert.equal(statSync(f.queue.storage.path).mtimeMs,mtime);
  assert.equal(existsSync(join(f.base,'gradle-calls.jsonl')),false);
  assert.equal(first.items[0].taskRoot,null);assert.equal(first.items[0].precondition.authorizationDigest,item.digest);
  const reloaded=new TaskQueue(f.root);assertQueueIdle(f.root);
  unlinkSync(join(f.root,'external'));assert.equal(reloaded.reserve().key,item.key);assert.equal(reloaded.reserve(),null);
 }finally{f.cleanup();}
});

test('paused and cancelled waits do not revive when conditions recover',()=>{
 const f=fixture();try{
  enqueue(f,'TASK-PAUSE');enqueue(f,'TASK-CANCEL');writeFileSync(join(f.root,'external'),'x');f.queue.reserve();
  f.queue.control('pause');f.queue.control('cancel','TASK-CANCEL');unlinkSync(join(f.root,'external'));
  assert.equal(new TaskQueue(f.root).reserve(),null);f.queue.control('resume');
  assert.equal(f.queue.reserve().key,'TASK-PAUSE@1');assert.equal(f.queue.item('TASK-CANCEL').state,'CANCELLED');
 }finally{f.cleanup();}
});

test('configuration commits during waiting require replanning and leave old digest intact',()=>{
 const f=fixture();try{
  const original=enqueue(f,'TASK-OLD');writeFileSync(join(f.root,'opencode.json'),'{"plugin": []}\n');f.queue.reserve();commit(f);
  assert.equal(f.queue.reserve(),null);const waiting=f.queue.item('TASK-OLD');
  assert.equal(waiting.precondition.state,'REPLAN_REQUIRED');assert.equal(waiting.planningHead,original.planningHead);assertAuthorized(waiting);
  f.queue.control('cancel','TASK-OLD');const fresh=enqueue(f,'TASK-FRESH');assert.notEqual(fresh.planningHead,original.planningHead);assert.equal(f.queue.reserve().key,fresh.key);
 }finally{f.cleanup();}
});

test('Worker race returns waiting before ownership or workspace creation and without a model call',async()=>{
 const f=fixture();try{
  enqueue(f,'TASK-RACE');const reservation=f.queue.reserve();writeFileSync(join(f.root,'external'),'x');
  const execution=spawnSync(process.execPath,[new URL('../dist/queue/cli.js',import.meta.url).pathname,'_worker',reservation.id,f.root],{env:f.env,encoding:'utf8',timeout:30000});
  assert.equal(execution.status,0,execution.stderr);
  f.queue.reconcile();
  const document=f.queue.storage.read();assert.equal(document.active,null);assert.equal(document.runs.at(-1).outcome.state,'WAITING_PRECONDITION');
  assert.equal(f.queue.item('TASK-RACE').taskRoot,null);
  assert.equal(existsSync(join(f.queue.storage.runtime,'workspaces/TASK-RACE.json')),false);
  assert.equal(existsSync(join(f.queue.storage.runtime,'locks/repository.workspace.lease')),false);
  assert.equal(existsSync(join(f.base,'gradle-calls.jsonl')),false);
  assert.equal(existsSync(join(f.queue.storage.runtime,'evidence/TASK-RACE/agent-runs.jsonl')),false);
 }finally{f.cleanup();}
});

test('only owned planning artifacts allow live predecessor intake, unknown edits remain external',()=>{
 const f=fixture();try{
  f.root=f.queue.storage.root;const item=enqueue(f,'TASK-OWNER'),reservation=f.queue.reserve();const branch='automation/owner';command(f.root,['switch','-c',branch]);
  writeFileSync(join(f.root,'automation/tasks/TASK-OWNER.json'),item.contractText);
  mkdirSync(join(f.root,'docs/plans'),{recursive:true});writeFileSync(join(f.root,item.contract.planPath),item.plan);
  atomicJson(join(f.queue.storage.runtime,'workspaces/TASK-OWNER.json'),{queueKey:item.key,taskRoot:f.root,sourceRoot:f.root,taskBranch:branch,baselineHead:item.planningHead,executionRunId:reservation.id,worktreeAllowlist:[]});
  atomicJson(join(f.queue.storage.runtime,'locks/repository.workspace.lease/lease.json'),{taskId:item.taskId,sourceRoot:f.root,workspaceStrategy:item.workspaceStrategy});
  f.queue.storage.transaction(document=>{document.items[0].taskRoot=f.root;document.active.worker=processIdentity(process.pid);});
  const next=draft(f,'TASK-NEXT');assert.equal(f.queue.readiness(next).state,'WAITING_PREDECESSOR');f.queue.enqueue(next.key,next.digest,f.queue.approvalText(next));
  writeFileSync(join(f.root,'app/src/main/java/Baseline.kt'),'unattributed edit');
  const third=draft(f,'TASK-THIRD');assert.throws(()=>f.queue.enqueue(third.key,third.digest,f.queue.approvalText(third)),/WORKTREE_DIRTY/);
 }finally{f.cleanup();}
});

test('required invalid prefix reports an independent configuration error',()=>{
 const f=fixture();try{
  const path=join(f.root,'automation/config.json'),config=JSON.parse(readFileSync(path));config.commitMessagePrefixMode='required';writeFileSync(path,JSON.stringify(config));
  writeFileSync(join(f.root,prefix),'ok\n');commit(f);const d=draft(f,'TASK-PREFIX-INVALID');
  writeFileSync(join(f.root,prefix),'two\nlines\n');shellClean(f);
  assert.equal(f.queue.readiness(d).reasonCode,'COMMIT_PREFIX_INVALID');assert.throws(()=>f.queue.enqueue(d.key,d.digest,f.queue.approvalText(d)),/COMMIT_PREFIX_INVALID/);
 }finally{f.cleanup();}
});

test('empty subprocess output still identifies helper and exit status',()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'scripts/automation/lib.sh'),'automation_empty_failure() { return 7; }\n');
  assert.throws(()=>helper(f.root,'automation_empty_failure'),/automation_empty_failure: exit=7.*no diagnostic output/);
 }finally{f.cleanup();}
});

test('process identity is stable across locales; unknown legacy identity cannot trigger takeover',()=>{
 const f=fixture();try{
  const id=processIdentity(process.pid),old=process.env.LC_ALL;process.env.LC_ALL='zh_CN.UTF-8';
  try{assert.deepEqual(processIdentity(process.pid),id);}finally{if(old===undefined)delete process.env.LC_ALL;else process.env.LC_ALL=old;}
  assert.equal(isAlive(id),true);assert.equal(isAlive({...id,started:'Mon Jan 1 00:00:00 2001'}),false);
  const legacy={...id,started:'日 10月 11 18:20:00 2026'};assert.throws(()=>isAlive(legacy),/PROCESS_IDENTITY_UNCERTAIN/);
  atomicJson(join(f.queue.storage.runtime,'service.json'),legacy);
  assert.throws(()=>serviceStatus(f.queue),/UNCERTAIN/);assert.throws(()=>startService(f.queue),/UNCERTAIN/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.queue.storage.runtime,'service.json'))),legacy);
 }finally{f.cleanup();}
});

test('large waiting path evidence is paginated and corrupted wait binding fails closed',()=>{
 const f=fixture();try{
  enqueue(f,'TASK-EVIDENCE');for(let i=0;i<250;i++)writeFileSync(join(f.root,`external-${i}`),'x');f.queue.reserve();
  const details=f.queue.details('TASK-EVIDENCE'),summary=compactTaskDetails(details);assert.equal(summary.readiness.pathCount,250);
  let cursor,content='';do{const page=readTaskEvidence(details,'precondition',summary.evidence.precondition.sha256,cursor);content+=page.content;cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(JSON.parse(content).paths.length,250);
  const document=f.queue.storage.read();document.items[0].precondition.authorizationDigest='tampered';atomicJson(f.queue.storage.path,document);
  assert.throws(()=>new TaskQueue(f.root),/Invalid startup waiting/);
 }finally{f.cleanup();}
});

test('WordPress-style 14-file upgrade waits, cancels, replans at new HEAD and executes with prefix edits', {timeout:360000}, async()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'opencode.json'),'{"plugin":["@frankzhang2026/opencode-android-orchestrator@1.2.3"]}\n');commit(f);
  const old=enqueue(f,'TASK-UPGRADE-OLD');
  writeFileSync(join(f.root,'opencode.json'),'{"plugin":["@frankzhang2026/opencode-android-orchestrator@1.3.0"]}\n');
  for(let i=0;i<13;i++)writeFileSync(join(f.root,'automation',`upgrade-${i}.txt`),'1.3.0 upgrade\n');
  atomicJson(join(f.root,'.automation-plugin/manifest.json'),{package:{version:'1.3.0'}});
  assert.throws(()=>f.queue.snapshot(),/EXECUTION_CONFIG_CHANGED.*committed=1.2.3, installed=1.3.0/);
  assert.equal(f.queue.reserve(),null);assert.equal(f.queue.item(old.key).precondition.paths.length,14);
  assert.equal(existsSync(join(f.base,'agent-calls.jsonl')),false);assert.equal(existsSync(join(f.base,'gradle-calls.jsonl')),false);
  f.queue.control('cancel',old.key);commit(f);
  writeFileSync(join(f.root,prefix),'WordPress prefix\n');command(f.root,['add',prefix]);
  const fresh=enqueue(f,'TASK-UPGRADE-FRESH');assert.notEqual(fresh.planningHead,old.planningHead);
  const outcome=await run(f,{timeoutMs:300000});assert.equal(outcome.item.state,'AWAITING_HUMAN',outcome.output+outcome.item.waitingReason);
  assert.equal(f.queue.item(old.key).state,'CANCELLED');assertAuthorized(outcome.item);
  const next=draft(f,'TASK-UPGRADE-NEXT');assert.equal(f.queue.readiness(next).state,'WAITING_PREDECESSOR');
  f.queue.enqueue(next.key,next.digest,f.queue.approvalText(next));
 }finally{f.cleanup();}
});

test('JSONC installations retain planning and same-version configuration checks',()=>{
 const f=fixture();try{
  command(f.root,['mv','opencode.json','opencode.jsonc']);commit(f);
  const d=draft(f,'TASK-JSONC');assert.equal(f.queue.readiness(d).state,'READY');
  writeFileSync(join(f.root,'opencode.jsonc'),'// edited configuration\n{}\n');
  assert.throws(()=>f.queue.snapshot(),/EXECUTION_CONFIG_CHANGED/);
 }finally{f.cleanup();}
});

test('draft readiness has a bounded card and exact evidence without changing its digest',()=>{
 const f=fixture();try{
  const d=draft(f,'TASK-DRAFT-CARD');for(let i=0;i<220;i++)writeFileSync(join(f.root,`review-${i}`),'x');
  f.queue.reviewDraft(d);const details=f.queue.details(d.key),summary=compactTaskDetails(details);
  assert.equal(summary.state,'DRAFT');assert.equal(summary.readiness.pathCount,220);assert.equal(summary.digest,d.digest);
  assert.ok(Buffer.byteLength(JSON.stringify(summary))<12*1024);
  assert.equal(f.queue.storage.read().items.length,0);
  let cursor,content='';do{const page=readTaskEvidence(details,'precondition',summary.evidence.precondition.sha256,cursor);content+=page.content;cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(JSON.parse(content).paths.length,220);
 }finally{f.cleanup();}
});
