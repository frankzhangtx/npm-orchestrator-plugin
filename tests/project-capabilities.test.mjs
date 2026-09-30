import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { validateProjectCapabilities, capabilityVerification, detectionWithCapabilities, detectAndroidProject,
  planAdaptiveProjectTemplates, parseProjectCapabilities } from '../dist/index.js';
import { createRequire } from 'node:module';
const { validateConfigurationModel } = createRequire(import.meta.url)('../templates/automation/verification/project.cjs');
const task = (module, name, kind, variant=null) => ({path:`:${module}:${name}`,kind,variant});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'android-model-'));
  const write=(name,text)=>{mkdirSync(dirname(join(root,name)),{recursive:true});writeFileSync(join(root,name),text);};
  mkdirSync(join(root,'.git'));
  write('settings.gradle',"rootProject.name='mobile'\ninclude ':handset', ':logic'\n");
  write('gradlew','#!/bin/sh\n'); write('gradle/wrapper/gradle-wrapper.properties','distributionUrl=fixture\n');
  write('handset/build.gradle',"plugins { id 'com.android.application' }\n");
  write('logic/build.gradle',"plugins { id 'java-library' }\n");
  const module=(name,type,dependencies,tasks)=>({gradlePath:`:${name}`,directory:name,buildFile:`${name}/build.gradle`,type,
    namespace:type==='application'?'example.mobile':null,applicationId:null,dependencies,
    sources:[{name:'main',kind:'production',paths:[`${name}/code/**`]},{name:'test',kind:'test',paths:[`${name}/checks/**`]}],tasks});
  const model={version:1,buildRoot:'.',modules:[module('handset','application',[':logic'],[
    task('handset','testDemoStagingUnitTest','unit','DemoStaging'),task('handset','assembleDemoStaging','assemble','DemoStaging')]),
    module('logic','jvm-library',[],[task('logic','test','unit'),task('logic','assemble','assemble')])]};
  return {root,write,model,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('custom sources, non-Debug tasks and reachable JVM dependencies drive configuration and Shell validation',()=>{
  const f=fixture();try {
    const detection=detectionWithCapabilities(detectAndroidProject(f.root),f.model);
    const matrix=capabilityVerification(f.model,':handset');
    const plan=planAdaptiveProjectTemplates(f.root,{projectDetection:detection,gradleVerification:matrix});
    assert.deepEqual(matrix.fullUnitTestTasks,[':handset:testDemoStagingUnitTest',':logic:test']);
    assert.deepEqual(matrix.assembleTasks,[':handset:assembleDemoStaging',':logic:assemble']);
    assert.deepEqual(matrix.deviceTestTasks,[]);assert.deepEqual(matrix.lintTasks,[]);
    assert.deepEqual(plan.taskContractExample.allowedPaths,['handset/code/**','logic/code/**','handset/checks/**','logic/checks/**']);
    assert.equal(plan.automationConfig.androidProject.primaryModule,':handset');
    validateConfigurationModel(plan.automationConfig,f.root);
    const primary=planAdaptiveProjectTemplates(f.root,{projectDetection:detection,moduleScope:'primary',primaryModule:':logic',gradleVerification:matrix});
    assert.deepEqual(primary.taskContractExample.allowedPaths,['logic/code/**','logic/checks/**']);
    assert.deepEqual(primary.automationConfig.gradleVerification.fullUnitTestTasks,matrix.fullUnitTestTasks);
    f.write('config.json',JSON.stringify(plan.automationConfig));
    const shell=spawnSync('node',['templates/automation/verification/project.cjs',join(f.root,'config.json'),f.root],{encoding:'utf8'});
    assert.equal(shell.status,0,shell.stderr);
    const bad=structuredClone(plan.automationConfig);bad.gradleVerification.fullUnitTestTasks=[':logic:test'];
    assert.throws(()=>validateConfigurationModel(bad,f.root),/omits module/);
    bad.gradleVerification.fullUnitTestTasks=matrix.fullUnitTestTasks;bad.androidProject.productionPaths.push('other/**');
    assert.throws(()=>validateConfigurationModel(bad,f.root),/source paths differ/);
  }finally{f.cleanup();}
});
test('new model refuses unrelated JVM modules, missing edges, unsafe/overlapping roots and fabricated tasks',()=>{
  const f=fixture();try {
    for(const mutate of [
      m=>{m.modules[0].dependencies=[]},m=>{m.modules[0].dependencies=[':missing']},
      m=>{m.modules[0].sources[0].paths=['../outside/**']},m=>{m.modules[0].sources[0].paths=['handset/build/generated/**']},
      m=>{m.modules[0].sources[0].paths=['handset/checks/**']},m=>{m.modules[0].sources[0].paths=['handset/**']},
      m=>{m.modules[0].tasks[0].path=':outside:test'},m=>{m.modules[0].type='jvm-library'},
    ]){const model=structuredClone(f.model);mutate(model);assert.throws(()=>validateProjectCapabilities(model,f.root));}
    symlinkSync('/does-not-exist',join(f.root,'linked'));
    const symlink=structuredClone(f.model);symlink.modules[0].sources[0].paths=['linked/code/**'];
    assert.throws(()=>validateProjectCapabilities(symlink,f.root),/symbolic-link/);
  }finally{f.cleanup();}
});
test('runtime model is portable and rejects duplicate, malformed and out-of-build output',()=>{
  const f=fixture();try {
    const raw=structuredClone(f.model);raw.buildRoot=f.root;
    for(const m of raw.modules){m.directory=join(f.root,m.directory);m.buildFile=join(f.root,m.buildFile);for(const s of m.sources)s.paths=s.paths.map(p=>join(f.root,p));}
    const line=m=>'OPENCODE_ANDROID_ORCHESTRATOR_MODEL='+Buffer.from(JSON.stringify(m)).toString('base64');
    assert.deepEqual(parseProjectCapabilities(line(raw),f.root,f.root),f.model);
    assert.throws(()=>parseProjectCapabilities(line(raw)+'\n'+line(raw),f.root,f.root),/duplicate/);
    raw.modules[0].sources[0].paths=['/outside/code/**'];
    assert.throws(()=>parseProjectCapabilities(line(raw),f.root,f.root));
  }finally{f.cleanup();}
});
test('Debug leads focused feedback while non-Debug variants and Android consumers remain required',()=>{
  const f=fixture();try {
    f.model.modules[0].tasks.push(task('handset','testDemoDebugUnitTest','unit','DemoDebug'),task('handset','assembleDemoDebug','assemble','DemoDebug'));
    const matrix=capabilityVerification(f.model,':handset');
    assert.deepEqual(matrix.fullUnitTestTasks,[':handset:testDemoDebugUnitTest',':handset:testDemoStagingUnitTest',':logic:test']);
    assert.deepEqual(matrix.assembleTasks,[':handset:assembleDemoStaging',':handset:assembleDemoDebug',':logic:assemble']);
  }finally{f.cleanup();}
});

test('variants without local tests retain build, lint and device gates and cannot be omitted',()=>{
  const f=fixture();try {
    f.model.modules[0].tasks.push(task('handset','assembleRelease','assemble','Release'),
      task('handset','lintRelease','lint','Release'),task('handset','connectedReleaseAndroidTest','device','Release'));
    const matrix=capabilityVerification(f.model,':handset');
    assert(matrix.assembleTasks.includes(':handset:assembleRelease'));
    assert.deepEqual(matrix.lintTasks,[':handset:lintRelease']);
    assert.deepEqual(matrix.deviceTestTasks,[':handset:connectedReleaseAndroidTest']);
    const detection=detectionWithCapabilities(detectAndroidProject(f.root),f.model);
    const plan=planAdaptiveProjectTemplates(f.root,{projectDetection:detection,gradleVerification:matrix});
    plan.automationConfig.gradleVerification.assembleTasks=matrix.assembleTasks.filter(t=>!t.endsWith('assembleRelease'));
    assert.throws(()=>validateConfigurationModel(plan.automationConfig,f.root),/build verification omits module/);
  }finally{f.cleanup();}
});
