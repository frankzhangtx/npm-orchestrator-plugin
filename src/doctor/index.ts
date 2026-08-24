import { spawnSync } from "node:child_process";

import {
  checkOpenCodeVersion,
  type OpenCodeVersionCheck,
} from "../compatibility/versions.js";
import {
  detectAndroidProject,
  type AndroidProjectDetection,
} from "../installer/android-project.js";

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

  if (options.targetDirectory !== undefined) {
    checks.push(
      ...androidProjectChecks(detectAndroidProject(options.targetDirectory)),
    );
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
