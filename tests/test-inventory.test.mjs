import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateContract } from "../dist/queue/queue.js";
import { fixture, taskContract } from "./queue-fixture.mjs";
const require = createRequire(import.meta.url);
const { validateCollection, evaluateBaseline, evaluateCoverage, snapshot } = require("../templates/automation/verification/inventory.cjs");

export function inventoryContract(f, id = "TASK-INVENTORY-001") {
  const contract = taskContract(f, id);
  contract.schemaVersion = 4;
  contract.targetTests = [{ gradleTask: ":app:testDebugUnitTest", filter: "example.*" }];
  contract.verification.version = 2;
  contract.verification.inventory = { mode: "focusedBaseline", existingSkips: "reject", emptyBaseline: "reject" };
  contract.verification.cases[0].test = { target: 0, className: "example.FeatureTest", name: "approved[0]" };
  return contract;
}
const config = { protectedPaths: ["automation/**"], gradleVerification: { focusedTestTasks: [":app:testDebugUnitTest", ":lib:test"] } };
function contract() {
  const result = {
    schemaVersion: 4, id: "TASK-INVENTORY-001", title: "Restore safe parsing", designApproved: true,
    planPath: "docs/plans/TASK-INVENTORY-001.md", ambiguityPolicy: "BLOCKED", maxFixLoops: 1, maxChangedFiles: 4,
    allowedPaths: ["app/src/**"], forbiddenPaths: ["automation/**"],
    allowedWorkflowSkills: ["test-driven-development", "systematic-debugging", "verification-before-completion"].map(name => `android-orchestrator-${name}`),
    acceptanceCriteria: ["Invalid inputs are rejected"], nonGoals: ["No public API changes"], deviceTestsRequired: false, testPolicy: "required",
    targetTests: [{ gradleTask: ":app:testDebugUnitTest", filter: "example.*" }],
    verification: { version: 2, maxPreparationFixes: 1, inventory: { mode: "focusedBaseline", existingSkips: "reject", emptyBaseline: "reject" },
      cases: [{ id: "INVALID-INPUT", criterion: 1, intent: "change", before: "fail", after: "pass", source: "userRequirement",
        test: { target: 0, className: "example.FeatureTest", name: "approved[0]" },
        expectedFailure: { type: "java.lang.AssertionError", messageIncludes: "expected missing behavior", origin: "The approved behavior assertion" } }] } };
  return result;
}
const actual = (name, result = "SUCCESS", taskPath = ":app:testDebugUnitTest") => ({ taskPath, className: "example.FeatureTest", name, result,
  failures: result === "FAILURE" ? [{ type: "java.lang.AssertionError", message: "expected missing behavior", stack: [`example.FeatureTest.${name.replace(/\[[^\]]*\]$/, "")}(FeatureTest.kt:20)`] }] : [] });
const tasks = [{ taskPath: ":app:testDebugUnitTest", filters: ["example.*"], sourceRoots: ["app/src/test/java"] }];
const baseline = { tasks, cases: [actual("legacy")] };
const red = { tasks, cases: [actual("legacy"), actual("approved[0]", "FAILURE")] };
const failure = code => error => error.code === code;

