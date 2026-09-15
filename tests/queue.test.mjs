import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assertAuthorized, TaskQueue } from "../dist/queue/queue.js";
import { guardExecutorCommand } from "../dist/queue/tools.js";
import { fixture, draft, enqueue, command } from "./queue-fixture.mjs";

test("intake reads a stable commit and never changes an occupied working diff", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "app/src/main/java/Baseline.kt"), "live Coder edits\n");
    const before = command(f.root, ["diff"]);
    const first = enqueue(f, "TASK-A");
    enqueue(f, "TASK-B");
    assert.equal(f.queue.readSnapshot(first.planningHead, "app/src/main/java/Baseline.kt"), "class Baseline");
    assert.equal(command(f.root, ["diff"]), before);
    assert.equal(existsSync(join(f.root, "automation/tasks/TASK-A.json")), false);
    assert.equal(new TaskQueue(f.root).storage.read().items.length, 2);
  } finally { f.cleanup(); }
});

test("planning snapshot stays compact while list pages discover stable committed paths", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "app/src/main/java/WeeklyRoundupUtils.kt"), "class WeeklyRoundupUtils\n");
    writeFileSync(join(f.root, "app/src/test/java/WeeklyRoundupUtilsTest.kt"), "class WeeklyRoundupUtilsTest\n");
    writeFileSync(join(f.root, "local.properties"), "sdk.dir=/private/example\n");
    command(f.root, ["add", "app/src/main/java/WeeklyRoundupUtils.kt", "app/src/test/java/WeeklyRoundupUtilsTest.kt", "local.properties"]);
    command(f.root, ["commit", "-qm", "Add planning paths"]);
    const snapshot = f.queue.snapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ["planningHead", "sourceRoot", "targetBranch"]);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") < 1024);
    const discovered = [];
    let cursor;
    do {
      const page = f.queue.listSnapshot(snapshot.planningHead, "app/src", "weeklyroundup", cursor, 1);
      assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 16 * 1024);
      discovered.push(...page.files);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(discovered, [
      "app/src/main/java/WeeklyRoundupUtils.kt",
      "app/src/test/java/WeeklyRoundupUtilsTest.kt",
    ]);
    assert.deepEqual(f.queue.listSnapshot(snapshot.planningHead, "", "local.properties").files, []);
    const first = f.queue.listSnapshot(snapshot.planningHead, "app/src", "", undefined, 1);
    assert.throws(() => f.queue.listSnapshot(snapshot.planningHead, "app/src/test", "", first.nextCursor ?? undefined, 1), /does not match/);
  } finally { f.cleanup(); }
});

test("snapshot chunks preserve exact UTF-8 content and make bounded forward progress", () => {
  const f = fixture();
  try {
    const path = "app/src/main/java/LargeUnicode.kt";
    const expected = `class LargeUnicode\n${"😀\\\"\u0000".repeat(3000)}\n  `;
    writeFileSync(join(f.root, path), expected);
    command(f.root, ["add", path]);
    command(f.root, ["commit", "-qm", "Add large Unicode source"]);
    const head = f.queue.snapshot().planningHead;
    const chunks = [];
    let cursor;
    do {
      const chunk = f.queue.readSnapshotChunk(head, path, cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(chunk), "utf8") <= 16 * 1024);
      if (cursor) assert.ok(chunk.content.length > 0);
      chunks.push(chunk.content);
      cursor = chunk.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(chunks.join(""), expected);
    const first = f.queue.readSnapshotChunk(head, path);
    assert.throws(() => f.queue.readSnapshotChunk(head, "app/src/main/java/Baseline.kt", first.nextCursor ?? undefined), /does not match/);
  } finally { f.cleanup(); }
});

test("approval seals version and policy, deduplicates, and rejects tampering", () => {
  const f = fixture({ commitPolicy: "autoCommit" });
  try {
    const sealed = draft(f, "TASK-A");
    assert.equal(sealed.commitPolicy, "humanApproval");
    assert.throws(() => f.queue.enqueue(sealed.key, sealed.digest, "automatic"), /Explicit approval/);
    const item = f.queue.enqueue(sealed.key, sealed.digest, f.queue.approvalText(sealed));
    assert.equal(f.queue.enqueue(sealed.key, sealed.digest, f.queue.approvalText(sealed)).sequence, item.sequence);
    assertAuthorized(item);
    assert.throws(() => assertAuthorized({ ...item, commitPolicy: "autoCommit" }), /changed/);
    const next = draft(f, "TASK-A", { commitPolicy: "autoCommit" });
    assert.equal(next.version, 2);
    assert.throws(() => f.queue.enqueue(next.key, next.digest, f.queue.approvalText(next)), /already has/);
    f.queue.control("cancel", item.key);
    assert.equal(f.queue.enqueue(next.key, next.digest, f.queue.approvalText(next)).commitPolicy, "autoCommit");
  } finally { f.cleanup(); }
});

test("one atomic claim respects deadlines, dependencies, priority and pause", () => {
  const f = fixture();
  try {
    enqueue(f, "TASK-LATER", { notBefore: new Date(Date.now() + 60000).toISOString() });
    enqueue(f, "TASK-A");
    enqueue(f, "TASK-C", { dependsOn: ["TASK-A"], priority: 100 });
    enqueue(f, "TASK-B", { priority: 1 });
    f.queue.control("pause");
    assert.equal(f.queue.reserve(), null);
    f.queue.control("resume");
    assert.equal(f.queue.reserve().key, "TASK-B@1");
    assert.equal(new TaskQueue(f.root).reserve(), null);
    assert.match(f.queue.item("TASK-C").waitingReason, /dependency/);
  } finally { f.cleanup(); }
});

