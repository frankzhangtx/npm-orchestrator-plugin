import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandResult } from "../doctor/index.js";
import type { GradleVerificationConfiguration } from "./adaptive-templates.js";
import {
  detectAndroidProject,
  type AndroidModuleDetection,
  type AndroidProjectDetection,
} from "./android-project.js";

export type GradleVerificationDiscoveryErrorCode =
  | "GRADLE_PROJECT_INVALID"
  | "GRADLE_TASK_DISCOVERY_FAILED"
  | "GRADLE_TASK_MATRIX_INCOMPLETE";

export class GradleVerificationDiscoveryError extends Error {
  readonly code: GradleVerificationDiscoveryErrorCode;
  readonly details: readonly string[];

  constructor(
    code: GradleVerificationDiscoveryErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "GradleVerificationDiscoveryError";
    this.code = code;
    this.details = details;
  }
}

export interface GradleVerificationProcessOptions {
  cwd: string;
  timeoutMs: number;
}

export type GradleVerificationProcessRunner = (
  executable: string,
  args: readonly string[],
  options: GradleVerificationProcessOptions,
) => CommandResult;

export interface GradleVerificationDiscoveryOptions {
  primaryModule?: string;
  timeoutMs?: number;
}

const DISCOVERY_MARKER = "OPENCODE_ANDROID_ORCHESTRATOR_TASK=";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 180_000;

export const GRADLE_TASK_DISCOVERY_INIT_SCRIPT = [
  "gradle.projectsEvaluated {",
  "    gradle.rootProject.allprojects.each { project ->",
  "        project.tasks.each { task ->",
  "            def name = task.name",
  "            def relevant =",
  '                (name.startsWith("test") && name.endsWith("DebugUnitTest")) ||',
  '                name == "assembleDebug" ||',
  '                (name.startsWith("assemble") && name.endsWith("Debug")) ||',
  '                name == "lint" ||',
  '                (name.startsWith("connected") && name.endsWith("DebugAndroidTest"))',
  "            if (relevant) {",
  `                println("${DISCOVERY_MARKER}" + task.path)`,
  "            }",
  "        }",
  "    }",
  "}",
  "",
].join("\n");

interface GradleTaskRecord {
  path: string;
  modulePath: string;
  name: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeTaskPath(value: string): string | null {
  const taskPath = value.trim();
  if (!/^:(?:[A-Za-z0-9_.-]+:)*[A-Za-z][A-Za-z0-9_.-]*$/.test(taskPath)) {
    return null;
  }
  return taskPath.indexOf(":", 1) < 0 ? taskPath.slice(1) : taskPath;
}

export function parseGradleTaskPaths(stdout: string): readonly string[] {
  const paths = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(DISCOVERY_MARKER))
    .map((line) => normalizeTaskPath(line.slice(DISCOVERY_MARKER.length)))
    .filter((path): path is string => path !== null);
  return unique(paths).sort(compareStrings);
}

function taskRecord(path: string): GradleTaskRecord {
  const separator = path.lastIndexOf(":");
  return separator < 0
    ? { path, modulePath: ":", name: path }
    : {
        path,
        modulePath: path.slice(0, separator),
        name: path.slice(separator + 1),
      };
}

function normalizedIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function moduleName(module: AndroidModuleDetection): string {
  return module.gradlePath.split(":").filter(Boolean).at(-1) ?? "";
}

function preferredModulePath(
  detection: AndroidProjectDetection,
  requestedPrimaryModule: string | undefined,
): string {
  if (
    requestedPrimaryModule !== undefined &&
    detection.modules.some(
      (module) => module.gradlePath === requestedPrimaryModule,
    )
  ) {
    return requestedPrimaryModule;
  }

  const applications = detection.modules.filter(
    (module) => module.type === "application",
  );
  const onlyApplication = applications[0];
  if (applications.length === 1 && onlyApplication !== undefined) {
    return onlyApplication.gradlePath;
  }

  const projectName = normalizedIdentifier(detection.projectName ?? "");
  const matchingApplication = applications.find((module) => {
    const name = normalizedIdentifier(moduleName(module));
    return name.length > 0 && projectName.includes(name);
  });
  return (
    matchingApplication ??
    applications[0] ??
    detection.modules[0]
  )?.gradlePath ?? ":";
}

