import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicJson, invariant, readJson, sha256 } from "../queue/storage.js";

export interface TrialLedger {
  version: 1; specificationSha256: string; candidateSha256: string; startedAt: number;
  executionDeadline: number; cleanupDeadline: number;
  phase: string; intent: string | null; error: string | null;
  upgradeHead: string | null; taskKey: string | null; result: string | null;
  events: Array<{phase: string; at: number; event: "START" | "DONE" | "FAILED"}>;
}
/** The specification contains absolute batch deadlines, never a resettable duration. */
export function openTrialLedger(directory: string, specification: unknown, candidateSha256: string,
  executionDeadline: number, cleanupDeadline: number, now = Date.now()): TrialLedger {
  invariant(/^[a-f0-9]{64}$/.test(candidateSha256) && Number.isSafeInteger(executionDeadline) &&
    Number.isSafeInteger(cleanupDeadline) && cleanupDeadline > executionDeadline, "Invalid trial identity or deadlines");
  const file = join(resolve(directory), "trial.json"), digest = sha256(JSON.stringify(specification));
  if (existsSync(file)) {
    const ledger = readJson<TrialLedger>(file);
    invariant(ledger.version === 1 && ledger.specificationSha256 === digest && ledger.candidateSha256 === candidateSha256 &&
      ledger.executionDeadline === executionDeadline && ledger.cleanupDeadline === cleanupDeadline && now >= ledger.startedAt,
      "Trial binding or original deadlines changed");
    return ledger;
  }
  invariant(now < executionDeadline, "Cannot start an expired trial");
  mkdirSync(directory, {recursive: true});
  const ledger: TrialLedger = {version: 1, specificationSha256: digest, candidateSha256, startedAt: now,
    executionDeadline, cleanupDeadline, phase: "PREPARED", intent: null, error: null,
    upgradeHead: null, taskKey: null, result: null, events: []};
  atomicJson(file, ledger); return ledger;
}
export function trialBudget(ledger: TrialLedger, cleanup = false, now = Date.now()): void {
  invariant(now >= ledger.startedAt && now < (cleanup ? ledger.cleanupDeadline : ledger.executionDeadline),
    cleanup ? "Trial cleanup deadline exhausted" : "Trial execution deadline exhausted");
}
export function recordTrialIntent(ledger: TrialLedger, phase: string, cleanup = false): void {
  trialBudget(ledger, cleanup);
  invariant(!ledger.intent && ledger.events.length < 128, "Interrupted trial operation requires reconciliation");
  ledger.intent = phase; ledger.events.push({phase, at: Date.now(), event: "START"});
}
export function finishTrialIntent(ledger: TrialLedger, phase: string): void {
  invariant(ledger.intent === phase, "Trial completion does not match its durable intent");
  ledger.phase = phase; ledger.intent = null; ledger.events.push({phase, at: Date.now(), event: "DONE"});
}
