import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {sameCandidate}=require('../templates/automation/verification/verification-reuse.cjs');
const {validateSelected}=require('../templates/automation/verification/selected-tests.cjs');
const {apiShape}=require('../templates/automation/verification/test-selection.cjs');
test('reuse requires identical inputs, environment, baseline and evidence',()=>{
 const old={head:'old',diffSha256:'diff',inputsSha256:'source',actualEnvironmentSha256:'jvm',evidence:{red:'sealed'}};
 assert(sameCandidate(old,structuredClone(old)));
 for(const key of Object.keys(old)){const changed={...old,[key]:'changed'};assert(!sameCandidate(old,changed),key);}
 const committed={...old,head:'new',diffSha256:'empty'};
 assert(!sameCandidate(old,committed));assert(!sameCandidate(old,committed,{integration:true,base:'old'}));
 assert(!sameCandidate(old,committed,{integration:true,base:'unrelated'}));
 assert(!sameCandidate(old,{...committed,inputsSha256:'changed'},{integration:true,base:'old'}));
});
test('every selected filter must have real passing cases; missing and skipped tests fail',()=>{
 const targets=[{gradleTask:':app:test',filter:'a.PhoneTest'},{gradleTask:':app:test',filter:'a.CallerTest'}];
 const cases=targets.map(t=>({taskPath:t.gradleTask,className:t.filter,name:'behavior',result:'SUCCESS'}));
 assert.equal(validateSelected(targets,{cases}),2);
 assert.throws(()=>validateSelected(targets,{cases:cases.slice(0,1)}),/No executed cases/);
 for(const result of ['SKIPPED','FAILURE'])assert.throws(()=>validateSelected(targets,{cases:[cases[0],{...cases[1],result}]}),/failed or were skipped/);
});
test('method-only classification does not hide changed literals outside method bodies',()=>{
 const code=value=>`class Phone { private val separator = "${value}"; fun format(x: String): String { return x } }`;
 assert.notEqual(apiShape(code(' ')),apiShape(code('')));
 assert.notEqual(apiShape(code('.')),apiShape(code('-')));
 assert.equal(apiShape(code('.')),apiShape(code('.').replace('return x','return x.trim()')));
});
