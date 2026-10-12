import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { QueueItem, QueueRun } from "./queue.js";
import { isAlive } from "./storage.js";

// Observations never alter scheduling, authorization or completed outcomes.
const LIVE_STATES = new Set(["PREPARING", "PENDING", "CODING", "READY_FOR_REVIEW", "REVIEWING", "CHANGES_REQUESTED", "INTEGRATING"]);
const TERMINAL_STATES = new Set(["COMPLETED", "CANCELLED", "ABORTED", "SUPERSEDED"]);
function record(path: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 64 * 1024) return null;
    const value: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function runtimePresentation(runtime: string, item: QueueItem, run: QueueRun | null): Record<string, unknown> {
  const fallback = { state: item.state, recordedState: item.state, progress: null };
  if (!run || run.key !== item.key || run.id !== item.runId || run.outcome || !run.worker ||
    (run.supervision && run.supervision.state !== "RUNNING") || !isAlive(run.worker) || TERMINAL_STATES.has(item.state)) return fallback;
  const workspace = record(join(runtime, "workspaces", `${item.taskId}.json`));
  const state = record(join(runtime, "state", `${item.taskId}.json`));
  if (!workspace || !state || workspace.taskId !== item.taskId || workspace.queueKey !== item.key ||
    workspace.sourceRoot !== item.sourceRoot || workspace.taskRoot !== item.taskRoot || !item.taskRoot ||
    state.taskId !== item.taskId || typeof state.state !== "string" || !LIVE_STATES.has(state.state)) return fallback;
  const updated = typeof state.updatedAt === "string" ? Date.parse(state.updatedAt) : NaN;
  const started = Date.parse(run.createdAt), observed = Date.now();
  // Legacy state has second precision. It is usable only for its original
  // workspace run; resumed runs must write their own explicit run binding.
  const bound = state.queueRunId === run.id || (state.queueRunId === undefined && workspace.executionRunId === run.id);
  if (!bound || !Number.isFinite(updated) || !Number.isFinite(started) || updated < Math.floor(started / 1000) * 1000 || updated > observed) return fallback;
  return { state: state.state, recordedState: item.state, progress: {
    source: "runtime-state", runId: run.id, workerAlive: true, stage: state.state,
    updatedAt: state.updatedAt, observedAt: new Date(observed).toISOString(),
    stageElapsedMs: Math.max(0, observed - updated), runElapsedMs: Math.max(0, observed - started),
    note: typeof state.note === "string" ? Array.from(state.note).slice(0, 180).join("") : null,
  } };
}
