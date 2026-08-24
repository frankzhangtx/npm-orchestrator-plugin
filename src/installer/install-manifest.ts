import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
  posix,
  resolve,
} from "node:path";

import {
  ORCHESTRATOR_PACKAGE_NAME,
  ORCHESTRATOR_PACKAGE_VERSION,
} from "./opencode-config.js";

export const INSTALLATION_MANIFEST_SCHEMA_VERSION = 1;
export const INSTALLATION_CONTROL_DIRECTORY = ".automation-plugin";
export const INSTALLATION_MANIFEST_RELATIVE_PATH =
  `${INSTALLATION_CONTROL_DIRECTORY}/manifest.json`;
export const INSTALLATION_BACKUPS_DIRECTORY =
  `${INSTALLATION_CONTROL_DIRECTORY}/backups`;
export const INSTALLATION_HISTORY_DIRECTORY =
  `${INSTALLATION_CONTROL_DIRECTORY}/history`;

export type InstallationManifestState =
  | "prepared"
  | "installed"
  | "rolledBack";
export type InstallationFileStrategy = "copy" | "generate" | "merge";
export type InstallationConflictKind =
  | "content"
  | "mode"
  | "content-and-mode";

export type InstallationManifestErrorCode =
  | "BACKUP_EXISTS"
  | "BACKUP_INTEGRITY_FAILED"
  | "BACKUP_WRITE_FAILED"
  | "CONTROL_PATH_CONFLICT"
  | "DUPLICATE_FILE"
  | "FILE_CONFLICT"
  | "FILE_NOT_REGULAR"
  | "FILE_SYMLINK"
  | "INSTALLATION_INCOMPLETE"
  | "INSTALLATION_ROLLBACK_FAILED"
  | "INSTALLATION_WRITE_FAILED"
  | "INVALID_FILE_PATH"
  | "INVALID_INSTALLATION_ID"
  | "INVALID_TIMESTAMP"
  | "MANIFEST_EXISTS"
  | "MANIFEST_INVALID"
  | "MANIFEST_MISSING"
  | "MANIFEST_STATE"
  | "MANIFEST_WRITE_FAILED"
  | "PLAN_STALE"
  | "ROLLBACK_FAILED"
  | "TARGET_MODIFIED"
  | "TARGET_NOT_DIRECTORY"
  | "TARGET_SYMLINK";

export class InstallationManifestError extends Error {
  readonly code: InstallationManifestErrorCode;
  readonly details: readonly string[];

  constructor(
    code: InstallationManifestErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "InstallationManifestError";
    this.code = code;
    this.details = details;
  }
}

export interface InstallationFileInput {
  path: string;
  source: string;
  strategy: InstallationFileStrategy;
  content: string | Uint8Array;
  mode?: number;
}

export interface InstallationFileConflict {
  path: string;
  source: string;
  strategy: InstallationFileStrategy;
  kind: InstallationConflictKind;
  existingSha256: string;
  desiredSha256: string;
  existingSize: number;
  desiredSize: number;
  existingMode: number;
  desiredMode: number;
}

export interface InstallationConflictReport {
  ok: boolean;
  targetDirectory: string;
  conflicts: readonly InstallationFileConflict[];
}

export interface PreviousInstallationFile {
  existed: boolean;
  sha256: string | null;
  size: number | null;
  mode: number | null;
  backupPath: string | null;
}

export interface InstallationManifestFile {
  path: string;
  source: string;
  strategy: InstallationFileStrategy;
  sha256: string;
  size: number;
  mode: number;
  previous: PreviousInstallationFile;
}

export interface InstallationManifest {
  schemaVersion: 1;
  package: {
    name: string;
    version: string;
  };
  installation: {
    id: string;
    state: InstallationManifestState;
    preparedAt: string;
    installedAt: string | null;
    rolledBackAt: string | null;
  };
  backupDirectory: string;
  files: readonly InstallationManifestFile[];
}

export interface InstallationPreparationOptions {
  installationId?: string;
  preparedAt?: string;
}

export interface PlannedInstallationFile {
  absolutePath: string;
  content: Uint8Array;
  previousContent: Uint8Array | null;
  manifest: InstallationManifestFile;
}

export interface InstallationPreparationPlan {
  targetDirectory: string;
  controlDirectory: string;
  manifestPath: string;
  backupDirectory: string;
  manifest: InstallationManifest;
  manifestContent: string;
  files: readonly PlannedInstallationFile[];
}

export interface PreparedInstallation {
  manifestPath: string;
  backupDirectory: string;
  manifestSha256: string;
  backedUpFileCount: number;
  manifest: InstallationManifest;
}

export interface InstallationApplyOptions {
  installedAt?: string;
  verify?: () => void;
}

export interface AppliedInstallation {
  prepared: PreparedInstallation;
  manifest: InstallationManifest;
  writtenFileCount: number;
  reusedFileCount: number;
}

export type InstallationIntegrityStatus =
  | "match"
  | "mismatch"
  | "missing"
  | "not-required"
  | "not-checked";

export interface InstallationIntegrityCheck {
  path: string;
  installed: InstallationIntegrityStatus;
  backup: InstallationIntegrityStatus;
}

export interface InstallationIntegrityReport {
  ok: boolean;
  manifest: InstallationManifest;
  checks: readonly InstallationIntegrityCheck[];
}

export interface InstallationCompletionOptions {
  installedAt?: string;
}

export interface InstallationRollbackOptions {
  rolledBackAt?: string;
}

interface FileSnapshot {
  existed: boolean;
  content: Uint8Array | null;
  sha256: string | null;
  size: number | null;
  mode: number | null;
}

