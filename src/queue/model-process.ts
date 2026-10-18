import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { atomicJson, readJson, invariant, processIdentity, type ProcessIdentity } from "./storage.js";
import { ownedTree, processSnapshot, signalOwned, type OwnedProcess } from "./process-ownership.js";

export type ModelStopReason = "EXITED" | "STEP_BUDGET" | "DEADLINE" | "INVALID_EVENTS" | "OUTPUT_LIMIT" | "HOST_ERROR" | "CANCELLED";
export interface ModelProcessResult {
  reason: ModelStopReason;
  steps: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processesExited: true;
  sessionID: string | null;
  startedAt: number;
  endedAt: number;
}
export interface ModelProcessOptions {
  cwd: string; agent: string; prompt: string; stepLimit: number; deadline: number;
  graceMs: number; eventLog: string; stderrLog: string;
  nativeCommand?: "change";
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  ownershipRecord?: string;
  /** Test harness injection; production callers always use the fixed OpenCode command. */
  command?: readonly string[];
}
const marker = "AUTOMATION_MODEL_CALL_TOKEN" as const;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Own the cutoff: a model's text, host exit 0 or generic stop is never a retry grant. */
export async function runBoundedModel(options: ModelProcessOptions): Promise<ModelProcessResult> {
  invariant(Number.isSafeInteger(options.stepLimit) && options.stepLimit >= 1 && options.stepLimit <= 256, "Invalid model step budget");
  invariant(Number.isSafeInteger(options.deadline) && options.deadline > Date.now(), "Model deadline already exhausted");
  invariant(Number.isSafeInteger(options.graceMs) && options.graceMs >= 100 && options.graceMs <= 60000, "Invalid model termination grace");
  invariant(["scheduled-coder", "scheduled-reviewer", "scheduled-planner"].includes(options.agent), "Invalid scheduled model role");
  invariant(options.agent !== "scheduled-planner" || options.nativeCommand === "change" && options.ownershipRecord,
    "Planner invocation requires native change and durable ownership");
  invariant(!options.nativeCommand || options.agent === "scheduled-planner", "Native change is reserved for Planner");
  invariant(!options.ownershipRecord || !existsSync(options.ownershipRecord), "Model ownership record already exists; recover instead of relaunching");
  options.signal?.throwIfAborted();
  const token = randomBytes(32).toString("hex"), startedAt = Date.now();
  const eventFd = openSync(options.eventLog, "wx", 0o600);
  let errorFd: number;
  try { errorFd = openSync(options.stderrLog, "wx", 0o600); }
  catch (error) { closeSync(eventFd); throw error; }
  const command = options.command ?? ["opencode", "run", "--dir", options.cwd, "--format", "json", "--agent", options.agent,
    ...(options.nativeCommand ? ["--command", options.nativeCommand] : []), "--", options.prompt];
  let child: ReturnType<typeof spawn> | undefined;
  let root: ProcessIdentity | null = null;
  let reason: ModelStopReason | null = null, ended = false, spawnError: Error | null = null;
  let sessionID: string | null = null, pending = "", bytes = 0;
  const decoder = new StringDecoder("utf8");
  const starts = new Set<string>(), finishes = new Set<string>();
  const ownership = (state: "SPAWNING" | "RUNNING" | "EXITED" | "NOT_STARTED", known: OwnedProcess[] = []) => {
    if (options.ownershipRecord) atomicJson(options.ownershipRecord, {version: 1, token, root, known, state, updatedAt: Date.now()});
  };
  const stop = (next: ModelStopReason) => {
    if (reason === null || (reason === "STEP_BUDGET" && next !== "STEP_BUDGET")) reason = next;
  };
  function event(line: string): void {
    if (!line.trim()) return;
    let value: { type?: string; sessionID?: string; part?: { id?: string; type?: string; messageID?: string; sessionID?: string } };
    try { value = JSON.parse(line); } catch { stop("INVALID_EVENTS"); return; }
    if (!value || typeof value !== "object" || typeof value.type !== "string") { stop("INVALID_EVENTS"); return; }
    if (value.type === "error") { stop("HOST_ERROR"); return; }
    if (!["step_start", "step_finish"].includes(value.type)) return;
    const p = value.part;
    if (!p || typeof p.id !== "string" || typeof p.messageID !== "string" || typeof value.sessionID !== "string" ||
        p.sessionID !== value.sessionID || p.type !== value.type.replace("_", "-")) { stop("INVALID_EVENTS"); return; }
    if (sessionID !== null && sessionID !== value.sessionID) { stop("INVALID_EVENTS"); return; }
    sessionID = value.sessionID;
    if (value.type === "step_start") { starts.add(p.messageID); return; }
    if (!starts.has(p.messageID) || finishes.has(p.id)) { stop("INVALID_EVENTS"); return; }
    finishes.add(p.id);
    if (finishes.size >= options.stepLimit) stop("STEP_BUDGET");
  }
  try {
    ownership("SPAWNING");
    child = spawn(command[0]!, command.slice(1), { cwd: options.cwd, detached: true,
      env: { ...process.env, ...options.environment, PWD: options.cwd, [marker]: token }, stdio: ["ignore", "pipe", "pipe"] });
    child.once("error", error => { spawnError = error; ended = true; stop("HOST_ERROR"); });
    child.once("close", () => { ended = true; pending += decoder.end(); if (pending.trim()) event(pending); pending = ""; });
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) { stop("OUTPUT_LIMIT"); return; }
      writeSync(eventFd, chunk);
      pending += decoder.write(chunk);
      for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
        event(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending) > 8 * 1024 * 1024) { pending = ""; stop("OUTPUT_LIMIT"); }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) { stop("OUTPUT_LIMIT"); return; }
      writeSync(errorFd, chunk);
    });
    // Wait for the actual spawn; a fast failure cannot become a budget stop.
    await new Promise<void>(resolve => { child!.once("spawn", resolve); child!.once("error", () => resolve()); });
    if (spawnError) { ownership("NOT_STARTED"); throw spawnError; }
    invariant(child.pid, "Model process has no PID");
    root = processIdentity(child.pid);
    invariant(root, "Cannot prove model process identity; supervisor must retain ownership");
    // spawn directly establishes the root identity and detached process group.
    // Persist that witness before sampling: a fast-exiting macOS process can
    // lose its visible environment before the first process-table snapshot.
    let known: OwnedProcess[] = [{...root, ppid: process.pid, pgid: child.pid, owned: true}];
    ownership("RUNNING", known);
    let termAt: number | null = null, empty = 0;
    for (;;) {
      const now = Date.now();
      if (options.signal?.aborted) stop("CANCELLED");
      if (now < startedAt || now >= options.deadline) stop("DEADLINE");
      const tree = ownedTree(processSnapshot(token, marker), root, known);
      const additions = tree.filter(p => !known.some(k => k.pid === p.pid && k.started === p.started));
      known = [...known, ...additions];
      if (additions.length) ownership("RUNNING", known);
      invariant(known.length <= 512, "Model process history exceeds its bounded ownership inventory");
      if (!tree.length && ended) {
        if (++empty >= 2) break;
      } else empty = 0;
      if (reason && tree.length) {
        termAt ??= now;
        invariant(now < termAt + options.graceMs + 10000, "Model processes did not exit; supervisor must retain ownership");
        const signal = now >= termAt + options.graceMs ? "SIGKILL" : "SIGTERM";
        for (const process of [...tree].sort((a, b) => Number(b.pid === root!.pid) - Number(a.pid === root!.pid)))
          signalOwned(token, process, signal, known, marker);
      }
      await wait(100);
    }
    ownership("EXITED", known);
    return { reason: reason === "STEP_BUDGET" && termAt === null ? "EXITED" : reason ?? "EXITED", steps: finishes.size, exitCode: child.exitCode, signal: child.signalCode,
      processesExited: true, sessionID, startedAt, endedAt: Date.now() };
  } finally {
    if (child && !ended) {
      child.stdout?.removeAllListeners("data"); child.stderr?.removeAllListeners("data");
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
    closeSync(eventFd); closeSync(errorFd);
  }
}

