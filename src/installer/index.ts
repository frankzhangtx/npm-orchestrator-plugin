export type InstallerCommand = "init" | "doctor" | "upgrade" | "uninstall";

export interface InstallerRequest {
  command: InstallerCommand;
  targetDirectory: string;
}

export {
  AdaptiveProjectTemplateError,
  planAdaptiveProjectTemplates,
  type AdaptiveAndroidModuleConfiguration,
  type AdaptiveAndroidProjectConfiguration,
  type AdaptiveAutomationConfiguration,
  type AdaptiveProjectTemplateErrorCode,
  type AdaptiveProjectTemplateOptions,
  type AdaptiveProjectTemplatePlan,
  type AdaptiveTaskContractExample,
} from "./adaptive-templates.js";

export {
  detectAndroidProject,
  type AndroidModuleDetection,
  type AndroidModuleType,
  type AndroidProjectDetection,
  type GradleDsl,
  type GradleWrapperDetection,
} from "./android-project.js";
export {
  INSTALLATION_BACKUPS_DIRECTORY,
  INSTALLATION_CONTROL_DIRECTORY,
  INSTALLATION_HISTORY_DIRECTORY,
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  INSTALLATION_MANIFEST_SCHEMA_VERSION,
  InstallationManifestError,
  completeInstallationManifest,
  planInstallationPreparation,
  prepareInstallationBackup,
  readInstallationManifest,
  rollbackPreparedInstallation,
  verifyInstallationIntegrity,
  type InstallationCompletionOptions,
  type InstallationFileInput,
  type InstallationFileStrategy,
  type InstallationIntegrityCheck,
  type InstallationIntegrityReport,
  type InstallationIntegrityStatus,
  type InstallationManifest,
  type InstallationManifestErrorCode,
  type InstallationManifestFile,
  type InstallationManifestState,
  type InstallationPreparationOptions,
  type InstallationPreparationPlan,
  type InstallationRollbackOptions,
  type PlannedInstallationFile,
  type PreparedInstallation,
  type PreviousInstallationFile,
} from "./install-manifest.js";
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
