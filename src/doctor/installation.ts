import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LONG_COMMAND_TIMEOUT_MS } from "../config/long-command-timeout.js";
import {
  AUTOMATION_CONFIG_RELATIVE_PATH,
  DEFAULT_LINT_ENABLED,
  DEFAULT_UNIT_TESTS_ENABLED,
  matchesManifestModuloVerificationPolicy,
} from "../config/verification-policy.js";
import {
  isModuleScope,
  planAdaptiveProjectTemplates,
  type GradleVerificationConfiguration,
  type ModuleScope,
} from "../installer/adaptive-templates.js";
import { planAgentsConfigMerge } from "../installer/agents-config.js";
import {
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  readInstallationManifest,
  verifyInstallationIntegrity,
  type InstallationFileStrategy,
  type InstallationManifest,
  type InstallationManifestFile,
} from "../installer/install-manifest.js";
import {
  ORCHESTRATOR_PACKAGE_NAME,
  ORCHESTRATOR_PACKAGE_VERSION,
  mergeOpenCodeConfigText,
} from "../installer/opencode-config.js";
import type { DoctorCheck } from "./index.js";

export const EXPECTED_MANAGED_FILE_COUNT = 47;

interface ExpectedManagedFile {
  path: string;
  source: string;
  strategy: InstallationFileStrategy;
  mode?: number;
}

interface InspectedFile {
  content: Buffer;
  mode: number;
}

type FileInspection =
  | { ok: true; file: InspectedFile }
  | { ok: false; reason: string };

const OPENCODE_TEMPLATE_PATHS = [
  ".opencode/agents/scheduled-coder.md",
  ".opencode/agents/scheduled-planner.md",
  ".opencode/agents/scheduled-reviewer.md",
  ".opencode/commands/abort-task.md",
  ".opencode/commands/acceptance.md",
  ".opencode/commands/change.md",
  ".opencode/commands/resume-task.md",
  ".opencode/commands/resume-review.md",
  ".opencode/skills/scheduled-quality-coder/SKILL.md",
  ".opencode/skills/scheduled-quality-orchestrator/SKILL.md",
  ".opencode/skills/scheduled-quality-reviewer/SKILL.md",
] as const;

const AUTOMATION_SCRIPT_PATHS = [
  "scripts/automation/abort-task.sh",
  "scripts/automation/accept-and-integrate.sh",
  "scripts/automation/acceptance-report.sh",
  "scripts/automation/approve-and-run.sh",
  "scripts/automation/begin-review.sh",
  "scripts/automation/block-task.sh",
  "scripts/automation/claim-task.sh",
  "scripts/automation/integration-scope-gate.sh",
  "scripts/automation/lib.sh",
  "scripts/automation/orchestrate-task.sh",
  "scripts/automation/preflight.sh",
  "scripts/automation/prepare-contract-review.sh",
  "scripts/automation/quality-gate.sh",
  "scripts/automation/queue-task.sh",
  "scripts/automation/record-red.sh",
  "scripts/automation/resume-task.sh",
  "scripts/automation/resume-review-fix.sh",
  "scripts/automation/resume-review.sh",
  "scripts/automation/scope-gate.sh",
  "scripts/automation/select-task.sh",
  "scripts/automation/shadow-run.sh",
  "scripts/automation/show-acceptance-review.sh",
  "scripts/automation/status.sh",
  "scripts/automation/submit-review.sh",
  "scripts/automation/tests/run-tests.sh",
  "scripts/automation/transition-state.sh",
  "scripts/automation/validate-contract.sh",
  "scripts/automation/verify-integration.sh",
  "scripts/automation/verify-task.sh",
] as const;

const OTHER_TEMPLATE_PATHS = [
  "automation/config.schema.json",
  "automation/task-contract.schema.json",
  "docs/plans/README.md",
] as const;

const EXPECTED_FIXED_FILES: readonly ExpectedManagedFile[] = [
  ...OPENCODE_TEMPLATE_PATHS.map((path) => ({
    path,
    source: `templates/${path}`,
    strategy: "copy" as const,
    mode: 0o644,
  })),
  ...AUTOMATION_SCRIPT_PATHS.map((path) => ({
    path,
    source: `templates/${path}`,
    strategy: "copy" as const,
    mode: 0o755,
  })),
  ...OTHER_TEMPLATE_PATHS.map((path) => ({
    path,
    source: `templates/${path}`,
    strategy: "copy" as const,
    mode: 0o644,
  })),
  {
    path: "automation/config.json",
    source: "generated/adaptive-automation-config",
    strategy: "generate",
  },
  {
    path: "automation/tasks/TASK-TEMPLATE.json.example",
    source: "generated/adaptive-task-contract-example",
    strategy: "generate",
  },
  {
    path: "AGENTS.md",
    source: "generated/agents-managed-block-merge",
    strategy: "merge",
  },
];

