import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initialSupervision, deadlineReason } from "../dist/queue/supervision.js";
import { parseProcessTable, ownedTree, processSnapshot, signalOwned } from "../dist/queue/process-ownership.js";
import { atomicJson, processIdentity, isAlive } from "../dist/queue/storage.js";
import { validateContract } from "../dist/queue/queue.js";
import { serviceStatus } from "../dist/queue/service.js";
import { queueCli } from "../dist/queue/cli.js";
import { fixture, taskContract, run, enqueue } from "./queue-fixture.mjs";
const { validateExecutionPolicy } = createRequire(import.meta.url)("../templates/automation/verification/recovery.cjs");
const execution = { version: 1, maxRunMs: 180000, maxStageMs: 30000, terminationGraceMs: 1000 };
const recovery = { version: 1, scope: "baseline", maxEnvironmentRetries: 0, maxManualRetries: 0,
  maxElapsedMs: 900000, initialDelayMs: 1000, maxDelayMs: 60000, maxSameFailureRetries: 0 };
function approve(f, id = "TASK-WORKER", policy = execution, extra = {}) {
  const contract = { ...taskContract(f, id), schemaVersion: 6, recovery, execution: policy };
  const draft = f.queue.draft({ contract, plan: "# Approved bounded Worker execution and scoped behavior\n", ...f.queue.snapshot(), ...extra });
  return f.queue.enqueue(draft.key, draft.digest, f.queue.approvalText(draft));
}
async function until(check, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
async function cleanup(f) {
  const active = f.queue.storage.read().active;
  if (active?.supervision) {
    if (active.supervision.owner && isAlive(active.supervision.owner)) process.kill(active.supervision.owner.pid, "SIGKILL");
    const rows = ownedTree(processSnapshot(active.supervision.token), active.worker, active.supervision.known);
    for (const row of rows) signalOwned(active.supervision.token, row, "SIGKILL", active.supervision.known);
    await until(() => ownedTree(processSnapshot(active.supervision.token), active.worker, active.supervision.known).length === 0, "owned test process cleanup", 10000);
  }
  f.cleanup();
}

test("termination requires a new V6 contract with bounded execution policy", () => {
  validateExecutionPolicy(execution);
  for (const extra of [{ maxRunMs: 0 }, { maxStageMs: 180001 }, { terminationGraceMs: 0 }, { version: 2 }, { killAll: true }])
    assert.throws(() => validateExecutionPolicy({ ...execution, ...extra }));
  const f = fixture({ inventoryMode: true });
  try {
    const contract = { ...taskContract(f, "TASK-BOUNDS"), schemaVersion: 6, recovery, execution };
    validateContract(contract, f.config);
    assert.throws(() => validateContract({ ...contract, execution: undefined }, f.config));
    assert.throws(() => validateContract({ ...contract, schemaVersion: 5 }, f.config));
    const legacy = { ...contract, schemaVersion: 5 }; delete legacy.execution;
    validateContract(legacy, f.config);
  } finally { f.cleanup(); }
});

test("durable deadlines survive reload, include sleep time, and never use log silence", () => {
  const record = initialSupervision(execution, 10000);
  assert.equal(deadlineReason(record, 11000), null);
  const restored = JSON.parse(JSON.stringify(record));
  assert.match(deadlineReason(restored, 40000), /stage deadline/);
  assert.match(deadlineReason(restored, 190000), /execution deadline/);
  assert.match(deadlineReason(restored, 9999), /Clock moved backwards/);
});

test("status, task evidence and queue controls redact the supervision ownership token", async () => {
  const f = fixture({ inventoryMode: true });
  try {
    approve(f);
    const reserved = f.queue.reserve();
    const token = reserved.supervision.token;
    for (const action of ["status", "pause", "resume"]) {
      const result = await queueCli([action, f.root]);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
      assert.equal(result.active.supervision.ownershipDigest.length, 64);
    }
    assert.doesNotMatch(JSON.stringify(f.queue.details("TASK-WORKER")), new RegExp(token));
    atomicJson(join(f.root, "automation/tasks/TASK-WORKER.json"), f.queue.item("TASK-WORKER").contract);
    const shell = spawnSync("bash", ["scripts/automation/status.sh", "TASK-WORKER"], { cwd: f.root, env: f.env, encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(JSON.parse(shell.stdout).evidence.workerSupervision.state, "RUNNING");
    assert.doesNotMatch(shell.stdout, new RegExp(token));
    assert.equal(f.queue.storage.read().active.supervision.token, token);
  } finally { f.cleanup(); }
});

test("ownership inventory handles detached children, PID reuse and unknown descendants without retaining environments", () => {
  const token = "a".repeat(64), started = "Mon Sep 28 12:00:00 2026";
  const table = ` 100 1 100 ${started} S node AUTOMATION_WORKER_TOKEN=${token} SECRET=hidden\n 101 100 101 ${started} S child AUTOMATION_WORKER_TOKEN=${token}\n 200 1 200 ${started} S unrelated SECRET=hidden\n`;
  const rows = parseProcessTable(table, token);
  assert.deepEqual(ownedTree(rows, { pid: 100, started }).map(p => p.pid), [100, 101]);
  assert.doesNotMatch(JSON.stringify(rows), /hidden|SECRET|AUTOMATION_WORKER_TOKEN/);
  assert.throws(() => ownedTree(rows, { pid: 100, started: "different start" }), /identity changed/);
  const exiting = rows.map(row => row.pid === 100 ? { ...row, owned: false } : row);
  assert.throws(() => ownedTree(exiting, { pid: 100, started }), /identity changed/);
  assert.deepEqual(ownedTree(exiting, { pid: 100, started }, [rows[0]]).map(p => p.pid), [100, 101]);
  assert.throws(() => ownedTree(exiting, { pid: 100, started: "reused PID" }, [rows[0]]), /identity changed/);
  assert.throws(() => ownedTree([...rows, { pid: 102, ppid: 1, pgid: 100, started, owned: false }], { pid: 100, started }), /lacks ownership/);
  assert.throws(() => parseProcessTable("malformed process record", token), /Cannot parse/);
});

test("real process signals require both the unique token and unchanged process identity", async () => {
  const token = "b".repeat(64);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { ...process.env, AUTOMATION_WORKER_TOKEN: token } });
  const ended = new Promise(resolve => child.once("exit", resolve));
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const identity = processIdentity(child.pid);
    assert(identity);
    assert.equal(processSnapshot(token).find(p => p.pid === child.pid)?.owned, true);
    assert.throws(() => signalOwned(token, { ...identity, started: "changed" }, "SIGTERM"), /identity changed/);
    assert.throws(() => signalOwned("c".repeat(64), identity, "SIGTERM"), /identity changed/);
    assert.equal(isAlive(identity), true);
    assert.equal(signalOwned(token, identity, "SIGTERM"), true);
    await ended;
    assert.equal(isAlive(identity), false);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; } }
});

