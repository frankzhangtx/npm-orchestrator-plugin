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
  compareSemanticVersions,
  parseOpenCodeVersion,
} from "../compatibility/versions.js";
import {
  AUTOMATION_CONFIG_RELATIVE_PATH,
  matchesManifestModuloVerificationPolicy,
} from "../config/verification-policy.js";
import {
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
} from "../doctor/index.js";
import { mergeAgentsConfigText } from "./agents-config.js";
import { detectAndroidProject } from "./android-project.js";
import {
  INSTALLATION_BACKUPS_DIRECTORY,
  INSTALLATION_CONTROL_DIRECTORY,
  INSTALLATION_HISTORY_DIRECTORY,
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  readInstallationManifest,
  verifyInstallationIntegrity,
  type InstallationFileInput,
  type InstallationFileStrategy,
  type InstallationManifest,
  type InstallationManifestFile,
  type PreviousInstallationFile,
} from "./install-manifest.js";
import {
  planProjectResourceInputs,
  runInitProcess,
  verifyInitializedProject,
  type InitProcessRunner,
  type InitVerificationReport,
} from "./init.js";
import {
  ORCHESTRATOR_PACKAGE_NAME,
  ORCHESTRATOR_PACKAGE_VERSION,
  mergeOpenCodeConfigText,
} from "./opencode-config.js";
import {
  isModuleScope,
  type GradleVerificationConfiguration,
  type ModuleScope,
} from "./adaptive-templates.js";

export const UPGRADE_MARKER_RELATIVE_PATH =
  `${INSTALLATION_CONTROL_DIRECTORY}/upgrade.json`;
export const UPGRADE_RECOVERY_DIRECTORY =
  `${INSTALLATION_CONTROL_DIRECTORY}/upgrades`;

const UNINSTALL_MARKER_RELATIVE_PATH =
  `${INSTALLATION_CONTROL_DIRECTORY}/uninstall.json`;

export type ProjectUpgradeErrorCode =
  | "DOCTOR_FAILED"
  | "INSTALLED_FILES_MODIFIED"
  | "INSTALLATION_INVALID"
  | "PACKAGE_MISMATCH"
  | "PLAN_STALE"
  | "POST_UPGRADE_VERIFICATION_FAILED"
  | "UPGRADE_CONFLICT"
  | "UPGRADE_IN_PROGRESS"
  | "UPGRADE_NOT_REQUIRED"
  | "UPGRADE_ROLLBACK_FAILED"
  | "UPGRADE_WRITE_FAILED"
  | "VERSION_DOWNGRADE_REFUSED"
  | "VERSION_INVALID";

export class ProjectUpgradeError extends Error {
  readonly code: ProjectUpgradeErrorCode;
  readonly details: readonly string[];

  constructor(
    code: ProjectUpgradeErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ProjectUpgradeError";
    this.code = code;
    this.details = details;
  }
}

export interface ProjectUpgradeOptions {
  androidSdkDirectory?: string;
  gradleVerification?: GradleVerificationConfiguration;
  installedAt?: string;
  longCommandTimeoutMs?: number;
  moduleScope?: ModuleScope;
  opencodeExecutable?: string;
  preparedAt?: string;
  primaryModule?: string;
  processRunner?: InitProcessRunner;
  upgradeId?: string;
}

export interface UpgradeFileSnapshot {
  existed: boolean;
  content: Uint8Array | null;
  sha256: string | null;
  size: number | null;
  mode: number | null;
}

export interface PlannedUpgradeFile {
  path: string;
  source: string;
  strategy: InstallationFileStrategy;
  content: Uint8Array;
  sha256: string;
  size: number;
  mode: number;
  before: UpgradeFileSnapshot;
  original: UpgradeFileSnapshot;
  previous: PreviousInstallationFile;
}

export interface PlannedUpgradeRemoval {
  path: string;
  before: UpgradeFileSnapshot;
  restore: UpgradeFileSnapshot;
}

export interface ProjectUpgradePlan {
  status: "already-current" | "upgrade";
  targetDirectory: string;
  moduleScope: ModuleScope;
  primaryModule: string;
  fromVersion: string;
  toVersion: string;
  upgradeId: string;
  preparedAt: string;
  installedAt: string;
  currentManifest: InstallationManifest;
  currentManifestContent: string;
  currentManifestSha256: string;
  desiredManifest: InstallationManifest;
  desiredManifestContent: string;
  desiredFiles: readonly PlannedUpgradeFile[];
  removedFiles: readonly PlannedUpgradeRemoval[];
  manifestPath: string;
  backupDirectory: string;
  recoveryDirectory: string;
  historyPath: string;
}

export interface AppliedProjectUpgrade {
  manifest: InstallationManifest;
  writtenFileCount: number;
  reusedFileCount: number;
  restoredOrRemovedFileCount: number;
  cleanupWarnings: readonly string[];
}

export interface ProjectUpgradeResult {
  status: "upgraded" | "already-current";
  targetDirectory: string;
  moduleScope: ModuleScope;
  primaryModule: string;
  fromVersion: string;
  toVersion: string;
  manifestPath: string;
  backupDirectory: string;
  recoveryDirectory: string | null;
  historyPath: string | null;
  managedFileCount: number;
  writtenFileCount: number;
  reusedFileCount: number;
  restoredOrRemovedFileCount: number;
  cleanupWarnings: readonly string[];
  manifest: InstallationManifest;
  doctor: DoctorReport;
  verification: InitVerificationReport;
}

interface UpgradeControlPaths {
  controlDirectory: string;
  backupsRoot: string;
  backupDirectory: string;
  backupStagingDirectory: string;
  upgradesRoot: string;
  recoveryDirectory: string;
  recoveryStagingDirectory: string;
  markerPath: string;
  historyDirectory: string;
  historyPath: string;
}

interface PreparedUpgrade {
  paths: UpgradeControlPaths;
  markerContent: string;
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

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? Buffer.from(content, "utf8")
    : Buffer.from(content);
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      `Upgrade timestamp must be canonical UTC ISO-8601: ${value}`,
    );
  }
  return value;
}

function validateUpgradeId(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      `Upgrade ID is not safe: ${value}`,
    );
  }
  return value;
}

function defaultUpgradeId(preparedAt: string): string {
  return validateUpgradeId(
    `upgrade-${preparedAt.replace(/[-:.TZ]/g, "")}-${randomUUID()}`,
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
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      `Upgrade path must be canonical and repository-relative: ${path}`,
    );
  }
  if (
    !allowControl &&
    (path === INSTALLATION_CONTROL_DIRECTORY ||
      path.startsWith(`${INSTALLATION_CONTROL_DIRECTORY}/`))
  ) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      `Upgrade cannot manage installer control state: ${path}`,
    );
  }
  return path;
}

