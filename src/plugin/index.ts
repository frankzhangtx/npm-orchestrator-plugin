import { resolve } from "node:path";

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

/**
 * Runtime implementation deliberately receives only fields shared by the two
 * certified OpenCode versions.
 */
export const createCompatiblePlugin: CompatiblePlugin = async ({
  directory,
  worktree,
  $,
}) => {
  const projectDirectory = resolve(directory);
  const projectWorktree = resolve(worktree);
  const longCommandTimeoutMs = readLongCommandTimeoutMs(projectWorktree);

  return defineCompatibleHooks({
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
