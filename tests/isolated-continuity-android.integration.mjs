import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { discoverGradleProjectConfiguration, planAdaptiveProjectTemplates } from '../dist/index.js';
import { fixture, taskContract, command, run } from './queue-fixture.mjs';

const files = root => existsSync(root) ? readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):[join(root,e.name)]) : [];
function write(root,path,text,mode) {
  const file=join(root,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text,mode?{mode}:undefined);
}

test('real Android queue automatically integrates isolated tasks and refreshes a dependent planning baseline', {timeout:1500000},async()=>{
  const artifacts=process.env.ORCHESTRATOR_CONTINUITY_ARTIFACTS??tmpdir();mkdirSync(artifacts,{recursive:true});
  const f=fixture({artifactRoot:artifacts,inventoryMode:true,workspaceStrategy:'isolatedWorktree',commitPolicy:'autoCommit',autoCleanupWorktrees:true});
  console.log('Retained Android continuity artifacts: '+f.base);
  const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk');
  const gradle=process.env.ORCHESTRATOR_TEST_GRADLE??files(join(homedir(),'.gradle/wrapper/dists/gradle-9.4.1-all')).find(p=>p.endsWith('/bin/gradle'));
  const junit=files(join(homedir(),'.gradle/caches/modules-2/files-2.1/junit/junit')).find(p=>p.endsWith('.jar')&&!/-sources|-javadoc/.test(p));
  const hamcrest=files(join(homedir(),'.gradle/caches/modules-2/files-2.1/org.hamcrest/hamcrest-core')).find(p=>p.endsWith('.jar')&&!/-sources|-javadoc/.test(p));
  assert(gradle&&junit&&hamcrest&&existsSync(sdk),'Cached Gradle, JUnit and Android SDK are required');
  f.env.ANDROID_HOME=sdk;f.env.ANDROID_SDK_ROOT=sdk;
  write(f.root,'.gitignore',readFileSync(join(f.root,'.gitignore'),'utf8')+'local.properties\n');
  write(f.root,'local.properties',`sdk.dir=${sdk}\n`);
  write(f.root,'settings.gradle.kts','pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositories { google(); mavenCentral() } }\nrootProject.name="continuity-android"\ninclude(":app")\n');
  write(f.root,'build.gradle',`plugins { id 'com.android.library' version '${process.env.ORCHESTRATOR_TEST_AGP??'9.2.1'}' apply false }\n`);
  unlinkSync(join(f.root,'app/build.gradle.kts'));
  write(f.root,'app/build.gradle',`plugins { id 'com.android.library' }
android { namespace='example.continuity'; compileSdk=36; defaultConfig { minSdk=23 } }
androidComponents { beforeVariants(selector().all()) { v -> if(v.buildType!='debug') v.enable=false; else v.enableUnitTest=true } }
dependencies { testImplementation files(${JSON.stringify(junit)},${JSON.stringify(hamcrest)}) }
`);
  write(f.root,'app/src/main/AndroidManifest.xml','<manifest />\n');
  write(f.root,'gradle.properties','org.gradle.workers.max=2\norg.gradle.daemon=false\n');
  write(f.root,'gradle/wrapper/gradle-wrapper.properties','distributionUrl=local-verified-fixture\n');
  write(f.root,'gradlew',`#!/usr/bin/env node
const r=require('node:child_process').spawnSync(${JSON.stringify(gradle)},['--offline','--no-daemon',...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);
`,0o755);
  for(const name of ['Domain','TaskA','TaskB'])write(f.root,`app/src/main/java/example/${name}.java`,`package example; public class ${name} { public static int answer() { return 42; } }\n`);
  write(f.root,'app/src/test/java/example/LegacyTest.java','package example; import org.junit.*; public class LegacyTest { @Test public void preserved() { Assert.assertEquals(42, Domain.answer()); } }\n');
  const processRunner=(exe,args,options={})=>{
    const r=spawnSync(exe,args,{cwd:options.cwd??f.root,env:f.env,encoding:'utf8',timeout:options.timeoutMs??240000,maxBuffer:16*1024*1024});
    return {status:r.status,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null};
  };
  const discovery=discoverGradleProjectConfiguration(f.root,processRunner,{timeoutMs:240000});
  write(f.base,'discovery.json',JSON.stringify(discovery,null,2));
  const plan=planAdaptiveProjectTemplates(f.root,{projectDetection:discovery.detection,gradleVerification:discovery.gradleVerification});
  Object.assign(f.config,{androidProject:plan.automationConfig.androidProject,gradleVerification:plan.automationConfig.gradleVerification,protectedPaths:plan.automationConfig.protectedPaths});
  write(f.root,'automation/config.json',JSON.stringify(f.config,null,2));
  const agent=join(f.bin,'opencode'),prefix=readFileSync(agent,'utf8').split("if(args[0]!=='run')")[0];
  writeFileSync(agent,prefix+`if(args[0]!=='run')process.exit(3);
const role=args[args.indexOf('--agent')+1],id=args.at(-1).match(/TASK-[A-Z0-9-]+/)[0],name='Task'+id.split('-').at(-1);
const run=(script,extra=[])=>{ const r=cp.spawnSync('./scripts/automation/'+script+'.sh',[id,...extra],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1); };
fs.appendFileSync(${JSON.stringify(join(f.base,'model-fixture-calls.jsonl'))},JSON.stringify({id,role})+'\\n');
if(role==='scheduled-coder') {
 fs.writeFileSync('app/src/test/java/example/'+name+'Test.java','package example; import org.junit.*; public class '+name+'Test { @Test public void approved() { Assert.assertEquals("approved answer", 43, '+name+'.answer()); } }\\n');
 run('record-red');
 fs.writeFileSync('app/src/main/java/example/'+name+'.java','package example; public class '+name+' { public static int answer() { return 43; } }\\n');
 run('quality-gate');
} else if(role==='scheduled-reviewer')run('submit-review',['APPROVED','Independent fixture review checks scoped implementation and actual Android verification.']);
else process.exit(4);
`);
  command(f.root,['add','.']);command(f.root,['commit','-qm','Real Android continuity fixture']);
  const baseline=command(f.root,['rev-parse','main']);
  for(const letter of ['A','B']) {
    const id='TASK-REAL-'+letter,name='Task'+letter,value=taskContract(f,id);
    Object.assign(value,{schemaVersion:8,allowedPaths:[`app/src/main/java/example/${name}.java`,`app/src/test/java/example/${name}Test.java`],
      forbiddenPaths:f.config.protectedPaths,targetTests:[{gradleTask:':app:testDebugUnitTest',filter:'example.*'}],
      recovery:{version:1,scope:'baseline',maxEnvironmentRetries:0,maxManualRetries:0,maxElapsedMs:900000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
      execution:{version:1,maxRunMs:600000,maxStageMs:300000,terminationGraceMs:1000},
      stageRecovery:{version:1,maxEnvironmentRetries:0,maxElapsedMs:900000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
      continuity:{version:1,isolatedAutoIntegration:true,planningRefresh:'completedQueueTasks',planningInputs:[`app/src/main/java/example/${name}.java`,`app/src/test/java/example/${name}Test.java`,'app/src/main/java/example/Domain.java','app/src/test/java/example/LegacyTest.java']}});
    value.verification.cases=[{id:'APPROVED-ANSWER',criterion:1,intent:'change',before:'fail',after:'pass',source:'userRequirement',
      test:{target:0,className:'example.'+name+'Test',name:'approved'},expectedFailure:{type:'java.lang.AssertionError',messageIncludes:'approved answer',origin:'Approved task-specific answer assertion'}}];
    const draft=f.queue.draft({contract:value,plan:'# Approve task-specific answer 43 and preserve all other answers\n',...f.queue.snapshot(),...(letter==='B'?{dependsOn:['TASK-REAL-A']}:{})});
    f.queue.enqueue(draft.key,draft.digest,f.queue.approvalText(draft));
  }
  for(const letter of ['A','B']) {
    const result=await run(f,{timeoutMs:660000});
    write(f.base,'task-'+letter+'.log',result.output);
    assert.equal(result.item.state,'COMPLETED',result.output+result.item.waitingReason);
    assert.equal(existsSync(result.item.taskRoot),false);
    const evidence=join(f.queue.storage.runtime,'evidence','TASK-REAL-'+letter);
    assert.equal(JSON.parse(readFileSync(join(evidence,'integration.json'))).authorizationSource,'contractAutoCommit');
    const inventory=JSON.parse(readFileSync(join(evidence,'green-inventory.json')));
    assert.equal(inventory.summary.total,letter==='A'?2:3);
  }
  assert.equal(command(f.root,['rev-list','--count',`${baseline}..main`]),'2');
  assert.equal(command(f.root,['status','--porcelain']),'');
  const refresh=JSON.parse(readFileSync(join(f.queue.storage.runtime,'evidence/TASK-REAL-B/planning-baseline.json')));
  assert.deepEqual(refresh.refresh.integratedTasks,['TASK-REAL-A@1']);
  write(f.base,'summary.json',JSON.stringify({baseline,head:command(f.root,['rev-parse','main']),tasks:2,localCommits:2,
    realAndroid:true,modelCalls:false,simulatedCoderAndReviewer:true,planningRefresh:refresh,worktreesCleaned:true,pushed:false},null,2)+'\n');
});
