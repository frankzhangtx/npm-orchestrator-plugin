"use strict";
// Compilation dependencies may be reused; only explicitly requested test and
// cleanup tasks may execute. This guard never manufactures verification scope.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), crypto = require("node:crypto");
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const bounded = contract => contract.verification?.scope?.version === 3;
function cleanTasks(contract) {
  const scope = contract.verification.scope;
  const tasks = [...contract.targetTests, ...scope.regressionTests].map(t => t.gradleTask)
    .concat(...Object.values(scope.tasks));
  return [...new Set(tasks.map(t => `${t.slice(0, t.lastIndexOf(":"))}:clean`))].sort();
}
function gradleArguments(contract, requestedTasks, config) {
  if (!bounded(contract)) return [];
  const allowedTests = [...contract.targetTests, ...contract.verification.scope.regressionTests].map(t => t.gradleTask);
  const allowedOther = Object.values(contract.verification.scope.tasks).flat();
  const cleanup = contract.verification.scope.buildMode === "clean" ? cleanTasks(contract) : [];
  assert(requestedTasks.length > 0 && requestedTasks.every(t => [...allowedTests, ...allowedOther, ...cleanup].includes(t)),
    "Requested Gradle task exceeds the sealed verification boundary");
  return ["--build-cache", "--no-configuration-cache", "--init-script", path.join(__dirname, "bounded.init.gradle"),
    `-Dorchestrator.allowedTests=${JSON.stringify(requestedTasks.filter(t => allowedTests.includes(t)))}`,
    `-Dorchestrator.allowedClean=${JSON.stringify(requestedTasks.filter(t => cleanup.includes(t)))}`,
    `-Dorchestrator.requestedVerification=${JSON.stringify(requestedTasks)}`,
    `-Dorchestrator.knownVerification=${JSON.stringify([...new Set([
      ...Object.values(config?.gradleVerification ?? {}).flat(),
      ...(config?.androidProject?.capabilities?.modules ?? []).flatMap(module => module.tasks.map(task => task.path)),
    ])])}`];
}
function prepareBuild(contractFile, configFile, root, evidence) {
  const contract = read(contractFile);
  if (!bounded(contract)) return;
  const config = read(configFile);
  require("./contract.cjs").validateContract(contract, config);
  const mode = contract.verification.scope.buildMode ?? "incremental";
  const binding = { contractSha256: hash(fs.readFileSync(contractFile)), configSha256: hash(fs.readFileSync(configFile)), mode };
  const file = path.join(evidence, "build-preparation.json");
  if (fs.existsSync(file)) {
    assert(!fs.lstatSync(file).isSymbolicLink(), "Build preparation evidence must be a regular file");
    const previous = read(file);
    assert(JSON.stringify(previous.binding) === JSON.stringify(binding) && previous.state === "COMPLETE",
      "Build preparation interrupted or changed; do not automatically repeat clean");
    return;
  }
  const record = { version: 1, binding, state: "RUNNING", tasks: mode === "clean" ? cleanTasks(contract) : [],
    startedAt: new Date().toISOString(), testsExecuted: false };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (mode === "clean") {
    const buildRoot = require("./project.cjs").gradleBuildRoot(config, root);
    const args = [...record.tasks, ...gradleArguments(contract, record.tasks, config), "--console=plain",
      ...(process.env.AUTOMATION_WORKER_TOKEN ? ["--no-daemon"] : [])];
    const log = path.join(evidence, "build-preparation.log"), fd = fs.openSync(log, "wx", 0o600);
    let result;
    try { result = cp.spawnSync(path.join(buildRoot, "gradlew"), args, { cwd: buildRoot, stdio: ["ignore", fd, fd] }); }
    finally { fs.closeSync(fd); }
    Object.assign(record, { args, exitCode: result.status, signal: result.signal, logSha256: hash(fs.readFileSync(log)) });
    if (result.status !== 0 || result.signal || result.error) {
      record.state = "FAILED"; fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
      throw new Error("Explicit clean failed; retain its evidence and request recovery without automatically cleaning again");
    }
  }
  record.state = "COMPLETE"; record.finishedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
}
function verificationPhases(contract, plan, phase, hasSelectedBaseline = false) {
  if (bounded(contract) && phase !== "integration") return ["focused", "inventory-check"];
  return ["focused", ...(plan.testSelection?.mode === "selected" ? ["selected"] :
    ["unit", ...(contract.verification.scope.version === 2 && hasSelectedBaseline ? ["baseline-regression"] : [])]),
    "assemble", "lint", "device", "inventory-check"];
}
function runBuildTasks(contractFile, configFile, root, evidence, tasks) {
  const contract = read(contractFile), config = read(configFile), project = require("./project.cjs");
  require("./contract.cjs").validateContract(contract, config);
  assert(bounded(contract) && tasks.every(t => Object.values(contract.verification.scope.tasks).flat().includes(t)),
    "Build tasks exceed the approved boundary");
  const buildRoot = project.gradleBuildRoot(config, root);
  const runtime = read(path.join(evidence, "test-manifest.json")).runtime;
  const environment = project.buildEnvironmentBinding(buildRoot, runtime);
  const args = [...tasks, ...gradleArguments(contract, tasks, config), "--console=plain", "--init-script", path.join(__dirname, "runtime.init.gradle"),
    ...(process.env.AUTOMATION_WORKER_TOKEN ? ["--no-daemon"] : [])];
  const result = cp.spawnSync(path.join(buildRoot, "gradlew"), args, { cwd: buildRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? ""); process.stdout.write(output);
  const taskOutcomes = [...output.matchAll(/^> Task (:[^\s]+)(?: (UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED|FAILED))?$/gm)]
    .map(match => ({ task: match[1], outcome: match[2] ?? "EXECUTED" }));
  process.stdout.write(`ORCHESTRATOR_BUILD_SUMMARY=${JSON.stringify({ tasks, buildMode: contract.verification.scope.buildMode ?? "incremental", buildCache: true, taskOutcomes })}\n`);
  if (result.status !== 0 || result.signal || result.error) return result.status || 1;
  assert(JSON.stringify(project.parseBuildRuntime(output)) === JSON.stringify(runtime), "Actual build runtime changed after RED");
  assert(project.buildEnvironmentBinding(buildRoot, runtime) === environment, "Build environment changed during verification");
  return 0;
}
module.exports = { bounded, cleanTasks, gradleArguments, prepareBuild, verificationPhases, runBuildTasks };
if (require.main === module) {
  try {
    if (process.argv[2] === "--run") process.exitCode = runBuildTasks(...process.argv.slice(3, 7), JSON.parse(process.argv[7]));
    else process.stdout.write(JSON.stringify(gradleArguments(read(process.argv[2]), JSON.parse(process.argv[3]))));
  }
  catch (error) { console.error(error.message); process.exitCode = 41; }
}
