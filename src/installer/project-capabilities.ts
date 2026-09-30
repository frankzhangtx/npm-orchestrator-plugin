import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectAndroidProject, type AndroidProjectDetection, type AndroidModuleType } from "./android-project.js";
import type { GradleVerificationConfiguration } from "./adaptive-templates.js";

export interface ModuleCapabilities {
  gradlePath: string;
  directory: string;
  buildFile: string;
  type: AndroidModuleType;
  namespace: string | null;
  applicationId: string | null;
  dependencies: string[];
  sources: Array<{ name: string; kind: "production" | "test"; paths: string[] }>;
  tasks: Array<{ path: string; kind: "unit" | "assemble" | "lint" | "device"; variant: string | null }>;
}
export interface ProjectCapabilities { version: 1; buildRoot: string; modules: ModuleCapabilities[] }
export const CAPABILITIES_MARKER = "OPENCODE_ANDROID_ORCHESTRATOR_MODEL=";
const fail = (message: string): never => { throw new Error(`Invalid Android capability model: ${message}`); };
const shared = createRequire(import.meta.url)("../../templates/automation/verification/project.cjs") as {
  validateProjectCapabilities(value: unknown, root: string): ProjectCapabilities;
  safePath(root: string, value: unknown, pattern?: boolean): string;
  validateConfigurationModel(config: unknown, root: string): void;
  gradleBuildRoot(config: unknown, root: string): string;
  buildProtectedPaths(buildRoot: string): string[];
};
const safePath = shared.safePath;
export const validateProjectCapabilities = shared.validateProjectCapabilities;
export const validateConfigurationModel = shared.validateConfigurationModel;
export const gradleBuildRoot = shared.gradleBuildRoot;
export const buildProtectedPaths = shared.buildProtectedPaths;

export function parseProjectCapabilities(stdout: string, gitRoot: string, projectRoot: string): ProjectCapabilities | undefined {
  const lines = stdout.split(/\r?\n/).filter(l => l.startsWith(CAPABILITIES_MARKER));
  if (!lines.length) return undefined;
  if (lines.length !== 1) fail("duplicate model output");
  const raw = JSON.parse(Buffer.from(lines[0]!.slice(CAPABILITIES_MARKER.length), "base64").toString("utf8"));
  const originalRoot = resolve(gitRoot);
  gitRoot = realpathSync(gitRoot);
  const portable = (path: string) => {
    if (!isAbsolute(path)) fail("discovery path must be absolute");
    const local = relative(originalRoot, path);
    if (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)) path = resolve(gitRoot, local);
    const p = relative(gitRoot, path).split(sep).join("/") || ".";
    return safePath(gitRoot, p);
  };
  if (raw.version !== 1 || realpathSync(raw.buildRoot) !== realpathSync(projectRoot) || !Array.isArray(raw.modules)) fail("wrong discovery build");
  raw.buildRoot = portable(raw.buildRoot);
  for (const m of raw.modules) {
    m.directory = portable(m.directory); m.buildFile = portable(m.buildFile);
    for (const s of m.sources) s.paths = s.paths.map((p: string) => p.endsWith("/**") ? `${portable(p.slice(0, -3))}/**` : portable(p));
  }
  return validateProjectCapabilities(raw, gitRoot);
}

export function detectionWithCapabilities(detection: AndroidProjectDetection, capabilities: ProjectCapabilities): AndroidProjectDetection {
  if (!detection.gitRoot) fail("Git root missing");
  validateProjectCapabilities(capabilities, detection.gitRoot!);
  const selectedRoot = resolve(detection.gitRoot!, capabilities.buildRoot);
  const repositoryRoot = detection.gitRoot;
  if (detection.projectRoot !== selectedRoot) detection = detectAndroidProject(selectedRoot);
  if (detection.projectRoot !== selectedRoot || detection.gitRoot !== repositoryRoot) fail("selected build settings missing or outside repository");
  return { ...detection, capabilities, isAndroidProject: true,
    errors: detection.errors.filter(e => !e.startsWith("No included Gradle module")),
    modules: capabilities.modules.map(m => ({ gradlePath: m.gradlePath, directory: resolve(detection.gitRoot!, m.directory),
      buildFile: resolve(detection.gitRoot!, m.buildFile), dsl: m.buildFile.endsWith(".kts") ? "kotlin" : "groovy", type: m.type,
      pluginIds: [], namespace: m.namespace, applicationId: m.applicationId })) };
}

export function capabilityVerification(model: ProjectCapabilities, preferred?: string): GradleVerificationConfiguration {
  const full: string[] = [], focused: string[] = [], assemble: string[] = [], lint: string[] = [], device: string[] = [];
  for (const m of [...model.modules].sort((a,b) => Number(b.gradlePath === preferred) - Number(a.gradlePath === preferred) || a.gradlePath.localeCompare(b.gradlePath))) {
    const units = m.tasks.filter(t => t.kind === "unit");
    // All discovered source sets are editable proposals. Verify every available
    // unit-test variant; prefer Debug for focused feedback without dropping Release.
    const chosen = [...units].sort((a,b) => Number(b.variant?.endsWith("Debug") ?? false) - Number(a.variant?.endsWith("Debug") ?? false) || a.path.localeCompare(b.path));
    full.push(...chosen.map(t => t.path)); focused.push(...chosen.map(t => t.path));
    const builds = m.tasks.filter(t => t.kind === "assemble");
    // A variant without a local Test task still compiles editable production
    // sources. Retain its build gate independently of the unit-test matrix.
    const selectedBuilds = m.type === "jvm-library" ? builds.filter(t => t.variant === null) : builds.filter(t => t.variant !== null);
    if (!selectedBuilds.length) fail(`no build capability for ${m.gradlePath}`);
    assemble.push(...selectedBuilds.map(t => t.path));
    const linters = m.tasks.filter(t => t.kind === "lint");
    lint.push(...(linters.some(t => t.variant === null) ? linters.filter(t => t.variant === null) : linters).map(t => t.path));
    device.push(...m.tasks.filter(t => t.kind === "device").map(t => t.path));
  }
  if (!full.length) fail("no local unit-test capability");
  return { fullUnitTestTasks: full, focusedTestTasks: focused, assembleTasks: assemble, lintTasks: lint, deviceTestTasks: device };
}