test("fixed waiting workspaces and mode changes prevent new claims", () => {
  const f = fixture();
  try {
    enqueue(f, "TASK-A"); enqueue(f, "TASK-B");
    f.queue.storage.transaction(doc => { doc.items[0].taskRoot = f.root; doc.items[0].state = "AWAITING_HUMAN"; });
    assert.equal(f.queue.reserve(), null);
    assert.match(f.queue.item("TASK-B").waitingReason, /TASK-A/);
    const configPath = join(f.root, "automation/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.workspaceStrategy = "isolatedWorktree";
    writeFileSync(configPath, JSON.stringify(config));
    assert.equal(f.queue.reserve(), null);
    assert.match(f.queue.storage.read().fault, /strategy changed/);
  } finally { f.cleanup(); }
});

test("unsupported policy combinations and missing dependency approvals fail", () => {
  const f = fixture();
  try {
    assert.throws(() => draft(f, "TASK-A", { workspaceStrategy: "isolatedWorktree", commitPolicy: "autoCommit" }), /unsupported/);
    assert.throws(() => enqueue(f, "TASK-B", { dependsOn: ["TASK-MISSING"] }), /Approve dependency first/);
    assert.throws(() => f.queue.readSnapshot(f.queue.snapshot().planningHead, "../secret"), /not allowed/);
    assert.throws(() => f.queue.readSnapshot(f.queue.snapshot().planningHead, "local.properties"), /not allowed/);
  } finally { f.cleanup(); }
});

test("unattended commands reject direct and indirect Git mutation paths", () => {
  const f = fixture();
  const previous = process.env.AUTOMATION_QUEUE_RUN_ID;
  process.env.AUTOMATION_QUEUE_RUN_ID = "fixture-run";
  try {
    for (const command of ["git push", "git -c alias.p=push p", "bash -c 'git push'", "npm run sync", "git push --tags", "git status && git push", "./gradlew publish", "./scripts/automation/status.sh TASK-A; git push"]) {
      assert.throws(() => guardExecutorCommand({ tool: "bash" }, { args: { command } }, f.root), /forbidden|outside/);
    }
    for (const command of ["git diff", "./scripts/automation/submit-review.sh TASK-A APPROVED 'Scoped review evidence is complete'", "./gradlew testDebugUnitTest"]) {
      guardExecutorCommand({ tool: "bash" }, { args: { command } }, f.root);
    }
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_QUEUE_RUN_ID;
    else process.env.AUTOMATION_QUEUE_RUN_ID = previous;
    f.cleanup();
  }
});

test("claim-time mode selection preserves sealed commit policy and priority authorization", () => {
  const f = fixture();
  try {
    enqueue(f, "TASK-HUMAN");
    enqueue(f, "TASK-AUTO", { commitPolicy: "autoCommit" });
    f.queue.reorder("TASK-AUTO", 100);
    assertAuthorized(f.queue.item("TASK-AUTO"));
    f.queue.control("pause");
    f.queue.setPolicy("isolatedWorktree", "humanApproval");
    f.queue.control("resume");
    assert.equal(f.queue.reserve().key, "TASK-HUMAN@1");
    assert.equal(f.queue.item("TASK-HUMAN").workspaceStrategy, "isolatedWorktree");
    assertAuthorized(f.queue.item("TASK-HUMAN"));
    assert.match(f.queue.item("TASK-AUTO").waitingReason, /unsupported/);
    assert.equal(f.queue.item("TASK-AUTO").commitPolicy, "autoCommit");
  } finally { f.cleanup(); }
});

test("capacity and public faults block execution but do not reject durable intake", () => {
  const f = fixture({ workspaceStrategy: "isolatedWorktree", queue: { scanIntervalMs: 1000, maxWorkspaces: 1, maxWorkspaceBytes: 1024 ** 3 } });
  try {
    enqueue(f, "TASK-A");
    f.queue.storage.transaction(doc => { doc.items[0].state = "AWAITING_HUMAN"; doc.items[0].taskRoot = f.queue.storage.root; });
    enqueue(f, "TASK-B");
    assert.equal(f.queue.reserve(), null);
    assert.match(f.queue.item("TASK-B").waitingReason, /capacity/);
    f.queue.storage.transaction(doc => { doc.fault = "Provider authentication failed"; });
    enqueue(f, "TASK-C");
    assert.equal(f.queue.reserve(), null);
    assert.equal(f.queue.storage.read().items.length, 3);
    f.queue.control("resume");
    assert.match(f.queue.storage.read().fault, /authentication/);
  } finally { f.cleanup(); }
});

test("revocation blocks automatic execution and durable notification acknowledgements survive reload", () => {
  const f = fixture();
  try {
    enqueue(f, "TASK-A", { commitPolicy: "autoCommit" });
    f.queue.control("revoke", "TASK-A");
    assert.equal(f.queue.reserve(), null);
    assert.match(f.queue.item("TASK-A").waitingReason, /revoked/);
    const notification = f.queue.storage.read().notifications.at(-1);
    f.queue.control("acknowledge", notification.id);
    assert.equal(new TaskQueue(f.root).storage.read().notifications.at(-1).acknowledged, true);
  } finally { f.cleanup(); }
});
