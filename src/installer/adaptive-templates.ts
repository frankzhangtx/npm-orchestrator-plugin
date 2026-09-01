import { readFileSync } from "node:fs";
import {
  isAbsolute,
  relative,
  sep,
} from "node:path";

import {
  detectAndroidProject,
  type AndroidModuleDetection,
  type AndroidModuleType,
  type AndroidProjectDetection,
  type GradleDsl,
} from "./android-project.js";
import {
  DEFAULT_LONG_COMMAND_TIMEOUT_MS,
  MAXIMUM_LONG_COMMAND_TIMEOUT_MS,
  MINIMUM_LONG_COMMAND_TIMEOUT_MS,
  isLongCommandTimeoutMs,
} from "../config/long-command-timeout.js";

export type AdaptiveProjectTemplateErrorCode =
  | "INVALID_ANDROID_PROJECT"
  | "LONG_COMMAND_TIMEOUT_INVALID"
  | "MODULE_SCOPE_INVALID"
  | "NESTED_GRADLE_ROOT_UNSUPPORTED"
  | "PRIMARY_MODULE_AMBIGUOUS"
  | "PRIMARY_MODULE_NOT_FOUND"
  | "PROJECT_PATH_OUTSIDE_GIT_ROOT"
  | "TEMPLATE_INVALID";

export class AdaptiveProjectTemplateError extends Error {
  readonly code: AdaptiveProjectTemplateErrorCode;
  readonly details: readonly string[];

  constructor(
    code: AdaptiveProjectTemplateErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "AdaptiveProjectTemplateError";
    this.code = code;
    this.details = details;
  }
}

export interface AdaptiveProjectTemplateOptions {
  /** Select whether generated task contracts can modify every detected module or one primary module. */
  moduleScope?: ModuleScope;
  /** Select the only editable module in primary scope or the focused-test default in all scope. */
  primaryModule?: string;
  /** Override the packaged Gradle quality-gate task matrix. */
  gradleVerification?: GradleVerificationConfiguration;
  /** Timeout applied by the plugin to managed long-running shell commands. */
  longCommandTimeoutMs?: number;
}

export type ModuleScope = "all" | "primary";

export const DEFAULT_MODULE_SCOPE: ModuleScope = "all";

export function isModuleScope(value: unknown): value is ModuleScope {
  return value === "all" || value === "primary";
}

export interface GradleVerificationConfiguration {
  fullUnitTestTasks: readonly string[];
  focusedTestTasks: readonly string[];
  assembleTasks: readonly string[];
  lintTasks: readonly string[];
  deviceTestTasks: readonly string[];
}

export interface AdaptiveAndroidModuleConfiguration {
  gradlePath: string;
  directory: string;
  buildFile: string;
  dsl: "kotlin" | "groovy";
  type: AndroidModuleType;
  namespace: string | null;
  applicationId: string | null;
}

export interface AdaptiveAndroidProjectConfiguration {
  name: string;
  gradleDsl: Exclude<GradleDsl, "unknown">;
  settingsFile: string;
  moduleScope: ModuleScope;
  /** Default module for focused-test rendering; it does not narrow all-module scope. */
  primaryModule: string;
  modules: readonly AdaptiveAndroidModuleConfiguration[];
  productionPaths: readonly string[];
  testPaths: readonly string[];
}

export interface AdaptiveAutomationConfiguration {
  readonly [key: string]: unknown;
  schemaVersion: 3;
  androidProject: AdaptiveAndroidProjectConfiguration;
  gradleVerification: GradleVerificationConfiguration;
  longCommandTimeoutMs: number;
  plugins: Readonly<{ superpowers: string }>;
  protectedPaths: readonly string[];
}

export interface AdaptiveTargetTest {
  gradleTask: string;
  filter: string;
}

export interface AdaptiveTaskContractExample {
  readonly [key: string]: unknown;
  schemaVersion: 1;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
  targetTests: readonly AdaptiveTargetTest[];
}

