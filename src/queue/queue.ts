import type { ApprovalProof } from "./approvals.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicJson, fileLock, git, gitBuffer, invariant, isAlive, processGroupAlive, processIdentity, readJson,
  sha256, QueueStorage, type ProcessIdentity,
} from "./storage.js";
import { queuePolicy, type QueuePolicy } from "../config/queue-policy.js";

export type WorkspaceStrategy = "inPlaceExclusive" | "isolatedWorktree";
export type CommitPolicy = "humanApproval" | "autoCommit";
export type JobKind = "execute" | "integrate" | "revalidate" | "resume" | "resume-review" | "abort" | "recover";
export interface QueueConfiguration {
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
  gradleVerification: { fullUnitTestTasks: string[]; focusedTestTasks: string[]; assembleTasks: string[] };
}
export interface Draft {
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
  approvedWorkspaceStrategy: WorkspaceStrategy;
  queuePriority: number;
  sequence: number;
  approvedAt: string;
  authorization: { source: "contractApproval"; digest: string; commitPolicy: CommitPolicy; pushAfterAcceptance: false; revoked: boolean; proof?: ApprovalProof };
  state: string;
  waitingReason: string | null;
  runId: string | null;
  taskRoot: string | null;
  request: { kind: JobKind; approval: string | null; candidate: string | null; proof?: ApprovalProof } | null;
  sealedDiff: string | null;
  sealedRunId: string | null;
  candidateId: string | null;
  completedCommit: string | null;
}
export interface QueueRun {
  id: string;
  key: string;
  kind: JobKind;
  createdAt: string;
  launcher: ProcessIdentity;
  worker: ProcessIdentity | null;
  outcome: { state: string; error: string | null } | null;
}
export interface QueueNotification {
  id: string; key: string; state: string; at: string; message: string;
  sealedDiff: string | null; commit: string | null; pushed: false; acknowledged: boolean;
}
export interface QueueDocument {
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
    approvedWorkspaceStrategy, queuePriority: _priority, ...draft } = item;
  return { ...draft, workspaceStrategy: approvedWorkspaceStrategy };
}

export function assertAuthorized(item: QueueItem): void {
  invariant(!item.authorization.revoked, "Contract authorization was revoked");
  invariant(item.digest === draftDigest(draftFromItem(item)) && item.digest === item.authorization.digest, "Approved contract or scheduling policy changed; fresh approval required");
  invariant(item.authorization.commitPolicy === item.commitPolicy && item.authorization.pushAfterAcceptance === false, "Invalid sealed commit or no-push authorization");
  invariant(sha256(item.contractText) === item.contractSha256 && sha256(item.plan) === item.planSha256, "Approved artifacts changed");
  invariant(JSON.stringify(JSON.parse(item.contractText)) === JSON.stringify(item.contract), "Contract text and metadata disagree");
  invariant(item.workspaceStrategy !== "isolatedWorktree" || item.commitPolicy === "humanApproval", "isolatedWorktree + autoCommit is unsupported");
}