function resolveTargetDirectory(directory: string): string {
  const targetDirectory = resolve(directory);
  try {
    const stats = lstatSync(targetDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ProjectUpgradeError(
        "INSTALLATION_INVALID",
        `Upgrade target is not a regular directory: ${targetDirectory}`,
      );
    }
  } catch (error) {
    if (error instanceof ProjectUpgradeError) {
      throw error;
    }
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      `Upgrade target does not exist or cannot be inspected: ${targetDirectory}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  return targetDirectory;
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
        throw new ProjectUpgradeError(
          "INSTALLATION_INVALID",
          `Upgrade path has an unsafe parent: ${current}`,
        );
      }
    } catch (error) {
      if (error instanceof ProjectUpgradeError) {
        throw error;
      }
      if (filesystemErrorCode(error) === "ENOENT") {
        return;
      }
      throw new ProjectUpgradeError(
        "INSTALLATION_INVALID",
        `Unable to inspect upgrade path parent: ${current}`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }
}

function snapshotFile(
  targetDirectory: string,
  relativePath: string,
  allowControl = false,
): UpgradeFileSnapshot {
  validateRelativePath(relativePath, allowControl);
  assertSafeAncestors(targetDirectory, relativePath);
  const absolutePath = join(targetDirectory, ...relativePath.split("/"));
  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ProjectUpgradeError(
        "INSTALLATION_INVALID",
        `Upgrade path is not a regular file: ${absolutePath}`,
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
    if (error instanceof ProjectUpgradeError) {
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
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      `Unable to inspect upgrade path: ${absolutePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function metadata(snapshot: UpgradeFileSnapshot): Omit<UpgradeFileSnapshot, "content"> {
  return {
    existed: snapshot.existed,
    sha256: snapshot.sha256,
    size: snapshot.size,
    mode: snapshot.mode,
  };
}

function snapshotFingerprint(snapshot: UpgradeFileSnapshot): Record<string, unknown> {
  return {
    ...metadata(snapshot),
    contentSha256:
      snapshot.content === null ? null : sha256(snapshot.content),
  };
}

function snapshotsMatch(
  left: UpgradeFileSnapshot,
  right: UpgradeFileSnapshot | PreviousInstallationFile,
): boolean {
  return (
    left.existed === right.existed &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function snapshotMatchesDesired(
  snapshot: UpgradeFileSnapshot,
  file: PlannedUpgradeFile,
): boolean {
  return (
    snapshot.existed &&
    snapshot.sha256 === file.sha256 &&
    snapshot.size === file.size &&
    snapshot.mode === file.mode
  );
}

function originalSnapshot(
  targetDirectory: string,
  file: InstallationManifestFile,
): UpgradeFileSnapshot {
  if (!file.previous.existed) {
    return {
      existed: false,
      content: null,
      sha256: null,
      size: null,
      mode: null,
    };
  }
  if (file.previous.backupPath === null) {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      `Original backup metadata is incomplete: ${file.path}`,
    );
  }
  const snapshot = snapshotFile(
    targetDirectory,
    file.previous.backupPath,
    true,
  );
  if (!snapshotsMatch(snapshot, file.previous)) {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      `Original backup failed integrity verification: ${file.path}`,
    );
  }
  return snapshot;
}

function manifestFileMatchesSnapshot(
  file: InstallationManifestFile,
  snapshot: UpgradeFileSnapshot,
): boolean {
  return (
    snapshot.existed &&
    snapshot.sha256 === file.sha256 &&
    snapshot.size === file.size &&
    snapshot.mode === file.mode
  );
}

function managedFileAcceptsSnapshot(
  file: InstallationManifestFile,
  snapshot: UpgradeFileSnapshot,
): boolean {
  if (manifestFileMatchesSnapshot(file, snapshot)) {
    return true;
  }
  return (
    file.path === AUTOMATION_CONFIG_RELATIVE_PATH &&
    snapshot.existed &&
    snapshot.content !== null &&
    snapshot.mode === file.mode &&
    matchesManifestModuloVerificationPolicy(snapshot.content, {
      sha256: file.sha256,
      size: file.size,
    })
  );
}

function readStableManifest(targetDirectory: string): {
  manifest: InstallationManifest;
  content: string;
  sha256: string;
} {
  const manifestSnapshotBefore = snapshotFile(
    targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
    true,
  );
  if (
    !manifestSnapshotBefore.existed ||
    manifestSnapshotBefore.content === null
  ) {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      "An installed manifest is required before upgrade.",
      ["Run init for a project that has never installed the orchestrator."],
    );
  }
  if (manifestSnapshotBefore.mode !== 0o600) {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      "The active installation manifest must have mode 0600.",
    );
  }
  const content = Buffer.from(manifestSnapshotBefore.content).toString("utf8");
  const manifest = readInstallationManifest(targetDirectory);
  const manifestSnapshotAfter = snapshotFile(
    targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
    true,
  );
  if (!snapshotsMatch(manifestSnapshotAfter, manifestSnapshotBefore)) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      "The installation manifest changed while upgrade was being planned.",
    );
  }
  return {
    manifest,
    content,
    sha256: manifestSnapshotBefore.sha256 as string,
  };
}

function assertNoUpgradeMarker(targetDirectory: string): void {
  const markers = [
    UPGRADE_MARKER_RELATIVE_PATH,
    UNINSTALL_MARKER_RELATIVE_PATH,
  ].filter(
    (path) => snapshotFile(targetDirectory, path, true).existed,
  );
  if (markers.length > 0) {
    throw new ProjectUpgradeError(
      "UPGRADE_IN_PROGRESS",
      "An unfinished installer transaction marker already exists.",
      [
        ...markers.map((path) => join(targetDirectory, ...path.split("/"))),
        `Inspect recovery evidence below ${join(targetDirectory, UPGRADE_RECOVERY_DIRECTORY)}.`,
      ],
    );
  }
}

function exactSemanticVersion(value: string): ReturnType<typeof parseOpenCodeVersion> {
  const parsed = parseOpenCodeVersion(value);
  return parsed !== null && parsed.normalized === value ? parsed : null;
}

function versionRelation(fromVersion: string, toVersion: string): number {
  const from = exactSemanticVersion(fromVersion);
  const to = exactSemanticVersion(toVersion);
  if (from === null || to === null) {
    throw new ProjectUpgradeError(
      "VERSION_INVALID",
      "Installed and target package versions must be canonical semantic versions.",
      [fromVersion, toVersion],
    );
  }
  return compareSemanticVersions(from, to);
}

