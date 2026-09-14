import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskQueue, type QueueRun } from "./queue.js";
import { atomicJson, fileLock, invariant, isAlive, processIdentity, readJson, recoverLock, type ProcessIdentity } from "./storage.js";
import { helper, QueueExecutor } from "./executor.js";
import { androidSdkCandidate } from "../config/android-sdk.js";

const entry = fileURLToPath(new URL("./cli.js", import.meta.url));

export function serviceStatus(queue: TaskQueue): { running: boolean; owner: ProcessIdentity | null } {
  const path = join(queue.storage.runtime, "service.json");
  const owner = existsSync(path) ? readJson<ProcessIdentity>(path) : null;
  return { running: owner !== null && isAlive(owner), owner };
}

function detach(queue: TaskQueue, args: string[], logName: string): void {
  mkdirSync(queue.storage.runtime, { recursive: true, mode: 0o700 });
  const log = openSync(join(queue.storage.runtime, logName), "a", 0o600);
  try {
    const child = spawn("node", [entry, ...args, queue.storage.root], {
      cwd: queue.storage.root, detached: true, stdio: ["ignore", log, log],
      env: { ...process.env, OPENCODE_ANDROID_ORCHESTRATOR_QUEUE_CLI: entry },
    });
    child.once("error", error => {
      queue.storage.transaction(document => { document.fault = `Background process could not start: ${error.message}`; });
    });
    child.unref();
  } finally { closeSync(log); }
}

export function startService(queue: TaskQueue): void {
  queue.config();
  if (!serviceStatus(queue).running) {
    const lock = join(queue.storage.runtime, "locks/service.lock");
    if (existsSync(lock)) {
      const owner = readJson<ProcessIdentity>(lock);
      if (isAlive(owner)) { wakeService(queue); return; }
      recoverLock(lock);
    }
    detach(queue, ["_serve"], "service.log");
  }
  wakeService(queue);
}

export function wakeService(queue: TaskQueue): void {
  atomicJson(join(queue.storage.runtime, "wake.json"), { at: new Date().toISOString() });
}

export function stopService(queue: TaskQueue): void {
  const status = serviceStatus(queue);
  if (status.running && status.owner) process.kill(status.owner.pid, "SIGTERM");
}

export async function runWorker(queue: TaskQueue, runId: string): Promise<void> {
  const owner = processIdentity(process.pid);
  invariant(owner, "Cannot establish executor identity");
  let run: QueueRun | null = null;
  queue.storage.transaction(document => {
    invariant(document.active?.id === runId && document.active.worker === null, "Execution is missing, already started, or belongs to another worker");
    document.active.worker = owner;
    run = structuredClone(document.active);
  });
  invariant(run, "Execution reservation is missing");
  // Resolve on the source root before entering an isolated worktree. Its
  // ignored local.properties is deliberately never copied into task workspaces.
  const sdk = androidSdkCandidate(queue.storage.root);
  if (sdk) process.env.ANDROID_HOME = sdk.directory;
  await new QueueExecutor(queue, run).execute();
}

/** Reconcile persisted outcomes before consuming; a wake carries no authority. */
export function dispatchOnce(queue: TaskQueue): QueueRun | null {
  queue.reconcile();
  releaseStoppedLeases(queue);
  const run = queue.reserve();
  if (run) detach(queue, ["_worker", run.id], `executor-${run.id}.log`);
  return run;
}

export function releaseStoppedLeases(queue: TaskQueue): void {
  queue.storage.transaction(after => {
  const leasePath = join(queue.storage.runtime, "locks/repository.workspace.lease/lease.json");
  if (!after.active && existsSync(leasePath)) {
    const lease = readJson<{ taskId: string }>(leasePath);
    const item = after.items.find(candidate => candidate.taskId === lease.taskId);
    if (item?.workspaceStrategy === "isolatedWorktree" && item.sealedDiff && item.sealedRunId === item.runId) {
      const workspace = readJson<{ executionExited?: boolean; taskRoot: string; taskBranch: string }>(join(queue.storage.runtime, "workspaces", `${item.taskId}.json`));
      if (workspace.executionExited) {
        invariant(helper(workspace.taskRoot, "automation_worktree_diff_sha", [workspace.taskRoot]) === item.sealedDiff, "Isolated candidate changed before execution-slot release");
        helper(item.sourceRoot, "automation_release_repository_lease", [item.taskId]);
      }
    }
  }
  });
}

export async function serve(queue: TaskQueue): Promise<void> {
  const lifecycleRelease = fileLock(join(queue.storage.runtime, "locks/lifecycle.lock"));
  let release: () => void;
  try {
    const lock = join(queue.storage.runtime, "locks/service.lock");
    if (existsSync(lock)) return;
    queue.config();
    release = fileLock(lock, 0);
  } finally { lifecycleRelease(); }
  const owner = processIdentity(process.pid);
  invariant(owner, "Cannot identify scheduler process");
  atomicJson(join(queue.storage.runtime, "service.json"), owner);
  let stopped = false;
  let wake: (() => void) | null = null;
  const stop = () => { stopped = true; wake?.(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const watcher = watch(queue.storage.runtime, (_event, file) => { if (file === "wake.json") wake?.(); });
  try {
    while (!stopped) {
      let interval = 5000;
      try {
        interval = queue.config().queue?.scanIntervalMs ?? 5000;
        dispatchOnce(queue);
      } catch (error) {
        process.stderr.write(`${new Date().toISOString()} ${String(error)}\n`);
        // A public/environment fault suspends consumption but never intake.
        try { queue.storage.transaction(document => { document.fault = String(error); }); } catch { /* keep original transaction evidence */ }
      }
      if (stopped) break;
      const deadlines = queue.storage.read().items.filter(item => item.state === "QUEUED" && item.notBefore).map(item => Date.parse(item.notBefore!) - Date.now()).filter(delay => delay > 0);
      const delay = Math.max(50, Math.min(interval, ...deadlines));
      await new Promise<void>(done => {
        const timer = setTimeout(() => { wake = null; done(); }, delay);
        wake = () => { clearTimeout(timer); wake = null; done(); };
      });
    }
  } finally {
    watcher.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    release();
  }
}
