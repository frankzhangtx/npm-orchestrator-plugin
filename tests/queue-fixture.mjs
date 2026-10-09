import { runtimeOutput } from "./runtime-fixture.mjs";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskQueue, publicRun } from "../dist/queue/queue.js";
import { releaseStoppedLeases } from "../dist/queue/service.js";

const templates = fileURLToPath(new URL("../templates/", import.meta.url));
export function command(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export function fixture(options = {}) {
  const { detachedAgentCommands = false, structuredCaseMode = "valid", inventoryMode = false, inventoryFailure = null,
    reviewChanges = 0, interruptReviewer = false, baselineFault = null, workerHang = null, stageFaults = [],
    deleteProduction = false, artifactRoot = tmpdir(), ...configOptions } = options;
  const base = mkdtempSync(join(artifactRoot, "orchestrator-queue-test-"));
  const root = join(base, "project");
  cpSync(templates, root, { recursive: true });
  const bin = join(base, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "app/src/main/java"), { recursive: true });
  mkdirSync(join(root, "app/src/test/java"), { recursive: true });
  writeFileSync(join(root, "app/src/main/java/Baseline.kt"), "class Baseline\n");
  if (inventoryMode) writeFileSync(join(root, "app/src/test/java/LegacyTest.kt"), "class LegacyTest\n");
  writeFileSync(join(root, ".gitignore"), ".automation-plugin/\n.gradle/\n**/build/\n");
  writeFileSync(join(root, "opencode.json"), "{}\n");
  writeFileSync(join(root, "settings.gradle.kts"), 'rootProject.name = "queue-fixture"\ninclude(":app")\n');
  writeFileSync(join(root, "app/build.gradle.kts"), 'plugins { id("com.android.application") }\n');
  const config = JSON.parse(readFileSync(join(root, "automation/config.json"), "utf8"));
  Object.assign(config, configOptions, { worktreeBase: join(base, "worktrees"), commitMessagePrefixMode: "disabled",
    androidProject: { name: "queue-fixture", gradleDsl: "kotlin", settingsFile: "settings.gradle.kts", moduleScope: "all", primaryModule: ":app",
      modules: [{ gradlePath: ":app", directory: "app", buildFile: "app/build.gradle.kts", dsl: "kotlin", type: "application", namespace: "example.queue", applicationId: "example.queue" }],
      productionPaths: ["app/src/main/**"], testPaths: ["app/src/test/**", "app/src/androidTest/**"] } });
  if (inventoryMode) config.gradleVerification.focusedTestTasks.push(":app:testDebugUnitTest");
  writeFileSync(join(root, "automation/config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, "gradlew"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(base, "gradle-calls.jsonl"))}, JSON.stringify({cwd:process.cwd(),args,at:Date.now()})+'\\n');
const inventoryArg = args.find(arg=>arg.startsWith('-Dorchestrator.inventoryRequest='));
console.log(${JSON.stringify(runtimeOutput.trim())});
if(args[0]==='help') process.exit(0);
for (const fault of ${JSON.stringify(stageFaults)}) {
  if (fault.phase !== process.env.AUTOMATION_STAGE_RECOVERY_PHASE) continue;
  const part=inventoryArg?'inventory':args.includes('testDebugUnitTest')?'full':'assemble';
  if (fault.part && fault.part!==part) continue;
  if (fault.calls) {
    const callFile=${JSON.stringify(join(base, "stage-calls-"))}+fault.phase+'-'+part;
    const call=fs.existsSync(callFile)?Number(fs.readFileSync(callFile,'utf8'))+1:1;
    fs.writeFileSync(callFile,String(call));
    if (!fault.calls.includes(call)) continue;
  }
  const counter=${JSON.stringify(join(base, "stage-fault-"))}+fault.phase;
  const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;
  if (count>=fault.failures) continue;
  fs.writeFileSync(counter,String(count+1));
  console.error(fault.message);process.exit(1);
}
const baselineFault=${JSON.stringify(baselineFault)};
const workerHang=${JSON.stringify(workerHang)};
const hangMarker=${JSON.stringify(join(base, "hanging-processes.json"))};
const integrationHang=workerHang==='integration';
const integrationReady=!integrationHang || (fs.existsSync('.git/automation-runtime/evidence/TASK-COMMIT/commit-transaction.json') && !fs.existsSync(hangMarker));
if(workerHang && integrationReady && process.env.AUTOMATION_WORKER_TOKEN && !inventoryArg && args.includes('testDebugUnitTest') && !args.includes('--tests')) {
  const cp=require('node:child_process');
  const hold="process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
  const child=cp.spawn(process.execPath,['-e',hold],{detached:true,stdio:'ignore'});child.unref();
  fs.writeFileSync(${JSON.stringify(join(base, "hanging-processes.json"))},JSON.stringify({parent:process.pid,child:child.pid,args}));
  process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
  return;
}
function injectBaselineFault(stage) {
  if(!baselineFault || baselineFault.stage!==stage) return;
  const counter=${JSON.stringify(join(base, "baseline-fault-count"))};
  const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;
  if(count>=baselineFault.failures) return;
  fs.writeFileSync(counter,String(count+1));
  console.error(baselineFault.message); process.exit(1);
}
if(!inventoryArg && args.includes('testDebugUnitTest') && !args.includes('--tests')) injectBaselineFault('full');
if (inventoryArg) {
  const request=JSON.parse(fs.readFileSync(inventoryArg.slice('-Dorchestrator.inventoryRequest='.length)));
  const id=request.targets[0].filter;
  const taskPath=request.targets[0].gradleTask;
  const discovery=args.includes('--dry-run');
  const phase=request.phase;
  if(phase==='baseline') injectBaselineFault(discovery?'discovery':'collection');
  const failureMode=${JSON.stringify(inventoryFailure)};
  const implemented=fs.existsSync('app/src/main/java/'+id+'.kt');
  const row=(name,result)=>({kind:'case',taskPath,className:id,name,result,failures:result==='FAILURE'?[{type:'java.lang.AssertionError',message:'expected missing behavior',stack:[id+'.'+name+'(FeatureTest.kt:20)']}]:[]});
  const cases=discovery?[]:[row('legacy',failureMode==='baseline'||(failureMode==='regression'&&phase==='red')?'FAILURE':'SUCCESS'),
    ...(phase==='baseline'?[]:[row('approved behavior',implemented?'SUCCESS':'FAILURE')])];
  if(!discovery && fs.existsSync('app/src/test/java/ExtraTest.kt')) cases.push(row('supplement', fs.readFileSync('app/src/test/java/ExtraTest.kt','utf8').includes('requires-implementation')&&!implemented?'FAILURE':'SUCCESS'));
  if(failureMode==='missing-green'&&phase==='green')cases.shift();
  const events=[{kind:'start',phase},{kind:'task',taskPath,filters:[id],sourceRoots:[require('node:path').resolve('app/src/test/java')]}];
  if(!discovery)events.push(...cases,{kind:'suite',taskPath,tests:cases.length,failures:cases.filter(c=>c.result==='FAILURE').length,skipped:0},
    {kind:'taskEnd',taskPath,executed:true,skipped:false,noSource:false,upToDate:false,failure:null});
  if((failureMode!=='interrupted'||phase!=='red')&&(failureMode!=='interrupted-baseline'||phase!=='baseline'))events.push({kind:'end',failure:null});
  fs.writeFileSync(request.output,events.map(e=>JSON.stringify({...e,runId:request.runId})).join('\\n')+'\\n');
  console.log('BUILD SUCCESSFUL');process.exit(0);
}
const filterIndex = args.indexOf('--tests');
if (filterIndex >= 0) {
  const id = args[filterIndex+1].replace(/\\*/g,'');
  const resultArg = args.find(arg => arg.startsWith('-Dorchestrator.caseResultFile='));
  if (resultArg) {
    const resultFile = resultArg.slice('-Dorchestrator.caseResultFile='.length);
    const implemented = fs.existsSync('app/src/main/java/'+id+'.kt');
    const values = [
      {kind:'case',taskPath:':app:testDebugUnitTest',className:id,name:'approved behavior',result:implemented?'SUCCESS':'FAILURE',exceptionType:implemented?null:'java.lang.AssertionError',exceptionMessage:implemented?null:'expected missing behavior'}
    ];
    if (${JSON.stringify(structuredCaseMode)} === 'preserveFailure') {
      values.push({kind:'case',taskPath:':app:testDebugUnitTest',className:id,name:'preserved encoding',result:'FAILURE',exceptionType:'java.lang.AssertionError',exceptionMessage:'incorrect preserved-value expectation'});
    }
    values.push({kind:'suite',taskPath:':app:testDebugUnitTest',tests:values.length,failures:values.filter(value=>value.result==='FAILURE').length,skipped:0,result:implemented?'SUCCESS':'FAILURE'});
    fs.writeFileSync(resultFile,values.map(value=>JSON.stringify(value)).join('\\n')+'\\n');
    console.log('BUILD SUCCESSFUL');
    process.exit(0);
  }
  if (!fs.existsSync('app/src/main/java/'+id+'.kt')) { console.log('expected missing behavior'); process.exit(1); }
}
if (args.includes('testDebugUnitTest')) {
  console.log('ORCHESTRATOR_TEST_EXPECTED|:app:testDebugUnitTest');
  console.log('ORCHESTRATOR_TEST_RESULT|:app:testDebugUnitTest|2|0|0');
}
console.log('BUILD SUCCESSFUL');
`, { mode: 0o755 });
  writeFileSync(join(bin, "opencode"), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'debug') {
  if (args[1] === 'skill') { console.log(JSON.stringify(JSON.parse(fs.readFileSync('automation/config.json')).requiredSkills)); process.exit(0); }
  if (args[1] === 'config') { console.log('{}'); process.exit(0); }
  if (args[1] === 'agent') {
    const text = fs.readFileSync('.opencode/agents/'+args[2]+'.md','utf8').split('---')[1];
    const permissions=[]; const tools={}; let current='';
    for (const line of text.split('\\n')) {
      let m=line.match(/^  ([a-z_*]+): (allow|deny)$/);
      if (m) { permissions.push({permission:m[1],pattern:'*',action:m[2]}); tools[m[1]]=m[2]==='allow'; continue; }
      m=line.match(/^  "([^"]+)": (allow|deny)$/);
      if (m) { permissions.push({permission:m[1],pattern:'*',action:m[2]}); continue; }
      m=line.match(/^  ([a-z_]+):$/); if (m) { current=m[1]; continue; }
      m=line.match(/^    "([^"]+)": (allow|deny)$/); if (m) permissions.push({permission:current,pattern:m[1],action:m[2]});
    }
    console.log(JSON.stringify({permission:permissions,tools})); process.exit(0);
  }
}
if(args[0]!=='run') process.exit(3);
const role=args[args.indexOf('--agent')+1];
const prompt=args.at(-1);
const id=prompt.match(/TASK-[A-Z0-9-]+/)[0];
const contract=JSON.parse(fs.readFileSync('automation/tasks/'+id+'.json'));
const run=(name,extra=[])=>{const r=cp.spawnSync('./scripts/automation/'+name+'.sh',[id,...extra],{stdio:'inherit',detached:${JSON.stringify(detachedAgentCommands)}}); if(r.status!==0)process.exit(r.status||1);};
fs.appendFileSync(${JSON.stringify(join(base, "agent-calls.jsonl"))},JSON.stringify({role,id,cwd:process.cwd(),pid:process.pid,at:Date.now()})+'\\n');
if(role==='scheduled-coder') {
  const priorCalls=fs.readFileSync(${JSON.stringify(join(base, "agent-calls.jsonl"))},'utf8').trim().split('\\n').map(JSON.parse);
  if(priorCalls.filter(call=>call.id===id&&call.role===role).length>1) {
    fs.appendFileSync('app/src/main/java/'+id+'.kt','// Reviewer correction\\n');
    run('quality-gate'); process.exit(0);
  }
  if(contract.schemaVersion<5) run('claim-task');
  fs.mkdirSync('app/src/test/java',{recursive:true});
  fs.writeFileSync('app/src/test/java/'+id+'Test.kt','class RegressionTest {}\\n');
  if (contract.schemaVersion >= 3) run('record-red');
  else run('record-red',['expected missing behavior','--',id]);
  fs.writeFileSync('app/src/main/java/'+id+'.kt','class ImplementedFeature {}\\n');
  if (${JSON.stringify(deleteProduction)}) fs.unlinkSync('app/src/main/java/Baseline.kt');
  run('quality-gate');
} else if(role==='scheduled-reviewer') {
  const priorCalls=fs.readFileSync(${JSON.stringify(join(base, "agent-calls.jsonl"))},'utf8').trim().split('\\n').map(JSON.parse);
  const attempt=priorCalls.filter(call=>call.id===id&&call.role===role).length;
  if(${JSON.stringify(interruptReviewer)} && attempt===1) process.exit(7);
  run('submit-review',[attempt<=${JSON.stringify(reviewChanges)}?'CHANGES_REQUESTED':'APPROVED',
    'Independent fixture review confirms scoped behavior and fresh deterministic verification.']);
}
else process.exit(4);
`, { mode: 0o755 });
  command(root, ["init", "-q", "-b", "main"]);
  command(root, ["config", "user.name", "Queue Test"]);
  command(root, ["config", "user.email", "queue-test@example.invalid"]);
  command(root, ["add", "."]);
  command(root, ["commit", "-qm", "Fixture baseline"]);
  const queue = new TaskQueue(root);
  return { root, base, bin, config, queue, structuredCaseMode, inventoryMode, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANDROID_HOME: base },
    cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function taskContract(f, id) {
  const template = JSON.parse(readFileSync(join(f.root, "automation/tasks/TASK-TEMPLATE.json.example"), "utf8"));
  const cases = [{
    id: "APPROVED-BEHAVIOR", criterion: 1, intent: "change", before: "fail", after: "pass", source: "userRequirement",
    test: { target: 0, className: id, name: "approved behavior" },
    expectedFailure: { type: "java.lang.AssertionError", messageIncludes: "expected missing behavior", origin: "The approved behavior assertion" },
  }];
  if (f.structuredCaseMode === "preserveFailure") cases.push({
    id: "PRESERVED-ENCODING", criterion: 1, intent: "preserve", before: "pass", after: "pass", source: "measuredFact",
    test: { target: 0, className: id, name: "preserved encoding" },
  });
  const contract = { ...template, schemaVersion: 3, id, title: `Implement scoped behavior ${id}`, planPath: `docs/plans/${id}.md`,
    allowedPaths: [`app/src/main/java/${id}.kt`, `app/src/test/java/${id}Test.kt`],
    acceptanceCriteria: ["The scoped behavior matches the approved regression test"],
    targetTests: [{ gradleTask: "testDebugUnitTest", filter: id }],
    verification: { version: 1, maxPreparationFixes: 1, cases } };
  if (f.inventoryMode) {
    contract.schemaVersion = 4;
    contract.targetTests[0].gradleTask = ":app:testDebugUnitTest";
    contract.verification.version = 2;
    contract.verification.inventory = { mode: "focusedBaseline", existingSkips: "reject", emptyBaseline: "reject" };
  }
  return contract;
}

export function draft(f, id, extra = {}) {
  const contract = taskContract(f, id);
  return f.queue.draft({ contract, plan: `# Plan for ${id}\n\nImplement the approved behavior with a regression test.\n`, ...f.queue.snapshot(), ...extra });
}
export function enqueue(f, id, extra = {}) {
  const sealed = draft(f, id, extra);
  return f.queue.enqueue(sealed.key, sealed.digest, f.queue.approvalText(sealed));
}

export async function run(f, { allowCrash = false, timeoutMs = 90000 } = {}) {
  const reservation = f.queue.reserve();
  if (!reservation) throw new Error('No runnable reservation: '+JSON.stringify(f.queue.storage.read()));
  const output = [];
  const cli = fileURLToPath(new URL('../dist/queue/cli.js', import.meta.url));
  let exitCode;
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, reservation.supervision ? '_supervise' : '_worker', reservation.id, f.root], { env: f.env, detached: true });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') { reject(error); return; } }
      reject(new Error('Fixture worker timed out: '+output.join('')));
    }, timeoutMs);
    child.stdout.on('data', chunk => output.push(chunk.toString()));
    child.stderr.on('data', chunk => output.push(chunk.toString()));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); exitCode = code;
      code === 0 || allowCrash ? done() : reject(new Error(output.join('')));
    });
  });
  f.queue.reconcile();
  releaseStoppedLeases(f.queue);
  const document = f.queue.storage.read();
  if (document.active?.supervision && document.active.supervision.state !== 'EXITED')
    output.push(JSON.stringify({ fault: document.fault, active: publicRun(document.active) }));
  return { item: f.queue.item(reservation.key), output: output.join(''), exitCode };
}
