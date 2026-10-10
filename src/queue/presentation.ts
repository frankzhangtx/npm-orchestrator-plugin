import { invariant, sha256 } from "./storage.js";

// Tool limits count serialized UTF-8 bytes, including escaping and questions.
export const QUEUE_RESPONSE_MAX_BYTES = 16 * 1024;
const SUMMARY_MAX_BYTES = 12 * 1024;
type Details = Record<string, unknown>;
interface Resource { content: string; format: "json" | "text"; value: unknown }
interface Cursor {
  version: 1; key: unknown; digest: unknown; candidateId: unknown; targetHead: unknown;
  name: string; sha256: string; offset: number;
}

export function queueResponse(value: unknown): string {
  const json = JSON.stringify(value);
  invariant(Buffer.byteLength(json) <= QUEUE_RESPONSE_MAX_BYTES,
    "Queue response metadata exceeds the 16 KiB tool limit; no partial approval question was returned");
  return json;
}

function resources(details: Details): Record<string, Resource> {
  return Object.fromEntries([
    ["contract", { value: details.contract, content: JSON.stringify(details.contract), format: "json" }],
    ["plan", { value: details.plan, content: String(details.plan), format: "text" }],
    ...Object.entries(details.evidence as Record<string, unknown>).map(([name, value]) =>
      [name, { value, content: JSON.stringify(value), format: "json" }]),
  ]) as Record<string, Resource>;
}

function preview(value: unknown, depth = 2): unknown {
  if (typeof value === "string") return Array.from(value).slice(0, 180).join("");
  if (Array.isArray(value)) return { count: value.length };
  if (value && typeof value === "object") {
    if (depth === 0) return { fields: Object.keys(value).length };
    return Object.fromEntries(Object.entries(value).slice(0, 8)
      .map(([key, entry]) => [Array.from(key).slice(0, 64).join(""), preview(entry, depth - 1)]));
  }
  return value;
}

const SUMMARY_KEYS = ["valid", "state", "reasonCode", "decision", "verificationExitCode", "fullTestsExecuted",
  "summary", "originalBranchDrifted", "evidence", "bindingChecks", "reviewSummary", "elapsedSeconds",
  "schemaVersion", "title", "acceptanceCriteria", "allowedPaths", "lastFailure", "waitingReason"];
function resourceSummary(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(SUMMARY_KEYS.filter(key => Object.hasOwn(object, key)).map(key => [key, preview(object[key])]));
}

/** A presentation only: execution and authorization still use original records. */
export function compactTaskDetails(details: Details): Details {
  const fields = ["key", "taskId", "version", "state", "digest", "targetBranch", "planningHead", "currentTargetHead",
    "workspaceStrategy", "commitPolicy", "taskRoot", "runId", "sealedDiff", "candidateId", "completedCommit",
    "contractSha256", "planSha256"];
  const result: Details = Object.fromEntries(fields.map(key => [key, details[key]]));
  result.format = "task-summary-v1";
  result.pushed = false;
  result.waitingReason = preview(details.waitingReason);
  result.waitingReasonTruncated = result.waitingReason !== details.waitingReason;
  const authorization = details.authorization as Record<string, unknown>;
  result.authorization = { source: authorization.source, revoked: authorization.revoked, pushAfterAcceptance: false };
  result.evidence = Object.fromEntries(Object.entries(resources(details)).map(([name, resource]) => [name, {
    bytes: Buffer.byteLength(resource.content), sha256: sha256(resource.content), format: resource.format,
    summary: resourceSummary(resource.value),
  }]));
  result.evidenceRead = "Summaries are previews, not complete evidence. Use readEvidence with key, name and evidenceSha256 from this index; follow nextCursor for exact content. Refresh review if the candidate or evidence changes.";
  // Keep every digest and resource available, even when summaries themselves
  // contain unusually large messages. Never crop serialized approval JSON.
  if (Buffer.byteLength(JSON.stringify(result)) > SUMMARY_MAX_BYTES) {
    for (const descriptor of Object.values(result.evidence as Record<string, Record<string, unknown>>)) delete descriptor.summary;
    result.summariesOmitted = true;
  }
  invariant(Buffer.byteLength(JSON.stringify(result)) <= SUMMARY_MAX_BYTES, "Task identity exceeds the queue summary limit");
  return result;
}

/** No filesystem path is accepted; only resources already exposed by details. */
export function readTaskEvidence(details: Details, name: string, expectedSha256: string, cursor?: string): Details {
  const available = resources(details);
  invariant(Object.hasOwn(available, name), "Unknown evidence resource; use a name from task status or review");
  const resource = available[name]!;
  const digest = sha256(resource.content);
  invariant(/^[a-f0-9]{64}$/.test(expectedSha256), "Evidence digest is required from task status or review");
  invariant(digest === expectedSha256, "Evidence digest changed; refresh task status or review");
  const binding = { version: 1 as const, key: details.key, digest: details.digest, candidateId: details.candidateId,
    targetHead: details.currentTargetHead, name, sha256: digest };
  let offset = 0;
  if (cursor !== undefined) {
    invariant(cursor.length <= 8192, "Invalid evidence cursor");
    let parsed: Cursor;
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor; }
    catch { throw new Error("Invalid evidence cursor"); }
    invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.keys(parsed).length === Object.keys(binding).length + 1 &&
      Object.entries(binding).every(([key, value]) => (parsed as unknown as Details)[key] === value),
    "Evidence cursor does not match this task, candidate, target or resource");
    offset = parsed.offset;
  }
  const bytes = Buffer.from(resource.content);
  invariant(Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length &&
    (offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80), "Invalid evidence cursor offset");
  let end = Math.min(offset + 4096, bytes.length);
  for (;;) {
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    invariant(end > offset || offset === bytes.length, "Evidence identity leaves no room for forward progress");
    const result = { ...binding, bytes: bytes.length, format: resource.format, offset,
      content: bytes.subarray(offset, end).toString("utf8"),
      nextCursor: end < bytes.length ? Buffer.from(JSON.stringify({ ...binding, offset: end })).toString("base64url") : null };
    if (Buffer.byteLength(JSON.stringify(result)) <= QUEUE_RESPONSE_MAX_BYTES) return result;
    invariant(end > offset, "Evidence identity exceeds the queue response limit");
    end = offset + Math.floor((end - offset) / 2);
  }
}
