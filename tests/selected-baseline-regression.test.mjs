import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,taskContract} from './queue-fixture.mjs';
const require=createRequire(import.meta.url);
const inventory=require('../templates/automation/verification/inventory.cjs');
const {runSelected,runBaselineRegression,validateBaselineCases}=require('../templates/automation/verification/selected-tests.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const target=className=>({gradleTask:':app:testDebugUnitTest',filter:`example.${className}`});
const sample=(className,name)=>({taskPath:':app:testDebugUnitTest',className:`example.${className}`,name,result:'SUCCESS',failures:[]});
function setup(t) {
 const f=fixture({inventoryMode:true});t.after(()=>f.cleanup());
 const contract=taskContract(f,'TASK-SELECTED-BASELINE');contract.schemaVersion=7;
 contract.recovery={version:1,scope:'baseline',maxEnvironmentRetries:0,maxManualRetries:0,maxElapsedMs:900000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0};
 contract.execution={version:1,maxRunMs:900000,maxStageMs:300000,terminationGraceMs:1000};
 contract.stageRecovery={version:1,maxEnvironmentRetries:0,maxElapsedMs:900000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0};
 contract.verification.scope={version:2,mode:'affected-tests',variants:'debug',maxManualRetries:0};
 contract.targetTests=[target('PhoneTest')];contract.verification.cases[0].test.className='example.PhoneTest';
 const model={gradlePath:':app',directory:'app',buildFile:'app/build.gradle.kts',type:'application',namespace:'example.queue',applicationId:'example.queue',dependencies:[],sources:[{name:'main',kind:'production',paths:['app/src/main/**']},{name:'test',kind:'test',paths:['app/src/test/**']}],tasks:[{path:':app:testDebugUnitTest',kind:'unit',variant:'Debug'},{path:':app:assembleDebug',kind:'assemble',variant:'Debug'}]};
 f.config.androidProject.capabilities={version:1,buildRoot:'.',modules:[model]};f.config.androidProject.testPaths=['app/src/test/**'];
 f.config.gradleVerification={fullUnitTestTasks:[':app:testDebugUnitTest'],focusedTestTasks:[':app:testDebugUnitTest'],assembleTasks:[':app:assembleDebug'],lintTasks:[],deviceTestTasks:[]};
 const contractFile=join(f.root,'automation/tasks/TASK-SELECTED-BASELINE.json'),configFile=join(f.root,'automation/config.json'),evidence=join(f.base,'evidence');
 writeFileSync(contractFile,JSON.stringify(contract));writeFileSync(configFile,JSON.stringify(f.config));
 const state={cases:[sample('PhoneTest','behavior'),sample('CallerTest','oldRegression')]};
 const collector=t.mock.method(inventory,'runGradle',()=>({cases:structuredClone(state.cases)}));
 t.mock.method(console,'log',()=>{});
 const plan={testSelection:{mode:'selected',targets:[target('PhoneTest'),target('CallerTest')],reasons:['fixture selection']}};
 const args=[contractFile,configFile,f.root,evidence];
 const capture=()=>runSelected(...args,plan,true);
 const seal=()=>writeFileSync(join(evidence,'baseline.json'),JSON.stringify({testSelection:{mode:'selected'},baselineSelectedSha256:sha(readFileSync(join(evidence,'baseline-selected.json')))}));
 return {...f,state,collector,plan,args,evidence,capture,seal};
}
test('selected baseline identifies every old method rather than merely its class',()=>{
 const old=[sample('PhoneTest','behavior'),sample('PhoneTest','oldRegression')];
 assert.equal(validateBaselineCases(old,[...old,sample('PhoneTest','newBehavior')]),2);
 assert.throws(()=>validateBaselineCases(old,[old[0]]),/Missing selected baseline case/);
 for(const field of ['taskPath','className','name'])assert.throws(()=>validateBaselineCases(old,[old[0],{...old[1],[field]:'different'}]),/Missing selected baseline case/);
 for(const result of ['SKIPPED','FAILURE'])assert.throws(()=>validateBaselineCases(old,[old[0],{...old[1],result}]),/failed or was skipped/);
});
test('selected baseline is written once and cannot be replaced by a later capture',t=>{
 const f=setup(t);f.capture();
 const file=join(f.evidence,'baseline-selected.json'),before=readFileSync(file,'utf8'),result=JSON.parse(before);
 assert.equal(result.phase,'baseline');assert.equal(result.cases.length,2);assert.equal(result.contractSha256,sha(readFileSync(f.args[0])));
 assert.throws(()=>f.capture(),/already exists/);assert.equal(readFileSync(file,'utf8'),before);assert.equal(f.collector.mock.callCount(),1);
});
test('selected results combine focused evidence with new execution and retain baseline targets',t=>{
 const f=setup(t);f.capture();f.seal();
 const green={cases:[{actual:sample('PhoneTest','behavior')}]},greenBytes=JSON.stringify(green);
 writeFileSync(join(f.evidence,'green-inventory.json'),greenBytes);
 writeFileSync(join(f.evidence,'green-verification.json'),JSON.stringify({state:'PASSED',greenSha256:sha(greenBytes)}));
 f.state.cases=[sample('CallerTest','oldRegression')];
 const narrowed={testSelection:{...f.plan.testSelection,targets:[target('PhoneTest')]}};
 const result=runSelected(...f.args,narrowed);
 assert.equal(result.combinedCases.length,2);assert.equal(result.cases.length,1);
 assert.deepEqual(result.reusedFocusedTargets,[target('PhoneTest')]);assert.deepEqual(result.executedTargets,[target('CallerTest')]);
 assert.deepEqual(f.collector.mock.calls.at(-1).arguments[2].targetTests,[target('CallerTest')]);
 f.state.cases=[sample('CallerTest','renamedRegression')];
 assert.throws(()=>runSelected(...f.args,narrowed),/Missing selected baseline case/);
});
test('a reused focused result cannot hide a missing baseline method',t=>{
 const f=setup(t);f.state.cases.push(sample('PhoneTest','oldRegression'));f.capture();f.seal();
 const bytes=JSON.stringify({cases:[{actual:sample('PhoneTest','behavior')}]});
 writeFileSync(join(f.evidence,'green-inventory.json'),bytes);
 writeFileSync(join(f.evidence,'green-verification.json'),JSON.stringify({state:'PASSED',greenSha256:sha(bytes)}));
 f.state.cases=[sample('CallerTest','oldRegression')];
 assert.throws(()=>runSelected(...f.args,f.plan),/Missing selected baseline case/);
});
test('module fallback reruns sealed baseline targets and rejects deleted old cases',t=>{
 const f=setup(t);f.capture();f.seal();
 assert.equal(runBaselineRegression(...f.args).state,'PASSED');
 assert.deepEqual(f.collector.mock.calls.at(-1).arguments[2].targetTests,f.plan.testSelection.targets);
 f.state.cases=[sample('PhoneTest','behavior'),sample('CallerTest','replacement')];
 assert.throws(()=>runBaselineRegression(...f.args),/Missing selected baseline case/);
});
test('fallback without a selected baseline reports not required without executing tests',t=>{
 const f=setup(t);assert.equal(runBaselineRegression(...f.args).state,'NOT_REQUIRED');assert.equal(f.collector.mock.callCount(),0);
});
test('changed sealed baseline bytes cannot be used for selected or fallback verification',t=>{
 const f=setup(t);f.capture();f.seal();
 const file=join(f.evidence,'baseline-selected.json'),changed=JSON.parse(readFileSync(file,'utf8'));changed.cases.push(sample('PhoneTest','injected'));
 writeFileSync(file,JSON.stringify(changed));
 assert.throws(()=>runSelected(...f.args,f.plan),/Selected baseline evidence changed/);
 assert.throws(()=>runBaselineRegression(...f.args),/Selected baseline evidence changed/);
});
