import type { Draft, DraftInput, QueueDocument } from "./queue.js";
import { invariant, sha256 } from "./storage.js";

/** Created by the trusted trial driver, never from prompt text or a model tool. */
export interface DelegationGrant {
  version: 1; id: string; runId: string; sourceRoot: string;
  originalHead: string; planningHead: string; targetBranch: string;
  upgradePaths: string[]; requestSha256: string; candidateSha256: string; configSha256: string;
  taskId: string; allowedPaths: string[]; targetTests: Array<{gradleTask: string; filter: string}>;
  workspaceStrategy: "isolatedWorktree"; commitPolicy: "autoCommit";
  expiresAt: string; cleanupExpiresAt: string;
  policies: Record<string, unknown>;
}
export interface DelegationRecord {
  grant: DelegationGrant; grantSha256: string; createdAt: string;
  sessionID: string | null; requestMessage: string | null;
  draft: { key: string; digest: string; planSha256: string; contractSha256: string } | null;
  consumedAt: string | null;
}
export interface DelegationContext { id: string; sessionID: string; messageID: string }
export interface DelegationProof {
  id: string; grantSha256: string; requestSha256: string; candidateSha256: string;
  sessionID: string; messageID: string; planSha256: string; contractSha256: string;
}
export const DELEGATION_ENV = "OPENCODE_ANDROID_ORCHESTRATOR_DELEGATION_ID";
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const policyKeys = ["recovery", "execution", "stageRecovery", "continuity", "modelContinuation",
  "maxFixLoops", "deviceTestsRequired", "verificationScope", "maxPreparationFixes", "inventory"];
const digestPattern = /^[a-f0-9]{64}$/;
const safePath = (p: string) => typeof p === "string" && /^[A-Za-z0-9_./-]+$/.test(p) &&
  !p.startsWith("/") && p.split("/").every(v => v && v !== "." && v !== ".." && v !== ".git");