export class TaskQueue {
  readonly storage: QueueStorage<QueueDocument>;
  constructor(directory: string) {
    this.storage = new QueueStorage(directory, () => ({ schemaVersion: 1, sequence: 0, paused: false, fault: null, strategy: null, drafts: [], items: [], active: null, runs: [], notifications: [] }));
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
  draft(input: DraftInput, proposalApproval?: ApprovalProof): Draft {
    const config = this.config();
    validateContract(input.contract, config);
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
    invariant(workspaceStrategy === "inPlaceExclusive" || commitPolicy === "humanApproval", "isolatedWorktree + autoCommit is unsupported");
    const dependencies = input.dependsOn ?? [];
    invariant(dependencies.every(id => TASK_ID.test(id) && id !== input.contract.id) && new Set(dependencies).size === dependencies.length, "Invalid task dependencies");
    const priority = input.priority ?? 0;
    invariant(Number.isInteger(priority) && priority >= -100 && priority <= 100, "Priority must be an integer from -100 to 100");
    invariant(input.notBefore === undefined || /(?:Z|[+-]\d{2}:\d{2})$/.test(input.notBefore), "notBefore must include an explicit timezone offset");
    const notBefore = input.notBefore === undefined ? null : new Date(input.notBefore).toISOString();
    const contractText = `${JSON.stringify(input.contract, null, 2)}\n`;
    return this.storage.transaction(document => {
      const taskId = String(input.contract.id);
      const version = Math.max(0, ...document.drafts.filter(draft => draft.taskId === taskId).map(draft => draft.version)) + 1;
      const sealed = { ...(proposalApproval ? { proposalApproval } : {}), key: `${taskId}@${version}`, taskId, version, contract: input.contract, contractText,
        plan: input.plan, contractSha256: sha256(contractText), planSha256: sha256(input.plan),
        planningHead: input.planningHead, targetBranch: input.targetBranch, sourceRoot: this.storage.root,
        workspaceStrategy, commitPolicy, notBefore, dependsOn: dependencies, priority, createdAt: now() };
      const draft = { ...sealed, digest: draftDigest(sealed) };
      document.drafts.push(draft);
      return draft;
    });
  }
  approvalText(draft: Draft): string {
    return draft.commitPolicy === "autoCommit"
      ? `批准入队 ${draft.key}：通过构建、全量单测和独立 Review 后自动本地提交并集成，不推送远程。`
      : `批准入队 ${draft.key}：执行后等待人工确认提交，不推送远程。`;
  }
  enqueue(key: string, digest: string, approval: string, proof?: ApprovalProof): QueueItem {
    this.config();
    return this.storage.transaction(document => {
      const existing = document.items.find(item => item.key === key);
      if (existing) {
        invariant(existing.digest === digest && this.approvalText(existing) === approval, "Repeated approval does not match the sealed contract");
        return existing;
      }
      const draft = document.drafts.find(candidate => candidate.key === key);
      invariant(draft && draft.digest === digest && draftDigest(draft) === digest, "Draft changed; display a fresh contract review");
      invariant(this.approvalText(draft) === approval, "Explicit approval for this version and commit policy is required");
      invariant(!document.items.some(item => item.taskId === draft.taskId && item.state !== "CANCELLED" && item.state !== "SUPERSEDED"), "This task already has an approved execution; use a new task ID or cancel its unstarted version");
      for (const dependency of draft.dependsOn) invariant(document.items.some(item => item.taskId === dependency && item.state !== "CANCELLED"), `Approve dependency first: ${dependency}`);
      const item: QueueItem = { ...draft, approvedWorkspaceStrategy: draft.workspaceStrategy, queuePriority: draft.priority,
        sequence: ++document.sequence, approvedAt: now(),
        authorization: { source: "contractApproval", digest, commitPolicy: draft.commitPolicy, pushAfterAcceptance: false, revoked: false, ...(proof ? { proof } : {}) },
        state: "QUEUED", waitingReason: null, runId: null, taskRoot: null, request: null, sealedDiff: null, sealedRunId: null, candidateId: null, completedCommit: null };
      document.items.push(item);
      document.paused = false;
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
      invariant(item?.state === "QUEUED", "Only unstarted queue items may be reordered");
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
        atomicJson(join(this.storage.root, "automation/config.json"), { ...config, ...policy });
        document.strategy = workspaceStrategy;
      });
    } finally { release(); }
  }
  recoverExecution(): void {
    this.storage.transaction(document => {
      const run = document.active;
      invariant(run, "No active execution to recover");
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
  details(key: string): Record<string, unknown> {
    const item = this.item(key);
    const evidence: Record<string, unknown> = {};
    for (const name of ["acceptance-report", "review", "full-test-verification", "commit-transaction", "integration", "planning-baseline"]) {
      const path = join(this.storage.runtime, "evidence", item.taskId, `${name}.json`);
      if (existsSync(path)) evidence[name] = readJson<unknown>(path);
    }
    return { ...item, currentTargetHead: git(item.sourceRoot, ["rev-parse", `refs/heads/${item.targetBranch}`]), evidence };
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
  request(key: string, kind: Exclude<JobKind, "execute">, approval?: string, candidate?: string, proof?: ApprovalProof): void {
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
      item.request = { kind, approval: approval ?? null, candidate: candidate ?? null, ...(proof ? { proof } : {}) };
      this.notify(document, item, `${kind} requested; waiting for the repository execution slot`);
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
    return this.storage.transaction(document => {
      if (existsSync(join(this.storage.runtime, "locks/lifecycle.lock"))) return null;
      if (document.active || document.paused || document.fault) return null;
      if (!config.unitTestsEnabled) { document.fault = "Queued execution requires full unit tests; enable unitTestsEnabled"; return null; }
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
      const requests = document.items.filter(item => item.request).sort((a, b) => a.sequence - b.sequence);
      const pending = document.items.filter(item => item.state === "QUEUED").sort((a, b) => b.queuePriority - a.queuePriority || a.sequence - b.sequence);
      for (const item of [...requests, ...pending]) {
        item.waitingReason = null;
        if (fixed && fixed.key !== item.key) { item.waitingReason = `Waiting for ${fixed.taskId}: ${fixed.state}`; continue; }
        if (item.commitPolicy === "autoCommit" && config.workspaceStrategy === "isolatedWorktree") { item.waitingReason = "isolatedWorktree + autoCommit is unsupported; fresh contract approval is required"; continue; }
        if (!item.request && item.notBefore && Date.parse(item.notBefore) > Date.now()) { item.waitingReason = `Scheduled for ${item.notBefore}`; continue; }
        const dependency = item.dependsOn.find(id => !document.items.some(candidate => candidate.taskId === id && candidate.state === "COMPLETED"));
        if (dependency && !item.request) { item.waitingReason = `Waiting for dependency ${dependency} to complete local integration`; continue; }
        if (!item.request && config.workspaceStrategy === "isolatedWorktree" && (retained.length >= (config.queue?.maxWorkspaces ?? 3) || workspaceBytes >= (config.queue?.maxWorkspaceBytes ?? 20 * 1024 ** 3))) { item.waitingReason = "Isolated workspace capacity or disk limit reached"; continue; }
        try { if (item.request?.kind !== "abort") assertAuthorized(item); }
        catch (error) { item.waitingReason = String(error); continue; }
        // Legacy leases and unknown workspace owners cannot be bypassed.
        const leasePath = join(this.storage.runtime, "locks/repository.workspace.lease/lease.json");
        if (existsSync(leasePath)) {
          const lease = readJson<{taskId: string}>(leasePath);
          if (lease.taskId !== item.taskId) { item.waitingReason = `Repository workspace is leased by ${lease.taskId}`; continue; }
        }
        const launcher = processIdentity(process.pid);
        invariant(launcher, "Cannot establish execution launcher identity");
        const run: QueueRun = { id: randomUUID(), key: item.key, kind: item.request?.kind ?? "execute", createdAt: now(), launcher, worker: null, outcome: null };
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
