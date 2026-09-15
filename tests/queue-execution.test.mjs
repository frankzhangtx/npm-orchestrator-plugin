import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releaseStoppedLeases } from "../dist/queue/service.js";
import { processIdentity } from "../dist/queue/storage.js";
import { fixture, enqueue, command, run } from "./queue-fixture.mjs";

test("human fixed mode waits before commit, integrates only the accepted candidate, then releases the slot", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const baseline = command(f.root, ["rev-parse", "main"]);
    enqueue(f, "TASK-A"); enqueue(f, "TASK-B");
    const first = await run(f);
    assert.equal(first.item.state, "AWAITING_HUMAN", first.output + JSON.stringify(first.item));
    assert.equal(command(f.root, ["rev-parse", "main"]), baseline);
    assert.equal(command(f.root, ["rev-parse", "HEAD"]), baseline);
    assert.equal(f.queue.reserve(), null);
    assert.throws(() => f.queue.request("TASK-A", "integrate", f.config.approvalPhrases.acceptance, "stale"), /latest sealed/);
    f.queue.request("TASK-A", "integrate", f.config.approvalPhrases.acceptance, first.item.candidateId);
    const accepted = await run(f);
    assert.equal(accepted.item.state, "COMPLETED", accepted.output + JSON.stringify(accepted.item));
    assert.equal(command(f.root, ["symbolic-ref", "--short", "HEAD"]), "main");
    assert.equal(command(f.root, ["rev-list", "--count", `${baseline}..main`]), "1");
    assert.equal(command(f.root, ["status", "--porcelain"]), "");
    assert.equal(f.queue.reserve().key, "TASK-B@1");
  } finally { f.cleanup(); }
});

test("queue ownership accepts OpenCode command descendants in a separate process group", { timeout: 180000 }, async () => {
  const f = fixture({ detachedAgentCommands: true });
  try {
    enqueue(f, "TASK-DETACHED-COMMAND");
    const result = await run(f);
    assert.equal(result.item.state, "AWAITING_HUMAN", result.output + JSON.stringify(result.item));
    assert.equal(existsSync(join(f.queue.storage.runtime, "evidence/TASK-DETACHED-COMMAND/baseline.json")), true);
  } finally { f.cleanup(); }
});

test("queue ownership still rejects an unrelated process that copies the active run id", async () => {
  const f = fixture();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    await once(unrelated, "spawn");
    enqueue(f, "TASK-UNRELATED");
    const reservation = f.queue.reserve();
    assert.ok(reservation);
    const owner = processIdentity(unrelated.pid);
    assert.ok(owner);
    f.queue.storage.transaction(document => { document.active.worker = owner; });
    mkdirSync(join(f.queue.storage.runtime, "workspaces"), { recursive: true });
    writeFileSync(join(f.queue.storage.runtime, "workspaces/TASK-UNRELATED.json"), `${JSON.stringify({ queueKey: reservation.key })}\n`);
    const result = spawnSync("bash", ["-c", 'source "$1"; automation_require_queue_execution "$2"',
      "queue-ownership-test", join(f.root, "scripts/automation/lib.sh"), "TASK-UNRELATED"], {
      cwd: f.root,
      encoding: "utf8",
      env: { ...f.env, AUTOMATION_TEST_MODE: "1", AUTOMATION_PROJECT_ROOT: f.root,
        AUTOMATION_RUNTIME_ROOT: f.queue.storage.runtime, AUTOMATION_QUEUE_RUN_ID: reservation.id },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /current process does not own this task queue execution/);
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) process.kill(-unrelated.pid, "SIGKILL");
    await once(unrelated, "close");
    f.cleanup();
  }
});

