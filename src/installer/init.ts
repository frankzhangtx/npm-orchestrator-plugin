import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatDoctorReport,
  runDoctor,
  type CommandResult,
  type DoctorReport,
} from "../doctor/index.js";
import {
  planAdaptiveProjectTemplates,
  type AdaptiveProjectTemplateOptions,
  type AdaptiveProjectTemplatePlan,
  type ModuleScope,
} from "./adaptive-templates.js";
import {
  GradleVerificationDiscoveryError,
  discoverGradleVerificationConfiguration,
} from "./gradle-verification.js";
import {
  planAgentsConfigMerge,
  type AgentsConfigMergePlan,
} from "./agents-config.js";
import {
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  InstallationManifestError,
  applyInstallationPlan,
  planInstallationPreparation,
  readInstallationManifest,
  verifyInstallationIntegrity,
  type AppliedInstallation,
  type InstallationFileInput,
  type InstallationManifest,
  type InstallationPreparationOptions,
  type InstallationPreparationPlan,
} from "./install-manifest.js";
import {
  ORCHESTRATOR_PACKAGE_NAME,
  ORCHESTRATOR_PACKAGE_VERSION,
  planOpenCodeConfigMerge,
  type OpenCodeConfigMergePlan,
} from "./opencode-config.js";

const TEMPLATE_COPY_ROOTS = [
  ".opencode",
  "scripts/automation",
] as const;
const TEMPLATE_COPY_FILES = [
  "automation/config.schema.json",
  "automation/task-contract.schema.json",
  "docs/plans/README.md",
] as const;

export const WORKTREE_ALLOWLIST_RELATIVE_PATH =
  ".automation-worktree-allowlist";
export const INITIAL_WORKTREE_ALLOWLIST_CONTENT = [
  "# Optional: one exact repository-relative file path per line.",
  "# Blank lines and lines beginning with # are ignored.",
  "",
].join("\n");

export type ProjectInitializationErrorCode =
  | "DOCTOR_FAILED"
  | "EXISTING_INSTALLATION_DIFFERENT"
  | "EXISTING_INSTALLATION_INVALID"
  | "GRADLE_DISCOVERY_FAILED"
  | "POST_INSTALL_VERIFICATION_FAILED"
  | "TEMPLATE_INVALID"
  | "WORKTREE_ALLOWLIST_INVALID"
  | "WORKTREE_ALLOWLIST_ROLLBACK_FAILED"
  | "WORKTREE_ALLOWLIST_WRITE_FAILED";

export class ProjectInitializationError extends Error {
  readonly code: ProjectInitializationErrorCode;
  readonly details: readonly string[];

  constructor(
    code: ProjectInitializationErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ProjectInitializationError";
    this.code = code;
    this.details = details;
  }
}

export interface InitProcessOptions {
  cwd: string;
  timeoutMs: number;
}

export type InitProcessRunner = (
  executable: string,
  args: readonly string[],
  options: InitProcessOptions,
) => CommandResult;

export interface ProjectInitializationOptions
  extends AdaptiveProjectTemplateOptions {
  androidSdkDirectory?: string;
  installationId?: string;
  preparedAt?: string;
  installedAt?: string;
  opencodeExecutable?: string;
  processRunner?: InitProcessRunner;
}

export interface ProjectInitializationPlan {
  targetDirectory: string;
  adaptiveTemplates: AdaptiveProjectTemplatePlan;
  agentsMerge: AgentsConfigMergePlan;
  openCodeConfigMerge: OpenCodeConfigMergePlan;
  installation: InstallationPreparationPlan;
}

export interface ProjectResourceInputPlan {
  targetDirectory: string;
  adaptiveTemplates: AdaptiveProjectTemplatePlan;
  inputs: readonly InstallationFileInput[];
}

export type InitVerificationStatus = "pass" | "fail";

export interface InitVerificationCheck {
  id: "automation-tests" | "shadow-run";
  status: InitVerificationStatus;
  summary: string;
  details: readonly string[];
}

export interface InitVerificationReport {
  ok: boolean;
  checks: readonly InitVerificationCheck[];
}

