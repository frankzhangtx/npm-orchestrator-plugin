import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const { runPhase } = createRequire(import.meta.url)('../templates/automation/verification/inventory.cjs');
import { discoverGradleProjectConfiguration, planAdaptiveProjectTemplates, runProjectInitialization,
  installationDoctorChecks, planProjectUpgrade, applyProjectUpgrade, runProjectUpgrade, planProjectUninstall, applyProjectUninstall,
  INSTALLATION_MANIFEST_RELATIVE_PATH } from '../dist/index.js';
function files(root) { return existsSync(root) ? readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):[join(root,e.name)]) : []; }
function write(root,name,text,mode) { const p=join(root,name);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text,mode===undefined?undefined:{mode}); }

for (const nested of [false, true]) test(`real Android ${nested ? 'nested' : 'root'} build discovers custom sources, Staging variants and JVM dependencies through installation`,()=>{
  const gradle=process.env.ORCHESTRATOR_TEST_GRADLE??files(join(homedir(),'.gradle/wrapper/dists/gradle-9.4.1-all')).find(p=>p.endsWith('/bin/gradle'));
  const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk');
  assert(gradle&&existsSync(sdk),'Cached Gradle 9.4.1 and Android SDK are required');
  const root=mkdtempSync(join(process.env.ORCHESTRATOR_INVENTORY_ARTIFACTS??tmpdir(),'capabilities-android-'));
  console.log('Android capability artifacts: '+root);
  const buildRoot=nested?join(root,'android'):root;
  const prefix=nested?'android/':'';
  const junit=files(join(homedir(),'.gradle/caches/modules-2/files-2.1/junit/junit')).find(p=>p.endsWith('.jar')&&!/-sources|-javadoc/.test(p));
  const hamcrest=files(join(homedir(),'.gradle/caches/modules-2/files-2.1/org.hamcrest/hamcrest-core')).find(p=>p.endsWith('.jar')&&!/-sources|-javadoc/.test(p));
  assert(junit&&hamcrest);
  const testing=`testImplementation files(${JSON.stringify(junit)},${JSON.stringify(hamcrest)})`;
  write(root,'.gitignore','.gradle/\n**/build/\nlocal.properties\n');
  write(buildRoot,'settings.gradle',`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name='capability-sample'
include ':surface', ':feature', ':domain', ':unrelated'
project(':feature').projectDir=file('components/feature')
`);
  write(buildRoot,'build.gradle',`plugins { id 'com.android.library' version '${process.env.ORCHESTRATOR_TEST_AGP??'9.2.1'}' apply false }\n`);
  write(buildRoot,'local.properties',`sdk.dir=${sdk}\n`);
  write(buildRoot,'gradle.properties','org.gradle.workers.max=2\norg.gradle.daemon=false\n');
  write(buildRoot,'gradle/wrapper/gradle-wrapper.properties','distributionUrl=local-verified-fixture\n');
  write(buildRoot,'gradlew',`#!/usr/bin/env node\nconst r=require('node:child_process').spawnSync(${JSON.stringify(gradle)},['--offline','--no-daemon',...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`,0o755);
  for(const module of ['domain','unrelated']) {
    write(buildRoot,`${module}/build.gradle`,`plugins { id 'java-library' }\ndependencies { ${testing} }\n`);
    write(buildRoot,`${module}/src/main/java/example/${module==='domain'?'Domain':'Unrelated'}.java`,`package example; public class ${module==='domain'?'Domain':'Unrelated'} { public static int answer() { return 42; } }\n`);
    write(buildRoot,`${module}/src/test/java/example/ValueTest.java`,`package example; import org.junit.*; public class ValueTest { @Test public void value() { Assert.assertEquals(${module==='domain'?'42':'0'}, Domain.answer()); } }\n`.replace(module==='unrelated'?'Domain.answer()':'NEVER','Unrelated.answer()'));
  }
  for(const [module,folder,dep] of [['feature','components/feature','domain'],['surface','surface','feature']]) {
    write(buildRoot,`${folder}/build.gradle`,`plugins { id 'com.android.library' }
android { namespace='example.${module}'; compileSdk=36; defaultConfig { minSdk=23 }
  buildTypes { staging { initWith debug } }
  sourceSets { main { java.setSrcDirs(['code/java']); kotlin.setSrcDirs(['code/kotlin']); resources.setSrcDirs(['code/resources']); manifest.srcFile 'meta/Manifest.xml' }
    test { java.setSrcDirs(['checks/java']); kotlin.setSrcDirs(['checks/kotlin']); resources.setSrcDirs(['checks/resources']) } }
}
androidComponents { beforeVariants(selector().all()) { v -> if (v.buildType != 'staging') v.enable=false; else v.enableUnitTest=true } }
dependencies { api project(':${dep}'); ${testing} }
`);
    write(buildRoot,`${folder}/meta/Manifest.xml`,'<manifest />\n');
    write(buildRoot,`${folder}/code/java/example/${module==='feature'?'Feature':'Surface'}.java`,`package example; public class ${module==='feature'?'Feature':'Surface'} { public static int answer() { return ${module==='feature'?'Domain':'Feature'}.answer(); } }\n`);
    write(buildRoot,`${folder}/code/kotlin/example/Extra.kt`,'package example\nclass Extra { fun value(): Int = 42 }\n');
    write(buildRoot,`${folder}/checks/resources/expected.txt`,'42\n');
    write(buildRoot,`${folder}/checks/java/example/ValueTest.java`,`package example; import org.junit.*; public class ValueTest { @Test public void value() { Assert.assertEquals(42, ${module==='feature'?'Feature':'Surface'}.answer()); Assert.assertNotNull(getClass().getResource("/expected.txt")); } }\n`);
  }
  if(nested)write(buildRoot,'domain/src/main/java/example/Extra.java','package example; public class Extra { public static int answer() { return 42; } }\n');
  const run=(exe,args,options={})=>{
    const r=spawnSync(exe,args,{cwd:options.cwd??root,env:options.env??process.env,encoding:'utf8',timeout:options.timeoutMs??240000,maxBuffer:16*1024*1024});
    return {status:r.status,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null};
  };
  if(nested) for(const folder of [root,join(root,'sibling')]) {
    write(folder,'gradlew','#!/bin/sh\necho WRONG_BUILD >&2\nexit 93\n',0o755);
    write(folder,'settings.gradle',"rootProject.name='decoy'\n");
  }
  const git=(...args)=>{const r=run('git',args);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q','-b','main');git('config','user.name','Capability Test');git('config','user.email','capability@example.invalid');git('add','.');git('commit','-qm','Android capability fixture');
  const discovery=discoverGradleProjectConfiguration(buildRoot,run,{timeoutMs:240000});
  write(root,'.git/capability-discovery.json',JSON.stringify(discovery,null,2));
  assert.deepEqual(discovery.detection.capabilities.modules.map(m=>m.gradlePath),[':domain',':feature',':surface']);
  assert(discovery.gradleVerification.fullUnitTestTasks.includes(':domain:test'));
  for(const name of ['feature','surface'])assert(discovery.gradleVerification.fullUnitTestTasks.includes(`:${name}:testStagingUnitTest`));
  assert(discovery.gradleVerification.fullUnitTestTasks.every(t=>!t.includes('unrelated')&&!t.includes('Debug')));
  assert.deepEqual([...discovery.gradleVerification.assembleTasks].sort(),[':domain:assemble',':feature:assembleStaging',':surface:assembleStaging']);
  assert(discovery.detection.capabilities.modules.every(m=>m.tasks.every(t=>!t.path.includes('lintFix'))));
  const plan=planAdaptiveProjectTemplates(root,{projectDetection:discovery.detection,gradleVerification:discovery.gradleVerification});
  assert(plan.automationConfig.androidProject.productionPaths.includes(prefix+'components/feature/code/java/**'));
  assert(plan.automationConfig.androidProject.productionPaths.includes(prefix+'components/feature/meta/Manifest.xml'));
  assert(plan.automationConfig.androidProject.testPaths.includes(prefix+'components/feature/checks/resources/**'));
  const args=[...discovery.gradleVerification.fullUnitTestTasks,...discovery.gradleVerification.assembleTasks,'--console=plain'];
  const built=run(join(buildRoot,'gradlew'),args,{cwd:buildRoot});write(root,'.git/capability-build.log',built.stdout+built.stderr);
  assert.equal(built.status,0,built.stdout+built.stderr);
  assert(files(root).some(p=>p.endsWith('.aar')));
  const installRunner=(exe,args,opts)=>{
    if(exe==='opencode')return {status:0,stdout:'1.14.22\n',stderr:'',error:null};
    if(exe.endsWith('scripts/automation/tests/run-tests.sh'))return {status:0,stdout:'1..46\n',stderr:'',error:null};
    if(exe.endsWith('scripts/automation/shadow-run.sh'))return {status:0,stdout:'{"mutationPerformed":false}\n',stderr:'',error:null};
    return run(exe,args,opts);
  };
  const installed=runProjectInitialization(buildRoot,{projectDetection:discovery.detection,gradleVerification:discovery.gradleVerification,androidSdkDirectory:sdk,processRunner:installRunner});
  assert.equal(installed.managedFileCount,52);
  assert.equal(installed.targetDirectory,root);
  if(nested)assert.equal(existsSync(join(buildRoot,'automation')),false);
  const checks=installationDoctorChecks(root);assert(checks.every(c=>c.status!=='fail'),JSON.stringify(checks));
  const shell=run('bash',['-c','source scripts/automation/lib.sh; automation_validate_config']);assert.equal(shell.status,0,shell.stderr);
  assert.throws(()=>applyProjectUpgrade(planProjectUpgrade(root)),e=>e.code==='UPGRADE_NOT_REQUIRED');
  // Exercise the version-transition transaction without publishing a test package.
  // This simulates an earlier version carrying the same model, not a released
  // 1.0.4 installation (which did not have this development capability).
  const manifest=JSON.parse(readFileSync(join(root,INSTALLATION_MANIFEST_RELATIVE_PATH),'utf8'));
  manifest.package.version='1.0.4';
  write(root,INSTALLATION_MANIFEST_RELATIVE_PATH,JSON.stringify(manifest,null,2)+'\n');
  runProjectUpgrade(root,{refreshGradleDiscovery:true,processRunner:installRunner});
  assert.deepEqual(JSON.parse(readFileSync(join(root,'automation/config.json'),'utf8')).androidProject.capabilities,discovery.detection.capabilities);
  assert(installationDoctorChecks(root).every(c=>c.status!=='fail'));
  if(nested) {
    // Exercise the installed Shell helpers and collector against real Android
    // tasks in a second Git worktree. local.properties stays in the source tree.
    git('add','.');git('commit','-qm','Installed nested build');
    const worktree=join(root,'.git','nested-checkout');
    git('worktree','add','--detach',worktree,'HEAD');
    assert.equal(existsSync(join(worktree,'android/local.properties')),false);
    const fresh=run('bash',['-euc','source scripts/automation/lib.sh; automation_run_fresh_unit_tests "$AUTOMATION_ROOT" :domain:test :feature:testStagingUnitTest :surface:testStagingUnitTest'],
      {cwd:worktree,env:{...process.env,ANDROID_HOME:sdk}});
    write(root,'.git/nested-fresh-tests.log',fresh.stdout+fresh.stderr);
    assert.equal(fresh.status,0,fresh.stdout+fresh.stderr);
    const contract=JSON.parse(readFileSync(join(root,'automation/tasks/TASK-TEMPLATE.json.example'),'utf8'));
    Object.assign(contract,{id:'TASK-NESTED-REAL',title:'Return the approved extra answer',planPath:'docs/plans/TASK-NESTED-REAL.md',
      acceptanceCriteria:['Extra returns 43 while existing Android consumers retain 42'],nonGoals:['No changes to existing answers or build configuration'],
      targetTests:[{gradleTask:':domain:test',filter:'example.*'}]});
    contract.verification.cases=[{id:'EXTRA-ANSWER',criterion:1,intent:'change',before:'fail',after:'pass',source:'userRequirement',
      test:{target:0,className:'example.AddedTest',name:'approved'},expectedFailure:{type:'java.lang.AssertionError',messageIncludes:'approved extra',origin:'Approved extra answer assertion'}}];
    const contractFile=join(root,'automation/tasks/'+contract.id+'.json');
    writeFileSync(contractFile,JSON.stringify(contract));
    write(root,contract.planPath,'Approved extra answer without changing existing answers\n');
    const evidence=join(root,'.git/automation-runtime/evidence',contract.id);
    write(evidence,'baseline.json',JSON.stringify({head:git('rev-parse','HEAD')}));
    const phase=name=>runPhase(name,contractFile,join(root,'automation/config.json'),root,evidence);
    assert.equal(phase('baseline').summary.existing,1);
    write(buildRoot,'domain/src/test/java/example/AddedTest.java','package example; import org.junit.*; public class AddedTest { @Test public void approved() { Assert.assertEquals("approved extra", 43, Extra.answer()); } }\n');
    assert.equal(phase('red').summary.expectedRed,1);
    write(buildRoot,'domain/src/main/java/example/Extra.java','package example; public class Extra { public static int answer() { return 43; } }\n');
    assert.equal(phase('green').summary.total,2);
    assert.equal(phase('check').valid,true);
    const processFiles=files(evidence).filter(p=>p.endsWith('/collection/process.json'));
    assert(processFiles.every(p=>JSON.parse(readFileSync(p,'utf8')).cwd.endsWith('/android')));
    git('worktree','remove',worktree);
  }
  applyProjectUninstall(planProjectUninstall(root));
  assert.equal(existsSync(join(root,'automation/config.json')),false);
  write(buildRoot,'external-build/settings.gradle',"rootProject.name='external-build'\n");
  write(buildRoot,'external-build/build.gradle',"plugins { id 'java-library' }\n");
  write(buildRoot,'settings.gradle',readFileSync(join(buildRoot,'settings.gradle'),'utf8')+"\nincludeBuild 'external-build'\n");
  assert.throws(()=>discoverGradleProjectConfiguration(buildRoot,run,{timeoutMs:240000}),
    e=>e.code==='GRADLE_TASK_DISCOVERY_FAILED'&&e.details.some(d=>d.includes('Composite builds are not supported')));
  write(root,'.git/capability-summary.json',JSON.stringify({gradleTasks:args,model:discovery.detection.capabilities,installed:true,doctor:true,upgrade:'simulated prior-version manifest with current model',uninstall:true,modelCalls:false,nested,realWorktreeAndInventory:nested},null,2));
});
