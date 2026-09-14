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

test("failed OpenCode processes pause the repository while preserving workspace and accepting new contracts", { timeout: 60000 }, async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bin, 'opencode'), '#!/bin/sh\necho "AuthenticationError: provider rejected credentials" >&2\nexit 7\n');
    enqueue(f, 'TASK-A');
    const failed = await run(f);
    assert.equal(failed.item.state, 'BLOCKED', failed.output);
    assert.match(f.queue.storage.read().fault, /exited with 7/);
    enqueue(f, 'TASK-B');
    assert.equal(f.queue.reserve(), null);
    assert.equal(existsSync(failed.item.taskRoot), true);
  } finally { f.cleanup(); }
});
