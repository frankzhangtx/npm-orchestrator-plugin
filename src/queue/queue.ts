import { assertRestorationScope, pendingRestoration as pendingRestorationForScope } from "../trial/restoration.js";
import { currentPackageSource, verifyPackageSource, packageRuntimeIdentity } from "../installer/package-source.js";
import { validateDelegationGrant, delegationRecord, bindDelegationSession, checkDelegatedDraft, sealDelegatedDraft, consumeDelegation,
  type DelegationGrant, type DelegationRecord, type DelegationContext, type DelegationProof } from "./delegation.js";
import type { ModelLedger } from "./model-ledger.js";
import { MAX_TRIAL_CANDIDATES, scopeAllows, validateRunScope, type RunScope } from "./run-scope.js";
import { evaluateReadiness, assertReadyForIntake, readinessMessage, type Readiness, type ReadinessScan } from "./preconditions.js";
import { runtimePresentation } from "./progress.js";
import { initialSupervision, supervisionEvidence, type Supervision, type ExecutionPolicy } from "./supervision.js";
import { ownedTree, processSnapshot } from "./process-ownership.js";
import type { ApprovalProof } from "./approvals.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomicJson, fileLock, git, gitBuffer, invariant, isAlive, processGroupAlive, processIdentity, readJson,
  sha256, QueueStorage, type ProcessIdentity,
} from "./storage.js";
import { queuePolicy, type QueuePolicy } from "../config/queue-policy.js";

export type WorkspaceStrategy = "inPlaceExclusive" | "isolatedWorktree";
export type CommitPolicy = "humanApproval" | "autoCommit";
export type JobKind = "execute" | "integrate" | "revalidate" | "resume" | "resume-review" | "abort" | "recover" | "retry-baseline";
export interface QueueConfiguration {
  androidProject?: { capabilities?: unknown };
  schemaVersion: number;
  enabled: boolean;
  mode: string;
  workspaceStrategy: WorkspaceStrategy;
  commitPolicy?: CommitPolicy;
  pushAfterAcceptance: false;
  unitTestsEnabled: boolean;
  autoCleanupWorktrees: boolean;
  worktreeBase: string;
  queue?: QueuePolicy["queue"];
  approvalPhrases: Record<string, string>;
  protectedPaths: string[];
  gradleVerification: { fullUnitTestTasks: string[]; focusedTestTasks: string[]; assembleTasks: string[]; deviceTestTasks?: string[] };
}
export interface Draft {
  verificationPreview?: unknown;
  verificationConfigSha256?: string;
  verificationFallbackReason?: string;
  planningInputsSha256?: string;
  proposalApproval?: ApprovalProof;
  key: string;
  taskId: string;
  version: number;
  contract: Record<string, unknown>;
  contractText: string;
  plan: string;
  contractSha256: string;
  planSha256: string;
  planningHead: string;
  targetBranch: string;
  sourceRoot: string;
  workspaceStrategy: WorkspaceStrategy;
  commitPolicy: CommitPolicy;
  notBefore: string | null;
  dependsOn: string[];
  priority: number;
  createdAt: string;
  digest: string;
}
export interface QueueItem extends Draft {
  modelLedger?: ModelLedger;
  precondition?: Readiness;
  approvedWorkspaceStrategy: WorkspaceStrategy;
  queuePriority: number;
  sequence: number;
  approvedAt: string;
  authorization: { source: "contractApproval" | "delegatedApproval"; delegation?: DelegationProof; digest: string; commitPolicy: CommitPolicy; pushAfterAcceptance: false; revoked: boolean; proof?: ApprovalProof };
  state: string;
  waitingReason: string | null;
  runId: string | null;
  taskRoot: string | null;
  request: { kind: JobKind; approval: string | null; candidate: string | null; proof?: ApprovalProof; verificationRecovery?: { phase: string; ledgerSha256: string; targetHead: string; candidateId: string } } | null;
  sealedDiff: string | null;
  sealedRunId: string | null;
  candidateId: string | null;
  completedCommit: string | null;
  baselineRecovery?: { sha256: string; nextRunAt: number | null; deadline: number; failure: Record<string, unknown> | null; waitingReason: string | null };
  stageRecovery?: Record<string, { sha256: string }>;
}
export interface QueueRun {
  packageIdentity?: ReturnType<typeof packageRuntimeIdentity>;
  id: string;
  key: string;
  kind: JobKind;
  createdAt: string;
  launcher: ProcessIdentity;
  worker: ProcessIdentity | null;
  outcome: { state: string; error: string | null } | null;
  supervision?: Supervision;
}
export function publicRun(run: QueueRun | null): unknown {
  return run ? { ...run, ...(run.supervision ? { supervision: supervisionEvidence(run.supervision) } : {}) } : null;
}
export interface QueueNotification {
  id: string; key: string; state: string; at: string; message: string;
  sealedDiff: string | null; commit: string | null; pushed: false; acknowledged: boolean;
}
export interface QueueDocument {
  delegations?: DelegationRecord[];
  runScope?: RunScope;
  schemaVersion: 1;
  sequence: number;
  paused: boolean;
  fault: string | null;
  strategy: WorkspaceStrategy | null;
  drafts: Draft[];
  items: QueueItem[];
  active: QueueRun | null;
  runs: QueueRun[];
  notifications: QueueNotification[];
}
export interface DraftInput {
  verificationFallbackReason?: string;
  contract: Record<string, unknown>; plan: string; planningHead: string; targetBranch: string;
  workspaceStrategy?: WorkspaceStrategy; commitPolicy?: CommitPolicy;
  notBefore?: string; dependsOn?: string[]; priority?: number;
}

export interface PlanningSnapshot {
  sourceRoot: string;
  targetBranch: string;
  planningHead: string;
}
export interface SnapshotFilePage {
  planningHead: string;
  prefix: string;
  query: string;
  files: string[];
  nextCursor: string | null;
}
export interface SnapshotReadChunk {
  planningHead: string;
  path: string;
  content: string;
  nextCursor: string | null;
}

interface SnapshotListCursor {
  version: 1; kind: "list"; planningHead: string; prefix: string; query: string; offset: number;
}
interface SnapshotReadCursor {
  version: 1; kind: "read"; planningHead: string; path: string; offset: number;
}

const TERMINAL = new Set(["COMPLETED", "CANCELLED", "ABORTED", "SUPERSEDED"]);
const STOPPED = new Set(["AWAITING_HUMAN", "READY_TO_COMMIT", "BLOCKED", "TEST_FAILED", "NEEDS_HUMAN", "INTEGRATION_BLOCKED", "BASELINE_REVIEW"]);
const SNAPSHOT_RESPONSE_MAX_BYTES = 16 * 1024;
const SNAPSHOT_LIST_DEFAULT_LIMIT = 50;
const SNAPSHOT_LIST_MAX_LIMIT = 200;
const SNAPSHOT_READ_TARGET_BYTES = 8 * 1024;
export const TASK_ID = /^TASK-[A-Z0-9-]+$/;
export function now(): string { return new Date().toISOString(); }