function moduleType(
  modules: ReadonlyMap<string, AndroidModuleDetection>,
  modulePath: string,
): AndroidModuleDetection["type"] | null {
  return modules.get(modulePath)?.type ?? null;
}

function variantName(
  taskName: string,
  prefix: "test" | "connected",
  suffix: "DebugUnitTest" | "DebugAndroidTest",
): string {
  return taskName.slice(prefix.length, -suffix.length);
}

function preferenceScore(
  task: GradleTaskRecord,
  detection: AndroidProjectDetection,
  modules: ReadonlyMap<string, AndroidModuleDetection>,
  preferredModule: string,
  prefix: "test" | "connected",
  suffix: "DebugUnitTest" | "DebugAndroidTest",
): number {
  let score = 0;
  if (task.modulePath === preferredModule) {
    score += 100;
  }
  if (moduleType(modules, task.modulePath) === "application") {
    score += 20;
  }

  const variant = normalizedIdentifier(
    variantName(task.name, prefix, suffix),
  );
  if (variant.length === 0) {
    score += 10;
  } else {
    const preferred =
      modules.get(preferredModule) ?? detection.modules[0];
    const tokens = unique([
      preferred === undefined
        ? ""
        : normalizedIdentifier(moduleName(preferred)),
      normalizedIdentifier(detection.projectName ?? ""),
    ]).filter((token) => token.length > 0);
    if (
      tokens.some(
        (token) => variant.includes(token) || token.includes(variant),
      )
    ) {
      score += 30;
    }
  }
  return score;
}

function sortByPreference(
  tasks: readonly GradleTaskRecord[],
  detection: AndroidProjectDetection,
  modules: ReadonlyMap<string, AndroidModuleDetection>,
  preferredModule: string,
  prefix: "test" | "connected",
  suffix: "DebugUnitTest" | "DebugAndroidTest",
): readonly GradleTaskRecord[] {
  return [...tasks].sort((left, right) => {
    const scoreDifference =
      preferenceScore(
        right,
        detection,
        modules,
        preferredModule,
        prefix,
        suffix,
      ) -
      preferenceScore(
        left,
        detection,
        modules,
        preferredModule,
        prefix,
        suffix,
      );
    return scoreDifference !== 0
      ? scoreDifference
      : compareStrings(left.path, right.path);
  });
}

function commandDetails(result: CommandResult): readonly string[] {
  return [
    `Exit status: ${String(result.status)}`,
    result.error,
    result.stderr.trim(),
    result.stdout.trim(),
  ]
    .filter((detail): detail is string => detail !== null && detail.length > 0)
    .map((detail) =>
      detail.length <= 2_000 ? detail : `[truncated]\n${detail.slice(-2_000)}`,
    );
}

