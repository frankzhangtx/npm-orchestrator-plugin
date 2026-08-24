import type {
  Hooks,
  PluginInput,
  PluginOptions,
} from "@opencode-ai/plugin";

/**
 * Plugin input fields that are present in both certified OpenCode versions.
 * Keeping the runtime implementation behind this narrower view prevents an
 * accidental dependency on version-specific workspace or server APIs.
 */
export const COMMON_PLUGIN_INPUT_KEYS = [
  "directory",
  "worktree",
  "client",
  "$",
] as const satisfies readonly (keyof PluginInput)[];

export type CommonPluginInputKey =
  (typeof COMMON_PLUGIN_INPUT_KEYS)[number];
export type CompatiblePluginInput = Pick<PluginInput, CommonPluginInputKey>;

/** Hooks verified to exist in both OpenCode 1.14.22 and 1.15.13. */
export const COMMON_HOOK_NAMES = [
  "config",
  "tool",
  "command.execute.before",
  "permission.ask",
  "shell.env",
  "tool.execute.before",
  "tool.execute.after",
] as const satisfies readonly (keyof Hooks)[];

export type CommonHookName = (typeof COMMON_HOOK_NAMES)[number];
export type CompatibleHooks = Pick<Hooks, CommonHookName>;
export type CompatiblePlugin = (
  input: CompatiblePluginInput,
  options?: PluginOptions,
) => Promise<CompatibleHooks>;

const commonHookNames = new Set<string>(COMMON_HOOK_NAMES);

/**
 * Adds a runtime guard to the compile-time hook allowlist. This catches hooks
 * introduced through object spreading or untyped JavaScript before OpenCode
 * attempts to register them.
 */
export function defineCompatibleHooks(
  hooks: CompatibleHooks,
): CompatibleHooks {
  const unsupportedHooks = Object.keys(hooks).filter(
    (hookName) => !commonHookNames.has(hookName),
  );

  if (unsupportedHooks.length > 0) {
    throw new Error(
      `Unsupported OpenCode hook(s): ${unsupportedHooks.join(", ")}`,
    );
  }

  return hooks;
}

/** Remove all input fields that are not part of the certified common API. */
export function toCompatiblePluginInput(
  input: PluginInput,
): CompatiblePluginInput {
  return {
    directory: input.directory,
    worktree: input.worktree,
    client: input.client,
    $: input.$,
  };
}
