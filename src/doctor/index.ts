import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  checkOpenCodeVersion,
  type OpenCodeVersionCheck,
} from "../compatibility/versions.js";
import {
  detectAndroidProject,
  type AndroidProjectDetection,
} from "../installer/android-project.js";
import { installationDoctorChecks } from "./installation.js";
import { androidSdkCandidate } from "../config/android-sdk.js";

export {
  EXPECTED_MANAGED_FILE_COUNT,
  installationDoctorChecks,
} from "./installation.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  summary: string;
  details: readonly string[];
}

export interface DoctorReport {
  ok: boolean;
  checks: readonly DoctorCheck[];
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => CommandResult;

export interface DoctorOptions {
  androidProjectDetection?: AndroidProjectDetection;
  androidSdkDirectory?: string;
  checkDependencies?: boolean;
  checkInstallation?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  opencodeExecutable?: string;
  runCommand?: CommandRunner;
  targetDirectory?: string;
}

export const runCommand: CommandRunner = (executable, args) => {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
};

function versionStatus(check: OpenCodeVersionCheck): DoctorCheckStatus {
  if (check.support === "certified") {
    return "pass";
  }
  if (check.support === "supported-uncertified") {
    return "warn";
  }
  return "fail";
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

export function inspectRequiredCommands(
  options: DoctorOptions = {},
): readonly DoctorCheck[] {
  const runner = options.runCommand ?? runCommand;
  const prerequisites: readonly [
    id: string,
    label: string,
    executable: string,
    args: readonly string[],
  ][] = [
    ["git-command", "Git command", "git", ["--version"]],
    ["jq-command", "jq command", "jq", ["--version"]],
    ["rg-command", "ripgrep command", "rg", ["--version"]],
    ["shasum-command", "shasum command", "shasum", ["--version"]],
    ["java-command", "Java command", "java", ["-version"]],
  ];

  return prerequisites.map<DoctorCheck>(([id, label, executable, args]) => {
    const result = runner(executable, args);
    const passed = result.error === null && result.status === 0;
    const versionLine = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      id,
      label,
      status: passed ? "pass" : "fail",
      summary: passed
        ? `${executable} is available.`
        : `${executable} could not be executed successfully.`,
      details: passed
        ? versionLine === undefined
          ? []
          : [versionLine]
        : commandDetails(result),
    };
  });
}

function isSafeDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch {
    return false;
  }
}

export function inspectAndroidSdk(
  targetDirectory: string,
  options: DoctorOptions = {},
): DoctorCheck {
  const candidate = androidSdkCandidate(targetDirectory, options);
  if (candidate === null) {
    return {
      id: "android-sdk",
      label: "Android SDK",
      status: "fail",
      summary:
        "No Android SDK was configured by option, environment, or local.properties.",
      details: [],
    };
  }
  if (!isSafeDirectory(candidate.directory)) {
    return {
      id: "android-sdk",
      label: "Android SDK",
      status: "fail",
      summary: `Android SDK directory is unavailable or unsafe: ${candidate.directory}`,
      details: [`Source: ${candidate.source}`],
    };
  }

  const missingComponents = ["platforms", "build-tools"].filter(
    (component) => !isSafeDirectory(join(candidate.directory, component)),
  );
  return {
    id: "android-sdk",
    label: "Android SDK",
    status: missingComponents.length === 0 ? "pass" : "warn",
    summary:
      missingComponents.length === 0
        ? `Found Android SDK at ${candidate.directory}.`
        : `Found the SDK root, but ${missingComponents.join(" and ")} could not be confirmed.`,
    details: [
      `Source: ${candidate.source}`,
      ...(missingComponents.length === 0
        ? []
        : [`SDK root: ${candidate.directory}`]),
    ],
  };
}