test("explicit automatic fixed mode executes quality gates and commits locally without human acceptance", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const baseline = command(f.root, ["rev-parse", "main"]);
    delete f.env.ANDROID_HOME;
    f.env.ANDROID_SDK_ROOT = f.base;
    const approved = enqueue(f, "TASK-A", { commitPolicy: "autoCommit" });
    const result = await run(f);
    assert.equal(result.item.state, "COMPLETED", result.output + JSON.stringify(result.item));
    const evidence = join(f.queue.storage.runtime, "evidence/TASK-A");
    assert.equal(existsSync(join(evidence, "acceptance.json")), false);
    const integration = JSON.parse(readFileSync(join(evidence, "integration.json")));
    assert.equal(integration.authorizationSource, "contractAutoCommit");
    assert.equal(integration.pushed, false);
    assert.equal(command(f.root, ["rev-list", "--count", `${baseline}..main`]), "1");
    const agents = readFileSync(join(f.base, "agent-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(agents.map(agent => agent.role), ["scheduled-coder", "scheduled-reviewer"]);
    const gradle = readFileSync(join(f.base, "gradle-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(gradle.filter(call => call.args.includes("--init-script")).length >= 4);
    assert.ok(gradle.every(call => !call.args.includes("clean")));
    assert.equal(approved.authorization.commitPolicy, "autoCommit");
  } finally { f.cleanup(); }
});

test("isolated waiting candidates release execution, dependencies wait for integration, and drift requires fresh review", { timeout: 240000 }, async () => {
  const f = fixture({ workspaceStrategy: "isolatedWorktree" });
  try {
    writeFileSync(join(f.root, ".gitignore"), "local.properties\n", { flag: "a" });
    writeFileSync(join(f.root, "local.properties"), `sdk.dir=${f.base}\n`);
    command(f.root, ["add", ".gitignore"]);
    command(f.root, ["commit", "-qm", "Keep local SDK configuration in the source workspace"]);
    delete f.env.ANDROID_HOME;
    delete f.env.ANDROID_SDK_ROOT;
    enqueue(f, "TASK-A"); enqueue(f, "TASK-B"); enqueue(f, "TASK-C", { dependsOn: ["TASK-A"] });
    const a = await run(f);
    assert.equal(a.item.state, "AWAITING_HUMAN", a.output);
    assert.notEqual(a.item.taskRoot, f.queue.storage.root);
    assert.equal(existsSync(a.item.taskRoot), true);
    assert.equal(existsSync(join(a.item.taskRoot, "local.properties")), false);
    assert.equal(command(f.root, ["status", "--porcelain"]), "");
    const b = await run(f);
    assert.equal(b.item.taskId, "TASK-B");
    assert.equal(b.item.state, "AWAITING_HUMAN", b.output);
    assert.equal(f.queue.reserve(), null);
    assert.match(f.queue.item("TASK-C").waitingReason, /dependency/);
    f.queue.request("TASK-A", "integrate", f.config.approvalPhrases.acceptance, a.item.candidateId);
    const completedA = await run(f);
    assert.equal(completedA.item.state, "COMPLETED", completedA.output);
    f.queue.request("TASK-B", "revalidate");
    const revised = await run(f);
    assert.equal(revised.item.state, "AWAITING_HUMAN", revised.output + revised.item.waitingReason);
    const workspace = JSON.parse(readFileSync(join(f.queue.storage.runtime, "workspaces/TASK-B.json")));
    assert.equal(workspace.baselineHead, completedA.item.completedCommit);
    assert.equal(workspace.taskRoot, b.item.taskRoot);
    assert.notEqual(revised.item.candidateId, b.item.candidateId);
    assert.throws(() => f.queue.request("TASK-B", "integrate", f.config.approvalPhrases.acceptance, b.item.candidateId), /latest sealed/);
    const agents = readFileSync(join(f.base, "agent-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(agents.filter(agent => agent.id === "TASK-B" && agent.role === "scheduled-reviewer").length, 2);
    f.queue.request("TASK-B", "integrate", f.config.approvalPhrases.acceptance, revised.item.candidateId);
    const completedB = await run(f);
    assert.equal(completedB.item.state, "COMPLETED", completedB.output + completedB.item.waitingReason);
    assert.equal(f.queue.reserve().key, "TASK-C@1");
  } finally { f.cleanup(); }
});