test("deadline stops TERM-resistant Gradle and its detached child, retains evidence and leaves unrelated processes alive", { timeout: 180000 }, async () => {
  const f = fixture({ inventoryMode: true, workerHang: true, workspaceStrategy: "isolatedWorktree" });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const ended = new Promise(resolve => unrelated.once("exit", resolve));
  try {
    const outsider = processIdentity(unrelated.pid);
    approve(f);
    enqueue(f, "TASK-INDEPENDENT");
    enqueue(f, "TASK-DEPENDENT", { dependsOn: ["TASK-WORKER"] });
    const running = run(f);
    await until(() => existsSync(join(f.base, "hanging-processes.json")), "hung Gradle fixture");
    const active = f.queue.storage.read().active;
    signalOwned(active.supervision.token, active.worker, "SIGSTOP");
    const result = await running;
    assert.equal(result.item.state, "BLOCKED", result.output + result.item.waitingReason);
    assert.match(result.item.waitingReason ?? JSON.stringify(f.queue.storage.read().active?.supervision), /stage deadline exceeded/);
    const completed = f.queue.storage.read().runs.at(-1);
    assert.equal(completed.supervision.state, "EXITED");
    assert(completed.supervision.events.some(e => e.kind === "SIGTERM"));
    assert(completed.supervision.events.some(e => e.kind === "SIGKILL"));
    const hanging = JSON.parse(readFileSync(join(f.base, "hanging-processes.json"), "utf8"));
    assert(hanging.args.includes("--no-daemon"));
    assert.equal(processIdentity(hanging.parent), null);
    assert.equal(processIdentity(hanging.child), null);
    assert.equal(isAlive(outsider), true);
    assert.equal(f.queue.storage.read().fault, null);
    assert.equal(existsSync(join(f.queue.storage.runtime, "locks/repository.workspace.lease")), false);
    assert.equal(existsSync(join(f.base, "agent-calls.jsonl")), false);
    assert(result.item.sealedDiff);
    assert.equal(result.item.completedCommit, null);
    assert.equal(existsSync(result.item.taskRoot), true);
    assert.equal(existsSync(join(f.queue.storage.runtime, "evidence/TASK-WORKER", `worker-stop-${completed.id}.json`)), true);
    const b = await run(f);
    assert.equal(b.item.state, "AWAITING_HUMAN", b.output + b.item.waitingReason);
    f.queue.request(b.item.key, "integrate", f.config.approvalPhrases.acceptance, b.item.candidateId);
    const integrated = await run(f);
    assert.equal(integrated.item.state, "COMPLETED", integrated.output + integrated.item.waitingReason);
    assert.equal(f.queue.reserve(), null);
    assert.match(f.queue.item("TASK-DEPENDENT").waitingReason, /dependency TASK-WORKER/);
    assert.equal(f.queue.item("TASK-WORKER").state, "BLOCKED");
  } finally {
    unrelated.kill("SIGTERM"); await ended;
    // Never delete a workspace while a supervised process can still use it.
    await cleanup(f);
  }
});

