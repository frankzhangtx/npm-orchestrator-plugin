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
import { dirname, join, posix, resolve } from "node:path";

import {
  INSTALLATION_CONTROL_DIRECTORY,
  INSTALLATION_HISTORY_DIRECTORY,
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  readInstallationManifest,
  type InstallationManifest,
  type InstallationManifestFile,
  type PreviousInstallationFile,
} from "./install-manifest.js";
import { ORCHESTRATOR_PACKAGE_NAME } from "./opencode-config.js";

export const UNINSTALL_MARKER_RELATIVE_PATH =
  `${INSTALLATION_CONTROL_DIRECTORY}/uninstall.json`;
export const UNINSTALL_RECOVERY_DIRECTORY =
  `${INSTALLATION_CONTROL_DIRECTORY}/uninstalls`;

const UPGRADE_MARKER_RELATIVE_PATH =
  `${INSTALLATION_CONTROL_DIRECTORY}/upgrade.json`;

export type ProjectUninstallErrorCode =
  | "INSTALLATION_INVALID"
  | "PACKAGE_MISMATCH"
  | "PLAN_STALE"
  | "POST_UNINSTALL_VERIFICATION_FAILED"
  | "UNINSTALL_CONFLICT"
  | "UNINSTALL_IN_PROGRESS"
  | "UNINSTALL_ROLLBACK_FAILED"
  | "UNINSTALL_WRITE_FAILED";

export class ProjectUninstallError extends Error {
  readonly code: ProjectUninstallErrorCode;
  readonly details: readonly string[];

  constructor(
    code: ProjectUninstallErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ProjectUninstallError";
    this.code = code;
    this.details = details;
  }
}

export interface ProjectUninstallOptions {
  preparedAt?: string;
  uninstallId?: string;
  uninstalledAt?: string;
}

export interface UninstallFileSnapshot {
  existed: boolean;
  content: Uint8Array | null;
  sha256: string | null;
  size: number | null;
  mode: number | null;
}

export type UninstallFileDisposition =
  | "restore-original"
  | "remove-installed"
  | "already-restored"
  | "already-absent"
  | "retain-modified"
  | "retain-missing";

export interface PlannedUninstallFile {
  path: string;
  source: string;
  strategy: InstallationManifestFile["strategy"];
  disposition: UninstallFileDisposition;
  before: UninstallFileSnapshot;
  after: UninstallFileSnapshot;
}

export interface ProjectUninstallPlan {
  targetDirectory: string;
  packageName: string;
  packageVersion: string;
  uninstallId: string;
  preparedAt: string;
  uninstalledAt: string;
  currentManifest: InstallationManifest;
  currentManifestContent: string;
  currentManifestSha256: string;
  files: readonly PlannedUninstallFile[];
  manifestPath: string;
  backupDirectory: string;
  recoveryDirectory: string;
  historyPath: string;
}

export interface AppliedProjectUninstall {
  restoredFileCount: number;
  removedFileCount: number;
  alreadyCleanFileCount: number;
  retainedFileCount: number;
  retainedPaths: readonly string[];
  cleanupWarnings: readonly string[];
}

export interface ProjectUninstallResult extends AppliedProjectUninstall {
  status: "uninstalled" | "uninstalled-with-retained-files";
  targetDirectory: string;
  packageName: string;
  packageVersion: string;
  managedFileCount: number;
  manifestPath: string;
  backupDirectory: string;
  recoveryDirectory: string;
  historyPath: string;
}

interface StableManifest {
  manifest: InstallationManifest;
  content: string;
  sha256: string;
}

interface UninstallControlPaths {
  controlDirectory: string;
  recoveryRoot: string;
  recoveryDirectory: string;
  recoveryStagingDirectory: string;
  markerPath: string;
  historyDirectory: string;
  historyPath: string;
}

interface PreparedUninstall {
  paths: UninstallControlPaths;
  markerSha256: string;
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

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ProjectUninstallError(
      "PLAN_STALE",
      `Uninstall timestamp must be canonical UTC ISO-8601: ${value}`,
    );
  }
  return value;
}

