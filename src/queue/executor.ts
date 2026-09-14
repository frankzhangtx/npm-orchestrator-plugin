import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAuthorized, matchesPath, now, TaskQueue, type QueueItem, type QueueRun } from "./queue.js";
import { atomicJson, fileLock, git, invariant, processIdentity, readJson, recoverLock, safePath, sha256 } from "./storage.js";

interface Workspace {
  taskId: string; sourceRoot: string; originalBranch: string; baselineHead: string;
  taskRoot: string; taskBranch: string; workspaceStrategy: string;
  repositoryLeaseRequired: boolean; queueKey: string; commitPolicy: string;
  worktreeAllowlist: string[]; codingCycle: number; reviewCycles: number;
  [key: string]: unknown;
}
interface CommitTransaction {
  id: string; taskId: string; queueKey: string; stage: "INTENT" | "COMMITTED" | "VERIFIED" | "INTEGRATED" | "COMPLETED";
  baselineHead: string; tree: string; sealedDiff: string; commit: string | null;
  targetBranch: string; authorization: { source: "humanAcceptance" | "contractAutoCommit"; digest: string; candidate: string; targetHead: string };
  paths: string[];
  approvalProof?: QueueItem["authorization"]["proof"];
  pushed: false; createdAt: string;
}
const bridge = fileURLToPath(new URL("./cli.js", import.meta.url));

export function workerEnvironment(runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AUTOMATION_QUEUE_RUN_ID: runId, OPENCODE_ANDROID_ORCHESTRATOR_QUEUE_CLI: bridge,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" };
  // Model/tool arguments cannot enable shell test bypasses in production runs.
  delete env.AUTOMATION_TEST_MODE;
  delete env.AUTOMATION_SKIP_AGENT_RUN;
  delete env.AUTOMATION_PROJECT_ROOT;
  delete env.AUTOMATION_RUNTIME_ROOT;
  return env;
}

export function helper(root: string, name: string, args: string[] = [], runId = ""): string {
  invariant(/^automation_[a-z_]+$/.test(name), "Invalid automation helper");
  const result = spawnSync("bash", ["-euc", 'source "$1"; shift; "$@"', "automation-helper", join(root, "scripts/automation/lib.sh"), name, ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: workerEnvironment(runId),
  });
  invariant(result.status === 0, result.error?.message ?? (result.stderr || result.stdout).trim());
  return result.stdout.trimEnd();
}

