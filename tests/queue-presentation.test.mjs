import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ApprovalLedger } from "../dist/queue/approvals.js";
import { createQueueTools } from "../dist/queue/tools.js";
import { fixture, enqueue, run, command } from "./queue-fixture.mjs";

const maxBytes = 16 * 1024;
const names = ["baseline-inventory", "test-preflight", "test-manifest", "green-inventory", "inventory-status"];
function setupEvidence(f, id) {
  const directory = join(f.queue.storage.runtime, "evidence", id);
  mkdirSync(directory, { recursive: true });
  const value = { valid: true, reasonCode: "VALID_INVENTORY", summary: { total: 7, skipped: 0 },
    inputs: Array.from({ length: 1400 }, (_, index) => ({ path: `src/test/国家😀-${index}.kt`, sha256: "a".repeat(64), detail: "证据\\\"\n".repeat(15) })) };
  for (const name of names) writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
  return { directory, value };
}
function context(f, sessionID = "presentation-session") {
  return { worktree: f.root, directory: f.root, agent: "scheduled-planner", sessionID,
    messageID: "presentation-message", abort: new AbortController().signal };
}
function select(ledger, ctx, question, callID = "actual-choice") {
  const input = { tool: "question", sessionID: ctx.sessionID, callID };
  ledger.before(input, { args: question });
  ledger.after(input, { metadata: { answers: [[question.questions[0].options[0].label]] } });
}

test("large inventories cannot truncate task status or any registered review question", async () => {
  const f = fixture();
  try {
    const item = enqueue(f, "TASK-LARGE");
    setupEvidence(f, item.taskId);
    assert(Buffer.byteLength(JSON.stringify(f.queue.details(item.key))) > 1_284_790);
    const ledger = new ApprovalLedger(), ctx = context(f);
    const tool = createQueueTools(f.root, ledger).android_orchestrator_queue;
    const before = readFileSync(f.queue.storage.path);
    for (const operation of [undefined, "abort", "resume-task", "resume-review", "integrate"]) {
      const raw = await tool.execute({ action: operation ? "review" : "status", key: item.key, operation }, ctx);
      assert(Buffer.byteLength(raw) <= maxBytes, `Oversized ${operation ?? "status"}: ${Buffer.byteLength(raw)}`);
      const result = JSON.parse(raw);
      assert.equal(result.key, item.key);
      assert.equal(result.evidence["test-manifest"].summary.valid, true);
      assert(result.evidence["test-manifest"].bytes > 200_000);
      assert.match(result.evidence["test-manifest"].sha256, /^[a-f0-9]{64}$/);
      assert.equal(result.contractText, undefined);
      if (operation) {
        assert.equal(result.question.questions.length, 1);
        await tool.execute({ action: "readEvidence", key: item.key, name: "plan",
          evidenceSha256: result.evidence.plan.sha256 }, ctx);
        select(ledger, ctx, result.question);
        const binding = `${item.key}:${item.digest}:${item.candidateId}:${operation}`;
        assert.equal(ledger.consume(ctx, operation, binding).kind, operation);
        assert.throws(() => ledger.consume(ctx, operation, binding), /fresh, matching/);
      }
    }
    assert.deepEqual(readFileSync(f.queue.storage.path), before);
  } finally { f.cleanup(); }
});

