import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_LONG_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
export const MINIMUM_LONG_COMMAND_TIMEOUT_MS = 2 * 60 * 1_000;
export const MAXIMUM_LONG_COMMAND_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

export const LONG_RUNNING_AUTOMATION_SCRIPTS = [
  "accept-and-integrate.sh",
  "approve-and-run.sh",
  "claim-task.sh",
  "orchestrate-task.sh",
  "quality-gate.sh",
  "resume-review.sh",
  "resume-task.sh",
  "submit-review.sh",
  "verify-integration.sh",
  "verify-task.sh",
] as const;

export function isLongCommandTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MINIMUM_LONG_COMMAND_TIMEOUT_MS &&
    value <= MAXIMUM_LONG_COMMAND_TIMEOUT_MS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runtime loading is deliberately fail-safe for legacy installations: schema
 * validation remains the install-time authority, while a missing or malformed
 * value can never restore OpenCode's shorter default for managed long runs.
 */
export function readLongCommandTimeoutMs(worktree: string): number {
  try {
    const config = JSON.parse(
      readFileSync(join(worktree, "automation", "config.json"), "utf8"),
    ) as unknown;
    if (isRecord(config) && isLongCommandTimeoutMs(config.longCommandTimeoutMs)) {
      return config.longCommandTimeoutMs;
    }
  } catch {
    // The read-only plugin must still load so doctor can report installation issues.
  }
  return DEFAULT_LONG_COMMAND_TIMEOUT_MS;
}

export interface ToolExecutionInput {
  tool: string;
}

export interface ToolExecutionOutput {
  args: unknown;
}

function isManagedLongCommand(command: unknown): boolean {
  if (typeof command !== "string") {
    return false;
  }
  const scriptNames = LONG_RUNNING_AUTOMATION_SCRIPTS.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|");
  return new RegExp(
    `^\\s*\\./scripts/automation/(?:${scriptNames})(?:\\s|$)`,
  ).test(command);
}

/** Raise, but never shorten, the timeout for a direct managed long command. */
export function applyLongCommandTimeout(
  input: ToolExecutionInput,
  output: ToolExecutionOutput,
  configuredTimeoutMs: number,
): void {
  if (
    input.tool !== "bash" ||
    !isRecord(output.args) ||
    !isManagedLongCommand(output.args.command)
  ) {
    return;
  }
  const existing = output.args.timeout;
  if (
    typeof existing !== "number" ||
    !Number.isFinite(existing) ||
    existing < configuredTimeoutMs
  ) {
    output.args.timeout = configuredTimeoutMs;
  }
}
