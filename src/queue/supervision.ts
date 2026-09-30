import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskQueue, QueueRun } from "./queue.js";
import { atomicJson, git, invariant, isAlive, processIdentity, readJson, recoverLock, sha256, type ProcessIdentity } from "./storage.js";
import { ownedTree, processSnapshot, signalOwned, type OwnedProcess } from "./process-ownership.js";
import { helper } from "./executor.js";

export interface ExecutionPolicy { version: 1; maxRunMs: number; maxStageMs: number; terminationGraceMs: number }
export interface Supervision {
  owner: ProcessIdentity | null; token: string; startedAt: number; deadline: number;
  stage: string; stageStartedAt: number; stageDeadline: number;
  state: "RUNNING" | "TERM_SENT" | "KILL_SENT" | "OWNERSHIP_BLOCKED" | "EXITED";
  stopReason: string | null; termAt: number | null; killAt: number | null;
  known: OwnedProcess[];
  events: Array<{ at: number; kind: string; pid?: number; started?: string }>;
}
const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function initialSupervision(policy: ExecutionPolicy, now: number): Supervision {
  return { owner: null, token: randomBytes(32).toString("hex"), startedAt: now, deadline: now + policy.maxRunMs,
    stage: "preparation", stageStartedAt: now, stageDeadline: now + policy.maxStageMs,
    state: "RUNNING", stopReason: null, termAt: null, killAt: null, known: [], events: [] };
}
export function supervisionEvidence(record: Supervision): Omit<Supervision, "token"> & { ownershipDigest: string } {
  const { token, ...evidence } = record;
  return { ...evidence, ownershipDigest: sha256(token) };
}
export function deadlineReason(record: Supervision, now: number): string | null {
  if (now < record.startedAt || now < record.stageStartedAt) return "Clock moved backwards; ownership review required";
  if (now >= record.deadline) return "Approved Worker execution deadline exceeded";
  if (now >= record.stageDeadline) return `Approved ${record.stage} stage deadline exceeded`;
  return null;
}
function stageFor(queue: TaskQueue, run: QueueRun): string {
  if (["integrate", "recover", "revalidate"].includes(run.kind)) return "integration";
  if (run.kind === "abort") return "abort";
  const item = queue.item(run.key), file = join(queue.storage.runtime, "state", `${item.taskId}.json`);
  const state = existsSync(file) ? readJson<{state: string}>(file).state : item.state;
  if (["READY_TO_COMMIT", "INTEGRATING", "COMPLETED"].includes(state)) return "integration";
  if (["READY_FOR_REVIEW", "REVIEWING", "CHANGES_REQUESTED"].includes(state)) return "review";
  if (["PENDING", "CODING"].includes(state)) return existsSync(join(queue.storage.runtime, "evidence", item.taskId, "baseline.json")) ? "coding" : "baseline";
  return run.supervision!.stage;
}
function update(queue: TaskQueue, runId: string, owner: ProcessIdentity, action: (run: QueueRun) => void): void {
  queue.storage.transaction(document => {
    invariant(document.active?.id === runId, "Supervisor lost its execution reservation");
    invariant(document.active.supervision?.owner?.pid === owner.pid && document.active.supervision.owner.started === owner.started,
      "Supervisor identity changed");
    action(document.active);
  });
}
export function recoverOwnedTransaction(queue: TaskQueue, record: Supervision, worker: ProcessIdentity | null): void {
  if (!existsSync(queue.storage.lockPath)) return;
  let owner: ProcessIdentity & { token?: string };
  try { owner = readJson<ProcessIdentity & { token?: string }>(queue.storage.lockPath); }
  catch (error) {
    // A live transaction creates its lock exclusively before writing its owner
    // and may release it between exists/read. Leave ambiguous bytes untouched;
    // normal transaction acquisition still waits and refuses an occupied lock.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (isAlive(owner)) return;
  // The process probe runs outside the file read. A short-lived transaction
  // can release its lock and exit before ps answers. Recheck the exact owner
  // before rejecting it, and bind any recovery to this same lock generation.
  try {
    const current = readJson<ProcessIdentity & { token?: string }>(queue.storage.lockPath);
    if (current.pid !== owner.pid || current.started !== owner.started || current.token !== owner.token) return;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  invariant([...(worker ? [worker] : []), ...(record.owner ? [record.owner] : []), ...record.known].some(p => p.pid === owner.pid && p.started === owner.started),
    "Dead queue lock does not belong to the supervised execution; explicit recovery required");
  recoverLock(queue.storage.lockPath, owner);
}
function finishStopped(queue: TaskQueue, run: QueueRun): void {
  const item = queue.item(run.key), evidence = join(queue.storage.runtime, "evidence", item.taskId);
  // A commit may already be visible. Preserve its transaction for the existing
  // idempotent recovery route; never start integration again here.
  const commit = existsSync(join(evidence, "commit-transaction.json"));
  const state = commit ? "INTEGRATION_BLOCKED" : "BLOCKED";
  const note = `${run.supervision!.stopReason}; all owned processes exited; candidate retained`;
  const statePath = join(queue.storage.runtime, "state", `${item.taskId}.json`);
  const previous = existsSync(statePath) ? readJson<{revision: number}>(statePath) : { revision: 0 };
  atomicJson(statePath, { taskId: item.taskId, state, revision: previous.revision + 1,
    updatedAt: new Date().toISOString(), updatedBy: "worker-supervisor", note });
  let diff: string | null = null, head = "";
  const workspacePath = join(queue.storage.runtime, "workspaces", `${item.taskId}.json`);
  if (!commit && existsSync(workspacePath)) {
    const workspace = readJson<{taskRoot: string; taskBranch: string; baselineHead: string}>(workspacePath);
    invariant(git(workspace.taskRoot, ["symbolic-ref", "--short", "HEAD"]) === workspace.taskBranch, "Stopped workspace branch changed");
    head = git(workspace.taskRoot, ["rev-parse", "HEAD"]);
    invariant(head === workspace.baselineHead, "Stopped workspace HEAD changed; preserve lease for explicit recovery");
    diff = helper(workspace.taskRoot, "automation_worktree_diff_sha", [workspace.taskRoot]);
    const patch = helper(workspace.taskRoot, "automation_worktree_patch_at", [workspace.taskRoot]);
    atomicJson(join(evidence, "queue-seal.json"), { runId: run.id, queueKey: item.key, taskRoot: workspace.taskRoot,
      taskBranch: workspace.taskBranch, head, diffSha256: diff, patch, state, sealedAt: new Date().toISOString(), stoppedBySupervisor: true });
  }
  queue.storage.transaction(document => {
    invariant(document.active?.id === run.id && document.active.supervision?.owner?.pid === run.supervision!.owner!.pid,
      "Stopped execution changed before sealing");
    document.active.outcome = { state, error: note };
    document.active.supervision.state = "EXITED";
    document.active.supervision.events.push({ at: Date.now(), kind: "exit-confirmed" });
    const current = document.items.find(candidate => candidate.key === item.key)!;
    current.state = state;
    if (current.baselineRecovery) current.baselineRecovery.nextRunAt = null;
    current.sealedDiff = diff; current.sealedRunId = diff ? run.id : null;
    current.candidateId = diff ? sha256(`${item.digest}:${head}:${diff}`) : null;
  });
}

/** Independent of both Worker event-loop progress and the scheduler lifetime. */
export async function supervise(queue: TaskQueue, runId: string): Promise<void> {
  const owner = processIdentity(process.pid);
  invariant(owner, "Cannot identify Worker supervisor");
  let run = queue.storage.read().active;
  invariant(run?.id === runId && run.supervision, "Missing approved supervision reservation");
  const previous = run.supervision.owner;
  if (previous && isAlive(previous)) return;
  recoverOwnedTransaction(queue, run.supervision, run.worker);
  queue.storage.transaction(document => {
    invariant(document.active?.id === runId && document.active.supervision, "Supervision reservation changed");
    const current = document.active.supervision.owner;
    invariant(!current || !isAlive(current), "Supervisor already alive");
    document.active.supervision.owner = owner;
    document.active.supervision.events.push({ at: Date.now(), kind: previous ? "supervisor-restarted" : "supervisor-started" });
  });
  const policy = queue.item(run.key).contract.execution as unknown as ExecutionPolicy;
  let launched = false;
  try {
    if (!run.worker && !previous) {
      const env = { ...process.env, AUTOMATION_WORKER_TOKEN: run.supervision.token };
      const child = spawn(process.execPath, [entry, "_worker", runId, queue.storage.root], { cwd: queue.storage.root, env, detached: true, stdio: "inherit" });
      child.on("error", () => { /* A missing registered worker fails closed below. */ });
      child.unref(); launched = true;
    }
    let previousClock = Date.now(), emptySnapshots = 0;
    for (;;) {
      run = queue.storage.read().active;
      invariant(run?.id === runId && run.supervision, "Supervisor reservation disappeared");
      const record = run.supervision, now = Date.now();
      invariant(now >= previousClock, "Clock moved backwards; retain execution slot"); previousClock = now;
      if (record.state === "EXITED" || record.state === "OWNERSHIP_BLOCKED") return;
      if (!run.worker) {
        invariant(launched && now < record.startedAt + Math.min(policy.maxRunMs, 30000), "Worker launch has no registered ownership; explicit recovery required");
        await wait(250); continue;
      }
      const tree = ownedTree(processSnapshot(record.token), run.worker, record.known);
      recoverOwnedTransaction(queue, record, run.worker);
      if (!tree.length) {
        emptySnapshots++;
        if (emptySnapshots < 2) { await wait(250); continue; }
        if (!run.outcome && !record.stopReason) update(queue, runId, owner, current => {
          current.supervision!.stopReason = "Worker exited without a durable outcome";
        });
        run = queue.storage.read().active!;
        if (run.supervision!.stopReason) finishStopped(queue, run);
        else update(queue, runId, owner, current => {
          current.supervision!.state = "EXITED";
          current.supervision!.events.push({ at: Date.now(), kind: "exit-confirmed" });
        });
        const document = queue.storage.read();
        const final = document.active?.id === runId ? document.active : document.runs.find(candidate => candidate.id === runId);
        invariant(final, "Completed supervision evidence is missing");
        atomicJson(join(queue.storage.runtime, "evidence", queue.item(final.key).taskId, `worker-stop-${runId}.json`), supervisionEvidence(final.supervision!));
        return;
      }
      emptySnapshots = 0;
      const stage = stageFor(queue, run);
      const reason = record.stopReason ?? deadlineReason(record, now);
      if (stage !== record.stage && !reason) update(queue, runId, owner, current => {
        const s = current.supervision!; s.stage = stage; s.stageStartedAt = now; s.stageDeadline = Math.min(s.deadline, now + policy.maxStageMs);
        s.events.push({ at: now, kind: `stage:${stage}` });
      });
      const fresh = tree.filter(p => !record.known.some(k => k.pid === p.pid && k.started === p.started));
      if (fresh.length) update(queue, runId, owner, current => {
        const live = new Set(tree.map(p => `${p.pid}:${p.started}`));
        current.supervision!.known = [...current.supervision!.known.filter(p => !live.has(`${p.pid}:${p.started}`)).slice(-(512 - tree.length)), ...tree];
      });
      if (reason) {
        const signal: NodeJS.Signals = record.termAt !== null && now >= record.termAt + policy.terminationGraceMs ? "SIGKILL" : "SIGTERM";
        invariant(record.killAt === null || now < record.killAt + 10000, "Owned processes did not exit after KILL; preserve execution slot");
        update(queue, runId, owner, current => {
          const s = current.supervision!; s.stopReason = reason;
          if (s.termAt === null) s.termAt = now;
          if (signal === "SIGKILL" && s.killAt === null) s.killAt = now;
          s.state = signal === "SIGKILL" ? "KILL_SENT" : "TERM_SENT";
        });
        // Stop the Worker first so it cannot start a fresh stage while children
        // handle TERM. Never signal a process group or a name-matched daemon.
        tree.sort((a, b) => Number(b.pid === run!.worker!.pid) - Number(a.pid === run!.worker!.pid));
        for (const process of tree) {
          if (record.events.some(e => (e.kind === `${signal}:sent` || e.kind === `${signal}:gone`) && e.pid === process.pid && e.started === process.started)) continue;
          update(queue, runId, owner, current => current.supervision!.events.push({ at: Date.now(), kind: signal, pid: process.pid, started: process.started }));
          const sent = signalOwned(record.token, process, signal, [...record.known, ...fresh]);
          update(queue, runId, owner, current => current.supervision!.events.push({ at: Date.now(), kind: `${signal}:${sent ? "sent" : "gone"}`, pid: process.pid, started: process.started }));
        }
      }
      await wait(250);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // No timeout ever authorizes taking an unknown lock or killing an unknown process.
    try {
      update(queue, runId, owner, current => {
        current.supervision!.state = "OWNERSHIP_BLOCKED";
        current.supervision!.stopReason = message;
        current.supervision!.events.push({ at: Date.now(), kind: "ownership-blocked" });
      });
      queue.storage.transaction(document => { document.fault = `Worker termination requires ownership recovery: ${message}`; });
    } finally {
      atomicJson(join(queue.storage.runtime, "evidence", queue.item(run!.key).taskId, `worker-stop-${runId}-blocked.json`), { runId, reason: message, at: Date.now() });
    }
  }
}