test("scheduler and supervisor restart retain the live Worker, stage deadline and termination budget", { timeout: 180000 }, async () => {
  const f = fixture({ inventoryMode: true, workerHang: true });
  const cli = fileURLToPath(new URL("../dist/queue/cli.js", import.meta.url));
  const services = [];
  function launch() {
    const logPath = join(f.base, `restart-service-${services.length}.log`);
    const log = openSync(logPath, 'a');
    const child = spawn(process.execPath, [cli, "_serve", f.root], { env: f.env, detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    const ended = new Promise(resolve => child.once("exit", resolve));
    const result = { child, ended, logPath }; services.push(result); return result;
  }
  try {
    approve(f, "TASK-WORKER", { ...execution, terminationGraceMs: 8000 });
    const firstService = launch();
    await until(() => existsSync(join(f.base, "hanging-processes.json")), "running supervised Worker");
    const original = f.queue.storage.read().active;
    firstService.child.kill("SIGTERM"); await firstService.ended;
    assert.equal(serviceStatus(f.queue).running, false);
    assert.equal(isAlive(original.worker), true);
    assert.equal(isAlive(original.supervision.owner), true);
    signalOwned(original.supervision.token, original.worker, "SIGSTOP");
    await until(() => f.queue.storage.read().active?.supervision.termAt !== null, "persisted TERM grace period");
    const stopping = f.queue.storage.read().active;
    process.kill(original.supervision.owner.pid, "SIGKILL");
    await until(() => !isAlive(original.supervision.owner), "supervisor stopped");
    launch();
    await until(() => f.queue.storage.read().active?.supervision.owner?.pid !== original.supervision.owner.pid, "new supervisor attached");
    const attached = f.queue.storage.read().active;
    assert.equal(attached.id, original.id);
    assert.deepEqual(attached.worker, original.worker);
    assert.equal(attached.supervision.deadline, original.supervision.deadline);
    assert.equal(attached.supervision.stageDeadline, original.supervision.stageDeadline);
    assert.equal(attached.supervision.termAt, stopping.supervision.termAt);
    await until(() => !f.queue.storage.read().active, "timeout reconciliation after service restart");
    const record = f.queue.storage.read().runs.at(-1);
    assert.equal(record.supervision.state, "EXITED");
    assert(record.supervision.events.some(e => e.kind === "supervisor-restarted"));
    assert(record.supervision.killAt >= stopping.supervision.termAt + 8000);
    assert.equal(f.queue.item("TASK-WORKER").state, "BLOCKED");
    assert.equal(f.queue.storage.read().runs.length, 1);
    assert.equal(f.queue.item("TASK-WORKER").completedCommit, null);
  } catch (error) {
    const document = f.queue.storage.read(), active = document.active;
    const { token, known, ...supervision } = active?.supervision ?? {};
    const read = path => existsSync(path) ? readFileSync(path, 'utf8').slice(-8000) : null;
    const lock = read(f.queue.storage.lockPath);
    let lockOwner;
    try { const { token: ignored, ...identity } = JSON.parse(lock); lockOwner = identity; }
    catch { lockOwner = { incomplete: true, bytes: lock?.length ?? 0 }; }
    console.error(JSON.stringify({ restartDiagnostic: { fault: document.fault,
      active: active && { id: active.id, worker: active.worker, outcome: active.outcome, supervision },
      lockOwner, services: services.map(s => ({ exitCode: s.child.exitCode, signal: s.child.signalCode, log: read(s.logPath) })),
      supervisorLog: active && read(join(f.queue.storage.runtime, `supervisor-${active.id}.log`)) } }));
    throw error;
  } finally {
    for (const { child, ended } of services) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await ended;
    }
    await cleanup(f);
  }
});

test("uncertain Worker identity sends no signals and keeps the execution slot and workspace lease", { timeout: 90000 }, async () => {
  const f = fixture({ inventoryMode: true, workerHang: true });
  let original = null;
  try {
    approve(f);
    const reservation = f.queue.reserve();
    const cli = fileURLToPath(new URL("../dist/queue/cli.js", import.meta.url));
    const supervisor = spawn(process.execPath, [cli, "_supervise", reservation.id, f.root], { env: f.env, detached: true, stdio: "ignore" });
    const running = new Promise(resolve => supervisor.once("exit", resolve));
    await until(() => existsSync(join(f.base, "hanging-processes.json")), "owned fixture Worker");
    original = f.queue.storage.read().active.worker;
    f.queue.storage.transaction(document => { document.active.worker.started = "different process generation"; });
    await running;
    const active = f.queue.storage.read().active;
    assert.equal(active.supervision.state, "OWNERSHIP_BLOCKED");
    assert.equal(active.supervision.events.some(e => e.kind.startsWith("SIG")), false);
    assert.equal(isAlive(original), true);
    assert.equal(f.queue.reserve(), null);
    assert.throws(() => f.queue.recoverExecution(), /identity changed/);
    assert.equal(existsSync(join(f.queue.storage.runtime, "locks/repository.workspace.lease")), true);
  } finally {
    if (original) f.queue.storage.transaction(document => { document.active.worker = original; });
    await cleanup(f);
  }
});

test("a healthy V6 Worker completes local integration without any termination signal", { timeout: 180000 }, async () => {
  const f = fixture({ inventoryMode: true });
  try {
    approve(f, "TASK-HEALTHY", { ...execution, maxStageMs: 120000 }, { commitPolicy: "autoCommit" });
    const result = await run(f);
    assert.equal(result.item.state, "COMPLETED", result.output + result.item.waitingReason);
    const record = f.queue.storage.read().runs.at(-1);
    assert.equal(record.supervision.state, "EXITED");
    assert.equal(record.supervision.stopReason, null);
    assert.equal(record.supervision.events.some(e => e.kind.startsWith("SIG")), false);
    const evidence = JSON.parse(readFileSync(join(f.queue.storage.runtime, "evidence/TASK-HEALTHY", `worker-stop-${record.id}.json`), "utf8"));
    assert.equal(Object.hasOwn(evidence, "token"), false);
  } finally { await cleanup(f); }
});

test("timeout after a local commit preserves the transaction and recovery integrates the same commit once", { timeout: 180000 }, async () => {
  const f = fixture({ inventoryMode: true, workerHang: "integration" });
  try {
    approve(f, "TASK-COMMIT", execution, { commitPolicy: "autoCommit" });
    const interrupted = await run(f);
    assert.equal(interrupted.item.state, "INTEGRATION_BLOCKED", interrupted.output + interrupted.item.waitingReason);
    const file = join(f.queue.storage.runtime, "evidence/TASK-COMMIT/commit-transaction.json");
    const before = JSON.parse(readFileSync(file, "utf8"));
    assert(before.commit);
    assert.equal(f.queue.item("TASK-COMMIT").completedCommit, null);
    assert.equal(existsSync(join(f.queue.storage.runtime, "locks/repository.workspace.lease")), true);
    f.queue.request("TASK-COMMIT", "recover");
    const recovered = await run(f);
    assert.equal(recovered.item.state, "COMPLETED", recovered.output + recovered.item.waitingReason);
    assert.equal(recovered.item.completedCommit, before.commit);
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.id, before.id);
    assert.equal(after.commit, before.commit);
  } finally { await cleanup(f); }
});
