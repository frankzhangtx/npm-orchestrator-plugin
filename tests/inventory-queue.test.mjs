import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { command, enqueue, fixture, run } from "./queue-fixture.mjs";

test("V4 queue preserves baseline inventory through RED, GREEN, independent review and acceptance", async () => {
  const f = fixture({ inventoryMode: true });
  try {
    const id = "TASK-INVENTORY-QUEUE";
    enqueue(f, id, { commitPolicy: "autoCommit" });
    const result = await run(f);
    assert.equal(result.item.state, "COMPLETED", result.output);
    const evidence = join(f.root, ".git/automation-runtime/evidence", id);
    const read = name => JSON.parse(readFileSync(join(evidence, `${name}.json`), "utf8"));
    assert.equal(read("baseline-inventory").summary.existing, 1);
    assert.equal(read("red").processExitCode, 0);
    assert.equal(read("red").expectedFailureCount, 1);
    assert.equal(read("red").exitCodeMeaning, "approved-case-failure");
    assert.equal(read("test-manifest").summary.total, 2);
    assert.equal(read("green-inventory").summary.total, 2);
    const report = read("acceptance-report").evidence.inventoryVerification;
    assert.equal(report.valid, true);
    assert.equal(report.baseline.existing, 1);
    assert.equal(report.red.expectedFailureCount, 1);
    assert.equal(report.cases.filter(item => item.classification === "regression").length, 1);
    assert.equal(f.queue.details(result.item.key).evidence["test-manifest"].summary.total, 2);
  } finally { f.cleanup(); }
});

for (const incomingTest of [false, true]) {
  test(`V4 isolated revalidation ${incomingTest ? "rejects changed frozen tests" : "rechecks an advanced production baseline"}`, { timeout: 120000 }, async () => {
    const f = fixture({ inventoryMode: true, workspaceStrategy: "isolatedWorktree" });
    try {
      const id = "TASK-INVENTORY-ISOLATED";
      enqueue(f, id);
      const candidate = await run(f);
      assert.equal(candidate.item.state, "AWAITING_HUMAN", candidate.output);
      const added = incomingTest ? "app/src/test/java/IncomingTest.kt" : "app/src/main/java/Unrelated.kt";
      writeFileSync(join(f.root, added), "class IndependentIncomingChange\n");
      command(f.root, ["add", added]); command(f.root, ["commit", "-qm", "Independent baseline advance"]);
      f.queue.request(id, "revalidate");
      const revised = await run(f, { allowCrash: incomingTest });
      if (incomingTest) {
        assert.equal(revised.item.state, "BLOCKED", revised.output);
        assert.equal(f.queue.details(revised.item.key).evidence["inventory-status"].reasonCode, "EVIDENCE_CHANGED");
      } else {
        assert.equal(revised.item.state, "AWAITING_HUMAN", revised.output + revised.item.waitingReason);
        assert.notEqual(candidate.item.candidateId, revised.item.candidateId);
        f.queue.request(id, "integrate", f.config.approvalPhrases.acceptance, revised.item.candidateId);
        const completed = await run(f);
        assert.equal(completed.item.state, "COMPLETED", completed.output + completed.item.waitingReason);
      }
    } finally { f.cleanup(); }
  });
}

for (const statusMode of ["old-run", "legacy-without-run", "corrupt"]) {
  test(`V4 interrupted baseline gives an actionable new-task route; ${statusMode} status cannot mask a resume refusal`, async () => {
    const f = fixture({ inventoryMode: true, inventoryFailure: "interrupted-baseline" });
    try {
      const id = "TASK-INVENTORY-RECOVERY";
      enqueue(f, id);
      const blocked = await run(f, { allowCrash: true });
      assert.equal(blocked.item.state, "BLOCKED", blocked.output);
      const evidence = join(f.root, ".git/automation-runtime/evidence", id);
      const statusPath = join(evidence, "inventory-status.json");
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      assert.equal(status.reasonCode, "INCOMPLETE_COLLECTION");
      assert(status.queueRunId);
      assert.match(status.nextAction, /approved abort\/archive/);
      assert.match(status.nextAction, /approve a new task/);
      assert.doesNotMatch(status.nextAction, /retry within/);
      const baseline = readFileSync(join(evidence, "baseline.json"), "utf8");
      if (statusMode === "legacy-without-run") {
        delete status.queueRunId;
        writeFileSync(statusPath, JSON.stringify(status));
      } else if (statusMode === "corrupt") writeFileSync(statusPath, "{broken");
      const retained = readFileSync(statusPath, "utf8");
      f.queue.control("clear-fault");
      f.queue.request(id, "resume", f.config.approvalPhrases.resume);
      const resumed = await run(f, { allowCrash: true });
      assert.equal(resumed.item.state, "BLOCKED");
      assert.match(resumed.item.waitingReason, /V4 baseline.json already exists/);
      assert.match(resumed.item.waitingReason, /approve a new task/);
      assert.doesNotMatch(resumed.item.waitingReason, /baseline: INCOMPLETE_COLLECTION/);
      assert.equal(readFileSync(join(evidence, "baseline.json"), "utf8"), baseline);
      assert.equal(readFileSync(statusPath, "utf8"), retained);
      assert.equal(existsSync(join(evidence, "baseline-inventory.json")), false);
      assert.equal(existsSync(join(evidence, "red.json")), false);
    } finally { f.cleanup(); }
  });
}

for (const [mode, reason, phase] of [["baseline", "BASELINE_NOT_GREEN", "baseline"],
  ["regression", "CASE_EXPECTATION_MISMATCH", "red"], ["interrupted", "INCOMPLETE_COLLECTION", "red"],
  ["missing-green", "COVERAGE_MISMATCH", "green"]]) {
  test(`V4 queue reports ${reason} with recovery guidance (${mode})`, async () => {
    const f = fixture({ inventoryMode: true, inventoryFailure: mode });
    try {
      const id = "TASK-INVENTORY-BLOCK";
      enqueue(f, id, { commitPolicy: "autoCommit" });
      const result = await run(f, { allowCrash: true });
      assert.notEqual(result.item.state, "COMPLETED");
      const detail = f.queue.details(result.item.key);
      const status = detail.evidence["inventory-status"];
      assert.equal(status.valid, false);
      assert.equal(status.reasonCode, reason);
      assert.equal(status.phase, phase);
      assert(status.nextAction.length > 10);
      assert.match(result.item.waitingReason, new RegExp(reason));
      const evidence = join(f.root, ".git/automation-runtime/evidence", id);
      assert.equal(existsSync(join(evidence, "red.json")), phase === "green");
      if (phase !== "green") assert.equal(existsSync(join(f.root, `app/src/main/java/${id}.kt`)), false);
      if (phase === "baseline") assert.equal(existsSync(join(f.root, `app/src/test/java/${id}Test.kt`)), false);
    } finally { f.cleanup(); }
  });
}
