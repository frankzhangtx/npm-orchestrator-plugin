import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectCommitMessagePrefix } from "../config/commit-message-prefix.js";
import { assertAuthorized, continuityPolicy, matchesPath, planningInputsDigest, type Draft, type QueueDocument, type TaskQueue } from "./queue.js";
import { git, gitBuffer, invariant, isAlive, readJson, sha256 } from "./storage.js";

export interface ChangedPath { path: string; status: string; destination?: string }
export interface Readiness {
  version: 1;
  state: "READY" | "WAITING_PREDECESSOR" | "WAITING_PRECONDITION" | "REPLAN_REQUIRED";
  reasonCode: string; checkedAt: string; planningHead: string; observedHead: string;
  targetHead: string; paths: ChangedPath[]; ownership: string | null;
  nextAction: string; fingerprint: string; authorizationDigest: string | null;
  codingStarted: false; workspaceCreated: false;
  versions: { committed: string | null; installed: string | null };
}
const shared = createRequire(import.meta.url)("../../templates/automation/verification/worktree.cjs") as {
  PREFIX: string; changes(root: string, allowlist: string[]): ChangedPath[];
};

function readHelper(root: string, name: string): string {
  const result = spawnSync("bash", ["-euc", 'source "$1"; "$2" "$3"', "precondition", join(root, "scripts/automation/lib.sh"), name, root],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, AUTOMATION_TEST_MODE: "", AUTOMATION_PROJECT_ROOT: "", AUTOMATION_RUNTIME_ROOT: "" } });
  invariant(result.status === 0 && !result.error, `${name}: exit=${result.status} signal=${result.signal}: ${result.error?.message || result.stderr?.trim().slice(-4000) || "no diagnostic output"}`);
  return result.stdout.trim();
}

/** A lease and a contract scope alone do not prove who wrote a file. Only exact
 * sealed artifacts or a previously sealed whole candidate establish ownership. */
function ownedPaths(queue: TaskQueue, document: QueueDocument, paths: ChangedPath[]): { owner: string | null; external: ChangedPath[] } {
  const root = queue.storage.root;
  const owner = document.items.find(item => item.taskRoot === root && !["COMPLETED", "CANCELLED", "ABORTED", "SUPERSEDED"].includes(item.state));
  if (!owner) return { owner: null, external: paths };
  const workspaceFile = join(queue.storage.runtime, "workspaces", `${owner.taskId}.json`);
  const leaseFile = join(queue.storage.runtime, "locks/repository.workspace.lease/lease.json");
  if (!existsSync(workspaceFile) || !existsSync(leaseFile)) return { owner: null, external: paths };
  const workspace = readJson<Record<string, unknown>>(workspaceFile), lease = readJson<Record<string, unknown>>(leaseFile);
  if (workspace.queueKey !== owner.key || workspace.taskRoot !== root || workspace.sourceRoot !== root ||
      lease.taskId !== owner.taskId || lease.sourceRoot !== root || lease.workspaceStrategy !== owner.workspaceStrategy ||
      workspace.baselineHead !== git(root, ["rev-parse", "HEAD"]) || workspace.executionRunId !== owner.runId ||
      git(root, ["symbolic-ref", "--short", "HEAD"]) !== workspace.taskBranch) return { owner: null, external: paths };
  assertAuthorized(owner);
  const active = document.active?.key === owner.key && document.active.id === owner.runId && document.active.worker && isAlive(document.active.worker);
  const sealed = owner.sealedRunId === owner.runId && owner.sealedDiff && readHelper(root, "automation_worktree_diff_sha") === owner.sealedDiff;
  if (!active && !sealed) return { owner: null, external: paths };
  const external = paths.filter(change => {
    if (change.destination) return true;
    const artifact = change.path === owner.contract.planPath ? owner.plan : change.path === `automation/tasks/${owner.taskId}.json` ? owner.contractText : null;
    if (artifact !== null) return !existsSync(join(root, change.path)) || readFileSync(join(root, change.path), "utf8") !== artifact;
    return !sealed || !(owner.contract.allowedPaths as string[]).some(pattern => matchesPath(pattern, change.path));
  });
  return { owner: owner.key, external };
}

