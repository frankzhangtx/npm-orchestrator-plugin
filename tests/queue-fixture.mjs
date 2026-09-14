import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskQueue } from "../dist/queue/queue.js";
import { releaseStoppedLeases } from "../dist/queue/service.js";

const templates = fileURLToPath(new URL("../templates/", import.meta.url));
export function command(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export function fixture(options = {}) {
  const base = mkdtempSync(join(tmpdir(), "orchestrator-queue-test-"));
  const root = join(base, "project");
  cpSync(templates, root, { recursive: true });
  const bin = join(base, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "app/src/main/java"), { recursive: true });
  mkdirSync(join(root, "app/src/test/java"), { recursive: true });
  writeFileSync(join(root, "app/src/main/java/Baseline.kt"), "class Baseline\n");
  writeFileSync(join(root, ".gitignore"), ".automation-plugin/\n.gradle/\n**/build/\n");
  writeFileSync(join(root, "opencode.json"), "{}\n");
  writeFileSync(join(root, "settings.gradle.kts"), 'rootProject.name = "queue-fixture"\ninclude(":app")\n');
  writeFileSync(join(root, "app/build.gradle.kts"), 'plugins { id("com.android.application") }\n');
  const config = JSON.parse(readFileSync(join(root, "automation/config.json"), "utf8"));
  Object.assign(config, options, { worktreeBase: join(base, "worktrees"), commitMessagePrefixMode: "disabled",
    androidProject: { name: "queue-fixture", gradleDsl: "kotlin", settingsFile: "settings.gradle.kts", moduleScope: "all", primaryModule: ":app",
      modules: [{ gradlePath: ":app", directory: "app", buildFile: "app/build.gradle.kts", dsl: "kotlin", type: "application", namespace: "example.queue", applicationId: "example.queue" }],
      productionPaths: ["app/src/main/**"], testPaths: ["app/src/test/**", "app/src/androidTest/**"] } });
  writeFileSync(join(root, "automation/config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, "gradlew"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(base, "gradle-calls.jsonl"))}, JSON.stringify({cwd:process.cwd(),args,at:Date.now()})+'\\n');
const filterIndex = args.indexOf('--tests');
if (filterIndex >= 0) {
  const id = args[filterIndex+1].replace(/\\*/g,'');
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
const run=(name,extra=[])=>{const r=cp.spawnSync('./scripts/automation/'+name+'.sh',[id,...extra],{stdio:'inherit'}); if(r.status!==0)process.exit(r.status||1);};
fs.appendFileSync(${JSON.stringify(join(base, "agent-calls.jsonl"))},JSON.stringify({role,id,cwd:process.cwd(),pid:process.pid,at:Date.now()})+'\\n');
if(role==='scheduled-coder') {
  run('claim-task');
  fs.mkdirSync('app/src/test/java',{recursive:true});
  fs.writeFileSync('app/src/test/java/'+id+'Test.kt','class RegressionTest {}\\n');
  run('record-red',['expected missing behavior','--',id]);
  fs.writeFileSync('app/src/main/java/'+id+'.kt','class ImplementedFeature {}\\n');
  run('quality-gate');
} else if(role==='scheduled-reviewer') run('submit-review',['APPROVED','Independent fixture review confirms scoped behavior and fresh deterministic verification.']);
else process.exit(4);
`, { mode: 0o755 });
  command(root, ["init", "-q", "-b", "main"]);
  command(root, ["config", "user.name", "Queue Test"]);
  command(root, ["config", "user.email", "queue-test@example.invalid"]);
  command(root, ["add", "."]);
  command(root, ["commit", "-qm", "Fixture baseline"]);
  const queue = new TaskQueue(root);
  return { root, base, bin, config, queue, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANDROID_HOME: base },
    cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function draft(f, id, extra = {}) {
  const template = JSON.parse(readFileSync(join(f.root, "automation/tasks/TASK-TEMPLATE.json.example"), "utf8"));
  const contract = { ...template, id, title: `Implement scoped behavior ${id}`, planPath: `docs/plans/${id}.md`,
    allowedPaths: [`app/src/main/java/${id}.kt`, `app/src/test/java/${id}Test.kt`],
    acceptanceCriteria: ["The scoped behavior matches the approved regression test"],
    targetTests: [{ gradleTask: "testDebugUnitTest", filter: id }] };
  return f.queue.draft({ contract, plan: `# Plan for ${id}\n\nImplement the approved behavior with a regression test.\n`, ...f.queue.snapshot(), ...extra });
}
export function enqueue(f, id, extra = {}) {
  const sealed = draft(f, id, extra);
  return f.queue.enqueue(sealed.key, sealed.digest, f.queue.approvalText(sealed));
}

export async function run(f, { allowCrash = false } = {}) {
  const reservation = f.queue.reserve();
  if (!reservation) throw new Error('No runnable reservation: '+JSON.stringify(f.queue.storage.read()));
  const output = [];
  const cli = fileURLToPath(new URL('../dist/queue/cli.js', import.meta.url));
  let exitCode;
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, '_worker', reservation.id, f.root], { env: f.env, detached: true });
    const timer = setTimeout(() => {
      process.kill(-child.pid, 'SIGKILL');
      reject(new Error('Fixture worker timed out: '+output.join('')));
    }, 90000);
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
  return { item: f.queue.item(reservation.key), output: output.join(''), exitCode };
}
