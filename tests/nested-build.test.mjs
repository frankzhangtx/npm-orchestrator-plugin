import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { detectAndroidProject, detectionWithCapabilities, planProjectResourceInputs, runDoctor } from '../dist/index.js';
import { guardExecutorCommand } from '../dist/queue/tools.js';
import { command, fixture, taskContract, run } from './queue-fixture.mjs';
const { gradleBuildRoot, validateConfigurationModel } = createRequire(import.meta.url)('../templates/automation/verification/project.cjs');

function nestedFixture(options={}) {
  const f=fixture(options), build=join(f.root,'android');
  mkdirSync(build);
  for(const component of ['platforms','build-tools']) mkdirSync(join(f.base,component));
  for(const path of ['app','settings.gradle.kts','gradlew']) renameSync(join(f.root,path),join(build,path));
  mkdirSync(join(build,'gradle/wrapper'),{recursive:true});
  writeFileSync(join(build,'gradle/wrapper/gradle-wrapper.properties'),'distributionUrl=fixture\n');
  writeFileSync(join(build,'local.properties'),`sdk.dir=${f.base}\n`);
  // The wrapper uses paths relative to the Gradle build. Agent edits use paths
  // relative to the repository, as do contracts and the queue's Git snapshots.
  const wrapper=join(build,'gradlew');
  writeFileSync(wrapper,readFileSync(wrapper,'utf8').replaceAll("args.includes('testDebugUnitTest')","args.includes(':app:testDebugUnitTest')")
    .replace('cwd:process.cwd(),args,at:', 'cwd:process.cwd(),sdk:process.env.ANDROID_HOME,args,at:'));
  delete f.env.ANDROID_HOME;
  delete f.env.ANDROID_SDK_ROOT;
  const agent=join(f.bin,'opencode');
  writeFileSync(agent,readFileSync(agent,'utf8').replaceAll('app/src/','android/app/src/'));
  for(const folder of [f.root,join(f.root,'sibling')]) {
    mkdirSync(folder,{recursive:true});
    writeFileSync(join(folder,'gradlew'),'#!/bin/sh\necho WRONG_BUILD >&2\nexit 93\n',{mode:0o755});
    writeFileSync(join(folder,'settings.gradle.kts'),'rootProject.name = "decoy"\n');
  }
  writeFileSync(join(f.root,'.gitignore'),readFileSync(join(f.root,'.gitignore'),'utf8')+'local.properties\n');
  const tasks=Object.entries(f.config.gradleVerification).flatMap(([group,values])=>values.map(path=>({
    path:path.startsWith(':')?path:':app:'+path,kind:group.includes('Unit')||group.includes('focused')?'unit':group.includes('assemble')?'assemble':group.includes('lint')?'lint':'device',variant:'Debug'})));
  const model={version:1,buildRoot:'android',modules:[{gradlePath:':app',directory:'android/app',buildFile:'android/app/build.gradle.kts',
    type:'application',namespace:'example.queue',applicationId:'example.queue',dependencies:[],
    sources:[{name:'main',kind:'production',paths:['android/app/src/main/**']},{name:'test',kind:'test',paths:['android/app/src/test/**']},
      {name:'androidTest',kind:'test',paths:['android/app/src/androidTest/**']}],tasks:[...new Map(tasks.map(t=>[t.path,t])).values()]}]};
  const detection=detectionWithCapabilities(detectAndroidProject(build),model);
  const resources=planProjectResourceInputs(build,{projectDetection:detection,commitMessagePrefixMode:'disabled'});
  Object.assign(f.config,{androidProject:resources.adaptiveTemplates.automationConfig.androidProject,
    gradleVerification:resources.adaptiveTemplates.automationConfig.gradleVerification,
    protectedPaths:resources.adaptiveTemplates.automationConfig.protectedPaths});
  writeFileSync(join(f.root,'automation/config.json'),JSON.stringify(f.config));
  command(f.root,['add','.']);command(f.root,['commit','-qm','Select nested Android build with decoys']);
  return {...f,build,model,resources};
}

