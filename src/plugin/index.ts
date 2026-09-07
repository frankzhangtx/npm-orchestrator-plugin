import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "@opencode-ai/plugin";

import {
  applyLongCommandTimeout,
  readLongCommandTimeoutMs,
} from "../config/long-command-timeout.js";
import {
  defineCompatibleHooks,
  toCompatiblePluginInput,
  type CompatiblePlugin,
} from "../compatibility/hooks.js";
import { createReadOnlyTools } from "../tools/index.js";

export const ORCHESTRATOR_DIRECTORY_ENV =
  "OPENCODE_ANDROID_ORCHESTRATOR_DIRECTORY";
export const ORCHESTRATOR_WORKTREE_ENV =
  "OPENCODE_ANDROID_ORCHESTRATOR_WORKTREE";
export const BUNDLED_SKILLS_DIRECTORY = fileURLToPath(
  new URL(
    "../../resources/third-party/superpowers-v6.2.0/skills/",
    import.meta.url,
  ),
);
export const BUNDLED_SKILL_IDS = [
  "android-orchestrator-brainstorming",
  "android-orchestrator-writing-plans",
  "android-orchestrator-test-driven-development",
  "android-orchestrator-systematic-debugging",
  "android-orchestrator-verification-before-completion",
] as const;

interface ConfigWithSkillPaths {
  skills?: {
    paths?: string[];
  };
}

function assertBundledSkillsAvailable(): void {
  for (const skillId of BUNDLED_SKILL_IDS) {
    const entrypoint = resolve(BUNDLED_SKILLS_DIRECTORY, skillId, "SKILL.md");
    try {
      if (!lstatSync(entrypoint).isFile()) {
        throw new Error("entrypoint is not a regular file");
      }
    } catch (error) {
      throw new Error(
        `Bundled Orchestrator skill is unavailable: ${skillId}. Reinstall the exact Orchestrator package.`,
        { cause: error },
      );
    }
  }
}

/**
 * Runtime implementation deliberately receives only fields shared by the two
 * certified OpenCode versions.
 */
export const createCompatiblePlugin: CompatiblePlugin = async ({
  directory,
  worktree,
  $,
}) => {
  assertBundledSkillsAvailable();
  const projectDirectory = resolve(directory);
  const projectWorktree = resolve(worktree);
  const longCommandTimeoutMs = readLongCommandTimeoutMs(projectWorktree);

  return defineCompatibleHooks({
    config: async (config) => {
      const compatibleConfig = config as typeof config & ConfigWithSkillPaths;
      compatibleConfig.skills = compatibleConfig.skills ?? {};
      compatibleConfig.skills.paths = compatibleConfig.skills.paths ?? [];
      if (!compatibleConfig.skills.paths.includes(BUNDLED_SKILLS_DIRECTORY)) {
        compatibleConfig.skills.paths.push(BUNDLED_SKILLS_DIRECTORY);
      }
    },
    tool: createReadOnlyTools({
      directory: projectDirectory,
      worktree: projectWorktree,
      shell: $,
    }),
    "shell.env": async (_input, output) => {
      output.env[ORCHESTRATOR_DIRECTORY_ENV] = projectDirectory;
      output.env[ORCHESTRATOR_WORKTREE_ENV] = projectWorktree;
    },
    "tool.execute.before": async (input, output) => {
      applyLongCommandTimeout(input, output, longCommandTimeoutMs);
    },
  });
};

/** OpenCode SDK entry point compiled against the 1.14.22 baseline. */
export const AndroidOrchestratorPlugin: Plugin = async (input, options) =>
  createCompatiblePlugin(toCompatiblePluginInput(input), options);

export default AndroidOrchestratorPlugin;
