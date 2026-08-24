import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  dirname,
  join,
  resolve,
} from "node:path";

export type GradleDsl = "kotlin" | "groovy" | "mixed" | "unknown";
export type AndroidModuleType =
  | "application"
  | "library"
  | "dynamic-feature"
  | "test"
  | "asset-pack";

export interface AndroidModuleDetection {
  gradlePath: string;
  directory: string;
  buildFile: string;
  dsl: Exclude<GradleDsl, "mixed" | "unknown">;
  type: AndroidModuleType;
  pluginIds: readonly string[];
}

export interface GradleWrapperDetection {
  script: string;
  properties: string;
  scriptPresent: boolean;
  propertiesPresent: boolean;
  executable: boolean;
  complete: boolean;
}

export interface AndroidProjectDetection {
  requestedDirectory: string;
  gitRoot: string | null;
  projectRoot: string | null;
  settingsFile: string | null;
  dsl: GradleDsl;
  gradleWrapper: GradleWrapperDetection | null;
  modules: readonly AndroidModuleDetection[];
  isGitRepository: boolean;
  isAndroidProject: boolean;
  warnings: readonly string[];
  errors: readonly string[];
}

const androidPluginTypes = {
  "com.android.application": "application",
  "com.android.library": "library",
  "com.android.dynamic-feature": "dynamic-feature",
  "com.android.test": "test",
  "com.android.asset-pack": "asset-pack",
} as const satisfies Record<string, AndroidModuleType>;

