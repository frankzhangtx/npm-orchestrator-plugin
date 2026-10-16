import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertAuthorized, type TaskQueue, type QueueDocument } from "./queue.js";
import { helper } from "./executor.js";
import { atomicJson, git, invariant, isAlive, readJson, sha256 } from "./storage.js";
import { scopeAllows } from "./run-scope.js";
import { runBoundedModel } from "./model-process.js";
import { completeModelCall, reserveModelCall, type ModelPolicy } from "./model-ledger.js";

function owner(document: QueueDocument) {
  const active = document.active;
  invariant(active, "No active model Worker");
  invariant(active.id === process.env.AUTOMATION_QUEUE_RUN_ID && active.worker && isAlive(active.worker) &&
    active.supervision?.state === "RUNNING" && active.supervision.token === process.env.AUTOMATION_WORKER_TOKEN,
    "Model invocation requires the supervised Worker");
  const item = document.items.find(candidate => candidate.key === active.key)!;
  assertAuthorized(item);
  invariant(!item.request && scopeAllows(document.runScope, item.key), "Model task is stopped or outside its run scope");
  invariant(item.contract.schemaVersion === 8 && item.contract.modelContinuation, "Explicit V8 model policy approval required");
  return { active, item, policy: item.contract.modelContinuation as unknown as ModelPolicy };
}
function fileHash(file: string): string | null {
  if (!existsSync(file)) return null;
  invariant(lstatSync(file).isFile(), "Model checkpoint must reference a regular file");
  return sha256(readFileSync(file));
}
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string, prefix: string) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), relative = `${prefix}${name}`, stat = lstatSync(path);
      invariant(!stat.isSymbolicLink(), "Model binding rejects symbolic links");
      if (stat.isDirectory()) walk(path, `${relative}/`);
      else { invariant(stat.isFile(), "Model binding rejects special files"); result[relative] = sha256(readFileSync(path)); }
    }
  }
  walk(root, ""); return result;
}

