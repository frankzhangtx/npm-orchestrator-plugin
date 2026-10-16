// Real OpenCode transport, stopped in command.execute.before before any model call.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sha256} from '../dist/queue/storage.js';
const cases=JSON.parse(readFileSync(new URL('./fixtures/native-change-arguments.json',import.meta.url),'utf8')).cases;
const root=realpathSync(mkdtempSync(join(tmpdir(),'orchestrator-native-arguments-')));
const output=join(root,'observed.json'), expected=join(root,'expected.json');
const module=pathToFileURL(fileURLToPath(new URL('../dist/queue/delegation.js',import.meta.url))).href;
try {
 assert.equal(spawnSync('git',['init','--quiet',root]).status,0);
 mkdirSync(join(root,'.opencode/commands'),{recursive:true});
 writeFileSync(join(root,'.opencode/commands/change.md'),'---\ndescription: Native argument binding diagnostic\n---\n$ARGUMENTS\n');
 const plugin=join(root,'probe.mjs');
 writeFileSync(plugin,`import {readFileSync,writeFileSync} from 'node:fs';
import {bindDelegationSession} from ${JSON.stringify(module)};
export default async()=>({'command.execute.before':async(input)=>{
 const record={grant:{requestSha256:JSON.parse(readFileSync(${JSON.stringify(expected)},'utf8')).sha256},sessionID:null,consumedAt:null};
 let error=null;try{bindDelegationSession(record,input.sessionID,input.arguments);}catch(e){error=String(e);}
 writeFileSync(${JSON.stringify(output)},JSON.stringify({arguments:input.arguments,record,error}));
 throw new Error('DIAGNOSTIC_STOP_BEFORE_MODEL');
}});
`);
 writeFileSync(join(root,'opencode.json'),JSON.stringify({plugin:[pathToFileURL(plugin).href]}));
 const env={...process.env,PWD:root};delete env.OPENCODE_ANDROID_ORCHESTRATOR_DELEGATION_ID;
 const tests=[...cases.map(c=>({...c,args:[c.request],accept:true})),
  {request:cases[0].request,args:[cases[0].request,'extra'],accept:false},
  {request:cases[0].request,args:[cases[0].request.replace('US','GB')],accept:false},
  {request:String.raw`literal \n with space`,args:['literal \n with space'],accept:false}];
 for(const [index,c] of tests.entries()){
  writeFileSync(expected,JSON.stringify({sha256:sha256(c.request)}));rmSync(output,{force:true});
  const r=spawnSync('opencode',['run','--dir',root,'--format','json','--agent','build','--command','change','--',...c.args],{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  assert.ifError(r.error);assert.equal(r.status,1,'diagnostic must stop in the hook');
  const seen=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(seen.error===null,c.accept,JSON.stringify(seen));
  assert.equal(seen.record.sessionID!==null,c.accept);assert.equal(seen.record.consumedAt,null);
  assert.equal(seen.record.grant.requestSha256,sha256(c.request));
  if(c.accept)assert.equal(seen.arguments,c.arguments);
  const events=r.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.ok(events.length>0&&events.every(e=>e.type==='error'),'no model steps or tool calls may run');
  console.log(`PASS ${index+1}/${tests.length}: native transport ${c.accept?'accepted authorized request':'rejected changed request'}`);
 }
}finally{rmSync(root,{recursive:true,force:true});}