test("V4 queue and shell share explicit inventory policy validation; legacy contracts stay V3", () => {
  const f = fixture();
  try {
    const value = inventoryContract(f);
    f.config.gradleVerification.focusedTestTasks.push(":app:testDebugUnitTest");
    writeFileSync(join(f.root, "automation/config.json"), JSON.stringify(f.config));
    writeFileSync(join(f.root, value.planPath), "Approved behavior plan\n");
    const file = join(f.root, `automation/tasks/${value.id}.json`);
    for (const mutate of [value => value, value => { value.verification.cases[0].test.className = "example.TodoAdapterTest"; },
      value => { delete value.verification.inventory; },
      value => { value.verification.inventory.existingSkips = "ignore"; },
      value => { value.targetTests[0].gradleTask = "testDebugUnitTest"; },
      value => { value.verification.cases.push(structuredClone(value.verification.cases[0])); }]) {
      const candidate = structuredClone(value); mutate(candidate);
      writeFileSync(file, JSON.stringify(candidate));
      const shell = spawnSync("bash", ["scripts/automation/validate-contract.sh", file], { cwd: f.root, encoding: "utf8" });
      let queueValid = true;
      try { validateContract(candidate, f.config); } catch { queueValid = false; }
      assert.equal(shell.status === 0, queueValid, shell.stderr);
    }
    validateContract(taskContract(f, "TASK-LEGACY-003"), f.config);
  } finally { f.cleanup(); }
});
test("V4 rejects aliases, duplicate behavior identities across overlapping filters and undeclared policy fields", () => {
  const value = contract(); validateContract(value, config);
  value.targetTests.push({ gradleTask: ":app:testDebugUnitTest", filter: "example.FeatureTest" });
  value.verification.cases.push({ ...structuredClone(value.verification.cases[0]), id: "SECOND-INPUT", test: { target: 1, className: "example.FeatureTest", name: "approved[0]" } });
  assert.throws(() => validateContract(value, config), /overlap/);
  const alias = contract(); alias.targetTests[0].gradleTask = "testDebugUnitTest";
  assert.throws(() => validateContract(alias, config), /fully qualified/);
});
test("baseline auto-classifies existing regression tests and RED/GREEN use the same complete manifest", () => {
  const value = contract(); evaluateBaseline(value, baseline);
  const manifest = evaluateCoverage(value, baseline, red, "red");
  assert.deepEqual(manifest.summary, { declared: 1, regression: 1, total: 2, expectedRed: 1, skipped: 0 });
  const green = { tasks, cases: [actual("approved[0]"), actual("legacy")] };
  assert.equal(evaluateCoverage(value, baseline, green, "green", manifest).summary.total, 2);
  for (const cases of [[actual("approved[0]")], [actual("legacy", "SKIPPED"), actual("approved[0]")],
    [...green.cases, actual("unapproved extra")], [actual("legacy"), actual("approved[1]")]])
    assert.throws(() => evaluateCoverage(value, baseline, { tasks, cases }, "green", manifest), failure("COVERAGE_MISMATCH"));
  assert.throws(() => evaluateCoverage(value, baseline, { tasks, cases: [actual("legacy", "FAILURE"), actual("approved[0]", "FAILURE")] }, "red"), failure("CASE_EXPECTATION_MISMATCH"));
});
test("existing skips and per-task empty baselines require explicit approval; no new skips are tolerated", () => {
  const value = contract(), skipped = { tasks, cases: [actual("legacy", "SKIPPED")] }, empty = { tasks, cases: [] };
  assert.throws(() => evaluateBaseline(value, skipped), failure("BASELINE_SKIPPED"));
  assert.throws(() => evaluateBaseline(value, empty), failure("EMPTY_BASELINE"));
  value.verification.inventory = { mode: "focusedBaseline", existingSkips: "preserve", emptyBaseline: "allow" };
  evaluateBaseline(value, empty); evaluateBaseline(value, skipped);
  const preserved = evaluateCoverage(value, skipped, { tasks, cases: [actual("legacy", "SKIPPED"), actual("approved[0]", "FAILURE")] }, "red");
  evaluateCoverage(value, skipped, { tasks, cases: [actual("legacy", "SKIPPED"), actual("approved[0]")] }, "green", preserved);
  const improved = evaluateCoverage(value, skipped, red, "red");
  assert.throws(() => evaluateCoverage(value, skipped, { tasks, cases: [actual("legacy", "SKIPPED"), actual("approved[0]")] }, "green", improved), failure("COVERAGE_MISMATCH"));
  assert.throws(() => evaluateBaseline(value, { tasks, cases: [actual("legacy", "FAILURE")] }), failure("BASELINE_NOT_GREEN"));
});
function stream(cases = red.cases) {
  const request = { runId: "fresh-run", phase: "red", targets: contract().targetTests };
  const events = [{ kind: "start", phase: "red" }, { kind: "task", ...tasks[0] }, ...cases.map(item => ({ kind: "case", ...item })),
    { kind: "suite", taskPath: tasks[0].taskPath, tests: cases.length, failures: cases.filter(item => item.result === "FAILURE").length, skipped: cases.filter(item => item.result === "SKIPPED").length },
    { kind: "taskEnd", taskPath: tasks[0].taskPath, executed: true, skipped: false, noSource: false, upToDate: false, failure: null }, { kind: "end", failure: null }]
    .map(item => ({ ...item, runId: request.runId }));
  return { request, events };
}
test("collector rejects cached, interrupted, malformed, duplicate and count-mismatched executions", () => {
  const valid = stream(); assert.equal(validateCollection(valid.events, valid.request, 0).cases.length, 2);
  for (const mutate of [events => events.pop(), events => { events[0].runId = "stale"; },
    events => { events.at(-2).skipped = true; events.at(-2).skipMessage = "FROM-CACHE"; },
    events => { events.at(-3).tests = 999; }, events => { events[1].taskPath = ":other:test"; },
    events => { events.at(-1).failure = "fixture failure"; }]) {
    const sample = stream(); mutate(sample.events);
    assert.throws(() => validateCollection(sample.events, sample.request, 0), failure("INCOMPLETE_COLLECTION"));
  }
  const repeated = stream([actual("same"), actual("same")]);
  assert.throws(() => validateCollection(repeated.events, repeated.request, 0), failure("AMBIGUOUS_IDENTITY"));
  assert.throws(() => validateCollection(valid.events, valid.request, 1), failure("EXECUTION_FAILURE"));
});
test("parameter instances are separate identities and same test names in different tasks do not collide", () => {
  const value = contract(); value.targetTests.push({ gradleTask: ":lib:test", filter: "example.*" });
  const existing = { cases: [actual("parameter[0]"), actual("parameter[1]"), actual("parameter[0]", "SUCCESS", ":lib:test")] };
  const manifest = evaluateCoverage(value, existing, { cases: [...existing.cases, actual("approved[0]", "FAILURE")] }, "red");
  assert.equal(manifest.summary.regression, 3);
  assert.throws(() => evaluateCoverage(value, existing, { cases: [actual("parameter[0]"), actual("approved[0]", "FAILURE")] }, "red"), failure("COVERAGE_MISMATCH"));
});
test("snapshot includes unchanged custom test resources and detects their edits", () => {
  const f = fixture();
  try {
    const patterns = ["app/src/test/**"];
    const file = join(f.root, "app/src/test/input.json"); writeFileSync(file, '{"expected":1}\n');
    const before = snapshot(f.root, f.config, patterns);
    writeFileSync(file, '{"expected":2}\n');
    assert.notDeepEqual(snapshot(f.root, f.config, patterns), before);
    assert.equal(readFileSync(file, "utf8").includes("2"), true);
  } finally { f.cleanup(); }
});