interface AnalyzedInstallationFile {
  path: string;
  source: string;
  strategy: InstallationFileStrategy;
  content: Uint8Array;
  sha256: string;
  size: number;
  mode: number;
  previous: FileSnapshot;
}

interface LoadedManifest {
  manifest: InstallationManifest;
  content: string;
  sha256: string;
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

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function contentBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === "string") {
    return Buffer.from(content, "utf8");
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  throw new InstallationManifestError(
    "MANIFEST_INVALID",
    "Planned installation content must be a string or Uint8Array.",
  );
}

function validateMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new InstallationManifestError(
      "MANIFEST_INVALID",
      `File mode must be an integer between 0 and 0777: ${String(mode)}`,
    );
  }
  return mode;
}

function validateRelativePath(path: string, source = false): string {
  const label = source ? "source" : "target";
  if (
    path.length === 0 ||
    path.trim() !== path ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.isAbsolute(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..") ||
    posix.normalize(path) !== path ||
    path.endsWith("/")
  ) {
    throw new InstallationManifestError(
      "INVALID_FILE_PATH",
      `Installation ${label} path must be canonical and repository-relative: ${path}`,
    );
  }
  if (
    !source &&
    (path === INSTALLATION_CONTROL_DIRECTORY ||
      path.startsWith(`${INSTALLATION_CONTROL_DIRECTORY}/`))
  ) {
    throw new InstallationManifestError(
      "INVALID_FILE_PATH",
      `Managed files cannot overwrite installer control state: ${path}`,
    );
  }
  return path;
}

function validateTimestamp(value: string): string {
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new InstallationManifestError(
      "INVALID_TIMESTAMP",
      `Timestamp must be a canonical UTC ISO-8601 value: ${value}`,
    );
  }
  return value;
}

function validateInstallationId(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new InstallationManifestError(
      "INVALID_INSTALLATION_ID",
      `Installation ID is not safe: ${value}`,
    );
  }
  return value;
}

function defaultInstallationId(preparedAt: string): string {
  return validateInstallationId(
    `${preparedAt.replace(/[-:.TZ]/g, "")}-${randomUUID()}`,
  );
}

