import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, enqueue, run } from "./queue-fixture.mjs";

const rows = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);

for (const cycles of [0, 1, 2]) {
  for (const exhausted of [false, true]) {
    test(`real queue executes ${cycles} review corrections, exhausted=${exhausted}`, { timeout: 180000 }, async () => {
      const f = fixture({ maxReviewCycles: cycles, reviewChanges: cycles + Number(exhausted) });
      try {
        enqueue(f, "TASK-REVIEW");
        const result = await run(f);
        assert.equal(result.item.state, exhausted ? "NEEDS_HUMAN" : "AWAITING_HUMAN", result.output);
        assert.doesNotMatch(result.output, /exceeded the deterministic orchestration step bound/);
        const calls = rows(join(f.base, "agent-calls.jsonl"));
        assert.equal(calls.filter(call => call.role === "scheduled-coder").length, cycles + 1);
        assert.equal(calls.filter(call => call.role === "scheduled-reviewer").length, cycles + 1);
        assert.equal(f.queue.storage.read().fault, null);
      } finally { f.cleanup(); }
    });
  }
}

for (const tamper of [false, true]) {
  test(`approved queue reviewer recovery preserves sealed candidate, tamper=${tamper}`, { timeout: 180000 }, async () => {
    const f = fixture({ interruptReviewer: true });
    try {
      enqueue(f, "TASK-REVIEW");
      const first = await run(f);
      assert.equal(first.item.state, "BLOCKED", first.output);
      assert.equal(f.queue.storage.read().fault, null);
      assert.throws(() => f.queue.request("TASK-REVIEW", "resume-review", "wrong approval"), /Explicit resume-review approval/);
      if (tamper) writeFileSync(join(first.item.taskRoot, "app/src/main/java/TASK-REVIEW.kt"), "class ChangedCandidate\n");
      f.queue.request("TASK-REVIEW", "resume-review", f.config.approvalPhrases.resume);
      const resumed = await run(f);
      assert.equal(resumed.item.state, tamper ? "BLOCKED" : "AWAITING_HUMAN", resumed.output);
      const calls = rows(join(f.base, "agent-calls.jsonl"));
      assert.equal(calls.filter(call => call.role === "scheduled-coder").length, 1);
      assert.equal(calls.filter(call => call.role === "scheduled-reviewer").length, tamper ? 1 : 2);
      if (tamper) assert.match(resumed.output, /sealed diff changed/);
      else {
        assert.equal(resumed.item.sealedDiff, first.item.sealedDiff);
        const recovery = rows(join(f.queue.storage.runtime, "evidence/TASK-REVIEW/review-resumptions.jsonl"));
        assert.equal(recovery[0].coderRerun, false);
      }
    } finally { f.cleanup(); }
  });
}
