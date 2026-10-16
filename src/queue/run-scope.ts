import { invariant } from "./storage.js";

export const MAX_TRIAL_CANDIDATES = 5;

/** Durable restriction. Expiration closes execution; it never removes the filter. */
export interface RunScope {
  version: 1;
  runId: string;
  taskKeys: string[];
  expiresAt: string;
  cleanupExpiresAt: string;
}
export function validateRunScope(value: RunScope): void {
  invariant(value && value.version === 1 && Object.keys(value).sort().join(",") === "cleanupExpiresAt,expiresAt,runId,taskKeys,version", "Invalid run scope");
  invariant(typeof value.runId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value.runId), "Invalid run scope identity");
  invariant(Array.isArray(value.taskKeys) && value.taskKeys.length > 0 && value.taskKeys.length <= MAX_TRIAL_CANDIDATES &&
    value.taskKeys.every(key => typeof key === "string" && /^TASK-[A-Z0-9-]+@[1-9][0-9]*$/.test(key)) &&
    new Set(value.taskKeys).size === value.taskKeys.length, "Invalid run scope task keys");
  invariant(typeof value.expiresAt === "string" && typeof value.cleanupExpiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) && Number.isFinite(Date.parse(value.cleanupExpiresAt)) &&
    Date.parse(value.cleanupExpiresAt) >= Date.parse(value.expiresAt), "Invalid run scope deadlines");
}
export function scopeAllows(scope: RunScope | undefined, key: string, cleanup = false, at = Date.now()): boolean {
  if (scope === undefined) return true;
  validateRunScope(scope);
  return scope.taskKeys.includes(key) && at < Date.parse(cleanup ? scope.cleanupExpiresAt : scope.expiresAt);
}