/** A restarted driver cleans the recorded Planner; it never launches it twice. */
export async function recoverModelProcesses(file: string, graceMs: number, deadline: number): Promise<void> {
  const record = readJson<{version: number; token: string; root: ProcessIdentity | null; known: OwnedProcess[]; state: string}>(file);
  if (record.version === 1 && record.state === "NOT_STARTED" && record.root === null) return;
  invariant(record.version === 1 && /^[a-f0-9]{64}$/.test(record.token) && record.root && Array.isArray(record.known) &&
    record.known.length <= 512, "Incomplete model launch identity; retain the execution boundary for ownership review");
  const started = Date.now();
  let empty = 0;
  for (;;) {
    invariant(Date.now() < deadline, "Model ownership cleanup deadline exhausted");
    const tree = ownedTree(processSnapshot(record.token, marker), record.root, record.known);
    if (!tree.length) { if (++empty >= 2) break; }
    else {
      empty = 0;
      for (const p of tree) if (!record.known.some(k => k.pid === p.pid && k.started === p.started)) record.known.push(p);
      invariant(record.known.length <= 512, "Model recovery process inventory exhausted");
      atomicJson(file, record);
      for (const process of tree) signalOwned(record.token, process, Date.now() - started < graceMs ? "SIGTERM" : "SIGKILL", record.known, marker);
    }
    await wait(100);
  }
  record.state = "EXITED"; atomicJson(file, record);
}
