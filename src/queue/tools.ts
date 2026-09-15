import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import { resolve } from "node:path";
import { installationDoctorChecks } from "../doctor/index.js";
import { invariant } from "./storage.js";
import { ApprovalLedger } from "./approvals.js";
import { TaskQueue, type DraftInput, type JobKind } from "./queue.js";
import { serviceStatus, startService, stopService, wakeService } from "./service.js";

export const QUEUE_TOOL_NAMES = ["android_orchestrator_snapshot", "android_orchestrator_intake", "android_orchestrator_queue"] as const;

export function createQueueTools(worktree: string, approvals = new ApprovalLedger()): Record<string, ToolDefinition> {
  const root = resolve(worktree);
  function bounded(context: ToolContext, mutation = false): TaskQueue {
    invariant(!context.abort.aborted && resolve(context.worktree) === root, "Queue tool workspace mismatch or aborted call");
    invariant(context.agent === "scheduled-planner", "Only the interactive Planner may access contract intake and queue controls");
    if (mutation) {
      const checks = installationDoctorChecks(root);
      const failures = ["installation-manifest", "managed-resources", "managed-permissions"].filter(id => !checks.some(check => check.id === id && check.status === "pass"));
      invariant(failures.length === 0, `Queue mutation requires an intact installation: ${failures.join(", ")}`);
    }
    return new TaskQueue(root);
  }
  return {
    android_orchestrator_snapshot: tool({
      description: "Read stable committed planning code without following the active Coder's branch or working files. Request compact snapshot metadata, discover paths with bounded list pages, then read exact files or chunks at the same planningHead.",
      args: {
        action: tool.schema.enum(["snapshot", "list", "read", "readChunk"]),
        targetBranch: tool.schema.string().optional(), planningHead: tool.schema.string().optional(),
        path: tool.schema.string().optional(), prefix: tool.schema.string().optional(), query: tool.schema.string().optional(),
        cursor: tool.schema.string().optional(), limit: tool.schema.number().int().min(1).max(200).optional(),
      },
      async execute(args, context) {
        const queue = bounded(context);
        if (args.action === "snapshot") return JSON.stringify(queue.snapshot(args.targetBranch));
        if (args.action === "list") return JSON.stringify(queue.listSnapshot(args.planningHead ?? "", args.prefix, args.query, args.cursor, args.limit));
        if (args.action === "readChunk") return JSON.stringify(queue.readSnapshotChunk(args.planningHead ?? "", args.path ?? "", args.cursor));
        return JSON.stringify(queue.readSnapshot(args.planningHead ?? "", args.path ?? ""));
      },
    }),
    android_orchestrator_intake: tool({
      description: "Seal a proposal-approved contract and plan in the independent inbox, or enqueue its exact reviewed digest and explicit human-selected approvalText. Approval returns immediately; only the background scheduler starts execution.",
      args: {
        action: tool.schema.enum(["draft", "enqueue"]),
        draftJson: tool.schema.string().optional(), key: tool.schema.string().optional(),
        digest: tool.schema.string().optional(), approval: tool.schema.string().optional(),
      },
      async execute(args, context) {
        const queue = bounded(context, true);
        if (args.action === "draft") {
          const draft = queue.draft(JSON.parse(args.draftJson ?? "{}") as DraftInput, approvals.consume(context, "proposal", "proposal"));
          const approvalText = queue.approvalText(draft);
          const question = approvals.prepare(context.sessionID, "enqueue", `${draft.key}:${draft.digest}`, "合同确认",
            `确认将 ${draft.key}（摘要 ${draft.digest.slice(0, 12)}，目标 ${draft.targetBranch}）按已展示的合同及提交策略入队？`, approvalText);
          return JSON.stringify({ ...draft, approvalText, question });
        }
        // An exact duplicate only returns the already authorized record; it
        // cannot recreate a cancelled task or widen its policy.
        const existing = queue.storage.read().items.some(item => item.key === args.key);
        const proof = existing ? undefined : approvals.consume(context, "enqueue", `${args.key}:${args.digest}`);
        const item = queue.enqueue(args.key ?? "", args.digest ?? "", args.approval ?? "", proof);
        let serviceError: string | null = null;
        try { startService(queue); } catch (error) { serviceError = String(error); }
        return JSON.stringify({ key: item.key, state: item.state, workspaceStrategy: item.workspaceStrategy, commitPolicy: item.commitPolicy,
          waitingReason: item.waitingReason, serviceError, pushed: false });
      },
    }),
    android_orchestrator_queue: tool({
      description: "Inspect durable queue notifications or manage the single repository executor. Acceptance, revalidation, recovery and abort all queue work through the same slot. Integration requires the latest candidate hash and human approval.",
      args: {
        action: tool.schema.enum(["status", "review", "start", "stop", "pause", "resume", "clear-fault", "cancel", "revoke", "acknowledge", "integrate", "revalidate", "resume-task", "resume-review", "abort", "recover", "recover-execution", "priority", "policy"]),
        operation: tool.schema.enum(["integrate", "resume-task", "resume-review", "abort"]).optional(),
        key: tool.schema.string().optional(), approval: tool.schema.string().optional(), candidate: tool.schema.string().optional(),
        priority: tool.schema.number().int().min(-100).max(100).optional(),
        workspaceStrategy: tool.schema.enum(["inPlaceExclusive", "isolatedWorktree"]).optional(),
        commitPolicy: tool.schema.enum(["humanApproval", "autoCommit"]).optional(),
      },
      async execute(args, context) {
        const queue = bounded(context, !["status", "review"].includes(args.action));
        if (args.action === "status") {
          if (args.key) return JSON.stringify(queue.details(args.key));
          const document = queue.storage.read();
          return JSON.stringify({ service: serviceStatus(queue), paused: document.paused, fault: document.fault, active: document.active,
            items: document.items.map(({ key, taskId, state, waitingReason, workspaceStrategy, commitPolicy, targetBranch, taskRoot, dependsOn, sealedDiff, candidateId, completedCommit }) => ({ key, taskId, state, waitingReason, workspaceStrategy, commitPolicy, targetBranch, taskRoot, dependsOn, sealedDiff, candidateId, completedCommit, pushed: false })),
            notifications: document.notifications.filter(notification => !notification.acknowledged) });
        }
        if (args.action === "review") {
          invariant(args.operation && args.key, "Review requires a task key and operation");
          const item = queue.item(args.key);
          const config = queue.config();
          const approval = args.operation === "integrate" ? config.approvalPhrases.acceptance : args.operation === "abort" ? config.approvalPhrases.abort : config.approvalPhrases.resume;
          invariant(approval, "Approval phrase is missing");
          const binding = `${item.key}:${item.digest}:${item.candidateId}:${args.operation}`;
          const question = approvals.prepare(context.sessionID, args.operation, binding,
            args.operation === "integrate" ? "最终验收" : args.operation === "abort" ? "中止确认" : "恢复确认",
            `确认对 ${item.key} 执行 ${args.operation}？候选 ${item.candidateId?.slice(0, 12) ?? "未封存"}，目标 ${item.targetBranch}；仅在本地处理，不推送。`, approval);
          return JSON.stringify({ ...queue.details(args.key), operation: args.operation, question });
        }
        if (args.action === "start") startService(queue);
        else if (args.action === "stop") stopService(queue);
        else if (args.action === "recover-execution") queue.recoverExecution();
        else if (args.action === "priority") queue.reorder(args.key ?? "", args.priority ?? NaN);
        else if (args.action === "policy") {
          invariant(args.workspaceStrategy && args.commitPolicy, "Specify both repository policies");
          queue.setPolicy(args.workspaceStrategy, args.commitPolicy);
        }
        else if (["pause", "resume", "clear-fault", "cancel", "revoke", "acknowledge"].includes(args.action)) queue.control(args.action as Parameters<TaskQueue["control"]>[0], args.key);
        else {
          const item = queue.item(args.key ?? "");
          const needsApproval = ["integrate", "resume-task", "resume-review", "abort"].includes(args.action);
          const proof = needsApproval ? approvals.consume(context, args.action, `${item.key}:${item.digest}:${item.candidateId}:${args.action}`) : undefined;
          queue.request(args.key ?? "", (args.action === "resume-task" ? "resume" : args.action) as Exclude<JobKind, "execute">, args.approval, args.candidate, proof);
          startService(queue);
        }
        wakeService(queue);
        return JSON.stringify({ requested: args.action, key: args.key, pushed: false });
      },
    }),
  };
}