export function inspectOpenCode(
  options: DoctorOptions = {},
): DoctorCheck {
  const executable = options.opencodeExecutable ?? "opencode";
  const runner = options.runCommand ?? runCommand;
  const result = runner(executable, ["--version"]);

  if (result.error !== null) {
    return {
      id: "opencode-version",
      label: "OpenCode version",
      status: "fail",
      summary: `Unable to execute ${executable}.`,
      details: [result.error],
    };
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      id: "opencode-version",
      label: "OpenCode version",
      status: "fail",
      summary: `${executable} --version exited with status ${String(result.status)}.`,
      details: detail.length === 0 ? [] : [detail],
    };
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  const versionCheck = checkOpenCodeVersion(output);

  return {
    id: "opencode-version",
    label: "OpenCode version",
    status: versionStatus(versionCheck),
    summary: versionCheck.message,
    details:
      versionCheck.installedVersion === null
        ? []
        : [`Detected executable: ${executable}`],
  };
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const checks = [inspectOpenCode(options)];
  let resolvedTarget =
    options.targetDirectory === undefined
      ? resolve(process.cwd())
      : resolve(options.targetDirectory);

  if (options.targetDirectory !== undefined) {
    const detection =
      options.androidProjectDetection ??
      detectAndroidProject(options.targetDirectory);
    checks.push(...androidProjectChecks(detection));
    resolvedTarget = detection.gitRoot ?? resolvedTarget;
  }
  if (options.checkDependencies === true) {
    checks.push(
      ...inspectRequiredCommands(options),
      inspectAndroidSdk(resolvedTarget, options),
    );
  }
  if (options.checkInstallation === true) {
    checks.push(...installationDoctorChecks(resolvedTarget));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

function androidProjectChecks(
  detection: AndroidProjectDetection,
): readonly DoctorCheck[] {
  const gitCheck: DoctorCheck = detection.isGitRepository
    ? {
        id: "git-root",
        label: "Git root",
        status: "pass",
        summary: `Found ${detection.gitRoot ?? ""}.`,
        details: [],
      }
    : {
        id: "git-root",
        label: "Git root",
        status: "fail",
        summary: "No Git root was found.",
        details: detection.errors.filter((error) =>
          error.includes("Git root"),
        ),
      };

  const androidDetected =
    detection.settingsFile !== null && detection.modules.length > 0;
  const androidCheck: DoctorCheck = androidDetected
    ? {
        id: "android-project",
        label: "Android/Gradle project",
        status: "pass",
        summary: `Detected ${detection.modules.length} Android module(s) using ${detection.dsl} DSL.`,
        details: [
          `Settings: ${detection.settingsFile ?? ""}`,
          ...detection.modules.map(
            (module) => `${module.gradlePath}: ${module.type} (${module.buildFile})`,
          ),
          ...detection.warnings,
        ],
      }
    : {
        id: "android-project",
        label: "Android/Gradle project",
        status: "fail",
        summary: "A supported Android Gradle project was not detected.",
        details: [...detection.errors, ...detection.warnings],
      };

  const wrapper = detection.gradleWrapper;
  const wrapperCheck: DoctorCheck =
    wrapper !== null && wrapper.complete && wrapper.executable
      ? {
          id: "gradle-wrapper",
          label: "Gradle Wrapper",
          status: "pass",
          summary: "gradlew and gradle-wrapper.properties are present.",
          details: [wrapper.script],
        }
      : {
          id: "gradle-wrapper",
          label: "Gradle Wrapper",
          status: "fail",
          summary:
            wrapper === null
              ? "Gradle project root is unavailable."
              : !wrapper.complete
                ? "Gradle Wrapper is incomplete."
                : "gradlew is not executable.",
          details:
            wrapper === null
              ? []
              : [wrapper.script, wrapper.properties],
        };

  return [gitCheck, androidCheck, wrapperCheck];
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["OpenCode Android Orchestrator doctor", ""];

  for (const check of report.checks) {
    lines.push(
      `[${check.status.toUpperCase()}] ${check.label}: ${check.summary}`,
    );
    for (const detail of check.details) {
      lines.push(`  ${detail}`);
    }
  }

  lines.push("", `Result: ${report.ok ? "OK" : "FAILED"}`);
  return `${lines.join("\n")}\n`;
}