function assertInstalledIntegrity(
  targetDirectory: string,
  manifest: InstallationManifest,
  expectedManifestSha256: string,
): void {
  if (manifest.installation.state !== "installed") {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      `Only an installed manifest can be upgraded: ${manifest.installation.state}`,
    );
  }
  if (manifest.package.name !== ORCHESTRATOR_PACKAGE_NAME) {
    throw new ProjectUpgradeError(
      "PACKAGE_MISMATCH",
      "The installed manifest belongs to a different package.",
      [manifest.package.name, ORCHESTRATOR_PACKAGE_NAME],
    );
  }
  const integrity = verifyInstallationIntegrity(targetDirectory);
  const changedManifest = snapshotFile(
    targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
    true,
  );
  if (changedManifest.sha256 !== expectedManifestSha256) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      "The installation manifest changed during integrity verification.",
    );
  }
  if (!integrity.ok) {
    throw new ProjectUpgradeError(
      "INSTALLED_FILES_MODIFIED",
      "Upgrade refused because managed files or original backups no longer match the installed manifest.",
      integrity.checks
        .filter(
          (check) =>
            check.installed === "missing" ||
            check.installed === "mismatch" ||
            check.backup === "missing" ||
            check.backup === "mismatch",
        )
        .map(
          (check) =>
            `${check.path}: installed=${check.installed}, backup=${check.backup}`,
        ),
    );
  }
}

function uniqueManifestFileBySource(
  manifest: InstallationManifest,
  source: string,
): InstallationManifestFile {
  const matches = manifest.files.filter((file) => file.source === source);
  if (matches.length !== 1) {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      `Installed manifest must contain exactly one ${source} entry.`,
      [`Found: ${matches.length}`],
    );
  }
  return matches[0] as InstallationManifestFile;
}

function textFromOriginal(
  targetDirectory: string,
  file: InstallationManifestFile,
  fallback: string,
): string {
  const original = originalSnapshot(targetDirectory, file);
  return original.content === null
    ? fallback
    : Buffer.from(original.content).toString("utf8");
}

interface ConfiguredAdaptiveOptions {
  moduleScope?: ModuleScope;
  primaryModule?: string;
  gradleVerification?: GradleVerificationConfiguration;
  lintEnabled?: boolean;
  unitTestsEnabled?: boolean;
  longCommandTimeoutMs?: number;
}

function configuredAdaptiveOptions(
  targetDirectory: string,
  manifest: InstallationManifest,
): ConfiguredAdaptiveOptions {
  const file = manifest.files.find(
    (candidate) => candidate.path === "automation/config.json",
  );
  if (file === undefined) {
    return { moduleScope: "primary" };
  }
  const snapshot = snapshotFile(targetDirectory, file.path);
  if (!managedFileAcceptsSnapshot(file, snapshot) || snapshot.content === null) {
    throw new ProjectUpgradeError(
      "INSTALLED_FILES_MODIFIED",
      "The installed automation configuration changed before upgrade planning.",
    );
  }
  let value: {
    androidProject?: { moduleScope?: unknown; primaryModule?: unknown };
    gradleVerification?: unknown;
    lintEnabled?: unknown;
    unitTestsEnabled?: unknown;
    longCommandTimeoutMs?: unknown;
  };
  try {
    value = JSON.parse(
      Buffer.from(snapshot.content).toString("utf8"),
    ) as typeof value;
  } catch (error) {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      "The installed automation configuration is not valid JSON.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const configured: ConfiguredAdaptiveOptions = {};
  const configuredModuleScope = value.androidProject?.moduleScope;
  if (configuredModuleScope === undefined) {
    configured.moduleScope = "primary";
  } else if (isModuleScope(configuredModuleScope)) {
    configured.moduleScope = configuredModuleScope;
  } else {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      "androidProject.moduleScope must be either all or primary.",
    );
  }
  if (typeof value.androidProject?.primaryModule === "string") {
    configured.primaryModule = value.androidProject.primaryModule;
  }
  if (value.gradleVerification !== undefined) {
    configured.gradleVerification =
      value.gradleVerification as GradleVerificationConfiguration;
  }
  if (value.lintEnabled !== undefined) {
    if (typeof value.lintEnabled !== "boolean") {
      throw new ProjectUpgradeError(
        "INSTALLATION_INVALID",
        "lintEnabled must be a boolean when present.",
      );
    }
    configured.lintEnabled = value.lintEnabled;
  }
  if (value.unitTestsEnabled !== undefined) {
    if (typeof value.unitTestsEnabled !== "boolean") {
      throw new ProjectUpgradeError(
        "INSTALLATION_INVALID",
        "unitTestsEnabled must be a boolean when present.",
      );
    }
    configured.unitTestsEnabled = value.unitTestsEnabled;
  }
  if (typeof value.longCommandTimeoutMs === "number") {
    configured.longCommandTimeoutMs = value.longCommandTimeoutMs;
  }
  return configured;
}

function desiredMergeInputs(
  targetDirectory: string,
  manifest: InstallationManifest,
): readonly InstallationFileInput[] {
  const agents = uniqueManifestFileBySource(
    manifest,
    "generated/agents-managed-block-merge",
  );
  const openCode = uniqueManifestFileBySource(
    manifest,
    "generated/opencode-config-merge",
  );
  return [
    {
      path: agents.path,
      source: agents.source,
      strategy: "merge",
      content: mergeAgentsConfigText(
        textFromOriginal(targetDirectory, agents, ""),
      ),
      mode: agents.mode,
    },
    {
      path: openCode.path,
      source: openCode.source,
      strategy: "merge",
      content: mergeOpenCodeConfigText(
        textFromOriginal(targetDirectory, openCode, "{}\n"),
      ).content,
      mode: openCode.mode,
    },
  ];
}

function previousMetadata(
  upgradeId: string,
  path: string,
  original: UpgradeFileSnapshot,
): PreviousInstallationFile {
  return original.existed
    ? {
        existed: true,
        sha256: original.sha256,
        size: original.size,
        mode: original.mode,
        backupPath: `${INSTALLATION_BACKUPS_DIRECTORY}/${upgradeId}/${path}`,
      }
    : {
        existed: false,
        sha256: null,
        size: null,
        mode: null,
        backupPath: null,
      };
}

