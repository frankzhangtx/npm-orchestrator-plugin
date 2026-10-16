import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBoundedModel } from '../dist/queue/model-process.js';
import { processIdentity } from '../dist/queue/storage.js';
async function probe(program, overrides={}) {
 const root=mkdtempSync(join(tmpdir(),'orchestrator-model-process-'));
 try {
  const file=join(root,'host.cjs');writeFileSync(file,program);
  const result=await runBoundedModel({cwd:root,agent:'scheduled-coder',prompt:'fixture',stepLimit:1,deadline:Date.now()+10000,graceMs:100,
   eventLog:join(root,'events.jsonl'),stderrLog:join(root,'stderr.log'),command:[process.execPath,file],...overrides});
  return {result,log:readFileSync(join(root,'events.jsonl'),'utf8')};
 }finally{rmSync(root,{recursive:true,force:true});}
}
const start={type:'step_start',sessionID:'session',part:{id:'start1',type:'step-start',sessionID:'session',messageID:'message1'}};
const finish={type:'step_finish',sessionID:'session',part:{id:'finish1',type:'step-finish',sessionID:'session',messageID:'message1'}};
const emit=e=>`process.stdout.write(${JSON.stringify(JSON.stringify(e)+'\n')});`;

test('owned step cutoff terminates the host and detached descendants before authorizing handoff', {timeout:30000}, async()=>{
 const program=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});`+
  `process.stdout.write(JSON.stringify({type:'text',childPid:c.pid})+'\\n');setTimeout(()=>{${emit(start)}${emit(finish)}},100);setInterval(()=>{},1000);`;
 const {result,log}=await probe(program);
 assert.equal(result.reason,'STEP_BUDGET');assert.equal(result.steps,1);assert.equal(result.processesExited,true);
 const child=JSON.parse(log.split('\n')[0]).childPid;assert.equal(processIdentity(child),null);
});
test('model prose and exit zero do not establish a budget stop', async()=>{
 const {result}=await probe(emit({type:'text',text:'Maximum steps for this agent have been reached.'})+'setTimeout(()=>process.exit(0),300);');
 assert.equal(result.reason,'EXITED');assert.equal(result.steps,0);assert.equal(result.exitCode,0);
});
test('malformed events and wall-clock deadlines never authorize step continuation', async()=>{
 const invalid=await probe("setTimeout(()=>process.stdout.write('invalid\\n'),100);setInterval(()=>{},1000);");
 assert.equal(invalid.result.reason,'INVALID_EVENTS');
 const deadline=await probe('setInterval(()=>{},1000);',{deadline:Date.now()+500});
 assert.equal(deadline.result.reason,'DEADLINE');
});

test('driver restart recovers its recorded Planner without relaunching the native command', {timeout:30000},async()=>{
 const {spawn}=await import('node:child_process');
 const {pathToFileURL}=await import('node:url');
 const {existsSync}=await import('node:fs');
 const {recoverModelProcesses}=await import('../dist/queue/model-process.js');
 const root=mkdtempSync(join(tmpdir(),'orchestrator-planner-recovery-'));
 const ownership=join(root,'ownership.json'),runner=join(root,'runner.mjs');
 let child,record;
 try {
  const module=pathToFileURL(join(process.cwd(),'dist/queue/model-process.js')).href;
  writeFileSync(runner,`import {runBoundedModel} from ${JSON.stringify(module)};await runBoundedModel(${JSON.stringify({cwd:root,agent:'scheduled-planner',nativeCommand:'change',prompt:'one requirement',stepLimit:64,deadline:Date.now()+20000,graceMs:100,ownershipRecord:ownership,eventLog:join(root,'events'),stderrLog:join(root,'stderr'),command:[process.execPath,'-e','setInterval(()=>{},1000)']})});`);
  child=spawn(process.execPath,[runner],{stdio:'ignore'});
  const end=Date.now()+10000;
  while(Date.now()<end){
   if(existsSync(ownership)){record=JSON.parse(readFileSync(ownership,'utf8'));if(record.root)break;}
   await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(record?.root);
  const witness=record.known.find(p=>p.pid===record.root.pid);
  assert.equal(witness?.started,record.root.started);assert.equal(witness?.pgid,record.root.pid);
  const {ownedTree}=await import('../dist/queue/process-ownership.js');
  assert.deepEqual(ownedTree([{...witness,owned:false}],record.root,record.known),[{...witness,owned:false}]);
  assert.throws(()=>ownedTree([{...witness,started:'different',owned:false}],record.root,record.known),/identity changed/);
  child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));
  await recoverModelProcesses(ownership,100,Date.now()+10000);
  assert.equal(processIdentity(record.root.pid),null);
  assert.equal(JSON.parse(readFileSync(ownership,'utf8')).state,'EXITED');
  await recoverModelProcesses(ownership,100,Date.now()+10000);
 } finally {
  child?.kill('SIGKILL');
  if(record?.root)await recoverModelProcesses(ownership,100,Date.now()+10000);
  rmSync(root,{recursive:true,force:true});
 }
});

test('fast failing hosts preserve their actual exit without an ownership race', {timeout:30000}, async()=>{
 for(let i=0;i<8;i++){
  const {result}=await probe('process.exit(7);');
  assert.equal(result.reason,'EXITED');assert.equal(result.exitCode,7);assert.equal(result.processesExited,true);
 }
});
