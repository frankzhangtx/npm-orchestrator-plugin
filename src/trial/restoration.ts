import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, invariant, readJson } from "../queue/storage.js";

export interface RestorationOwner {
  version: 1; repository: string; runId: string; taskKey: string;
  specificationSha256: string; candidateSha256: string; evidence: string;
  originalBranch: string; originalHead: string; state: "PENDING" | "VERIFIED";
}
const file = (runtime: string) => join(runtime, "trial-restoration.json");
export function pendingRestoration(runtime: string): RestorationOwner | null {
  if (!existsSync(file(runtime))) return null;
  const owner = readJson<RestorationOwner>(file(runtime));
  invariant(owner.version === 1 && ["PENDING", "VERIFIED"].includes(owner.state) &&
    typeof owner.specificationSha256 === "string" && typeof owner.evidence === "string", "Invalid trial restoration record; recovery required");
  return owner.state === "PENDING" ? owner : null;
}
export function assertRestorationOwner(runtime: string, digest: string): void {
  const owner = pendingRestoration(runtime);
  invariant(!owner || owner.specificationSha256 === digest,
    `Unfinished trial restoration requires recovery using ${owner?.evidence}/specification.json`);
}
export function assertRestorationScope(runtime: string, runId: string, taskKeys: string[]): void {
  const owner = pendingRestoration(runtime);
  invariant(!owner || owner.runId === runId && taskKeys.length === 1 && taskKeys[0] === owner.taskKey,
    `Unfinished trial restoration prevents a new validation baseline: ${owner?.evidence}`);
}
/** Called under the repository driver lock, before switching the installation. */
export function recordRestoration(runtime: string, owner: RestorationOwner): void {
  assertRestorationOwner(runtime, owner.specificationSha256);
  atomicJson(file(runtime), owner);
}