function planDesiredFiles(
  targetDirectory: string,
  currentManifest: InstallationManifest,
  inputs: readonly InstallationFileInput[],
  upgradeId: string,
): readonly PlannedUpgradeFile[] {
  const currentByPath = new Map(
    currentManifest.files.map((file) => [file.path, file] as const),
  );
  const seen = new Set<string>();
  return inputs
    .map<PlannedUpgradeFile>((input) => {
      const path = validateRelativePath(input.path);
      if (seen.has(path)) {
        throw new ProjectUpgradeError(
          "PLAN_STALE",
          `Upgrade resource plan contains a duplicate path: ${path}`,
        );
      }
      seen.add(path);
      const content = bytes(input.content);
      const before = snapshotFile(targetDirectory, path);
      const current = currentByPath.get(path);
      if (current !== undefined && !managedFileAcceptsSnapshot(current, before)) {
        throw new ProjectUpgradeError(
          "INSTALLED_FILES_MODIFIED",
          `Managed file changed before upgrade planning: ${path}`,
        );
      }
      const mode = input.mode ?? current?.mode ?? before.mode ?? 0o644;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
        throw new ProjectUpgradeError(
          "PLAN_STALE",
          `Upgrade resource mode is invalid for ${path}: ${String(mode)}`,
        );
      }
      const desiredSha256 = sha256(content);
      if (
        current === undefined &&
        before.existed &&
        input.strategy !== "merge" &&
        !(
          before.sha256 === desiredSha256 &&
          before.size === content.byteLength &&
          before.mode === mode
        )
      ) {
        throw new ProjectUpgradeError(
          "UPGRADE_CONFLICT",
          `A newly managed path already contains different user content: ${path}`,
        );
      }
      const original =
        current === undefined
          ? before
          : originalSnapshot(targetDirectory, current);
      return {
        path,
        source: input.source,
        strategy: input.strategy,
        content,
        sha256: desiredSha256,
        size: content.byteLength,
        mode,
        before,
        original,
        previous: previousMetadata(upgradeId, path, original),
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

function planRemovedFiles(
  targetDirectory: string,
  currentManifest: InstallationManifest,
  desiredFiles: readonly PlannedUpgradeFile[],
): readonly PlannedUpgradeRemoval[] {
  const desiredPaths = new Set(desiredFiles.map((file) => file.path));
  return currentManifest.files
    .filter((file) => !desiredPaths.has(file.path))
    .map((file) => {
      const before = snapshotFile(targetDirectory, file.path);
      if (!manifestFileMatchesSnapshot(file, before)) {
        throw new ProjectUpgradeError(
          "INSTALLED_FILES_MODIFIED",
          `Obsolete managed file changed before upgrade planning: ${file.path}`,
        );
      }
      return {
        path: file.path,
        before,
        restore: originalSnapshot(targetDirectory, file),
      };
    });
}

function desiredManifest(
  upgradeId: string,
  preparedAt: string,
  installedAt: string,
  files: readonly PlannedUpgradeFile[],
): InstallationManifest {
  return {
    schemaVersion: 1,
    package: {
      name: ORCHESTRATOR_PACKAGE_NAME,
      version: ORCHESTRATOR_PACKAGE_VERSION,
    },
    installation: {
      id: upgradeId,
      state: "installed",
      preparedAt,
      installedAt,
      rolledBackAt: null,
    },
    backupDirectory: `${INSTALLATION_BACKUPS_DIRECTORY}/${upgradeId}`,
    files: files.map<InstallationManifestFile>((file) => ({
      path: file.path,
      source: file.source,
      strategy: file.strategy,
      sha256: file.sha256,
      size: file.size,
      mode: file.mode,
      previous: file.previous,
    })),
  };
}

function desiredFilesMatchCurrent(
  current: InstallationManifest,
  desired: InstallationManifest,
): boolean {
  return (
    current.files.length === desired.files.length &&
    current.files.every((file, index) => {
      const next = desired.files[index];
      return (
        next !== undefined &&
        file.path === next.path &&
        file.source === next.source &&
        file.strategy === next.strategy &&
        file.sha256 === next.sha256 &&
        file.size === next.size &&
        file.mode === next.mode
      );
    })
  );
}

function upgradeControlPaths(
  targetDirectory: string,
  upgradeId: string,
): UpgradeControlPaths {
  const controlDirectory = join(targetDirectory, INSTALLATION_CONTROL_DIRECTORY);
  const backupsRoot = join(targetDirectory, INSTALLATION_BACKUPS_DIRECTORY);
  const upgradesRoot = join(targetDirectory, UPGRADE_RECOVERY_DIRECTORY);
  const historyDirectory = join(targetDirectory, INSTALLATION_HISTORY_DIRECTORY);
  return {
    controlDirectory,
    backupsRoot,
    backupDirectory: join(backupsRoot, upgradeId),
    backupStagingDirectory: join(backupsRoot, `.staging-${upgradeId}`),
    upgradesRoot,
    recoveryDirectory: join(upgradesRoot, upgradeId),
    recoveryStagingDirectory: join(upgradesRoot, `.staging-${upgradeId}`),
    markerPath: join(
      targetDirectory,
      ...UPGRADE_MARKER_RELATIVE_PATH.split("/"),
    ),
    historyDirectory,
    historyPath: join(historyDirectory, `${upgradeId}.upgraded.json`),
  };
}

export function planProjectUpgrade(
  directory: string,
  options: ProjectUpgradeOptions = {},
): ProjectUpgradePlan {
  const detection = detectAndroidProject(directory);
  const requestedTarget = resolveTargetDirectory(
    detection.gitRoot ?? directory,
  );
  const stable = readStableManifest(requestedTarget);
  assertNoUpgradeMarker(requestedTarget);
  assertInstalledIntegrity(
    requestedTarget,
    stable.manifest,
    stable.sha256,
  );
  const relation = versionRelation(
    stable.manifest.package.version,
    ORCHESTRATOR_PACKAGE_VERSION,
  );
  if (relation > 0) {
    throw new ProjectUpgradeError(
      "VERSION_DOWNGRADE_REFUSED",
      "Upgrade refuses to replace a newer installed package with this older package.",
      [
        `Installed: ${stable.manifest.package.version}`,
        `Running: ${ORCHESTRATOR_PACKAGE_VERSION}`,
      ],
    );
  }

  const configured = configuredAdaptiveOptions(
    requestedTarget,
    stable.manifest,
  );
  const adaptiveOptions: ConfiguredAdaptiveOptions = {};
  const moduleScope =
    options.moduleScope ?? configured.moduleScope ?? "primary";
  adaptiveOptions.moduleScope = moduleScope;
  const primaryModule = options.primaryModule ?? configured.primaryModule;
  if (primaryModule !== undefined) {
    adaptiveOptions.primaryModule = primaryModule;
  }
  const gradleVerification =
    options.gradleVerification ?? configured.gradleVerification;
  if (gradleVerification !== undefined) {
    adaptiveOptions.gradleVerification = gradleVerification;
  }
  if (configured.lintEnabled !== undefined) {
    adaptiveOptions.lintEnabled = configured.lintEnabled;
  }
  if (configured.unitTestsEnabled !== undefined) {
    adaptiveOptions.unitTestsEnabled = configured.unitTestsEnabled;
  }
  const longCommandTimeoutMs =
    options.longCommandTimeoutMs ?? configured.longCommandTimeoutMs;
  if (longCommandTimeoutMs !== undefined) {
    adaptiveOptions.longCommandTimeoutMs = longCommandTimeoutMs;
  }
  const resources = planProjectResourceInputs(
    requestedTarget,
    adaptiveOptions,
  );
  if (resources.targetDirectory !== requestedTarget) {
    throw new ProjectUpgradeError(
      "INSTALLATION_INVALID",
      "The active manifest must be located at the detected Git/Gradle project root.",
      [requestedTarget, resources.targetDirectory],
    );
  }
  const preparedAt = validateTimestamp(
    options.preparedAt ?? new Date().toISOString(),
  );
  const installedAt = validateTimestamp(
    options.installedAt ?? preparedAt,
  );
  const upgradeId = validateUpgradeId(
    options.upgradeId ?? defaultUpgradeId(preparedAt),
  );
  const desiredFiles = planDesiredFiles(
    requestedTarget,
    stable.manifest,
    [
      ...resources.inputs,
      ...desiredMergeInputs(requestedTarget, stable.manifest),
    ],
    upgradeId,
  );
  const removedFiles = planRemovedFiles(
    requestedTarget,
    stable.manifest,
    desiredFiles,
  );
  const manifest = desiredManifest(
    upgradeId,
    preparedAt,
    installedAt,
    desiredFiles,
  );
  const paths = upgradeControlPaths(requestedTarget, upgradeId);
  const sameVersion = relation === 0;
  const resourcesMatch = desiredFilesMatchCurrent(stable.manifest, manifest);
  if (sameVersion && !resourcesMatch) {
    throw new ProjectUpgradeError(
      "UPGRADE_NOT_REQUIRED",
      "The installed package has the same version but different managed resources.",
      [
        "Package versions are immutable; install a newer package version before upgrading.",
      ],
    );
  }

  return {
    status: sameVersion ? "already-current" : "upgrade",
    targetDirectory: requestedTarget,
    moduleScope: resources.adaptiveTemplates.moduleScope,
    primaryModule: resources.adaptiveTemplates.primaryModule.gradlePath,
    fromVersion: stable.manifest.package.version,
    toVersion: ORCHESTRATOR_PACKAGE_VERSION,
    upgradeId,
    preparedAt,
    installedAt,
    currentManifest: stable.manifest,
    currentManifestContent: stable.content,
    currentManifestSha256: stable.sha256,
    desiredManifest: manifest,
    desiredManifestContent: serialize(manifest),
    desiredFiles,
    removedFiles,
    manifestPath: join(
      requestedTarget,
      ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
    ),
    backupDirectory: paths.backupDirectory,
    recoveryDirectory: paths.recoveryDirectory,
    historyPath: paths.historyPath,
  };
}

function planFingerprint(plan: ProjectUpgradePlan): string {
  return serialize({
    status: plan.status,
    targetDirectory: plan.targetDirectory,
    moduleScope: plan.moduleScope,
    primaryModule: plan.primaryModule,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    upgradeId: plan.upgradeId,
    preparedAt: plan.preparedAt,
    installedAt: plan.installedAt,
    currentManifest: plan.currentManifest,
    currentManifestContent: plan.currentManifestContent,
    currentManifestSha256: plan.currentManifestSha256,
    desiredManifest: plan.desiredManifest,
    desiredManifestContent: plan.desiredManifestContent,
    desiredFiles: plan.desiredFiles.map((file) => ({
      path: file.path,
      source: file.source,
      strategy: file.strategy,
      contentSha256: sha256(file.content),
      sha256: file.sha256,
      size: file.size,
      mode: file.mode,
      before: snapshotFingerprint(file.before),
      original: snapshotFingerprint(file.original),
      previous: file.previous,
    })),
    removedFiles: plan.removedFiles.map((file) => ({
      path: file.path,
      before: snapshotFingerprint(file.before),
      restore: snapshotFingerprint(file.restore),
    })),
    manifestPath: plan.manifestPath,
    backupDirectory: plan.backupDirectory,
    recoveryDirectory: plan.recoveryDirectory,
    historyPath: plan.historyPath,
  });
}

function assertPlanConsistent(plan: ProjectUpgradePlan): void {
  const replanned = planProjectUpgrade(plan.targetDirectory, {
    moduleScope: plan.moduleScope,
    primaryModule: plan.primaryModule,
    upgradeId: plan.upgradeId,
    preparedAt: plan.preparedAt,
    installedAt: plan.installedAt,
  });
  if (planFingerprint(plan) !== planFingerprint(replanned)) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      "Upgrade plan or target state changed after planning.",
    );
  }
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
      throw new ProjectUpgradeError(
        "UPGRADE_CONFLICT",
        `Upgrade control path is not a regular directory: ${path}`,
      );
    }
    return false;
  }
}