function validateUninstallId(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new ProjectUninstallError(
      "PLAN_STALE",
      `Uninstall ID is not safe: ${value}`,
    );
  }
  return value;
}

function defaultUninstallId(preparedAt: string): string {
  return validateUninstallId(
    `uninstall-${preparedAt.replace(/[-:.TZ]/g, "")}-${randomUUID()}`,
  );
}

function validateRelativePath(path: string, allowControl = false): string {
  if (
    path.length === 0 ||
    path.trim() !== path ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      `Uninstall path must be canonical and repository-relative: ${path}`,
    );
  }
  if (
    !allowControl &&
    (path === INSTALLATION_CONTROL_DIRECTORY ||
      path.startsWith(`${INSTALLATION_CONTROL_DIRECTORY}/`))
  ) {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      `Uninstall cannot manage installer control state as a project file: ${path}`,
    );
  }
  return path;
}

function resolveInputDirectory(directory: string): string {
  const resolvedDirectory = resolve(directory);
  try {
    const stats = lstatSync(resolvedDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ProjectUninstallError(
        "INSTALLATION_INVALID",
        `Uninstall target is not a regular directory: ${resolvedDirectory}`,
      );
    }
  } catch (error) {
    if (error instanceof ProjectUninstallError) {
      throw error;
    }
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      `Uninstall target does not exist or cannot be inspected: ${resolvedDirectory}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  return resolvedDirectory;
}

function locateInstallationRoot(directory: string): string {
  let candidate = resolveInputDirectory(directory);
  while (true) {
    const manifestPath = join(
      candidate,
      ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
    );
    try {
      const stats = lstatSync(manifestPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new ProjectUninstallError(
          "INSTALLATION_INVALID",
          `Installation manifest is not a regular file: ${manifestPath}`,
        );
      }
      return candidate;
    } catch (error) {
      if (error instanceof ProjectUninstallError) {
        throw error;
      }
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw new ProjectUninstallError(
          "INSTALLATION_INVALID",
          `Unable to inspect installation manifest: ${manifestPath}`,
          [error instanceof Error ? error.message : String(error)],
        );
      }
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }
  throw new ProjectUninstallError(
    "INSTALLATION_INVALID",
    "An installed manifest is required before uninstall.",
    [`No ${INSTALLATION_MANIFEST_RELATIVE_PATH} was found at or above ${resolve(directory)}.`],
  );
}

function assertSafeAncestors(
  targetDirectory: string,
  relativePath: string,
): void {
  let current = targetDirectory;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ProjectUninstallError(
          "INSTALLATION_INVALID",
          `Uninstall path has an unsafe parent: ${current}`,
        );
      }
    } catch (error) {
      if (error instanceof ProjectUninstallError) {
        throw error;
      }
      if (filesystemErrorCode(error) === "ENOENT") {
        return;
      }
      throw new ProjectUninstallError(
        "INSTALLATION_INVALID",
        `Unable to inspect uninstall path parent: ${current}`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }
}

function absentSnapshot(): UninstallFileSnapshot {
  return {
    existed: false,
    content: null,
    sha256: null,
    size: null,
    mode: null,
  };
}

function cloneSnapshot(snapshot: UninstallFileSnapshot): UninstallFileSnapshot {
  return {
    ...snapshot,
    content: snapshot.content === null ? null : Buffer.from(snapshot.content),
  };
}

function snapshotFile(
  targetDirectory: string,
  relativePath: string,
  allowControl = false,
): UninstallFileSnapshot {
  validateRelativePath(relativePath, allowControl);
  assertSafeAncestors(targetDirectory, relativePath);
  const absolutePath = join(targetDirectory, ...relativePath.split("/"));
  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ProjectUninstallError(
        "INSTALLATION_INVALID",
        `Uninstall path is not a regular file: ${absolutePath}`,
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
    if (error instanceof ProjectUninstallError) {
      throw error;
    }
    if (filesystemErrorCode(error) === "ENOENT") {
      return absentSnapshot();
    }
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      `Unable to inspect uninstall path: ${absolutePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function snapshotMetadata(
  snapshot: UninstallFileSnapshot,
): Omit<UninstallFileSnapshot, "content"> {
  return {
    existed: snapshot.existed,
    sha256: snapshot.sha256,
    size: snapshot.size,
    mode: snapshot.mode,
  };
}

function snapshotFingerprint(snapshot: UninstallFileSnapshot): unknown {
  return {
    ...snapshotMetadata(snapshot),
    contentSha256:
      snapshot.content === null ? null : sha256(snapshot.content),
  };
}

function snapshotsMatch(
  left: UninstallFileSnapshot,
  right: UninstallFileSnapshot | PreviousInstallationFile,
): boolean {
  return (
    left.existed === right.existed &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function snapshotMatchesInstalled(
  snapshot: UninstallFileSnapshot,
  file: InstallationManifestFile,
): boolean {
  return (
    snapshot.existed &&
    snapshot.sha256 === file.sha256 &&
    snapshot.size === file.size &&
    snapshot.mode === file.mode
  );
}

function readStableManifest(targetDirectory: string): StableManifest {
  const before = snapshotFile(
    targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
    true,
  );
  if (!before.existed || before.content === null || before.sha256 === null) {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      "An installed manifest is required before uninstall.",
    );
  }
  if (before.mode !== 0o600) {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      "The active installation manifest must have mode 0600.",
    );
  }
  const content = Buffer.from(before.content).toString("utf8");
  let manifest: InstallationManifest;
  try {
    manifest = readInstallationManifest(targetDirectory);
  } catch (error) {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      "The active installation manifest is invalid.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
  const after = snapshotFile(
    targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
    true,
  );
  if (!snapshotsMatch(after, before)) {
    throw new ProjectUninstallError(
      "PLAN_STALE",
      "The installation manifest changed while uninstall was being planned.",
    );
  }
  if (manifest.installation.state !== "installed") {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      `Only an installed manifest can be uninstalled: ${manifest.installation.state}`,
    );
  }
  if (manifest.package.name !== ORCHESTRATOR_PACKAGE_NAME) {
    throw new ProjectUninstallError(
      "PACKAGE_MISMATCH",
      "The installed manifest belongs to a different package.",
      [manifest.package.name, ORCHESTRATOR_PACKAGE_NAME],
    );
  }
  return { manifest, content, sha256: before.sha256 };
}

function assertNoTransactionMarkers(targetDirectory: string): void {
  const existing = [
    UNINSTALL_MARKER_RELATIVE_PATH,
    UPGRADE_MARKER_RELATIVE_PATH,
  ].filter(
    (path) => snapshotFile(targetDirectory, path, true).existed,
  );
  if (existing.length > 0) {
    throw new ProjectUninstallError(
      "UNINSTALL_IN_PROGRESS",
      "An unfinished installer transaction marker already exists.",
      existing.map((path) => join(targetDirectory, ...path.split("/"))),
    );
  }
}

function originalBackupSnapshot(
  targetDirectory: string,
  file: InstallationManifestFile,
): UninstallFileSnapshot {
  if (!file.previous.existed || file.previous.backupPath === null) {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      `Original backup metadata is incomplete: ${file.path}`,
    );
  }
  const original = snapshotFile(
    targetDirectory,
    file.previous.backupPath,
    true,
  );
  if (!snapshotsMatch(original, file.previous)) {
    throw new ProjectUninstallError(
      "INSTALLATION_INVALID",
      `Original backup failed SHA-256, size, or mode verification: ${file.path}`,
      [file.previous.backupPath],
    );
  }
  return original;
}

function planUninstallFile(
  targetDirectory: string,
  file: InstallationManifestFile,
): PlannedUninstallFile {
  const before = snapshotFile(targetDirectory, file.path);
  if (file.previous.existed && snapshotsMatch(before, file.previous)) {
    return {
      path: file.path,
      source: file.source,
      strategy: file.strategy,
      disposition: "already-restored",
      before,
      after: cloneSnapshot(before),
    };
  }
  if (!file.previous.existed && !before.existed) {
    return {
      path: file.path,
      source: file.source,
      strategy: file.strategy,
      disposition: "already-absent",
      before,
      after: absentSnapshot(),
    };
  }
  if (snapshotMatchesInstalled(before, file)) {
    if (file.previous.existed) {
      return {
        path: file.path,
        source: file.source,
        strategy: file.strategy,
        disposition: "restore-original",
        before,
        after: originalBackupSnapshot(targetDirectory, file),
      };
    }
    return {
      path: file.path,
      source: file.source,
      strategy: file.strategy,
      disposition: "remove-installed",
      before,
      after: absentSnapshot(),
    };
  }
  return {
    path: file.path,
    source: file.source,
    strategy: file.strategy,
    disposition: before.existed ? "retain-modified" : "retain-missing",
    before,
    after: cloneSnapshot(before),
  };
}

function uninstallControlPaths(
  targetDirectory: string,
  uninstallId: string,
): UninstallControlPaths {
  const controlDirectory = join(targetDirectory, INSTALLATION_CONTROL_DIRECTORY);
  const recoveryRoot = join(targetDirectory, UNINSTALL_RECOVERY_DIRECTORY);
  const historyDirectory = join(targetDirectory, INSTALLATION_HISTORY_DIRECTORY);
  return {
    controlDirectory,
    recoveryRoot,
    recoveryDirectory: join(recoveryRoot, uninstallId),
    recoveryStagingDirectory: join(recoveryRoot, `.staging-${uninstallId}`),
    markerPath: join(
      targetDirectory,
      ...UNINSTALL_MARKER_RELATIVE_PATH.split("/"),
    ),
    historyDirectory,
    historyPath: join(historyDirectory, `${uninstallId}.uninstalled.json`),
  };
}

export function planProjectUninstall(
  directory: string,
  options: ProjectUninstallOptions = {},
): ProjectUninstallPlan {
  const targetDirectory = locateInstallationRoot(directory);
  const stable = readStableManifest(targetDirectory);
  assertNoTransactionMarkers(targetDirectory);
  const preparedAt = validateTimestamp(
    options.preparedAt ?? new Date().toISOString(),
  );
  const uninstalledAt = validateTimestamp(
    options.uninstalledAt ?? preparedAt,
  );
  const uninstallId = validateUninstallId(
    options.uninstallId ?? defaultUninstallId(preparedAt),
  );
  const paths = uninstallControlPaths(targetDirectory, uninstallId);
  return {
    targetDirectory,
    packageName: stable.manifest.package.name,
    packageVersion: stable.manifest.package.version,
    uninstallId,
    preparedAt,
    uninstalledAt,
    currentManifest: stable.manifest,
    currentManifestContent: stable.content,
    currentManifestSha256: stable.sha256,
    files: stable.manifest.files.map((file) =>
      planUninstallFile(targetDirectory, file),
    ),
    manifestPath: join(
      targetDirectory,
      ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
    ),
    backupDirectory: join(
      targetDirectory,
      ...stable.manifest.backupDirectory.split("/"),
    ),
    recoveryDirectory: paths.recoveryDirectory,
    historyPath: paths.historyPath,
  };
}

function planFingerprint(plan: ProjectUninstallPlan): string {
  return serialize({
    targetDirectory: plan.targetDirectory,
    packageName: plan.packageName,
    packageVersion: plan.packageVersion,
    uninstallId: plan.uninstallId,
    preparedAt: plan.preparedAt,
    uninstalledAt: plan.uninstalledAt,
    currentManifest: plan.currentManifest,
    currentManifestContent: plan.currentManifestContent,
    currentManifestSha256: plan.currentManifestSha256,
    files: plan.files.map((file) => ({
      path: file.path,
      source: file.source,
      strategy: file.strategy,
      disposition: file.disposition,
      before: snapshotFingerprint(file.before),
      after: snapshotFingerprint(file.after),
    })),
    manifestPath: plan.manifestPath,
    backupDirectory: plan.backupDirectory,
    recoveryDirectory: plan.recoveryDirectory,
    historyPath: plan.historyPath,
  });
}

function assertPlanConsistent(plan: ProjectUninstallPlan): void {
  const replanned = planProjectUninstall(plan.targetDirectory, {
    uninstallId: plan.uninstallId,
    preparedAt: plan.preparedAt,
    uninstalledAt: plan.uninstalledAt,
  });
  if (planFingerprint(plan) !== planFingerprint(replanned)) {
    throw new ProjectUninstallError(
      "PLAN_STALE",
      "Uninstall plan or target state changed after planning.",
    );
  }
}

function actionFiles(
  plan: ProjectUninstallPlan,
): readonly PlannedUninstallFile[] {
  return plan.files.filter(
    (file) =>
      file.disposition === "restore-original" ||
      file.disposition === "remove-installed",
  );
}

function retainedFiles(
  plan: ProjectUninstallPlan,
): readonly PlannedUninstallFile[] {
  return plan.files.filter(
    (file) =>
      file.disposition === "retain-modified" ||
      file.disposition === "retain-missing",
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
      throw new ProjectUninstallError(
        "UNINSTALL_CONFLICT",
        `Uninstall control path is not a regular directory: ${path}`,
      );
    }
    return false;
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

function assertPathMissing(path: string): void {
  try {
    lstatSync(path);
    throw new ProjectUninstallError(
      "UNINSTALL_CONFLICT",
      `Uninstall control path already exists: ${path}`,
    );
  } catch (error) {
    if (error instanceof ProjectUninstallError) {
      throw error;
    }
    if (filesystemErrorCode(error) !== "ENOENT") {
      throw new ProjectUninstallError(
        "UNINSTALL_CONFLICT",
        `Unable to inspect uninstall control path: ${path}`,
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

function writeSnapshot(
  root: string,
  relativePath: string,
  snapshot: UninstallFileSnapshot,
): void {
  if (!snapshot.existed || snapshot.content === null || snapshot.mode === null) {
    return;
  }
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, snapshot.content, { flag: "wx", mode: snapshot.mode });
  chmodSync(path, snapshot.mode);
}

function transactionRecord(
  plan: ProjectUninstallPlan,
  state: "prepared" | "uninstalled" | "rolledBack",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: plan.uninstallId,
    state,
    package: {
      name: plan.packageName,
      version: plan.packageVersion,
    },
    preparedAt: plan.preparedAt,
    uninstalledAt: state === "uninstalled" ? plan.uninstalledAt : null,
    previousManifestSha256: plan.currentManifestSha256,
    backupDirectory: plan.currentManifest.backupDirectory,
    recoveryDirectory:
      `${UNINSTALL_RECOVERY_DIRECTORY}/${plan.uninstallId}`,
    files: plan.files.map((file) => ({
      path: file.path,
      source: file.source,
      strategy: file.strategy,
      disposition: file.disposition,
      before: snapshotMetadata(file.before),
      after: snapshotMetadata(file.after),
    })),
  };
}

function verifyPreparedUninstall(
  plan: ProjectUninstallPlan,
  paths: UninstallControlPaths,
): void {
  const manifest = snapshotFile(
    paths.recoveryDirectory,
    "active-manifest.json",
  );
  if (
    !manifest.existed ||
    manifest.sha256 !== plan.currentManifestSha256 ||
    manifest.mode !== 0o600
  ) {
    throw new ProjectUninstallError(
      "UNINSTALL_WRITE_FAILED",
      "The uninstall recovery manifest failed verification.",
    );
  }
  for (const file of actionFiles(plan)) {
    const recovery = snapshotFile(
      paths.recoveryDirectory,
      `files/${file.path}`,
    );
    if (!snapshotsMatch(recovery, file.before)) {
      throw new ProjectUninstallError(
        "UNINSTALL_WRITE_FAILED",
        `Uninstall recovery snapshot failed verification: ${file.path}`,
      );
    }
  }
}

function prepareUninstall(plan: ProjectUninstallPlan): PreparedUninstall {
  const paths = uninstallControlPaths(plan.targetDirectory, plan.uninstallId);
  assertPathMissing(paths.markerPath);
  assertPathMissing(paths.recoveryDirectory);
  assertPathMissing(paths.recoveryStagingDirectory);
  assertPathMissing(paths.historyPath);
  const createdControl = createDirectory(paths.controlDirectory);
  const createdRecoveryRoot = createDirectory(paths.recoveryRoot);
  let recoveryPublished = false;
  let markerPublished = false;

  try {
    mkdirSync(paths.recoveryStagingDirectory, { mode: 0o700 });
    writeFileSync(
      join(paths.recoveryStagingDirectory, "active-manifest.json"),
      plan.currentManifestContent,
      { flag: "wx", mode: 0o600 },
    );
    for (const file of actionFiles(plan)) {
      writeSnapshot(paths.recoveryStagingDirectory, `files/${file.path}`, file.before);
    }
    writeFileSync(
      join(paths.recoveryStagingDirectory, "transaction.json"),
      serialize(transactionRecord(plan, "prepared")),
      { flag: "wx", mode: 0o600 },
    );
    renameSync(paths.recoveryStagingDirectory, paths.recoveryDirectory);
    recoveryPublished = true;
    verifyPreparedUninstall(plan, paths);

    const markerContent = serialize(transactionRecord(plan, "prepared"));
    publishNewFile(paths.markerPath, markerContent, 0o600);
    markerPublished = true;
    return { paths, markerSha256: sha256(markerContent) };
  } catch (error) {
    if (!markerPublished) {
      rmSync(paths.recoveryStagingDirectory, { recursive: true, force: true });
      if (recoveryPublished) {
        rmSync(paths.recoveryDirectory, { recursive: true, force: true });
      }
      if (createdRecoveryRoot) {
        safeRemoveDirectory(paths.recoveryRoot);
      }
      if (createdControl) {
        safeRemoveDirectory(paths.controlDirectory);
      }
    }
    if (error instanceof ProjectUninstallError) {
      throw error;
    }
    throw new ProjectUninstallError(
      "UNINSTALL_WRITE_FAILED",
      "Unable to prepare uninstall recovery state.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function assertManifestUnchanged(plan: ProjectUninstallPlan): void {
  const current = snapshotFile(
    plan.targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
    true,
  );
  if (
    !current.existed ||
    current.sha256 !== plan.currentManifestSha256 ||
    current.size !== Buffer.byteLength(plan.currentManifestContent) ||
    current.mode !== 0o600
  ) {
    throw new ProjectUninstallError(
      "PLAN_STALE",
      "The active installation manifest changed during uninstall.",
    );
  }
}

function assertMarkerUnchanged(prepared: PreparedUninstall): void {
  let marker: Uint8Array;
  try {
    marker = readFileSync(prepared.paths.markerPath);
  } catch (error) {
    throw new ProjectUninstallError(
      "PLAN_STALE",
      "The uninstall transaction marker changed during uninstall.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
  if (sha256(marker) !== prepared.markerSha256) {
    throw new ProjectUninstallError(
      "PLAN_STALE",
      "The uninstall transaction marker changed during uninstall.",
    );
  }
}

function restoreSnapshot(
  targetDirectory: string,
  relativePath: string,
  snapshot: UninstallFileSnapshot,
): void {
  const current = snapshotFile(targetDirectory, relativePath);
  const absolutePath = join(targetDirectory, ...relativePath.split("/"));
  if (snapshot.existed) {
    if (snapshot.content === null || snapshot.mode === null) {
      throw new ProjectUninstallError(
        "UNINSTALL_WRITE_FAILED",
        `Uninstall snapshot is incomplete: ${relativePath}`,
      );
    }
    if (current.existed) {
      atomicReplaceFile(absolutePath, snapshot.content, snapshot.mode);
    } else {
      publishNewFile(absolutePath, snapshot.content, snapshot.mode);
    }
  } else if (current.existed) {
    unlinkSync(absolutePath);
  }
}

function verifyPlannedState(plan: ProjectUninstallPlan): void {
  const failed = plan.files
    .filter(
      (file) =>
        !snapshotsMatch(
          snapshotFile(plan.targetDirectory, file.path),
          file.after,
        ),
    )
    .map((file) => file.path);
  if (failed.length > 0) {
    throw new ProjectUninstallError(
      "UNINSTALL_WRITE_FAILED",
      "Uninstalled paths failed SHA-256, size, mode, or removal verification.",
      failed,
    );
  }
}

function rollbackUninstall(
  plan: ProjectUninstallPlan,
  prepared: PreparedUninstall,
  historyPublished: boolean,
): void {
  assertManifestUnchanged(plan);
  assertMarkerUnchanged(prepared);
  const unsafe = actionFiles(plan)
    .filter((file) => {
      const current = snapshotFile(plan.targetDirectory, file.path);
      return (
        !snapshotsMatch(current, file.before) &&
        !snapshotsMatch(current, file.after)
      );
    })
    .map((file) => file.path);
  if (unsafe.length > 0) {
    throw new ProjectUninstallError(
      "UNINSTALL_ROLLBACK_FAILED",
      "Uninstall rollback refused concurrently modified paths.",
      unsafe,
    );
  }

  for (const file of actionFiles(plan)) {
    restoreSnapshot(plan.targetDirectory, file.path, file.before);
  }
  const failed = actionFiles(plan)
    .filter(
      (file) =>
        !snapshotsMatch(
          snapshotFile(plan.targetDirectory, file.path),
          file.before,
        ),
    )
    .map((file) => file.path);
  if (failed.length > 0) {
    throw new ProjectUninstallError(
      "UNINSTALL_ROLLBACK_FAILED",
      "Uninstall rollback did not restore every changed path.",
      failed,
    );
  }

  if (historyPublished) {
    unlinkSync(prepared.paths.historyPath);
  }
  unlinkSync(prepared.paths.markerPath);
  try {
    atomicReplaceFile(
      join(prepared.paths.recoveryDirectory, "transaction.json"),
      serialize(transactionRecord(plan, "rolledBack")),
      0o600,
    );
  } catch {
    // The recovery snapshots and active manifest remain sufficient for audit.
  }
}

export function applyProjectUninstall(
  plan: ProjectUninstallPlan,
  verify?: () => void,
): AppliedProjectUninstall {
  assertPlanConsistent(plan);
  const prepared = prepareUninstall(plan);
  let restoredFileCount = 0;
  let removedFileCount = 0;
  let historyPublished = false;
  let committed = false;
  let phase: "write" | "verify" | "commit" = "write";

  try {
    assertManifestUnchanged(plan);
    assertMarkerUnchanged(prepared);
    for (const file of plan.files) {
      if (
        !snapshotsMatch(
          snapshotFile(plan.targetDirectory, file.path),
          file.before,
        )
      ) {
        throw new ProjectUninstallError(
          "PLAN_STALE",
          `Managed file changed after uninstall recovery preparation: ${file.path}`,
        );
      }
    }

    for (const file of actionFiles(plan)) {
      assertManifestUnchanged(plan);
      assertMarkerUnchanged(prepared);
      const current = snapshotFile(plan.targetDirectory, file.path);
      if (!snapshotsMatch(current, file.before)) {
        throw new ProjectUninstallError(
          "PLAN_STALE",
          `Managed file changed before uninstall write: ${file.path}`,
        );
      }
      restoreSnapshot(plan.targetDirectory, file.path, file.after);
      if (
        !snapshotsMatch(
          snapshotFile(plan.targetDirectory, file.path),
          file.after,
        )
      ) {
        throw new ProjectUninstallError(
          "UNINSTALL_WRITE_FAILED",
          `Uninstalled file failed verification: ${file.path}`,
        );
      }
      if (file.disposition === "restore-original") {
        restoredFileCount += 1;
      } else {
        removedFileCount += 1;
      }
    }

    verifyPlannedState(plan);
    phase = "verify";
    verify?.();
    verifyPlannedState(plan);
    phase = "commit";
    assertManifestUnchanged(plan);
    assertMarkerUnchanged(prepared);
    createDirectory(prepared.paths.historyDirectory);
    publishNewFile(
      prepared.paths.historyPath,
      serialize(transactionRecord(plan, "uninstalled")),
      0o600,
    );
    historyPublished = true;
    unlinkSync(plan.manifestPath);
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        rollbackUninstall(plan, prepared, historyPublished);
      } catch (rollbackError) {
        throw new ProjectUninstallError(
          "UNINSTALL_ROLLBACK_FAILED",
          "Uninstall failed and automatic rollback could not complete safely.",
          [
            `Original failure: ${error instanceof Error ? error.message : String(error)}`,
            `Rollback failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            `Recovery evidence: ${prepared.paths.recoveryDirectory}`,
          ],
        );
      }
    }
    if (error instanceof ProjectUninstallError) {
      throw error;
    }
    throw new ProjectUninstallError(
      phase === "verify"
        ? "POST_UNINSTALL_VERIFICATION_FAILED"
        : "UNINSTALL_WRITE_FAILED",
      phase === "verify"
        ? "Uninstalled resources failed verification and the installation was restored."
        : "Uninstall failed and the installation was restored.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const cleanupWarnings: string[] = [];
  try {
    atomicReplaceFile(
      join(prepared.paths.recoveryDirectory, "transaction.json"),
      serialize(transactionRecord(plan, "uninstalled")),
      0o600,
    );
  } catch (error) {
    cleanupWarnings.push(
      `Committed uninstall recovery record could not be finalized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    unlinkSync(prepared.paths.markerPath);
  } catch (error) {
    cleanupWarnings.push(
      `Committed uninstall marker could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const retained = retainedFiles(plan);
  return {
    restoredFileCount,
    removedFileCount,
    alreadyCleanFileCount:
      plan.files.length - actionFiles(plan).length - retained.length,
    retainedFileCount: retained.length,
    retainedPaths: retained.map((file) => file.path),
    cleanupWarnings,
  };
}

export function runProjectUninstall(
  directory: string,
  options: ProjectUninstallOptions = {},
): ProjectUninstallResult {
  const plan = planProjectUninstall(directory, options);
  const applied = applyProjectUninstall(plan);
  return {
    status:
      applied.retainedFileCount === 0
        ? "uninstalled"
        : "uninstalled-with-retained-files",
    targetDirectory: plan.targetDirectory,
    packageName: plan.packageName,
    packageVersion: plan.packageVersion,
    managedFileCount: plan.files.length,
    manifestPath: plan.manifestPath,
    backupDirectory: plan.backupDirectory,
    recoveryDirectory: plan.recoveryDirectory,
    historyPath: plan.historyPath,
    ...applied,
  };
}

export function formatProjectUninstallResult(
  result: ProjectUninstallResult,
): string {
  const lines = [
    "OpenCode Android Orchestrator uninstall",
    "",
    `Result: ${result.status === "uninstalled" ? "UNINSTALLED" : "UNINSTALLED WITH RETAINED FILES"}`,
    `Project root: ${result.targetDirectory}`,
    `Package: ${result.packageName}@${result.packageVersion}`,
    `Managed files: ${String(result.managedFileCount)}`,
    `Restored original files: ${String(result.restoredFileCount)}`,
    `Removed unchanged files: ${String(result.removedFileCount)}`,
    `Already clean files: ${String(result.alreadyCleanFileCount)}`,
    `Retained modified or missing files: ${String(result.retainedFileCount)}`,
    `Removed active manifest: ${result.manifestPath}`,
    `Recovery evidence: ${result.recoveryDirectory}`,
    `Uninstall history: ${result.historyPath}`,
    `Original backups: ${result.backupDirectory}`,
  ];
  if (result.retainedPaths.length > 0) {
    lines.push("", "Retained paths requiring manual review:");
    lines.push(...result.retainedPaths.map((path) => `  ${path}`));
  }
  if (result.cleanupWarnings.length > 0) {
    lines.push("", "Cleanup warnings:");
    lines.push(...result.cleanupWarnings.map((warning) => `  ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}