function snapshotCursor(value: SnapshotListCursor | SnapshotReadCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseSnapshotCursor(value: string): unknown {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid snapshot cursor"); }
}

export function matchesPath(pattern: string, path: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    .replace(/\u0001\//g, "(?:.*/)?").replace(/\u0001/g, ".*");
  return new RegExp(`^${expression}${pattern.endsWith("/") ? ".*" : ""}$`).test(path);
}

export function validateContract(contract: Record<string, unknown>, config: QueueConfiguration): void {
  if ([4, 5, 6, 7, 8].includes(Number(contract.schemaVersion))) {
    const validator = createRequire(import.meta.url)("../../templates/automation/verification/contract.cjs") as {
      validateContract: (contract: Record<string, unknown>, config: QueueConfiguration) => void;
    };
    validator.validateContract(contract, config);
    return;
  }
  invariant(TASK_ID.test(String(contract.id)), "Invalid task ID");
  invariant([1, 2, 3].includes(Number(contract.schemaVersion)), "Unsupported contract schema");
  invariant(contract.designApproved === true && contract.ambiguityPolicy === "BLOCKED", "An approved, bounded design is required");
  invariant(typeof contract.title === "string" && contract.title.length > 0, "Contract title is required");
  invariant(contract.planPath === `docs/plans/${contract.id}.md`, "Plan must use the task-specific docs/plans path");
  invariant(Number.isInteger(contract.maxChangedFiles) && Number(contract.maxChangedFiles) >= 1 && Number(contract.maxChangedFiles) <= 12, "Invalid file limit");
  invariant(Number.isInteger(contract.maxFixLoops) && Number(contract.maxFixLoops) >= 0 && Number(contract.maxFixLoops) <= 1, "Invalid fix-loop limit");
  for (const key of ["allowedPaths", "forbiddenPaths", "acceptanceCriteria", "nonGoals"]) {
    invariant(Array.isArray(contract[key]) && contract[key].length > 0 && contract[key].every(value => typeof value === "string" && value.length > 0), `Invalid ${key}`);
  }
  const allowed = contract.allowedPaths as string[];
  const forbidden = contract.forbiddenPaths as string[];
  for (const path of [...allowed, ...forbidden]) invariant(/^[A-Za-z0-9._/?*-]+$/.test(path) && !path.startsWith("/") && !path.includes(".."), "Unsafe contract path");
  for (const path of config.protectedPaths) {
    invariant(!allowed.some(pattern => matchesPath(pattern, path)), `Allowed paths overlap protected path: ${path}`);
    invariant(forbidden.some(pattern => matchesPath(pattern, path)), `Forbidden paths must cover: ${path}`);
  }
  const skills = contract.schemaVersion === 1 ? contract.allowedSuperpowers : contract.allowedWorkflowSkills;
  const expected = ["test-driven-development", "systematic-debugging", "verification-before-completion"].map(skill => contract.schemaVersion === 1 ? skill : `android-orchestrator-${skill}`);
  invariant(JSON.stringify(skills) === JSON.stringify(expected), "Invalid workflow skill allowlist");
  invariant(Array.isArray(contract.targetTests) && contract.targetTests.length > 0, "Focused tests are required");
  for (const target of contract.targetTests) {
    invariant(target && typeof target === "object" && typeof target.gradleTask === "string" && config.gradleVerification.focusedTestTasks.includes(target.gradleTask), "Focused test task is not configured");
    invariant(typeof target.filter === "string" && /^[A-Za-z0-9_.#$*-]+$/.test(target.filter), "Unsafe test filter");
  }
  const targetKeys = (contract.targetTests as Array<Record<string, unknown>>).map(target => `${target.gradleTask}\u0000${target.filter}`);
  invariant(new Set(targetKeys).size === targetKeys.length, "Focused test targets must be unique");
  invariant(typeof contract.deviceTestsRequired === "boolean", "Missing device-test policy");
  invariant(!contract.deviceTestsRequired || (config.gradleVerification.deviceTestTasks?.length ?? 0) > 0,
    "Device tests are required by this contract but no device test tasks are available");
  invariant(contract.testPolicy === "required" || (contract.testPolicy === "not-required" && typeof contract.testPolicyReason === "string" && contract.testPolicyReason.length >= 20), "Missing test policy");
  if (Number(contract.schemaVersion) === 3) {
    const verification = contract.verification;
    invariant(verification && typeof verification === "object" && !Array.isArray(verification), "Schema V3 requires structured verification");
    const value = verification as Record<string, unknown>;
    invariant(Object.keys(value).sort().join(",") === "cases,maxPreparationFixes,version", "Invalid verification fields");
    invariant(value.version === 1 && Number.isInteger(value.maxPreparationFixes) && Number(value.maxPreparationFixes) >= 0 && Number(value.maxPreparationFixes) <= 1, "Invalid verification policy");
    invariant(Array.isArray(value.cases) && value.cases.length > 0, "Verification cases are required");
    const caseIds = new Set<string>();
    const testIds = new Set<string>();
    let changedBehavior = 0;
    for (const rawCase of value.cases) {
      invariant(rawCase && typeof rawCase === "object" && !Array.isArray(rawCase), "Invalid verification case");
      const testCase = rawCase as Record<string, unknown>;
      const allowedFields = new Set(["id", "criterion", "intent", "before", "after", "source", "test", "expectedFailure"]);
      invariant(Object.keys(testCase).every(key => allowedFields.has(key)), "Invalid verification case fields");
      invariant(typeof testCase.id === "string" && /^[A-Z][A-Z0-9-]{2,63}$/.test(testCase.id) && !caseIds.has(testCase.id), "Verification case IDs must be unique and stable");
      caseIds.add(testCase.id);
      invariant(Number.isInteger(testCase.criterion) && Number(testCase.criterion) >= 1 && Number(testCase.criterion) <= (contract.acceptanceCriteria as unknown[]).length, "Verification criterion reference is invalid");
      invariant(testCase.after === "pass", "Every verification case must pass after implementation");
      const intent = testCase.intent;
      const before = testCase.before;
      const source = testCase.source;
      invariant(["preserve", "change", "observe"].includes(String(intent)), "Invalid verification intent");
      invariant(["pass", "fail", "observe"].includes(String(before)), "Invalid pre-change expectation");
      const test = testCase.test;
      invariant(test && typeof test === "object" && !Array.isArray(test), "Verification test identity is required");
      const testIdentity = test as Record<string, unknown>;
      invariant(Object.keys(testIdentity).sort().join(",") === "className,name,target", "Invalid verification test fields");
      invariant(Number.isInteger(testIdentity.target) && Number(testIdentity.target) >= 0 && Number(testIdentity.target) < (contract.targetTests as unknown[]).length, "Verification target index is invalid");
      invariant(typeof testIdentity.className === "string" && testIdentity.className.length > 0 && typeof testIdentity.name === "string" && testIdentity.name.length > 0, "Verification test identity is incomplete");
      const testKey = `${testIdentity.target}\u0000${testIdentity.className}\u0000${testIdentity.name}`;
      invariant(!testIds.has(testKey), "Verification test identities must be unique");
      testIds.add(testKey);
      const failure = testCase.expectedFailure;
      if (intent === "preserve") {
        invariant(before === "pass" && ["existingTest", "baselineCapture", "measuredFact"].includes(String(source)) && failure === undefined, "Preserved behavior must pass on a measured baseline");
      } else if (intent === "change") {
        changedBehavior += 1;
        invariant(before === "fail" && source === "userRequirement", "Changed behavior must fail before implementation and originate in the approved requirement");
        invariant(failure && typeof failure === "object" && !Array.isArray(failure), "Changed behavior requires an expected failure");
      } else {
        invariant(before === "observe" && ["userRequirement", "existingTest", "baselineCapture", "measuredFact"].includes(String(source)), "Observed behavior must declare an admissible source");
      }
      if (failure !== undefined) {
        const expected = failure as Record<string, unknown>;
        invariant(Object.keys(expected).every(key => ["type", "messageIncludes", "origin"].includes(key)), "Invalid expected failure fields");
        invariant(typeof expected.type === "string" && expected.type.length > 0 && typeof expected.origin === "string" && expected.origin.length >= 12, "Expected failure type and origin are required");
        invariant(expected.messageIncludes === undefined || (typeof expected.messageIncludes === "string" && expected.messageIncludes.length >= 3), "Expected failure message fragment is invalid");
      }
    }
    invariant(changedBehavior > 0, "At least one changed behavior must provide genuine RED");
  }
  invariant(!/replace with|TASK-EXAMPLE|\btodo\b|\btbd\b|placeholder/i.test(JSON.stringify(contract)), "Contract contains placeholders");
}

function draftDigest(draft: Omit<Draft, "digest"> | Draft): string {
  const { digest: _digest, ...sealed } = draft as Draft;
  return sha256(JSON.stringify(sealed));
}

export function draftFromItem(item: QueueItem): Draft {
  const { sequence: _sequence, approvedAt: _approvedAt, authorization: _authorization,
    state: _state, waitingReason: _waitingReason, runId: _runId, taskRoot: _taskRoot,
    request: _request, sealedDiff: _sealedDiff, sealedRunId: _sealedRunId, candidateId: _candidateId, completedCommit: _commit,
    modelLedger: _modelLedger, baselineRecovery: _baselineRecovery, stageRecovery: _stageRecovery, precondition: _precondition,
    approvedWorkspaceStrategy, queuePriority: _priority, ...draft } = item;
  return { ...draft, workspaceStrategy: approvedWorkspaceStrategy };
}

export interface ContinuityPolicy {
  version: 1;
  isolatedAutoIntegration: boolean;
  planningRefresh: "reject" | "completedQueueTasks";
  planningInputs: string[];
}

export function continuityPolicy(contract: Record<string, unknown>): ContinuityPolicy | undefined {
  return contract.schemaVersion === 8 ? contract.continuity as ContinuityPolicy : undefined;
}

export function isolatedAutoIntegrationAuthorized(item: Pick<Draft, "contract" | "workspaceStrategy" | "commitPolicy">): boolean {
  return item.workspaceStrategy === "isolatedWorktree" && item.commitPolicy === "autoCommit" &&
    continuityPolicy(item.contract)?.isolatedAutoIntegration === true;
}

export function planningInputsDigest(root: string, head: string, patterns: string[]): string {
  const entries = gitBuffer(root, ["ls-tree", "-r", "-z", head]).toString("utf8").split("\0").filter(Boolean)
    .filter(entry => patterns.some(pattern => matchesPath(pattern, entry.slice(entry.indexOf("\t") + 1))));
  invariant(entries.every(entry => /^100(?:644|755) blob /.test(entry)), "Planning inputs must be regular tracked files, not symlinks or submodules");
  // Paths, modes, object IDs and the selectors themselves bind additions,
  // deletions and previously absent files without reading the Coder worktree.
  return sha256(JSON.stringify({ version: 1, patterns, entries }));
}

export function assertAuthorized(item: QueueItem): void {
  invariant(!item.authorization.revoked, "Contract authorization was revoked");
  invariant(item.digest === draftDigest(draftFromItem(item)) && item.digest === item.authorization.digest, "Approved contract or scheduling policy changed; fresh approval required");
  invariant(item.authorization.commitPolicy === item.commitPolicy && item.authorization.pushAfterAcceptance === false, "Invalid sealed commit or no-push authorization");
  invariant(sha256(item.contractText) === item.contractSha256 && sha256(item.plan) === item.planSha256, "Approved artifacts changed");
  invariant(JSON.stringify(JSON.parse(item.contractText)) === JSON.stringify(item.contract), "Contract text and metadata disagree");
  invariant(item.workspaceStrategy !== "isolatedWorktree" || item.commitPolicy === "humanApproval" ||
    (item.approvedWorkspaceStrategy === "isolatedWorktree" && isolatedAutoIntegrationAuthorized(item)),
    "isolatedWorktree + autoCommit is unsupported without explicit V8 approval");
}

export class TaskQueue {
  readonly storage: QueueStorage<QueueDocument>;
  constructor(directory: string) {
    this.storage = new QueueStorage(directory, () => ({ schemaVersion: 1, sequence: 0, paused: false, fault: null, strategy: null, drafts: [], items: [], active: null, runs: [], notifications: [] }));
    const document = this.storage.read();
    invariant(document.schemaVersion === 1, "Unsupported queue document; use the matching plugin version");
    for (const item of document.items) {
      if (item.state !== "WAITING_PRECONDITION") continue;
      const result = item.precondition;
      invariant(!item.taskRoot && result?.codingStarted === false && result.workspaceCreated === false && result?.version === 1 && result.authorizationDigest === item.digest && result.planningHead === item.planningHead &&
        ["WAITING_PRECONDITION", "WAITING_PREDECESSOR", "REPLAN_REQUIRED"].includes(result.state) &&
        Array.isArray(result.paths) && result.paths.every(row => typeof row.path === "string" && typeof row.status === "string") &&
        typeof result.nextAction === "string" && typeof result.reasonCode === "string" && typeof result.checkedAt === "string" &&
        /^[a-f0-9]{64}$/.test(result.fingerprint), "Invalid startup waiting record; retain evidence and recover explicitly");
      const { checkedAt: _checkedAt, fingerprint, ...condition } = result;
      invariant(sha256(JSON.stringify(condition)) === fingerprint, "Invalid startup waiting fingerprint; retain evidence and recover explicitly");
    }
  }
  config(): QueueConfiguration {
    const config = readJson<QueueConfiguration>(join(this.storage.root, "automation/config.json"));
    invariant(config.schemaVersion === 6, "Queue execution requires an upgraded schema V6 installation");
    invariant(config.enabled && config.mode === "orchestrated", "Automation is not enabled in orchestrated mode");
    invariant(config.pushAfterAcceptance === false, "Remote push is forbidden");
    invariant(["inPlaceExclusive", "isolatedWorktree"].includes(config.workspaceStrategy), "Unsupported workspace strategy");
    invariant(config.commitPolicy === undefined || ["humanApproval", "autoCommit"].includes(config.commitPolicy), "Unsupported commit policy");
    queuePolicy(config);
    return config;
  }
  snapshot(targetBranch?: string): PlanningSnapshot {
    const document = this.storage.read();
    const occupied = document.items.find(item => item.taskRoot && !TERMINAL.has(item.state));
    const branch = targetBranch ?? occupied?.targetBranch ?? git(this.storage.root, ["symbolic-ref", "--short", "HEAD"]);
    git(this.storage.root, ["check-ref-format", `refs/heads/${branch}`]);
    const head = git(this.storage.root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    assertReadyForIntake(evaluateReadiness(this, head, branch, undefined, document), true);
    return { sourceRoot: this.storage.root, targetBranch: branch, planningHead: head };
  }
  private sensitive(path: string): boolean {
    return /(^|\/)(\.env(?:\..*)?|local\.properties)$|\.(jks|keystore)$/.test(path);
  }
  readSnapshot(head: string, path: string): string {
    invariant(/^[a-f0-9]{40,64}$/.test(head), "A fixed planning commit is required");
    invariant(!path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0") && !this.sensitive(path), "Snapshot path is not allowed");
    const type = git(this.storage.root, ["cat-file", "-t", `${head}:${path}`]);
    invariant(type === "blob", "Snapshot path must be a file");
    const size = Number(git(this.storage.root, ["cat-file", "-s", `${head}:${path}`]));
    invariant(size <= 1024 * 1024, "Snapshot file exceeds 1 MiB");
    return git(this.storage.root, ["show", `${head}:${path}`]);
  }
  listSnapshot(head: string, prefix = "", query = "", cursor?: string, limit = SNAPSHOT_LIST_DEFAULT_LIMIT): SnapshotFilePage {
    this.validateSnapshotHead(head);
    this.validateSnapshotPath(prefix, true);
    invariant(!query.includes("\0") && Buffer.byteLength(query, "utf8") <= 256, "Snapshot query is invalid or too long");
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= SNAPSHOT_LIST_MAX_LIMIT, `Snapshot list limit must be 1-${SNAPSHOT_LIST_MAX_LIMIT}`);
    let offset = 0;
    if (cursor) {
      const parsed = parseSnapshotCursor(cursor) as Partial<SnapshotListCursor>;
      invariant(parsed.version === 1 && parsed.kind === "list" && parsed.planningHead === head && parsed.prefix === prefix && parsed.query === query && Number.isInteger(parsed.offset) && Number(parsed.offset) >= 0, "Snapshot list cursor does not match this query");
      offset = Number(parsed.offset);
    }
    const args = ["ls-tree", "-r", "-z", "--name-only", head];
    if (prefix) args.push("--", prefix);
    const lowerQuery = query.toLowerCase();
    const files = gitBuffer(this.storage.root, args).toString("utf8").split("\0")
      .filter(path => path.length > 0 && !this.sensitive(path) && (!lowerQuery || path.toLowerCase().includes(lowerQuery)));
    invariant(offset <= files.length, "Snapshot list cursor is past the end of the result");
    const pageFiles: string[] = [];
    while (offset + pageFiles.length < files.length && pageFiles.length < limit) {
      const path = files[offset + pageFiles.length]!;
      const candidate = [...pageFiles, path];
      const nextOffset = offset + candidate.length;
      const candidatePage: SnapshotFilePage = {
        planningHead: head, prefix, query, files: candidate,
        nextCursor: nextOffset < files.length ? snapshotCursor({ version: 1, kind: "list", planningHead: head, prefix, query, offset: nextOffset }) : null,
      };
      if (Buffer.byteLength(JSON.stringify(candidatePage), "utf8") > SNAPSHOT_RESPONSE_MAX_BYTES) break;
      pageFiles.push(path);
    }
    invariant(offset === files.length || pageFiles.length > 0, "A snapshot path exceeds the response byte limit");
    const nextOffset = offset + pageFiles.length;
    return {
      planningHead: head, prefix, query, files: pageFiles,
      nextCursor: nextOffset < files.length ? snapshotCursor({ version: 1, kind: "list", planningHead: head, prefix, query, offset: nextOffset }) : null,
    };
  }
  readSnapshotChunk(head: string, path: string, cursor?: string): SnapshotReadChunk {
    this.validateSnapshotHead(head);
    this.validateSnapshotPath(path, false);
    invariant(!this.sensitive(path), "Snapshot path is not allowed");
    const type = git(this.storage.root, ["cat-file", "-t", `${head}:${path}`]);
    invariant(type === "blob", "Snapshot path must be a file");
    const content = gitBuffer(this.storage.root, ["show", `${head}:${path}`]);
    invariant(content.length <= 1024 * 1024, "Snapshot file exceeds 1 MiB");
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    let offset = 0;
    if (cursor) {
      const parsed = parseSnapshotCursor(cursor) as Partial<SnapshotReadCursor>;
      invariant(parsed.version === 1 && parsed.kind === "read" && parsed.planningHead === head && parsed.path === path && Number.isInteger(parsed.offset) && Number(parsed.offset) >= 0, "Snapshot read cursor does not match this file");
      offset = Number(parsed.offset);
    }
    invariant(offset <= content.length && (offset === content.length || offset === 0 || (content[offset]! & 0xc0) !== 0x80), "Snapshot read cursor is not at a UTF-8 boundary");
    let end = Math.min(content.length, offset + SNAPSHOT_READ_TARGET_BYTES);
    while (end < content.length && (content[end]! & 0xc0) === 0x80) end -= 1;
    let chunk = content.subarray(offset, end).toString("utf8");
    while (end > offset) {
      const candidate: SnapshotReadChunk = {
        planningHead: head, path, content: chunk,
        nextCursor: end < content.length ? snapshotCursor({ version: 1, kind: "read", planningHead: head, path, offset: end }) : null,
      };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= SNAPSHOT_RESPONSE_MAX_BYTES) return candidate;
      end -= 1;
      while (end > offset && (content[end]! & 0xc0) === 0x80) end -= 1;
      chunk = content.subarray(offset, end).toString("utf8");
    }
    invariant(offset === content.length, "Snapshot content exceeds the response byte limit");
    return { planningHead: head, path, content: "", nextCursor: null };
  }
  private validateSnapshotHead(head: string): void {
    invariant(/^[a-f0-9]{40,64}$/.test(head), "A fixed planning commit is required");
    git(this.storage.root, ["cat-file", "-e", `${head}^{commit}`]);
  }
  private validateSnapshotPath(path: string, allowEmpty: boolean): void {
    invariant((allowEmpty || path.length > 0) && !path.includes("\0") && !path.startsWith("/") && Buffer.byteLength(path, "utf8") <= 4096, "Snapshot path is invalid or too long");
    invariant(!path.split(/[\\/]/).some(part => part === ".." || part === ".git"), "Snapshot path is not allowed");
  }
  verificationPreview(contract: Record<string, unknown>, planningHead?: string): unknown {
    if (!(contract.verification as {scope?: unknown} | undefined)?.scope) return null;
    const project = createRequire(import.meta.url)("../../templates/automation/verification/project.cjs");
    const config = planningHead ? this.planningConfiguration(planningHead).config : this.config();
    return project.selectVerification(config, contract, this.storage.root, [], true);
  }
  private planningConfiguration(planningHead: string): { config: QueueConfiguration; sha256: string } {
    this.validateSnapshotHead(planningHead);
    const bytes = gitBuffer(this.storage.root, ["show", `${planningHead}:automation/config.json`]);
    const config = JSON.parse(bytes.toString("utf8")) as QueueConfiguration;
    invariant(config.schemaVersion === 6 && config.enabled && config.mode === "orchestrated" && config.pushAfterAcceptance === false,
      "Planning snapshot requires an enabled schema V6 installation");
    return { config, sha256: sha256(bytes) };
  }
  preview(input: Pick<DraftInput, "contract" | "planningHead">): { planningHead: string; configSha256: string; verificationPreview: unknown } {
    const scope = (input.contract.verification as {scope?: {version?: number}} | undefined)?.scope;
    invariant(scope?.version === 3, "Read-only preview requires an explicit bounded verification.scope version 3");
    const snapshot = this.planningConfiguration(input.planningHead);
    validateContract(input.contract, snapshot.config);
    return { planningHead: input.planningHead, configSha256: snapshot.sha256,
      verificationPreview: this.verificationPreview(input.contract, input.planningHead) };
  }
  checkedDelegation(document: QueueDocument, id: string): DelegationRecord {
    const record = delegationRecord(document, id), grant = record.grant;
    invariant(grant.sourceRoot === this.storage.root, "Delegation repository changed");
    const source = currentPackageSource();
    invariant(source.kind === "local-tgz" && source.sha256 === grant.candidateSha256, "Delegation candidate package changed");
    verifyPackageSource(source);
    invariant(sha256(readFileSync(join(this.storage.root, "automation/config.json"))) === grant.configSha256 &&
      git(this.storage.root, ["rev-parse", `refs/heads/${grant.targetBranch}`]) === grant.planningHead,
      "Delegation configuration or planning HEAD changed");
    return record;
  }
  issueDelegation(grant: DelegationGrant): void {
    validateDelegationGrant(grant);
    assertRestorationScope(this.storage.runtime, grant.runId, [`${grant.taskId}@1`]);
    invariant(grant.sourceRoot === this.storage.root && Date.now() < Date.parse(grant.expiresAt), "Delegation repository or expiry mismatch");
    invariant(git(this.storage.root, ["rev-parse", `${grant.planningHead}^`]) === grant.originalHead,
      "Delegation planning baseline must be the single registered upgrade commit");
    const changed = git(this.storage.root, ["diff", "--name-only", grant.originalHead, grant.planningHead]).split("\n").filter(Boolean);
    invariant(changed.length > 0 && changed.every(p => grant.upgradePaths.includes(p)), "Unregistered change in upgrade baseline");
    const manifest = readJson<{files: Array<{path: string}>}>(join(this.storage.root, ".automation-plugin/manifest.json"));
    const managed = new Set(manifest.files.map(f => f.path));
    invariant(grant.upgradePaths.every(p => managed.has(p) || p.startsWith(".automation-plugin/")), "Upgrade baseline includes unmanaged files");
    this.storage.transaction(document => {
      invariant(document.paused && !document.active, "Delegation issuance requires paused idle queue");
      invariant(!document.delegations?.some(r => r.grant.id === grant.id || r.grant.taskId === grant.taskId ||
        r.grant.candidateSha256 === grant.candidateSha256), "Candidate delegation already issued");
      document.delegations ??= [];
      invariant(document.delegations.filter(r => r.grant.runId === grant.runId).length < MAX_TRIAL_CANDIDATES, "Candidate delegation limit exhausted");
      document.delegations.push({grant, grantSha256: sha256(JSON.stringify(grant)), createdAt: now(), sessionID: null,
        requestMessage: null, draft: null, consumedAt: null});
      this.checkedDelegation(document, grant.id);
    });
  }
  bindDelegation(id: string, sessionID: string, request: string): void {
    this.storage.transaction(document => bindDelegationSession(this.checkedDelegation(document, id), sessionID, request));
  }
  sessionDelegation(id: string, sessionID: string): DelegationRecord {
    const record = this.checkedDelegation(this.storage.read(), id);
    invariant(record.sessionID === sessionID, "Delegation is not bound to this native change session");
    return record;
  }
  draft(input: DraftInput, proposalApproval?: ApprovalProof, delegated?: DelegationContext): Draft {
    const config = this.config();
    validateContract(input.contract, config);
    const scope = (input.contract.verification as {scope?: {version?: number}} | undefined)?.scope;
    const bounded = scope?.version === 3;
    const preview = bounded ? this.preview(input) : undefined;
    if (!bounded) this.verificationPreview(input.contract);
    const verificationFallbackReason = input.verificationFallbackReason;
    if (verificationFallbackReason !== undefined) invariant(!bounded && typeof verificationFallbackReason === "string" &&
      verificationFallbackReason.trim().length >= 10 && Buffer.byteLength(verificationFallbackReason) <= 512,
      "Legacy verification requires a meaningful verificationFallbackReason of at most 512 UTF-8 bytes; bounded contracts must omit it");
    invariant(!config.androidProject?.capabilities || bounded || verificationFallbackReason !== undefined,
      "New drafts with project capabilities require bounded verification.scope version 3, or an explicit verificationFallbackReason for reviewed legacy verification; existing approvals remain unchanged");
    if (preview) invariant(preview.configSha256 === sha256(readFileSync(join(this.storage.root, "automation/config.json"))),
      "Verification configuration changed after the planning snapshot; obtain a fresh preview");
    invariant(input.plan.trim().length >= 20 && Buffer.byteLength(input.plan) <= 1024 * 1024, "A complete plan of at most 1 MiB is required");
    invariant(/^[a-f0-9]{40,64}$/.test(input.planningHead), "A fixed planning commit is required");
    git(this.storage.root, ["check-ref-format", `refs/heads/${input.targetBranch}`]);
    git(this.storage.root, ["merge-base", "--is-ancestor", input.planningHead, `refs/heads/${input.targetBranch}`]);
    const workspaceStrategy = input.workspaceStrategy ?? config.workspaceStrategy;
    // A task can override the repository policy; legacy configurations without
    // a commitPolicy retain the original human-approval fallback.
    const commitPolicy = input.commitPolicy ?? config.commitPolicy ?? "humanApproval";
    invariant(["inPlaceExclusive", "isolatedWorktree"].includes(workspaceStrategy), "Invalid workspace strategy");
    invariant(["humanApproval", "autoCommit"].includes(commitPolicy), "Invalid commit policy");
    invariant(workspaceStrategy === "inPlaceExclusive" || commitPolicy === "humanApproval" ||
      isolatedAutoIntegrationAuthorized({ contract: input.contract, workspaceStrategy, commitPolicy }),
      "isolatedWorktree + autoCommit is unsupported without explicit V8 approval");
    const continuity = continuityPolicy(input.contract);
    invariant(!continuity?.isolatedAutoIntegration || (workspaceStrategy === "isolatedWorktree" && commitPolicy === "autoCommit"),
      "Isolated auto integration requires matching workspace and commit policies");
    const planningInputsSha256 = continuity ? planningInputsDigest(this.storage.root, input.planningHead, continuity.planningInputs) : undefined;
    const dependencies = input.dependsOn ?? [];
    invariant(dependencies.every(id => TASK_ID.test(id) && id !== input.contract.id) && new Set(dependencies).size === dependencies.length, "Invalid task dependencies");
    const priority = input.priority ?? 0;
    invariant(Number.isInteger(priority) && priority >= -100 && priority <= 100, "Priority must be an integer from -100 to 100");
    invariant(input.notBefore === undefined || /(?:Z|[+-]\d{2}:\d{2})$/.test(input.notBefore), "notBefore must include an explicit timezone offset");
    const notBefore = input.notBefore === undefined ? null : new Date(input.notBefore).toISOString();
    const contractText = `${JSON.stringify(input.contract, null, 2)}\n`;
    return this.storage.transaction(document => {
      const delegation = delegated ? this.checkedDelegation(document, delegated.id) : undefined;
      if (delegation) checkDelegatedDraft(delegation, input, delegated!);
      if (delegation?.draft) {
        const previous = document.drafts.find(d => d.key === delegation.draft!.key);
        invariant(previous && previous.contractSha256 === sha256(contractText) && previous.planSha256 === sha256(input.plan),
          "Delegated draft already sealed with different content");
        return previous;
      }
      const taskId = String(input.contract.id);
      const version = Math.max(0, ...document.drafts.filter(draft => draft.taskId === taskId).map(draft => draft.version)) + 1;
      const sealed = { ...(preview ? { verificationPreview: preview.verificationPreview, verificationConfigSha256: preview.configSha256 } : {}), ...(verificationFallbackReason !== undefined ? { verificationFallbackReason } : {}), ...(proposalApproval ? { proposalApproval } : {}), ...(planningInputsSha256 ? { planningInputsSha256 } : {}), key: `${taskId}@${version}`, taskId, version, contract: input.contract, contractText,
        plan: input.plan, contractSha256: sha256(contractText), planSha256: sha256(input.plan),
        planningHead: input.planningHead, targetBranch: input.targetBranch, sourceRoot: this.storage.root,
        workspaceStrategy, commitPolicy, notBefore, dependsOn: dependencies, priority, createdAt: now() };
      const draft = { ...sealed, digest: draftDigest(sealed) };
      assertReadyForIntake(this.readiness(draft, document), true);
      if (delegation) sealDelegatedDraft(delegation, draft, delegated!);
      document.drafts.push(draft);
      return draft;
    });
  }
  reviewDraft(draft: Draft): Readiness {
    const readiness = this.readiness(draft);
    atomicJson(join(this.storage.runtime, "inbox", `${draft.key}.readiness.json`), readiness);
    return readiness;
  }
  readiness(draft: Draft, document = this.storage.read()): Readiness {
    return evaluateReadiness(this, draft.planningHead, draft.targetBranch, draft, document);
  }
  waitForPrecondition(document: QueueDocument, item: QueueItem, result: Readiness): void {
    invariant(!item.taskRoot, "Started workspaces cannot enter startup waiting");
    if (item.precondition?.fingerprint !== result.fingerprint) {
      item.precondition = result;
      item.state = "WAITING_PRECONDITION";
      item.waitingReason = readinessMessage(result);
      this.notify(document, item, item.waitingReason);
    }
  }
  approvalText(draft: Draft): string {
    const scope = (draft.contract.verification as {scope?: {version?: number; baseline?: string; buildMode?: string; regressionTests?: Array<{gradleTask: string; filter: string}>; tasks?: Record<string, string[]>}} | undefined)?.scope;
    if (scope?.version === 3) {
      const tests = [...draft.contract.targetTests as Array<{gradleTask: string; filter: string}>, ...(scope.regressionTests ?? [])];
      const cleanTasks = (draft.verificationPreview as {cleanTasks?: string[]} | undefined)?.cleanTasks ?? [];
      const commands = [...cleanTasks, ...new Set(tests.map(t => `${t.gradleTask} --tests ${t.filter}`)), ...Object.values(scope.tasks ?? {}).flat()];
      let text = `批准入队 ${draft.key}：${scope.baseline === "execute" ? "运行已列出的目标基线测试" : "基线仅保存快照，不运行测试"}；${scope.buildMode === "clean" ? "明确授权所选模块干净构建" : "增量编译并允许构建缓存"}。验证上限：${commands.join("；")}。不得自动扩大测试、模块或变体。`;
      text += draft.commitPolicy === "autoCommit" ? "独立 Review 及候选提交最终验证通过后自动本地集成，不推送远程。" : "执行后等待人工确认提交，不推送远程。";
      const policy = continuityPolicy(draft.contract);
      return policy ? text + (policy.isolatedAutoIntegration ? "隔离工作区自动集成已授权。" : "") +
        (policy.planningRefresh === "completedQueueTasks" ? "仅允许已完成队列提交且声明的规划输入未变化时刷新基线。" : "规划基线变化须重新审批。") : text;
    }
    const selected = (draft.contract.verification as {scope?: {mode?: string}} | undefined)?.scope?.mode === "affected-tests";
    const verification = selected ? "选定回归测试（无法确定影响时扩大至模块）及所需构建" : (draft.contract.verification as {scope?: unknown} | undefined)?.scope ? "影响范围内的编译、单测" : "构建、全量单测";
    let text = draft.commitPolicy === "autoCommit"
      ? `批准入队 ${draft.key}：通过${verification}和独立 Review 后自动本地提交并集成，不推送远程。`
      : `批准入队 ${draft.key}：执行后等待人工确认提交，不推送远程。`;
    if (selected) text += "按实际改动选择目标及调用方测试；允许复用同一冻结候选的通过证据，变化后重新验证。";
    if (draft.verificationFallbackReason) text += scope ? `使用已明确审阅的旧版影响范围验证；原因：${draft.verificationFallbackReason}` : `使用全量验证（包含配置中的全部构建变体）；原因：${draft.verificationFallbackReason}`;
    const policy = continuityPolicy(draft.contract);
    return policy ? text + (policy.isolatedAutoIntegration ? "隔离工作区自动集成已授权。" : "") +
      (policy.planningRefresh === "completedQueueTasks" ? "仅允许已完成队列提交且声明的规划输入未变化时刷新基线。" : "规划基线变化须重新审批。") : text;
  }
  enqueue(key: string, digest: string, approval: string, proof?: ApprovalProof, delegated?: DelegationContext): QueueItem {
    this.config();
    return this.storage.transaction(document => {
      const existing = document.items.find(item => item.key === key);
      if (existing) {
        if (delegated) invariant(existing.authorization.source === "delegatedApproval" &&
          existing.authorization.delegation?.id === delegated.id && existing.authorization.delegation.sessionID === delegated.sessionID,
          "Delegated duplicate does not match the original session");
        invariant(existing.digest === digest && this.approvalText(existing) === approval, "Repeated approval does not match the sealed contract");
        return existing;
      }
      const draft = document.drafts.find(candidate => candidate.key === key);
      invariant(draft && draft.digest === digest && draftDigest(draft) === digest, "Draft changed; display a fresh contract review");
      invariant(this.approvalText(draft) === approval, "Explicit approval for this version and commit policy is required");
      if (draft.verificationConfigSha256 !== undefined) {
        const preview = this.preview(draft);
        invariant(preview.configSha256 === draft.verificationConfigSha256 &&
          sha256(readFileSync(join(this.storage.root, "automation/config.json"))) === draft.verificationConfigSha256 &&
          JSON.stringify(preview.verificationPreview) === JSON.stringify(draft.verificationPreview) &&
          JSON.stringify(this.verificationPreview(draft.contract)) === JSON.stringify(draft.verificationPreview),
          "Sealed verification preview changed; obtain a fresh proposal and contract approval");
      }
      invariant(!document.items.some(item => item.taskId === draft.taskId && item.state !== "CANCELLED" && item.state !== "SUPERSEDED"), "This task already has an approved execution; use a new task ID or cancel its unstarted version");
      for (const dependency of draft.dependsOn) invariant(document.items.some(item => item.taskId === dependency && item.state !== "CANCELLED"), `Approve dependency first: ${dependency}`);
      assertReadyForIntake(this.readiness(draft, document));
      invariant(delegated || !document.delegations?.some(r => r.draft?.key === key), "Delegated draft requires atomic grant consumption");
      const delegationProof = delegated ? consumeDelegation(this.checkedDelegation(document, delegated.id), draft, delegated) : undefined;
      const item: QueueItem = { ...draft, approvedWorkspaceStrategy: draft.workspaceStrategy, queuePriority: draft.priority,
        sequence: ++document.sequence, approvedAt: now(),
        authorization: { source: delegationProof ? "delegatedApproval" : "contractApproval", ...(delegationProof ? { delegation: delegationProof } : {}), digest, commitPolicy: draft.commitPolicy, pushAfterAcceptance: false, revoked: false, ...(proof ? { proof } : {}) },
        state: "QUEUED", waitingReason: null, runId: null, taskRoot: null, request: null, sealedDiff: null, sealedRunId: null, candidateId: null, completedCommit: null };
      document.items.push(item);
      if (scopeAllows(document.runScope, item.key)) document.paused = false;
      this.notify(document, item, "Contract approved and durably enqueued");
      return item;
    });
  }
  item(key: string): QueueItem {
    const item = this.findItem(this.storage.read(), key);
    invariant(item, `Unknown queued task: ${key}`);
    return item;
  }
  private findItem(document: QueueDocument, key: string): QueueItem | undefined {
    return document.items.find(item => item.key === key) ?? [...document.items].reverse().find(item => item.taskId === key);
  }
  reorder(key: string, priority: number): void {
    invariant(Number.isInteger(priority) && priority >= -100 && priority <= 100, "Priority must be an integer from -100 to 100");
    this.storage.transaction(document => {
      const item = this.findItem(document, key);
      invariant(item && ["QUEUED", "WAITING_PRECONDITION"].includes(item.state), "Only unstarted queue items may be reordered");
      item.queuePriority = priority;
    });
  }
  setPolicy(workspaceStrategy: WorkspaceStrategy, commitPolicy: CommitPolicy): void {
    const release = fileLock(join(this.storage.runtime, "locks/lifecycle.lock"));
    try {
      this.storage.transaction(document => {
        invariant(document.paused && !document.active, "Pause the queue and wait for its executor before changing policy");
        invariant(!document.items.some(item => item.taskRoot && !TERMINAL.has(item.state)), "Retained workspaces must complete or abort before a policy change");
        invariant(!existsSync(join(this.storage.runtime, "locks/repository.workspace.lease")), "Repository still has a workspace owner");
        const config = this.config();
        helperFreeCleanCheck(this.storage.root);
        const policy = queuePolicy({ ...config, workspaceStrategy, commitPolicy });
        const configPath = join(this.storage.root, "automation/config.json");
        atomicJson(configPath, { ...config, ...policy }, statSync(configPath).mode & 0o777);
        document.strategy = workspaceStrategy;
      });
    } finally { release(); }
  }
  recoverExecution(): void {
    this.storage.transaction(document => {
      const run = document.active;
      invariant(run, "No active execution to recover");
      if (run.supervision) {
        invariant(!run.supervision.owner || !isAlive(run.supervision.owner), "Worker supervisor is still alive");
        invariant(run.worker, "Supervised Worker launch is ambiguous; preserve reservation");
        invariant(ownedTree(processSnapshot(run.supervision.token), run.worker, run.supervision.known).length === 0, "Supervised descendants are still alive");
      }
      if (run.worker) {
        invariant(!isAlive(run.worker) && !processGroupAlive(run.worker.pid), "Executor or its children are still alive; preserve the execution slot");
      } else {
        invariant(run.launcher && !isAlive(run.launcher), "Execution launcher is still alive or unknown; cannot recover its reservation");
      }
      const item = this.findItem(document, run.key)!;
      item.state = "BLOCKED";
      item.waitingReason = "Interrupted execution preserved; inspect its workspace, then request resume, abort or commit recovery";
      item.sealedRunId = null;
      this.notify(document, item, item.waitingReason);
      document.runs.push({ ...run, outcome: { state: item.state, error: item.waitingReason } });
      // Invalidate the reservation atomically. A delayed, unregistered worker
      // cannot acquire it after this transaction, even if it starts later.
      document.active = null;
    });
  }
  present(item: QueueItem, document: QueueDocument = this.storage.read()): Record<string, unknown> {
    return { ...item, ...runtimePresentation(this.storage.runtime, item, document.active) };
  }
  details(key: string): Record<string, unknown> {
    const stored = this.storage.read();
    const approved = this.findItem(stored, key);
    if (!approved) {
      const draft = stored.drafts.find(candidate => candidate.key === key);
      invariant(draft, `Unknown task or draft: ${key}`);
      const reviewPath = join(this.storage.runtime, "inbox", `${draft.key}.readiness.json`);
      const readiness = existsSync(reviewPath) ? readJson<Readiness>(reviewPath) : null;
      return { ...draft, state: "DRAFT", candidateId: null, currentTargetHead: git(draft.sourceRoot, ["rev-parse", `refs/heads/${draft.targetBranch}`]),
        authorization: { source: "draft", revoked: false, pushAfterAcceptance: false }, precondition: readiness,
        evidence: readiness ? { precondition: readiness } : {} };
    }
    const item = approved;
    const evidence: Record<string, unknown> = {};
    for (const name of ["acceptance-report", "review", "full-test-verification", "commit-transaction", "integration", "planning-baseline",
      "model-continuation", "baseline-inventory", "baseline-recovery", "test-preflight", "test-manifest", "test-supplement", "green-inventory", "inventory-status", "verification-plan", "verification-result"]) {
      const path = join(this.storage.runtime, "evidence", item.taskId, `${name}.json`);
      if (existsSync(path)) evidence[name] = readJson<unknown>(path);
    }
    const document = this.storage.read();
    const run = document.active?.key === item.key ? document.active : [...document.runs].reverse().find(candidate => candidate.key === item.key);
    if (run?.supervision) evidence.workerSupervision = supervisionEvidence(run.supervision);
    const stages: Record<string, unknown> = {};
    for (const phase of ["red", "green", "review", "verification-green", "verification-review", "verification-integration"]) {
      const file = join(this.storage.runtime, "evidence", item.taskId, "stage-recovery", `${phase}.json`);
      if (existsSync(file)) stages[phase] = readJson<unknown>(file);
    }
    if (Object.keys(stages).length) evidence.stageRecovery = stages;
    if (item.precondition) evidence.precondition = item.precondition;
    return { ...this.present(item, stored), currentTargetHead: git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]), evidence };
  }
  notify(document: QueueDocument, item: QueueItem, message: string): void {
    const id = sha256(`${item.key}:${item.state}:${item.candidateId}:${item.completedCommit}:${message}`);
    if (!document.notifications.some(notification => notification.id === id)) document.notifications.push({ id, key: item.key, state: item.state, at: now(), message, sealedDiff: item.sealedDiff, commit: item.completedCommit, pushed: false, acknowledged: false });
  }
  control(action: "pause" | "resume" | "clear-fault" | "cancel" | "revoke" | "acknowledge", key?: string): QueueDocument {
    return this.storage.transaction(document => {
      if (action === "pause") document.paused = true;
      if (action === "resume") document.paused = false;
      if (action === "clear-fault") {
        invariant(!document.active, "Resolve the active execution before clearing a public fault");
        document.fault = null;
      }
      if (action === "acknowledge") {
        const notification = document.notifications.find(notification => notification.id === key);
        invariant(notification, "Unknown notification"); notification.acknowledged = true;
      }
      if (action === "cancel" || action === "revoke") {
        const item = this.findItem(document, key ?? "");
        invariant(item && !TERMINAL.has(item.state), "No active approval for this task");
        if (action === "cancel") {
          invariant(item.taskRoot === null && document.active?.key !== item.key, "Running or occupied tasks require the approved abort workflow");
          item.state = "CANCELLED";
        }
        item.authorization.revoked = true;
        this.notify(document, item, action === "cancel" ? "Queued task cancelled" : "Commit authorization revoked; preserve workspace");
      }
      return document;
    });
  }
  verificationRecovery(item: QueueItem): NonNullable<QueueItem["request"]>["verificationRecovery"] {
    if (!(item.contract.verification as {scope?: unknown} | undefined)?.scope ||
      !existsSync(join(this.storage.runtime, "evidence", item.taskId, "red.json"))) return undefined;
    invariant(["BLOCKED", "INTEGRATION_BLOCKED"].includes(item.state) && item.candidateId && item.sealedDiff, "Candidate is not an environment-blocked sealed task");
    for (const phase of item.state === "INTEGRATION_BLOCKED" ? ["integration"] : ["review", "green"]) {
      const file = join(this.storage.runtime, "evidence", item.taskId, "stage-recovery", `verification-${phase}.json`);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file), record = JSON.parse(bytes.toString());
      if (!["EXHAUSTED", "ENVIRONMENT_BLOCKED"].includes(record.state)) continue;
      invariant(sha256(bytes) === item.stageRecovery?.[`verification-${phase}`]?.sha256, "Recovery ledger changed");
      invariant(record.lastFailure?.category === "environment" && record.manualRetriesUsed <
        (item.contract.verification as {scope: {maxManualRetries: number}}).scope.maxManualRetries, "Candidate recovery is not authorized or its budget is exhausted");
      return {phase, ledgerSha256: sha256(bytes), targetHead: git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]), candidateId: item.candidateId};
    }
    throw new Error("No recoverable environmental verification failure; preserve evidence and approve a revised task");
  }
  operationBinding(item: QueueItem, operation: string): string {
    const recovery = operation === "resume-task" ? this.verificationRecovery(item) : undefined;
    return `${item.key}:${item.digest}:${item.candidateId}:${operation}${recovery ? `:${sha256(JSON.stringify(recovery))}` : ""}`;
  }
  request(key: string, kind: Exclude<JobKind, "execute">, approval?: string, candidate?: string, proof?: ApprovalProof): void {
    invariant(kind !== "retry-baseline", "Automatic baseline recovery is reserved for the approved scheduler policy");
    const config = this.config();
    this.storage.transaction(document => {
      const item = this.findItem(document, key);
      invariant(item && item.taskRoot && !TERMINAL.has(item.state), "Task has no recoverable workspace");
      invariant(document.active?.key !== item.key || kind === "abort", "Task is still running; wait for its recorded process to exit");
      invariant(!item.request || item.request.kind === kind, "An earlier request is already queued for this task");
      if (kind === "integrate") {
        invariant(item.commitPolicy === "humanApproval" && item.state === "AWAITING_HUMAN", "Task is not awaiting human acceptance");
        invariant(candidate && candidate === item.candidateId, "Acceptance must bind to the latest sealed candidate and target baseline");
        invariant(approval === config.approvalPhrases.acceptance, "Explicit final acceptance is required");
      } else if (kind !== "recover" && kind !== "revalidate") {
        const phrase = kind === "abort" ? config.approvalPhrases.abort : config.approvalPhrases.resume;
        invariant(approval === phrase, `Explicit ${kind} approval is required`);
      }
      if (kind === "revalidate") invariant(item.workspaceStrategy === "isolatedWorktree" && item.state === "AWAITING_HUMAN", "Only a sealed isolated candidate can be revalidated");
      const verificationRecovery = kind === "resume" || (kind === "recover" && item.stageRecovery?.["verification-integration"]) ? this.verificationRecovery(item) : undefined;
      invariant(kind !== "resume" || verificationRecovery?.phase !== "integration", "Committed candidates use recover, not resume-task");
      item.request = { ...(verificationRecovery ? {verificationRecovery} : {}), kind, approval: approval ?? null, candidate: candidate ?? null, ...(proof ? { proof } : {}) };
      this.notify(document, item, `${kind} requested; waiting for the repository execution slot`);
    });
  }
  setRunScope(scope: RunScope): void {
    validateRunScope(scope);
    const owner = pendingRestorationForScope(this.storage.runtime);
    if (owner) {
      invariant(scope.taskKeys.includes(owner.taskKey), "Run scope excludes the pending restoration task");
      assertRestorationScope(this.storage.runtime, scope.runId, [owner.taskKey]);
    }
    this.storage.transaction(document => {
      invariant(document.paused && !document.active, "Run scope changes require a paused, idle queue");
      invariant(!document.runScope || JSON.stringify(document.runScope) === JSON.stringify(scope), "Existing run scope is immutable; finish restoration before starting another batch");
      invariant(!document.items.some(item => item.taskRoot && !TERMINAL.has(item.state)), "Cannot scope a queue with retained task workspaces");
      document.runScope = structuredClone(scope);
    });
  }
  reserve(): QueueRun | null {
    const config = this.config();
    // Disk traversal stays outside the intake transaction.
    const retained = this.storage.read().items.filter(item => item.taskRoot && item.workspaceStrategy === "isolatedWorktree" && existsSync(item.taskRoot));
    let workspaceBytes = 0;
    for (const item of retained) {
      const usage = spawnSync("du", ["-sk", item.taskRoot!], { encoding: "utf8" });
      invariant(usage.status === 0, "Cannot measure retained workspace disk usage");
      workspaceBytes += Number(usage.stdout.trim().split(/\s+/)[0]) * 1024;
    }
    const observed = this.storage.read();
    const observedDigest = sha256(JSON.stringify(observed));
    const readinessByKey = new Map<string, Readiness>();
    const scan: ReadinessScan = {};
    if (!observed.active && !observed.fault && !observed.paused) {
      for (const item of observed.items.filter(item => scopeAllows(observed.runScope, item.key) && ["QUEUED", "WAITING_PRECONDITION"].includes(item.state))) {
        readinessByKey.set(item.key, evaluateReadiness(this, item.planningHead, item.targetBranch, item, observed, scan));
      }
    }
    return this.storage.transaction(document => {
      if (sha256(JSON.stringify(document)) !== observedDigest) return null;
      if (existsSync(join(this.storage.runtime, "locks/lifecycle.lock"))) return null;
      if (document.active || document.fault) return null;

      const occupied = document.items.filter(item => item.taskRoot && !TERMINAL.has(item.state));
      if (occupied.some(item => item.workspaceStrategy !== config.workspaceStrategy)) {
        document.fault = "Workspace strategy changed while tasks retain a workspace; restore the recorded strategy";
        return null;
      }
      const fixed = occupied.find(item => item.workspaceStrategy === "inPlaceExclusive");
      const leaseDirectory = join(this.storage.runtime, "locks/repository.workspace.lease");
      if (existsSync(leaseDirectory) && !existsSync(join(leaseDirectory, "lease.json"))) {
        document.fault = "Repository workspace lease is incomplete; recover its ownership before scheduling";
        return null;
      }
      const requests = document.items.filter(item => item.request && (!document.paused || item.request.kind === "abort")).sort((a, b) => a.sequence - b.sequence);
      const retries = document.items.filter(item => !document.paused && !item.request && item.state === "BLOCKED" && Number(item.contract.schemaVersion) >= 5 && item.baselineRecovery?.nextRunAt != null)
        .sort((a, b) => a.sequence - b.sequence);
      const pending = document.items.filter(item => !document.paused && ["QUEUED", "WAITING_PRECONDITION"].includes(item.state)).sort((a, b) => b.queuePriority - a.queuePriority || a.sequence - b.sequence);
      for (const item of [...requests, ...retries, ...pending]) {
        if (!scopeAllows(document.runScope, item.key, item.request?.kind === "abort")) continue;
        if (document.runScope && Number(item.contract.schemaVersion) < 6) {
          item.waitingReason = "Scoped runs require an explicitly approved supervised execution policy";
          continue;
        }
        if (item.request?.kind !== "abort" && !config.unitTestsEnabled) { document.fault = "Queued execution requires unit tests; enable unitTestsEnabled"; return null; }
        if (item.state !== "WAITING_PRECONDITION") item.waitingReason = null;
        const retry = !item.request && item.state === "BLOCKED" ? item.baselineRecovery : null;
        if (retry) {
          if (Date.now() >= retry.deadline) { item.waitingReason = "Baseline recovery elapsed-time budget exhausted"; retry.nextRunAt = null; continue; }
          if (retry.nextRunAt === null || Date.now() < retry.nextRunAt) { item.waitingReason = `Baseline recovery backoff until ${new Date(retry.nextRunAt!).toISOString()}`; continue; }
          if (item.sealedRunId !== item.runId || !item.sealedDiff) { item.waitingReason = "Baseline candidate was not sealed; explicit recovery required"; continue; }
        }
        if (fixed && fixed.key !== item.key) { item.waitingReason = `Waiting for ${fixed.taskId}: ${fixed.state}`; continue; }
        if (item.commitPolicy === "autoCommit" && config.workspaceStrategy === "isolatedWorktree" &&
          !(item.approvedWorkspaceStrategy === "isolatedWorktree" && isolatedAutoIntegrationAuthorized(item))) {
          item.waitingReason = "isolatedWorktree + autoCommit is unsupported without explicit V8 approval; fresh contract approval is required"; continue;
        }
        if (continuityPolicy(item.contract) && item.approvedWorkspaceStrategy !== config.workspaceStrategy) {
          item.waitingReason = "V8 workspace strategy changed; restore the approved policy or approve a revised contract"; continue;
        }
        if (!item.request && item.notBefore && Date.parse(item.notBefore) > Date.now()) { item.waitingReason = `Scheduled for ${item.notBefore}`; continue; }
        const dependency = item.dependsOn.find(id => !document.items.some(candidate => candidate.taskId === id && candidate.state === "COMPLETED"));
        if (dependency && !item.request) { item.waitingReason = `Waiting for dependency ${dependency} to complete local integration`; continue; }
        if (!item.request && !retry && config.workspaceStrategy === "isolatedWorktree" && (retained.length >= (config.queue?.maxWorkspaces ?? 3) || workspaceBytes >= (config.queue?.maxWorkspaceBytes ?? 20 * 1024 ** 3))) { item.waitingReason = "Isolated workspace capacity or disk limit reached"; continue; }
        try { if (item.request?.kind !== "abort") assertAuthorized(item); }
        catch (error) { item.waitingReason = String(error); continue; }
        // Legacy leases and unknown workspace owners cannot be bypassed.
        const leasePath = join(this.storage.runtime, "locks/repository.workspace.lease/lease.json");
        if (existsSync(leasePath)) {
          const lease = readJson<{taskId: string}>(leasePath);
          if (lease.taskId !== item.taskId) { item.waitingReason = `Repository workspace is leased by ${lease.taskId}`; continue; }
        }
        if (!item.request && !retry) {
          const readiness = readinessByKey.get(item.key);
          invariant(readiness, "Startup readiness observation is missing");
          if (readiness.state !== "READY") { this.waitForPrecondition(document, item, readiness); continue; }
          delete item.precondition;
          item.waitingReason = null;
        }
        const launcher = processIdentity(process.pid);
        invariant(launcher, "Cannot establish execution launcher identity");
        const run: QueueRun = { packageIdentity: packageRuntimeIdentity(), id: randomUUID(), key: item.key, kind: item.request?.kind ?? (retry ? "retry-baseline" : "execute"), createdAt: now(), launcher, worker: null, outcome: null };
        // Consume the scheduled wake before launch. A crash or rejected input
        // must not replay it indefinitely without a new durable failed attempt.
        if (item.baselineRecovery && (run.kind === "retry-baseline" || run.kind === "resume")) item.baselineRecovery.nextRunAt = null;
        if (Number(item.contract.schemaVersion) >= 6) run.supervision = initialSupervision(item.contract.execution as unknown as ExecutionPolicy, Date.now());
        if (document.runScope && run.supervision) {
          const deadline = Date.parse(run.kind === "abort" ? document.runScope.cleanupExpiresAt : document.runScope.expiresAt);
          run.supervision.deadline = Math.min(run.supervision.deadline, deadline);
          run.supervision.stageDeadline = Math.min(run.supervision.stageDeadline, deadline);
        }
        document.active = run; document.strategy = config.workspaceStrategy;
        item.runId = run.id;
        item.sealedRunId = null;
        if (run.kind === "execute") { item.workspaceStrategy = config.workspaceStrategy; item.state = "CLAIMED"; }
        return run;
      }
      return null;
    });
  }
  reconcile(): void {
    this.storage.transaction(document => {
      const run = document.active;
      if (!run) return;
      const item = document.items.find(item => item.key === run.key);
      invariant(item, "Active execution has no contract");
      if (run.supervision && run.supervision.state !== "EXITED") return;
      if (!run.worker) {
        // A crash between reservation and spawn is ambiguous, never requeue it.
        if (Date.now() - Date.parse(run.createdAt) > 30000) document.fault = "Execution launch ownership is unknown; explicit recovery is required";
        return;
      }
      if (isAlive(run.worker) || processGroupAlive(run.worker.pid)) return;
      if (!run.outcome) {
        item.state = "BLOCKED";
        item.waitingReason = "Executor stopped without a durable outcome; preserve workspace and recover";
      } else {
        item.state = run.outcome.state;
        item.waitingReason = run.outcome.error;
      }
      if (run.outcome && item.sealedRunId === run.id && item.workspaceStrategy === "isolatedWorktree" && STOPPED.has(item.state) && item.sealedDiff) {
        // Worker seals while it owns the lease. Only release after its entire
        // process group has exited; never infer this from the shell exit alone.
        const workspacePath = join(this.storage.runtime, "workspaces", `${item.taskId}.json`);
        if (existsSync(workspacePath)) {
          const workspace = readJson<Record<string, unknown>>(workspacePath);
          atomicJson(workspacePath, { ...workspace, repositoryLeaseRequired: false, executionExited: true });
        }
      }
      if (item.request?.kind === run.kind) item.request = null;
      this.notify(document, item, item.waitingReason ?? (item.state === "COMPLETED" ? "Local integration completed; not pushed" : `Task reached ${item.state}`));
      document.runs.push(structuredClone(run));
      document.active = null;
    });
  }
}

function helperFreeCleanCheck(root: string): void {
  invariant(git(root, ["status", "--porcelain"]) === "", "Workspace must be clean before changing queue policy");
}
