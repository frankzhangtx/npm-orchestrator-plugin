import { Buffer } from "node:buffer";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  tool,
  type PluginInput,
  type ToolContext,
  type ToolDefinition,
} from "@opencode-ai/plugin";

import {
  installationDoctorChecks,
  runDoctor,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
} from "../doctor/index.js";

export const ORCHESTRATOR_STATUS_TOOL_NAME =
  "android_orchestrator_status";
export const ORCHESTRATOR_DOCTOR_TOOL_NAME =
  "android_orchestrator_doctor";
export const READ_ONLY_TOOL_NAMES = [
  ORCHESTRATOR_STATUS_TOOL_NAME,
  ORCHESTRATOR_DOCTOR_TOOL_NAME,
] as const;

export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];
export type ReadOnlyTools = Record<ReadOnlyToolName, ToolDefinition>;

export type ReadOnlyToolErrorCode =
  | "INVALID_TASK_ID"
  | "WORKSPACE_MISMATCH"
  | "TOOL_ABORTED"
  | "UNTRUSTED_INSTALLATION"
  | "STATUS_RUNNER_UNAVAILABLE"
  | "STATUS_COMMAND_FAILED"
  | "STATUS_OUTPUT_TOO_LARGE"
  | "INVALID_STATUS_OUTPUT";

export class ReadOnlyToolError extends Error {
  readonly code: ReadOnlyToolErrorCode;
  readonly details: readonly string[];

  constructor(
    code: ReadOnlyToolErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ReadOnlyToolError";
    this.code = code;
    this.details = details;
  }
}

export interface StatusRunnerInput {
  scriptPath: string;
  targetDirectory: string;
  taskId: string;
}

export interface StatusRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type StatusRunner = (
  input: StatusRunnerInput,
) => Promise<StatusRunnerResult>;
export type DoctorRunner = (options: DoctorOptions) => DoctorReport;
export type InstallationCheckRunner = (
  targetDirectory: string,
) => readonly DoctorCheck[];

export interface ReadOnlyToolsOptions {
  directory: string;
  worktree: string;
  shell?: PluginInput["$"];
  doctorRunner?: DoctorRunner;
  installationCheckRunner?: InstallationCheckRunner;
  statusRunner?: StatusRunner;
}

const TASK_ID_PATTERN = /^TASK-[A-Z0-9-]+$/;
const STATUS_SCRIPT_RELATIVE_PATH = "scripts/automation/status.sh";
const MAX_STATUS_OUTPUT_BYTES = 1024 * 1024;
const REQUIRED_STATUS_CHECKS = [
  "installation-manifest",
  "managed-resources",
  "managed-permissions",
] as const;

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function assertContextIsBounded(
  context: ToolContext,
  projectWorktree: string,
): string {
  const contextWorktree = resolve(context.worktree);
  const contextDirectory = resolve(context.directory);

  if (
    contextWorktree !== projectWorktree ||
    !isInside(projectWorktree, contextDirectory)
  ) {
    throw new ReadOnlyToolError(
      "WORKSPACE_MISMATCH",
      "The tool context does not match the workspace that loaded the plugin.",
      [
        `Plugin worktree: ${projectWorktree}`,
        `Context worktree: ${contextWorktree}`,
        `Context directory: ${contextDirectory}`,
      ],
    );
  }

  if (context.abort.aborted) {
    throw new ReadOnlyToolError(
      "TOOL_ABORTED",
      "The read-only tool call was aborted before execution.",
    );
  }

  return contextDirectory;
}

function createShellStatusRunner(shell: PluginInput["$"]): StatusRunner {
  return async ({ scriptPath, targetDirectory, taskId }) => {
    const result = await shell`${scriptPath} ${taskId}`
      .cwd(targetDirectory)
      .quiet()
      .nothrow();
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  };
}

const unavailableStatusRunner: StatusRunner = async () => {
  throw new ReadOnlyToolError(
    "STATUS_RUNNER_UNAVAILABLE",
    "OpenCode did not provide the shell adapter required by the status tool.",
  );
};

function trustedStatusInstallation(
  checks: readonly DoctorCheck[],
): readonly string[] {
  const checksById = new Map(checks.map((check) => [check.id, check]));
  return REQUIRED_STATUS_CHECKS.flatMap((id) => {
    const check = checksById.get(id);
    if (check === undefined) {
      return [`${id}: required integrity check is missing`];
    }
    if (check.status !== "pass") {
      return [
        `${id}: ${check.summary}`,
        ...check.details.map((detail) => `${id}: ${detail}`),
      ];
    }
    return [];
  });
}

