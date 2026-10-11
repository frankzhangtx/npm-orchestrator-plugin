import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { selectVerification } = require('../templates/automation/verification/project.cjs');
const { classifyFailure } = require('../templates/automation/verification/recovery.cjs');

function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'impact-selection-'));
  const module = (id, dependencies = [], jvm = false) => {
    const variants = jvm ? [null] : ['FreeDebug', 'PaidDebug', 'FreeRelease', 'PaidRelease'];
    return { gradlePath: `:${id}`, directory: id, buildFile: `${id}/build.gradle`, type: jvm ? 'jvm-library' : 'application',
      namespace: null, applicationId: null, dependencies,
      sources: (jvm ? ['main', 'test'] : ['main', 'free', 'release', 'test', 'testFreeDebug']).map(name =>
        ({ name, kind: name.startsWith('test') ? 'test' : 'production', paths: [`${id}/src/${name}/**`] })),
      tasks: variants.flatMap(variant => ['unit', 'assemble', ...(jvm ? [] : ['lint', 'device'])].map(kind => ({kind,variant,
        path:`:${id}:${kind === 'unit' ? (jvm ? 'test' : `test${variant}UnitTest`) : kind === 'device' ? `connected${variant}AndroidTest` : kind + (variant ?? '')}`}))) };
  };
  const modules = [module('app', [':shared']), module('other'), module('shared', [':core']), module('core', [], true)];
  modules[0].tasks.push({path:':app:assembleFree',kind:'assemble',variant:'Free'}, {path:':app:assembleDebug',kind:'assemble',variant:'Debug'});
  const config = {lintEnabled:true,protectedPaths:['settings.gradle','**/build.gradle'],
    androidProject:{settingsFile:'settings.gradle',capabilities:{version:1,buildRoot:'.',modules},
      modules:modules.map(m=>({gradlePath:m.gradlePath,directory:m.directory,buildFile:m.buildFile,dsl:'groovy',type:m.type,namespace:m.namespace,applicationId:m.applicationId})),
      productionPaths:modules.flatMap(m=>m.sources.filter(s=>s.kind==='production').flatMap(s=>s.paths)),
      testPaths:modules.flatMap(m=>m.sources.filter(s=>s.kind==='test').flatMap(s=>s.paths))},
    gradleVerification:Object.fromEntries(Object.entries({fullUnitTestTasks:'unit',focusedTestTasks:'unit',assembleTasks:'assemble',lintTasks:'lint',deviceTestTasks:'device'})
      .map(([group,kind])=>[group,modules.flatMap(m=>m.tasks.filter(t=>t.kind===kind).map(t=>t.path))]))};
  const contract = {id:'TASK-IMPACT',planPath:'docs/plans/TASK-IMPACT.md',allowedPaths:['app/src/main/**','app/src/test/**'],targetTests:[{gradleTask:':app:testFreeDebugUnitTest'}],
    verification:{scope:{version:1,mode:'affected',variants:'debug',maxManualRetries:1}}};
  return {root,config,contract,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('production edits select only affected Debug flavors and remove aggregate builds',()=>{
  const f=scenario();try {
    const plan=selectVerification(f.config,f.contract,f.root,['app/src/main/Phone.kt']);
    assert.deepEqual(plan.affectedModules,[':app']);
    assert.deepEqual(plan.tasks.assembleTasks,[':app:assembleFreeDebug',':app:assemblePaidDebug']);
    assert.deepEqual(plan.tasks.fullUnitTestTasks,[':app:testFreeDebugUnitTest',':app:testPaidDebugUnitTest']);
    assert(plan.tasks.lintTasks.every(t=>t.endsWith('Debug')));
    assert(!JSON.stringify(plan.tasks).includes('Release'));
  }finally{f.cleanup();}
});
test('flavor-specific edits narrow variants; library changes include transitive consumers',()=>{
  const f=scenario();try {
    f.contract.allowedPaths=['app/src/free/**'];
    assert.deepEqual(selectVerification(f.config,f.contract,f.root,['app/src/free/File.kt']).tasks.assembleTasks,[':app:assembleFreeDebug']);
    f.contract.allowedPaths=['core/src/main/**'];
    const plan=selectVerification(f.config,f.contract,f.root,['core/src/main/Api.kt']);
    assert.deepEqual(plan.affectedModules,[':app',':core',':shared']);
    assert(plan.tasks.assembleTasks.includes(':core:assemble'));
    assert(!plan.tasks.assembleTasks.some(t=>t.startsWith(':other:')));
  }finally{f.cleanup();}
});
test('test-only changes run relevant unit suites without unrelated application packaging',()=>{
  const f=scenario();try {
    const plan=selectVerification(f.config,f.contract,f.root,['app/src/test/PhoneTest.kt']);
    assert.deepEqual(plan.tasks.assembleTasks,[]);
    assert.equal(plan.tasks.fullUnitTestTasks.length,2);
  }finally{f.cleanup();}
});
test('Release sources, unknown paths and missing task capabilities cannot silently pass Debug verification',()=>{
  const f=scenario();try {
    f.contract.allowedPaths=['app/src/release/**'];
    assert.throws(()=>selectVerification(f.config,f.contract,f.root,['app/src/release/File.kt']),/not covered/);
    f.contract.verification.scope.variants='all';
    assert.deepEqual(selectVerification(f.config,f.contract,f.root,['app/src/release/File.kt']).tasks.assembleTasks,[':app:assembleFreeRelease',':app:assemblePaidRelease']);
    f.contract.allowedPaths=['unknown/**'];
    assert.throws(()=>selectVerification(f.config,f.contract,f.root,['unknown/file']),/cannot map/);
    f.contract.allowedPaths=['app/src/main/**'];
    f.config.gradleVerification.assembleTasks=[];
    assert.throws(()=>selectVerification(f.config,f.contract,f.root,['app/src/main/File.kt']),/omits module/);
  }finally{f.cleanup();}
});
test('baseline uses the approved path envelope and actual selection retains explicit acceptance tasks',()=>{
  const f=scenario();try {
    f.contract.allowedPaths.push('shared/src/main/**');
    const plan=selectVerification(f.config,f.contract,f.root,[],true);
    assert.deepEqual(plan.affectedModules,[':app',':shared']);
    f.contract.verification.criteriaEvidence=[{kind:'build',references:[':other:assembleFreeDebug']}];
    assert(selectVerification(f.config,f.contract,f.root,['app/src/main/File.kt']).tasks.assembleTasks.includes(':other:assembleFreeDebug'));
  }finally{f.cleanup();}
});
test('dependency TLS interruptions are retryable while certificate, authorization, missing artifacts and code failures are not',()=>{
  const transport="Could not GET 'https://repo.example.org/react-android-0.73.3-release.aar'\nRemote host terminated the handshake";
  const result=classifyFailure({phase:'assemble',log:transport,exitCode:1});
  assert.equal(result.retryable,true);assert.equal(result.reasonCode,'DEPENDENCY_TRANSPORT_FAILURE');
  assert.deepEqual(result.dependency,{host:'repo.example.org',artifact:'react-android-0.73.3-release.aar'});
  for(const text of ['PKIX path building failed','Received status code 401','HTTP 404','Compilation failed','AssertionError'])
    assert.equal(classifyFailure({phase:'assemble',log:transport+'\n'+text,exitCode:1}).retryable,false,text);
  assert.equal(classifyFailure({phase:'assemble',log:'Remote host terminated the handshake',exitCode:1}).retryable,false);
});

test('dependency impact widens a directly edited consumer without accepting Release-only edits as Debug',()=>{
 const f=scenario();try{
   f.contract.allowedPaths=['app/src/free/**','core/src/main/**','app/src/release/**'];
   const selected=selectVerification(f.config,f.contract,f.root,['app/src/free/Flavor.kt','core/src/main/Api.kt']);
   assert.deepEqual(selected.selectedVariants[':app'],['FreeDebug','PaidDebug']);
   assert.throws(()=>selectVerification(f.config,f.contract,f.root,['app/src/release/Release.kt','core/src/main/Api.kt']),/not covered/);
 }finally{f.cleanup();}
});
