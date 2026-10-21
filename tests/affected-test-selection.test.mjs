import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {selectVerification}=require('../templates/automation/verification/project.cjs');
export function fixture() {
 const root=mkdtempSync(join(tmpdir(),'affected-tests-'));
 const put=(p,s)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),s);};
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
 const source='app/src/main/Phone.kt',caller='app/src/main/Contact.kt',testFile='app/src/test/PhoneTest.kt';
 put(source,'package example\nclass Phone { fun format(value: String): String { return value } }\n');
 put(caller,'package example\nclass Contact { fun display(value: String): String { return Phone().format(value) } }\n');
 put(testFile,'package example\nclass PhoneTest { @Test fun formats() { Phone().format("x") } }\n');
 put('app/src/test/ContactTest.kt','package example\nclass ContactTest { @Test fun displays() { Contact().display("x") } }\n');
 put('app/src/test/OtherTest.kt','package example\nclass OtherTest { @Test fun unrelated() { assert(true) } }\n');
 git('add','.');git('commit','-qm','Baseline');
 const m={gradlePath:':app',directory:'app',buildFile:'app/build.gradle',type:'application',namespace:'example',applicationId:'example',dependencies:[],
 sources:['main','test'].map(name=>({name,kind:name==='main'?'production':'test',paths:[`app/src/${name}/**`]})),
 tasks:[{path:':app:testDebugUnitTest',kind:'unit',variant:'Debug'},{path:':app:assembleDebug',kind:'assemble',variant:'Debug'}]};
 const config={lintEnabled:false,protectedPaths:['build.gradle'],androidProject:{settingsFile:'settings.gradle',capabilities:{version:1,buildRoot:'.',modules:[m]},
 modules:[{gradlePath:m.gradlePath,directory:m.directory,buildFile:m.buildFile,dsl:'groovy',type:m.type,namespace:m.namespace,applicationId:m.applicationId}],productionPaths:['app/src/main/**'],testPaths:['app/src/test/**']},
 gradleVerification:{fullUnitTestTasks:[':app:testDebugUnitTest'],focusedTestTasks:[':app:testDebugUnitTest'],assembleTasks:[':app:assembleDebug'],lintTasks:[],deviceTestTasks:[]}};
 const contract={id:'TASK-SELECT',planPath:'docs/plans/TASK-SELECT.md',allowedPaths:[source,testFile],targetTests:[{gradleTask:':app:testDebugUnitTest',filter:'example.PhoneTest'}],verification:{scope:{version:2,mode:'affected-tests',variants:'debug',maxManualRetries:1}}};
 return {root,put,git,source,testFile,config,contract,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('body-only edits include caller regressions and exclude unrelated tests',()=>{
 const f=fixture();try{
 f.put(f.source,'package example\nclass Phone { fun format(value: String): String { return value.trim() } }\n');
 const p=selectVerification(f.config,f.contract,f.root,[f.source]);
 assert.equal(p.testSelection.mode,'selected');assert.deepEqual(p.tasks.fullUnitTestTasks,[]);
 assert.deepEqual(p.testSelection.targets.map(t=>t.filter),['example.ContactTest','example.PhoneTest']);
 assert.deepEqual(p.tasks.assembleTasks,[':app:assembleDebug']);
 }finally{f.cleanup();}
});
test('new policy baseline selects existing related tests; legacy policy stays module-wide',()=>{
 const f=fixture();try{
 assert.equal(selectVerification(f.config,f.contract,f.root,[],true).testSelection.mode,'selected');
 f.contract.verification.scope={version:1,mode:'affected',variants:'debug',maxManualRetries:1};
 const p=selectVerification(f.config,f.contract,f.root,[f.source]);assert.equal(p.testSelection,undefined);assert.equal(p.tasks.fullUnitTestTasks.length,1);
 }finally{f.cleanup();}
});
for(const [name,edit] of [
 ['API change',f=>f.put(f.source,'package example\nclass Phone { fun format(value: Int): String { return value.toString() } }\n')],
 ['unknown dynamic dispatch',f=>f.put('app/src/main/Dynamic.kt','package example\nclass Dynamic { fun load(name: String) { Class.forName(name) } }')],
 ['missing source',f=>rmSync(join(f.root,f.source))],
 ['broad approved envelope',f=>f.contract.allowedPaths=['app/src/main/**',f.testFile]]
])test(`${name} falls back with an auditable reason`,()=>{const f=fixture();try{edit(f);const p=selectVerification(f.config,f.contract,f.root,[f.source]);assert.equal(p.testSelection.mode,'fallback');assert(p.testSelection.reasons.length);assert.equal(p.tasks.fullUnitTestTasks.length,1);}finally{f.cleanup();}});
test('new or modified test classes always join the selected set',()=>{const f=fixture();try{
 const file='app/src/test/AddedTest.kt';f.contract.allowedPaths.push(file);f.put(file,'package example\nclass AddedTest { @Test fun newBehavior() { assert(true) } }');
 const p=selectVerification(f.config,f.contract,f.root,[file]);assert.equal(p.testSelection.mode,'selected');assert(p.testSelection.targets.some(t=>t.filter==='example.AddedTest'));
}finally{f.cleanup();}});
test('Kotlin descriptive test names and unrelated unsupported sources do not discard a known mapping',()=>{
 const f=fixture();try{
  f.put(f.testFile,'package example\nclass PhoneTest { @Test fun `formats a phone number`() { Phone().format("x") } }');
  f.put('app/src/main/Unrelated.kt','package example\ntypealias Unrelated = String');
  const p=selectVerification(f.config,f.contract,f.root,[f.source]);assert.equal(p.testSelection.mode,'selected');
  f.put('app/src/main/Unrelated.kt','package example\ntypealias Unrelated = Phone');
  assert.equal(selectVerification(f.config,f.contract,f.root,[f.source]).testSelection.mode,'fallback');
 }finally{f.cleanup();}
});
for(const [name,code] of [
 ['repeated-test annotation','package example\nclass CallerTest { @RepeatedTest(2) fun repeats() { Contact().display("x") } }'],
 ['custom test annotation','package example\nclass CallerTest { @DomainTest fun checks() { Contact().display("x") } }'],
 ['Java inherited tests','package example; class CallerTest extends SharedTest { @Before public void prepare() { new Contact().display("x"); } }'],
 ['Kotlin inherited tests','package example\nclass CallerTest\n : SharedTest() { @Before fun prepare() { Contact().display("x") } }'],
 ['abstract test class','package example\nabstract class CallerTest { @Test fun checks() { Contact().display("x") } }']
])test(`reachable ${name} cannot be silently omitted from selected tests`,()=>{
 const f=fixture();try{
  f.put(`app/src/test/CallerTest.${name.startsWith('Java')?'java':'kt'}`,code);
  const p=selectVerification(f.config,f.contract,f.root,[f.source]);
  assert.equal(p.testSelection.mode,'fallback');
  assert.equal(p.tasks.fullUnitTestTasks.length,1);
 }finally{f.cleanup();}
});
test('a new approved method captures its entire existing class at baseline',()=>{
 const f=fixture();try{
  f.contract.targetTests[0].filter='example.PhoneTest.newBehavior';
  f.contract.verification.inventory={mode:'focusedBaseline',existingSkips:'reject',emptyBaseline:'allow'};
  const baseline=selectVerification(f.config,f.contract,f.root,[],true);
  assert.equal(baseline.testSelection.mode,'selected');
  assert(baseline.testSelection.targets.some(t=>t.filter==='example.PhoneTest'));
  assert(!baseline.testSelection.targets.some(t=>t.filter==='example.PhoneTest.newBehavior'));
  const current=selectVerification(f.config,f.contract,f.root,[f.source]);
  assert(current.testSelection.targets.some(t=>t.filter==='example.PhoneTest.newBehavior'));
 }finally{f.cleanup();}
});
test('an approved new class remains absent from baseline selection',()=>{
 const f=fixture();try{
  f.contract.targetTests[0].filter='example.AddedTest.newBehavior';
  f.contract.allowedPaths.push('app/src/test/AddedTest.kt');
  const p=selectVerification(f.config,f.contract,f.root,[],true);
  assert.equal(p.testSelection.mode,'selected');
  assert(!p.testSelection.targets.some(t=>t.filter.startsWith('example.AddedTest')));
  assert(p.testSelection.targets.some(t=>t.filter==='example.PhoneTest'));
 }finally{f.cleanup();}
});
for(const filter of ['example.PhoneTest.*','example.*Test'])test(`wildcard baseline ${filter} retains module verification`,()=>{
 const f=fixture();try{
  f.contract.targetTests[0].filter=filter;
  const baseline=selectVerification(f.config,f.contract,f.root,[],true);
  assert.equal(baseline.testSelection.mode,'fallback');
  assert(baseline.testSelection.reasons.some(reason=>reason.includes('wildcard baseline')));
  assert.equal(baseline.tasks.fullUnitTestTasks.length,1);
  const current=selectVerification(f.config,f.contract,f.root,[f.source]);
  assert.equal(current.testSelection.mode,'selected');
  assert(current.testSelection.targets.some(t=>t.filter===filter));
 }finally{f.cleanup();}
});