/** This bridge is internal to orchestrate-task.sh; it does not grant a tool new approval powers. */
export async function runQueuedModel(queue: TaskQueue, role: string, prompt: string, cycle: number, attempt: number): Promise<void> {
  invariant(["scheduled-coder", "scheduled-reviewer"].includes(role) && prompt.length <= 32768 &&
    Number.isSafeInteger(cycle) && cycle >= 0 && Number.isSafeInteger(attempt) && attempt >= 0, "Invalid model invocation");
  const first = owner(queue.storage.read());
  const taskId = first.item.taskId, evidence = join(queue.storage.runtime, "evidence", taskId);
  const workspaceFile = join(queue.storage.runtime, "workspaces", `${taskId}.json`);
  const stateFile = join(queue.storage.runtime, "state", `${taskId}.json`);
  const workspace = readJson<{taskRoot: string; baselineHead: string}>(workspaceFile), root = workspace.taskRoot;
  invariant(first.item.taskRoot === root, "Model workspace does not match the reserved task");
  const binding = () => {
    invariant(git(root, ["rev-parse", "HEAD"]) === workspace.baselineHead, "Model workspace HEAD changed");
    invariant(fileHash(join(root, "automation/tasks", `${taskId}.json`)) === first.item.contractSha256 &&
      fileHash(join(root, first.item.contract.planPath as string)) === first.item.planSha256, "Model contract or plan changed");
    return sha256(JSON.stringify({ digest: first.item.digest, baselineHead: workspace.baselineHead, root,
      config: fileHash(join(root, "automation/config.json")), sourceConfig: fileHash(join(queue.storage.root, "automation/config.json")),
      opencode: fileHash(join(root, "opencode.json")), scripts: tree(join(root, "scripts/automation")),
      verification: tree(join(root, "automation/verification")), agents: tree(join(root, ".opencode/agents")),
      skills: tree(join(root, ".opencode/skills")) }));
  };
  const checkpoint = () => sha256(JSON.stringify({
    binding: binding(), diff: helper(root, "automation_worktree_diff_sha", [root], first.active.id),
    workspace: fileHash(workspaceFile), state: fileHash(stateFile),
    files: Object.fromEntries(["origin.json", "baseline.json", "baseline-inventory.json", "red.json", "test-manifest.json",
      "test-preflight.json", "test-supplement.json", "preparation.json", "gate.json", "ready.json", "review.json", "baseline-recovery.json",
      ...readdirSync(evidence).filter(name => /^(?:gate-attempts-cycle-|preparation-|test-preparation-).*\.json$/.test(name)).sort()]
      .map(name => [name, fileHash(join(evidence, name))])),
    stageRecovery: tree(join(evidence, "stage-recovery")),
  }));
  const previous = first.item.modelLedger?.calls.at(-1);
  let continuationOf: number | null = role === "scheduled-coder" && previous?.role === role &&
    previous.cycle === cycle && previous.result?.reason === "STEP_BUDGET" ? previous.id : null;
  for (;;) {
    const currentBinding = binding(), currentCheckpoint = checkpoint();
    const reserved = queue.storage.transaction(document => {
      const { active, item, policy } = owner(document);
      invariant(active.id === first.active.id, "Model Worker reservation changed");
      const state = readJson<{state: string}>(stateFile).state;
      invariant(role === "scheduled-coder" ? ["PENDING", "CODING"].includes(state) : state === "REVIEWING", "Model role does not match task state");
      if (continuationOf !== null) {
        const red = readJson<{structuredCasesVerified?: boolean}>(join(evidence, "red.json"));
        const manifest = readJson<{valid?: boolean; phase?: string}>(join(evidence, "test-manifest.json"));
        invariant(red.structuredCasesVerified === true && manifest.valid === true && manifest.phase === "red", "Continuation requires sealed RED and test evidence");
      }
      const result = reserveModelCall(item.modelLedger, policy, { binding: currentBinding, checkpoint: currentCheckpoint,
        role, cycle, attempt, continuationOf, now: Date.now(),
        deadline: Math.min(active.supervision!.deadline, active.supervision!.stageDeadline) });
      item.modelLedger = result.ledger;
      return { id: result.call.id, deadline: Math.min(result.ledger.deadline, active.supervision!.deadline, active.supervision!.stageDeadline), policy };
    });
    // A crash after reservation intentionally leaves an unfinished call. Neither
    // a restart nor a manually repeated command can reclaim its budget.
    atomicJson(join(evidence, "model-continuation.json"), queue.item(first.item.key).modelLedger);
    const result = await runBoundedModel({ cwd: root, agent: role,
      prompt: continuationOf === null ? prompt : `${prompt}\nContinue the existing sealed RED and test manifest. Preserve all preparation, repair, review and model budgets. Do not recapture baseline, RED or tests.`,
      stepLimit: reserved.policy.stepLimit, deadline: reserved.deadline,
      graceMs: (first.item.contract.execution as {terminationGraceMs: number}).terminationGraceMs,
      eventLog: join(evidence, `model-call-${reserved.id}.jsonl`), stderrLog: join(evidence, `model-call-${reserved.id}.stderr.log`) });
    const stoppedCheckpoint = checkpoint();
    queue.storage.transaction(document => {
      const { item } = owner(document);
      invariant(item.modelLedger?.binding === currentBinding, "Model ledger binding changed");
      completeModelCall(item.modelLedger, reserved.id, result, stoppedCheckpoint);
    });
    atomicJson(join(evidence, "model-continuation.json"), queue.item(first.item.key).modelLedger);
    appendFileSync(join(evidence, "agent-runs.jsonl"), `${JSON.stringify({taskId, role, cycle, attempt,
      at: new Date().toISOString(), exitCode: result.exitCode, stopReason: result.reason, modelCall: reserved.id})}\n`);
    const state = readJson<{state: string}>(stateFile).state;
    if (role !== "scheduled-coder" || result.reason !== "STEP_BUDGET" || !["PENDING", "CODING"].includes(state)) return;
    continuationOf = reserved.id;
  }
}