test("evidence chunks preserve exact Unicode JSON and reject stale or cross-resource cursors", async () => {
  const f = fixture();
  try {
    const item = enqueue(f, "TASK-CHUNKS"), other = enqueue(f, "TASK-OTHER");
    const { directory, value } = setupEvidence(f, item.taskId);
    setupEvidence(f, other.taskId);
    const tool = createQueueTools(f.root).android_orchestrator_queue, ctx = context(f);
    const summary = JSON.parse(await tool.execute({ action: "status", key: item.key }, ctx));
    const evidenceSha256 = summary.evidence["test-manifest"].sha256;
    const args = { action: "readEvidence", key: item.key, name: "test-manifest", evidenceSha256 };
    let cursor, chunks = [], first;
    do {
      const raw = await tool.execute({ ...args, cursor }, ctx);
      assert(Buffer.byteLength(raw) <= maxBytes);
      const page = JSON.parse(raw);
      first ??= page;
      assert(page.content.length > 0);
      assert(!page.content.includes("�"));
      chunks.push(page.content);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(chunks.join(""), JSON.stringify(value));
    await assert.rejects(tool.execute({ ...args, key: other.key, cursor: first.nextCursor }, ctx), /cursor.*match/i);
    await assert.rejects(tool.execute({ ...args, name: "green-inventory", cursor: first.nextCursor }, ctx), /cursor.*match/i);
    await assert.rejects(tool.execute({ ...args, name: "../../config", cursor: undefined }, ctx), /Unknown evidence/);
    await assert.rejects(tool.execute({ ...args, cursor: "not-json" }, ctx), /cursor/i);
    await assert.rejects(tool.execute({ ...args, evidenceSha256: undefined }, ctx), /digest/i);
    const invalidOffset = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
    invalidOffset.offset = Buffer.from(JSON.stringify(value)).indexOf(Buffer.from("国")) + 1;
    await assert.rejects(tool.execute({ ...args, cursor: Buffer.from(JSON.stringify(invalidOffset)).toString("base64url") }, ctx), /cursor offset/i);
    await assert.rejects(tool.execute(args, { ...ctx, agent: "scheduled-coder" }), /Only the interactive Planner/);
    await assert.rejects(tool.execute(args, { ...ctx, worktree: f.base }), /workspace mismatch/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(tool.execute(args, { ...ctx, abort: aborted.signal }), /aborted call/);
    command(f.root, ["commit", "--allow-empty", "-qm", "Advance target"]);
    await assert.rejects(tool.execute({ ...args, cursor: first.nextCursor }, ctx), /cursor.*match/i);
    const refreshed = JSON.parse(await tool.execute(args, ctx));
    f.queue.storage.transaction(doc => { doc.items.find(x => x.key === item.key).candidateId = "changed-candidate"; });
    await assert.rejects(tool.execute({ ...args, cursor: refreshed.nextCursor }, ctx), /cursor.*match/i);
    writeFileSync(join(directory, "test-manifest.json"), JSON.stringify({ ...value, valid: false }));
    await assert.rejects(tool.execute(args, ctx), /digest.*changed/i);
  } finally { f.cleanup(); }
});

test("large summary messages remain bounded and omitted previews retain exact evidence access", async () => {
  const f = fixture();
  try {
    const item = enqueue(f, "TASK-SUMMARY");
    const { directory } = setupEvidence(f, item.taskId);
    const value = Object.fromEntries(["summary", "evidence", "bindingChecks", "lastFailure"].map(name =>
      [name, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`字段${i}`, "😀\u0000".repeat(5000)]))]));
    for (const name of names) writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
    f.queue.storage.transaction(doc => { doc.items[0].waitingReason = "失败😀".repeat(10000); });
    const tool = createQueueTools(f.root).android_orchestrator_queue, ctx = context(f);
    const raw = await tool.execute({ action: "review", operation: "abort", key: item.key }, ctx);
    assert(Buffer.byteLength(raw) <= maxBytes);
    const review = JSON.parse(raw);
    assert.equal(review.waitingReasonTruncated, true);
    assert.equal(review.summariesOmitted, true);
    assert.equal(review.question.questions[0].header, "中止确认");
    assert.match(review.evidence["test-manifest"].sha256, /^[a-f0-9]{64}$/);
    for (const name of ["contract", "plan"]) {
      const page = JSON.parse(await tool.execute({ action: "readEvidence", key: item.key, name,
        evidenceSha256: review.evidence[name].sha256 }, ctx));
      const expected = name === "plan" ? item.plan : JSON.stringify(item.contract);
      assert.equal(page.content, expected);
      assert.equal(page.nextCursor, null);
    }
  } finally { f.cleanup(); }
});

test("altered questions, other sessions and changed candidates cannot authorize a large-evidence abort", async () => {
  const f = fixture();
  try {
    const item = enqueue(f, "TASK-RECEIPT");
    setupEvidence(f, item.taskId);
    const ledger = new ApprovalLedger(), tool = createQueueTools(f.root, ledger).android_orchestrator_queue, ctx = context(f);
    const args = { action: "review", operation: "abort", key: item.key };
    const binding = `${item.key}:${item.digest}:${item.candidateId}:abort`;
    const wrong = JSON.parse(await tool.execute(args, ctx)).question;
    wrong.questions[0].question += "different candidate";
    select(ledger, ctx, wrong);
    assert.throws(() => ledger.consume(ctx, "abort", binding), /fresh, matching/);
    const review = JSON.parse(await tool.execute(args, ctx));
    select(ledger, context(f, "other-session"), review.question);
    assert.throws(() => ledger.consume(ctx, "abort", binding), /fresh, matching/);
    select(ledger, ctx, review.question);
    assert.throws(() => ledger.consume(ctx, "abort", `${item.key}:${item.digest}:changed:abort`), /fresh, matching/);
    assert.equal(ledger.consume(ctx, "abort", binding).kind, "abort");
  } finally { f.cleanup(); }
});

test("a stopped real queue worker can archive after approval despite oversized inventories", { timeout: 180000 }, async () => {
  const f = fixture({ inventoryMode: true, inventoryFailure: "missing-green" });
  try {
    const item = enqueue(f, "TASK-ABORT-LARGE");
    const stopped = await run(f);
    assert(["TEST_FAILED", "BLOCKED"].includes(stopped.item.state), stopped.output);
    setupEvidence(f, item.taskId);
    const ledger = new ApprovalLedger(), ctx = context(f);
    const raw = await createQueueTools(f.root, ledger).android_orchestrator_queue.execute({ action: "review", operation: "abort", key: item.key }, ctx);
    assert(Buffer.byteLength(raw) <= maxBytes);
    const review = JSON.parse(raw);
    select(ledger, ctx, review.question);
    const current = f.queue.item(item.key);
    const proof = ledger.consume(ctx, "abort", `${current.key}:${current.digest}:${current.candidateId}:abort`);
    f.queue.request(item.key, "abort", f.config.approvalPhrases.abort, undefined, proof);
    const archived = await run(f);
    assert.equal(archived.item.state, "ABORTED", archived.output);
    assert.equal(f.queue.storage.read().active, null);
  } finally { f.cleanup(); }
});