/** In unattended runs, executable shell syntax and indirect Git entry points
 * cannot extend the installed agents' command allowlists. */
export function guardExecutorCommand(input: { tool: string }, output: { args: unknown }, directory?: string): void {
  if (!process.env.AUTOMATION_QUEUE_RUN_ID || input.tool !== "bash") return;
  const command = (output.args as { command?: unknown })?.command;
  invariant(typeof command === "string", "Executor shell command is missing");
  invariant(!/[\n\r;|&<>`\\]|\$\(/.test(command), "Shell chaining, substitution and redirection are forbidden in unattended execution");
  const readOnlyGit = /^git (?:status(?: --short)?|diff(?: --(?:stat|name-only))?|rev-parse (?:HEAD|--show-toplevel)|ls-files|show HEAD(?: --stat)?)$/;
  const scripts = /^\.\/scripts\/automation\/(?:status|select-task|claim-task|block-task|record-red|quality-gate|submit-review)\.sh [^\n]+$/;
  const gradle = /^\.\/gradlew (?:(?::?[A-Za-z][A-Za-z0-9_.:-]*)(?: --tests [A-Za-z0-9_.#$*'"-]+)?)(?: (?::?[A-Za-z][A-Za-z0-9_.:-]*))*$/;
  invariant(readOnlyGit.test(command) || scripts.test(command) || gradle.test(command), "Command is outside the unattended allowlist; direct or indirect remote push and Git mutation are forbidden");
  if (gradle.test(command)) {
    invariant(directory, "Gradle execution requires the recorded project configuration");
    const config = new TaskQueue(directory).config();
    const allowed = Object.values(config.gradleVerification).flat();
    const arguments_ = command.slice("./gradlew ".length).split(" ");
    for (let index = 0; index < arguments_.length; index += 1) {
      if (arguments_[index] === "--tests") { index += 1; continue; }
      invariant(allowed.includes(arguments_[index]!), "Gradle task is outside the configured verification allowlist");
    }
  }
}