export function validateDelegationGrant(grant: DelegationGrant): void {
  invariant(grant && grant.version === 1 && Object.keys(grant).sort().join(",") ===
    "allowedPaths,candidateSha256,cleanupExpiresAt,commitPolicy,configSha256,expiresAt,id,originalHead,planningHead,policies,requestSha256,runId,sourceRoot,targetBranch,targetTests,taskId,upgradePaths,version,workspaceStrategy", "Invalid delegation grant fields");
  invariant(/^[A-Za-z0-9-]{1,100}$/.test(grant.id) && /^[A-Za-z0-9-]{1,100}$/.test(grant.runId) &&
    /^TASK-[A-Z0-9-]+$/.test(grant.taskId), "Invalid delegation identity");
  invariant(typeof grant.sourceRoot === "string" && grant.sourceRoot.startsWith("/") &&
    /^[a-f0-9]{40,64}$/.test(grant.originalHead) && /^[a-f0-9]{40,64}$/.test(grant.planningHead) &&
    grant.originalHead !== grant.planningHead && typeof grant.targetBranch === "string" && grant.targetBranch.length > 0,
    "Delegation requires an explicit original and upgraded planning baseline");
  invariant([grant.requestSha256, grant.candidateSha256, grant.configSha256].every(v => digestPattern.test(v)), "Invalid delegation content digest");
  for (const paths of [grant.allowedPaths, grant.upgradePaths]) invariant(Array.isArray(paths) && paths.length > 0 &&
    paths.length <= 128 && new Set(paths).size === paths.length && paths.every(safePath), "Delegation paths must be exact bounded paths");
  invariant(grant.allowedPaths.length <= 12 && !grant.allowedPaths.some(p => grant.upgradePaths.includes(p)), "Delegation upgrade overlaps business scope");
  invariant(Array.isArray(grant.targetTests) && grant.targetTests.length > 0 && grant.targetTests.length <= 16 &&
    grant.targetTests.every(t => t && Object.keys(t).sort().join(",") === "filter,gradleTask" &&
      /^(?::[A-Za-z0-9_.-]+)+$/.test(t.gradleTask) && /^[A-Za-z0-9_.$#*-]+$/.test(t.filter)), "Invalid delegated test targets");
  invariant(grant.workspaceStrategy === "isolatedWorktree" && grant.commitPolicy === "autoCommit", "Invalid delegated execution strategy");
  invariant(Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.cleanupExpiresAt) > Date.parse(grant.expiresAt), "Invalid delegation deadlines");
  invariant(grant.policies && Object.keys(grant.policies).sort().join(",") === [...policyKeys].sort().join(","), "Delegation must explicitly bind every execution policy");
}
export function delegationRecord(document: QueueDocument, id: string, at = Date.now()): DelegationRecord {
  const record = document.delegations?.find(r => r.grant.id === id);
  invariant(record, "No trusted delegation grant");
  validateDelegationGrant(record.grant);
  invariant(sha256(JSON.stringify(record.grant)) === record.grantSha256, "Delegation grant changed");
  invariant(at >= Date.parse(record.createdAt) && at < Date.parse(record.grant.expiresAt), "Delegation expired or clock moved backwards");
  invariant(document.runScope?.runId === record.grant.runId && document.runScope.taskKeys.includes(`${record.grant.taskId}@1`) &&
    Date.parse(document.runScope.expiresAt) <= Date.parse(record.grant.expiresAt) &&
    Date.parse(document.runScope.cleanupExpiresAt) <= Date.parse(record.grant.cleanupExpiresAt), "Delegation run scope changed");
  return record;
}
/** Match raw /change input or the single-argument transport emitted by OpenCode run.
 * This is not JSON or shell decoding: only embedded double quotes are escaped;
 * backslashes, newlines and whitespace in the authorized request stay literal.
 */
function matchesNativeRequest(argumentsText: string, expectedSha256: string): boolean {
  if (typeof argumentsText !== "string") return false;
  if (sha256(argumentsText) === expectedSha256) return true;
  if (!argumentsText.startsWith('"') || !argumentsText.endsWith('"')) return false;
  const request = argumentsText.slice(1, -1).replaceAll('\\"', '"');
  // The CLI wraps arguments containing a literal space. Require its exact
  // encoding, rejecting extra arguments, noncanonical escapes and extra layers.
  return request.includes(" ") &&
    '"' + request.replaceAll('"', '\\"') + '"' === argumentsText &&
    sha256(request) === expectedSha256;
}
export function bindDelegationSession(record: DelegationRecord, sessionID: string, request: string): void {
  invariant(typeof sessionID === "string" && sessionID.length > 0 && matchesNativeRequest(request, record.grant.requestSha256),
    "Native change request does not match delegated requirement");
  invariant(!record.consumedAt && (!record.sessionID || record.sessionID === sessionID), "Delegation is already bound or consumed");
  record.sessionID = sessionID;
}
export function checkDelegatedDraft(record: DelegationRecord, input: DraftInput, context: DelegationContext): void {
  const g = record.grant, c = input.contract, v = c.verification as Record<string, unknown>;
  invariant(context.id === g.id && context.sessionID === record.sessionID && context.messageID.length > 0 && !record.consumedAt,
    "Delegated draft requires the bound native change session");
  invariant(c.id === g.taskId && c.schemaVersion === 8 && input.planningHead === g.planningHead && input.targetBranch === g.targetBranch &&
    input.workspaceStrategy === g.workspaceStrategy && input.commitPolicy === g.commitPolicy &&
    !input.notBefore && !input.dependsOn?.length && !input.verificationFallbackReason, "Delegated planning or scheduling scope changed");
  invariant(JSON.stringify(c.allowedPaths) === JSON.stringify(g.allowedPaths) &&
    Number(c.maxChangedFiles) <= g.allowedPaths.length && JSON.stringify(c.targetTests) === JSON.stringify(g.targetTests), "Delegated paths or test targets changed");
  const actual = { recovery: c.recovery, execution: c.execution, stageRecovery: c.stageRecovery, continuity: c.continuity,
    modelContinuation: c.modelContinuation, maxFixLoops: c.maxFixLoops, deviceTestsRequired: c.deviceTestsRequired,
    verificationScope: v.scope ?? null, maxPreparationFixes: v.maxPreparationFixes, inventory: v.inventory };
  for (const key of policyKeys) invariant(canonical(actual[key as keyof typeof actual]) === canonical(g.policies[key]), `Delegated policy changed: ${key}`);
  invariant(!v.supplementalTests, "Delegation does not authorize supplemental test revisions");
}
export function sealDelegatedDraft(record: DelegationRecord, draft: Draft, context: DelegationContext): void {
  invariant(draft.version === 1 && !record.draft, "Delegation permits exactly one task version");
  record.requestMessage = context.messageID;
  record.draft = { key: draft.key, digest: draft.digest, planSha256: draft.planSha256, contractSha256: draft.contractSha256 };
}
export function consumeDelegation(record: DelegationRecord, draft: Draft, context: DelegationContext): DelegationProof {
  invariant(record.sessionID === context.sessionID && record.grant.id === context.id && context.messageID.length > 0 &&
    !record.consumedAt && record.draft?.key === draft.key && record.draft.digest === draft.digest &&
    record.draft.planSha256 === draft.planSha256 && record.draft.contractSha256 === draft.contractSha256, "Delegation does not match sealed draft");
  record.consumedAt = new Date().toISOString();
  return { id: context.id, grantSha256: record.grantSha256, requestSha256: record.grant.requestSha256,
    candidateSha256: record.grant.candidateSha256, sessionID: context.sessionID, messageID: context.messageID,
    planSha256: draft.planSha256, contractSha256: draft.contractSha256 };
}