export function inferGradleVerificationConfiguration(
  detection: AndroidProjectDetection,
  taskPaths: readonly string[],
  requestedPrimaryModule?: string,
): GradleVerificationConfiguration {
  if (detection.modules.length === 0) {
    throw new GradleVerificationDiscoveryError(
      "GRADLE_PROJECT_INVALID",
      "At least one detected Android module is required for task inference.",
    );
  }
  const modules = new Map(
    detection.modules.map((module) => [module.gradlePath, module]),
  );
  const tasks = taskPaths
    .map(taskRecord)
    .filter((task) => modules.has(task.modulePath));
  const preferredModule = preferredModulePath(
    detection,
    requestedPrimaryModule,
  );

  const unitTasks = sortByPreference(
    tasks.filter((task) =>
      /^test(?:[A-Z][A-Za-z0-9]*)?DebugUnitTest$/.test(task.name),
    ),
    detection,
    modules,
    preferredModule,
    "test",
    "DebugUnitTest",
  );
  const deviceTasks = sortByPreference(
    tasks.filter((task) =>
      /^connected(?:[A-Z][A-Za-z0-9]*)?DebugAndroidTest$/.test(task.name),
    ),
    detection,
    modules,
    preferredModule,
    "connected",
    "DebugAndroidTest",
  );
  const assembleTasks = tasks.filter((task) =>
    /^assemble(?:[A-Z][A-Za-z0-9]*)?Debug$/.test(task.name),
  );
  const lintTasks = tasks.filter((task) => task.name === "lint");

  const fullUnitTestTasks = [
    ...(unitTasks.some((task) => task.name === "testDebugUnitTest")
      ? ["testDebugUnitTest"]
      : []),
    ...unitTasks
      .filter((task) => task.name !== "testDebugUnitTest")
      .map((task) => task.path),
  ];
  const focusedTestTasks = unitTasks.map((task) => task.path);
  const selectedAssembleTasks = assembleTasks.some(
    (task) => task.name === "assembleDebug",
  )
    ? ["assembleDebug"]
    : assembleTasks.map((task) => task.path).sort(compareStrings);
  const selectedLintTasks = lintTasks.length > 0 ? ["lint"] : [];
  const deviceTestTasks = [
    ...(deviceTasks.some((task) => task.name === "connectedDebugAndroidTest")
      ? ["connectedDebugAndroidTest"]
      : []),
    ...deviceTasks
      .filter((task) => task.name !== "connectedDebugAndroidTest")
      .map((task) => task.path),
  ];

  const configuration: GradleVerificationConfiguration = {
    fullUnitTestTasks: unique(fullUnitTestTasks),
    focusedTestTasks: unique(focusedTestTasks),
    assembleTasks: unique(selectedAssembleTasks),
    lintTasks: unique(selectedLintTasks),
    deviceTestTasks: unique(deviceTestTasks),
  };
  const missingGroups = Object.entries(configuration)
    .filter(([, values]) => values.length === 0)
    .map(([name]) => name);
  if (missingGroups.length > 0) {
    throw new GradleVerificationDiscoveryError(
      "GRADLE_TASK_MATRIX_INCOMPLETE",
      "Gradle task discovery could not build a complete Android verification matrix.",
      [
        `Missing task groups: ${missingGroups.join(", ")}`,
        `Detected relevant tasks: ${tasks.map((task) => task.path).join(", ") || "none"}`,
      ],
    );
  }
  return configuration;
}

export function discoverGradleVerificationConfiguration(
  targetDirectory: string,
  runner: GradleVerificationProcessRunner,
  options: GradleVerificationDiscoveryOptions = {},
): GradleVerificationConfiguration {
  const detection = detectAndroidProject(targetDirectory);
  if (
    !detection.isAndroidProject ||
    detection.projectRoot === null ||
    detection.gradleWrapper === null ||
    !detection.gradleWrapper.complete
  ) {
    throw new GradleVerificationDiscoveryError(
      "GRADLE_PROJECT_INVALID",
      "A complete Android Gradle project is required for task discovery.",
      [...detection.errors, ...detection.warnings],
    );
  }

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "opencode-android-orchestrator-gradle-"),
  );
  const initScript = join(temporaryDirectory, "discover-tasks.init.gradle");
  try {
    writeFileSync(initScript, GRADLE_TASK_DISCOVERY_INIT_SCRIPT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const result = runner(
      detection.gradleWrapper.script,
      [
        "help",
        "--init-script",
        initScript,
        "--console=plain",
        "--quiet",
      ],
      {
        cwd: detection.projectRoot,
        timeoutMs: options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      },
    );
    if (result.error !== null || result.status !== 0) {
      throw new GradleVerificationDiscoveryError(
        "GRADLE_TASK_DISCOVERY_FAILED",
        "Gradle could not enumerate Android verification tasks.",
        commandDetails(result),
      );
    }
    const taskPaths = parseGradleTaskPaths(result.stdout);
    return inferGradleVerificationConfiguration(
      detection,
      taskPaths,
      options.primaryModule,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