function assertPathMissing(path: string): void {
  try {
    lstatSync(path);
    throw new ProjectUpgradeError(
      "UPGRADE_CONFLICT",
      `Upgrade control path already exists: ${path}`,
    );
  } catch (error) {
    if (error instanceof ProjectUpgradeError) {
      throw error;
    }
    if (filesystemErrorCode(error) !== "ENOENT") {
      throw new ProjectUpgradeError(
        "UPGRADE_CONFLICT",
        `Unable to inspect upgrade control path: ${path}`,
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

function createManagedParentDirectories(
  targetDirectory: string,
  relativePath: string,
  createdDirectories: string[],
): void {
  let current = targetDirectory;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ProjectUpgradeError(
          "UPGRADE_CONFLICT",
          `Managed path has an unsafe parent: ${current}`,
        );
      }
    } catch (error) {
      if (error instanceof ProjectUpgradeError) {
        throw error;
      }
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
      mkdirSync(current, { mode: 0o755 });
      createdDirectories.push(current);
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

function cleanupCreatedDirectories(directories: readonly string[]): void {
  for (const directory of [...directories].reverse()) {
    safeRemoveDirectory(directory);
  }
}

function affectedSnapshots(
  plan: ProjectUpgradePlan,
): ReadonlyMap<string, UpgradeFileSnapshot> {
  return new Map([
    ...plan.desiredFiles.map((file) => [file.path, file.before] as const),
    ...plan.removedFiles.map((file) => [file.path, file.before] as const),
  ]);
}

function transactionRecord(
  plan: ProjectUpgradePlan,
  state: "prepared" | "installed" | "rolledBack",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: plan.upgradeId,
    state,
    package: {
      name: ORCHESTRATOR_PACKAGE_NAME,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
    },
    preparedAt: plan.preparedAt,
    installedAt: state === "installed" ? plan.installedAt : null,
    previousManifestSha256: plan.currentManifestSha256,
    desiredManifestSha256: sha256(plan.desiredManifestContent),
    recoveryDirectory: `${UPGRADE_RECOVERY_DIRECTORY}/${plan.upgradeId}`,
    backupDirectory: `${INSTALLATION_BACKUPS_DIRECTORY}/${plan.upgradeId}`,
    files: [
      ...plan.desiredFiles.map((file) => ({
        path: file.path,
        before: metadata(file.before),
        after: {
          existed: true,
          sha256: file.sha256,
          size: file.size,
          mode: file.mode,
        },
      })),
      ...plan.removedFiles.map((file) => ({
        path: file.path,
        before: metadata(file.before),
        after: metadata(file.restore),
      })),
    ],
  };
}

function writeSnapshot(
  root: string,
  relativePath: string,
  snapshot: UpgradeFileSnapshot,
): void {
  if (!snapshot.existed || snapshot.content === null || snapshot.mode === null) {
    return;
  }
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, snapshot.content, {
    flag: "wx",
    mode: snapshot.mode,
  });
  chmodSync(path, snapshot.mode);
}

function verifyPreparedUpgrade(
  plan: ProjectUpgradePlan,
  paths: UpgradeControlPaths,
): void {
  const previousManifest = readFileSync(
    join(paths.recoveryDirectory, "previous-manifest.json"),
  );
  if (sha256(previousManifest) !== plan.currentManifestSha256) {
    throw new ProjectUpgradeError(
      "UPGRADE_WRITE_FAILED",
      "The recovery copy of the previous manifest failed verification.",
    );
  }
  for (const [path, before] of affectedSnapshots(plan)) {
    if (!before.existed) {
      continue;
    }
    const recovery = snapshotFile(
      paths.recoveryDirectory,
      `files/${path}`,
    );
    if (!snapshotsMatch(recovery, before)) {
      throw new ProjectUpgradeError(
        "UPGRADE_WRITE_FAILED",
        `Upgrade recovery snapshot failed verification: ${path}`,
      );
    }
  }
  for (const file of plan.desiredFiles) {
    if (!file.original.existed) {
      continue;
    }
    const backup = snapshotFile(paths.backupDirectory, file.path);
    if (!snapshotsMatch(backup, file.original)) {
      throw new ProjectUpgradeError(
        "UPGRADE_WRITE_FAILED",
        `Preserved original backup failed verification: ${file.path}`,
      );
    }
  }
}

function prepareUpgrade(plan: ProjectUpgradePlan): PreparedUpgrade {
  const paths = upgradeControlPaths(plan.targetDirectory, plan.upgradeId);
  assertPathMissing(paths.markerPath);
  assertPathMissing(paths.backupDirectory);
  assertPathMissing(paths.backupStagingDirectory);
  assertPathMissing(paths.recoveryDirectory);
  assertPathMissing(paths.recoveryStagingDirectory);
  createDirectory(paths.controlDirectory);
  createDirectory(paths.backupsRoot);
  createDirectory(paths.upgradesRoot);
  let backupPublished = false;
  let recoveryPublished = false;
  let markerPublished = false;

  try {
    mkdirSync(paths.backupStagingDirectory, { mode: 0o700 });
    mkdirSync(paths.recoveryStagingDirectory, { mode: 0o700 });
    writeFileSync(
      join(paths.recoveryStagingDirectory, "previous-manifest.json"),
      plan.currentManifestContent,
      { flag: "wx", mode: 0o600 },
    );
    for (const [path, before] of affectedSnapshots(plan)) {
      writeSnapshot(paths.recoveryStagingDirectory, `files/${path}`, before);
    }
    for (const file of plan.desiredFiles) {
      writeSnapshot(paths.backupStagingDirectory, file.path, file.original);
    }
    writeFileSync(
      join(paths.recoveryStagingDirectory, "transaction.json"),
      serialize(transactionRecord(plan, "prepared")),
      { flag: "wx", mode: 0o600 },
    );

    renameSync(paths.backupStagingDirectory, paths.backupDirectory);
    backupPublished = true;
    renameSync(paths.recoveryStagingDirectory, paths.recoveryDirectory);
    recoveryPublished = true;
    verifyPreparedUpgrade(plan, paths);

    const markerContent = serialize(transactionRecord(plan, "prepared"));
    publishNewFile(paths.markerPath, markerContent, 0o600);
    markerPublished = true;
    return {
      paths,
      markerContent,
      markerSha256: sha256(markerContent),
    };
  } catch (error) {
    if (!markerPublished) {
      rmSync(paths.backupStagingDirectory, { recursive: true, force: true });
      rmSync(paths.recoveryStagingDirectory, { recursive: true, force: true });
      if (backupPublished) {
        rmSync(paths.backupDirectory, { recursive: true, force: true });
      }
      if (recoveryPublished) {
        rmSync(paths.recoveryDirectory, { recursive: true, force: true });
      }
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new ProjectUpgradeError(
      "UPGRADE_WRITE_FAILED",
      "Unable to prepare upgrade recovery state.",
      [String(error)],
    );
  }
}

function assertManifestUnchanged(plan: ProjectUpgradePlan): void {
  const current = snapshotFile(
    plan.targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
    true,
  );
  if (
    !current.existed ||
    current.sha256 !== plan.currentManifestSha256 ||
    current.mode !== 0o600
  ) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      "The active installation manifest changed during upgrade.",
    );
  }
}

function assertMarkerUnchanged(prepared: PreparedUpgrade): void {
  const marker = readFileSync(prepared.paths.markerPath);
  if (sha256(marker) !== prepared.markerSha256) {
    throw new ProjectUpgradeError(
      "PLAN_STALE",
      "The upgrade transaction marker changed during upgrade.",
    );
  }
}

function restoreSnapshot(
  targetDirectory: string,
  path: string,
  snapshot: UpgradeFileSnapshot,
  createdDirectories: string[],
): void {
  const current = snapshotFile(targetDirectory, path);
  const absolutePath = join(targetDirectory, ...path.split("/"));
  if (snapshot.existed) {
    if (snapshot.content === null || snapshot.mode === null) {
      throw new ProjectUpgradeError(
        "UPGRADE_ROLLBACK_FAILED",
        `Recovery snapshot is incomplete: ${path}`,
      );
    }
    createManagedParentDirectories(
      targetDirectory,
      path,
      createdDirectories,
    );
    if (current.existed) {
      atomicReplaceFile(absolutePath, snapshot.content, snapshot.mode);
    } else {
      publishNewFile(absolutePath, snapshot.content, snapshot.mode);
    }
  } else if (current.existed) {
    unlinkSync(absolutePath);
  }
}

function rollbackUpgrade(
  plan: ProjectUpgradePlan,
  prepared: PreparedUpgrade,
  createdDirectories: readonly string[],
  historyPublished: boolean,
): void {
  assertManifestUnchanged(plan);
  assertMarkerUnchanged(prepared);
  const beforeByPath = affectedSnapshots(plan);
  const unsafe: string[] = [];
  for (const [path, before] of beforeByPath) {
    const current = snapshotFile(plan.targetDirectory, path);
    const desired = plan.desiredFiles.find((file) => file.path === path);
    const removal = plan.removedFiles.find((file) => file.path === path);
    const plannedAfter =
      desired === undefined
        ? removal?.restore
        : {
            existed: true,
            content: desired.content,
            sha256: desired.sha256,
            size: desired.size,
            mode: desired.mode,
          };
    if (
      !snapshotsMatch(current, before) &&
      (plannedAfter === undefined || !snapshotsMatch(current, plannedAfter))
    ) {
      unsafe.push(path);
    }
  }
  if (unsafe.length > 0) {
    throw new ProjectUpgradeError(
      "UPGRADE_ROLLBACK_FAILED",
      "Upgrade rollback refused concurrently modified paths.",
      unsafe,
    );
  }

  const rollbackDirectories: string[] = [];
  for (const [path, before] of beforeByPath) {
    restoreSnapshot(plan.targetDirectory, path, before, rollbackDirectories);
  }
  const failed = [...beforeByPath]
    .filter(([path, before]) =>
      !snapshotsMatch(snapshotFile(plan.targetDirectory, path), before),
    )
    .map(([path]) => path);
  if (failed.length > 0) {
    throw new ProjectUpgradeError(
      "UPGRADE_ROLLBACK_FAILED",
      "Upgrade rollback did not restore every managed path.",
      failed,
    );
  }

  cleanupCreatedDirectories([...createdDirectories, ...rollbackDirectories]);
  if (historyPublished) {
    unlinkSync(prepared.paths.historyPath);
  }
  rmSync(prepared.paths.backupDirectory, { recursive: true, force: true });
  unlinkSync(prepared.paths.markerPath);
  try {
    atomicReplaceFile(
      join(prepared.paths.recoveryDirectory, "transaction.json"),
      serialize(transactionRecord(plan, "rolledBack")),
      0o600,
    );
  } catch {
    // Recovery bytes and the previous manifest remain sufficient for audit.
  }
}

function verifyPlannedState(plan: ProjectUpgradePlan): void {
  const failures = [
    ...plan.desiredFiles
      .filter(
        (file) =>
          !snapshotMatchesDesired(
            snapshotFile(plan.targetDirectory, file.path),
            file,
          ),
      )
      .map((file) => file.path),
    ...plan.removedFiles
      .filter(
        (file) =>
          !snapshotsMatch(
            snapshotFile(plan.targetDirectory, file.path),
            file.restore,
          ),
      )
      .map((file) => file.path),
  ];
  if (failures.length > 0) {
    throw new ProjectUpgradeError(
      "UPGRADE_WRITE_FAILED",
      "Upgraded paths failed SHA-256, size, mode, or removal verification.",
      failures,
    );
  }
}

export function applyProjectUpgrade(
  plan: ProjectUpgradePlan,
  verify?: () => void,
): AppliedProjectUpgrade {
  if (plan.status !== "upgrade") {
    throw new ProjectUpgradeError(
      "UPGRADE_NOT_REQUIRED",
      "The project already has the current package version and resources.",
    );
  }
  assertPlanConsistent(plan);
  const prepared = prepareUpgrade(plan);
  const createdDirectories: string[] = [];
  let writtenFileCount = 0;
  let reusedFileCount = 0;
  let restoredOrRemovedFileCount = 0;
  let historyPublished = false;
  let committed = false;

  try {
    assertManifestUnchanged(plan);
    assertMarkerUnchanged(prepared);
    for (const [path, before] of affectedSnapshots(plan)) {
      if (!snapshotsMatch(snapshotFile(plan.targetDirectory, path), before)) {
        throw new ProjectUpgradeError(
          "PLAN_STALE",
          `Upgrade target changed after recovery preparation: ${path}`,
        );
      }
    }

    for (const file of plan.desiredFiles) {
      assertManifestUnchanged(plan);
      assertMarkerUnchanged(prepared);
      const current = snapshotFile(plan.targetDirectory, file.path);
      if (snapshotMatchesDesired(current, file)) {
        reusedFileCount += 1;
        continue;
      }
      if (!snapshotsMatch(current, file.before)) {
        throw new ProjectUpgradeError(
          "PLAN_STALE",
          `Managed file changed before upgrade write: ${file.path}`,
        );
      }
      createManagedParentDirectories(
        plan.targetDirectory,
        file.path,
        createdDirectories,
      );
      const absolutePath = join(
        plan.targetDirectory,
        ...file.path.split("/"),
      );
      if (current.existed) {
        atomicReplaceFile(absolutePath, file.content, file.mode);
      } else {
        publishNewFile(absolutePath, file.content, file.mode);
      }
      if (!snapshotMatchesDesired(snapshotFile(plan.targetDirectory, file.path), file)) {
        throw new ProjectUpgradeError(
          "UPGRADE_WRITE_FAILED",
          `Upgraded file failed verification: ${file.path}`,
        );
      }
      writtenFileCount += 1;
    }

    for (const file of plan.removedFiles) {
      assertManifestUnchanged(plan);
      assertMarkerUnchanged(prepared);
      const current = snapshotFile(plan.targetDirectory, file.path);
      if (!snapshotsMatch(current, file.before)) {
        throw new ProjectUpgradeError(
          "PLAN_STALE",
          `Obsolete managed file changed before restoration: ${file.path}`,
        );
      }
      restoreSnapshot(
        plan.targetDirectory,
        file.path,
        file.restore,
        createdDirectories,
      );
      restoredOrRemovedFileCount += 1;
    }

    verifyPlannedState(plan);
    verify?.();
    verifyPlannedState(plan);
    assertManifestUnchanged(plan);
    assertMarkerUnchanged(prepared);

    createDirectory(prepared.paths.historyDirectory);
    publishNewFile(
      prepared.paths.historyPath,
      serialize(transactionRecord(plan, "installed")),
      0o600,
    );
    historyPublished = true;
    atomicReplaceFile(plan.manifestPath, plan.desiredManifestContent, 0o600);
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        rollbackUpgrade(
          plan,
          prepared,
          createdDirectories,
          historyPublished,
        );
      } catch (rollbackError) {
        throw new ProjectUpgradeError(
          "UPGRADE_ROLLBACK_FAILED",
          "Upgrade failed and automatic rollback could not complete safely.",
          [
            `Original failure: ${error instanceof Error ? error.message : String(error)}`,
            `Rollback failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            `Recovery evidence: ${prepared.paths.recoveryDirectory}`,
          ],
        );
      }
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new ProjectUpgradeError(
      "UPGRADE_WRITE_FAILED",
      "Upgrade failed and was rolled back.",
      [String(error)],
    );
  }

  const cleanupWarnings: string[] = [];
  try {
    unlinkSync(prepared.paths.markerPath);
  } catch (error) {
    cleanupWarnings.push(
      `Committed upgrade marker could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    manifest: plan.desiredManifest,
    writtenFileCount,
    reusedFileCount,
    restoredOrRemovedFileCount,
    cleanupWarnings,
  };
}

function doctorForUpgrade(
  directory: string,
  options: ProjectUpgradeOptions,
  runner: InitProcessRunner,
): DoctorReport {
  const report = runDoctor({
    ...(options.androidSdkDirectory === undefined
      ? {}
      : { androidSdkDirectory: options.androidSdkDirectory }),
    checkDependencies: true,
    targetDirectory: directory,
    ...(options.opencodeExecutable === undefined
      ? {}
      : { opencodeExecutable: options.opencodeExecutable }),
    runCommand: (executable, args) =>
      runner(executable, args, { cwd: resolve(directory), timeoutMs: 10_000 }),
  });
  if (!report.ok) {
    throw new ProjectUpgradeError(
      "DOCTOR_FAILED",
      "Upgrade prerequisites failed before any project file was changed.",
      report.checks
        .filter((check) => check.status === "fail")
        .map((check) => `${check.label}: ${check.summary}`),
    );
  }
  return report;
}

function assertVerificationPassed(report: InitVerificationReport): void {
  if (!report.ok) {
    throw new ProjectUpgradeError(
      "POST_UPGRADE_VERIFICATION_FAILED",
      "Upgraded resources failed verification and the previous version will be restored.",
      report.checks
        .filter((check) => check.status === "fail")
        .flatMap((check) => [check.summary, ...check.details]),
    );
  }
}

export function runProjectUpgrade(
  directory: string,
  options: ProjectUpgradeOptions = {},
): ProjectUpgradeResult {
  const runner = options.processRunner ?? runInitProcess;
  const doctor = doctorForUpgrade(directory, options, runner);
  const plan = planProjectUpgrade(directory, options);

  if (plan.status === "already-current") {
    const verification = verifyInitializedProject(plan.targetDirectory, runner);
    assertVerificationPassed(verification);
    return {
      status: "already-current",
      targetDirectory: plan.targetDirectory,
      moduleScope: plan.moduleScope,
      primaryModule: plan.primaryModule,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      manifestPath: plan.manifestPath,
      backupDirectory: join(
        plan.targetDirectory,
        ...plan.currentManifest.backupDirectory.split("/"),
      ),
      recoveryDirectory: null,
      historyPath: null,
      managedFileCount: plan.currentManifest.files.length,
      writtenFileCount: 0,
      reusedFileCount: plan.currentManifest.files.length,
      restoredOrRemovedFileCount: 0,
      cleanupWarnings: [],
      manifest: plan.currentManifest,
      doctor,
      verification,
    };
  }

  let verification: InitVerificationReport | null = null;
  const applied = applyProjectUpgrade(plan, () => {
    verification = verifyInitializedProject(plan.targetDirectory, runner);
    assertVerificationPassed(verification);
  });
  if (verification === null) {
    throw new ProjectUpgradeError(
      "POST_UPGRADE_VERIFICATION_FAILED",
      "Upgrade verification did not produce a report.",
    );
  }
  return {
    status: "upgraded",
    targetDirectory: plan.targetDirectory,
    moduleScope: plan.moduleScope,
    primaryModule: plan.primaryModule,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    manifestPath: plan.manifestPath,
    backupDirectory: plan.backupDirectory,
    recoveryDirectory: plan.recoveryDirectory,
    historyPath: plan.historyPath,
    managedFileCount: applied.manifest.files.length,
    writtenFileCount: applied.writtenFileCount,
    reusedFileCount: applied.reusedFileCount,
    restoredOrRemovedFileCount: applied.restoredOrRemovedFileCount,
    cleanupWarnings: applied.cleanupWarnings,
    manifest: applied.manifest,
    doctor,
    verification,
  };
}

export function formatProjectUpgradeResult(result: ProjectUpgradeResult): string {
  const lines = [
    "OpenCode Android Orchestrator upgrade",
    "",
    `Result: ${result.status === "upgraded" ? "UPGRADED" : "ALREADY CURRENT"}`,
    `Project root: ${result.targetDirectory}`,
    `Module scope: ${result.moduleScope}`,
    `Default module: ${result.primaryModule}`,
    `Version: ${result.fromVersion} -> ${result.toVersion}`,
    `Managed files: ${String(result.managedFileCount)}`,
    `Written files: ${String(result.writtenFileCount)}`,
    `Reused files: ${String(result.reusedFileCount)}`,
    `Restored/removed obsolete files: ${String(result.restoredOrRemovedFileCount)}`,
    `Manifest: ${result.manifestPath}`,
    `Original-file backups: ${result.backupDirectory}`,
    ...(result.recoveryDirectory === null
      ? []
      : [`Upgrade recovery: ${result.recoveryDirectory}`]),
    ...(result.historyPath === null
      ? []
      : [`Upgrade history: ${result.historyPath}`]),
    ...result.cleanupWarnings.map((warning) => `Warning: ${warning}`),
    "",
    formatDoctorReport(result.doctor).trimEnd(),
    "",
    ...result.verification.checks.map(
      (check) => `[${check.status.toUpperCase()}] ${check.summary}`,
    ),
    "",
    `Next: opencode --agent scheduled-planner ${result.targetDirectory}`,
  ];
  return `${lines.join("\n")}\n`;
}
