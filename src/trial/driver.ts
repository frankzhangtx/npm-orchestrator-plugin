import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { directoryIdentity, verifyDirectoryIdentity, restoreMissingPackageDirectory, type DirectoryIdentity } from "../installer/directory-identity.js";
import { currentPackageSource, verifyPackageSource } from "../installer/package-source.js";
import { planProjectUpgrade, applyProjectUpgrade } from "../installer/upgrade.js";
import { captureInstallationRestorePoint, sealInstallationSwitch, restoreInstallation } from "../installer/restore.js";
import { TaskQueue } from "../queue/queue.js";
import { assertQueueIdle } from "../queue/lifecycle.js";
import { DELEGATION_ENV, type DelegationGrant } from "../queue/delegation.js";
import { MAX_TRIAL_CANDIDATES, type RunScope, validateRunScope } from "../queue/run-scope.js";
import { runBoundedModel, recoverModelProcesses } from "../queue/model-process.js";
import { serviceStatus, startService, stopService } from "../queue/service.js";
import { atomicJson, fileLock, git, invariant, readJson, sha256 } from "../queue/storage.js";
import { openTrialLedger, trialBudget, recordTrialIntent, finishTrialIntent, type TrialLedger } from "./ledger.js";

export interface TrialSpecification {
  version: 1; runId: string; repository: string; evidenceDirectory: string; batchDirectory: string;
  originalHead: string; originalBranch: string; originalPackageRoot: string; originalInstallationRoot: string;
  targetBranch: string; taskId: string; request: string; candidateSha256: string;
  allowedPaths: string[]; targetTests: DelegationGrant["targetTests"];
  policies: DelegationGrant["policies"]; runScope: RunScope;
}
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function hostLoad(root: string, packageRoot: string, deadline: number): { entryObserved: boolean; hookObserved: boolean } {
  const result = spawnSync("opencode", ["debug", "config"], {cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    timeout: Math.max(1, Math.min(60000, deadline - Date.now()))});
  invariant(result.status === 0 && !result.error, "Host configuration probe failed (raw config is not retained)");
  let config: {plugin?: string[]; skills?: {paths?: string[]}};
  try { config = JSON.parse(result.stdout); } catch { throw new Error("Host config probe did not return structured JSON"); }
  const pkg = readJson<{name: string; version: string}>(join(packageRoot, "package.json"));
  const entryObserved = Boolean(config.plugin?.some(p => p === `${pkg.name}@${pkg.version}` || p.includes(packageRoot)));
  const hookObserved = Boolean(config.skills?.paths?.some(p => p === join(packageRoot, "resources/third-party/superpowers-v6.2.0/skills/")));
  invariant(entryObserved && hookObserved, "Host did not load the expected package entry and bundled-skill hook");
  return {entryObserved, hookObserved};
}
function doctor(root: string, packageRoot: string, deadline: number): unknown {
  const result = spawnSync(process.execPath, [join(packageRoot, "dist/cli.js"), "doctor", root, "--json"], {
    cwd: root, encoding: "utf8", timeout: Math.max(1, Math.min(120000, deadline - Date.now())), maxBuffer: 8 * 1024 * 1024});
  invariant(result.status === 0 && !result.error, `Package doctor failed: ${result.stderr.slice(-2000)} ${result.stdout.slice(-12000)}`);
  const report = JSON.parse(result.stdout) as {ok?: boolean};
  invariant(report.ok, "Package doctor did not pass"); return report;
}

