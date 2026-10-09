"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { validateContract, identity, matchesPath } = require("./contract.cjs");
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => hash(JSON.stringify(value));
const read = file => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new InventoryError("EVIDENCE_CHANGED", `Missing or invalid evidence/configuration: ${file}`); }
};
const fileHash = file => hash(fs.readFileSync(file));
const same = (a, b) => digest(a) === digest(b);
const sorted = values => [...new Set(values)].sort();
class InventoryError extends Error {
  constructor(code, message, issues = []) { super(message); this.code = code; this.issues = issues; }
}
function requireThat(condition, code, message, issues) {
  if (!condition) throw new InventoryError(code, message, issues);
}
const recovery = (code, phase) => phase === "baseline"
  ? "Baseline capture is blocked. If baseline.json exists, /resume-task cannot retry this task: inspect the attempt, request approved abort/archive, then approve a new task after correcting the cause. Do not delete or overwrite baseline evidence."
  : ({
  EXECUTION_FAILURE: "Inspect the attempt log and fix the build or environment; incomplete execution cannot become RED.",
  INCOMPLETE_COLLECTION: "Inspect the retained attempt; restore actual, complete Test execution and retry within the preparation budget.",
  AMBIGUOUS_IDENTITY: "Give parameterized or dynamic cases stable distinct names, then approve a corrected contract if behavior identities change.",
  BASELINE_NOT_GREEN: "Restore a passing baseline; existing failures cannot be approved automatically as regression coverage.",
  EMPTY_BASELINE: "Correct the focused scope, or approve a new contract explicitly allowing an empty baseline for new tests.",
  BASELINE_SKIPPED: "Restore the skipped tests or approve a new contract explicitly preserving existing skips.",
  COVERAGE_MISMATCH: "Restore the listed missing or skipped cases; newly added behavior requires explicit contract coverage.",
  CASE_EXPECTATION_MISMATCH: "Inspect each listed case; fix test preparation only within the approved requirements, otherwise revise the contract.",
  EVIDENCE_CHANGED: "Restore the sealed inputs or create a revised task; do not overwrite baseline or RED evidence.",
  UNSUPPORTED_TEST_INPUT: "Use repository-local test source/resource directories separated from production and generated outputs, then retry with a corrected configuration.",
  INPUT_CHANGED_DURING_RUN: "Stop concurrent edits or input-generating side effects and rerun; this attempt was not sealed.",
  PREPARATION_BUDGET: "The preparation budget is exhausted; preserve attempts and approve a revised task.",
}[code] ?? "Inspect inventory-status.json and the retained attempt before resuming.");
function atomic(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { if (exclusive) { fs.linkSync(temp, file); } else { fs.renameSync(temp, file); } }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function groupedTargets(contract) {
  return sorted(contract.targetTests.map(item => item.gradleTask)).map(taskPath => ({ taskPath,
    filters: sorted(contract.targetTests.filter(item => item.gradleTask === taskPath).map(item => item.filter)) }));
}

// Counts and completion records authenticate the event stream independently of
// which cases are expected to fail. Duplicate identities are never deduplicated.
function validateCollection(events, request, status, discovery = false) {
  requireThat(status === 0, "EXECUTION_FAILURE", `Gradle exited with ${status}`);
  const ofKind = kind => events.filter(item => item.kind === kind);
  requireThat(events.length > 1 && events.every(item => item.runId === request.runId) &&
    events[0].kind === "start" && events[0].phase === request.phase && events.at(-1).kind === "end" &&
    ofKind("start").length === 1 && ofKind("end").length === 1 && events.at(-1).failure === null &&
    events.every(item => ["start", "task", "case", "suite", "taskEnd", "end"].includes(item.kind)),
  "INCOMPLETE_COLLECTION", "Missing, stale, malformed or interrupted Gradle event stream");
  const targets = groupedTargets({ targetTests: request.targets });
  const tasks = ofKind("task"), cases = ofKind("case");
  requireThat(tasks.length === targets.length && targets.every(target => tasks.filter(item => item.taskPath === target.taskPath && same(item.filters, target.filters)).length === 1),
    "INCOMPLETE_COLLECTION", "Resolved Test tasks or filters differ from the approved scope");
  requireThat(events.every(item => !item.taskPath || targets.some(target => target.taskPath === item.taskPath)), "INCOMPLETE_COLLECTION", "Unexpected task in collected results");
  if (discovery) return { tasks, cases: [] };
  const keys = new Set();
  for (const item of cases) {
    requireThat(typeof item.className === "string" && item.className.length > 0 && typeof item.name === "string" && item.name.length > 0 &&
      ["SUCCESS", "FAILURE", "SKIPPED"].includes(item.result) && Array.isArray(item.failures) &&
      (item.result === "FAILURE" ? item.failures.length > 0 : item.failures.length === 0), "INCOMPLETE_COLLECTION", "Invalid test case event", [item]);
    const key = identity(item);
    requireThat(!keys.has(key), "AMBIGUOUS_IDENTITY", "Repeated case identity; parameter instances must remain distinguishable", [item]);
    keys.add(key);
  }
  for (const target of targets) {
    const endings = ofKind("taskEnd").filter(item => item.taskPath === target.taskPath);
    const suites = ofKind("suite").filter(item => item.taskPath === target.taskPath);
    const actual = cases.filter(item => item.taskPath === target.taskPath);
    const end = endings[0];
    requireThat(endings.length === 1 && end.executed === true && end.failure === null,
      "INCOMPLETE_COLLECTION", `Test task did not finish: ${target.taskPath}`);
    if (end.noSource === true && request.phase === "baseline") {
      requireThat(actual.length === 0 && suites.length === 0 && end.skipMessage === "NO-SOURCE", "INCOMPLETE_COLLECTION", "Invalid NO-SOURCE completion");
      continue;
    }
    requireThat(end.skipped === false && end.upToDate === false && end.noSource === false && suites.length === 1,
      "INCOMPLETE_COLLECTION", `Test task was cached, skipped, empty or incomplete: ${target.taskPath}`);
    const suite = suites[0];
    requireThat(suite.tests === actual.length && suite.failures === actual.filter(item => item.result === "FAILURE").length &&
      suite.skipped === actual.filter(item => item.result === "SKIPPED").length,
    "INCOMPLETE_COLLECTION", `Suite counts disagree with individual results: ${target.taskPath}`);
    requireThat(request.phase === "baseline" || actual.length > 0, "COVERAGE_MISMATCH", `No focused tests executed: ${target.taskPath}`);
  }
  return { tasks, cases: cases.map(({ runId, kind, ...item }) => item).sort((a, b) => identity(a).localeCompare(identity(b))) };
}
function evaluateBaseline(contract, collection) {
  const { cases, tasks } = collection, policy = contract.verification.inventory;
  const failed = cases.filter(item => item.result === "FAILURE");
  requireThat(failed.length === 0, "BASELINE_NOT_GREEN", "Existing focused tests fail on the execution baseline", failed);
  const skipped = cases.filter(item => item.result === "SKIPPED");
  requireThat(policy.existingSkips === "preserve" || skipped.length === 0, "BASELINE_SKIPPED", "The approved policy rejects existing skipped tests", skipped);
  const empty = tasks.filter(task => !cases.some(item => item.taskPath === task.taskPath));
  requireThat(policy.emptyBaseline === "allow" || empty.length === 0, "EMPTY_BASELINE", "One or more focused tasks have an empty baseline", empty);
  return { cases, summary: { existing: cases.length, passed: cases.length - skipped.length, skipped: skipped.length, emptyTasks: empty.length } };
}
function matchesFailureOrigin(expected, actual, test) {
  if (!Array.isArray(actual.stack) || !actual.stack.length) return false;
  const frames = actual.stack.map(frame => typeof frame === "string" &&
    /^(?:[^/]+\/)?(.+)\.([^.(]+)\(([^():]+)(?::([0-9]+))?\)$/.exec(frame));
  if (frames.some(frame => !frame)) return false;
  const methodName = test.name.replace(/\[[^\]]*\]$/, "").replace(/\([^)]*\)$/, "");
  // Before/after hooks, rules and initialization failures do not include the
  // test body's invocation. Merely sharing an exception/message is not RED.
  if (!frames.some(frame => frame[1] === test.className && frame[2] === methodName)) return false;
  const origin = typeof expected.origin === "object" ? expected.origin : { className: test.className, methodName };
  const first = frames.find(frame => !/^(?:org\.junit\.(?:Assert|ComparisonFailure)$|org\.junit\.jupiter\.api\.(?:Assertions|AssertionUtils|Assert\w+)$|org\.opentest4j\.|kotlin\.test\.|org\.hamcrest\.MatcherAssert$|org\.assertj\.core\.)/.test(frame[1]));
  return Boolean(first && first[1] === origin.className && first[2] === origin.methodName &&
    (!origin.fileName || first[3] === origin.fileName) && (!origin.lineNumber || Number(first[4]) === origin.lineNumber));
}
function evaluateCoverage(contract, baseline, collection, phase, manifest) {
  const actual = new Map(collection.cases.map(item => [identity(item), item]));
  const expected = new Map(baseline.cases.map(item => [identity(item), { ...item, classification: "regression", id: identity(item) }]));
  for (const item of contract.verification.cases) {
    const value = { ...item, ...item.test, taskPath: contract.targetTests[item.test.target].gradleTask, classification: "behavior" };
    expected.set(identity(value), value);
  }
  if (phase === "green") {
    requireThat(manifest && same([...expected.keys()].sort(), manifest.cases.map(identity).sort()), "EVIDENCE_CHANGED", "Manifest coverage differs from baseline and contract");
  }
  const coverage = [], mismatches = [], cases = [];
  for (const [key, item] of expected) {
    const result = actual.get(key);
    if (!result) { coverage.push({ ...item, problem: "missing" }); continue; }
    let valid;
    if (phase === "green") {
      const sealed = manifest.cases.find(candidate => identity(candidate) === key);
      valid = result.result === "SUCCESS" || (sealed.allowSkip && result.result === "SKIPPED");
    } else if (item.classification === "regression") {
      valid = result.result === "SUCCESS" || (item.result === "SKIPPED" && contract.verification.inventory.existingSkips === "preserve" && result.result === "SKIPPED");
    } else {
      const failure = item.expectedFailure;
      const matched = result.result === "FAILURE" && failure && result.failures.length === 1 &&
        result.failures[0].type === failure.type && (!failure.messageIncludes || result.failures[0].message.includes(failure.messageIncludes)) &&
        matchesFailureOrigin(failure, result.failures[0], item);
      valid = item.before === "pass" ? result.result === "SUCCESS" : item.before === "fail" ? matched : result.result === "SUCCESS" || matched;
    }
    const entry = { id: item.id, taskPath: item.taskPath, className: item.className, name: item.name,
      classification: item.classification, intent: item.intent ?? "regression", valid: Boolean(valid), actual: result,
      allowSkip: item.classification === "regression" && item.result === "SKIPPED" && result.result === "SKIPPED" };
    cases.push(entry);
    if (!valid) (result.result === "SKIPPED" ? coverage : mismatches).push({ ...entry, problem: result.result === "SKIPPED" ? "newly-skipped" : "unexpected-result" });
  }
  for (const [key, item] of actual) if (!expected.has(key)) coverage.push({ ...item, problem: "undeclared-new-case" });
  requireThat(coverage.length === 0, "COVERAGE_MISMATCH", "Focused test coverage changed", coverage);
  requireThat(mismatches.length === 0, "CASE_EXPECTATION_MISMATCH", "Behavior or existing regression results do not match the approved expectations", mismatches);
  const expectedRed = cases.filter(item => item.intent === "change" && item.actual.result === "FAILURE").length;
  requireThat(phase !== "red" || expectedRed > 0, "CASE_EXPECTATION_MISMATCH", "No approved failing behavior provides RED");
  return { cases, summary: { declared: contract.verification.cases.length, regression: cases.filter(item => item.classification === "regression").length,
    total: cases.length, expectedRed, skipped: cases.filter(item => item.actual.result === "SKIPPED").length } };
}

