import {
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

export const COMMIT_MESSAGE_PREFIX_RELATIVE_PATH =
  "automation/automation-commit-prefix";
export const INITIAL_COMMIT_MESSAGE_PREFIX_CONTENT = [
  "# 必填：请在下一行填写当前 Git 提交文案前缀",
  "# 示例：XXX",
  "",
].join("\n");
export const COMMIT_MESSAGE_PREFIX_FILE_MAX_BYTES = 4_096;
export const COMMIT_MESSAGE_PREFIX_MAX_BYTES = 256;

export type CommitMessagePrefixMode = "required" | "disabled";

export const DEFAULT_COMMIT_MESSAGE_PREFIX_MODE: CommitMessagePrefixMode =
  "required";

export function isCommitMessagePrefixMode(
  value: unknown,
): value is CommitMessagePrefixMode {
  return value === "required" || value === "disabled";
}

export type CommitMessagePrefixInspectionStatus =
  | "disabled"
  | "missing"
  | "unconfigured"
  | "configured"
  | "invalid";

export interface CommitMessagePrefixInspection {
  path: string;
  mode: CommitMessagePrefixMode;
  status: CommitMessagePrefixInspectionStatus;
  prefix: string | null;
  details: readonly string[];
}

export type CommitMessagePrefixInitializationStatus =
  | "disabled"
  | "created-unconfigured"
  | "existing-unconfigured"
  | "existing-configured";

export interface CommitMessagePrefixInitialization {
  path: string;
  mode: CommitMessagePrefixMode;
  status: CommitMessagePrefixInitializationStatus;
}

export type CommitMessagePrefixErrorCode =
  | "COMMIT_MESSAGE_PREFIX_INVALID"
  | "COMMIT_MESSAGE_PREFIX_ROLLBACK_FAILED"
  | "COMMIT_MESSAGE_PREFIX_WRITE_FAILED";

export class CommitMessagePrefixError extends Error {
  readonly code: CommitMessagePrefixErrorCode;
  readonly details: readonly string[];

  constructor(
    code: CommitMessagePrefixErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "CommitMessagePrefixError";
    this.code = code;
    this.details = details;
  }
}

function filesystemErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function invalidInspection(
  path: string,
  mode: CommitMessagePrefixMode,
  detail: string,
): CommitMessagePrefixInspection {
  return {
    path,
    mode,
    status: "invalid",
    prefix: null,
    details: [detail],
  };
}

export function inspectCommitMessagePrefix(
  targetDirectory: string,
  mode: CommitMessagePrefixMode,
): CommitMessagePrefixInspection {
  const path = join(
    targetDirectory,
    ...COMMIT_MESSAGE_PREFIX_RELATIVE_PATH.split("/"),
  );
  if (mode === "disabled") {
    return { path, mode, status: "disabled", prefix: null, details: [] };
  }

  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") {
      return { path, mode, status: "missing", prefix: null, details: [] };
    }
    return invalidInspection(
      path,
      mode,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return invalidInspection(
      path,
      mode,
      "The commit-message prefix must be a regular file, not a symlink or directory.",
    );
  }
  if (stats.size > COMMIT_MESSAGE_PREFIX_FILE_MAX_BYTES) {
    return invalidInspection(
      path,
      mode,
      `The commit-message prefix file exceeds ${String(COMMIT_MESSAGE_PREFIX_FILE_MAX_BYTES)} bytes.`,
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    return invalidInspection(
      path,
      mode,
      `The commit-message prefix file is unreadable or is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const activeLines = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
  if (activeLines.length === 0) {
    return { path, mode, status: "unconfigured", prefix: null, details: [] };
  }
  if (activeLines.length !== 1) {
    return invalidInspection(
      path,
      mode,
      "The commit-message prefix file must contain exactly one non-comment line.",
    );
  }

  const prefix = activeLines[0] as string;
  if (prefix !== prefix.trim()) {
    return invalidInspection(
      path,
      mode,
      "The commit-message prefix must not have leading or trailing whitespace.",
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(prefix)) {
    return invalidInspection(
      path,
      mode,
      "The commit-message prefix must not contain control characters.",
    );
  }
  if (Buffer.byteLength(prefix, "utf8") > COMMIT_MESSAGE_PREFIX_MAX_BYTES) {
    return invalidInspection(
      path,
      mode,
      `The commit-message prefix exceeds ${String(COMMIT_MESSAGE_PREFIX_MAX_BYTES)} UTF-8 bytes.`,
    );
  }
  return { path, mode, status: "configured", prefix, details: [] };
}

function assertUsableInspection(
  inspection: CommitMessagePrefixInspection,
): void {
  if (inspection.status === "invalid") {
    throw new CommitMessagePrefixError(
      "COMMIT_MESSAGE_PREFIX_INVALID",
      "The commit-message prefix file is invalid.",
      [inspection.path, ...inspection.details],
    );
  }
}

export function initializeCommitMessagePrefix(
  targetDirectory: string,
  mode: CommitMessagePrefixMode,
): CommitMessagePrefixInitialization {
  const initial = inspectCommitMessagePrefix(targetDirectory, mode);
  assertUsableInspection(initial);
  if (initial.status === "disabled") {
    return { path: initial.path, mode, status: "disabled" };
  }
  if (initial.status === "configured") {
    return { path: initial.path, mode, status: "existing-configured" };
  }
  if (initial.status === "unconfigured") {
    return { path: initial.path, mode, status: "existing-unconfigured" };
  }

  try {
    writeFileSync(initial.path, INITIAL_COMMIT_MESSAGE_PREFIX_CONTENT, {
      flag: "wx",
      mode: 0o644,
    });
    return { path: initial.path, mode, status: "created-unconfigured" };
  } catch (error) {
    if (filesystemErrorCode(error) === "EEXIST") {
      const concurrent = inspectCommitMessagePrefix(targetDirectory, mode);
      assertUsableInspection(concurrent);
      if (concurrent.status === "configured") {
        return { path: concurrent.path, mode, status: "existing-configured" };
      }
      if (concurrent.status === "unconfigured") {
        return { path: concurrent.path, mode, status: "existing-unconfigured" };
      }
    }
    throw new CommitMessagePrefixError(
      "COMMIT_MESSAGE_PREFIX_WRITE_FAILED",
      `Unable to create the commit-message prefix file: ${initial.path}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

export function rollbackCommitMessagePrefixInitialization(
  initialization: CommitMessagePrefixInitialization,
): void {
  if (initialization.status !== "created-unconfigured") {
    return;
  }
  try {
    const stats = lstatSync(initialization.path);
    const content = readFileSync(initialization.path, "utf8");
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      content !== INITIAL_COMMIT_MESSAGE_PREFIX_CONTENT
    ) {
      throw new Error(
        "The automatically created prefix file changed and was preserved.",
      );
    }
    unlinkSync(initialization.path);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") {
      return;
    }
    throw new CommitMessagePrefixError(
      "COMMIT_MESSAGE_PREFIX_ROLLBACK_FAILED",
      "The automatically created commit-message prefix file could not be rolled back safely.",
      [
        error instanceof Error ? error.message : String(error),
        `Preserved path: ${initialization.path}`,
      ],
    );
  }
}
