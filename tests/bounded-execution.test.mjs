import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {gradleArguments,cleanTasks,verificationPhases,prepareBuild}=require('../templates/automation/verification/bounded-execution.cjs');
const contract=()=>({targetTests:[{gradleTask:':app:testFreeDebugUnitTest',filter:'example.FeatureTest'}],verification:{scope:{version:3,mode:'bounded',regressionTests:[{gradleTask:':shared:test',filter:'example.SharedTest'}],tasks:{assembleTasks:[':app:assembleFreeDebug'],lintTasks:[],deviceTestTasks:[]}}}});
test('bounded compilation enables cache without forcing clean or rerunning all tasks',()=>{
 const c=contract(),args=gradleArguments(c,[':app:testFreeDebugUnitTest']);
 assert(args.includes('--build-cache'));
 assert(!args.some(x=>x==='clean'||x==='--rerun-tasks'||x==='--no-build-cache'));
 assert(args.includes('-Dorchestrator.allowedTests=[":app:testFreeDebugUnitTest"]'));
 assert(args.includes('-Dorchestrator.allowedClean=[]'));
 assert.throws(()=>gradleArguments(c,[':app:testPaidDebugUnitTest']),/exceeds/);
 assert.throws(()=>gradleArguments(c,[':app:clean']),/exceeds/);
 c.verification.scope.buildMode='clean';
 assert.deepEqual(cleanTasks(c),[':app:clean',':shared:clean']);
 assert(gradleArguments(c,[':app:clean']).includes('-Dorchestrator.allowedClean=[":app:clean"]'));
 assert.throws(()=>gradleArguments(c,[':unrelated:clean']),/exceeds/);
 const extra=gradleArguments(c,[':app:assembleFreeDebug'],{gradleVerification:{lintTasks:[]},androidProject:{capabilities:{modules:[{tasks:[{path:':app:lintPaidRelease'}]}]}}});
 assert(extra.includes('-Dorchestrator.knownVerification=[":app:lintPaidRelease"]'));
});
test('GREEN and Review defer packaging and supplemental tests to the fixed final commit',()=>{
 const c=contract(),p={testSelection:{mode:'selected'}};
 for(const phase of ['green','review'])assert.deepEqual(verificationPhases(c,p,phase),['focused','inventory-check']);
 assert.deepEqual(verificationPhases(c,p,'integration'),['focused','selected','assemble','lint','device','inventory-check']);
 c.verification.scope.version=2;
 assert.deepEqual(verificationPhases(c,p,'green'),['focused','selected','assemble','lint','device','inventory-check']);
 assert.deepEqual(gradleArguments(c,[':app:testFreeDebugUnitTest']),[]);
});
test('incremental preparation runs no Gradle; explicit clean runs once and failed clean is not retried',t=>{
 const root=mkdtempSync(join(tmpdir(),'bounded-prepare-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 // Scope validation and task discovery have independent integration coverage.
 // Here observe the process boundary, including durable retry prevention.
 t.mock.method(require('../templates/automation/verification/contract.cjs'),'validateContract',()=>{});
 t.mock.method(require('../templates/automation/verification/project.cjs'),'gradleBuildRoot',()=>root);
 let exit=0;
 const process=t.mock.method(require('node:child_process'),'spawnSync',()=>({status:exit,signal:null}));
 const contractFile=join(root,'contract.json'),config=join(root,'config.json');writeFileSync(config,'{}');
 for(const mode of ['incremental','clean','failed-clean']) {
  const evidence=join(root,mode);mkdirSync(evidence);
  const c=contract();c.verification.scope.buildMode=mode==='incremental'?'incremental':'clean';
  writeFileSync(contractFile,JSON.stringify(c));const before=process.mock.callCount();
  if(mode==='failed-clean') {
   exit=1;
   assert.throws(()=>prepareBuild(contractFile,config,root,evidence),/Explicit clean failed/);
   assert.throws(()=>prepareBuild(contractFile,config,root,evidence),/do not automatically repeat clean/);
   assert.equal(process.mock.callCount(),before+1);
  } else {
   prepareBuild(contractFile,config,root,evidence);prepareBuild(contractFile,config,root,evidence);
   assert.equal(process.mock.callCount(),before+(mode==='clean'?1:0));
   const receipt=JSON.parse(readFileSync(join(evidence,'build-preparation.json'),'utf8'));
   assert.equal(receipt.state,'COMPLETE');assert.equal(receipt.testsExecuted,false);
  }
 }
});
