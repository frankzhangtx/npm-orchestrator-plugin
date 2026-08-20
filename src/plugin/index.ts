import type { Plugin } from "@opencode-ai/plugin";

/**
 * Minimal, side-effect-free plugin entry used while the installer and
 * read-only diagnostic tools are implemented.
 */
export const AndroidOrchestratorPlugin: Plugin = async ({
  directory,
  worktree,
}) => {
  void directory;
  void worktree;

  return {};
};

export default AndroidOrchestratorPlugin;