export interface ReadinessScan { changes?: ChangedPath[]; owned?: { owner: string | null; external: ChangedPath[] } }
export function evaluateReadiness(queue: TaskQueue, planningHead: string, targetBranch: string, draft?: Draft, document = queue.storage.read(), scan: ReadinessScan = {}): Readiness {
  const root = queue.storage.root;
  let observedHead = "", targetHead = "", paths: ChangedPath[] = [], ownership: string | null = null;
  let state: Readiness["state"] = "READY", reasonCode = "READY", nextAction = "Ready for scheduling";
  const versions: Readiness["versions"] = { committed: null, installed: null };
  try {
    const config = queue.config();
    observedHead = git(root, ["rev-parse", "HEAD"]);
    targetHead = git(root, ["rev-parse", `refs/heads/${targetBranch}^{commit}`]);
    const configPaths = gitBuffer(root, ["ls-tree", "--name-only", "-z", planningHead, "--", "opencode.json", "opencode.jsonc"]).toString("utf8").split("\0").filter(Boolean);
    const pinned = configPaths.map(path => git(root, ["show", `${planningHead}:${path}`])).join("\n");
    versions.committed = pinned.match(/opencode-android-orchestrator@([\d.]+)/)?.[1] ?? null;
    const manifest = join(root, ".automation-plugin/manifest.json");
    if (existsSync(manifest)) versions.installed = readJson<{package: {version: string}}>(manifest).package.version;
    if (!scan.changes) {
      const allowlist = JSON.parse(readHelper(root, "automation_effective_worktree_allowlist_json_at")) as string[];
      scan.changes = shared.changes(root, allowlist);
    }
    paths = scan.changes;
    const owned = scan.owned ??= ownedPaths(queue, document, paths);
    ownership = owned.owner;
    paths = owned.external;
    // Fixed execution paths are protected even if a local config weakens its patterns.
    const protectedPath = (path: string) => path !== shared.PREFIX && (config.protectedPaths.some(pattern => matchesPath(pattern, path)) ||
      /^(opencode\.json|\.opencode\/|automation\/|scripts\/automation\/)/.test(path));
    if (versions.committed && versions.installed && versions.committed !== versions.installed) {
      state = "REPLAN_REQUIRED"; reasonCode = "EXECUTION_CONFIG_CHANGED";
      nextAction = "Installed plugin version differs from the planning configuration; review and commit the upgrade, then obtain a new snapshot and approval";
    }
    if (paths.some(change => protectedPath(change.path))) {
      state = "REPLAN_REQUIRED"; reasonCode = "EXECUTION_CONFIG_CHANGED";
      nextAction = "Review and commit installation/configuration changes, then obtain a new snapshot and approval";
    } else if (paths.length && state === "READY") {
      state = "WAITING_PRECONDITION"; reasonCode = "WORKTREE_DIRTY";
      nextAction = "Review and resolve the listed external changes, then recheck; no Coder or Gradle has started";
    }
    if (draft && reasonCode === "WORKTREE_DIRTY") {
      const inputs = [...(draft.contract.allowedPaths as string[]), ...(continuityPolicy(draft.contract)?.planningInputs ?? [])];
      if (paths.some(change => inputs.some(pattern => matchesPath(pattern, change.path)))) {
        state = "REPLAN_REQUIRED"; reasonCode = "PLANNING_INPUT_CHANGED";
        nextAction = "Resolve changed planning inputs, then obtain a new snapshot and approval";
      }
    }
    if (draft && targetHead !== planningHead) {
      git(root, ["merge-base", "--is-ancestor", planningHead, targetHead]);
      const changed = gitBuffer(root, ["diff", "--no-renames", "--name-only", "-z", planningHead, targetHead, "--"]).toString("utf8").split("\0").filter(Boolean);
      const policy = continuityPolicy(draft.contract);
      const completed = document.items.filter(item => item.state === "COMPLETED" && item.targetBranch === targetBranch && item.sourceRoot === root && item.completedCommit);
      const otherArtifact = (path: string) => completed.some(item => item.taskId !== draft.taskId && (path === item.contract.planPath || path === `automation/tasks/${item.taskId}.json`));
      // Committed prefix changes retain the existing baseline/authorization rules.
      const executionChanged = changed.some(path => !otherArtifact(path) && (config.protectedPaths.some(pattern => matchesPath(pattern, path)) || protectedPath(path)));
      let refresh = !policy && !changed.some(path => executionChanged || (draft.contract.allowedPaths as string[]).some(pattern => matchesPath(pattern, path)));
      if (policy && !executionChanged && policy.planningRefresh === "completedQueueTasks" &&
          planningInputsDigest(root, targetHead, policy.planningInputs) === draft.planningInputsSha256) {
        const lines = git(root, ["rev-list", "--reverse", "--parents", `${planningHead}..${targetHead}`]).split("\n").filter(Boolean);
        let parent = planningHead;
        refresh = lines.length > 0;
        for (const line of lines) {
          const [commit, previous, ...extra] = line.split(" ");
          const owner = completed.find(item => item.completedCommit === commit);
          if (!owner || previous !== parent || extra.length) { refresh = false; break; }
          assertAuthorized(owner);
          const tx = readJson<Record<string, any>>(join(queue.storage.runtime, "evidence", owner.taskId, "commit-transaction.json"));
          if (tx.stage !== "COMPLETED" || tx.commit !== commit || tx.baselineHead !== parent || tx.queueKey !== owner.key ||
              tx.authorization?.digest !== owner.digest || tx.targetBranch !== targetBranch || tx.pushed !== false ||
              git(root, ["rev-parse", `${commit}^{tree}`]) !== tx.tree) { refresh = false; break; }
          parent = commit!;
        }
        refresh = refresh && parent === targetHead;
      }
      if (!refresh) { paths = [...paths, ...changed.map(path => ({ path, status: "COMMITTED" }))]; state = "REPLAN_REQUIRED"; reasonCode = executionChanged ? "EXECUTION_CONFIG_CHANGED" : "PLANNING_BASELINE_CHANGED"; nextAction = "Cancel the unstarted version and obtain a new planning snapshot and approval; the original authorization is unchanged"; }
    }
    const prefix = inspectCommitMessagePrefix(root, (config as unknown as {commitMessagePrefixMode?: "required" | "disabled"}).commitMessagePrefixMode ?? "required");
    if (!["disabled", "configured"].includes(prefix.status) && state === "READY") {
      state = "WAITING_PRECONDITION"; reasonCode = "COMMIT_PREFIX_INVALID"; nextAction = `Configure automation/automation-commit-prefix: ${prefix.details.join("; ") || prefix.status}`;
    }
    if (state === "READY" && !ownership && document.active && document.active.key !== draft?.key) ownership = document.active.key;
    if (state === "READY" && ownership) { state = "WAITING_PREDECESSOR"; reasonCode = "WORKSPACE_OCCUPIED"; nextAction = `Wait for ${ownership} to release its workspace`; }
    if (state === "READY" && git(root, ["symbolic-ref", "--short", "HEAD"]) !== targetBranch) {
      state = "WAITING_PRECONDITION"; reasonCode = "TARGET_BRANCH_REQUIRED"; nextAction = `Restore approved branch ${targetBranch} before execution`;
    }
  } catch (error) {
    state = "WAITING_PRECONDITION"; reasonCode = "PRECONDITION_CHECK_FAILED";
    nextAction = `Resolve check failure and recheck: ${error instanceof Error ? error.message : String(error)}`;
  }
  const condition = { version: 1 as const, state, reasonCode, planningHead, observedHead, targetHead, paths, ownership, nextAction,
    authorizationDigest: draft?.digest ?? null, codingStarted: false as const, workspaceCreated: false as const, versions };
  return { ...condition, checkedAt: new Date().toISOString(), fingerprint: sha256(JSON.stringify(condition)) };
}

export function readinessMessage(result: Readiness): string {
  return `${result.reasonCode}: ${result.paths.length} changed paths ${JSON.stringify(result.paths.slice(0, 12)).slice(0, 3000)}; committed=${result.versions.committed ?? "unknown"}, installed=${result.versions.installed ?? "unknown"}. ${result.nextAction}`;
}
export function assertReadyForIntake(result: Readiness, planning = false): void {
  invariant(result.state === "READY" || result.state === "WAITING_PREDECESSOR" || (planning && result.reasonCode === "WORKTREE_DIRTY"), readinessMessage(result));
}
