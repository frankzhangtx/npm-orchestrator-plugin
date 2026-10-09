"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => hash(JSON.stringify(value));
const fileHash = file => {
  assert(fs.lstatSync(file).isFile(), `Recovery input is not a regular file: ${file}`);
  return hash(fs.readFileSync(file));
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const read = file => {
  assert(!fs.lstatSync(file).isSymbolicLink(), `Symbolic-link recovery evidence: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
function atomic(file, value, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { if (exclusive) fs.linkSync(temporary, file); else fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}


function validateExecutionPolicy(policy) {
  const keys = ["version", "maxRunMs", "maxStageMs", "terminationGraceMs"];
  assert(policy && typeof policy === "object" && !Array.isArray(policy) &&
    Object.keys(policy).length === keys.length && keys.every(key => Object.hasOwn(policy, key)), "Invalid Worker execution policy fields");
  assert(policy.version === 1, "Unsupported Worker supervision protocol");
  for (const key of ["maxRunMs", "maxStageMs"])
    assert(Number.isInteger(policy[key]) && policy[key] >= 1000 && policy[key] <= 86400000, `Invalid ${key}`);
  assert(policy.maxStageMs <= policy.maxRunMs, "Stage timeout must not exceed the run timeout");
  assert(Number.isInteger(policy.terminationGraceMs) && policy.terminationGraceMs >= 1000 && policy.terminationGraceMs <= 60000,
    "Invalid Worker termination grace period");
}

function validateRecoveryPolicy(policy) {
  const keys = ["version", "scope", "maxEnvironmentRetries", "maxManualRetries", "maxElapsedMs", "initialDelayMs", "maxDelayMs", "maxSameFailureRetries"];
  assert(policy && typeof policy === "object" && !Array.isArray(policy) &&
    Object.keys(policy).length === keys.length && keys.every(key => Object.hasOwn(policy, key)), "Invalid recovery policy fields");
  assert(policy.version === 1 && policy.scope === "baseline", "Only recovery protocol 1 for baseline capture is supported");
  for (const key of ["maxEnvironmentRetries", "maxManualRetries", "maxSameFailureRetries"])
    assert(Number.isInteger(policy[key]) && policy[key] >= 0 && policy[key] <= 3, `Invalid ${key}`);
  assert(Number.isInteger(policy.maxElapsedMs) && policy.maxElapsedMs >= 1000 && policy.maxElapsedMs <= 86400000, "Invalid recovery elapsed-time limit");
  assert(Number.isInteger(policy.initialDelayMs) && policy.initialDelayMs >= 1000 && policy.initialDelayMs <= 600000, "Invalid recovery initial delay");
  assert(Number.isInteger(policy.maxDelayMs) && policy.maxDelayMs >= policy.initialDelayMs && policy.maxDelayMs <= 600000, "Invalid recovery maximum delay");
}

// Positive, narrow signatures only. An assertion, compilation or integrity
// failure takes precedence over incidental network text in the same log.
function classifyFailure({ phase, reasonCode = "", log = "", exitCode = null }) {
  let category = "unknown", code = reasonCode || "UNKNOWN_FAILURE", retryable = false;
  if (["EVIDENCE_CHANGED", "INPUT_CHANGED_DURING_RUN", "UNSUPPORTED_TEST_INPUT"].includes(reasonCode)) category = "integrity";
  else if (["BASELINE_NOT_GREEN", "BASELINE_SKIPPED", "EMPTY_BASELINE"].includes(reasonCode) ||
    /ORCHESTRATOR_TEST_RESULT\|[^\n|]+\|\d+\|[1-9]\d*\||There were failing tests|\bAssertionError\b/.test(log)) {
    category = phase.startsWith("baseline") ? "baselineFailure" : "implementation"; code = reasonCode || "TEST_FAILURE";
  } else if (/Compilation (?:failed|error)|Unresolved reference|cannot find symbol|Could not compile/.test(log)) {
    category = phase === "red" ? "testPreparation" : "buildFailure"; code = "COMPILATION_FAILURE";
  } else if (["CASE_EXPECTATION_MISMATCH", "COVERAGE_MISMATCH", "AMBIGUOUS_IDENTITY"].includes(reasonCode)) {
    category = phase === "red" ? "testPreparation" : "implementation";
  } else if (/status code (?:401|403)\b|AuthenticationError|Unauthorized|invalid (?:API key|credentials)/i.test(log)) {
    category = "configuration"; code = "AUTHENTICATION_FAILURE";
  } else if (Number.isInteger(exitCode) && exitCode !== 0 && /(?:Received status code 429\b|HTTP(?:\/\d(?:\.\d)?)?\s+429\b|Too Many Requests)/i.test(log)) {
    category = "environment"; code = "RATE_LIMIT"; retryable = true;
  } else if (Number.isInteger(exitCode) && exitCode !== 0 && /java\.net\.(?:SocketTimeoutException|ConnectException|UnknownHostException)|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/.test(log)) {
    category = "environment"; code = "TEMPORARY_NETWORK"; retryable = true;
  }
  return { phase, category, reasonCode: code, retryable, exitCode,
    fingerprint: digest([phase, category, code]) };
}

function retryDecision(policy, record, mode, now = Date.now(), random = Math.random) {
  validateRecoveryPolicy(policy);
  const last = record.attempts.at(-1);
  if (!last || last.state !== "FAILED") return { allowed: false, reason: "No completed failed attempt" };
  if (mode !== "auto" && mode !== "manual") return { allowed: false, reason: "Invalid retry mode" };
  if (!Number.isFinite(record.startedAt) || now < record.startedAt || now >= record.startedAt + policy.maxElapsedMs)
    return { allowed: false, reason: "Recovery elapsed-time budget exhausted or clock moved backwards" };
  if (["integrity", "baselineFailure", "implementation", "testPreparation", "buildFailure", "configuration"].includes(last.failure.category))
    return { allowed: false, reason: "Failure requires correction or a revised contract" };
  const used = record.attempts.filter(attempt => attempt.mode === mode).length;
  const limit = mode === "auto" ? policy.maxEnvironmentRetries : policy.maxManualRetries;
  if (used >= limit) return { allowed: false, reason: `${mode} retry budget exhausted` };
  if (mode === "auto" && !last.failure.retryable) return { allowed: false, reason: "Unknown or non-environment failures require explicit recovery approval" };
  let repeated = 0;
  for (const attempt of [...record.attempts].reverse()) {
    if (attempt.state !== "FAILED" || attempt.failure.fingerprint !== last.failure.fingerprint) break;
    repeated++;
  }
  if (mode === "auto" && repeated > policy.maxSameFailureRetries)
    return { allowed: false, reason: "Repeated failure without stage progress" };
  const backoff = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** used);
  const delay = mode === "manual" ? 0 : Math.floor(backoff * (0.75 + 0.25 * random()));
  const nextRunAt = now + delay;
  if (nextRunAt >= record.startedAt + policy.maxElapsedMs) return { allowed: false, reason: "Backoff exceeds recovery deadline" };
  return { allowed: true, nextRunAt, reason: null };
}

function git(root, args) {
  const result = cp.spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert(result.status === 0, result.stderr || "Cannot inspect baseline repository");
  return result.stdout;
}
function helper(root, name, args = []) {
  const result = cp.spawnSync("bash", ["-euc", 'source "$1"; shift; "$@"', "baseline-recovery", path.join(root, "scripts/automation/lib.sh"), name, ...args],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert(result.status === 0, result.stderr || `Baseline helper failed: ${name}`);
  return result.stdout.trimEnd();
}
function inputBinding(root, contractFile, configFile, contract, allowProduct = false) {
  helper(root, "automation_assert_planning_artifacts_sealed", [contract.id, root]);
  const changed = helper(root, "automation_changed_paths_at", [root]).split("\n").filter(Boolean).sort();
  assert(allowProduct || JSON.stringify(changed) === JSON.stringify([`automation/tasks/${contract.id}.json`, contract.planPath].sort()),
    "Baseline recovery requires exactly the sealed plan and contract; product inputs changed");
  const excluded = [".automation-worktree-allowlist", "automation/automation-commit-prefix",
    ...JSON.parse(helper(root, "automation_effective_worktree_allowlist_json_at", [root]))].sort();
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0").filter(file => file && !excluded.includes(file)).sort();
  const inputs = [...new Set(files)].map(file => {
    const absolute = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) {
      // Tracked deletions are valid product changes after baseline capture.
      // Keep their identities in the binding so restoring them breaks backoff.
      if (allowProduct && error.code === "ENOENT") return [file, "deleted"];
      throw error;
    }
    return [file, stat.mode & 0o777, hash(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute))];
  });
  const environment = Object.fromEntries(["JAVA_HOME", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "GRADLE_OPTS", "GRADLE_USER_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT"].map(key => [key, process.env[key] ?? null]));
  const localProperties = path.join(require("./project.cjs").gradleBuildRoot(read(configFile), root), "local.properties");
  return { contractSha256: fileHash(contractFile), configSha256: fileHash(configFile), head: git(root, ["rev-parse", "HEAD"]).trim(),
    inputsSha256: digest(inputs), excludedPathsSha256: digest(excluded), environmentSha256: digest(environment),
    buildEnvironmentSha256: require("./project.cjs").buildEnvironmentBinding(require("./project.cjs").gradleBuildRoot(read(configFile), root)), node: process.version,
    localPropertiesSha256: fs.existsSync(localProperties) ? fileHash(localProperties) : null };
}
function artifactHashes(evidence, directory) {
  const entries = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), "Symlink in recovery evidence");
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else entries.push([path.relative(evidence, file), fileHash(file)]);
  }
  visit(directory);
  return entries;
}
function checkArtifacts(evidence, record) {
  for (const attempt of record.attempts) {
    assert(attempt.state !== "RUNNING", "Previous capture has no durable outcome; explicit process recovery is required");
    for (const [file, sha] of attempt.files ?? []) {
      assert(!path.isAbsolute(file) && !file.split(path.sep).includes(".."), "Invalid recovery artifact path");
      const absolute = path.join(evidence, file);
      assert(fs.realpathSync(absolute) === absolute, `Recovery evidence path changed: ${file}`);
      assert(fileHash(absolute) === sha, `Recovery evidence changed: ${file}`);
    }
  }
  for (const [file, sha] of Object.entries(record.checkpoints))
    assert(fileHash(path.join(evidence, file)) === sha, `Baseline checkpoint changed: ${file}`);
}

function captureBaseline(contractFile, configFile, root, evidence, mode, expectedHash) {
  const contract = read(contractFile), config = read(configFile);
  require("./contract.cjs").validateContract(contract, config);
  assert(contract.schemaVersion >= 5, "Baseline checkpoint recovery requires a V5 contract");
  root = fs.realpathSync(root);
  const ledger = path.join(evidence, "baseline-recovery.json");
  const binding = inputBinding(root, contractFile, configFile, contract);
  let record;
  if (fs.existsSync(ledger)) {
    assert(expectedHash && fileHash(ledger) === expectedHash, "Recovery ledger differs from the queue's sealed checkpoint");
    record = read(ledger);
    assert(digest(record.binding) === digest(binding), "Baseline inputs, HEAD, contract, configuration or toolchain changed");
    checkArtifacts(evidence, record);
    assert(record.state !== "COMPLETE" && !fs.existsSync(path.join(evidence, "baseline.json")), "Successful baseline cannot be overwritten");
    const decision = retryDecision(contract.recovery, record, mode);
    assert(decision.allowed, decision.reason);
    if (mode === "auto") assert(record.nextRunAt !== null && Date.now() >= record.nextRunAt, "Persisted retry backoff has not elapsed");
  } else {
    assert(mode === "initial" && !expectedHash, "Recovery ledger is missing; budgets cannot be reset");
    for (const file of ["baseline.json", "baseline-full.json", "baseline-discovery.json", "baseline-inventory.json", "red.json"])
      assert(!fs.existsSync(path.join(evidence, file)), `Unexpected existing baseline evidence: ${file}`);
    record = { version: 1, binding, startedAt: Date.now(), state: "RUNNING", attempts: [], checkpoints: {}, nextRunAt: null, modelInvocations: 0 };
  }
  const checkpoint = name => { record.checkpoints[name] = fileHash(path.join(evidence, name)); };
  const persist = () => atomic(ledger, record);
  // One retry pays once even when it completes more than one remaining stage.
  let attemptMode = mode;
  for (const stage of ["baseline-full", "baseline-inventory"]) {
    if (record.checkpoints[`${stage}.json`]) continue;
    assert(Date.now() < record.startedAt + contract.recovery.maxElapsedMs, "Recovery elapsed-time budget exhausted");
    const attemptDir = path.join(evidence, `baseline-attempt-${record.attempts.length + 1}-${randomUUID()}`);
    fs.mkdirSync(attemptDir);
    const attempt = { stage, mode: attemptMode, state: "RUNNING", queueRunId: process.env.AUTOMATION_QUEUE_RUN_ID,
      startedAt: Date.now(), directory: path.basename(attemptDir) };
    attemptMode = "continuation";
    record.attempts.push(attempt); record.state = "RUNNING"; record.nextRunAt = null; persist();
    const logFile = path.join(attemptDir, "command.log"), fd = fs.openSync(logFile, "wx");
    let result;
    try {
      const args = stage === "baseline-full"
        ? ["-euc", 'source "$1"; automation_run_gradle_group fullUnitTestTasks "$2"', "baseline-capture", path.join(root, "scripts/automation/lib.sh"), root]
        : [path.join(root, "automation/verification/inventory.cjs"), "baseline", contractFile, configFile, root, evidence];
      result = cp.spawnSync(stage === "baseline-full" ? "bash" : process.execPath, args, { cwd: root, stdio: ["ignore", fd, fd] });
    } finally { fs.closeSync(fd); }
    attempt.finishedAt = Date.now(); attempt.exitCode = result.status; attempt.state = result.status === 0 ? "PASSED" : "FAILED";
    let log = fs.readFileSync(logFile, "utf8"), reasonCode = "";
    if (stage === "baseline-inventory") {
      if (fs.existsSync(path.join(evidence, "baseline-discovery.json"))) checkpoint("baseline-discovery.json");
      const status = path.join(evidence, "inventory-status.json");
      if (fs.existsSync(status)) {
        const detail = read(status);
        if (detail.queueRunId === process.env.AUTOMATION_QUEUE_RUN_ID && detail.attemptPath) {
          assert(/^inventory-attempts\/baseline-[0-9]+-[a-f0-9-]+$/.test(detail.attemptPath), "Invalid baseline inventory attempt path");
          attempt.inventoryFiles = artifactHashes(evidence, path.join(evidence, detail.attemptPath));
          for (const [file] of attempt.inventoryFiles) if (file.endsWith("gradle.log")) log += fs.readFileSync(path.join(evidence, file), "utf8");
          reasonCode = detail.valid ? "" : detail.reasonCode;
        }
      }
    }
    if (digest(inputBinding(root, contractFile, configFile, contract)) !== digest(binding)) {
      attempt.state = "FAILED"; reasonCode = "INPUT_CHANGED_DURING_RUN";
    }
    atomic(path.join(attemptDir, "process.json"), { exitCode: result.status, signal: result.signal, error: result.error?.message ?? null });
    attempt.files = [...artifactHashes(evidence, attemptDir), ...(attempt.inventoryFiles ?? [])]; delete attempt.inventoryFiles;
    if (attempt.state === "FAILED") {
      attempt.failure = classifyFailure({ phase: stage, reasonCode, log, exitCode: result.status });
      record.state = "FAILED";
      const decision = retryDecision(contract.recovery, record, "auto");
      record.nextRunAt = decision.allowed ? decision.nextRunAt : null;
      record.waitingReason = decision.reason;
      persist();
      return { ok: false, record };
    }
    if (stage === "baseline-full") {
      atomic(path.join(evidence, "baseline-full.json"), { taskId: contract.id, startedAt: new Date(attempt.startedAt).toISOString(),
        finishedAt: new Date(attempt.finishedAt).toISOString(), head: binding.head, worktree: root,
        cwd: require("./project.cjs").gradleBuildRoot(config, root),
        command: ["./gradlew", ...config.gradleVerification.fullUnitTestTasks, ...(process.env.AUTOMATION_WORKER_TOKEN ? ["--no-daemon"] : [])], unitTestsEnabled: true, exitCode: 0 }, true);
      const { matchesPath } = require("./contract.cjs");
      const protectedFiles = git(root, ["ls-files", "-z"]).split("\0").filter(file => file && config.protectedPaths.some(pattern => matchesPath(pattern, file)));
      fs.writeFileSync(path.join(evidence, "protected.sha256"), protectedFiles.map(file => `${fileHash(path.join(root, file))}  ${path.join(root, file)}\n`).join(""), { flag: "wx" });
      checkpoint("protected.sha256");
    }
    checkpoint(`${stage}.json`); persist();
  }
  // Final baseline bytes match the full-test checkpoint used by the inventory
  // binding. Only successful complete capture publishes baseline.json.
  fs.copyFileSync(path.join(evidence, "baseline-full.json"), path.join(evidence, "baseline.json"), fs.constants.COPYFILE_EXCL);
  checkpoint("baseline.json"); record.state = "COMPLETE"; record.nextRunAt = null; record.waitingReason = null; persist();
  return { ok: true, record };
}

function validateStageRecoveryPolicy(policy) {
  const keys = ["version", "maxEnvironmentRetries", "maxElapsedMs", "initialDelayMs", "maxDelayMs", "maxSameFailureRetries"];
  assert(policy && Object.keys(policy).length === keys.length && keys.every(key => Object.hasOwn(policy, key)), "Invalid stage recovery policy fields");
  validateRecoveryPolicy({ ...policy, scope: "baseline", maxManualRetries: 0 });
}

function stageRetryDecision(policy, record, now = Date.now(), random = Math.random) {
  validateStageRecoveryPolicy(policy);
  if (!record.lastFailure?.retryable) return { allowed: false, reason: "Failure is not an identified transient environment error" };
  if (now < record.startedAt || now < record.lastObservedAt || now >= record.startedAt + policy.maxElapsedMs)
    return { allowed: false, reason: "Stage recovery window exhausted or clock moved backwards" };
  if (record.retriesUsed >= policy.maxEnvironmentRetries) return { allowed: false, reason: "Stage environment retry budget exhausted" };
  if (record.sameFailureCount > policy.maxSameFailureRetries) return { allowed: false, reason: "Repeated failure without verification progress" };
  const delay = Math.floor(Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** record.retriesUsed) * (0.75 + 0.25 * random()));
  const nextRunAt = now + delay;
  if (nextRunAt >= record.startedAt + policy.maxElapsedMs) return { allowed: false, reason: "Backoff exceeds stage recovery window" };
  return { allowed: true, nextRunAt, reason: null };
}

// The trusted entry points retry deterministic verification only, never a model
// invocation or a commit. One durable budget is shared by all calls in a phase.
function persistStageRecord(ledger, record, previous, checkpoint) {
  if (previous) assert(fileHash(ledger) === previous, "Stage recovery ledger changed before update");
  else assert(!fs.existsSync(ledger), "Stage recovery ledger appeared outside its owner");
  // Bind the intended bytes, not a reread that could adopt an external edit.
  const next = hash(JSON.stringify(record, null, 2) + "\n");
  atomic(ledger, record);
  assert(fileHash(ledger) === next, "Stage recovery bytes changed before checkpoint");
  checkpoint(previous, next);
  assert(fileHash(ledger) === next, "Stage recovery bytes changed during checkpoint");
  return next;
}

function runStage(phase, contractFile, configFile, root, evidence) {
  assert(["red", "green", "review"].includes(phase), "Unsupported recovery phase");
  const contract = read(contractFile), config = read(configFile);
  require("./contract.cjs").validateContract(contract, config);
  assert(contract.schemaVersion >= 7, "Stage recovery requires a new V7 approval");
  root = fs.realpathSync(root); evidence = fs.realpathSync(evidence);
  const policy = contract.stageRecovery;
  const authorize = () => helper(root, "automation_require_queue_execution", [contract.id]);
  authorize();
  const directory = path.join(evidence, "stage-recovery"); fs.mkdirSync(directory, { recursive: true });
  assert(fs.realpathSync(directory) === directory, "Stage evidence path changed");
  const ledger = path.join(directory, `${phase}.json`), lock = path.join(directory, `${phase}.lock`);
  const bridge = process.env.OPENCODE_ANDROID_ORCHESTRATOR_QUEUE_CLI;
  assert(bridge && path.isAbsolute(bridge), "Trusted queue checkpoint bridge is missing");
  let sealedHash = fs.existsSync(ledger) ? fileHash(ledger) : "";
  const checkpoint = (previous, next) => {
    const result = cp.spawnSync(process.execPath, [bridge, "_stage-record", root, phase, previous, next], { cwd: root, encoding: "utf8" });
    assert(result.status === 0, result.stderr || "Cannot seal stage recovery checkpoint");
  };
  if (sealedHash) checkpoint(sealedHash, sealedHash);
  const descriptor = fs.openSync(lock, "wx", 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, queueRunId: process.env.AUTOMATION_QUEUE_RUN_ID })); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  let record, writableRecord = false;
  try {
    const binding = () => ({ ...inputBinding(root, contractFile, configFile, contract, true),
      evidence: Object.fromEntries(["baseline.json", "baseline-inventory.json", ...(phase === "red" ? [] : ["red.json", "test-manifest.json", "test-preflight.json"]), ...(phase === "review" ? ["ready.json"] : [])]
        .map(file => [file, fileHash(path.join(evidence, file))])) });
    const currentBinding = binding(), now = Date.now();
    record = fs.existsSync(ledger) ? read(ledger) : { version: 1, phase, taskId: contract.id,
      contractSha256: fileHash(contractFile), policySha256: digest(policy), startedAt: now, lastObservedAt: now,
      retriesUsed: 0, sameFailureCount: 0, lastFailure: null, nextRunAt: null, state: "IDLE", attempts: [] };
    assert(record.version === 1 && record.phase === phase && record.taskId === contract.id && record.policySha256 === digest(policy) &&
      record.contractSha256 === fileHash(contractFile), "Stage recovery authorization changed");
    assert(record.state !== "RUNNING", "Previous verification has no durable outcome; explicit ownership recovery is required");
    for (const attempt of record.attempts) {
      assert(/^attempt-[a-f0-9-]+\.log$/.test(attempt.log), "Invalid stage attempt evidence path");
      assert(fileHash(path.join(directory, attempt.log)) === attempt.logSha256, "Stage attempt evidence changed");
    }
    checkArtifacts(evidence, { attempts: record.attempts, checkpoints: {} });
    assert(!["EXHAUSTED", "BLOCKED"].includes(record.state), "Stage recovery stopped; inspect evidence and approve a revised contract");
    writableRecord = true;
    if (record.state === "WAITING") assert(digest(record.binding) === digest(currentBinding), "Verification inputs changed during backoff");
    else { record.binding = currentBinding; record.state = "IDLE"; }
    const save = () => {
      sealedHash = persistStageRecord(ledger, record, sealedHash, checkpoint);
    };
    for (;;) {
      authorize();
      if (sealedHash) assert(fileHash(ledger) === sealedHash, "Stage recovery ledger changed during execution");
      const clock = Date.now();
      assert(clock >= record.lastObservedAt && clock >= record.startedAt, "Clock moved backwards during stage recovery");
      record.lastObservedAt = clock;
      assert(digest(binding()) === digest(record.binding), "Verification inputs or sealed evidence changed");
      checkArtifacts(evidence, { attempts: record.attempts, checkpoints: {} });
      for (const previous of record.attempts)
        assert(fileHash(path.join(directory, previous.log)) === previous.logSha256, "Stage attempt evidence changed");
      if (record.state === "WAITING") {
        if (clock >= record.startedAt + policy.maxElapsedMs) {
          record.state = "EXHAUSTED"; record.nextRunAt = null; record.waitingReason = "Stage recovery window exhausted"; save(); return 75;
        }
        if (clock < record.nextRunAt) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1000, record.nextRunAt - clock)); continue;
        }
        record.retriesUsed++;
      }
      const attempt = { id: randomUUID(), queueRunId: process.env.AUTOMATION_QUEUE_RUN_ID, startedAt: clock,
        retry: record.state === "WAITING", log: `attempt-${randomUUID()}.log`, state: "RUNNING" };
      record.state = "RUNNING"; record.nextRunAt = null; record.attempts.push(attempt); save();
      const logPath = path.join(directory, attempt.log), fd = fs.openSync(logPath, "wx", 0o600);
      const inventoryBefore = fs.existsSync(path.join(evidence, "inventory-status.json")) ? fileHash(path.join(evidence, "inventory-status.json")) : null;
      const command = phase === "red" ? process.execPath : "bash";
      const args = phase === "red" ? [path.join(__dirname, "inventory.cjs"), "red", contractFile, configFile, root, evidence]
        : [path.join(root, "scripts/automation/verify-task.sh"), contract.id];
      let result;
      try { result = cp.spawnSync(command, args, { cwd: root, stdio: ["ignore", fd, fd],
        env: { ...process.env, AUTOMATION_STAGE_RECOVERY_PHASE: phase } }); }
      finally { fs.closeSync(fd); }
      attempt.finishedAt = Date.now(); attempt.exitCode = result.status; attempt.signal = result.signal;
      attempt.state = result.status === 0 ? "PASSED" : "FAILED"; attempt.logSha256 = fileHash(logPath);
      const log = fs.readFileSync(logPath, "utf8"); process.stdout.write(log);
      assert(digest(binding()) === digest(record.binding), "Verification changed its inputs or sealed evidence");
      let failure = classifyFailure({ phase, log, exitCode: result.status });
      const statusPath = path.join(evidence, "inventory-status.json");
      if (result.status !== 0 && fs.existsSync(statusPath) && fileHash(statusPath) !== inventoryBefore) {
        const status = read(statusPath);
        if (status.attemptPath) {
          assert(new RegExp(`^inventory-attempts/${phase === "red" ? "red" : "green"}-[0-9]+-[a-f0-9-]+$`).test(status.attemptPath), "Unexpected verification attempt path");
          attempt.files = artifactHashes(evidence, path.join(evidence, status.attemptPath));
        }
        if (!status.valid && status.queueRunId === process.env.AUTOMATION_QUEUE_RUN_ID && status.failure) failure = status.failure;
        else if (!status.valid) failure = classifyFailure({ phase, reasonCode: status.reasonCode, log, exitCode: result.status });
      }
      // Scope/integrity exits and signal termination can never grant retries.
      if (result.signal || result.error || [40, 41].includes(result.status)) failure = { ...failure, category: "integrity", retryable: false };
      attempt.failure = result.status === 0 ? null : failure;
      if (result.status === 0) {
        record.state = "PASSED"; record.lastFailure = null; record.sameFailureCount = 0; record.waitingReason = null; save(); return 0;
      }
      record.sameFailureCount = record.lastFailure?.fingerprint === failure.fingerprint ? record.sameFailureCount + 1 : 1;
      record.lastFailure = failure;
      const decision = stageRetryDecision(policy, record, Date.now());
      record.waitingReason = decision.reason;
      if (!decision.allowed) {
        record.state = failure.retryable ? "EXHAUSTED" : "FAILED"; record.nextRunAt = null; save();
        return failure.retryable ? 75 : ["unknown", "configuration", "integrity"].includes(failure.category) ? 76 : 1;
      }
      record.state = "WAITING"; record.nextRunAt = decision.nextRunAt; save();
    }
  } catch (error) {
    if (writableRecord) {
      record.state = "BLOCKED"; record.nextRunAt = null; record.waitingReason = error.message;
      // A concurrently altered ledger must remain intact for diagnosis.
      if (!sealedHash || fileHash(ledger) === sealedHash) {
        sealedHash = persistStageRecord(ledger, record, sealedHash, checkpoint);
      }
    }
    throw error;
  } finally { fs.unlinkSync(lock); }
}

module.exports = { validateExecutionPolicy, validateRecoveryPolicy, validateStageRecoveryPolicy, stageRetryDecision, persistStageRecord, runStage, classifyFailure, retryDecision, captureBaseline, fileHash };
if (require.main === module) {
  const argv = process.argv.slice(2);
  const [contract, config, root, evidence, mode, expectedHash] = argv;
  try {
    if (contract === "--stage") process.exitCode = runStage(...argv.slice(1));
    else {
      const result = captureBaseline(contract, config, root, evidence, mode, expectedHash || null);
      if (!result.ok) { console.error(JSON.stringify(result.record.attempts.at(-1).failure)); process.exitCode = 75; }
    }
  } catch (error) { console.error(error.message); process.exitCode = 76; }
}