export interface AdaptiveProjectTemplatePlan {
  detection: AndroidProjectDetection;
  projectRoot: string;
  moduleScope: ModuleScope;
  primaryModule: AdaptiveAndroidModuleConfiguration;
  automationConfig: AdaptiveAutomationConfiguration;
  automationConfigContent: string;
  taskContractExample: AdaptiveTaskContractExample;
  taskContractExampleContent: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObjectTemplate(relativePath: string): Record<string, unknown> {
  const templateUrl = new URL(`../../templates/${relativePath}`, import.meta.url);
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(templateUrl, "utf8")) as unknown;
  } catch (error) {
    throw new AdaptiveProjectTemplateError(
      "TEMPLATE_INVALID",
      `Unable to parse packaged template: ${relativePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  if (!isRecord(value)) {
    throw new AdaptiveProjectTemplateError(
      "TEMPLATE_INVALID",
      `Packaged template must contain a JSON object: ${relativePath}`,
    );
  }
  return value;
}

function stringArrayProperty(
  value: Record<string, unknown>,
  propertyName: string,
  relativePath: string,
): readonly string[] {
  const property = value[propertyName];
  if (
    !Array.isArray(property) ||
    property.length === 0 ||
    property.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new AdaptiveProjectTemplateError(
      "TEMPLATE_INVALID",
      `Packaged template property ${propertyName} must be a non-empty string array: ${relativePath}`,
    );
  }
  return property as readonly string[];
}

function repositoryPath(gitRoot: string, absolutePath: string): string {
  const relativePath = relative(gitRoot, absolutePath);
  if (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new AdaptiveProjectTemplateError(
      "PROJECT_PATH_OUTSIDE_GIT_ROOT",
      "Detected Android project paths must remain inside the Git root.",
      [absolutePath],
    );
  }
  return relativePath.length === 0
    ? "."
    : relativePath.split(sep).join("/");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

const GRADLE_TASK_PATTERN =
  /^(?:[A-Za-z][A-Za-z0-9_.-]*|(?::[A-Za-z0-9_.-]+)+)$/;

const GRADLE_VERIFICATION_PROPERTIES = [
  "fullUnitTestTasks",
  "focusedTestTasks",
  "assembleTasks",
  "lintTasks",
  "deviceTestTasks",
] as const;

function gradleTaskList(
  value: Record<string, unknown>,
  propertyName: (typeof GRADLE_VERIFICATION_PROPERTIES)[number],
  source: string,
): readonly string[] {
  const property = value[propertyName];
  if (
    !Array.isArray(property) ||
    property.length === 0 ||
    property.some(
      (entry) =>
        typeof entry !== "string" ||
        !GRADLE_TASK_PATTERN.test(entry),
    ) ||
    new Set(property).size !== property.length
  ) {
    throw new AdaptiveProjectTemplateError(
      "TEMPLATE_INVALID",
      `Gradle verification property ${propertyName} must be a non-empty unique task array: ${source}`,
    );
  }
  return property as readonly string[];
}

function gradleVerificationConfiguration(
  value: unknown,
  source: string,
): GradleVerificationConfiguration {
  if (!isRecord(value)) {
    throw new AdaptiveProjectTemplateError(
      "TEMPLATE_INVALID",
      `Gradle verification configuration must be an object: ${source}`,
    );
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...GRADLE_VERIFICATION_PROPERTIES].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new AdaptiveProjectTemplateError(
      "TEMPLATE_INVALID",
      `Gradle verification configuration has unexpected or missing properties: ${source}`,
      actualKeys,
    );
  }
  return {
    fullUnitTestTasks: gradleTaskList(
      value,
      "fullUnitTestTasks",
      source,
    ),
    focusedTestTasks: gradleTaskList(value, "focusedTestTasks", source),
    assembleTasks: gradleTaskList(value, "assembleTasks", source),
    lintTasks: gradleTaskList(value, "lintTasks", source),
    deviceTestTasks: gradleTaskList(value, "deviceTestTasks", source),
  };
}

function sourcePattern(directory: string, sourceSet: string): string {
  const prefix = directory === "." ? "" : `${directory}/`;
  return `${prefix}src/${sourceSet}/**`;
}

function selectPrimaryModule(
  modules: readonly AndroidModuleDetection[],
  requestedGradlePath: string | undefined,
  moduleScope: ModuleScope,
): AndroidModuleDetection {
  if (requestedGradlePath !== undefined) {
    const selected = modules.find(
      (module) => module.gradlePath === requestedGradlePath,
    );
    if (selected === undefined) {
      throw new AdaptiveProjectTemplateError(
        "PRIMARY_MODULE_NOT_FOUND",
        `Primary Android module was not detected: ${requestedGradlePath}`,
        modules.map((module) => module.gradlePath),
      );
    }
    return selected;
  }

  const applications = modules.filter(
    (module) => module.type === "application",
  );
  if (applications.length === 1) {
    return applications[0] as AndroidModuleDetection;
  }
  if (applications.length === 0 && modules.length === 1) {
    return modules[0] as AndroidModuleDetection;
  }

  const defaultModule = applications[0] ?? modules[0];
  if (moduleScope === "all" && defaultModule !== undefined) {
    return defaultModule;
  }

  throw new AdaptiveProjectTemplateError(
    "PRIMARY_MODULE_AMBIGUOUS",
    "Primary-module scope requires an explicit Android module before rendering templates.",
    (applications.length > 1 ? applications : modules).map(
      (module) => module.gradlePath,
    ),
  );
}

function taskTestFilter(module: AdaptiveAndroidModuleConfiguration): string {
  const packageName = [module.namespace, module.applicationId].find(
    (candidate) =>
      candidate !== null &&
      /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(candidate),
  );
  return packageName !== undefined
    ? `${packageName}.ReplaceWithFocusedTest`
    : "*ReplaceWithFocusedTest";
}

function taskForbiddenPath(protectedPath: string): string {
  return protectedPath.endsWith("/")
    ? `${protectedPath}**`
    : protectedPath;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function planAdaptiveProjectTemplates(
  targetDirectory: string,
  options: AdaptiveProjectTemplateOptions = {},
): AdaptiveProjectTemplatePlan {
  const detection = detectAndroidProject(targetDirectory);
  if (
    !detection.isAndroidProject ||
    detection.gitRoot === null ||
    detection.projectRoot === null ||
    detection.projectName === null ||
    detection.settingsFile === null ||
    detection.dsl === "unknown"
  ) {
    throw new AdaptiveProjectTemplateError(
      "INVALID_ANDROID_PROJECT",
      "A Git-backed Android Gradle project is required to render templates.",
      [...detection.errors, ...detection.warnings],
    );
  }
  if (detection.projectRoot !== detection.gitRoot) {
    throw new AdaptiveProjectTemplateError(
      "NESTED_GRADLE_ROOT_UNSUPPORTED",
      "The Gradle settings root must currently match the Git root.",
      [detection.gitRoot, detection.projectRoot],
    );
  }

  const gitRoot = detection.gitRoot;

  const moduleScope = options.moduleScope ?? DEFAULT_MODULE_SCOPE;
  if (!isModuleScope(moduleScope)) {
    throw new AdaptiveProjectTemplateError(
      "MODULE_SCOPE_INVALID",
      `Unsupported Android module scope: ${String(moduleScope)}`,
      ["Expected one of: all, primary"],
    );
  }

  const selectedModule = selectPrimaryModule(
    detection.modules,
    options.primaryModule,
    moduleScope,
  );
  const modules = detection.modules.map<AdaptiveAndroidModuleConfiguration>(
    (module) => ({
      gradlePath: module.gradlePath,
      directory: repositoryPath(gitRoot, module.directory),
      buildFile: repositoryPath(gitRoot, module.buildFile),
      dsl: module.dsl,
      type: module.type,
      namespace: module.namespace,
      applicationId: module.applicationId,
    }),
  );
  const primaryModule = modules.find(
    (module) => module.gradlePath === selectedModule.gradlePath,
  );
  if (primaryModule === undefined) {
    throw new AdaptiveProjectTemplateError(
      "PRIMARY_MODULE_NOT_FOUND",
      `Primary Android module was not rendered: ${selectedModule.gradlePath}`,
    );
  }

  const productionPaths = unique(
    modules.map((module) => sourcePattern(module.directory, "main")),
  );
  const testPaths = unique(
    modules.flatMap((module) => [
      sourcePattern(module.directory, "test"),
      sourcePattern(module.directory, "androidTest"),
    ]),
  );
  const androidProject: AdaptiveAndroidProjectConfiguration = {
    name: detection.projectName,
    gradleDsl: detection.dsl,
    settingsFile: repositoryPath(gitRoot, detection.settingsFile),
    moduleScope,
    primaryModule: primaryModule.gradlePath,
    modules,
    productionPaths,
    testPaths,
  };

  const configTemplatePath = "automation/config.json";
  const configTemplate = readObjectTemplate(configTemplatePath);
  const gradleVerification = gradleVerificationConfiguration(
    options.gradleVerification ?? configTemplate.gradleVerification,
    options.gradleVerification === undefined
      ? configTemplatePath
      : "AdaptiveProjectTemplateOptions.gradleVerification",
  );
  const longCommandTimeoutMs =
    options.longCommandTimeoutMs ??
    configTemplate.longCommandTimeoutMs ??
    DEFAULT_LONG_COMMAND_TIMEOUT_MS;
  if (!isLongCommandTimeoutMs(longCommandTimeoutMs)) {
    throw new AdaptiveProjectTemplateError(
      "LONG_COMMAND_TIMEOUT_INVALID",
      `Long-command timeout must be an integer from ${MINIMUM_LONG_COMMAND_TIMEOUT_MS} to ${MAXIMUM_LONG_COMMAND_TIMEOUT_MS} milliseconds.`,
    );
  }
  const baseProtectedPaths = stringArrayProperty(
    configTemplate,
    "protectedPaths",
    configTemplatePath,
  );
  const protectedPaths = unique([
    ...baseProtectedPaths,
    androidProject.settingsFile,
    ...modules.map((module) => module.buildFile),
  ]);
  const automationConfig = {
    ...configTemplate,
    longCommandTimeoutMs,
    gradleVerification,
    androidProject,
    protectedPaths,
  } as unknown as AdaptiveAutomationConfiguration;

  const taskTemplatePath =
    "automation/tasks/TASK-TEMPLATE.json.example";
  const taskTemplate = readObjectTemplate(taskTemplatePath);
  const defaultFocusedTestTask = gradleVerification.focusedTestTasks[0];
  if (defaultFocusedTestTask === undefined) {
    throw new AdaptiveProjectTemplateError(
      "TEMPLATE_INVALID",
      "Gradle verification configuration has no focused test task.",
    );
  }
  const taskContractExample = {
    ...taskTemplate,
    allowedPaths:
      moduleScope === "all"
        ? [...productionPaths, ...testPaths]
        : [
            sourcePattern(primaryModule.directory, "main"),
            sourcePattern(primaryModule.directory, "test"),
            sourcePattern(primaryModule.directory, "androidTest"),
          ],
    forbiddenPaths: protectedPaths.map(taskForbiddenPath),
    targetTests: [
      {
        gradleTask: defaultFocusedTestTask,
        filter: taskTestFilter(primaryModule),
      },
    ],
  } as unknown as AdaptiveTaskContractExample;

  return {
    detection,
    projectRoot: detection.projectRoot,
    moduleScope,
    primaryModule,
    automationConfig,
    automationConfigContent: serialize(automationConfig),
    taskContractExample,
    taskContractExampleContent: serialize(taskContractExample),
  };
}