export interface ProjectInitializationResult {
  status: "installed" | "already-installed";
  targetDirectory: string;
  moduleScope: ModuleScope;
  primaryModule: string;
  manifestPath: string;
  backupDirectory: string;
  managedFileCount: number;
  writtenFileCount: number;
  reusedFileCount: number;
  worktreeAllowlistPath: string;
  worktreeAllowlistStatus: WorktreeAllowlistInitializationStatus;
  manifest: InstallationManifest;
  doctor: DoctorReport;
  verification: InitVerificationReport;
}

export type WorktreeAllowlistInitializationStatus = "created" | "existing";

interface WorktreeAllowlistInitialization {
  path: string;
  status: WorktreeAllowlistInitializationStatus;
}

export const runInitProcess: InitProcessRunner = (
  executable,
  args,
  options,
) => {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
};

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function assertExistingWorktreeAllowlistIsRegular(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new ProjectInitializationError(
      "WORKTREE_ALLOWLIST_WRITE_FAILED",
      `Unable to inspect the worktree allowlist: ${path}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProjectInitializationError(
      "WORKTREE_ALLOWLIST_INVALID",
      "The worktree allowlist must be a regular file, not a symlink or directory.",
      [path],
    );
  }
}

function initializeWorktreeAllowlist(
  targetDirectory: string,
): WorktreeAllowlistInitialization {
  const path = join(targetDirectory, WORKTREE_ALLOWLIST_RELATIVE_PATH);
  try {
    lstatSync(path);
    assertExistingWorktreeAllowlistIsRegular(path);
    return { path, status: "existing" };
  } catch (error) {
    if (
      error instanceof ProjectInitializationError ||
      filesystemErrorCode(error) !== "ENOENT"
    ) {
      if (error instanceof ProjectInitializationError) {
        throw error;
      }
      throw new ProjectInitializationError(
        "WORKTREE_ALLOWLIST_WRITE_FAILED",
        `Unable to inspect the worktree allowlist target: ${path}`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }

  try {
    writeFileSync(path, INITIAL_WORKTREE_ALLOWLIST_CONTENT, {
      flag: "wx",
      mode: 0o644,
    });
    return { path, status: "created" };
  } catch (error) {
    if (filesystemErrorCode(error) === "EEXIST") {
      assertExistingWorktreeAllowlistIsRegular(path);
      return { path, status: "existing" };
    }
    throw new ProjectInitializationError(
      "WORKTREE_ALLOWLIST_WRITE_FAILED",
      `Unable to create the worktree allowlist: ${path}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function rollbackWorktreeAllowlistInitialization(
  initialization: WorktreeAllowlistInitialization,
  originalError: unknown,
): never {
  if (initialization.status === "created") {
    try {
      const stats = lstatSync(initialization.path);
      const content = readFileSync(initialization.path, "utf8");
      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        content !== INITIAL_WORKTREE_ALLOWLIST_CONTENT
      ) {
        throw new Error(
          "The newly created allowlist changed during initialization and was preserved.",
        );
      }
      unlinkSync(initialization.path);
    } catch (error) {
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw new ProjectInitializationError(
          "WORKTREE_ALLOWLIST_ROLLBACK_FAILED",
          "Initialization failed and the automatically created worktree allowlist could not be rolled back safely.",
          [
            `Original failure: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
            `Allowlist rollback failure: ${error instanceof Error ? error.message : String(error)}`,
            `Preserved path: ${initialization.path}`,
          ],
        );
      }
    }
  }
  throw originalError;
}

function templateRoot(): string {
  return fileURLToPath(new URL("../../templates/", import.meta.url));
}

function templateError(message: string, error?: unknown): never {
  throw new ProjectInitializationError(
    "TEMPLATE_INVALID",
    message,
    error === undefined
      ? []
      : [error instanceof Error ? error.message : String(error)],
  );
}

function readTemplateFile(
  templatesDirectory: string,
  relativePath: string,
): InstallationFileInput {
  const absolutePath = join(
    templatesDirectory,
    ...relativePath.split("/"),
  );
  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return templateError(
        `Packaged installation template is not a regular file: ${relativePath}`,
      );
    }
    return {
      path: relativePath,
      source: `templates/${relativePath}`,
      strategy: "copy",
      content: readFileSync(absolutePath),
      mode: stats.mode & 0o777,
    };
  } catch (error) {
    if (error instanceof ProjectInitializationError) {
      throw error;
    }
    return templateError(
      `Unable to read packaged installation template: ${relativePath}`,
      error,
    );
  }
}

function collectTemplateDirectory(
  templatesDirectory: string,
  relativeDirectory: string,
): readonly InstallationFileInput[] {
  const absoluteDirectory = join(
    templatesDirectory,
    ...relativeDirectory.split("/"),
  );
  let entries;
  try {
    const stats = lstatSync(absoluteDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return templateError(
        `Packaged installation template root is not a directory: ${relativeDirectory}`,
      );
    }
    entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
  } catch (error) {
    if (error instanceof ProjectInitializationError) {
      throw error;
    }
    return templateError(
      `Unable to inspect packaged installation template root: ${relativeDirectory}`,
      error,
    );
  }

  return entries.flatMap<InstallationFileInput>((entry) => {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      return [...collectTemplateDirectory(templatesDirectory, relativePath)];
    }
    if (!entry.isFile()) {
      return templateError(
        `Packaged installation template entry is not regular: ${relativePath}`,
      );
    }
    return [readTemplateFile(templatesDirectory, relativePath)];
  });
}

function repositoryRelativePath(root: string, absolutePath: string): string {
  const value = relative(root, absolutePath);
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value === ".." ||
    value.startsWith(`..${sep}`)
  ) {
    throw new ProjectInitializationError(
      "TEMPLATE_INVALID",
      `Generated installation target is outside the project root: ${absolutePath}`,
    );
  }
  return value.split(sep).join("/");
}

function installationPreparationOptions(
  options: ProjectInitializationOptions,
): InstallationPreparationOptions {
  const result: InstallationPreparationOptions = {};
  if (options.installationId !== undefined) {
    result.installationId = options.installationId;
  }
  if (options.preparedAt !== undefined) {
    result.preparedAt = options.preparedAt;
  }
  return result;
}

function baseInstallationInputs(
  adaptive: AdaptiveProjectTemplatePlan,
): readonly InstallationFileInput[] {
  const templatesDirectory = templateRoot();
  const copied = [
    ...TEMPLATE_COPY_ROOTS.flatMap((root) =>
      collectTemplateDirectory(templatesDirectory, root),
    ),
    ...TEMPLATE_COPY_FILES.map((path) =>
      readTemplateFile(templatesDirectory, path),
    ),
  ];
  return [
    ...copied,
    {
      path: "automation/config.json",
      source: "generated/adaptive-automation-config",
      strategy: "generate",
      content: adaptive.automationConfigContent,
    },
    {
      path: "automation/tasks/TASK-TEMPLATE.json.example",
      source: "generated/adaptive-task-contract-example",
      strategy: "generate",
      content: adaptive.taskContractExampleContent,
    },
  ];
}

export function planProjectResourceInputs(
  directory: string,
  options: AdaptiveProjectTemplateOptions = {},
): ProjectResourceInputPlan {
  const adaptiveTemplates = planAdaptiveProjectTemplates(directory, options);
  return {
    targetDirectory: adaptiveTemplates.projectRoot,
    adaptiveTemplates,
    inputs: baseInstallationInputs(adaptiveTemplates),
  };
}

function mergedInstallationInputs(
  resources: ProjectResourceInputPlan,
  agentsMerge: AgentsConfigMergePlan,
  openCodeConfigMerge: OpenCodeConfigMergePlan,
): readonly InstallationFileInput[] {
  return [
    ...resources.inputs,
    {
      path: repositoryRelativePath(
        resources.targetDirectory,
        agentsMerge.agentsPath,
      ),
      source: "generated/agents-managed-block-merge",
      strategy: "merge",
      content: agentsMerge.content,
    },
    {
      path: repositoryRelativePath(
        resources.targetDirectory,
        openCodeConfigMerge.configPath,
      ),
      source: "generated/opencode-config-merge",
      strategy: "merge",
      content: openCodeConfigMerge.content,
    },
  ];
}

export function planProjectInitialization(
  directory: string,
  options: ProjectInitializationOptions = {},
): ProjectInitializationPlan {
  const adaptiveOptions: AdaptiveProjectTemplateOptions = {};
  if (options.moduleScope !== undefined) {
    adaptiveOptions.moduleScope = options.moduleScope;
  }
  if (options.primaryModule !== undefined) {
    adaptiveOptions.primaryModule = options.primaryModule;
  }
  if (options.gradleVerification !== undefined) {
    adaptiveOptions.gradleVerification = options.gradleVerification;
  }
  const resources = planProjectResourceInputs(directory, adaptiveOptions);
  const { adaptiveTemplates, targetDirectory } = resources;
  const agentsMerge = planAgentsConfigMerge(targetDirectory);
  const openCodeConfigMerge = planOpenCodeConfigMerge(targetDirectory);
  const installation = planInstallationPreparation(
    targetDirectory,
    mergedInstallationInputs(
      resources,
      agentsMerge,
      openCodeConfigMerge,
    ),
    installationPreparationOptions(options),
  );
  return {
    targetDirectory,
    adaptiveTemplates,
    agentsMerge,
    openCodeConfigMerge,
    installation,
  };
}

function commandDetails(result: CommandResult): readonly string[] {
  return [result.error, result.stderr.trim(), result.stdout.trim()]
    .filter((value): value is string => value !== null && value.length > 0)
    .map((value) =>
      value.length <= 4_000
        ? value
        : `[truncated]\n${value.slice(-4_000)}`,
    )
    .slice(0, 3);
}

function processCheck(
  id: InitVerificationCheck["id"],
  label: string,
  result: CommandResult,
  outputIsValid: (stdout: string) => boolean,
): InitVerificationCheck {
  const passed =
    result.error === null &&
    result.status === 0 &&
    outputIsValid(result.stdout);
  return {
    id,
    status: passed ? "pass" : "fail",
    summary: passed
      ? `${label} passed.`
      : `${label} failed with status ${String(result.status)}.`,
    details: passed ? [] : commandDetails(result),
  };
}

function shadowOutputIsSafe(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      "mutationPerformed" in value &&
      value.mutationPerformed === false
    );
  } catch {
    return false;
  }
}

export function verifyInitializedProject(
  targetDirectory: string,
  runner: InitProcessRunner = runInitProcess,
): InitVerificationReport {
  const automationTests = runner(
    join(targetDirectory, "scripts/automation/tests/run-tests.sh"),
    [],
    { cwd: targetDirectory, timeoutMs: 300_000 },
  );
  const shadowRun = runner(
    join(targetDirectory, "scripts/automation/shadow-run.sh"),
    [],
    { cwd: targetDirectory, timeoutMs: 120_000 },
  );
  const checks = [
    processCheck(
      "automation-tests",
      "Automation transaction tests",
      automationTests,
      (stdout) => /(?:^|\n)1\.\.42(?:\n|$)/.test(stdout),
    ),
    processCheck(
      "shadow-run",
      "Read-only shadow run",
      shadowRun,
      shadowOutputIsSafe,
    ),
  ];
  return {
    ok: checks.every((check) => check.status === "pass"),
    checks,
  };
}

function doctorForInitialization(
  directory: string,
  options: ProjectInitializationOptions,
  runner: InitProcessRunner,
): DoctorReport {
  const baseReport = runDoctor({
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
  const report: DoctorReport = baseReport;
  if (!report.ok) {
    throw new ProjectInitializationError(
      "DOCTOR_FAILED",
      "Initialization prerequisites failed before any project file was changed.",
      report.checks
        .filter((check) => check.status === "fail")
        .map((check) => `${check.label}: ${check.summary}`),
    );
  }
  return report;
}

function existingManifest(targetDirectory: string): InstallationManifest | null {
  try {
    return readInstallationManifest(targetDirectory);
  } catch (error) {
    if (
      error instanceof InstallationManifestError &&
      error.code === "MANIFEST_MISSING"
    ) {
      return null;
    }
    throw error;
  }
}

function optionsWithAutomaticGradleVerification(
  directory: string,
  options: ProjectInitializationOptions,
  runner: InitProcessRunner,
): ProjectInitializationOptions {
  if (options.gradleVerification !== undefined) {
    return options;
  }
  try {
    return {
      ...options,
      gradleVerification: discoverGradleVerificationConfiguration(
        directory,
        runner,
        options.primaryModule === undefined
          ? {}
          : { primaryModule: options.primaryModule },
      ),
    };
  } catch (error) {
    if (error instanceof GradleVerificationDiscoveryError) {
      throw new ProjectInitializationError(
        "GRADLE_DISCOVERY_FAILED",
        error.message,
        [
          ...error.details,
          "Fix Gradle configuration or use --gradle-verification-config for an intentional project override.",
        ],
      );
    }
    throw error;
  }
}

function desiredFilesMatch(
  existing: InstallationManifest,
  planned: InstallationManifest,
): boolean {
  if (existing.files.length !== planned.files.length) {
    return false;
  }
  return existing.files.every((file, index) => {
    const desired = planned.files[index];
    return (
      desired !== undefined &&
      file.path === desired.path &&
      file.source === desired.source &&
      file.strategy === desired.strategy &&
      file.sha256 === desired.sha256 &&
      file.size === desired.size &&
      file.mode === desired.mode
    );
  });
}

function assertExistingInstallationIsCurrent(
  plan: ProjectInitializationPlan,
  manifest: InstallationManifest,
): void {
  if (
    manifest.installation.state !== "installed" ||
    manifest.package.name !== ORCHESTRATOR_PACKAGE_NAME ||
    manifest.package.version !== ORCHESTRATOR_PACKAGE_VERSION
  ) {
    throw new ProjectInitializationError(
      "EXISTING_INSTALLATION_INVALID",
      "An installation manifest already exists but is not this installed package version.",
      [
        `State: ${manifest.installation.state}`,
        `Package: ${manifest.package.name}@${manifest.package.version}`,
      ],
    );
  }
  if (!desiredFilesMatch(manifest, plan.installation.manifest)) {
    throw new ProjectInitializationError(
      "EXISTING_INSTALLATION_DIFFERENT",
      "The installed manifest does not match the resources planned by this package.",
      ["Use the future upgrade workflow; init will not overwrite this installation."],
    );
  }

  const integrity = verifyInstallationIntegrity(plan.targetDirectory);
  if (!integrity.ok) {
    throw new ProjectInitializationError(
      "EXISTING_INSTALLATION_INVALID",
      "The existing installation or its backups failed integrity verification.",
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

function assertVerificationPassed(report: InitVerificationReport): void {
  if (!report.ok) {
    throw new ProjectInitializationError(
      "POST_INSTALL_VERIFICATION_FAILED",
      "Installed resources failed verification and the new installation will be rolled back.",
      report.checks
        .filter((check) => check.status === "fail")
        .flatMap((check) => [check.summary, ...check.details]),
    );
  }
}

function resultFromApplied(
  plan: ProjectInitializationPlan,
  applied: AppliedInstallation,
  doctor: DoctorReport,
  verification: InitVerificationReport,
  worktreeAllowlist: WorktreeAllowlistInitialization,
): ProjectInitializationResult {
  return {
    status: "installed",
    targetDirectory: plan.targetDirectory,
    moduleScope: plan.adaptiveTemplates.moduleScope,
    primaryModule: plan.adaptiveTemplates.primaryModule.gradlePath,
    manifestPath: applied.prepared.manifestPath,
    backupDirectory: applied.prepared.backupDirectory,
    managedFileCount: applied.manifest.files.length,
    writtenFileCount: applied.writtenFileCount,
    reusedFileCount: applied.reusedFileCount,
    worktreeAllowlistPath: worktreeAllowlist.path,
    worktreeAllowlistStatus: worktreeAllowlist.status,
    manifest: applied.manifest,
    doctor,
    verification,
  };
}

export function runProjectInitialization(
  directory: string,
  options: ProjectInitializationOptions = {},
): ProjectInitializationResult {
  const runner = options.processRunner ?? runInitProcess;
  const doctor = doctorForInitialization(directory, options, runner);
  const resolvedOptions = optionsWithAutomaticGradleVerification(
    directory,
    options,
    runner,
  );
  const plan = planProjectInitialization(directory, resolvedOptions);
  const existing = existingManifest(plan.targetDirectory);

  if (existing !== null) {
    assertExistingInstallationIsCurrent(plan, existing);
    const worktreeAllowlist = initializeWorktreeAllowlist(plan.targetDirectory);
    let verification: InitVerificationReport;
    try {
      verification = verifyInitializedProject(plan.targetDirectory, runner);
      if (!verification.ok) {
        throw new ProjectInitializationError(
          "POST_INSTALL_VERIFICATION_FAILED",
          "The existing installation failed verification; no persistent file was changed.",
          verification.checks
            .filter((check) => check.status === "fail")
            .flatMap((check) => [check.summary, ...check.details]),
        );
      }
    } catch (error) {
      rollbackWorktreeAllowlistInitialization(worktreeAllowlist, error);
    }
    return {
      status: "already-installed",
      targetDirectory: plan.targetDirectory,
      moduleScope: plan.adaptiveTemplates.moduleScope,
      primaryModule: plan.adaptiveTemplates.primaryModule.gradlePath,
      manifestPath: join(
        plan.targetDirectory,
        ...INSTALLATION_MANIFEST_RELATIVE_PATH.split("/"),
      ),
      backupDirectory: join(
        plan.targetDirectory,
        ...existing.backupDirectory.split("/"),
      ),
      managedFileCount: existing.files.length,
      writtenFileCount: 0,
      reusedFileCount: existing.files.length,
      worktreeAllowlistPath: worktreeAllowlist.path,
      worktreeAllowlistStatus: worktreeAllowlist.status,
      manifest: existing,
      doctor,
      verification,
    };
  }

  const worktreeAllowlist = initializeWorktreeAllowlist(plan.targetDirectory);
  let verification: InitVerificationReport | null = null;
  let applied: AppliedInstallation;
  try {
    applied = applyInstallationPlan(plan.installation, {
      ...(options.installedAt === undefined
        ? {}
        : { installedAt: options.installedAt }),
      verify: () => {
        verification = verifyInitializedProject(plan.targetDirectory, runner);
        assertVerificationPassed(verification);
      },
    });
  } catch (error) {
    rollbackWorktreeAllowlistInitialization(worktreeAllowlist, error);
  }
  if (verification === null) {
    throw new ProjectInitializationError(
      "POST_INSTALL_VERIFICATION_FAILED",
      "Installation verification did not produce a report.",
    );
  }
  return resultFromApplied(
    plan,
    applied,
    doctor,
    verification,
    worktreeAllowlist,
  );
}

export function formatProjectInitializationResult(
  result: ProjectInitializationResult,
): string {
  const lines = [
    "OpenCode Android Orchestrator init",
    "",
    `Result: ${result.status === "installed" ? "INSTALLED" : "ALREADY INSTALLED"}`,
    `Project root: ${result.targetDirectory}`,
    `Module scope: ${result.moduleScope}`,
    `Default module: ${result.primaryModule}`,
    `Managed files: ${String(result.managedFileCount)}`,
    `Written files: ${String(result.writtenFileCount)}`,
    `Reused files: ${String(result.reusedFileCount)}`,
    `Worktree allowlist: ${result.worktreeAllowlistPath} (${result.worktreeAllowlistStatus})`,
    `Manifest: ${result.manifestPath}`,
    `Recovery backups: ${result.backupDirectory}`,
    "Failure rollback: automatic until the manifest is marked installed",
    "",
    formatDoctorReport(result.doctor).trimEnd(),
    "",
    ...result.verification.checks.map(
      (check) =>
        `[${check.status.toUpperCase()}] ${check.summary}`,
    ),
    "",
    `Next: opencode --agent scheduled-planner ${result.targetDirectory}`,
  ];
  return `${lines.join("\n")}\n`;
}