async function script(root: string, name: string, args: string[], runId: string): Promise<void> {
  invariant(/^[a-z-]+\.sh$/.test(name), "Invalid automation script");
  await new Promise<void>((done, reject) => {
    const child = spawn("bash", [join(root, "scripts/automation", name), ...args], {
      cwd: root, stdio: "inherit", env: workerEnvironment(runId),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? done() : reject(new Error(`${name} exited with ${code ?? signal}`)));
  });
}

export class QueueExecutor {
  private readonly evidence: string;
  private readonly workspacePath: string;
  private readonly previousAgentRuns: number;
  constructor(readonly queue: TaskQueue, readonly run: QueueRun) {
    const item = queue.item(run.key);
    this.evidence = join(queue.storage.runtime, "evidence", item.taskId);
    this.workspacePath = join(queue.storage.runtime, "workspaces", `${item.taskId}.json`);
    const runs = join(this.evidence, "agent-runs.jsonl");
    this.previousAgentRuns = existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).length : 0;
  }
  private item(): QueueItem { return this.queue.item(this.run.key); }
  private workspace(): Workspace { return readJson<Workspace>(this.workspacePath); }
  private state(): string {
    const path = join(this.queue.storage.runtime, "state", `${this.item().taskId}.json`);
    return existsSync(path) ? readJson<{state: string}>(path).state : this.item().state;
  }
  private setState(state: string, note: string): void {
    const item = this.item();
    const path = join(this.queue.storage.runtime, "state", `${item.taskId}.json`);
    const previous = existsSync(path) ? readJson<{revision: number}>(path) : { revision: 0 };
    atomicJson(path, { taskId: item.taskId, state, revision: previous.revision + 1, updatedAt: now(), updatedBy: "queue-executor", note });
    this.queue.storage.transaction(document => {
      invariant(document.active?.id === this.run.id, "Executor no longer owns the queue slot");
      const current = document.items.find(candidate => candidate.key === item.key)!;
      current.state = state;
      this.queue.notify(document, current, note);
    });
  }
  private assertOwner(): void {
    const active = this.queue.storage.read().active;
    invariant(active?.id === this.run.id && active.worker?.pid === process.pid, "Executor does not own the repository slot");
    invariant(active.worker.started === processIdentity(process.pid)?.started, "Executor process identity changed");
    if (this.run.kind !== "abort") assertAuthorized(this.item());
    this.queue.config();
  }
  private lease(item: QueueItem, root: string): void {
    helper(root, "automation_acquire_repository_lease", [item.taskId, item.sourceRoot, item.workspaceStrategy], this.run.id);
    if (existsSync(this.workspacePath)) atomicJson(this.workspacePath, { ...this.workspace(), repositoryLeaseRequired: true, executionExited: false });
  }
  private executionInputsChanged(path: string, item: QueueItem): boolean {
    // Other completed tasks bring their own sealed planning files. Those files
    // are protected from Coder edits but are not this task's execution policy.
    const otherArtifact = this.queue.storage.read().items.some(other =>
      other.taskId !== item.taskId && other.state === "COMPLETED" &&
      (path === other.contract.planPath || path === `automation/tasks/${other.taskId}.json`));
    return !otherArtifact && this.queue.config().protectedPaths.some(pattern => matchesPath(pattern, path));
  }
  private prepare(): boolean {
    const item = this.item();
    const config = this.queue.config();
    invariant(config.unitTestsEnabled === true, "Queued execution requires full unit tests; enable unitTestsEnabled");
    const target = git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]);
    git(item.sourceRoot, ["merge-base", "--is-ancestor", item.planningHead, target]);
    const changed = target === item.planningHead ? [] : git(item.sourceRoot, ["diff", "--name-only", item.planningHead, target, "--"]).split("\n").filter(Boolean);
    const relevant = changed.filter(path => (item.contract.allowedPaths as string[]).some(pattern => matchesPath(pattern, path)) || this.executionInputsChanged(path, item));
    atomicJson(join(this.evidence, "planning-baseline.json"), { planningHead: item.planningHead, executionHead: target, changedPaths: changed, relevantChanges: relevant, checkedAt: now() });
    if (relevant.length > 0) {
      this.setState("BASELINE_REVIEW", "Relevant code or execution configuration changed after planning; create and approve a revised contract");
      return false;
    }
    helper(item.sourceRoot, "automation_worktree_is_clean", [item.sourceRoot], this.run.id);
    invariant(git(item.sourceRoot, ["symbolic-ref", "--short", "HEAD"]) === item.targetBranch, "Source root must be on the approved local target branch");
    const taskBranch = `automation/${item.taskId.toLowerCase()}-v${item.version}`;
    const branchCheck = spawnSync("git", ["-C", item.sourceRoot, "show-ref", "--verify", "--quiet", `refs/heads/${taskBranch}`]);
    invariant(branchCheck.status === 1, "Task branch already exists or cannot be inspected");
    let taskRoot = item.sourceRoot;
    let base = "";
    if (item.workspaceStrategy === "isolatedWorktree") {
      base = helper(item.sourceRoot, "automation_worktree_base", [], this.run.id);
      mkdirSync(base, { recursive: true });
      base = realpathSync(base);
      taskRoot = join(base, `${item.taskId.toLowerCase()}-v${item.version}`);
      invariant(!existsSync(taskRoot), "Task worktree already exists");
    }
    this.lease(item, item.sourceRoot);
    const allowlist = JSON.parse(helper(item.sourceRoot, "automation_worktree_allowlist_file_json_at", [item.sourceRoot], this.run.id)) as string[];
    const workspace: Workspace = { taskId: item.taskId, sourceRoot: item.sourceRoot, originalBranch: item.targetBranch,
      baselineHead: target, workspaceStrategy: item.workspaceStrategy, taskRoot, taskBranch,
      repositoryLeaseRequired: true, queueKey: item.key, commitPolicy: item.commitPolicy,
      worktreeBase: base, worktreeAllowlist: allowlist, planningArtifactsCommitPolicy: "withProductChanges",
      codingCycle: 0, reviewCycles: 0, createdAt: now(), executionRunId: this.run.id };
    // Write ownership before mutating Git; partial preparation remains occupied.
    atomicJson(this.workspacePath, workspace);
    this.queue.storage.transaction(document => { document.items.find(candidate => candidate.key === item.key)!.taskRoot = taskRoot; });
    atomicJson(join(this.evidence, "origin.json"), { taskId: item.taskId, sourceRoot: item.sourceRoot,
      originalBranch: item.targetBranch, originalHeadBeforeContract: item.planningHead, baselineHead: target,
      contractPath: `automation/tasks/${item.taskId}.json`, planPath: item.contract.planPath,
      contractSha256: item.contractSha256, planSha256: item.planSha256,
      planningArtifactsCommitPolicy: "withProductChanges", contractCommit: null, approvedAt: item.approvedAt,
      queueKey: item.key, authorizationDigest: item.digest, commitPolicy: item.commitPolicy, pushed: false });
    atomicJson(join(this.evidence, "contract-authorization.json"), item.authorization);
    this.setState("PREPARING", "Preparing only this contract's sealed artifacts");
    const releaseGit = fileLock(join(this.queue.storage.runtime, "locks/git.lock"));
    try {
      if (item.workspaceStrategy === "inPlaceExclusive") git(item.sourceRoot, ["switch", "-c", taskBranch, target]);
      else {
        mkdirSync(base, { recursive: true });
        git(item.sourceRoot, ["worktree", "add", taskRoot, "-b", taskBranch, target]);
      }
    } finally { releaseGit(); }
    for (const [path, content] of [[String(item.contract.planPath), item.plan], [`automation/tasks/${item.taskId}.json`, item.contractText]] as const) {
      const destination = safePath(taskRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, { flag: "wx", mode: 0o644 });
    }
    helper(taskRoot, "automation_assert_planning_artifacts_sealed", [item.taskId, taskRoot], this.run.id);
    this.setState("PENDING", "Approved queue contract prepared for Coder");
    return true;
  }
  private seal(): void {
    if (!existsSync(this.workspacePath)) return;
    const workspace = this.workspace();
    if (!existsSync(workspace.taskRoot)) return;
    invariant(git(workspace.taskRoot, ["symbolic-ref", "--short", "HEAD"]) === workspace.taskBranch, "Cannot seal a workspace on an unexpected branch");
    const diff = helper(workspace.taskRoot, "automation_worktree_diff_sha", [workspace.taskRoot], this.run.id);
    const patch = helper(workspace.taskRoot, "automation_worktree_patch_at", [workspace.taskRoot], this.run.id);
    atomicJson(join(this.evidence, "queue-seal.json"), { runId: this.run.id, queueKey: this.item().key, taskRoot: workspace.taskRoot,
      taskBranch: workspace.taskBranch, head: git(workspace.taskRoot, ["rev-parse", "HEAD"]), diffSha256: diff,
      patch, state: this.state(), sealedAt: now(), processGroup: process.pid });
    this.queue.storage.transaction(document => {
      const item = document.items.find(item => item.key === this.run.key)!;
      item.sealedDiff = diff;
      item.sealedRunId = this.run.id;
      item.candidateId = sha256(`${item.digest}:${workspace.baselineHead}:${diff}`);
    });
  }
  private async integrate(recovery = false): Promise<void> {
    this.assertOwner();
    invariant(this.item().request?.kind !== "abort", "Approved abort requested; stop before automatic local commit");
    const item = this.item();
    if (recovery) recoverLock(join(this.queue.storage.runtime, "locks/git.lock"));
    const workspace = this.workspace();
    this.lease(item, item.sourceRoot);
    const transactionPath = join(this.evidence, "commit-transaction.json");
    let transaction: CommitTransaction;
    if (existsSync(transactionPath)) {
      invariant(recovery, "A commit transaction already exists; request recovery");
      transaction = readJson<CommitTransaction>(transactionPath);
      invariant(transaction.queueKey === item.key && transaction.authorization.digest === item.digest && transaction.pushed === false, "Commit recovery authorization does not match");
      invariant(transaction.taskId === item.taskId && transaction.targetBranch === item.targetBranch &&
        transaction.baselineHead === workspace.baselineHead && transaction.authorization.targetHead === workspace.baselineHead &&
        transaction.authorization.candidate === sha256(`${item.digest}:${workspace.baselineHead}:${transaction.sealedDiff}`), "Commit transaction candidate or baseline changed");
      invariant(transaction.authorization.source === (item.commitPolicy === "autoCommit" ? "contractAutoCommit" : "humanAcceptance"), "Commit transaction authorization source changed");
      invariant(["INTENT", "COMMITTED", "VERIFIED", "INTEGRATED", "COMPLETED"].includes(transaction.stage), "Invalid commit transaction stage");
    } else {
      invariant(!recovery, "No commit transaction is available to recover");
      invariant(this.state() === (item.commitPolicy === "autoCommit" ? "READY_TO_COMMIT" : "AWAITING_HUMAN"), "Candidate is not ready for authorized integration");
      invariant(item.commitPolicy !== "autoCommit" || item.workspaceStrategy === "inPlaceExclusive", "Unsupported automatic commit workspace");
      const head = git(workspace.taskRoot, ["rev-parse", "HEAD"]);
      invariant(head === workspace.baselineHead, "Task HEAD changed before commit");
      const target = git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]);
      invariant(target === workspace.baselineHead, "Target branch advanced; revalidate isolated candidates before fresh acceptance");
      helper(workspace.taskRoot, "automation_assert_planning_artifacts_sealed", [item.taskId, workspace.taskRoot], this.run.id);
      const diff = helper(workspace.taskRoot, "automation_worktree_diff_sha", [workspace.taskRoot], this.run.id);
      const ready = readJson<{diffSha256: string}>(join(this.evidence, "ready.json"));
      const review = readJson<{decision: string; diffSha256: string; verificationExitCode: number}>(join(this.evidence, "review.json"));
      invariant(diff === ready.diffSha256 && diff === review.diffSha256 && review.decision === "APPROVED" && review.verificationExitCode === 0, "Current candidate lacks matching independent review and quality evidence");
      const candidateId = sha256(`${item.digest}:${workspace.baselineHead}:${diff}`);
      if (item.commitPolicy === "humanApproval") invariant(item.request?.candidate === candidateId, "Human acceptance is stale for this candidate or baseline");
      await script(workspace.taskRoot, "acceptance-report.sh", [item.taskId], this.run.id);
      await script(workspace.taskRoot, "scope-gate.sh", [item.taskId], this.run.id);
      // Require the forced full-test evidence from both Coder and Reviewer.
      const verification = readJson<{fullTestsExecuted: boolean; diffSha256: string}>(join(this.evidence, "full-test-verification.json"));
      invariant(verification.fullTestsExecuted && verification.diffSha256 === diff, "Full unit-test execution evidence is absent or stale");
      const paths = helper(workspace.taskRoot, "automation_changed_paths_at", [workspace.taskRoot], this.run.id).split("\n").filter(Boolean);
      invariant(paths.length >= 3, "Combined commit needs product changes and both planning artifacts");
      const index = join(this.evidence, `commit-index-${randomUUID()}`);
      const indexEnv = { ...workerEnvironment(this.run.id), GIT_INDEX_FILE: index };
      for (const args of [["read-tree", head], ["add", "--", ...paths]]) {
        const result = spawnSync("git", ["-C", workspace.taskRoot, ...args], { env: indexEnv, encoding: "utf8" });
        invariant(result.status === 0, result.stderr);
      }
      const treeResult = spawnSync("git", ["-C", workspace.taskRoot, "write-tree"], { env: indexEnv, encoding: "utf8" });
      invariant(treeResult.status === 0, treeResult.stderr);
      transaction = { id: randomUUID(), taskId: item.taskId, queueKey: item.key, stage: "INTENT", baselineHead: head, paths,
        tree: treeResult.stdout.trim(), sealedDiff: diff, commit: null, targetBranch: item.targetBranch,
        authorization: { source: item.commitPolicy === "autoCommit" ? "contractAutoCommit" : "humanAcceptance", digest: item.digest, candidate: candidateId, targetHead: target },
        ...(item.commitPolicy === "autoCommit" ? { approvalProof: item.authorization.proof } : { approvalProof: item.request?.proof }),
        pushed: false, createdAt: now() };
      atomicJson(transactionPath, transaction);
      atomicJson(join(this.evidence, item.commitPolicy === "autoCommit" ? "auto-commit-authorization.json" : "acceptance.json"), transaction.authorization);
    }
    this.setState("INTEGRATING", "Applying the sealed local commit transaction");
    if (transaction.stage === "INTENT") {
      const branchHead = git(item.sourceRoot, ["rev-parse", `refs/heads/${workspace.taskBranch}`]);
      if (branchHead !== transaction.baselineHead) {
        invariant(!transaction.commit || transaction.commit === branchHead, "Task reference differs from recorded commit");
        invariant(git(item.sourceRoot, ["rev-parse", `${branchHead}^{tree}`]) === transaction.tree && git(item.sourceRoot, ["rev-parse", `${branchHead}^`]) === transaction.baselineHead, "Existing task commit differs from recorded transaction intent");
        transaction.commit = branchHead;
      } else {
        invariant(git(workspace.taskRoot, ["symbolic-ref", "--short", "HEAD"]) === workspace.taskBranch, "Task branch changed before transaction commit");
        invariant(helper(workspace.taskRoot, "automation_worktree_diff_sha", [workspace.taskRoot], this.run.id) === transaction.sealedDiff, "Diff changed after commit intent");
        this.assertOwner();
        const title = helper(item.sourceRoot, "automation_commit_message_at", [item.sourceRoot, `Implement ${item.contract.title} (${item.taskId})`], this.run.id);
        // commit-tree has no hooks or remote side effects; persist its SHA before
        // updating the task reference. A crash can only leave an unreachable
        // object, never a second visible task commit.
        if (!transaction.commit) {
          transaction.commit = git(workspace.taskRoot, ["-c", "commit.gpgSign=false", "commit-tree", transaction.tree, "-p", transaction.baselineHead, "-m", title]);
          atomicJson(transactionPath, transaction);
        }
        git(workspace.taskRoot, ["update-ref", `refs/heads/${workspace.taskBranch}`, transaction.commit, transaction.baselineHead]);
      }
      invariant(transaction.commit, "Commit transaction has no candidate");
      // Align only committed index entries. Human-owned excluded staged entries
      // must survive handoff just like their working files and build outputs.
      const treeEntries = git(workspace.taskRoot, ["ls-tree", "-r", transaction.commit, "--", ...transaction.paths]);
      const entries = new Map(treeEntries.split("\n").filter(Boolean).map(line => {
        const [header, path] = line.split("\t");
        const [mode, , object] = header!.split(" ");
        return [path!, `${mode} ${object}\t${path}`];
      }));
      const indexInfo = transaction.paths.map(path => entries.get(path) ?? `0 ${"0".repeat(40)}\t${path}`).join("\n") + "\n";
      git(workspace.taskRoot, ["update-index", "--index-info"], indexInfo);
      helper(workspace.taskRoot, "automation_worktree_is_clean", [workspace.taskRoot], this.run.id);
      transaction.stage = "COMMITTED";
      atomicJson(transactionPath, transaction);
    }
    invariant(transaction.commit, "Missing transaction commit");
    invariant(git(item.sourceRoot, ["rev-parse", `${transaction.commit}^{tree}`]) === transaction.tree, "Candidate tree differs from transaction");
    invariant(git(item.sourceRoot, ["rev-parse", `${transaction.commit}^`]) === transaction.baselineHead, "Candidate parent differs from transaction");
    // These are derived records. Rewrite on recovery even if a crash occurred
    // after the durable COMMITTED stage but before its metadata was stored.
    atomicJson(this.workspacePath, { ...this.workspace(), productCommit: transaction.commit, candidateHead: transaction.commit });
    const origin = readJson<Record<string, unknown>>(join(this.evidence, "origin.json"));
    atomicJson(join(this.evidence, "origin.json"), { ...origin, contractCommit: transaction.commit, planningArtifactsCommittedWithProduct: true });
    if (transaction.stage === "COMMITTED") {
      invariant(git(workspace.taskRoot, ["rev-parse", "HEAD"]) === transaction.commit, "Candidate workspace HEAD changed");
      helper(workspace.taskRoot, "automation_worktree_is_clean", [workspace.taskRoot], this.run.id);
      await script(workspace.taskRoot, "verify-integration.sh", [item.taskId, transaction.baselineHead, transaction.commit], this.run.id);
      helper(workspace.taskRoot, "automation_worktree_is_clean", [workspace.taskRoot], this.run.id);
      transaction.stage = "VERIFIED";
      atomicJson(transactionPath, transaction);
    }
    if (transaction.stage === "VERIFIED") {
      const releaseGit = fileLock(join(this.queue.storage.runtime, "locks/git.lock"));
      try {
      this.assertOwner();
      const current = git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]);
      invariant(current === transaction.baselineHead || current === transaction.commit, "Target advanced during verification; transaction remains blocked");
      if (item.workspaceStrategy === "inPlaceExclusive") {
        helper(item.sourceRoot, "automation_worktree_is_clean", [item.sourceRoot], this.run.id);
        const branch = git(item.sourceRoot, ["symbolic-ref", "--short", "HEAD"]);
        invariant(branch === workspace.taskBranch || branch === item.targetBranch, "Source branch changed before integration");
        if (branch === workspace.taskBranch) git(item.sourceRoot, ["switch", item.targetBranch]);
      }
      invariant(git(item.sourceRoot, ["symbolic-ref", "--short", "HEAD"]) === item.targetBranch, "Source root no longer on target branch");
      helper(item.sourceRoot, "automation_worktree_is_clean", [item.sourceRoot], this.run.id);
      if (current !== transaction.commit) {
        // --ff-only cannot synthesize an unverified merge. Disable hooks in this
        // deterministic integration path; authorization never includes them.
        git(item.sourceRoot, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", transaction.commit]);
      }
      invariant(git(item.sourceRoot, ["rev-parse", "HEAD"]) === transaction.commit, "Local target did not reach verified candidate");
      transaction.stage = "INTEGRATED";
      atomicJson(transactionPath, transaction);
      } finally { releaseGit(); }
    }
    invariant(git(item.sourceRoot, ["symbolic-ref", "--short", "HEAD"]) === item.targetBranch &&
      git(item.sourceRoot, ["rev-parse", "HEAD"]) === transaction.commit, "Completed transaction target changed; preserve workspace for recovery");
    helper(item.sourceRoot, "automation_worktree_is_clean", [item.sourceRoot], this.run.id);
    if (transaction.stage === "INTEGRATED") {
      invariant(git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]) === transaction.commit, "Target moved before final handoff");
      helper(item.sourceRoot, "automation_worktree_is_clean", [item.sourceRoot], this.run.id);
      if (item.workspaceStrategy === "isolatedWorktree" && existsSync(workspace.taskRoot)) {
        helper(workspace.taskRoot, "automation_worktree_is_clean", [workspace.taskRoot], this.run.id);
        if (this.queue.config().autoCleanupWorktrees) git(item.sourceRoot, ["worktree", "remove", workspace.taskRoot]);
        else git(workspace.taskRoot, ["switch", "--detach", transaction.commit]);
      }
      const branch = spawnSync("git", ["-C", item.sourceRoot, "show-ref", "--verify", "--quiet", `refs/heads/${workspace.taskBranch}`]);
      if (branch.status === 0) git(item.sourceRoot, ["branch", "-d", "--", workspace.taskBranch]);
      else invariant(branch.status === 1, "Cannot inspect task branch cleanup");
      transaction.stage = "COMPLETED";
      atomicJson(transactionPath, transaction);
    }
    atomicJson(join(this.evidence, "integration.json"), { taskId: item.taskId, productCommit: transaction.commit,
      integratedHead: transaction.commit, originalBranch: item.targetBranch, authorizationSource: transaction.authorization.source,
      method: `${item.workspaceStrategy}-fast-forward`, verificationExitCode: 0, integratedAt: now(), pushed: false });
    this.queue.storage.transaction(document => { document.items.find(candidate => candidate.key === item.key)!.completedCommit = transaction.commit; });
    this.setState("COMPLETED", `${transaction.authorization.source}: local commit and integration complete; not pushed`);
    helper(item.sourceRoot, "automation_release_repository_lease", [item.taskId], this.run.id);
  }
  private async revalidate(): Promise<void> {
    const item = this.item();
    const workspace = this.workspace();
    invariant(item.workspaceStrategy === "isolatedWorktree" && item.commitPolicy === "humanApproval", "Revalidation requires isolated human-review mode");
    this.lease(item, item.sourceRoot);
    const target = git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]);
    if (target === workspace.baselineHead) return;
    invariant(helper(workspace.taskRoot, "automation_worktree_diff_sha", [workspace.taskRoot], this.run.id) === item.sealedDiff, "Sealed candidate changed before revalidation");
    invariant(git(workspace.taskRoot, ["rev-parse", "HEAD"]) === workspace.baselineHead, "Candidate has unrecorded commits");
    git(item.sourceRoot, ["merge-base", "--is-ancestor", workspace.baselineHead, target]);
    // A mixed reset/rebase could discard a waiting candidate. Git's three-way
    // checkout preserves the working diff, and fails on conflicts. Archive the
    // complete candidate first and keep the same task root for all verification.
    const archive = readJson<Record<string, unknown>>(join(this.evidence, "queue-seal.json"));
    const revalidationPath = join(this.evidence, `revalidation-${this.run.id}.json`);
    atomicJson(revalidationPath, { previous: workspace, seal: archive, target, state: "INTENT" });
    const changed = git(item.sourceRoot, ["diff", "--name-only", workspace.baselineHead, target, "--"]).split("\n").filter(Boolean);
    invariant(!changed.some(path => this.executionInputsChanged(path, item)), "Execution configuration changed; replan and approve a new contract");
    const paths = helper(workspace.taskRoot, "automation_changed_paths_at", [workspace.taskRoot], this.run.id).split("\n");
    invariant(!changed.some(path => paths.includes(path)), "Revalidation conflicts with the sealed candidate; preserve workspace for explicit recovery");
    invariant(git(workspace.taskRoot, ["diff", "--cached", "--name-only"]) === "", "Unstage the sealed candidate before revalidation; staged contents are preserved");
    // checkout --merge retains uncommitted task changes; no commit or acceptance
    // is fabricated. The existing branch is moved only after checkout succeeds.
    git(workspace.taskRoot, ["switch", "--detach", "--merge", target]);
    git(item.sourceRoot, ["update-ref", `refs/heads/${workspace.taskBranch}`, target, workspace.baselineHead]);
    git(workspace.taskRoot, ["switch", workspace.taskBranch]);
    atomicJson(this.workspacePath, { ...workspace, baselineHead: target, originalBaselineHead: workspace.originalBaselineHead ?? workspace.baselineHead, revalidationRunId: this.run.id, reviewCycles: workspace.reviewCycles + 1, repositoryLeaseRequired: true });
    helper(workspace.taskRoot, "automation_assert_planning_artifacts_sealed", [item.taskId, workspace.taskRoot], this.run.id);
    await script(workspace.taskRoot, "verify-task.sh", [item.taskId], this.run.id);
    const readyPath = join(this.evidence, "ready.json");
    const ready = readJson<Record<string, unknown>>(readyPath);
    atomicJson(join(this.evidence, `ready-before-${this.run.id}.json`), ready);
    const diff = helper(workspace.taskRoot, "automation_worktree_diff_sha", [workspace.taskRoot], this.run.id);
    atomicJson(readyPath, { ...ready, diffSha256: diff, baselineHead: target, revalidatedAt: now() });
    this.setState("READY_FOR_REVIEW", "New baseline verified; a fresh independent Review and human acceptance are required");
    await script(item.sourceRoot, "orchestrate-task.sh", [item.taskId], this.run.id);
    atomicJson(revalidationPath, { previous: workspace, target, state: "REVIEWED", completedAt: now() });
  }
  async execute(): Promise<void> {
    let error: string | null = null;
    try {
      this.assertOwner();
      const item = this.item();
      switch (this.run.kind) {
        case "execute":
          if (this.prepare()) {
            await script(item.sourceRoot, "orchestrate-task.sh", [item.taskId], this.run.id);
            if (this.state() === "READY_TO_COMMIT" && this.item().request?.kind !== "abort") await this.integrate();
          }
          break;
        case "integrate": await this.integrate(); break;
        case "recover": await this.integrate(true); break;
        case "revalidate": await this.revalidate(); break;
        case "resume":
        case "resume-review":
        case "abort": {
          this.lease(item, item.sourceRoot);
          const scriptName = this.run.kind === "resume" ? "resume-task.sh" : this.run.kind === "resume-review" ? "resume-review.sh" : "abort-task.sh";
          await script(item.sourceRoot, scriptName, [item.taskId, item.request?.approval ?? ""], this.run.id);
          if (this.state() === "READY_TO_COMMIT" && this.item().request?.kind !== "abort") await this.integrate();
          break;
        }
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      const state = this.state();
      if (this.run.kind === "revalidate" || !["BLOCKED", "TEST_FAILED", "NEEDS_HUMAN", "BASELINE_REVIEW", "AWAITING_HUMAN"].includes(state)) this.setState(state === "INTEGRATING" ? "INTEGRATION_BLOCKED" : "BLOCKED", error);
    } finally {
      if (!["COMPLETED", "ABORTED", "BASELINE_REVIEW"].includes(this.state())) {
        try { this.seal(); } catch (failure) { error = `${error ?? ""} Unable to seal workspace: ${String(failure)}`; }
      }
      this.queue.storage.transaction(document => {
        invariant(document.active?.id === this.run.id, "Cannot finish an execution owned by another process");
        document.active.outcome = { state: this.state(), error };
        const agentRuns = join(this.evidence, "agent-runs.jsonl");
        if (existsSync(agentRuns)) {
          const failed = readFileSync(agentRuns, "utf8").trim().split("\n").filter(Boolean).slice(this.previousAgentRuns)
            .map(line => JSON.parse(line) as { role: string; exitCode: number }).find(result => result.exitCode !== 0);
          if (failed) document.fault = `OpenCode ${failed.role} exited with ${failed.exitCode}; inspect provider/environment evidence before clearing this shared execution fault`;
        }
      });
    }
  }
}