const OPENCODE_CONFIG_SOURCE = "generated/opencode-config-merge";

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

function errorDetails(error: unknown): readonly string[] {
  if (
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    Array.isArray(error.details) &&
    error.details.every((detail) => typeof detail === "string")
  ) {
    return [
      error instanceof Error ? error.message : String(error),
      ...(error.details as readonly string[]),
    ];
  }
  return [error instanceof Error ? error.message : String(error)];
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function templateRoot(): string {
  return fileURLToPath(new URL("../../templates/", import.meta.url));
}

function inspectRegularFile(
  targetDirectory: string,
  relativePath: string,
): FileInspection {
  const segments = relativePath.split("/");
  let current = targetDirectory;

  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) {
        return {
          ok: false,
          reason: `symbolic-link ancestor: ${current}`,
        };
      }
      if (!stats.isDirectory()) {
        return { ok: false, reason: `parent is not a directory: ${current}` };
      }
    } catch (error) {
      return {
        ok: false,
        reason:
          filesystemErrorCode(error) === "ENOENT"
            ? `missing parent: ${current}`
            : `unreadable parent: ${current}`,
      };
    }
  }

  const absolutePath = join(targetDirectory, ...segments);
  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      return { ok: false, reason: "path is a symbolic link" };
    }
    if (!stats.isFile()) {
      return { ok: false, reason: "path is not a regular file" };
    }
    return {
      ok: true,
      file: {
        content: readFileSync(absolutePath),
        mode: stats.mode & 0o777,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        filesystemErrorCode(error) === "ENOENT"
          ? "file is missing"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

function manifestInventoryIssues(manifest: InstallationManifest): string[] {
  const issues: string[] = [];
  if (manifest.package.name !== ORCHESTRATOR_PACKAGE_NAME) {
    issues.push(
      `Package name is ${manifest.package.name}; expected ${ORCHESTRATOR_PACKAGE_NAME}.`,
    );
  }
  if (manifest.package.version !== ORCHESTRATOR_PACKAGE_VERSION) {
    issues.push(
      `Package version is ${manifest.package.version}; expected ${ORCHESTRATOR_PACKAGE_VERSION}.`,
    );
  }
  if (manifest.installation.state !== "installed") {
    issues.push(
      `Installation state is ${manifest.installation.state}; expected installed.`,
    );
  }
  if (manifest.files.length !== EXPECTED_MANAGED_FILE_COUNT) {
    issues.push(
      `Manifest tracks ${manifest.files.length} files; expected ${EXPECTED_MANAGED_FILE_COUNT}.`,
    );
  }

  const actualByPath = new Map(
    manifest.files.map((file) => [file.path, file] as const),
  );
  for (const expected of EXPECTED_FIXED_FILES) {
    const actual = actualByPath.get(expected.path);
    if (actual === undefined) {
      issues.push(`Missing manifest entry: ${expected.path}`);
      continue;
    }
    if (
      actual.source !== expected.source ||
      actual.strategy !== expected.strategy
    ) {
      issues.push(
        `${expected.path}: expected ${expected.strategy} from ${expected.source}.`,
      );
    }
    if (expected.mode !== undefined && actual.mode !== expected.mode) {
      issues.push(
        `${expected.path}: manifest mode ${formatMode(actual.mode)}; expected ${formatMode(expected.mode)}.`,
      );
    }
    if (expected.strategy === "copy") {
      const packaged = inspectRegularFile(templateRoot(), expected.path);
      if (!packaged.ok) {
        issues.push(
          `Packaged template ${expected.path}: ${packaged.reason}.`,
        );
      } else {
        const packagedSha256 = sha256(packaged.file.content);
        if (
          actual.sha256 !== packagedSha256 ||
          actual.size !== packaged.file.content.byteLength
        ) {
          issues.push(
            `${expected.path}: manifest content does not match the packaged ${ORCHESTRATOR_PACKAGE_VERSION} template.`,
          );
        }
      }
    }
  }

  const configEntries = manifest.files.filter(
    (file) => file.source === OPENCODE_CONFIG_SOURCE,
  );
  if (configEntries.length !== 1) {
    issues.push(
      `Expected exactly one OpenCode configuration entry; found ${configEntries.length}.`,
    );
  } else {
    const config = configEntries[0] as InstallationManifestFile;
    if (
      !(config.path === "opencode.json" || config.path === "opencode.jsonc") ||
      config.strategy !== "merge"
    ) {
      issues.push(
        "OpenCode configuration must merge opencode.json or opencode.jsonc.",
      );
    }
  }

  const expectedPaths = new Set(EXPECTED_FIXED_FILES.map((file) => file.path));
  for (const file of manifest.files) {
    const isOpenCodeConfig =
      file.source === OPENCODE_CONFIG_SOURCE &&
      (file.path === "opencode.json" || file.path === "opencode.jsonc");
    if (!expectedPaths.has(file.path) && !isOpenCodeConfig) {
      issues.push(`Unexpected manifest entry: ${file.path}`);
    }
  }
  return issues;
}

function blockedCheck(id: string, label: string, reason: string): DoctorCheck {
  return {
    id,
    label,
    status: "fail",
    summary: "Unable to inspect this installation area.",
    details: [reason],
  };
}

function blockedInstallationChecks(reason: string): readonly DoctorCheck[] {
  return [
    blockedCheck("managed-resources", "Managed resources", reason),
    blockedCheck("managed-permissions", "Managed permissions", reason),
    blockedCheck("installation-backups", "Installation backups", reason),
    blockedCheck("managed-configuration", "Managed configuration", reason),
  ];
}

function managedResourceCheck(
  manifest: InstallationManifest,
  inspections: ReadonlyMap<string, FileInspection>,
): DoctorCheck {
  const failures: string[] = [];
  for (const file of manifest.files) {
    const inspection = inspections.get(file.path);
    if (inspection === undefined || !inspection.ok) {
      failures.push(
        `${file.path}: ${inspection?.reason ?? "inspection result is missing"}`,
      );
      continue;
    }
    const actualSha256 = sha256(inspection.file.content);
    const contentChanged =
      inspection.file.content.byteLength !== file.size ||
      actualSha256 !== file.sha256;
    const supportedPolicyOverride =
      file.path === AUTOMATION_CONFIG_RELATIVE_PATH &&
      matchesManifestModuloVerificationPolicy(inspection.file.content, {
        sha256: file.sha256,
        size: file.size,
      });
    if (contentChanged && !supportedPolicyOverride) {
      failures.push(
        `${file.path}: SHA-256 or size mismatch (actual ${actualSha256}).`,
      );
    }
  }
  return {
    id: "managed-resources",
    label: "Managed resources",
    status: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? `All ${manifest.files.length} managed files match the manifest or supported verification-policy overrides.`
        : `${failures.length} managed file(s) are missing, unsafe, or modified.`,
    details: failures,
  };
}

function managedPermissionCheck(
  manifest: InstallationManifest,
  inspections: ReadonlyMap<string, FileInspection>,
): DoctorCheck {
  const failures: string[] = [];
  for (const file of manifest.files) {
    const inspection = inspections.get(file.path);
    if (inspection === undefined || !inspection.ok) {
      failures.push(
        `${file.path}: ${inspection?.reason ?? "inspection result is missing"}`,
      );
    } else if (inspection.file.mode !== file.mode) {
      failures.push(
        `${file.path}: mode ${formatMode(inspection.file.mode)}; expected ${formatMode(file.mode)}.`,
      );
    }
  }
  return {
    id: "managed-permissions",
    label: "Managed permissions",
    status: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? `All managed modes match; ${AUTOMATION_SCRIPT_PATHS.length} automation scripts are executable.`
        : `${failures.length} managed path(s) have unsafe or unexpected permissions.`,
    details: failures,
  };
}

function installationBackupCheck(
  targetDirectory: string,
  manifest: InstallationManifest,
): DoctorCheck {
  try {
    const integrity = verifyInstallationIntegrity(targetDirectory);
    const failures = integrity.checks
      .filter(
        (check) =>
          !(check.backup === "match" || check.backup === "not-required"),
      )
      .map((check) => `${check.path}: backup is ${check.backup}.`);
    const backupCount = manifest.files.filter(
      (file) => file.previous.existed,
    ).length;
    return {
      id: "installation-backups",
      label: "Installation backups",
      status: failures.length === 0 ? "pass" : "fail",
      summary:
        failures.length === 0
          ? `${backupCount} required original-file backup(s) match the manifest.`
          : `${failures.length} required backup(s) failed integrity checks.`,
      details: failures,
    };
  } catch (error) {
    return {
      id: "installation-backups",
      label: "Installation backups",
      status: "fail",
      summary: "Installation backups could not be verified.",
      details: errorDetails(error),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function jsonMatches(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function inspectedText(
  path: string,
  inspections: ReadonlyMap<string, FileInspection>,
): string {
  const inspection = inspections.get(path);
  if (inspection === undefined || !inspection.ok) {
    throw new Error(
      `${path}: ${inspection?.reason ?? "inspection result is missing"}`,
    );
  }
  return inspection.file.content.toString("utf8");
}

function managedConfigurationCheck(
  targetDirectory: string,
  manifest: InstallationManifest,
  inspections: ReadonlyMap<string, FileInspection>,
): DoctorCheck {
  const failures: string[] = [];
  const details: string[] = [];
  const openCodeConfig = manifest.files.find(
    (file) => file.source === OPENCODE_CONFIG_SOURCE,
  );

  if (openCodeConfig === undefined) {
    failures.push("OpenCode configuration is not tracked by the manifest.");
  } else {
    try {
      const merge = mergeOpenCodeConfigText(
        inspectedText(openCodeConfig.path, inspections),
      );
      if (merge.changed) {
        failures.push(
          `${openCodeConfig.path}: required pinned plugin references are missing.`,
        );
      } else {
        details.push(`OpenCode configuration: ${openCodeConfig.path}`);
      }
    } catch (error) {
      failures.push(...errorDetails(error).map((detail) =>
        `${openCodeConfig.path}: ${detail}`,
      ));
    }
  }

  try {
    const agentsPlan = planAgentsConfigMerge(targetDirectory);
    if (agentsPlan.changed) {
      failures.push("AGENTS.md: the exact bounded managed block is missing.");
    } else {
      details.push("AGENTS managed block: present and unchanged");
    }
  } catch (error) {
    failures.push(...errorDetails(error).map((detail) => `AGENTS.md: ${detail}`));
  }

  try {
    const automationConfig = JSON.parse(
      inspectedText("automation/config.json", inspections),
    ) as unknown;
    if (!isRecord(automationConfig) || !isRecord(automationConfig.androidProject)) {
      throw new Error("automation config must contain an androidProject object");
    }
    const primaryModule = automationConfig.androidProject.primaryModule;
    if (typeof primaryModule !== "string") {
      throw new Error("androidProject.primaryModule must be a string");
    }
    const configuredModuleScope = automationConfig.androidProject.moduleScope;
    let moduleScope: ModuleScope;
    let comparableAutomationConfig: Record<string, unknown> = automationConfig;
    if (configuredModuleScope === undefined) {
      moduleScope = "primary";
      comparableAutomationConfig = {
        ...automationConfig,
        androidProject: {
          ...automationConfig.androidProject,
          moduleScope,
        },
      };
    } else if (isModuleScope(configuredModuleScope)) {
      moduleScope = configuredModuleScope;
    } else {
      throw new Error(
        "androidProject.moduleScope must be either all or primary",
      );
    }
    if (!isRecord(automationConfig.gradleVerification)) {
      throw new Error("automation config must contain a gradleVerification object");
    }
    const lintEnabled = automationConfig.lintEnabled ?? DEFAULT_LINT_ENABLED;
    if (typeof lintEnabled !== "boolean") {
      throw new Error("lintEnabled must be a boolean");
    }
    if (automationConfig.lintEnabled === undefined) {
      comparableAutomationConfig = {
        ...comparableAutomationConfig,
        lintEnabled,
      };
    }
    const unitTestsEnabled =
      automationConfig.unitTestsEnabled ?? DEFAULT_UNIT_TESTS_ENABLED;
    if (typeof unitTestsEnabled !== "boolean") {
      throw new Error("unitTestsEnabled must be a boolean");
    }
    if (automationConfig.unitTestsEnabled === undefined) {
      comparableAutomationConfig = {
        ...comparableAutomationConfig,
        unitTestsEnabled,
      };
    }
    const longCommandTimeoutMs =
      automationConfig.longCommandTimeoutMs ?? DEFAULT_LONG_COMMAND_TIMEOUT_MS;
    if (typeof longCommandTimeoutMs !== "number") {
      throw new Error("longCommandTimeoutMs must be a number");
    }
    if (automationConfig.longCommandTimeoutMs === undefined) {
      comparableAutomationConfig = {
        ...comparableAutomationConfig,
        longCommandTimeoutMs,
      };
    }
    const expected = planAdaptiveProjectTemplates(targetDirectory, {
      moduleScope,
      primaryModule,
      gradleVerification:
        automationConfig.gradleVerification as unknown as GradleVerificationConfiguration,
      lintEnabled,
      unitTestsEnabled,
      longCommandTimeoutMs,
    });
    if (!jsonMatches(comparableAutomationConfig, expected.automationConfig)) {
      failures.push(
        "automation/config.json: configuration no longer matches the detected Android project and packaged safe defaults.",
      );
    } else {
      details.push(`Automation module scope: ${moduleScope}`);
      details.push(`Automation default module: ${primaryModule}`);
      details.push(
        `Unit-test verification: ${unitTestsEnabled ? "enabled" : "disabled"}`,
      );
      details.push(`Android lint verification: ${lintEnabled ? "enabled" : "disabled"}`);
    }

    const taskExample = JSON.parse(
      inspectedText(
        "automation/tasks/TASK-TEMPLATE.json.example",
        inspections,
      ),
    ) as unknown;
    if (!jsonMatches(taskExample, expected.taskContractExample)) {
      failures.push(
        "automation/tasks/TASK-TEMPLATE.json.example: example no longer matches the detected module scope.",
      );
    }
  } catch (error) {
    failures.push(...errorDetails(error));
  }

  return {
    id: "managed-configuration",
    label: "Managed configuration",
    status: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? "OpenCode, AGENTS, and adaptive Android configuration are consistent."
        : `${failures.length} managed configuration issue(s) were found.`,
    details: failures.length === 0 ? details : failures,
  };
}

export function installationDoctorChecks(
  targetDirectory: string,
): readonly DoctorCheck[] {
  let manifest: InstallationManifest;
  try {
    manifest = readInstallationManifest(targetDirectory);
  } catch (error) {
    const details = errorDetails(error);
    return [
      {
        id: "installation-manifest",
        label: "Installation manifest",
        status: "fail",
        summary: "A valid installation manifest could not be loaded.",
        details,
      },
      ...blockedInstallationChecks(details.join("; ")),
    ];
  }

  const manifestIssues = manifestInventoryIssues(manifest);
  const manifestInspection = inspectRegularFile(
    targetDirectory,
    INSTALLATION_MANIFEST_RELATIVE_PATH,
  );
  if (!manifestInspection.ok) {
    manifestIssues.push(
      `${INSTALLATION_MANIFEST_RELATIVE_PATH}: ${manifestInspection.reason}`,
    );
  } else if (manifestInspection.file.mode !== 0o600) {
    manifestIssues.push(
      `${INSTALLATION_MANIFEST_RELATIVE_PATH}: mode ${formatMode(manifestInspection.file.mode)}; expected 0600.`,
    );
  }

  const manifestCheck: DoctorCheck = {
    id: "installation-manifest",
    label: "Installation manifest",
    status: manifestIssues.length === 0 ? "pass" : "fail",
    summary:
      manifestIssues.length === 0
        ? `${ORCHESTRATOR_PACKAGE_NAME}@${ORCHESTRATOR_PACKAGE_VERSION} tracks ${manifest.files.length} installed files.`
        : `${manifestIssues.length} manifest identity, state, inventory, or mode issue(s) were found.`,
    details:
      manifestIssues.length === 0
        ? [`Installation ID: ${manifest.installation.id}`]
        : manifestIssues,
  };
  const inspections = new Map(
    manifest.files.map((file) => [
      file.path,
      inspectRegularFile(targetDirectory, file.path),
    ] as const),
  );

  return [
    manifestCheck,
    managedResourceCheck(manifest, inspections),
    managedPermissionCheck(manifest, inspections),
    installationBackupCheck(targetDirectory, manifest),
    managedConfigurationCheck(targetDirectory, manifest, inspections),
  ];
}
