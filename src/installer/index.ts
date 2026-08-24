export type InstallerCommand = "init" | "doctor" | "upgrade" | "uninstall";

export interface InstallerRequest {
  command: InstallerCommand;
  targetDirectory: string;
}

export {
  detectAndroidProject,
  type AndroidModuleDetection,
  type AndroidModuleType,
  type AndroidProjectDetection,
  type GradleDsl,
  type GradleWrapperDetection,
} from "./android-project.js";
export {
  ORCHESTRATOR_PACKAGE_NAME,
  ORCHESTRATOR_PACKAGE_VERSION,
  ORCHESTRATOR_PLUGIN_REFERENCE,
  REQUIRED_PLUGIN_REFERENCES,
  SUPERPOWERS_PLUGIN_REFERENCE,
  OpenCodeConfigMergeError,
  mergeOpenCodeConfigText,
  planOpenCodeConfigMerge,
  pluginPackageIdentity,
  type OpenCodeConfigMergeErrorCode,
  type OpenCodeConfigMergeOptions,
  type OpenCodeConfigMergePlan,
  type OpenCodeConfigMergeResult,
} from "./opencode-config.js";