function resolveTargetDirectory(directory: string): string {
  const targetDirectory = resolve(directory);
  try {
    const stats = lstatSync(targetDirectory);
    if (stats.isSymbolicLink()) {
      throw new InstallationManifestError(
        "TARGET_SYMLINK",
        `Installation target cannot be a symbolic link: ${targetDirectory}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new InstallationManifestError(
        "TARGET_NOT_DIRECTORY",
        `Installation target is not a directory: ${targetDirectory}`,
      );
    }
  } catch (error) {
    if (error instanceof InstallationManifestError) {
      throw error;
    }
    throw new InstallationManifestError(
      "TARGET_NOT_DIRECTORY",
      `Installation target does not exist or cannot be inspected: ${targetDirectory}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  return targetDirectory;
}

function assertSafeAncestors(
  targetDirectory: string,
  relativePath: string,
): void {
  const segments = relativePath.split("/");
  let currentPath = targetDirectory;

  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment);
    try {
      const stats = lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        throw new InstallationManifestError(
          "FILE_SYMLINK",
          `Installation path has a symbolic-link ancestor: ${currentPath}`,
        );
      }
      if (!stats.isDirectory()) {
        throw new InstallationManifestError(
          "FILE_NOT_REGULAR",
          `Installation path parent is not a directory: ${currentPath}`,
        );
      }
    } catch (error) {
      if (error instanceof InstallationManifestError) {
        throw error;
      }
      if (filesystemErrorCode(error) === "ENOENT") {
        return;
      }
      throw new InstallationManifestError(
        "FILE_NOT_REGULAR",
        `Unable to inspect installation path parent: ${currentPath}`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }
}

function snapshotFile(
  targetDirectory: string,
  relativePath: string,
): FileSnapshot {
  assertSafeAncestors(targetDirectory, relativePath);
  const absolutePath = join(targetDirectory, ...relativePath.split("/"));

  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new InstallationManifestError(
        "FILE_SYMLINK",
        `Refusing to manage a symbolic-link file: ${absolutePath}`,
      );
    }
    if (!stats.isFile()) {
      throw new InstallationManifestError(
        "FILE_NOT_REGULAR",
        `Managed path is not a regular file: ${absolutePath}`,
      );
    }
    const content = readFileSync(absolutePath);
    return {
      existed: true,
      content,
      sha256: sha256(content),
      size: content.byteLength,
      mode: stats.mode & 0o777,
    };
  } catch (error) {
    if (error instanceof InstallationManifestError) {
      throw error;
    }
    if (filesystemErrorCode(error) === "ENOENT") {
      return {
        existed: false,
        content: null,
        sha256: null,
        size: null,
        mode: null,
      };
    }
    throw new InstallationManifestError(
      "FILE_NOT_REGULAR",
      `Unable to inspect managed path: ${absolutePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function analyzeInstallationInputs(
  targetDirectory: string,
  inputs: readonly InstallationFileInput[],
): readonly AnalyzedInstallationFile[] {
  if (inputs.length === 0) {
    throw new InstallationManifestError(
      "MANIFEST_INVALID",
      "Installation plan must contain at least one managed file.",
    );
  }

  const seen = new Set<string>();
  return inputs
    .map<AnalyzedInstallationFile>((input) => {
      const relativePath = validateRelativePath(input.path);
      const source = validateRelativePath(input.source, true);
      if (seen.has(relativePath)) {
        throw new InstallationManifestError(
          "DUPLICATE_FILE",
          `Installation plan contains a duplicate path: ${relativePath}`,
        );
      }
      seen.add(relativePath);

      if (
        !("copy" === input.strategy ||
          "generate" === input.strategy ||
          "merge" === input.strategy)
      ) {
        throw new InstallationManifestError(
          "MANIFEST_INVALID",
          `Installation strategy is invalid for ${relativePath}: ${String(input.strategy)}`,
        );
      }

      const content = contentBytes(input.content);
      const previous = snapshotFile(targetDirectory, relativePath);
      const mode = validateMode(input.mode ?? previous.mode ?? 0o644);
      return {
        path: relativePath,
        source,
        strategy: input.strategy,
        content,
        sha256: sha256(content),
        size: content.byteLength,
        mode,
        previous,
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

function installationFileConflict(
  file: AnalyzedInstallationFile,
): InstallationFileConflict | null {
  if (!file.previous.existed) {
    return null;
  }
  const {
    sha256: existingSha256,
    size: existingSize,
    mode: existingMode,
  } = file.previous;
  if (
    existingSha256 === null ||
    existingSize === null ||
    existingMode === null
  ) {
    throw new InstallationManifestError(
      "MANIFEST_INVALID",
      `Existing-file snapshot is incomplete: ${file.path}`,
    );
  }

  const contentDiffers =
    existingSha256 !== file.sha256 || existingSize !== file.size;
  const contentConflict = contentDiffers && file.strategy !== "merge";
  const modeConflict = existingMode !== file.mode;
  if (!contentConflict && !modeConflict) {
    return null;
  }

  const kind: InstallationConflictKind =
    contentConflict && modeConflict
      ? "content-and-mode"
      : contentConflict
        ? "content"
        : "mode";
  return {
    path: file.path,
    source: file.source,
    strategy: file.strategy,
    kind,
    existingSha256,
    desiredSha256: file.sha256,
    existingSize,
    desiredSize: file.size,
    existingMode,
    desiredMode: file.mode,
  };
}

function installationConflicts(
  files: readonly AnalyzedInstallationFile[],
): readonly InstallationFileConflict[] {
  return files
    .map(installationFileConflict)
    .filter(
      (conflict): conflict is InstallationFileConflict => conflict !== null,
    );
}

function formatMode(mode: number): string {
  return `0o${mode.toString(8).padStart(3, "0")}`;
}

function assertNoInstallationConflicts(
  conflicts: readonly InstallationFileConflict[],
): void {
  if (conflicts.length === 0) {
    return;
  }
  throw new InstallationManifestError(
    "FILE_CONFLICT",
    "Installation stopped because existing files differ; no user file was overwritten.",
    conflicts.map(
      (conflict) =>
        `${conflict.path}: ${conflict.kind} conflict ` +
        `(existing ${conflict.existingSha256}, ` +
        `${formatMode(conflict.existingMode)}; ` +
        `desired ${conflict.desiredSha256}, ${formatMode(conflict.desiredMode)})`,
    ),
  );
}

function snapshotsMatch(
  actual: FileSnapshot,
  expected: PreviousInstallationFile,
): boolean {
  return (
    actual.existed === expected.existed &&
    actual.sha256 === expected.sha256 &&
    actual.size === expected.size &&
    actual.mode === expected.mode
  );
}

function snapshotMatchesManifestFile(
  snapshot: FileSnapshot,
  file: InstallationManifestFile,
): boolean {
  return (
    snapshot.existed &&
    snapshot.sha256 === file.sha256 &&
    snapshot.size === file.size &&
    snapshot.mode === file.mode
  );
}

function createDirectory(path: string, mode = 0o700): boolean {
  try {
    mkdirSync(path, { mode });
    return true;
  } catch (error) {
    if (filesystemErrorCode(error) !== "EEXIST") {
      throw error;
    }
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new InstallationManifestError(
        "CONTROL_PATH_CONFLICT",
        `Installer control path is not a regular directory: ${path}`,
      );
    }
    return false;
  }
}

function assertPathMissing(path: string, code: InstallationManifestErrorCode): void {
  try {
    lstatSync(path);
    throw new InstallationManifestError(
      code,
      `Installer path already exists: ${path}`,
    );
  } catch (error) {
    if (error instanceof InstallationManifestError) {
      throw error;
    }
    if (filesystemErrorCode(error) !== "ENOENT") {
      throw new InstallationManifestError(
        code,
        `Unable to inspect installer path: ${path}`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }
}

function publishNewFile(
  path: string,
  content: string | Uint8Array,
  mode: number,
): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    writeFileSync(temporaryPath, content, { flag: "wx", mode });
    chmodSync(temporaryPath, mode);
    linkSync(temporaryPath, path);
    published = true;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!published && filesystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
}

function atomicReplaceFile(
  path: string,
  content: string | Uint8Array,
  mode: number,
): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { flag: "wx", mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
}

function safeRemoveDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (
      filesystemErrorCode(error) !== "ENOENT" &&
      filesystemErrorCode(error) !== "ENOTEMPTY"
    ) {
      throw error;
    }
  }
}

function createManagedParentDirectories(
  targetDirectory: string,
  relativePath: string,
  createdDirectories: string[],
): void {
  const segments = relativePath.split("/").slice(0, -1);
  let currentPath = targetDirectory;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    try {
      const stats = lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        throw new InstallationManifestError(
          "FILE_SYMLINK",
          `Installation path has a symbolic-link ancestor: ${currentPath}`,
        );
      }
      if (!stats.isDirectory()) {
        throw new InstallationManifestError(
          "FILE_NOT_REGULAR",
          `Installation path parent is not a directory: ${currentPath}`,
        );
      }
    } catch (error) {
      if (error instanceof InstallationManifestError) {
        throw error;
      }
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
      try {
        mkdirSync(currentPath, { mode: 0o755 });
        createdDirectories.push(currentPath);
      } catch (mkdirError) {
        if (filesystemErrorCode(mkdirError) !== "EEXIST") {
          throw mkdirError;
        }
        const stats = lstatSync(currentPath);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new InstallationManifestError(
            stats.isSymbolicLink() ? "FILE_SYMLINK" : "FILE_NOT_REGULAR",
            `Installation path parent changed while it was created: ${currentPath}`,
          );
        }
      }
    }
  }
}

function cleanupCreatedDirectories(createdDirectories: readonly string[]): void {
  for (const directory of [...createdDirectories].reverse()) {
    safeRemoveDirectory(directory);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") ===
    [...expected].sort().join("\0")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNullableTimestamp(value: unknown): value is string | null {
  if (value === null) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  try {
    validateTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

function invalidManifest(message: string): never {
  throw new InstallationManifestError(
    "MANIFEST_INVALID",
    message,
  );
}

function parseManifest(content: string): InstallationManifest {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new InstallationManifestError(
      "MANIFEST_INVALID",
      "Installation manifest is not valid JSON.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "package",
      "installation",
      "backupDirectory",
      "files",
    ]) ||
    value.schemaVersion !== INSTALLATION_MANIFEST_SCHEMA_VERSION ||
    !isRecord(value.package) ||
    !exactKeys(value.package, ["name", "version"]) ||
    typeof value.package.name !== "string" ||
    value.package.name.length === 0 ||
    typeof value.package.version !== "string" ||
    value.package.version.length === 0 ||
    !isRecord(value.installation) ||
    !exactKeys(value.installation, [
      "id",
      "state",
      "preparedAt",
      "installedAt",
      "rolledBackAt",
    ]) ||
    typeof value.installation.id !== "string" ||
    typeof value.installation.state !== "string" ||
    !["prepared", "installed", "rolledBack"].includes(
      value.installation.state,
    ) ||
    typeof value.installation.preparedAt !== "string" ||
    !isNullableTimestamp(value.installation.installedAt) ||
    !isNullableTimestamp(value.installation.rolledBackAt) ||
    typeof value.backupDirectory !== "string" ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    return invalidManifest("Installation manifest structure is invalid.");
  }

  try {
    validateInstallationId(value.installation.id);
    validateTimestamp(value.installation.preparedAt);
  } catch (error) {
    throw new InstallationManifestError(
      "MANIFEST_INVALID",
      "Installation manifest identity or timestamps are invalid.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const state = value.installation.state as InstallationManifestState;
  if (
    (state === "prepared" &&
      (value.installation.installedAt !== null ||
        value.installation.rolledBackAt !== null)) ||
    (state === "installed" &&
      (value.installation.installedAt === null ||
        value.installation.rolledBackAt !== null)) ||
    (state === "rolledBack" && value.installation.rolledBackAt === null)
  ) {
    return invalidManifest("Installation manifest state timestamps are inconsistent.");
  }

  const expectedBackupDirectory =
    `${INSTALLATION_BACKUPS_DIRECTORY}/${value.installation.id}`;
  if (value.backupDirectory !== expectedBackupDirectory) {
    return invalidManifest("Installation manifest backup directory is inconsistent.");
  }

  const files: InstallationManifestFile[] = [];
  const seen = new Set<string>();
  for (const candidate of value.files) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, [
        "path",
        "source",
        "strategy",
        "sha256",
        "size",
        "mode",
        "previous",
      ]) ||
      typeof candidate.path !== "string" ||
      typeof candidate.source !== "string" ||
      typeof candidate.strategy !== "string" ||
      !["copy", "generate", "merge"].includes(candidate.strategy) ||
      !isSha256(candidate.sha256) ||
      !Number.isInteger(candidate.size) ||
      (candidate.size as number) < 0 ||
      !Number.isInteger(candidate.mode) ||
      (candidate.mode as number) < 0 ||
      (candidate.mode as number) > 0o777 ||
      !isRecord(candidate.previous) ||
      !exactKeys(candidate.previous, [
        "existed",
        "sha256",
        "size",
        "mode",
        "backupPath",
      ]) ||
      typeof candidate.previous.existed !== "boolean"
    ) {
      return invalidManifest("Installation manifest contains an invalid file entry.");
    }

    try {
      validateRelativePath(candidate.path);
      validateRelativePath(candidate.source, true);
    } catch (error) {
      throw new InstallationManifestError(
        "MANIFEST_INVALID",
        "Installation manifest contains an unsafe path.",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    if (seen.has(candidate.path)) {
      return invalidManifest("Installation manifest contains duplicate file paths.");
    }
    seen.add(candidate.path);

    const previous = candidate.previous;
    const expectedBackupPath = previous.existed
      ? `${expectedBackupDirectory}/${candidate.path}`
      : null;
    if (
      previous.backupPath !== expectedBackupPath ||
      (previous.existed &&
        (!isSha256(previous.sha256) ||
          !Number.isInteger(previous.size) ||
          (previous.size as number) < 0 ||
          !Number.isInteger(previous.mode) ||
          (previous.mode as number) < 0 ||
          (previous.mode as number) > 0o777)) ||
      (!previous.existed &&
        (previous.sha256 !== null ||
          previous.size !== null ||
          previous.mode !== null))
    ) {
      return invalidManifest("Installation manifest previous-file metadata is invalid.");
    }

    files.push(candidate as unknown as InstallationManifestFile);
  }

  const sortedPaths = files.map((file) => file.path).sort();
  if (!files.every((file, index) => file.path === sortedPaths[index])) {
    return invalidManifest("Installation manifest files must be sorted by path.");
  }

  return {
    schemaVersion: INSTALLATION_MANIFEST_SCHEMA_VERSION,
    package: {
      name: value.package.name,
      version: value.package.version,
    },
    installation: {
      id: value.installation.id,
      state,
      preparedAt: value.installation.preparedAt,
      installedAt: value.installation.installedAt,
      rolledBackAt: value.installation.rolledBackAt,
    },
    backupDirectory: value.backupDirectory,
    files,
  };
}

function loadInstallationManifest(targetDirectory: string): LoadedManifest {
  const resolvedTarget = resolveTargetDirectory(targetDirectory);
  assertSafeAncestors(resolvedTarget, INSTALLATION_MANIFEST_RELATIVE_PATH);
  const manifestPath = join(
    resolvedTarget,
    ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
  );
  let content: string;

  try {
    const stats = lstatSync(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new InstallationManifestError(
        "MANIFEST_INVALID",
        `Installation manifest is not a regular file: ${manifestPath}`,
      );
    }
    content = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (error instanceof InstallationManifestError) {
      throw error;
    }
    if (filesystemErrorCode(error) === "ENOENT") {
      throw new InstallationManifestError(
        "MANIFEST_MISSING",
        `Installation manifest does not exist: ${manifestPath}`,
      );
    }
    throw new InstallationManifestError(
      "MANIFEST_INVALID",
      `Unable to read installation manifest: ${manifestPath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  return {
    manifest: parseManifest(content),
    content,
    sha256: sha256(content),
  };
}

function backupSnapshot(
  targetDirectory: string,
  file: InstallationManifestFile,
): FileSnapshot {
  if (!file.previous.existed || file.previous.backupPath === null) {
    return {
      existed: false,
      content: null,
      sha256: null,
      size: null,
      mode: null,
    };
  }
  return snapshotFile(targetDirectory, file.previous.backupPath);
}

function backupMatches(
  targetDirectory: string,
  file: InstallationManifestFile,
): boolean {
  if (!file.previous.existed) {
    return true;
  }
  const backup = backupSnapshot(targetDirectory, file);
  return snapshotsMatch(backup, file.previous);
}

function assertBackupIntegrity(
  targetDirectory: string,
  manifest: InstallationManifest,
): void {
  const failed = manifest.files
    .filter((file) => !backupMatches(targetDirectory, file))
    .map((file) => file.path);
  if (failed.length > 0) {
    throw new InstallationManifestError(
      "BACKUP_INTEGRITY_FAILED",
      "One or more installation backups failed SHA-256, size, or mode verification.",
      failed,
    );
  }
}

function assertManifestUnchanged(
  targetDirectory: string,
  expectedSha256: string,
): void {
  const manifestPath = join(
    targetDirectory,
    ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
  );
  let actual: string;
  try {
    actual = sha256(readFileSync(manifestPath));
  } catch (error) {
    throw new InstallationManifestError(
      "PLAN_STALE",
      "Installation manifest changed while the transaction was running.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
  if (actual !== expectedSha256) {
    throw new InstallationManifestError(
      "PLAN_STALE",
      "Installation manifest changed while the transaction was running.",
    );
  }
}

export function detectInstallationConflicts(
  directory: string,
  inputs: readonly InstallationFileInput[],
): InstallationConflictReport {
  const targetDirectory = resolveTargetDirectory(directory);
  const files = analyzeInstallationInputs(targetDirectory, inputs);
  const conflicts = installationConflicts(files);
  return {
    ok: conflicts.length === 0,
    targetDirectory,
    conflicts,
  };
}

export function planInstallationPreparation(
  directory: string,
  inputs: readonly InstallationFileInput[],
  options: InstallationPreparationOptions = {},
): InstallationPreparationPlan {
  const targetDirectory = resolveTargetDirectory(directory);
  const analyzedFiles = analyzeInstallationInputs(targetDirectory, inputs);
  assertNoInstallationConflicts(installationConflicts(analyzedFiles));

  const preparedAt = validateTimestamp(
    options.preparedAt ?? new Date().toISOString(),
  );
  const installationId = validateInstallationId(
    options.installationId ?? defaultInstallationId(preparedAt),
  );
  const backupRelativeDirectory =
    `${INSTALLATION_BACKUPS_DIRECTORY}/${installationId}`;

  const files = analyzedFiles.map<PlannedInstallationFile>((file) => {
    const previousManifest: PreviousInstallationFile = file.previous.existed
      ? {
          existed: true,
          sha256: file.previous.sha256,
          size: file.previous.size,
          mode: file.previous.mode,
          backupPath: `${backupRelativeDirectory}/${file.path}`,
        }
      : {
          existed: false,
          sha256: null,
          size: null,
          mode: null,
          backupPath: null,
        };

    return {
      absolutePath: join(targetDirectory, ...file.path.split("/")),
      content: file.content,
      previousContent: file.previous.content,
      manifest: {
        path: file.path,
        source: file.source,
        strategy: file.strategy,
        sha256: file.sha256,
        size: file.size,
        mode: file.mode,
        previous: previousManifest,
      },
    };
  });

  const manifest: InstallationManifest = {
    schemaVersion: INSTALLATION_MANIFEST_SCHEMA_VERSION,
    package: {
      name: ORCHESTRATOR_PACKAGE_NAME,
      version: ORCHESTRATOR_PACKAGE_VERSION,
    },
    installation: {
      id: installationId,
      state: "prepared",
      preparedAt,
      installedAt: null,
      rolledBackAt: null,
    },
    backupDirectory: backupRelativeDirectory,
    files: files.map((file) => file.manifest),
  };
  const controlDirectory = join(targetDirectory, INSTALLATION_CONTROL_DIRECTORY);

  return {
    targetDirectory,
    controlDirectory,
    manifestPath: join(
      targetDirectory,
      ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
    ),
    backupDirectory: join(
      targetDirectory,
      ...backupRelativeDirectory.split("/"),
    ),
    manifest,
    manifestContent: serialize(manifest),
    files,
  };
}

function assertPreparationPlanConsistent(
  plan: InstallationPreparationPlan,
  targetDirectory: string,
): void {
  let parsedManifest: InstallationManifest;
  try {
    parsedManifest = parseManifest(plan.manifestContent);
  } catch (error) {
    throw new InstallationManifestError(
      "PLAN_STALE",
      "Installation plan manifest content is no longer valid.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const expectedControlDirectory = join(
    targetDirectory,
    INSTALLATION_CONTROL_DIRECTORY,
  );
  const expectedManifestPath = join(
    targetDirectory,
    ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
  );
  const expectedBackupDirectory = join(
    targetDirectory,
    ...parsedManifest.backupDirectory.split("/"),
  );
  const canonicalManifestContent = serialize(parsedManifest);
  const planEntriesMatch =
    plan.files.length === parsedManifest.files.length &&
    plan.files.every((file, index) => {
      const manifestFile = parsedManifest.files[index];
      return (
        manifestFile !== undefined &&
        JSON.stringify(file.manifest) === JSON.stringify(manifestFile) &&
        file.absolutePath ===
          join(targetDirectory, ...manifestFile.path.split("/"))
      );
    });

  if (
    plan.targetDirectory !== targetDirectory ||
    plan.controlDirectory !== expectedControlDirectory ||
    plan.manifestPath !== expectedManifestPath ||
    plan.backupDirectory !== expectedBackupDirectory ||
    plan.manifestContent !== canonicalManifestContent ||
    serialize(plan.manifest) !== canonicalManifestContent ||
    parsedManifest.installation.state !== "prepared" ||
    parsedManifest.package.name !== ORCHESTRATOR_PACKAGE_NAME ||
    parsedManifest.package.version !== ORCHESTRATOR_PACKAGE_VERSION ||
    !planEntriesMatch
  ) {
    throw new InstallationManifestError(
      "PLAN_STALE",
      "Installation plan paths or manifest metadata changed after planning.",
    );
  }
}

export function prepareInstallationBackup(
  plan: InstallationPreparationPlan,
): PreparedInstallation {
  const targetDirectory = resolveTargetDirectory(plan.targetDirectory);
  assertPreparationPlanConsistent(plan, targetDirectory);

  assertPathMissing(plan.manifestPath, "MANIFEST_EXISTS");
  assertPathMissing(plan.backupDirectory, "BACKUP_EXISTS");
  for (const file of plan.files) {
    const actual = snapshotFile(targetDirectory, file.manifest.path);
    if (!snapshotsMatch(actual, file.manifest.previous)) {
      throw new InstallationManifestError(
        "PLAN_STALE",
        `Managed file changed after installation planning: ${file.manifest.path}`,
      );
    }
    if (
      sha256(file.content) !== file.manifest.sha256 ||
      file.content.byteLength !== file.manifest.size
    ) {
      throw new InstallationManifestError(
        "PLAN_STALE",
        `Planned content changed after installation planning: ${file.manifest.path}`,
      );
    }
  }

  const backupsRoot = join(targetDirectory, INSTALLATION_BACKUPS_DIRECTORY);
  const stagingDirectory = join(
    plan.controlDirectory,
    `.staging-${plan.manifest.installation.id}`,
  );
  let createdControl = false;
  let createdBackupsRoot = false;
  let backupPublished = false;
  let manifestPublished = false;

  try {
    createdControl = createDirectory(plan.controlDirectory);
    createdBackupsRoot = createDirectory(backupsRoot);
    assertPathMissing(stagingDirectory, "BACKUP_EXISTS");
    mkdirSync(stagingDirectory, { mode: 0o700 });

    for (const file of plan.files) {
      if (
        !file.manifest.previous.existed ||
        file.previousContent === null
      ) {
        continue;
      }
      const backupPath = join(
        stagingDirectory,
        ...file.manifest.path.split("/"),
      );
      mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
      writeFileSync(backupPath, file.previousContent, {
        flag: "wx",
        mode: file.manifest.previous.mode ?? 0o600,
      });
      chmodSync(backupPath, file.manifest.previous.mode ?? 0o600);
    }

    renameSync(stagingDirectory, plan.backupDirectory);
    backupPublished = true;
    assertBackupIntegrity(targetDirectory, plan.manifest);

    publishNewFile(plan.manifestPath, plan.manifestContent, 0o600);
    manifestPublished = true;
  } catch (error) {
    if (!manifestPublished) {
      rmSync(stagingDirectory, { recursive: true, force: true });
      if (backupPublished) {
        rmSync(plan.backupDirectory, { recursive: true, force: true });
      }
      if (createdBackupsRoot) {
        safeRemoveDirectory(backupsRoot);
      }
      if (createdControl) {
        safeRemoveDirectory(plan.controlDirectory);
      }
    }
    if (error instanceof InstallationManifestError) {
      throw error;
    }
    throw new InstallationManifestError(
      manifestPublished ? "MANIFEST_WRITE_FAILED" : "BACKUP_WRITE_FAILED",
      "Unable to prepare installation backup and manifest.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  return {
    manifestPath: plan.manifestPath,
    backupDirectory: plan.backupDirectory,
    manifestSha256: sha256(plan.manifestContent),
    backedUpFileCount: plan.files.filter(
      (file) => file.manifest.previous.existed,
    ).length,
    manifest: plan.manifest,
  };
}

export function applyInstallationPlan(
  plan: InstallationPreparationPlan,
  options: InstallationApplyOptions = {},
): AppliedInstallation {
  const targetDirectory = resolveTargetDirectory(plan.targetDirectory);
  const prepared = prepareInstallationBackup(plan);
  const createdDirectories: string[] = [];
  let writtenFileCount = 0;
  let reusedFileCount = 0;
  let phase: "write" | "verify" | "complete" = "write";

  try {
    assertPreparationPlanConsistent(plan, targetDirectory);
    const loaded = loadInstallationManifest(targetDirectory);
    if (
      loaded.manifest.installation.state !== "prepared" ||
      loaded.sha256 !== prepared.manifestSha256
    ) {
      throw new InstallationManifestError(
        "PLAN_STALE",
        "Prepared installation manifest no longer matches the installation plan.",
      );
    }
    assertBackupIntegrity(targetDirectory, loaded.manifest);

    for (const file of plan.files) {
      const current = snapshotFile(targetDirectory, file.manifest.path);
      if (!snapshotsMatch(current, file.manifest.previous)) {
        throw new InstallationManifestError(
          "PLAN_STALE",
          `Managed file changed after backup preparation: ${file.manifest.path}`,
        );
      }
    }

    for (const file of plan.files) {
      assertManifestUnchanged(targetDirectory, prepared.manifestSha256);
      const current = snapshotFile(targetDirectory, file.manifest.path);
      if (snapshotMatchesManifestFile(current, file.manifest)) {
        reusedFileCount += 1;
        continue;
      }
      if (!snapshotsMatch(current, file.manifest.previous)) {
        throw new InstallationManifestError(
          "PLAN_STALE",
          `Managed file changed before installation write: ${file.manifest.path}`,
        );
      }

      createManagedParentDirectories(
        targetDirectory,
        file.manifest.path,
        createdDirectories,
      );
      try {
        if (file.manifest.previous.existed) {
          atomicReplaceFile(
            file.absolutePath,
            file.content,
            file.manifest.mode,
          );
        } else {
          publishNewFile(
            file.absolutePath,
            file.content,
            file.manifest.mode,
          );
        }
      } catch (error) {
        if (error instanceof InstallationManifestError) {
          throw error;
        }
        throw new InstallationManifestError(
          "INSTALLATION_WRITE_FAILED",
          `Unable to install managed file: ${file.manifest.path}`,
          [error instanceof Error ? error.message : String(error)],
        );
      }

      const installed = snapshotFile(targetDirectory, file.manifest.path);
      if (!snapshotMatchesManifestFile(installed, file.manifest)) {
        throw new InstallationManifestError(
          "INSTALLATION_WRITE_FAILED",
          `Installed file failed SHA-256, size, or mode verification: ${file.manifest.path}`,
        );
      }
      writtenFileCount += 1;
    }

    phase = "verify";
    options.verify?.();
    phase = "complete";
    const manifest = completeInstallationManifest(
      targetDirectory,
      options.installedAt === undefined
        ? {}
        : { installedAt: options.installedAt },
    );
    return {
      prepared,
      manifest,
      writtenFileCount,
      reusedFileCount,
    };
  } catch (error) {
    let rollbackError: unknown = null;
    try {
      rollbackPreparedInstallation(targetDirectory);
      cleanupCreatedDirectories(createdDirectories);
    } catch (caughtRollbackError) {
      rollbackError = caughtRollbackError;
    }

    if (rollbackError !== null) {
      throw new InstallationManifestError(
        "INSTALLATION_ROLLBACK_FAILED",
        "Installation failed and automatic rollback could not complete safely.",
        [
          `Original ${phase} failure: ${error instanceof Error ? error.message : String(error)}`,
          `Rollback failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          `Backups remain at ${prepared.backupDirectory}.`,
        ],
      );
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new InstallationManifestError(
      "INSTALLATION_WRITE_FAILED",
      `Installation ${phase} failed and was rolled back.`,
      [String(error)],
    );
  }
}

export function readInstallationManifest(
  directory: string,
): InstallationManifest {
  return loadInstallationManifest(directory).manifest;
}

export function verifyInstallationIntegrity(
  directory: string,
): InstallationIntegrityReport {
  const targetDirectory = resolveTargetDirectory(directory);
  const { manifest } = loadInstallationManifest(targetDirectory);
  const checks = manifest.files.map<InstallationIntegrityCheck>((file) => {
    let backup: InstallationIntegrityStatus = "not-required";
    if (file.previous.existed) {
      try {
        const snapshot = backupSnapshot(targetDirectory, file);
        backup = !snapshot.existed
          ? "missing"
          : snapshotsMatch(snapshot, file.previous)
            ? "match"
            : "mismatch";
      } catch {
        backup = "mismatch";
      }
    }

    let installed: InstallationIntegrityStatus = "not-checked";
    if (manifest.installation.state === "installed") {
      try {
        const snapshot = snapshotFile(targetDirectory, file.path);
        installed = !snapshot.existed
          ? "missing"
          : snapshotMatchesManifestFile(snapshot, file)
            ? "match"
            : "mismatch";
      } catch {
        installed = "mismatch";
      }
    }

    return { path: file.path, installed, backup };
  });

  return {
    ok: checks.every(
      (check) =>
        (check.backup === "match" || check.backup === "not-required") &&
        (check.installed === "match" || check.installed === "not-checked"),
    ),
    manifest,
    checks,
  };
}

export function completeInstallationManifest(
  directory: string,
  options: InstallationCompletionOptions = {},
): InstallationManifest {
  const targetDirectory = resolveTargetDirectory(directory);
  const loaded = loadInstallationManifest(targetDirectory);
  if (loaded.manifest.installation.state !== "prepared") {
    throw new InstallationManifestError(
      "MANIFEST_STATE",
      `Installation manifest is not prepared: ${loaded.manifest.installation.state}`,
    );
  }
  assertBackupIntegrity(targetDirectory, loaded.manifest);

  const mismatched = loaded.manifest.files
    .filter(
      (file) =>
        !snapshotMatchesManifestFile(
          snapshotFile(targetDirectory, file.path),
          file,
        ),
    )
    .map((file) => file.path);
  if (mismatched.length > 0) {
    throw new InstallationManifestError(
      "INSTALLATION_INCOMPLETE",
      "Installed files do not match the prepared manifest.",
      mismatched,
    );
  }

  const installedAt = validateTimestamp(
    options.installedAt ?? new Date().toISOString(),
  );
  const manifest: InstallationManifest = {
    ...loaded.manifest,
    installation: {
      ...loaded.manifest.installation,
      state: "installed",
      installedAt,
    },
  };
  assertManifestUnchanged(targetDirectory, loaded.sha256);
  try {
    atomicReplaceFile(
      join(targetDirectory, ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/")),
      serialize(manifest),
      0o600,
    );
  } catch (error) {
    throw new InstallationManifestError(
      "MANIFEST_WRITE_FAILED",
      "Unable to mark the installation manifest as installed.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
  return manifest;
}

function rollbackTargetIsSafe(
  snapshot: FileSnapshot,
  file: InstallationManifestFile,
): boolean {
  if (!snapshot.existed) {
    return true;
  }
  if (snapshotMatchesManifestFile(snapshot, file)) {
    return true;
  }
  return file.previous.existed && snapshotsMatch(snapshot, file.previous);
}

export function rollbackPreparedInstallation(
  directory: string,
  options: InstallationRollbackOptions = {},
): InstallationManifest {
  const targetDirectory = resolveTargetDirectory(directory);
  const loaded = loadInstallationManifest(targetDirectory);
  if (loaded.manifest.installation.state !== "prepared") {
    throw new InstallationManifestError(
      "MANIFEST_STATE",
      `Only a prepared installation can be rolled back: ${loaded.manifest.installation.state}`,
    );
  }
  assertBackupIntegrity(targetDirectory, loaded.manifest);

  const unsafe = loaded.manifest.files
    .filter(
      (file) =>
        !rollbackTargetIsSafe(
          snapshotFile(targetDirectory, file.path),
          file,
        ),
    )
    .map((file) => file.path);
  if (unsafe.length > 0) {
    throw new InstallationManifestError(
      "TARGET_MODIFIED",
      "Rollback refused files that differ from both prepared and original hashes.",
      unsafe,
    );
  }

  const rolledBackAt = validateTimestamp(
    options.rolledBackAt ?? new Date().toISOString(),
  );
  const historyDirectory = join(
    targetDirectory,
    INSTALLATION_HISTORY_DIRECTORY,
  );
  const historyPath = join(
    historyDirectory,
    `${loaded.manifest.installation.id}.rolled-back.json`,
  );
  createDirectory(historyDirectory);
  assertPathMissing(historyPath, "CONTROL_PATH_CONFLICT");

  try {
    for (const file of loaded.manifest.files) {
      const current = snapshotFile(targetDirectory, file.path);
      if (file.previous.existed && file.previous.backupPath !== null) {
        const backup = snapshotFile(targetDirectory, file.previous.backupPath);
        if (backup.content === null || file.previous.mode === null) {
          throw new InstallationManifestError(
            "BACKUP_INTEGRITY_FAILED",
            `Backup disappeared during rollback: ${file.path}`,
          );
        }
        mkdirSync(dirname(join(targetDirectory, ...file.path.split("/"))), {
          recursive: true,
          mode: 0o755,
        });
        atomicReplaceFile(
          join(targetDirectory, ...file.path.split("/")),
          backup.content,
          file.previous.mode,
        );
      } else if (current.existed) {
        unlinkSync(join(targetDirectory, ...file.path.split("/")));
      }
    }

    const restoreFailures = loaded.manifest.files
      .filter((file) => {
        const current = snapshotFile(targetDirectory, file.path);
        return file.previous.existed
          ? !snapshotsMatch(current, file.previous)
          : current.existed;
      })
      .map((file) => file.path);
    if (restoreFailures.length > 0) {
      throw new InstallationManifestError(
        "ROLLBACK_FAILED",
        "Rollback did not restore every managed path to its original state.",
        restoreFailures,
      );
    }

    const manifest: InstallationManifest = {
      ...loaded.manifest,
      installation: {
        ...loaded.manifest.installation,
        state: "rolledBack",
        rolledBackAt,
      },
    };
    publishNewFile(historyPath, serialize(manifest), 0o600);
    assertManifestUnchanged(targetDirectory, loaded.sha256);
    unlinkSync(
      join(targetDirectory, ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/")),
    );
    return manifest;
  } catch (error) {
    if (error instanceof InstallationManifestError) {
      throw error;
    }
    throw new InstallationManifestError(
      "ROLLBACK_FAILED",
      "Unable to roll back the prepared installation.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
}
