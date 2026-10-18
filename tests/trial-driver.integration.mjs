// Deterministic packaged fixture: real installer/plugin/tools/queue/restore,
// with the OpenCode model transport and Gradle outputs supplied by fixtures.
import assert from 'node:assert/strict';
import {realpathSync,existsSync as fExists,cpSync,mkdirSync,readFileSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {fixture,taskContract,command,enqueue} from './queue-fixture.mjs';
import {runProjectInitialization} from '../dist/installer/init.js';
import {installLocalPackage} from '../dist/installer/local-package.js';
import {runtimeOutput} from './runtime-fixture.mjs';
const failNative=process.argv.includes('--fail-native');
const interruptNative=process.argv.includes('--interrupt-native');
const killNative=process.argv.includes('--kill-native');
const flag=(name)=>{const i=process.argv.indexOf(name);return i<0?null:resolve(process.argv[i+1]);};
const frozenArtifact=flag('--candidate-tgz'),originalRoot=flag('--original-package-root'),originalDependencies=flag('--original-node-modules');
if(frozenArtifact)assert.ok(originalRoot&&originalDependencies,'Frozen trials require the original package and dependency roots');
const initialize=frozenArtifact?(await import(pathToFileURL(join(originalRoot,'dist/installer/init.js')).href)).runProjectInitialization:runProjectInitialization;
const artifactRoot=resolve('../driver-fixtures');mkdirSync(artifactRoot,{recursive:true});
const f=fixture({artifactRoot,inventoryMode:true});
console.log('Fixture evidence:',f.base);
const run=(exe,args,cwd=f.root,env=f.env,timeout=240000)=>{
 const r=spawnSync(exe,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
 if(r.status!==0)throw new Error(`${exe} failed: ${r.error??r.status}\n${r.stderr}\n${r.stdout}`);return r.stdout;
};
const result=(stdout='')=>({status:0,stdout,stderr:'',error:null});
const initRunner=(exe,args)=>{
 if(exe==='opencode'&&args[0]==='--version')return result('1.15.13\n');
 if(exe.endsWith('run-tests.sh'))return result('ok 46 - fixture\n1..46\n');
 if(exe.endsWith('shadow-run.sh'))return result('{"mutationPerformed":false}\n');
 if(args.length===1&&['--version','-version'].includes(args[0]))return result('fixture version\n');
 if(exe.endsWith('gradlew')&&args[0]==='help')return result(args.some(a=>a.endsWith('runtime.init.gradle'))?runtimeOutput:
  [':app:assembleDebug',':app:connectedDebugAndroidTest',':app:lint',':app:testDebugUnitTest'].map(t=>'OPENCODE_ANDROID_ORCHESTRATOR_TASK='+t).join('\n')+'\n');
 return {status:1,stdout:'',stderr:'unexpected fixture command '+exe+' '+args.join(' '),error:null};
};
for(const path of ['.opencode','automation','scripts','docs'])rmSync(join(f.root,path),{recursive:true,force:true});
writeFileSync(join(f.root,'app/build.gradle.kts'),'plugins { id("com.android.application") }\nandroid { namespace = "example.queue"\n defaultConfig { applicationId = "example.queue" } }\n');
mkdirSync(join(f.root,'gradle/wrapper'),{recursive:true});writeFileSync(join(f.root,'gradle/wrapper/gradle-wrapper.properties'),'distributionUrl=fixture\n');
mkdirSync(join(f.base,'platforms'));mkdirSync(join(f.base,'build-tools'));
initialize(f.root,{androidSdkDirectory:f.base,installationId:'trial-baseline',processRunner:initRunner});
const old=join(f.base,'original-package'),candidate=join(f.base,'candidate-source');mkdirSync(old);
if(!frozenArtifact){
const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',f.base],process.cwd()));
run('tar',['-xzf',join(f.base,packed[0].filename),'-C',old,'--strip-components=1']);
cpSync(realpathSync(join(process.cwd(),'node_modules')),join(old,'node_modules'),{recursive:true,dereference:false,verbatimSymlinks:true});
cpSync(old,candidate,{recursive:true,dereference:false,verbatimSymlinks:true});
const pkg=JSON.parse(readFileSync(join(candidate,'package.json')));pkg.version='1.3.99-fixture.1';writeFileSync(join(candidate,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const candidatePack=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',f.base],candidate));
writeFileSync(join(f.base,'fixture-artifact-path'),join(f.base,candidatePack[0].filename));
}else{
 cpSync(originalRoot,old,{recursive:true,dereference:false,verbatimSymlinks:true});
 cpSync(originalDependencies,join(old,'node_modules'),{recursive:true,dereference:false,verbatimSymlinks:true});
}
const artifact=frozenArtifact||readFileSync(join(f.base,'fixture-artifact-path'),'utf8');
const source=installLocalPackage(artifact,join(f.base,'installed'),true);
const id='TASK-TRIAL',c={...taskContract(f,id),schemaVersion:8,maxChangedFiles:2,
 recovery:{version:1,scope:'baseline',maxEnvironmentRetries:0,maxManualRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
 execution:{version:1,maxRunMs:180000,maxStageMs:120000,terminationGraceMs:1000},
 stageRecovery:{version:1,maxEnvironmentRetries:0,maxElapsedMs:600000,initialDelayMs:1000,maxDelayMs:1000,maxSameFailureRetries:0},
 continuity:{version:1,isolatedAutoIntegration:true,planningRefresh:'reject',planningInputs:['app/src/main/java/**','app/src/test/java/**']},
 modelContinuation:{version:1,maxContinuations:1,maxCalls:4,maxElapsedMs:170000,stepLimit:64}};
writeFileSync(join(f.base,'contract.json'),JSON.stringify(c));
let mock=readFileSync(join(f.bin,'opencode'),'utf8');
mock=mock.replace("stdio:'inherit'","stdio:['ignore',2,2]");
const native=`
if(args[0]==='--version'){console.log('1.15.13');return;}
async function pluginHooks(){
 const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
 const req=createRequire(${JSON.stringify(join(old,'package.json'))});
 const config=req('jsonc-parser').parse(fs.readFileSync(fs.existsSync('opencode.jsonc')?'opencode.jsonc':'opencode.json','utf8'));
 const local=config.plugin.find(p=>p.startsWith('file:'));
 const entry=local||pathToFileURL(${JSON.stringify(join(old,'dist/opencode-plugin.js'))}).href;
 const plugin=(await import(entry)).default;
 const hooks=await plugin({directory:process.cwd(),worktree:process.cwd(),client:{},$:()=>{throw new Error('unexpected shell hook');}});
 await hooks.config(config);return {hooks,config};
}
if(args[0]==='debug'&&args[1]==='config'){
 pluginHooks().then(({config})=>console.log(JSON.stringify(config))).catch(e=>{console.error(e);process.exitCode=1;});return;
}
if(args[0]==='run'&&args.includes('--command')){
 if(${interruptNative||killNative}){fs.writeFileSync(${JSON.stringify(join(f.base,'native-started'))},'started');setInterval(()=>{},1000);return;}
 if(${failNative}){console.error('Injected native planner failure');process.exitCode=1;return;}
 (async()=>{
  const {hooks}=await pluginHooks(),sessionID='fixture-native-session';
  await hooks['command.execute.before']({command:'change',sessionID,arguments:JSON.stringify(args.at(-1))},{parts:[{type:'text',text:'native change'}]});
  const ctx={directory:process.cwd(),worktree:process.cwd(),sessionID,messageID:'fixture-planner-message',agent:'scheduled-planner',abort:new AbortController().signal};
  const snap=JSON.parse(await hooks.tool.android_orchestrator_snapshot.execute({action:'snapshot'},ctx));
  if(!snap.delegation)throw new Error('Missing native delegation');
  const contract=JSON.parse(fs.readFileSync(${JSON.stringify(join(f.base,'contract.json'))},'utf8'));
  const input={contract,plan:'# Complete fixture behavior plan with scoped tests and exact RED evidence\\n',planningHead:snap.planningHead,targetBranch:snap.targetBranch,workspaceStrategy:'isolatedWorktree',commitPolicy:'autoCommit'};
  const draft=JSON.parse(await hooks.tool.android_orchestrator_intake.execute({action:'draft',draftJson:JSON.stringify(input)},ctx));
  const item=await hooks.tool.android_orchestrator_intake.execute({action:'enqueue',key:draft.key,digest:draft.digest,approval:draft.approvalText},ctx);
  console.log(JSON.stringify({type:'text',text:item}));
 })().catch(e=>{console.error(e);process.exitCode=1;});return;
}
`;
mock=mock.replace("if (args[0] === 'debug') {",native+"\nif (args[0] === 'debug') {");writeFileSync(join(f.bin,'opencode'),mock);
writeFileSync(join(f.root,'automation/automation-commit-prefix'),'fixture:\n');
command(f.root,['add','--all']);command(f.root,['commit','-qm','Install original fixture package']);f.queue.control('pause');
enqueue(f,'TASK-HISTORY');f.queue.control('pause');
const historical=JSON.stringify(f.queue.item('TASK-HISTORY'));
const head=command(f.root,['rev-parse','HEAD']),now=Date.now();
const spec={version:1,runId:'fixture-batch',repository:f.root,evidenceDirectory:join(f.base,'trial'),batchDirectory:join(f.base,'batch'),originalHead:head,originalBranch:'main',originalPackageRoot:old,originalInstallationRoot:old,targetBranch:'trial/fixture',taskId:id,request:'Implement one "fixture" behavior with a regression test.',candidateSha256:source.sha256,allowedPaths:c.allowedPaths,targetTests:c.targetTests,
 policies:{recovery:c.recovery,execution:c.execution,stageRecovery:c.stageRecovery,continuity:c.continuity,modelContinuation:c.modelContinuation,maxFixLoops:c.maxFixLoops,deviceTestsRequired:c.deviceTestsRequired,verificationScope:c.verification.scope??null,maxPreparationFixes:c.verification.maxPreparationFixes,inventory:c.verification.inventory},
 runScope:{version:1,runId:'fixture-batch',taskKeys:[id+'@1'],expiresAt:new Date(now+240000).toISOString(),cleanupExpiresAt:new Date(now+360000).toISOString()}};
const specFile=join(f.base,'spec.json');writeFileSync(specFile,JSON.stringify(spec,null,2));
let execution;
if(interruptNative||killNative){
 const child=spawn(process.execPath,[join(source.packageRoot,'dist/cli.js'),'trial-run',specFile],{cwd:f.root,env:f.env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const exited=new Promise(resolve=>child.once('exit',(status,signal)=>resolve({status,signal})));
 const deadline=Date.now()+180000;
 while(!fExists(join(f.base,'native-started'))){assert.ok(Date.now()<deadline,'Native planner never started');assert.equal(child.exitCode,null,stderr);await new Promise(r=>setTimeout(r,100));}
 child.kill(killNative?'SIGKILL':'SIGTERM');
 const stopped=await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Driver did not stop')),120000);t.unref();})]);
 if(killNative){
  const other={...spec,runId:'other-batch',evidenceDirectory:join(f.base,'other-trial'),batchDirectory:join(f.base,'other-batch'),runScope:{...spec.runScope,runId:'other-batch'}};
  const otherFile=join(f.base,'other-spec.json');writeFileSync(otherFile,JSON.stringify(other));
  const refused=spawnSync(process.execPath,[join(source.packageRoot,'dist/cli.js'),'trial-run',otherFile],{cwd:f.root,env:f.env,encoding:'utf8',timeout:15000});
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/restoration|recovery/i);
  execution=spawnSync(process.execPath,[join(source.packageRoot,'dist/cli.js'),'trial-recover',specFile],{cwd:f.root,env:f.env,encoding:'utf8',timeout:120000});
 }else execution={...stopped,stdout,stderr};
}else execution=spawnSync(process.execPath,[join(source.packageRoot,'dist/cli.js'),'trial-run',specFile],{cwd:f.root,env:f.env,encoding:'utf8',timeout:380000,maxBuffer:8*1024*1024});
writeFileSync(join(f.base,'driver-output.log'),execution.stdout+'\n'+execution.stderr);
const ledger=JSON.parse(readFileSync(join(spec.evidenceDirectory,'trial.json')));
assert.equal(execution.status,killNative?0:(failNative||interruptNative?1:0),JSON.stringify(ledger,null,2)+'\n'+execution.stderr);
assert.equal(ledger.phase,'VERIFIED');
if(interruptNative||killNative){assert.notEqual(ledger.error,null);assert.equal(ledger.result,null);}
else if(failNative){assert.equal(ledger.result,null);assert.match(ledger.error,/Native change did not enqueue/);}
else {assert.equal(ledger.result,'COMPLETED');assert.equal(ledger.error,null);}
assert.equal(command(f.root,['rev-parse','HEAD']),head);assert.equal(command(f.root,['status','--porcelain']),'');
if(!failNative&&!interruptNative&&!killNative){const item=f.queue.item(id);assert.equal(item.authorization.source,'delegatedApproval');assert.equal(item.state,'COMPLETED');}
assert.equal(JSON.stringify(f.queue.item('TASK-HISTORY')),historical);
assert.equal(f.queue.storage.read().paused,true);console.log('Packaged driver fixture passed; retained evidence:',f.base);

const replay=spawnSync(process.execPath,[join(source.packageRoot,'dist/cli.js'),'trial-run',specFile],{cwd:f.root,env:f.env,encoding:'utf8',timeout:30000});
assert.equal(replay.status,failNative||interruptNative||killNative?1:0,replay.stderr);
assert.deepEqual(JSON.parse(readFileSync(join(spec.evidenceDirectory,'trial.json'))),ledger);
assert.equal(JSON.stringify(f.queue.item('TASK-HISTORY')),historical);

// A historical VERIFIED ledger cannot certify a later drifted installation.
const manifest=join(f.root,'.automation-plugin/manifest.json'),originalManifest=readFileSync(manifest);
writeFileSync(manifest,originalManifest.toString()+' ');
const drifted=spawnSync(process.execPath,[join(source.packageRoot,'dist/cli.js'),'trial-run',specFile],{cwd:f.root,env:f.env,encoding:'utf8',timeout:30000});
assert.notEqual(drifted.status,0,'Verified replay must check current installation');
assert.deepEqual(readFileSync(manifest),Buffer.from(originalManifest.toString()+' '),'Acceptance must not repair drift');
writeFileSync(manifest,originalManifest);
