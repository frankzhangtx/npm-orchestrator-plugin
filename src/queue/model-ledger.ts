import { invariant } from "./storage.js";
import type { ModelProcessResult } from "./model-process.js";

export interface ModelPolicy {
  version: 1; maxContinuations: number; maxCalls: number; maxElapsedMs: number; stepLimit: number;
}
export interface ModelCall {
  id: number; role: string; cycle: number; attempt: number; startedAt: number;
  checkpoint: string; continuationOf: number | null; result?: ModelProcessResult;
  stoppedCheckpoint?: string;
}
export interface ModelLedger {
  version: 1; binding: string; startedAt: number; deadline: number;
  continuations: number; calls: ModelCall[];
}

/** Mutated only inside the queue transaction, before spawning any process. */
export function reserveModelCall(ledger: ModelLedger | undefined, policy: ModelPolicy, input: {
  binding: string; checkpoint: string; role: string; cycle: number; attempt: number;
  continuationOf: number | null; now: number; deadline: number;
}): { ledger: ModelLedger; call: ModelCall } {
  ledger ??= { version: 1, binding: input.binding, startedAt: input.now,
    deadline: Math.min(input.deadline, input.now + policy.maxElapsedMs), continuations: 0, calls: [] };
  invariant(ledger.binding === input.binding, "Model authorization binding changed");
  invariant(input.now >= ledger.startedAt && input.now < Math.min(ledger.deadline, input.deadline), "Model elapsed budget exhausted");
  invariant(ledger.calls.length < policy.maxCalls, "Model call budget exhausted");
  invariant(ledger.calls.every(call => call.result?.processesExited === true), "Interrupted model call requires ownership recovery; budget cannot reset");
  if (input.continuationOf !== null) {
    const previous = ledger.calls.at(-1);
    invariant(input.role === "scheduled-coder" && previous?.role === input.role && previous.cycle === input.cycle &&
      previous.id === input.continuationOf && previous.result?.reason === "STEP_BUDGET" && previous.result.processesExited,
      "Continuation requires the immediately preceding owned coder budget stop");
    invariant(previous.stoppedCheckpoint === input.checkpoint, "Continuation checkpoint changed");
    invariant(ledger.continuations < policy.maxContinuations, "Model continuation budget exhausted");
    ledger.continuations++;
  } else {
    // Re-entering the same cycle after a stopped/unknown call must not bypass
    // the continuation guard by claiming to be a fresh invocation.
    invariant(!ledger.calls.some(call => call.role === input.role && call.cycle === input.cycle &&
      (input.role === "scheduled-coder" || call.attempt === input.attempt)), "Model invocation already consumed");
  }
  const call: ModelCall = { id: ledger.calls.length + 1, role: input.role, cycle: input.cycle, attempt: input.attempt,
    startedAt: input.now, checkpoint: input.checkpoint, continuationOf: input.continuationOf };
  ledger.calls.push(call);
  return { ledger, call };
}

export function completeModelCall(ledger: ModelLedger, id: number, result: ModelProcessResult, checkpoint: string): void {
  const call = ledger.calls.at(-1);
  invariant(call?.id === id && !call.result, "Model completion is stale or already recorded");
  invariant(result.processesExited === true && result.startedAt >= call.startedAt && result.endedAt >= result.startedAt,
    "Model completion lacks process exit evidence");
  call.result = result;
  call.stoppedCheckpoint = checkpoint;
}
