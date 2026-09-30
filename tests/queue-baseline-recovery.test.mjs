import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { TaskQueue } from "../dist/queue/queue.js";
import { fixture, taskContract, run, command } from "./queue-fixture.mjs";
const policy = { version: 1, scope: "baseline", maxEnvironmentRetries: 2, maxManualRetries: 1,
  maxElapsedMs: 900000, initialDelayMs: 1000, maxDelayMs: 60000, maxSameFailureRetries: 2 };
function enqueueV5(f, recovery = policy, commitPolicy = "autoCommit") {
  const contract = { ...taskContract(f, "TASK-RECOVERY"), schemaVersion: 5, recovery };
  const draft = f.queue.draft({ contract, plan: "# Approved baseline recovery and scoped implementation\n", ...f.queue.snapshot(), commitPolicy });
  f.queue.enqueue(draft.key, draft.digest, f.queue.approvalText(draft));
}
const read = file => JSON.parse(readFileSync(file, "utf8"));
async function untilDue(item) {
  const delay = item.baselineRecovery.nextRunAt - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay + 10));
}

for (const stage of ["full", "discovery", "collection"]) {
  test(`V5 resumes ${stage} failure with retained checkpoints, no model retry and persistent budgets`, { timeout: 180000 }, async () => {
    const f = fixture({ inventoryMode: true, baselineFault: { stage, failures: 1, message: "Received status code 429 from server: Too Many Requests" } });
    try {
      if (stage === "full") {
        writeFileSync(join(f.root, ".automation-worktree-allowlist"), "operator-note.txt\n");
        writeFileSync(join(f.root, "operator-note.txt"), "Human-owned note before capture\n");
      }
      enqueueV5(f);
      const failed = await run(f);
      assert.equal(failed.item.state, "BLOCKED", failed.output);
      assert.equal(failed.item.baselineRecovery?.failure.category, "environment", failed.output);
      const evidence = join(f.queue.storage.runtime, "evidence/TASK-RECOVERY");
      assert.equal(existsSync(join(evidence, "baseline.json")), false);
      assert.equal(existsSync(join(f.base, "agent-calls.jsonl")), false);
      const checkpoint = stage === "full" ? null : readFileSync(join(evidence, "baseline-full.json"), "utf8");
      const first = read(join(evidence, "baseline-recovery.json"));
      if (stage === "full") writeFileSync(join(f.root, "operator-note.txt"), "Human-owned note during backoff\n");
      // Reload durable queue state as a restarted service would.
      f.queue = new TaskQueue(f.root);
      await untilDue(failed.item);
      const recovered = await run(f);
      assert.equal(recovered.item.state, "COMPLETED", recovered.output + recovered.item.waitingReason);
      const final = read(join(evidence, "baseline-recovery.json"));
      assert.equal(final.state, "COMPLETE");
      assert.equal(final.attempts.filter(attempt => attempt.mode === "auto").length, 1);
      assert.deepEqual(final.attempts.slice(0, first.attempts.length), first.attempts);
      if (checkpoint) assert.equal(readFileSync(join(evidence, "baseline-full.json"), "utf8"), checkpoint);
      if (stage === "collection") {
        const calls = readFileSync(join(f.base, "gradle-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(calls.filter(call => call.args.includes("--dry-run")).length, 1, "successful discovery must be reused");
      }
      assert.equal(readFileSync(join(evidence, "baseline.json"), "utf8"), readFileSync(join(evidence, "baseline-full.json"), "utf8"));
      assert.equal(read(join(evidence, "test-manifest.json")).attempt, 1, "environment retry must not spend RED preparation budget");
      assert.equal(read(join(evidence, "gate-attempts-cycle-0.json")).attempts, 1);
      const agents = readFileSync(join(f.base, "agent-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(agents.length, 2);
      assert.equal(f.queue.storage.read().fault, null);
    } finally { f.cleanup(); }
  });
}

test("environment retries stop at the approved persisted budget without resetting on service restart", { timeout: 90000 }, async () => {
  const f = fixture({ inventoryMode: true, baselineFault: { stage: "full", failures: 10, message: "java.net.SocketTimeoutException" } });
  try {
    enqueueV5(f, { ...policy, maxEnvironmentRetries: 1, maxManualRetries: 0 });
    const first = await run(f); await untilDue(first.item);
    f.queue = new TaskQueue(f.root);
    const second = await run(f);
    assert.equal(second.item.state, "BLOCKED", second.output);
    assert.equal(second.item.baselineRecovery.nextRunAt, null);
    assert.match(second.item.waitingReason, /retry budget exhausted/);
    f.queue = new TaskQueue(f.root);
    assert.equal(f.queue.reserve(), null);
    const record = read(join(f.queue.storage.runtime, "evidence/TASK-RECOVERY/baseline-recovery.json"));
    assert.equal(record.attempts.length, 2);
    assert.equal(existsSync(join(f.base, "agent-calls.jsonl")), false);
  } finally { f.cleanup(); }
});

test("unknown baseline failure requires explicit approval and uses only the manual recovery budget", { timeout: 180000 }, async () => {
  const f = fixture({ inventoryMode: true, baselineFault: { stage: "full", failures: 1, message: "unclassified Gradle error" } });
  try {
    enqueueV5(f);
    const first = await run(f);
    assert.equal(first.item.baselineRecovery.failure.category, "unknown");
    assert.equal(f.queue.reserve(), null);
    assert.throws(() => f.queue.request("TASK-RECOVERY", "resume", "not approval"), /Explicit resume approval/);
    assert.throws(() => f.queue.request("TASK-RECOVERY", "retry-baseline"), /reserved/);
    f.queue.request("TASK-RECOVERY", "resume", f.config.approvalPhrases.resume);
    const result = await run(f);
    assert.equal(result.item.state, "COMPLETED", result.output);
    const record = read(join(f.queue.storage.runtime, "evidence/TASK-RECOVERY/baseline-recovery.json"));
    assert.equal(record.attempts.filter(attempt => attempt.mode === "manual").length, 1);
    assert.equal(record.attempts.filter(attempt => attempt.mode === "auto").length, 0);
  } finally { f.cleanup(); }
});

for (const tamper of ["baseline-full.json", "baseline-discovery.json", "baseline-recovery.json", "attempt", "checkpoint-symlink", "product", "config", "toolchain", "target-head"]) {
  test(`recovery rejects ${tamper} changes and consumes the scheduled wake`, { timeout: 90000 }, async () => {
    const f = fixture({ inventoryMode: true, baselineFault: { stage: "collection", failures: 1, message: "java.net.ConnectException" } });
    try {
      enqueueV5(f);
      const first = await run(f);
      const evidence = join(f.queue.storage.runtime, "evidence/TASK-RECOVERY");
      const target = tamper === "product" ? join(first.item.taskRoot, "app/src/main/java/Baseline.kt")
        : tamper === "config" ? join(first.item.taskRoot, "automation/config.json") : join(evidence, tamper);
      if (tamper === "toolchain") f.env.JAVA_TOOL_OPTIONS = "-Drecovery.changed=true";
      else if (tamper === "target-head") {
        const next = command(f.root, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "Independent branch advance"]);
        command(f.root, ["update-ref", `refs/heads/${first.item.targetBranch}`, next]);
      } else if (tamper === "attempt") {
        const retained = read(join(evidence, "baseline-recovery.json")).attempts[0].files[0][0];
        writeFileSync(join(evidence, retained), "changed attempt\n");
      } else if (tamper === "checkpoint-symlink") {
        const checkpoint = join(evidence, "baseline-full.json"), moved = join(f.base, "unchanged-checkpoint.json");
        renameSync(checkpoint, moved); symlinkSync(moved, checkpoint);
      }
      else writeFileSync(target, readFileSync(target, "utf8") + "\n");
      await untilDue(first.item);
      const rejected = await run(f);
      assert.equal(rejected.item.state, "BLOCKED", rejected.output);
      assert.equal(rejected.item.baselineRecovery.nextRunAt, null);
      assert.equal(f.queue.reserve(), null, "input rejection must not create an automatic retry loop");
      assert.equal(existsSync(join(evidence, "baseline.json")), false);
      assert.equal(existsSync(join(f.base, "agent-calls.jsonl")), false);
    } finally { f.cleanup(); }
  });
}

test("historical focused failures cannot be retried automatically or by manual resume", { timeout: 90000 }, async () => {
  const f = fixture({ inventoryMode: true, inventoryFailure: "baseline" });
  try {
    enqueueV5(f);
    const first = await run(f);
    assert.equal(first.item.baselineRecovery.failure.category, "baselineFailure");
    assert.equal(first.item.baselineRecovery.nextRunAt, null);
    const ledger = join(f.queue.storage.runtime, "evidence/TASK-RECOVERY/baseline-recovery.json");
    const retained = readFileSync(ledger, "utf8");
    f.queue.request("TASK-RECOVERY", "resume", f.config.approvalPhrases.resume);
    const second = await run(f);
    assert.equal(second.item.state, "BLOCKED");
    assert.match(second.item.waitingReason, /correction or a revised contract/);
    assert.equal(readFileSync(ledger, "utf8"), retained);
    assert.equal(existsSync(join(f.base, "agent-calls.jsonl")), false);
  } finally { f.cleanup(); }
});

test("isolated recovery reuses its retained workspace at capacity and preserves human acceptance", { timeout: 180000 }, async () => {
  const f = fixture({ inventoryMode: true, workspaceStrategy: "isolatedWorktree",
    baselineFault: { stage: "collection", failures: 1, message: "HTTP 429" } });
  try {
    f.config.queue.maxWorkspaces = 1;
    writeFileSync(join(f.root, "automation/config.json"), JSON.stringify(f.config, null, 2) + "\n");
    command(f.root, ["add", "automation/config.json"]); command(f.root, ["commit", "-qm", "Limit retained workspace capacity"]);
    enqueueV5(f, policy, "humanApproval");
    const first = await run(f);
    await untilDue(first.item);
    const second = await run(f);
    assert.equal(second.item.state, "AWAITING_HUMAN", second.output + second.item.waitingReason);
    assert.equal(first.item.taskRoot, second.item.taskRoot);
    assert.equal(second.item.completedCommit, null);
    assert.equal(f.queue.storage.read().fault, null);
  } finally { f.cleanup(); }
});

test("pause, revocation and elapsed deadline prevent an otherwise due baseline retry", { timeout: 90000 }, async () => {
  const f = fixture({ inventoryMode: true, baselineFault: { stage: "full", failures: 1, message: "HTTP 429" } });
  try {
    enqueueV5(f);
    const first = await run(f); await untilDue(first.item);
    f.queue.control("pause");
    assert.equal(f.queue.reserve(), null);
    f.queue.control("resume");
    f.queue.control("revoke", first.item.key);
    assert.equal(f.queue.reserve(), null);
    const originalNow = Date.now;
    try {
      Date.now = () => first.item.baselineRecovery.deadline + 1;
      assert.equal(f.queue.reserve(), null);
    } finally { Date.now = originalNow; }
    const item = f.queue.item(first.item.key);
    assert.equal(item.baselineRecovery.nextRunAt, null);
    assert.match(item.waitingReason, /elapsed-time budget exhausted/);
    assert.equal(existsSync(join(f.base, "agent-calls.jsonl")), false);
  } finally { f.cleanup(); }
});

for (const message of ["There were failing tests", "unexpected tool error"]) {
  test(`V5 does not automatically retry ${message}`, { timeout: 90000 }, async () => {
    const f = fixture({ inventoryMode: true, baselineFault: { stage: "full", failures: 1, message } });
    try {
      enqueueV5(f);
      const result = await run(f);
      assert.equal(result.item.state, "BLOCKED", result.output);
      assert.equal(result.item.baselineRecovery.nextRunAt, null);
      assert.equal(f.queue.reserve(), null);
      assert.equal(existsSync(join(f.base, "agent-calls.jsonl")), false);
    } finally { f.cleanup(); }
  });
}