type AndroidPluginId = keyof typeof androidPluginTypes;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function findGitRoot(startDirectory: string): string | null {
  let currentDirectory = startDirectory;

  while (true) {
    if (existsSync(join(currentDirectory, ".git"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }
}

function findSettingsFile(
  startDirectory: string,
  boundaryDirectory: string | null,
  warnings: string[],
): string | null {
  let currentDirectory = startDirectory;

  while (true) {
    const kotlinSettings = join(currentDirectory, "settings.gradle.kts");
    const groovySettings = join(currentDirectory, "settings.gradle");
    const hasKotlinSettings = isRegularFile(kotlinSettings);
    const hasGroovySettings = isRegularFile(groovySettings);

    if (hasKotlinSettings && hasGroovySettings) {
      warnings.push(
        `Both settings.gradle.kts and settings.gradle exist in ${currentDirectory}; using settings.gradle.kts.`,
      );
    }
    if (hasKotlinSettings) {
      return kotlinSettings;
    }
    if (hasGroovySettings) {
      return groovySettings;
    }

    if (currentDirectory === boundaryDirectory) {
      return null;
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }
}

/** Remove Gradle comments while preserving quoted strings and line numbers. */
function stripComments(source: string): string {
  let result = "";
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const nextCharacter = source[index + 1] ?? "";

    if (state === "line") {
      if (character === "\n") {
        result += character;
        state = "normal";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block") {
      if (character === "*" && nextCharacter === "/") {
        result += "  ";
        index += 1;
        state = "normal";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single" || state === "double") {
      result += character;
      if (character === "\\") {
        result += nextCharacter;
        index += 1;
      } else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"')
      ) {
        state = "normal";
      }
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (character === "/" && nextCharacter === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else {
      result += character;
      if (character === "'") {
        state = "single";
      } else if (character === '"') {
        state = "double";
      }
    }
  }

  return result;
}

function extractQuotedModules(value: string, modules: Set<string>): void {
  const quotedValuePattern = /["'](:[^"']+)["']/g;
  for (const match of value.matchAll(quotedValuePattern)) {
    const modulePath = match[1];
    if (modulePath !== undefined) {
      modules.add(modulePath);
    }
  }
}

function parseIncludedModules(settingsSource: string): readonly string[] {
  const source = stripComments(settingsSource);
  const modules = new Set<string>();

  for (const match of source.matchAll(/\binclude\s*\(([^)]*)\)/gs)) {
    extractQuotedModules(match[1] ?? "", modules);
  }
  for (const match of source.matchAll(/^\s*include\s+([^\r\n]+)/gm)) {
    extractQuotedModules(match[1] ?? "", modules);
  }

  return [...modules].sort();
}

function parseProjectDirectoryMappings(
  settingsSource: string,
  projectRoot: string,
): ReadonlyMap<string, string> {
  const source = stripComments(settingsSource);
  const mappings = new Map<string, string>();
  const patterns = [
    /project\s*\(\s*["'](:[^"']+)["']\s*\)\s*\.projectDir\s*=\s*(?:rootProject\.)?file\s*\(\s*["']([^"']+)["']\s*\)/g,
    /project\s*\(\s*["'](:[^"']+)["']\s*\)\s*\.projectDir\s*=\s*(?:new\s+)?File\s*\(\s*(?:rootDir|settingsDir)\s*,\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const modulePath = match[1];
      const relativeDirectory = match[2];
      if (modulePath !== undefined && relativeDirectory !== undefined) {
        mappings.set(modulePath, resolve(projectRoot, relativeDirectory));
      }
    }
  }

  return mappings;
}

function pluginAliasAccessor(alias: string): string {
  return alias.split(/[._-]+/).filter(Boolean).join(".");
}

function parseAndroidPluginAliases(
  projectRoot: string,
): ReadonlyMap<string, AndroidPluginId> {
  const catalogPath = join(projectRoot, "gradle", "libs.versions.toml");
  if (!isRegularFile(catalogPath)) {
    return new Map();
  }

  const catalog = readTextFile(catalogPath);
  if (catalog === null) {
    return new Map();
  }
  const aliases = new Map<string, AndroidPluginId>();
  const pluginPattern =
    /^\s*([A-Za-z0-9_.-]+)\s*=\s*\{[^}\r\n]*\bid\s*=\s*["'](com\.android\.(?:application|library|dynamic-feature|test|asset-pack))["'][^}\r\n]*\}/gm;

  for (const match of catalog.matchAll(pluginPattern)) {
    const alias = match[1];
    const pluginId = match[2];
    if (alias !== undefined && pluginId !== undefined) {
      aliases.set(
        `libs.plugins.${pluginAliasAccessor(alias)}`,
        pluginId as AndroidPluginId,
      );
    }
  }

  return aliases;
}

function tokenIsApplied(source: string, token: string): boolean {
  let searchFrom = 0;

  while (true) {
    const tokenIndex = source.indexOf(token, searchFrom);
    if (tokenIndex < 0) {
      return false;
    }
    const lineStart = source.lastIndexOf("\n", tokenIndex) + 1;
    const nextLineBreak = source.indexOf("\n", tokenIndex);
    const lineEnd = nextLineBreak < 0 ? source.length : nextLineBreak;
    const line = source.slice(lineStart, lineEnd);
    if (!/\bapply\s+false\b/.test(line)) {
      return true;
    }
    searchFrom = tokenIndex + token.length;
  }
}

function detectAndroidPluginIds(
  buildSource: string,
  aliases: ReadonlyMap<string, AndroidPluginId>,
): readonly AndroidPluginId[] {
  const source = stripComments(buildSource);
  const pluginIds = new Set<AndroidPluginId>();

  for (const pluginId of Object.keys(androidPluginTypes) as AndroidPluginId[]) {
    if (tokenIsApplied(source, pluginId)) {
      pluginIds.add(pluginId);
    }
  }

  for (const [aliasAccessor, pluginId] of aliases) {
    if (tokenIsApplied(source, aliasAccessor)) {
      pluginIds.add(pluginId);
    }
  }

  return [...pluginIds].sort();
}

function moduleType(pluginIds: readonly AndroidPluginId[]): AndroidModuleType {
  const priority: readonly AndroidPluginId[] = [
    "com.android.application",
    "com.android.library",
    "com.android.dynamic-feature",
    "com.android.test",
    "com.android.asset-pack",
  ];
  const selectedPlugin = priority.find((pluginId) =>
    pluginIds.includes(pluginId),
  );
  return selectedPlugin === undefined
    ? "library"
    : androidPluginTypes[selectedPlugin];
}

function detectGradleWrapper(projectRoot: string): GradleWrapperDetection {
  const script = join(projectRoot, "gradlew");
  const properties = join(
    projectRoot,
    "gradle",
    "wrapper",
    "gradle-wrapper.properties",
  );
  const scriptPresent = isRegularFile(script);
  const propertiesPresent = isRegularFile(properties);
  const executable =
    scriptPresent && (statSync(script).mode & 0o111) !== 0;

  return {
    script,
    properties,
    scriptPresent,
    propertiesPresent,
    executable,
    complete: scriptPresent && propertiesPresent,
  };
}

function moduleDirectory(modulePath: string, projectRoot: string): string {
  return resolve(
    projectRoot,
    ...modulePath.slice(1).split(":").filter(Boolean),
  );
}

function detectDsl(
  settingsFile: string,
  modules: readonly AndroidModuleDetection[],
): GradleDsl {
  const dialects = new Set<"kotlin" | "groovy">([
    settingsFile.endsWith(".kts") ? "kotlin" : "groovy",
    ...modules.map((module) => module.dsl),
  ]);

  if (dialects.size > 1) {
    return "mixed";
  }
  return [...dialects][0] ?? "unknown";
}

export function detectAndroidProject(
  targetDirectory: string,
): AndroidProjectDetection {
  const requestedDirectory = resolve(targetDirectory);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!isDirectory(requestedDirectory)) {
    return {
      requestedDirectory,
      gitRoot: null,
      projectRoot: null,
      settingsFile: null,
      dsl: "unknown",
      gradleWrapper: null,
      modules: [],
      isGitRepository: false,
      isAndroidProject: false,
      warnings,
      errors: [
        `Target directory does not exist or is not a directory: ${requestedDirectory}`,
      ],
    };
  }

  const gitRoot = findGitRoot(requestedDirectory);
  if (gitRoot === null) {
    errors.push("No Git root (.git directory or file) was found.");
  }

  const settingsFile = findSettingsFile(
    requestedDirectory,
    gitRoot,
    warnings,
  );
  if (settingsFile === null) {
    errors.push("No settings.gradle.kts or settings.gradle file was found.");
    return {
      requestedDirectory,
      gitRoot,
      projectRoot: null,
      settingsFile: null,
      dsl: "unknown",
      gradleWrapper: null,
      modules: [],
      isGitRepository: gitRoot !== null,
      isAndroidProject: false,
      warnings,
      errors,
    };
  }

  const projectRoot = dirname(settingsFile);
  const settingsSource = readTextFile(settingsFile);
  if (settingsSource === null) {
    errors.push(`Unable to read Gradle settings file: ${settingsFile}`);
    return {
      requestedDirectory,
      gitRoot,
      projectRoot,
      settingsFile,
      dsl: settingsFile.endsWith(".kts") ? "kotlin" : "groovy",
      gradleWrapper: detectGradleWrapper(projectRoot),
      modules: [],
      isGitRepository: gitRoot !== null,
      isAndroidProject: false,
      warnings,
      errors,
    };
  }

  const includedModules = parseIncludedModules(settingsSource);
  const directoryMappings = parseProjectDirectoryMappings(
    settingsSource,
    projectRoot,
  );
  const aliases = parseAndroidPluginAliases(projectRoot);
  const modules: AndroidModuleDetection[] = [];

  const rootBuildExists =
    isRegularFile(join(projectRoot, "build.gradle.kts")) ||
    isRegularFile(join(projectRoot, "build.gradle"));
  const candidateModules = rootBuildExists
    ? [":", ...includedModules]
    : includedModules;

  for (const gradlePath of candidateModules) {
    const directory =
      directoryMappings.get(gradlePath) ??
      moduleDirectory(gradlePath, projectRoot);
    const kotlinBuildFile = join(directory, "build.gradle.kts");
    const groovyBuildFile = join(directory, "build.gradle");
    const hasKotlinBuild = isRegularFile(kotlinBuildFile);
    const hasGroovyBuild = isRegularFile(groovyBuildFile);

    if (hasKotlinBuild && hasGroovyBuild) {
      warnings.push(
        `Module ${gradlePath} has both build.gradle.kts and build.gradle; using build.gradle.kts.`,
      );
    }

    const buildFile = hasKotlinBuild
      ? kotlinBuildFile
      : hasGroovyBuild
        ? groovyBuildFile
        : null;
    if (buildFile === null) {
      warnings.push(
        `Module ${gradlePath} has no Gradle build file at ${directory}.`,
      );
      continue;
    }

    const buildSource = readTextFile(buildFile);
    if (buildSource === null) {
      warnings.push(`Unable to read Gradle build file: ${buildFile}`);
      continue;
    }
    const pluginIds = detectAndroidPluginIds(buildSource, aliases);
    if (pluginIds.length === 0) {
      continue;
    }

    modules.push({
      gradlePath,
      directory,
      buildFile,
      dsl: buildFile.endsWith(".kts") ? "kotlin" : "groovy",
      type: moduleType(pluginIds),
      pluginIds,
    });
  }

  if (modules.length === 0) {
    errors.push(
      "No included Gradle module applying a supported com.android plugin was found.",
    );
  }

  const gradleWrapper = detectGradleWrapper(projectRoot);
  if (!gradleWrapper.complete) {
    warnings.push(
      "Gradle Wrapper is incomplete (gradlew and wrapper properties are required).",
    );
  } else if (!gradleWrapper.executable) {
    warnings.push("gradlew exists but is not executable.");
  }

  return {
    requestedDirectory,
    gitRoot,
    projectRoot,
    settingsFile,
    dsl: detectDsl(settingsFile, modules),
    gradleWrapper,
    modules,
    isGitRepository: gitRoot !== null,
    isAndroidProject: gitRoot !== null && modules.length > 0,
    warnings,
    errors,
  };
}