function git(root, args) {
  const result = cp.spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  requireThat(result.status === 0, "EVIDENCE_CHANGED", result.stderr || "Unable to inspect Git baseline");
  return result.stdout;
}
function localPath(root, file) {
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute).split(path.sep).join("/");
  requireThat(relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative) &&
    !relative.split("/").some(part => [".git", ".gradle", "build"].includes(part)), "UNSUPPORTED_TEST_INPUT", `Unsafe or generated test input: ${file}`);
  let parent = absolute;
  while (parent !== root) {
    requireThat(!fs.existsSync(parent) || !fs.lstatSync(parent).isSymbolicLink(), "UNSUPPORTED_TEST_INPUT", `Symlink test input is unsupported: ${file}`);
    parent = path.dirname(parent);
  }
  return relative;
}
function testPatterns(root, config, tasks) {
  const discovered = tasks.flatMap(task => task.sourceRoots.map(file => `${localPath(root, file)}/**`));
  return sorted([...config.androidProject.testPaths, ...discovered]);
}
function isTest(config, patterns, file) {
  return patterns.some(pattern => matchesPath(pattern, file)) &&
    ![...config.protectedPaths, ...config.androidProject.productionPaths].some(pattern => matchesPath(pattern, file));
}
function snapshot(root, config, patterns, excluded = []) {
  root = fs.realpathSync(root);
  const files = new Set();
  function visit(file) {
    if (!fs.existsSync(file)) return;
    const relative = localPath(root, file), stat = fs.lstatSync(file);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name)); }
    else if (stat.isFile() && patterns.some(pattern => matchesPath(pattern, relative))) {
      requireThat(!excluded.includes(relative), "UNSUPPORTED_TEST_INPUT", `Human-owned path cannot be a test evidence input: ${relative}`);
      requireThat(isTest(config, patterns, relative), "UNSUPPORTED_TEST_INPUT", `Test inputs overlap production or protected paths: ${relative}`);
      files.add(relative);
    }
  }
  for (const pattern of patterns) {
    const wildcard = pattern.search(/[?*]/);
    let prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
    if (wildcard >= 0 && !prefix.endsWith("/")) prefix = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    requireThat(prefix.length > 0, "UNSUPPORTED_TEST_INPUT", `Test path needs a bounded directory: ${pattern}`);
    visit(path.resolve(root, prefix));
  }
  return [...files].sort().map(file => ({ path: file, sha256: fileHash(path.join(root, file)), mode: fs.statSync(path.join(root, file)).mode & 0o777 }));
}
function worktree(root, excluded = []) {
  const files = sorted(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(file => file && !excluded.includes(file)));
  return digest(files.map(file => {
    const full = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(full); } catch { return [file, "absent"]; }
    return [file, stat.mode & 0o777, stat.isFile() ? fileHash(full) : stat.isSymbolicLink() ? `symlink:${fs.readlinkSync(full)}` : "non-file"];
  }));
}
function humanOwnedPaths(contract, evidence) {
  const workspaceFile = path.join(path.dirname(path.dirname(evidence)), "workspaces", `${contract.id}.json`);
  const allowlist = fs.existsSync(workspaceFile) ? read(workspaceFile).worktreeAllowlist ?? [] : [];
  requireThat(Array.isArray(allowlist) && allowlist.every(item => typeof item === "string"), "EVIDENCE_CHANGED", "Invalid worktree allowlist");
  return sorted([".automation-worktree-allowlist", "automation/automation-commit-prefix", ...allowlist]);
}
function unchangedProduction(root, contract, config, patterns, phase, evidence) {
  const changed = sorted([...git(root, ["diff", "--name-only", "--no-renames", "HEAD", "-z"]).split("\0"),
    ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")].filter(Boolean));
  const ignored = new Set([contract.planPath, `automation/tasks/${contract.id}.json`, ...humanOwnedPaths(contract, evidence)]);
  const invalid = changed.filter(file => !ignored.has(file) && (phase === "baseline" || !isTest(config, patterns, file)));
  requireThat(invalid.length === 0, "EVIDENCE_CHANGED", "Baseline/RED requires unchanged production and configuration", invalid.map(file => ({ path: file })));
}
function collectorHash() { return digest(["contract.cjs", "inventory.cjs", "project.cjs", "collect.init.gradle", "runtime.init.gradle"].map(file => [file, fileHash(path.join(__dirname, file))])); }
function evidenceFiles(evidence, directory) {
  const result = [];
  function visit(folder) { for (const name of fs.readdirSync(folder).sort()) { const file = path.join(folder, name); const stat = fs.lstatSync(file);
    requireThat(!stat.isSymbolicLink(), "EVIDENCE_CHANGED", "Evidence cannot contain symbolic links");
    if (stat.isDirectory()) visit(file); else if (stat.isFile()) result.push({ path: path.relative(evidence, file), sha256: fileHash(file) });
  } }
  visit(directory); return result;
}
function checkFiles(evidence, files) {
  requireThat(Array.isArray(files) && files.length > 0, "EVIDENCE_CHANGED", "Evidence file binding is missing");
  for (const item of files) {
    const file = path.resolve(evidence, item.path), relative = path.relative(evidence, file);
    requireThat(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) &&
      fs.existsSync(file) && fs.lstatSync(file).isFile() && fileHash(file) === item.sha256, "EVIDENCE_CHANGED", `Evidence file changed: ${item.path}`);
  }
}
function checkEvaluation(evidence, value, phase) {
  requireThat(value.phase === phase && typeof value.attemptPath === "string" &&
    new RegExp(`^inventory-attempts/${phase}-[0-9]+-[a-f0-9-]+$`).test(value.attemptPath),
  "EVIDENCE_CHANGED", "Invalid sealed attempt reference");
  const { files, baselineInventorySha256, redSha256, manifestSha256, supplementSha256, ...report } = value;
  requireThat(same(report, read(path.join(evidence, value.attemptPath, "evaluation.json"))),
    "EVIDENCE_CHANGED", "Inventory report differs from its completed evaluation");
  if (files) requireThat(same(files, evidenceFiles(evidence, path.join(evidence, value.attemptPath))),
    "EVIDENCE_CHANGED", "Attempt file inventory changed");
}
function runGradle(root, config, contract, phase, directory, discovery) {
  const buildRoot = require("./project.cjs").gradleBuildRoot(config, root);
  fs.mkdirSync(directory, { recursive: true });
  const request = { runId: randomUUID(), phase, targets: contract.targetTests, output: path.join(directory, "events.jsonl") };
  const requestFile = path.join(directory, "request.json"); atomic(requestFile, request, true);
  fs.writeFileSync(request.output, "", { flag: "wx" });
  const args = [...groupedTargets(contract).map(item => item.taskPath), "--no-configuration-cache", "--console=plain", "--no-build-cache",
    "--init-script", path.join(__dirname, "runtime.init.gradle"), "--init-script", path.join(__dirname, "collect.init.gradle"), `-Dorchestrator.inventoryRequest=${requestFile}`, ...(discovery ? ["--dry-run"] : [])];
  const fd = fs.openSync(path.join(directory, "gradle.log"), "wx");
  let result;
  if (process.env.AUTOMATION_WORKER_TOKEN) args.push("--no-daemon");
  try { result = cp.spawnSync(path.join(buildRoot, "gradlew"), args, { cwd: buildRoot, stdio: ["ignore", fd, fd] }); }
  finally { fs.closeSync(fd); }
  atomic(path.join(directory, "process.json"), { status: result.status, signal: result.signal, error: result.error?.message ?? null, args, cwd: buildRoot });
  if (contract.schemaVersion >= 7 && phase !== "baseline" && result.status !== 0 && !result.signal && !result.error) {
    const failure = require("./recovery.cjs").classifyFailure({ phase, exitCode: result.status, log: fs.readFileSync(path.join(directory, "gradle.log"), "utf8") });
    if (failure.retryable) {
      const error = new InventoryError("ENVIRONMENT_FAILURE", `Gradle environment failure: ${failure.reasonCode}`);
      error.failure = failure; throw error;
    }
  }
  let events;
  try { events = fs.readFileSync(request.output, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new InventoryError("INCOMPLETE_COLLECTION", "Invalid or truncated collector output"); }
  const collection = validateCollection(events, request, result.status, discovery);
  let runtime;
  try { runtime = require("./project.cjs").parseBuildRuntime(fs.readFileSync(path.join(directory, "gradle.log"), "utf8")); }
  catch (error) { throw new InventoryError("INCOMPLETE_COLLECTION", error.message); }
  return { ...collection, runtime, processExitCode: result.status };
}

// Invalidate previous GREEN before even validating inputs. A crash, early
// rejection or failed rerun must never leave an older success acceptable.
function runPhase(phase, contractFile, configFile, root, evidence) {
  if (phase !== "green") return runPhaseInternal(phase, contractFile, configFile, root, evidence);
  const markerFile = path.join(evidence, "green-verification.json");
  const verificationRunId = randomUUID();
  const marker = { verificationRunId, queueRunId: process.env.AUTOMATION_QUEUE_RUN_ID ?? null, startedAt: new Date().toISOString() };
  atomic(markerFile, { ...marker, state: "RUNNING" });
  try {
    const result = runPhaseInternal(phase, contractFile, configFile, root, evidence, verificationRunId);
    atomic(markerFile, { ...marker, state: "PASSED", greenSha256: fileHash(path.join(evidence, "green-inventory.json")) });
    return result;
  } catch (error) {
    atomic(markerFile, { ...marker, state: "FAILED", reasonCode: error.code ?? "EVIDENCE_CHANGED" });
    throw error;
  }
}
function runPhaseInternal(phase, contractFile, configFile, root, evidence, verificationRunId) {
  // Gradle canonicalizes the project root (for example /var -> /private/var
  // on macOS). Normalize the root, while still rejecting symlinks inside it.
  root = fs.realpathSync(root);
  const contract = read(contractFile), config = read(configFile);
  validateContract(contract, config);
  const excluded = humanOwnedPaths(contract, evidence);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const baselineFile = path.join(evidence, "baseline-inventory.json"), manifestFile = path.join(evidence, "test-manifest.json"), redFile = path.join(evidence, "red.json");
  const baselineMeta = path.join(evidence, contract.schemaVersion >= 5 && phase === "baseline" ? "baseline-full.json" : "baseline.json");
  const binding = { taskId: contract.id, contractSha256: fileHash(contractFile), configSha256: fileHash(configFile),
    baselineHead: read(baselineMeta).head, baselineEvidenceSha256: fileHash(baselineMeta), collectorSha256: collectorHash(), excludedPathsSha256: digest(excluded) };
  const checkBinding = value => requireThat(same(value.binding, binding), "EVIDENCE_CHANGED", "Contract, baseline, configuration or collector binding changed");
  const inputEvidence = [];
  const bindInput = file => { inputEvidence.push({ file, sha256: fileHash(file) }); };
  let baseline, manifest, red, patterns, supplement;
  if (phase !== "baseline") {
    baseline = read(baselineFile); checkBinding(baseline); checkFiles(evidence, baseline.files);
    checkEvaluation(evidence, baseline, "baseline");
    requireThat(baseline.valid === true && baseline.phase === "baseline", "EVIDENCE_CHANGED", "A valid baseline inventory is required");
    bindInput(baselineFile);
    patterns = baseline.testPatterns;
    requireThat(baseline.environmentSha256 === require("./project.cjs").buildEnvironmentBinding(require("./project.cjs").gradleBuildRoot(config, root), baseline.runtime),
      "EVIDENCE_CHANGED", "Build environment or Gradle user/JVM configuration changed after baseline");
    if (phase === "green" || phase === "check") {
      red = read(redFile); manifest = read(manifestFile); checkBinding(red); checkBinding(manifest);
      requireThat(red.manifestSha256 === fileHash(manifestFile) && red.baselineInventorySha256 === fileHash(baselineFile) &&
        red.preflightSha256 === fileHash(path.join(evidence, "test-preflight.json")), "EVIDENCE_CHANGED", "RED manifest, inventory or evaluation changed");
      checkFiles(evidence, red.files);
      checkEvaluation(evidence, manifest, "red");
      requireThat(red.structuredCasesVerified === true && manifest.valid === true && manifest.phase === "red", "EVIDENCE_CHANGED", "Valid sealed RED evidence is required");
      for (const file of [redFile, manifestFile, path.join(evidence, "test-preflight.json")]) bindInput(file);
      supplement = supplementalEvidence(phase, root, config, contract, evidence, binding, baseline, manifest, patterns, excluded);
      if (supplement) {
        bindInput(path.join(evidence, "test-supplement.json"));
        baseline = { ...baseline, cases: [...baseline.cases, ...supplement.cases] };
        manifest = { ...manifest, cases: [...manifest.cases, ...supplement.cases.map(item => ({ ...item, classification: "regression", id: identity(item), allowSkip: false }))],
          testSnapshot: [...manifest.testSnapshot, ...supplement.addedFiles].sort((a, b) => a.path.localeCompare(b.path)) };
      }
      requireThat(same(snapshot(root, config, patterns, excluded), [...manifest.testSnapshot].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), "EVIDENCE_CHANGED", "Test sources or resources changed after sealed test evidence");
    }
  }
  if (phase === "baseline" || phase === "red") requireThat(head === binding.baselineHead, "EVIDENCE_CHANGED", "Execution HEAD changed before RED");
  if (phase === "check") {
    const green = read(path.join(evidence, "green-inventory.json")); checkBinding(green); checkFiles(evidence, green.files);
    const latest = read(path.join(evidence, "green-verification.json"));
    requireThat(latest.state === "PASSED" && latest.verificationRunId === green.verificationRunId &&
      latest.greenSha256 === fileHash(path.join(evidence, "green-inventory.json")),
      "EVIDENCE_CHANGED", "Latest GREEN failed, was interrupted or is not the sealed successful run; rerun GREEN");
    checkEvaluation(evidence, green, "green");
    requireThat(green.valid && green.redSha256 === fileHash(redFile) && green.manifestSha256 === fileHash(manifestFile), "EVIDENCE_CHANGED", "GREEN is not bound to the sealed RED and manifest");
    requireThat((green.supplementSha256 ?? null) === (supplement ? fileHash(path.join(evidence, "test-supplement.json")) : null), "EVIDENCE_CHANGED", "GREEN is not bound to the supplemental test evidence");
    requireThat(green.verifiedHead === head && green.worktreeSha256 === worktree(root, excluded), "EVIDENCE_CHANGED", "Repository inputs changed after GREEN; rerun verification");
    return green;
  }
  requireThat(["baseline", "red", "green"].includes(phase), "EVIDENCE_CHANGED", "Unknown inventory phase");
  if (phase === "baseline") requireThat(!fs.existsSync(baselineFile), "EVIDENCE_CHANGED", "Baseline inventory already exists");
  if (phase === "red") requireThat(!fs.existsSync(redFile), "EVIDENCE_CHANGED", "RED already exists");
  const attempts = path.join(evidence, "inventory-attempts"); fs.mkdirSync(attempts, { recursive: true });
  const number = fs.readdirSync(attempts).filter(name => name.startsWith(`${phase}-`)).length + 1;
  if (phase === "red") {
    const environmentAttempts = contract.schemaVersion >= 7 ? fs.readdirSync(attempts).filter(name => {
      const file = path.join(attempts, name, "evaluation.json");
      return name.startsWith("red-") && fs.existsSync(file) && read(file).failure?.retryable === true;
    }).length : 0;
    requireThat(number - environmentAttempts <= contract.verification.maxPreparationFixes + 1, "PREPARATION_BUDGET", "Test preparation retry budget exhausted");
  }
  const attemptPath = `inventory-attempts/${phase}-${String(number).padStart(3, "0")}-${randomUUID()}`;
  const attempt = path.join(evidence, attemptPath); fs.mkdirSync(attempt);
  const startedAt = new Date().toISOString();
  try {
    if (phase === "baseline") {
      const beforeDiscovery = worktree(root, excluded);
      const discoveryFile = path.join(evidence, "baseline-discovery.json");
      let discovered;
      if (contract.schemaVersion >= 5 && fs.existsSync(discoveryFile)) {
        discovered = read(discoveryFile); checkBinding(discovered); checkFiles(evidence, discovered.files);
        requireThat(discovered.worktreeSha256 === beforeDiscovery && discovered.phase === "baseline-discovery",
          "EVIDENCE_CHANGED", "Baseline discovery inputs changed");
      } else {
        discovered = runGradle(root, config, contract, phase, path.join(attempt, "discovery"), true);
        requireThat(beforeDiscovery === worktree(root, excluded), "INPUT_CHANGED_DURING_RUN", "Discovery changed repository inputs");
        if (contract.schemaVersion >= 5) atomic(discoveryFile, { ...discovered, phase: "baseline-discovery", binding,
          worktreeSha256: beforeDiscovery, files: evidenceFiles(evidence, path.join(attempt, "discovery")) }, true);
      }
      requireThat(beforeDiscovery === worktree(root, excluded), "INPUT_CHANGED_DURING_RUN", "Discovery changed repository inputs");
      patterns = testPatterns(root, config, discovered.tasks);
    }
    if (phase !== "green") unchangedProduction(root, contract, config, patterns, phase, evidence);
    const before = snapshot(root, config, patterns, excluded), repositoryBefore = worktree(root, excluded);
    const environmentBefore = require("./project.cjs").buildEnvironmentBinding(require("./project.cjs").gradleBuildRoot(config, root), baseline?.runtime);
    const collection = runGradle(root, config, contract, phase, path.join(attempt, "collection"), false);
    requireThat(environmentBefore === require("./project.cjs").buildEnvironmentBinding(require("./project.cjs").gradleBuildRoot(config, root), baseline?.runtime),
      "EVIDENCE_CHANGED", "Build environment changed during collection");
    if (baseline) requireThat(same(collection.runtime, baseline.runtime), "EVIDENCE_CHANGED", "Actual Gradle, build JVM, plugins or test JVMs differ from baseline");
    requireThat(same(patterns, testPatterns(root, config, collection.tasks)), "EVIDENCE_CHANGED", "Test source/resource discovery changed after baseline");
    const after = snapshot(root, config, patterns, excluded);
    requireThat(same(before, after) && repositoryBefore === worktree(root, excluded) && head === git(root, ["rev-parse", "HEAD"]).trim(),
      "INPUT_CHANGED_DURING_RUN", "Repository or test inputs changed during Gradle execution");
    if (phase !== "green") unchangedProduction(root, contract, config, patterns, phase, evidence);
    requireThat(same(binding, { ...binding, contractSha256: fileHash(contractFile), configSha256: fileHash(configFile),
      baselineEvidenceSha256: fileHash(baselineMeta), collectorSha256: collectorHash(), excludedPathsSha256: digest(humanOwnedPaths(contract, evidence)) }), "EVIDENCE_CHANGED", "Execution policy changed during collection");
    for (const item of inputEvidence) requireThat(fileHash(item.file) === item.sha256, "EVIDENCE_CHANGED", `Evidence changed during collection: ${item.file}`);
    if (baseline) checkFiles(evidence, baseline.files);
    if (red) checkFiles(evidence, red.files);
    const evaluation = phase === "baseline" ? evaluateBaseline(contract, collection) : evaluateCoverage(contract, baseline, collection, phase, manifest);
    const report = { schemaVersion: 1, taskId: contract.id, phase, attempt: number, attemptPath, startedAt, finishedAt: new Date().toISOString(),
      valid: true, reasonCode: phase === "red" ? "VALID_RED" : "VALID_INVENTORY", binding, ...evaluation, testPatterns: patterns, testSnapshot: after,
      processExitCode: collection.processExitCode, runtime: collection.runtime,
      environmentSha256: require("./project.cjs").buildEnvironmentBinding(require("./project.cjs").gradleBuildRoot(config, root), collection.runtime),
      verifiedHead: head, worktreeSha256: repositoryBefore,
      queueRunId: process.env.AUTOMATION_QUEUE_RUN_ID ?? null, ...(verificationRunId ? { verificationRunId } : {}) };
    atomic(path.join(attempt, "evaluation.json"), report, true);
    const files = evidenceFiles(evidence, attempt);
    if (phase === "baseline") atomic(baselineFile, { ...report, files }, true);
    if (phase === "red") {
      atomic(path.join(evidence, "test-preflight.json"), report);
      atomic(manifestFile, { ...report, baselineInventorySha256: fileHash(baselineFile) });
      atomic(redFile, { schemaVersion: 4, taskId: contract.id, binding, attemptPath, files, structuredCasesVerified: true,
        baselineInventorySha256: fileHash(baselineFile), manifestSha256: fileHash(manifestFile),
        preflightSha256: fileHash(path.join(evidence, "test-preflight.json")), processExitCode: collection.processExitCode,
        expectedFailureCount: evaluation.summary.expectedRed, exitCode: 1, exitCodeMeaning: "approved-case-failure" }, true);
    }
    if (phase === "green") atomic(path.join(evidence, "green-inventory.json"), { ...report, files, redSha256: fileHash(redFile), manifestSha256: fileHash(manifestFile),
      supplementSha256: supplement ? fileHash(path.join(evidence, "test-supplement.json")) : null });
    atomic(path.join(evidence, "inventory-status.json"), { ...report, nextAction: null });
    return report;
  } catch (error) {
    const report = { taskId: contract.id, phase, attempt: number, attemptPath, startedAt, finishedAt: new Date().toISOString(), valid: false,
      reasonCode: error.code ?? "EXECUTION_FAILURE", message: error.message, issues: error.issues ?? [],
      ...(error.failure ? { failure: error.failure } : {}),
      nextAction: contract.schemaVersion >= 5 && phase === "baseline" ? "Inspect the sealed baseline recovery status; only approved classified retries may resume incomplete capture." : recovery(error.code, phase),
      queueRunId: process.env.AUTOMATION_QUEUE_RUN_ID ?? null };
    atomic(path.join(attempt, "evaluation.json"), report);
    if (phase === "red") atomic(path.join(evidence, "test-preflight.json"), report);
    atomic(path.join(evidence, "inventory-status.json"), report);
    throw error;
  }
}
function supplementalEvidence(phase, root, config, contract, evidence, binding, baseline, manifest, patterns, excluded) {
  const file = path.join(evidence, "test-supplement.json");
  const original = manifest.testSnapshot, current = snapshot(root, config, patterns, excluded);
  requireThat(original.every(item => current.some(candidate => same(item, candidate))), "EVIDENCE_CHANGED", "Original RED tests cannot be changed or deleted; approve a revised task for changed assertions");
  const addedFiles = current.filter(item => !original.some(previous => previous.path === item.path));
  const authorized = contract.verification.supplementalTests?.mode === "baselinePassingNewFiles";
  const bound = { binding, redSha256: fileHash(path.join(evidence, "red.json")), manifestSha256: fileHash(path.join(evidence, "test-manifest.json")) };
  if (fs.existsSync(file)) {
    requireThat(authorized, "EVIDENCE_CHANGED", "Supplemental test permission was not approved");
    const saved = read(file);
    requireThat(saved.version === 1 && same(saved.bound, bound) && same(saved.addedFiles, addedFiles), "EVIDENCE_CHANGED", "Supplemental tests or their original RED binding changed");
    checkFiles(evidence, saved.files);
    requireThat(same(saved, read(path.join(evidence, saved.attemptPath, "supplement.json"))), "EVIDENCE_CHANGED", "Supplemental test report differs from its sealed attempt");
    return saved;
  }
  if (!addedFiles.length) return null;
  requireThat(phase === "green" && authorized, "EVIDENCE_CHANGED", "New test files require approved supplementalTests policy and a fresh GREEN; original RED remains frozen");
  requireThat(addedFiles.length <= contract.maxChangedFiles && addedFiles.every(item =>
    /\.(?:java|kt|groovy)$/.test(item.path) && contract.allowedPaths.some(pattern => matchesPath(pattern, item.path)) &&
    !contract.forbiddenPaths.some(pattern => matchesPath(pattern, item.path))), "EVIDENCE_CHANGED", "Supplemental files must be new allowed test sources; resources and original assertions remain frozen");
  const parent = path.join(evidence, "supplement-attempts"); fs.mkdirSync(parent, { recursive: true });
  requireThat(fs.readdirSync(parent).length < contract.verification.supplementalTests.maxRevisions, "PREPARATION_BUDGET", "Supplemental revision budget exhausted; inspect retained evidence and approve a revised task");
  const attemptPath = `supplement-attempts/${randomUUID()}`, attempt = path.join(evidence, attemptPath);
  fs.mkdirSync(attempt);
  const probe = path.join(attempt, "baseline-worktree"), sourceBefore = worktree(root, excluded);
  let created = false;
  try {
    git(root, ["worktree", "add", "--detach", probe, binding.baselineHead]); created = true;
    for (const item of addedFiles) {
      const target = path.join(probe, localPath(probe, item.path));
      requireThat(!fs.existsSync(target), "EVIDENCE_CHANGED", "Supplemental test overwrites a baseline file");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fs.readFileSync(path.join(root, item.path)), { flag: "wx", mode: item.mode });
    }
    // Only the SDK path may be passed to this diagnostic worktree. No ignored
    // properties, credentials or arbitrary files are copied into model inputs.
    const sourceBuild = require("./project.cjs").gradleBuildRoot(config, root);
    const probeBuild = require("./project.cjs").gradleBuildRoot(config, probe);
    const local = path.join(sourceBuild, "local.properties");
    if (fs.existsSync(local)) {
      const lines = fs.readFileSync(local, "utf8").split(/\r?\n/).filter(line => line.trim() && !/^\s*[#!]/.test(line));
      requireThat(lines.every(line => /^\s*sdk\.dir\s*[=:]/.test(line) && !/\\$/.test(line)), "EVIDENCE_CHANGED", "Supplemental baseline requires explicit isolation setup for non-SDK local.properties entries");
      fs.writeFileSync(path.join(probeBuild, "local.properties"), lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
    }
    const before = worktree(probe, excluded);
    const collection = runGradle(probe, config, contract, "baseline", path.join(attempt, "collection"), false);
    requireThat(before === worktree(probe, excluded) && sourceBefore === worktree(root, excluded) && same(current, snapshot(root, config, patterns, excluded)),
      "INPUT_CHANGED_DURING_RUN", "Inputs changed while validating supplemental tests on the original baseline");
    requireThat(same(collection.runtime, baseline.runtime), "EVIDENCE_CHANGED", "Supplemental baseline runtime differs from original baseline");
    const expected = new Map(baseline.cases.map(item => [identity(item), item]));
    requireThat(baseline.cases.every(item => collection.cases.some(result => identity(result) === identity(item) && result.result === item.result)),
      "COVERAGE_MISMATCH", "Supplemental baseline changed existing regression outcomes");
    const cases = collection.cases.filter(item => !expected.has(identity(item)));
    requireThat(cases.length > 0 && cases.every(item => item.result === "SUCCESS" && !manifest.cases.some(original => identity(original) === identity(item))),
      "CASE_EXPECTATION_MISMATCH", "Every new supplemental case must pass on the original baseline without replacing approved behavior identities");
    git(root, ["worktree", "remove", "--force", probe]); created = false;
    const saved = { version: 1, bound, addedFiles, cases, attemptPath, files: evidenceFiles(evidence, path.join(attempt, "collection")) };
    atomic(path.join(attempt, "supplement.json"), saved, true);
    atomic(file, saved, true);
    return saved;
  } catch (error) {
    atomic(path.join(attempt, "failure.json"), { code: error.code ?? "SUPPLEMENT_FAILED", message: error.message });
    throw error;
  } finally {
    if (created) git(root, ["worktree", "remove", "--force", probe]);
  }
}
module.exports = { identity, validateCollection, evaluateBaseline, evaluateCoverage, matchesFailureOrigin, snapshot, testPatterns, isTest, runPhase };
if (require.main === module) {
  const [phase, contractFile, configFile, root, evidence] = process.argv.slice(2);
  try {
    if (phase === "is-test") {
      const baseline = read(contractFile), config = read(configFile);
      process.exitCode = isTest(config, baseline.testPatterns, evidence) ? 0 : 1;
    } else {
      const result = runPhase(phase, contractFile, configFile, root, evidence);
      console.log(`Inventory ${phase}: ${result.reasonCode}; ${JSON.stringify(result.summary)}`);
    }
  } catch (error) {
    const reasonCode = error instanceof InventoryError ? error.code : "EVIDENCE_CHANGED";
    console.error(`${reasonCode}: ${error.message}\n${recovery(reasonCode, phase)}`);
    if (evidence && phase !== "is-test") {
      const statusFile = path.join(evidence, "inventory-status.json");
      let previous = null;
      try { if (fs.existsSync(statusFile)) previous = read(statusFile); } catch { /* Replace invalid status, never sealed evidence. */ }
      const queueRunId = process.env.AUTOMATION_QUEUE_RUN_ID ?? null;
      if (!previous || previous.valid || previous.message !== error.message || previous.phase !== phase || previous.queueRunId !== queueRunId)
        atomic(statusFile, { phase, queueRunId, valid: false, reasonCode, message: error.message, issues: error.issues ?? [], nextAction: recovery(reasonCode, phase), finishedAt: new Date().toISOString() });
    }
    process.exitCode = 1;
  }
}
