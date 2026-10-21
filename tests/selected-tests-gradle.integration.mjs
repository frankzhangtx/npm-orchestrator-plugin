import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,readdirSync,writeFileSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fixture,taskContract} from './queue-fixture.mjs';
const require=createRequire(import.meta.url);
const {runSelected}=require('../templates/automation/verification/selected-tests.cjs');
const files=root=>!existsSync(root)?[]:readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):[join(root,e.name)]);
test('real Gradle executes selected classes, rejects empty/failing selections, and reruns Test tasks',()=>{
 const f=fixture({inventoryMode:true});try {
  const gradle=files(join(homedir(),'.gradle/wrapper/dists/gradle-9.4.1-all')).find(p=>p.endsWith('/bin/gradle'));
  assert(gradle,'Gradle fixture requires cached Gradle 9.4.1');
  const jar=(g,a)=>{const p=files(join(homedir(),'.gradle/caches/modules-2/files-2.1',g,a)).find(p=>p.endsWith('.jar')&&!/-sources|-javadoc/.test(p));assert(p);return p;};
  const put=(p,s,mode)=>{mkdirSync(dirname(join(f.root,p)),{recursive:true});writeFileSync(join(f.root,p),s,mode?{mode}:undefined);};
  put('settings.gradle.kts','rootProject.name="selected-tests"\ninclude(":app")\n');
  put('app/build.gradle.kts',`plugins { java }\ndependencies { testImplementation(files(${[jar('junit','junit'),jar('org.hamcrest','hamcrest-core')].map(JSON.stringify).join(',')})) }\ntasks.register<Test>("testDebugUnitTest") { testClassesDirs=sourceSets.test.get().output.classesDirs; classpath=sourceSets.test.get().runtimeClasspath; useJUnit() }\n`);
  put('gradlew',`#!/usr/bin/env node\nconst r=require('node:child_process').spawnSync(${JSON.stringify(gradle)},['--offline','--max-workers=2',...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`,0o755);
  put('app/src/test/java/example/PhoneTest.java','package example; public class PhoneTest { @org.junit.Test public void formats() { org.junit.Assert.assertEquals(2,1+1); } }');
  put('app/src/test/java/example/CallerTest.java','package example; public class CallerTest { @org.junit.Test public void calls() { org.junit.Assert.assertTrue(true); } }');
  put('app/src/test/java/example/UnrelatedTest.java','package example; public class UnrelatedTest { @org.junit.Test public void unrelatedFailure() { org.junit.Assert.fail("must not run in selected set"); } }');
  const contract=taskContract(f,'TASK-SELECTED');contract.schemaVersion=7;
  contract.recovery={version:1,scope:'baseline',maxEnvironmentRetries:0,maxManualRetries:0,maxElapsedMs:900000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0};
  contract.execution={version:1,maxRunMs:900000,maxStageMs:300000,terminationGraceMs:1000};
  contract.stageRecovery={version:1,maxEnvironmentRetries:0,maxElapsedMs:900000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0};
  contract.verification.scope={version:2,mode:'affected-tests',variants:'debug',maxManualRetries:0};
  // This harness tests the real collector/runner; the selector's capability
  // checks are covered separately. Validation requires a discovered model.
  f.config.androidProject.capabilities={version:1};
  contract.targetTests=[{gradleTask:':app:testDebugUnitTest',filter:'example.PhoneTest'}];
  contract.verification.cases[0].test.className='example.PhoneTest';
  put('automation/config.json',JSON.stringify(f.config));put('automation/tasks/TASK-SELECTED.json',JSON.stringify(contract));
  const model={gradlePath:':app',directory:'app',buildFile:'app/build.gradle.kts',type:'application',namespace:'example.queue',applicationId:'example.queue',dependencies:[],sources:[{name:'main',kind:'production',paths:['app/src/main/**']},{name:'test',kind:'test',paths:['app/src/test/**']}],tasks:[{path:':app:testDebugUnitTest',kind:'unit',variant:'Debug'},{path:':app:assembleDebug',kind:'assemble',variant:'Debug'}]};
  f.config.androidProject.capabilities={version:1,buildRoot:'.',modules:[model]};f.config.androidProject.testPaths=['app/src/test/**'];
  f.config.gradleVerification={fullUnitTestTasks:[':app:testDebugUnitTest'],focusedTestTasks:[':app:testDebugUnitTest'],assembleTasks:[':app:assembleDebug'],lintTasks:[],deviceTestTasks:[]};
  put('automation/config.json',JSON.stringify(f.config));
  const selection=filters=>({testSelection:{mode:'selected',targets:filters.map(filter=>({gradleTask:':app:testDebugUnitTest',filter})),reasons:['real collector fixture']}});
  const call=filters=>runSelected(join(f.root,'automation/tasks/TASK-SELECTED.json'),join(f.root,'automation/config.json'),f.root,join(f.base,'evidence'),selection(filters));
  for(let i=0;i<2;i++) {const result=call(['example.PhoneTest','example.CallerTest']);assert.equal(result.cases.length,2);assert(result.cases.every(c=>c.result==='SUCCESS'));}
  assert.throws(()=>call(['example.MissingTest']),/No tests|Gradle exited|No executed|No focused/);
  assert.throws(()=>call(['example.UnrelatedTest']),/failed or were skipped/);
  console.log('Real Gradle selected-test artifacts:',f.base);
 }finally{f.cleanup();}
});