function parseStatusOutput(stdout: string, taskId: string): unknown {
  if (Buffer.byteLength(stdout, "utf8") > MAX_STATUS_OUTPUT_BYTES) {
    throw new ReadOnlyToolError(
      "STATUS_OUTPUT_TOO_LARGE",
      `The status command returned more than ${MAX_STATUS_OUTPUT_BYTES} bytes.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new ReadOnlyToolError(
      "INVALID_STATUS_OUTPUT",
      "The status command did not return valid JSON.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("contract" in value) ||
    typeof value.contract !== "object" ||
    value.contract === null ||
    Array.isArray(value.contract) ||
    !("id" in value.contract) ||
    value.contract.id !== taskId
  ) {
    throw new ReadOnlyToolError(
      "INVALID_STATUS_OUTPUT",
      "The status JSON does not identify the requested task contract.",
    );
  }

  return value;
}

function validateTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new ReadOnlyToolError(
      "INVALID_TASK_ID",
      "Task ID must match TASK-[A-Z0-9-]+.",
    );
  }
}

export function createReadOnlyTools(
  options: ReadOnlyToolsOptions,
): ReadOnlyTools {
  const projectDirectory = resolve(options.directory);
  const projectWorktree = resolve(options.worktree);
  if (!isInside(projectWorktree, projectDirectory)) {
    throw new ReadOnlyToolError(
      "WORKSPACE_MISMATCH",
      "The plugin directory must be inside its worktree.",
      [
        `Plugin worktree: ${projectWorktree}`,
        `Plugin directory: ${projectDirectory}`,
      ],
    );
  }

  const doctorRunner = options.doctorRunner ?? runDoctor;
  const installationCheckRunner =
    options.installationCheckRunner ?? installationDoctorChecks;
  const statusRunner =
    options.statusRunner ??
    (options.shell === undefined
      ? unavailableStatusRunner
      : createShellStatusRunner(options.shell));

  return {
    [ORCHESTRATOR_STATUS_TOOL_NAME]: tool({
      description:
        "Read the authenticated automation state and evidence for one TASK-[A-Z0-9-]+ contract in the current Android project.",
      args: {
        taskId: tool.schema
          .string()
          .regex(TASK_ID_PATTERN, "Task ID must match TASK-[A-Z0-9-]+."),
      },
      async execute({ taskId }, context) {
        validateTaskId(taskId);
        assertContextIsBounded(context, projectWorktree);
        const integrityFailures = trustedStatusInstallation(
          installationCheckRunner(projectWorktree),
        );
        if (integrityFailures.length > 0) {
          throw new ReadOnlyToolError(
            "UNTRUSTED_INSTALLATION",
            "Status execution was refused because the installed read-only script could not be authenticated.",
            integrityFailures,
          );
        }

        context.metadata({
          title: `Android orchestrator status: ${taskId}`,
          metadata: {
            readOnly: true,
            taskId,
          },
        });
        const result = await statusRunner({
          scriptPath: join(projectWorktree, STATUS_SCRIPT_RELATIVE_PATH),
          targetDirectory: projectWorktree,
          taskId,
        });
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim();
          throw new ReadOnlyToolError(
            "STATUS_COMMAND_FAILED",
            `The status command exited with status ${result.exitCode}.`,
            detail.length === 0 ? [] : [detail.slice(-4_000)],
          );
        }

        const status = parseStatusOutput(result.stdout, taskId);
        return {
          output: `${JSON.stringify(status, null, 2)}\n`,
          metadata: {
            readOnly: true,
            taskId,
          },
        };
      },
    }),
    [ORCHESTRATOR_DOCTOR_TOOL_NAME]: tool({
      description:
        "Run read-only OpenCode, Android, dependency, SDK, and installed-resource diagnostics for the current project.",
      args: {},
      async execute(_args, context) {
        const targetDirectory = assertContextIsBounded(
          context,
          projectWorktree,
        );
        context.metadata({
          title: "Android orchestrator doctor",
          metadata: {
            readOnly: true,
            targetDirectory,
          },
        });
        const report = doctorRunner({
          checkDependencies: true,
          checkInstallation: true,
          targetDirectory,
        });
        return {
          output: `${JSON.stringify(report, null, 2)}\n`,
          metadata: {
            readOnly: true,
            ok: report.ok,
            targetDirectory,
          },
        };
      },
    }),
  };
}
