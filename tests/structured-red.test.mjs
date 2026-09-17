import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateContract } from "../dist/queue/queue.js";
import { enqueue, fixture, run, taskContract } from "./queue-fixture.mjs";

test("schema V3 rejects contradictory or ambiguous test classifications", () => {
  const f = fixture();
  try {
    const preserved = taskContract(f, "TASK-CONTRACT-RED-001");
    Object.assign(preserved.verification.cases[0], {
      intent: "preserve", before: "fail", source: "measuredFact",
    });
    assert.throws(() => validateContract(preserved, f.queue.config()), /Preserved behavior must pass/);

    const missingFailure = taskContract(f, "TASK-CONTRACT-RED-002");
    delete missingFailure.verification.cases[0].expectedFailure;
    assert.throws(() => validateContract(missingFailure, f.queue.config()), /requires an expected failure/);

    const invalidTarget = taskContract(f, "TASK-CONTRACT-RED-003");
    invalidTarget.verification.cases[0].test.target = 2;
    assert.throws(() => validateContract(invalidTarget, f.queue.config()), /target index is invalid/);
  } finally {
    f.cleanup();
  }
});

test("schema V3 records RED only when every declared case matches", async () => {
  const f = fixture();
  try {
    enqueue(f, "TASK-STRUCTURED-RED-001", { commitPolicy: "autoCommit" });
    const result = await run(f);
    assert.equal(result.item.state, "COMPLETED", result.output);
    const evidence = join(f.root, ".git/automation-runtime/evidence/TASK-STRUCTURED-RED-001");
    const red = JSON.parse(readFileSync(join(evidence, "red.json"), "utf8"));
    const preflight = JSON.parse(readFileSync(join(evidence, "test-preflight.json"), "utf8"));
    assert.equal(red.structuredCasesVerified, true);
    assert.equal(preflight.valid, true);
    assert.deepEqual(preflight.summary, { declared: 1, valid: 1, invalid: 0, expectedRed: 1, undeclared: 0 });
  } finally {
    f.cleanup();
  }
});

test("schema V3 rejects RED when a preserved behavior also fails", async () => {
  const f = fixture({ structuredCaseMode: "preserveFailure" });
  try {
    enqueue(f, "TASK-STRUCTURED-RED-002", { commitPolicy: "autoCommit" });
    const result = await run(f, { allowCrash: true });
    assert.equal(result.item.state, "BLOCKED");
    const evidence = join(f.root, ".git/automation-runtime/evidence/TASK-STRUCTURED-RED-002");
    assert.equal(existsSync(join(evidence, "red.json")), false);
    const preflight = JSON.parse(readFileSync(join(evidence, "test-preflight.json"), "utf8"));
    assert.equal(preflight.valid, false);
    assert.equal(preflight.reasonCode, "CASE_EXPECTATION_MISMATCH");
    assert.equal(preflight.summary.expectedRed, 1);
    assert.equal(preflight.summary.invalid, 1);
    assert.equal(preflight.cases.find(testCase => !testCase.valid).id, "PRESERVED-ENCODING");
    assert.equal(existsSync(join(evidence, "attempts/red-preflight-001/evaluation.json")), true);
  } finally {
    f.cleanup();
  }
});
