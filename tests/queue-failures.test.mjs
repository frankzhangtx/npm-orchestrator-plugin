import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, enqueue, command, run } from "./queue-fixture.mjs";
import { assertQueueIdle } from "../dist/queue/lifecycle.js";

test("cached-only full tests cannot authorize an automatic commit or release the fixed workspace", { timeout: 60000 }, async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'gradlew'), '#!/bin/sh\necho "ORCHESTRATOR_TEST_EXPECTED|:app:testDebugUnitTest"\necho "FROM-CACHE"\necho "BUILD SUCCESSFUL"\n');
    command(f.root, ['add', 'gradlew']); command(f.root, ['commit', '-qm', 'Cached-only fixture']);
    const baseline = command(f.root, ['rev-parse', 'main']);
    enqueue(f, 'TASK-A', { commitPolicy: 'autoCommit' });
    enqueue(f, 'TASK-B');
    const failed = await run(f);
    assert.equal(failed.item.state, 'BLOCKED', failed.output);
    assert.match(failed.output, /no fresh successful test results/);
    assert.equal(command(f.root, ['rev-parse', 'main']), baseline);
    assert.equal(f.queue.reserve(), null);
    assert.throws(() => assertQueueIdle(f.root), /Retained task workspaces/);
    assert.equal(existsSync(join(f.queue.storage.runtime, 'evidence/TASK-A/commit-transaction.json')), false);
  } finally { f.cleanup(); }
});

test("failed OpenCode processes retain the fixed workspace without inventing a shared fault", { timeout: 60000 }, async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bin, 'opencode'), '#!/bin/sh\necho "AuthenticationError: provider rejected credentials" >&2\nexit 7\n');
    enqueue(f, 'TASK-A');
    const failed = await run(f);
    assert.equal(failed.item.state, 'BLOCKED', failed.output);
    assert.equal(f.queue.storage.read().fault, null);
    assert.match(failed.item.waitingReason, /exited with 7/);
    enqueue(f, 'TASK-B');
    assert.equal(f.queue.reserve(), null);
    assert.equal(existsSync(failed.item.taskRoot), true);
  } finally { f.cleanup(); }
});

test("isolated agent failure preserves A, allows B integration, and keeps C waiting for A", { timeout: 180000 }, async () => {
  const f = fixture({ workspaceStrategy: "isolatedWorktree" });
  try {
    const agent = readFileSync(join(f.bin, "opencode"), "utf8");
    writeFileSync(join(f.bin, "opencode"), '#!/bin/sh\necho "unclassified agent error" >&2\nexit 7\n');
    const baseline = command(f.root, ["rev-parse", "main"]);
    enqueue(f, "TASK-A"); enqueue(f, "TASK-B"); enqueue(f, "TASK-C", { dependsOn: ["TASK-A"] });
    const failed = await run(f);
    assert.equal(failed.item.state, "BLOCKED", failed.output);
    assert.equal(f.queue.storage.read().fault, null);
    assert.equal(existsSync(join(f.queue.storage.runtime, "evidence/TASK-A/queue-seal.json")), true);
    writeFileSync(join(f.bin, "opencode"), agent);
    const b = await run(f);
    assert.equal(b.item.taskId, "TASK-B");
    assert.equal(b.item.state, "AWAITING_HUMAN", b.output);
    f.queue.request("TASK-B", "integrate", f.config.approvalPhrases.acceptance, b.item.candidateId);
    const completed = await run(f);
    assert.equal(completed.item.state, "COMPLETED", completed.output);
    assert.equal(command(f.root, ["rev-list", "--count", `${baseline}..main`]), "1");
    assert.equal(f.queue.reserve(), null);
    assert.match(f.queue.item("TASK-C").waitingReason, /dependency TASK-A/);
    assert.equal(f.queue.item("TASK-A").state, "BLOCKED");
    assert.equal(existsSync(failed.item.taskRoot), true);
  } finally { f.cleanup(); }
});
