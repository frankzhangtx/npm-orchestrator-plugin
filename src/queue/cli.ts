#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskQueue, type DraftInput, type JobKind } from "./queue.js";
import { invariant, recoverLock } from "./storage.js";
import { runWorker, serve, serviceStatus, startService, stopService, wakeService } from "./service.js";

export async function queueCli(args: string[]): Promise<unknown> {
  const [action = "status", ...rest] = args;
  if (action === "--help" || action === "-h") return {
    usage: "opencode-android-orchestrator queue <action> [directory] [arguments]",
    actions: {
      status: "Durable queue, waiting reasons, notifications and daemon status",
      start: "Start the detached repository scheduler", stop: "Stop scheduling; retain the current executor",
      pause: "Pause new executions", resume: "Resume consumption", snapshot: "[targetBranch] Read compact stable planning metadata",
      list: "<planningHead> [prefix] [query] [cursor] [limit] List bounded stable file pages",
      read: "<planningHead> <path> Read a file at a fixed commit",
      "read-chunk": "<planningHead> <path> [cursor] Read a bounded exact file chunk",
      draft: "<input.json> Seal contract, plan, scheduling and commit policy in the inbox",
      enqueue: "<key> <digest> <approval> Approve exactly one reviewed draft and return immediately",
      cancel: "<key> Cancel an unstarted contract", revoke: "<key> Revoke future commit authorization",
      integrate: "<key> <approval> <candidate> Request local integration after fresh final acceptance",
      revalidate: "<key> Revalidate an isolated candidate on the current target branch",
      "resume-task": "<key> <approval> Queue approved Coder recovery", "resume-review": "<key> <approval> Queue approved Reviewer recovery",
      abort: "<key> <approval> Queue approved archival and safe workspace handoff",
      recover: "<key> Resume a sealed local commit transaction",
      "recover-lock": "Recover a queue transaction only after proving its owner has exited",
      "clear-fault": "Clear a resolved public fault while no executor is active",
      "recover-execution": "Prove the recorded executor and children have exited, then retain its interrupted workspace",
      priority: "<key> <priority> Reorder an unstarted item without changing its sealed authorization",
      policy: "<workspaceStrategy> <commitPolicy> Change repository defaults only while paused and unoccupied",
    },
  };
  if (action === "_worker") {
    invariant(rest.length === 2, "Invalid executor invocation");
    return runWorker(new TaskQueue(rest[1]!), rest[0]!);
  }
  const [directory = process.cwd(), ...values] = rest;
  const queue = new TaskQueue(directory);
  if (action === "_serve") return serve(queue);
  if (action === "status") return values[0] ? queue.details(values[0]) : { service: serviceStatus(queue), ...queue.storage.read() };
  if (action === "snapshot") return queue.snapshot(values[0]);
  if (action === "list") return queue.listSnapshot(values[0] ?? "", values[1], values[2], values[3], values[4] === undefined ? undefined : Number(values[4]));
  if (action === "read") return queue.readSnapshot(values[0] ?? "", values[1] ?? "");
  if (action === "read-chunk") return queue.readSnapshotChunk(values[0] ?? "", values[1] ?? "", values[2]);
  if (action === "draft") {
    invariant(values.length === 1, "draft requires an input JSON file");
    const draft = queue.draft(JSON.parse(readFileSync(values[0]!, "utf8")) as DraftInput);
    return { ...draft, approvalText: queue.approvalText(draft) };
  }
  if (action === "enqueue") {
    invariant(values.length === 3, "enqueue requires key, digest and exact review approval");
    const item = queue.enqueue(values[0]!, values[1]!, values[2]!);
    let serviceError: string | null = null;
    try { startService(queue); } catch (error) { serviceError = String(error); }
    return { key: item.key, state: item.state, commitPolicy: item.commitPolicy, workspaceStrategy: item.workspaceStrategy, serviceError, pushed: false };
  }
  if (action === "start") { startService(queue); return { requested: "start" }; }
  if (action === "stop") { stopService(queue); return { requested: "stop" }; }
  if (["pause", "resume", "clear-fault", "cancel", "revoke", "acknowledge"].includes(action)) {
    const result = queue.control(action as Parameters<TaskQueue["control"]>[0], values[0]);
    wakeService(queue); return result;
  }
  if (action === "recover-lock") {
    recoverLock(queue.storage.lockPath);
    return { recovered: true };
  }
  if (action === "recover-execution") { queue.recoverExecution(); wakeService(queue); return { recovered: true }; }
  if (action === "priority") { queue.reorder(values[0] ?? "", Number(values[1])); wakeService(queue); return { reordered: values[0] }; }
  if (action === "policy") {
    invariant(values.length === 2, "policy requires workspaceStrategy and commitPolicy");
    queue.setPolicy(values[0] as Parameters<TaskQueue["setPolicy"]>[0], values[1] as Parameters<TaskQueue["setPolicy"]>[1]);
    return { policy: queue.config() };
  }
  if (["integrate", "revalidate", "resume-task", "resume-review", "abort", "recover"].includes(action)) {
    const kind = action === "resume-task" ? "resume" : action;
    queue.request(values[0] ?? "", kind as Exclude<JobKind, "execute">, values[1], values[2]);
    startService(queue); return { key: values[0], requested: kind };
  }
  throw new Error(`Unknown queue action: ${action}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  queueCli(process.argv.slice(2)).then(result => {
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
