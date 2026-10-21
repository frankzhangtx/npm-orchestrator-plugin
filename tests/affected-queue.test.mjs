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
  const contract={...taskContract(f,'TASK-IMPACT'),...(f.contractOverrides??{}),schemaVersion:7,stageRecovery,
    recovery:{...stageRecovery,scope:'baseline',maxManualRetries:1},execution:{version:1,maxRunMs:360000,maxStageMs:240000,terminationGraceMs:1000}};
  contract.verification.scope={version:2,mode:'affected-tests',variants:'debug',maxManualRetries:1};
  const draft=f.queue.draft({contract,plan:'# Apply scoped verification with immutable retry checkpoints\n',...f.queue.snapshot()});
  return f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft));
}
const evidence=f=>join(f.queue.storage.runtime,'evidence/TASK-IMPACT');
test('V2 preserves independent Review while reusing unchanged GREEN gates',{timeout:240000},async()=>{
 const f=setup();try{
  const approved=approve(f);assert.match(f.queue.approvalText(approved),/选定|选择/);
  const result=await run(f,{timeoutMs:210000});assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
  const green=read(join(evidence(f),'stage-recovery/verification-green.json'));
  const review=read(join(evidence(f),'stage-recovery/verification-review.json'));
  assert.equal(green.state,'PASSED');assert.equal(review.state,'PASSED');
  assert.equal(review.reusedFrom.phase,'green');assert.equal(review.attempts.length,0);
  const calls=readFileSync(join(f.base,'agent-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.role),['scheduled-coder','scheduled-reviewer']);
  // Evidence must remain independently verifiable after the owner has sealed it.
  assert.equal(read(join(evidence(f),'review.json')).decision,'APPROVED');
 }finally{f.cleanup();}
});
test('selected baseline, Review and integration preserve scoped tests and candidate evidence',{timeout:300000},async()=>{
 const f=setup();try{
  const product='app/src/main/java/TASK-IMPACT.kt',testFile='app/src/test/java/TASK-IMPACTTest.kt';
  const production=value=>`package example\nclass Feature { fun value(): Int { return ${value} } }\n`;
  const tests='package example\nclass FeatureTest { @Test fun legacy() { Feature().value() } }\n';
  writeFileSync(join(f.root,product),production(1));writeFileSync(join(f.root,testFile),tests);
  writeFileSync(join(f.root,'app/src/main/java/Baseline.kt'),'package example\nclass Baseline\n');
  writeFileSync(join(f.root,'app/src/test/java/LegacyTest.kt'),'package example\nclass LegacyTest\n');
  let gradle=readFileSync(join(f.root,'gradlew'),'utf8');
  gradle=gradle.replaceAll("fs.existsSync('app/src/main/java/'+id+'.kt')",`fs.readFileSync(${JSON.stringify(product)},'utf8').includes('return 2')`);
  writeFileSync(join(f.root,'gradlew'),gradle);
  let agent=readFileSync(join(f.bin,'opencode'),'utf8');
  agent=agent.replace("'class RegressionTest {}\\n'",JSON.stringify(tests.replace(' }\n',' @Test fun approvedBehavior() { Feature().value() } }\n')));
  agent=agent.replace("'class ImplementedFeature {}\\n'",JSON.stringify(production(2)));
  writeFileSync(join(f.bin,'opencode'),agent);
  execFileSync('git',['add','.'],{cwd:f.root});execFileSync('git',['commit','-qm','Existing source and regression mapping'],{cwd:f.root});
  const original=taskContract(f,'TASK-IMPACT');
  f.contractOverrides={targetTests:[{gradleTask:':app:testDebugUnitTest',filter:'example.FeatureTest'}],verification:{...original.verification,cases:original.verification.cases.map(c=>({...c,test:{...c.test,className:'example.FeatureTest'}}))}};
  const approved=approve(f);
  assert.equal(f.queue.verificationPreview(approved.contract).testSelection.mode,'selected');
  const result=await run(f,{timeoutMs:210000});assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
  const green=read(join(evidence(f),'stage-recovery/verification-green.json'));
  assert.equal(green.plan.testSelection.mode,'selected');assert.equal(green.attempts.some(a=>a.part==='unit'),false);
  assert.equal(read(join(evidence(f),'baseline-full.json')).testSelection.mode,'selected');
  const calls=readFileSync(join(f.base,'gradle-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert(!calls.some(c=>c.args.includes(':app:testDebugUnitTest')&&!c.args.some(a=>a.startsWith('-Dorchestrator.inventoryRequest='))));
  assert.equal(read(join(evidence(f),'stage-recovery/verification-review.json')).reusedFrom.phase,'green');
  assert(read(join(evidence(f),'baseline-selected.json')).cases.length > 0);
  f.queue.request('TASK-IMPACT','integrate',f.config.approvalPhrases.acceptance,result.item.candidateId);
  const completed=await run(f,{timeoutMs:120000});
  assert.equal(completed.item.state,'COMPLETED',completed.output+completed.item.waitingReason);
  const integration=read(join(evidence(f),'stage-recovery/verification-integration.json'));
  assert.equal(integration.state,'PASSED');assert.equal(integration.reusedFrom,undefined);
  assert(integration.attempts.some(a=>a.part==='selected'));
  assert(!integration.attempts.some(a=>a.part==='unit'));
  assert.notEqual(integration.binding.head,green.binding.head);
 }finally{f.cleanup();}
});