test('nested installation selects Git root, persisted discovery selects build root, and SDK comes from that build',()=>{
  const f=nestedFixture();try {
    assert.equal(f.resources.targetDirectory,f.root);
    assert.equal(f.resources.adaptiveTemplates.projectRoot,f.build);
    const restored=planProjectResourceInputs(f.root,{projectCapabilities:f.model});
    assert.equal(restored.targetDirectory,f.root);
    assert.equal(restored.adaptiveTemplates.detection.settingsFile,join(f.build,'settings.gradle.kts'));
    assert.equal(gradleBuildRoot(f.config,f.root),f.build);
    assert(restored.adaptiveTemplates.taskContractExample.allowedPaths.every(p=>p.startsWith('android/app/')));
    const report=runDoctor({targetDirectory:f.root,checkDependencies:true,
      environment:{},runCommand:()=>({status:0,stdout:'1.14.22\n',stderr:'',error:null})});
    const sdk=report.checks.find(c=>c.id==='android-sdk');
    assert.equal(sdk.status,'pass',JSON.stringify(sdk));
    assert(JSON.stringify(sdk).includes(f.base));
    for(const mutate of [c=>{c.androidProject.settingsFile='settings.gradle.kts'},
      c=>{c.protectedPaths=c.protectedPaths.filter(p=>p!=='android/gradlew')},
      c=>{c.androidProject.capabilities.modules[0].sources[0].paths=['sibling/code/**']},
      c=>{c.androidProject.capabilities.buildRoot='../outside'}]) {
      const config=structuredClone(f.config);mutate(config);assert.throws(()=>validateConfigurationModel(config,f.root));
    }
    renameSync(f.build,join(f.root,'real-android'));symlinkSync('real-android',f.build);
    assert.throws(()=>gradleBuildRoot(f.config,f.root),/symbolic-link/);
  }finally{f.cleanup();}
});

test('nested unattended direct Gradle invocation is refused while controlled scripts remain allowed',()=>{
  const f=nestedFixture(), previous=process.env.AUTOMATION_QUEUE_RUN_ID;
  process.env.AUTOMATION_QUEUE_RUN_ID='nested-test';
  try {
    assert.throws(()=>guardExecutorCommand({tool:'bash'},{args:{command:'./gradlew :app:testDebugUnitTest'}},f.root),/managed verification scripts/);
    guardExecutorCommand({tool:'bash'},{args:{command:'./scripts/automation/quality-gate.sh TASK-NESTED'}},f.root);
  }finally{if(previous===undefined)delete process.env.AUTOMATION_QUEUE_RUN_ID;else process.env.AUTOMATION_QUEUE_RUN_ID=previous;f.cleanup();}
});

for(const [inventoryMode,workspaceStrategy,recovery] of [[false,'inPlaceExclusive',false],[true,'inPlaceExclusive',false],[true,'isolatedWorktree',false],[true,'inPlaceExclusive',true]]) {
  test(`nested ${recovery?'V7 recovery':inventoryMode?'inventory':'classified tests'} lifecycle in ${workspaceStrategy} never executes decoy wrappers`,{timeout:180000},async()=>{
    const f=nestedFixture({inventoryMode,workspaceStrategy});try {
      const id='TASK-NESTED',contract=taskContract(f,id);
      contract.allowedPaths=contract.allowedPaths.map(p=>'android/'+p);
      contract.forbiddenPaths=f.config.protectedPaths;
      contract.targetTests[0].gradleTask=':app:testDebugUnitTest';
      if(recovery) Object.assign(contract,{schemaVersion:7,
        recovery:{version:1,scope:'baseline',maxEnvironmentRetries:1,maxManualRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:1},
        execution:{version:1,maxRunMs:180000,maxStageMs:120000,terminationGraceMs:1000},
        stageRecovery:{version:1,maxEnvironmentRetries:1,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:1}});
      const sealed=f.queue.draft({contract,plan:'# Approved nested behavior\n',...f.queue.snapshot()});
      f.queue.enqueue(sealed.key,sealed.digest,f.queue.approvalText(sealed));
      const result=await run(f);
      assert.equal(result.item.state,'AWAITING_HUMAN',result.output+result.item.waitingReason);
      f.queue.request(id,'integrate',f.config.approvalPhrases.acceptance,result.item.candidateId);
      const complete=await run(f);
      assert.equal(complete.item.state,'COMPLETED',complete.output+complete.item.waitingReason);
      assert(existsSync(join(f.root,'android/app/src/main/java/TASK-NESTED.kt')));
      const calls=readFileSync(join(f.base,'gradle-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert(calls.length>=7);
      assert(calls.every(c=>c.cwd.endsWith('/android')),JSON.stringify(calls));
      assert(calls.every(c=>resolve(c.sdk)===resolve(f.base)),JSON.stringify(calls));
      if(workspaceStrategy==='isolatedWorktree')assert(calls.some(c=>resolve(c.cwd)!==resolve(f.build)));
      const evidence=join(f.root,'.git/automation-runtime/evidence',id);
      assert(JSON.parse(readFileSync(join(evidence,recovery?'baseline-full.json':'baseline.json'),'utf8')).cwd.endsWith('/android'));
      if(inventoryMode) {
        const baseline=JSON.parse(readFileSync(join(evidence,'baseline-inventory.json'),'utf8'));
        assert(baseline.testPatterns.includes('android/app/src/test/java/**'));
        assert.equal(JSON.parse(readFileSync(join(evidence,'green-inventory.json'),'utf8')).summary.total,2);
      }
      const agents=readFileSync(join(f.base,'agent-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert(agents.every(c=>!c.cwd.endsWith('/android')));
    }finally{f.cleanup();}
  });
}