/** One frozen candidate, one native change invocation, always followed by restoration. */
export async function runTrial(spec: TrialSpecification): Promise<TrialLedger> {
  invariant(spec.version === 1 && spec.repository === realpathSync(spec.repository) &&
    spec.originalPackageRoot === resolve(spec.originalPackageRoot) && spec.originalInstallationRoot === resolve(spec.originalInstallationRoot) &&
    (spec.originalPackageRoot === spec.originalInstallationRoot || spec.originalPackageRoot.startsWith(spec.originalInstallationRoot + "/")) && spec.request.length > 0 && spec.request.length <= 16384,
    "Invalid trial specification");
  validateRunScope(spec.runScope);
  invariant(Date.parse(spec.runScope.cleanupExpiresAt) - Date.parse(spec.runScope.expiresAt) <= 2 * 60 * 60 * 1000,
    "Trial cleanup budget exceeds two hours");
  git(spec.repository, ["check-ref-format", `refs/heads/${spec.targetBranch}`]);
  invariant(spec.runId === spec.runScope.runId && spec.runScope.taskKeys.includes(`${spec.taskId}@1`) &&
    spec.targetBranch !== spec.originalBranch, "Trial scope or branch mismatch");
  const source = currentPackageSource();
  invariant(source.kind === "local-tgz" && source.sha256 === spec.candidateSha256, "Run the trial using its installed frozen candidate CLI");
  verifyPackageSource(source);
  const root = spec.repository, evidence = resolve(spec.evidenceDirectory), queue = new TaskQueue(root);
  invariant(evidence !== root && !evidence.startsWith(root + "/"), "Trial evidence must be outside the product checkout");
  mkdirSync(evidence, {recursive: true});
  const batchRoot = resolve(spec.batchDirectory);
  invariant(batchRoot !== root && !batchRoot.startsWith(root + "/"), "Batch audit must be outside the checkout");
  mkdirSync(batchRoot, {recursive: true});
  const batchRelease = fileLock(join(batchRoot, "batch.lock"));
  try {
    const batchFile = join(batchRoot, "batch.json");
    const binding = sha256(JSON.stringify({runId: spec.runId, root, originalHead: spec.originalHead, scope: spec.runScope}));
    const batch = existsSync(batchFile) ? readJson<{binding: string; candidates: Array<{sha256: string; taskId: string; evidence: string}>}>(batchFile) : {binding, candidates: []};
    invariant(batch.binding === binding, "Batch scope or original deadlines changed");
    const previous = batch.candidates.find(c => c.sha256 === source.sha256);
    if (previous) invariant(previous.taskId === spec.taskId && previous.evidence === evidence, "Candidate already registered with a different task or evidence directory");
    else {
      invariant(batch.candidates.length < MAX_TRIAL_CANDIDATES && !batch.candidates.some(c => c.taskId === spec.taskId), "Candidate or real-task budget exhausted");
      batch.candidates.push({sha256: source.sha256, taskId: spec.taskId, evidence}); atomicJson(batchFile, batch);
    }
  } finally { batchRelease(); }
  const release = fileLock(join(evidence, "driver.lock"));
  const ledgerFile = join(evidence, "trial.json"), restoration = join(evidence, "installation-restore"), ownership = join(evidence, "planner-ownership.json");
  let ledger: TrialLedger;
  try { ledger = openTrialLedger(evidence, spec, source.sha256, Date.parse(spec.runScope.expiresAt), Date.parse(spec.runScope.cleanupExpiresAt)); }
  catch (error) { release(); throw error; }
  const save = () => atomicJson(ledgerFile, ledger);
  const begin = (phase: string, cleanup = false) => { recordTrialIntent(ledger, phase, cleanup); save(); };
  const done = (phase: string) => { finishTrialIntent(ledger, phase); save(); };
  const historical = () => queue.storage.read().items.filter(item => !spec.runScope.taskKeys.includes(item.key));
  try {
    if (ledger.phase === "VERIFIED") return ledger;
    try {
      if (ledger.intent) {
        // A stopped driver never replays an unknown installation, commit or
        // native model invocation. Reconcile an already enqueued task, or clean up.
        if (ledger.intent === "TASK_FINISHED") {
          ledger.intent = null; ledger.phase = "PLANNED"; save();
        } else if (ledger.intent === "PLANNED" && existsSync(ownership)) {
          await recoverModelProcesses(ownership, 1000, ledger.cleanupDeadline);
          const item = queue.storage.read().items.find(i => i.key === `${spec.taskId}@1`);
          invariant(item?.authorization.delegation?.candidateSha256 === source.sha256, "Interrupted Planner did not enqueue its authorized task");
          ledger.taskKey = item.key; done("PLANNED");
        } else throw new Error(`Interrupted trial operation ${ledger.intent}; restoration required before another candidate`);
      }
      if (ledger.phase === "PREPARED") {
        trialBudget(ledger); assertQueueIdle(root);
        invariant(queue.storage.read().paused && git(root, ["status", "--porcelain"]) === "" &&
          git(root, ["rev-parse", "HEAD"]) === spec.originalHead && git(root, ["branch", "--show-current"]) === spec.originalBranch,
          "Trial baseline must be clean, paused and on its original branch");
        atomicJson(join(evidence, "historical-items.json"), historical());
        const originalPackageIdentity = directoryIdentity(spec.originalInstallationRoot);
        atomicJson(join(evidence, "original-package-identity.json"), originalPackageIdentity);
        cpSync(spec.originalInstallationRoot, join(evidence, "original-package"), {recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false});
        verifyDirectoryIdentity(join(evidence, "original-package"), originalPackageIdentity);
        begin("INSTALLED");
        const plan = planProjectUpgrade(root);
        invariant(plan.status === "upgrade" && plan.toVersion !== plan.fromVersion, "A candidate requires a new package version");
        const paths = [...new Set([...plan.desiredFiles.map(f => f.path), ...plan.removedFiles.map(f => f.path)])];
        atomicJson(join(evidence, "upgrade-paths.json"), paths);
        captureInstallationRestorePoint(root, restoration, paths);
        git(root, ["switch", "-c", spec.targetBranch]);
        applyProjectUpgrade(plan);
        atomicJson(join(evidence, "candidate-load.json"), hostLoad(root, source.packageRoot, ledger.executionDeadline));
        done("INSTALLED");
      }
      if (ledger.phase === "INSTALLED") {
        begin("UPGRADE_COMMITTED");
        const allowed = readJson<string[]>(join(evidence, "upgrade-paths.json"));
        const changed = [...new Set([git(root, ["diff", "--name-only"]), git(root, ["ls-files", "--others", "--exclude-standard"])].flatMap(s => s.split("\n").filter(Boolean)))];
        invariant(changed.length > 0 && changed.every(p => allowed.includes(p)), "Upgrade contains unregistered repository edits");
        git(root, ["add", "--all", "--", ...changed]);
        git(root, ["commit", "-m", `Upgrade orchestrator for local candidate ${source.version}`]);
        // The policy API requires a clean checkout. Commit the registered
        // upgrade first, then include the policy in that same upgrade commit.
        queue.setPolicy("isolatedWorktree", "autoCommit");
        git(root, ["add", "--", "automation/config.json"]);
        git(root, ["commit", "--amend", "--no-edit"]);
        sealInstallationSwitch(restoration);
        atomicJson(join(evidence, "candidate-doctor.json"), doctor(root, source.packageRoot, ledger.executionDeadline));
        ledger.upgradeHead = git(root, ["rev-parse", "HEAD"]);
        invariant(git(root, ["rev-parse", "HEAD^"]) === spec.originalHead, "Upgrade baseline parent changed");
        done("UPGRADE_COMMITTED");
      }
      if (ledger.phase === "UPGRADE_COMMITTED") {
        begin("AUTHORIZED"); queue.setRunScope(spec.runScope);
        const grant: DelegationGrant = {version: 1, id: `${spec.runId}-${spec.taskId}`, runId: spec.runId, sourceRoot: root,
          originalHead: spec.originalHead, planningHead: ledger.upgradeHead!, targetBranch: spec.targetBranch,
          upgradePaths: git(root, ["diff", "--name-only", spec.originalHead, ledger.upgradeHead!]).split("\n").filter(Boolean),
          requestSha256: sha256(spec.request), candidateSha256: source.sha256, configSha256: sha256(readFileSync(join(root, "automation/config.json"))),
          taskId: spec.taskId, allowedPaths: spec.allowedPaths, targetTests: spec.targetTests, workspaceStrategy: "isolatedWorktree", commitPolicy: "autoCommit",
          expiresAt: spec.runScope.expiresAt, cleanupExpiresAt: spec.runScope.cleanupExpiresAt, policies: spec.policies};
        queue.issueDelegation(grant); atomicJson(join(evidence, "delegation.json"), grant); done("AUTHORIZED");
      }
      if (ledger.phase === "AUTHORIZED") {
        begin("PLANNED");
        const grant = readJson<DelegationGrant>(join(evidence, "delegation.json"));
        const result = await runBoundedModel({cwd: root, agent: "scheduled-planner", nativeCommand: "change", prompt: spec.request,
          stepLimit: 256, deadline: ledger.executionDeadline, graceMs: 1000, ownershipRecord: ownership,
          environment: {[DELEGATION_ENV]: grant.id}, eventLog: join(evidence, "planner-events.jsonl"), stderrLog: join(evidence, "planner-stderr.log")});
        atomicJson(join(evidence, "planner-result.json"), result);
        const item = queue.storage.read().items.find(i => i.key === `${spec.taskId}@1`);
        invariant(item?.authorization.source === "delegatedApproval" && item.authorization.delegation?.id === grant.id,
          `Native change did not enqueue its authorized task (${result.reason})`);
        ledger.taskKey = item.key; done("PLANNED");
      }
      if (ledger.phase === "PLANNED") {
        begin("TASK_FINISHED"); startService(queue);
        for (;;) {
          trialBudget(ledger);
          const live = queue.storage.read();
          if (serviceStatus(queue).running) {
            const service = readJson<{packageIdentity?: {artifactSha256?: string}}>(join(queue.storage.runtime, "service.json"));
            invariant(service.packageIdentity?.artifactSha256 === source.sha256, "Scheduler loaded a different candidate");
            atomicJson(join(evidence, "scheduler-source.json"), service);
          }
          if (live.active) invariant(live.active.packageIdentity?.artifactSha256 === source.sha256, "Worker reservation loaded a different candidate");
          const item = queue.item(ledger.taskKey!);
          if (!queue.storage.read().active && ["COMPLETED", "ABORTED", "BLOCKED", "TEST_FAILED", "NEEDS_HUMAN", "INTEGRATION_BLOCKED", "AWAITING_HUMAN", "WAITING_PRECONDITION"].includes(item.state)) {
            ledger.result = item.state; atomicJson(join(evidence, "task-result.json"), queue.details(item.key)); break;
          }
          await wait(1000);
        }
        invariant(ledger.result === "COMPLETED", `Trial task ended in ${ledger.result}`); done("TASK_FINISHED");
      }
    } catch (error) {
      ledger.error = String(error); ledger.events.push({phase: ledger.intent ?? ledger.phase, at: Date.now(), event: "FAILED"});
      ledger.intent = null; save();
    }

    if (!existsSync(join(restoration, "snapshot.json"))) {
      ledger.phase = "PRECONDITION_FAILED"; save(); return ledger;
    }
    // Cleanup uses its original separate deadline even if execution has expired.
    begin("RESTORED", true);
    queue.control("pause");
    atomicJson(join(evidence, "cleanup-authorization.json"), {source: "delegatedCleanup", specificationSha256: ledger.specificationSha256,
      taskKey: `${spec.taskId}@1`, cleanupDeadline: ledger.cleanupDeadline, requestedAt: new Date().toISOString()});
    if (existsSync(ownership)) await recoverModelProcesses(ownership, 1000, ledger.cleanupDeadline);
    for (;;) {
      trialBudget(ledger, true);
      const document = queue.storage.read(), item = document.items.find(i => i.key === `${spec.taskId}@1`);
      if (document.active) {
        invariant(document.active.key === item?.key, "Unrelated task owns the queue; trial cannot stop it");
        if (!item.request) queue.request(item.key, "abort", queue.config().approvalPhrases.abort);
        await wait(1000); continue;
      }
      if (item && !["COMPLETED", "ABORTED", "CANCELLED"].includes(item.state)) {
        if (!item.taskRoot) { queue.control("cancel", item.key); continue; }
        if (!item.request) queue.request(item.key, "abort", queue.config().approvalPhrases.abort);
        startService(queue); await wait(1000); continue;
      }
      break;
    }
    stopService(queue);
    while (serviceStatus(queue).running) { trialBudget(ledger, true); await wait(250); }
    if (existsSync(join(restoration, "snapshot.json"))) {
      // Failed installs may have rolled themselves back before publishing a
      // switched manifest. With no model launched, preserve that exact state.
      if (!existsSync(join(restoration, "transaction.json"))) {
        invariant(!existsSync(ownership), "Unsealed installation cannot be restored after model execution");
        sealInstallationSwitch(restoration);
      }
      restoreInstallation(restoration);
    }
    if (git(root, ["branch", "--show-current"]) !== spec.originalBranch) {
      // Restoration verified these bytes against the captured baseline. Stage
      // only restored upgrade paths so Git can switch to that same baseline.
      const allowed = readJson<string[]>(join(evidence, "upgrade-paths.json"));
      const changed = git(root, ["diff", "--name-only"]).split("\n").filter(Boolean);
      invariant(changed.every(p => allowed.includes(p)), "Unregistered edits prevent restoring the original branch");
      if (changed.length) git(root, ["add", "--all", "--", ...changed]);
      git(root, ["switch", spec.originalBranch]);
    }
    invariant(git(root, ["rev-parse", "HEAD"]) === spec.originalHead && git(root, ["status", "--porcelain"]) === "", "Original checkout was not restored exactly");
    queue.storage.transaction(d => { d.paused = true; d.strategy = queue.config().workspaceStrategy; });
    done("RESTORED");
    begin("VERIFIED", true);
    restoreMissingPackageDirectory(join(evidence, "original-package"), spec.originalInstallationRoot,
      readJson<DirectoryIdentity>(join(evidence, "original-package-identity.json")), spec.runId);
    atomicJson(join(evidence, "restored-doctor.json"), doctor(root, spec.originalPackageRoot, ledger.cleanupDeadline));
    atomicJson(join(evidence, "restored-load.json"), hostLoad(root, spec.originalPackageRoot, ledger.cleanupDeadline));
    const queueBeforeProbe = sha256(readFileSync(queue.storage.path));
    const compatibility = spawnSync(process.execPath, [join(spec.originalPackageRoot, "dist/cli.js"), "queue", "status", root], {
      cwd: root, encoding: "utf8", timeout: Math.max(1, Math.min(60000, ledger.cleanupDeadline - Date.now())), maxBuffer: 32 * 1024 * 1024});
    invariant(compatibility.status === 0 && !compatibility.error, "Original CLI cannot read retained queue metadata");
    const originalStatus = JSON.parse(compatibility.stdout) as {paused?: boolean; active?: unknown; service?: {running?: boolean}; items?: Array<{key: string; state: string}>};
    invariant(originalStatus.paused === true && originalStatus.active === null && originalStatus.service?.running === false &&
      Array.isArray(originalStatus.items) && sha256(readFileSync(queue.storage.path)) === queueBeforeProbe,
      "Original CLI queue inspection changed metadata or observed an active executor");
    atomicJson(join(evidence, "restored-queue-compatibility.json"), {readable: true, queueSha256: queueBeforeProbe,
      serviceMustRemainStopped: true, items: originalStatus.items.map(item => ({key: item.key, state: item.state}))});
    if (existsSync(join(restoration, "transaction.json"))) restoreInstallation(restoration);
    invariant(sha256(JSON.stringify(historical())) === sha256(JSON.stringify(readJson(join(evidence, "historical-items.json")))), "Historical queue items changed during the trial");
    invariant(queue.storage.read().paused && !queue.storage.read().active && !serviceStatus(queue).running, "Restored queue must remain paused and stopped");
    done("VERIFIED"); return ledger;
  } catch (error) {
    ledger.error = `${ledger.error ? ledger.error + "; " : ""}${String(error)}`;
    ledger.phase = "RESTORATION_BLOCKED"; save(); throw error;
  } finally { release(); }
}
