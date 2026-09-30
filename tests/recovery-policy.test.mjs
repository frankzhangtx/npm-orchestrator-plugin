import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateContract } from "../dist/queue/queue.js";
import { fixture, taskContract } from "./queue-fixture.mjs";
const { validateRecoveryPolicy, classifyFailure, retryDecision } = createRequire(import.meta.url)("../templates/automation/verification/recovery.cjs");
export const recoveryPolicy = { version: 1, scope: "baseline", maxEnvironmentRetries: 2, maxManualRetries: 1,
  maxElapsedMs: 900000, initialDelayMs: 1000, maxDelayMs: 60000, maxSameFailureRetries: 2 };

test("queue and installed shell require explicit V5 recovery without relaxing inventory verification", () => {
  const f = fixture({ inventoryMode: true });
  try {
    const value = { ...taskContract(f, "TASK-POLICY"), schemaVersion: 5, recovery: recoveryPolicy };
    writeFileSync(join(f.root, value.planPath), "Approved bounded behavior plan\n");
    const file = join(f.root, `automation/tasks/${value.id}.json`);
    for (const [valid, mutate] of [[true, () => {}], [false, c => { delete c.recovery; }],
      [false, c => { c.schemaVersion = 4; }], [false, c => { c.recovery.maxEnvironmentRetries = 4; }],
      [false, c => { c.recovery.maxDelayMs = 1000; c.recovery.initialDelayMs = 2000; }],
      [false, c => { c.testPolicy = "not-required"; }], [false, c => { c.verification.version = 1; }],
      [false, c => { c.verification.cases = []; }],
      [true, c => { c.schemaVersion = 4; delete c.recovery; }]]) {
      const candidate = structuredClone(value); mutate(candidate);
      if (valid) validateContract(candidate, f.config);
      else assert.throws(() => validateContract(candidate, f.config));
      writeFileSync(file, JSON.stringify(candidate));
      const result = spawnSync("bash", ["scripts/automation/validate-contract.sh", file], { cwd: f.root, encoding: "utf8" });
      assert.equal(result.status === 0, valid, result.stderr);
    }
  } finally { f.cleanup(); }
});

test("recovery policy rejects unbounded, ambiguous or unsupported authorization", () => {
  validateRecoveryPolicy(recoveryPolicy);
  for (const changes of [{ maxEnvironmentRetries: 4 }, { maxManualRetries: -1 }, { maxElapsedMs: 0 },
    { scope: "all" }, { version: 2 }, { maxDelayMs: 1 }, { extraAuthority: true }])
    assert.throws(() => validateRecoveryPolicy({ ...recoveryPolicy, ...changes }));
});

test("classification distinguishes environment, history, preparation, implementation and unknown failures", () => {
  for (const [phase, log, reasonCode, category, retryable] of [
    ["baseline-full", "java.net.SocketTimeoutException: Read timed out", "", "environment", true],
    ["baseline-inventory", "Received status code 429 from server", "EXECUTION_FAILURE", "environment", true],
    ["baseline-full", "AuthenticationError: invalid credentials", "", "configuration", false],
    ["baseline-inventory", "java.net.SocketTimeoutException", "BASELINE_NOT_GREEN", "baselineFailure", false],
    ["baseline-full", "There were failing tests. ECONNRESET", "", "baselineFailure", false],
    ["red", "Compilation failed. HTTP 429", "", "testPreparation", false],
    ["green", "", "CASE_EXPECTATION_MISMATCH", "implementation", false],
    ["baseline-full", "unknown agent exited 7", "", "unknown", false],
    ["baseline-inventory", "", "INCOMPLETE_COLLECTION", "unknown", false],
    ["baseline-full", "HTTP 429", "EVIDENCE_CHANGED", "integrity", false],
  ]) {
    const failure = classifyFailure({ phase, log, reasonCode, exitCode: 1 });
    assert.equal(failure.category, category); assert.equal(failure.retryable, retryable);
  }
});

test("retry budgets and backoff survive serialization, do not spend repair budgets, and stop without progress", () => {
  const failure = classifyFailure({ phase: "baseline-full", log: "java.net.ConnectException", exitCode: 1 });
  const first = { mode: "initial", state: "FAILED", failure };
  const record = { startedAt: 10000, attempts: [first] };
  assert.deepEqual(retryDecision(recoveryPolicy, record, "auto", 11000, () => 0), { allowed: true, nextRunAt: 11750, reason: null });
  record.attempts.push({ ...first, mode: "auto" });
  assert.equal(retryDecision(recoveryPolicy, JSON.parse(JSON.stringify(record)), "auto", 12000, () => 0).nextRunAt, 13500);
  record.attempts.push({ ...first, mode: "auto" });
  assert.match(retryDecision(recoveryPolicy, record, "auto", 13000).reason, /budget exhausted/);
  assert.match(retryDecision({ ...recoveryPolicy, maxEnvironmentRetries: 3, maxSameFailureRetries: 1 }, record, "auto", 13000).reason, /without stage progress/);
  assert.match(retryDecision(recoveryPolicy, record, "manual", 9999).reason, /clock moved backwards/);
  assert.match(retryDecision(recoveryPolicy, record, "manual", 1000000).reason, /elapsed-time/);
  assert.equal(retryDecision(recoveryPolicy, record, "manual", 14000).allowed, true);
  record.attempts.push({ ...first, mode: "manual" });
  assert.match(retryDecision(recoveryPolicy, record, "manual", 15000).reason, /manual retry budget/);
});

test("successful or signal-terminated commands cannot acquire network retry authority from log text", () => {
  for (const exitCode of [0, null, undefined]) {
    const failure = classifyFailure({ phase: "baseline-full", log: "HTTP 429 ECONNRESET", exitCode });
    assert.equal(failure.category, "unknown");
    assert.equal(failure.retryable, false);
  }
});

test("zero budgets, recovery deadline and incomplete attempts stop new retries", () => {
  const failure = classifyFailure({ phase: "baseline-full", log: "HTTP 429", exitCode: 1 });
  const record = { startedAt: 10000, attempts: [{ mode: "initial", state: "FAILED", failure }] };
  assert.match(retryDecision({ ...recoveryPolicy, maxEnvironmentRetries: 0 }, record, "auto", 10001).reason, /budget exhausted/);
  assert.match(retryDecision({ ...recoveryPolicy, maxManualRetries: 0 }, record, "manual", 10001).reason, /budget exhausted/);
  assert.match(retryDecision({ ...recoveryPolicy, maxElapsedMs: 1000 }, record, "auto", 10900).reason, /deadline/);
  record.attempts[0].state = "RUNNING";
  assert.match(retryDecision(recoveryPolicy, record, "auto", 11000).reason, /No completed failed attempt/);
});
