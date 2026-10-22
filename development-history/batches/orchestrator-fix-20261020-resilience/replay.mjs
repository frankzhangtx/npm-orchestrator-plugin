import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {evaluateCoverage}=require('./source/templates/automation/verification/inventory.cjs');
const runtime='/Users/zhanglong/files/program/wordpresslocal/WordPress/.git/automation-runtime';
const queue=JSON.parse(readFileSync(runtime+'/inbox/queue.json'));
const contract=queue.items.find(x=>x.taskId==='TASK-DOMAINPHONE-001').contract;
const evidence=runtime+'/evidence/TASK-DOMAINPHONE-001';
const baseline=JSON.parse(readFileSync(evidence+'/baseline-inventory.json'));
const attempts=['red-001-229b3bde-f88e-4d86-b4be-698a93aad779','red-002-7dc941f4-cd38-4416-b4bc-ea9b62e350c4'];
const results=[];
for(const name of attempts){
 const events=readFileSync(evidence+'/inventory-attempts/'+name+'/collection/events.jsonl','utf8').trim().split('\n').map(x=>JSON.parse(x));
 const cases=events.filter(x=>x.kind==='case').map(({runId,kind,...x})=>x);
 try {evaluateCoverage(contract,baseline,{cases},'red');throw new Error('Unexpected acceptance');}
 catch(e){if(e.code!=='CASE_EXPECTATION_MISMATCH')throw e;results.push({attempt:name,reason:e.code,issues:e.issues.map(x=>({id:x.id,checks:x.failureChecks}))});}
}
console.log(JSON.stringify(results,null,2));