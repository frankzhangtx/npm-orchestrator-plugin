import { createHash } from "node:crypto";
import { queuePolicy } from "./queue-policy.js";
import {
  DEFAULT_COMMIT_MESSAGE_PREFIX_MODE,
  isCommitMessagePrefixMode,
  type CommitMessagePrefixMode,
} from "./commit-message-prefix.js";

export const AUTOMATION_CONFIG_RELATIVE_PATH = "automation/config.json";
export const DEFAULT_LINT_ENABLED = false;
export const DEFAULT_UNIT_TESTS_ENABLED = true;

export interface VerificationPolicy {
  commitMessagePrefixMode: CommitMessagePrefixMode;
  lintEnabled: boolean;
  unitTestsEnabled: boolean;
}

interface ContentFingerprint {
  sha256: string;
  size: number;
  queuePolicySha256?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Authenticate managed settings independently of operator-owned queue values. */
export function queuePolicyFingerprint(path: string, content: Uint8Array): { queuePolicySha256?: string } {
  if (path !== AUTOMATION_CONFIG_RELATIVE_PATH) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.from(content).toString("utf8")); } catch { return {}; }
  if (!isRecord(value) || value.schemaVersion !== 6) return {};
  queuePolicy(value);
  return { queuePolicySha256: sha256(Buffer.from(`${JSON.stringify({ ...value, ...queuePolicy({}) }, null, 2)}\n`)) };
}

function setOptionalBoolean(
  value: Record<string, unknown>,
  key: keyof VerificationPolicy,
  configured: boolean | undefined,
): void {
  if (configured === undefined) {
    delete value[key];
  } else {
    value[key] = configured;
  }
}

function setOptionalCommitMessagePrefixMode(
  value: Record<string, unknown>,
  configured: CommitMessagePrefixMode | undefined,
): void {
  if (configured === undefined) {
    delete value.commitMessagePrefixMode;
  } else {
    value.commitMessagePrefixMode = configured;
  }
}

/**
 * Accept an otherwise byte-identical generated configuration when an operator
 * changed only supported operator policy fields. New manifests authenticate
 * managed content with queue values normalized; older manifests retain the
 * finite-state fallback. Neither path ignores changes to protected settings.
 */
export function matchesManifestModuloVerificationPolicy(
  content: Uint8Array,
  expected: ContentFingerprint,
): boolean {
  if (
    content.byteLength === expected.size &&
    sha256(content) === expected.sha256
  ) {
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  if (
    typeof parsed.lintEnabled !== "boolean" ||
    typeof parsed.unitTestsEnabled !== "boolean" ||
    (parsed.commitMessagePrefixMode !== undefined &&
      !isCommitMessagePrefixMode(parsed.commitMessagePrefixMode))
  ) {
    return false;
  }

  const states: readonly (boolean | undefined)[] = [undefined, false, true];
  if (parsed.schemaVersion === 6) {
    try { queuePolicy(parsed); } catch { return false; }
  }
  const queueCandidates = parsed.schemaVersion === 6
    ? [parsed, ...["inPlaceExclusive", "isolatedWorktree"].flatMap(workspaceStrategy =>
      ["humanApproval", "autoCommit"].flatMap(commitPolicy => [
        { ...parsed, workspaceStrategy, commitPolicy },
        { ...parsed, workspaceStrategy, commitPolicy, worktreeBase: "", queue: { scanIntervalMs: 5000, maxWorkspaces: 3, maxWorkspaceBytes: 20 * 1024 ** 3 } },
      ]))]
    : [parsed];
  const prefixModes: readonly (CommitMessagePrefixMode | undefined)[] = [
    undefined,
    DEFAULT_COMMIT_MESSAGE_PREFIX_MODE,
    "disabled",
  ];
  for (const policyCandidate of queueCandidates) {
    for (const commitMessagePrefixMode of prefixModes) {
      for (const unitTestsEnabled of states) {
        for (const lintEnabled of states) {
          const candidate = { ...policyCandidate };
          setOptionalCommitMessagePrefixMode(candidate, commitMessagePrefixMode);
          setOptionalBoolean(candidate, "unitTestsEnabled", unitTestsEnabled);
          setOptionalBoolean(candidate, "lintEnabled", lintEnabled);
          const rendered = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
          if (
            (rendered.byteLength === expected.size && sha256(rendered) === expected.sha256) ||
            (expected.queuePolicySha256 !== undefined &&
              sha256(Buffer.from(`${JSON.stringify({ ...candidate, ...queuePolicy({}) }, null, 2)}\n`)) === expected.queuePolicySha256)
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}
