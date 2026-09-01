import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type Node,
  type ParseError,
} from "jsonc-parser";

export const ORCHESTRATOR_PACKAGE_NAME =
  "@frankzhang2026/opencode-android-orchestrator";
export const ORCHESTRATOR_PACKAGE_VERSION = "0.6.1";
export const ORCHESTRATOR_PLUGIN_REFERENCE =
  `${ORCHESTRATOR_PACKAGE_NAME}@${ORCHESTRATOR_PACKAGE_VERSION}`;
export const OPENCODE_CONFIG_SCHEMA_URL =
  "https://opencode.ai/config.json";
export const SUPERPOWERS_PLUGIN_REFERENCE =
  "superpowers@git+https://github.com/obra/superpowers.git#v6.2.0";
export const REQUIRED_PLUGIN_REFERENCES = [
  SUPERPOWERS_PLUGIN_REFERENCE,
  ORCHESTRATOR_PLUGIN_REFERENCE,
] as const;

export type OpenCodeConfigMergeErrorCode =
  | "AMBIGUOUS_CONFIG"
  | "CONFIG_NOT_FILE"
  | "CONFIG_READ_FAILED"
  | "CONFIG_SYMLINK"
  | "DUPLICATE_PLUGIN"
  | "DUPLICATE_PROPERTY"
  | "INVALID_JSONC"
  | "INVALID_PLUGIN_ENTRY"
  | "PLUGIN_NOT_ARRAY"
  | "PLUGIN_VERSION_CONFLICT"
  | "ROOT_NOT_OBJECT"
  | "TARGET_NOT_DIRECTORY";

export class OpenCodeConfigMergeError extends Error {
  readonly code: OpenCodeConfigMergeErrorCode;
  readonly details: readonly string[];

  constructor(
    code: OpenCodeConfigMergeErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "OpenCodeConfigMergeError";
    this.code = code;
    this.details = details;
  }
}

export interface OpenCodeConfigMergeOptions {
  requiredPluginReferences?: readonly string[];
}

export interface OpenCodeConfigMergeResult {
  content: string;
  changed: boolean;
  addedPluginReferences: readonly string[];
  pluginReferences: readonly string[];
}

export interface OpenCodeConfigMergePlan extends OpenCodeConfigMergeResult {
  targetDirectory: string;
  configPath: string;
  configFormat: "json" | "jsonc";
  existed: boolean;
  originalContent: string;
}

interface ValidatedConfig {
  root: Node;
  pluginNode: Node | undefined;
  pluginReferences: readonly string[];
}

function filesystemErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function formatJsonPath(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>(
    (result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : `${result}.${segment}`,
    "$",
  );
}

function findDuplicateProperties(
  node: Node,
  path: readonly (string | number)[] = [],
): readonly string[] {
  const duplicates: string[] = [];

  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      const key = typeof keyNode?.value === "string" ? keyNode.value : null;
      if (key === null) {
        continue;
      }

      const propertyPath = [...path, key];
      if (seen.has(key)) {
        duplicates.push(formatJsonPath(propertyPath));
      } else {
        seen.add(key);
      }
      if (valueNode !== undefined) {
        duplicates.push(...findDuplicateProperties(valueNode, propertyPath));
      }
    }
  } else if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      duplicates.push(...findDuplicateProperties(child, [...path, index]));
    }
  }

  return duplicates;
}

function lineAndColumn(source: string, offset: number): string {
  const beforeOffset = source.slice(0, offset);
  const lines = beforeOffset.split(/\r?\n/);
  return `${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`;
}

function parseErrorDetails(
  source: string,
  errors: readonly ParseError[],
): readonly string[] {
  return errors.map(
    (error) =>
      `${printParseErrorCode(error.error)} at ${lineAndColumn(source, error.offset)}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function pluginReference(entry: unknown, index: number): string {
  if (typeof entry === "string" && entry.length > 0 && entry.trim() === entry) {
    return entry;
  }

  if (
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "string" &&
    entry[0].length > 0 &&
    entry[0].trim() === entry[0] &&
    isPlainObject(entry[1])
  ) {
    return entry[0];
  }

  throw new OpenCodeConfigMergeError(
    "INVALID_PLUGIN_ENTRY",
    `plugin[${index}] must be a non-empty string or [string, options] tuple.`,
  );
}

export function pluginPackageIdentity(reference: string): string {
  if (reference.startsWith("@")) {
    const slashIndex = reference.indexOf("/");
    const versionIndex =
      slashIndex < 0 ? -1 : reference.indexOf("@", slashIndex + 1);
    return versionIndex < 0 ? reference : reference.slice(0, versionIndex);
  }

  const versionIndex = reference.indexOf("@");
  return versionIndex < 0 ? reference : reference.slice(0, versionIndex);
}

function validatePluginReferences(
  entries: readonly unknown[],
): readonly string[] {
  const references = entries.map(pluginReference);
  const seen = new Map<string, string>();

  for (const reference of references) {
    const identity = pluginPackageIdentity(reference);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      throw new OpenCodeConfigMergeError(
        "DUPLICATE_PLUGIN",
        `Plugin ${identity} is configured more than once.`,
        [previous, reference],
      );
    }
    seen.set(identity, reference);
  }

  return references;
}

function parseAndValidateConfig(source: string): ValidatedConfig {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (root === undefined || errors.length > 0) {
    throw new OpenCodeConfigMergeError(
      "INVALID_JSONC",
      "OpenCode configuration is not valid JSON or JSONC.",
      parseErrorDetails(source, errors),
    );
  }
  if (root.type !== "object") {
    throw new OpenCodeConfigMergeError(
      "ROOT_NOT_OBJECT",
      "OpenCode configuration root must be an object.",
    );
  }

  const duplicateProperties = findDuplicateProperties(root);
  if (duplicateProperties.length > 0) {
    throw new OpenCodeConfigMergeError(
      "DUPLICATE_PROPERTY",
      "OpenCode configuration contains duplicate object properties.",
      duplicateProperties,
    );
  }

  const pluginNode = findNodeAtLocation(root, ["plugin"]);
  if (pluginNode === undefined) {
    return { root, pluginNode, pluginReferences: [] };
  }
  if (pluginNode.type !== "array") {
    throw new OpenCodeConfigMergeError(
      "PLUGIN_NOT_ARRAY",
      "OpenCode configuration property 'plugin' must be an array.",
    );
  }

  const pluginValue: unknown = getNodeValue(pluginNode);
  if (!Array.isArray(pluginValue)) {
    throw new OpenCodeConfigMergeError(
      "PLUGIN_NOT_ARRAY",
      "OpenCode configuration property 'plugin' must be an array.",
    );
  }

  return {
    root,
    pluginNode,
    pluginReferences: validatePluginReferences(pluginValue),
  };
}

function formattingOptions(source: string): FormattingOptions {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indentation = /\r?\n([ \t]+)"/.exec(source)?.[1];
  const usesTabs = indentation?.startsWith("\t") ?? false;

  return {
    eol,
    insertFinalNewline: source.endsWith("\n"),
    insertSpaces: !usesTabs,
    keepLines: true,
    tabSize: usesTabs ? 1 : (indentation?.length ?? 2),
  };
}

function requiredReferences(
  options: OpenCodeConfigMergeOptions,
): readonly string[] {
  const references =
    options.requiredPluginReferences ?? REQUIRED_PLUGIN_REFERENCES;
  const seen = new Set<string>();

  for (const reference of references) {
    if (reference.length === 0 || reference.trim() !== reference) {
      throw new OpenCodeConfigMergeError(
        "INVALID_PLUGIN_ENTRY",
        "Required plugin references must be non-empty trimmed strings.",
      );
    }
    const identity = pluginPackageIdentity(reference);
    if (seen.has(identity)) {
      throw new OpenCodeConfigMergeError(
        "DUPLICATE_PLUGIN",
        `Required plugin ${identity} is declared more than once.`,
      );
    }
    seen.add(identity);
  }

  return references;
}

export function mergeOpenCodeConfigText(
  source: string,
  options: OpenCodeConfigMergeOptions = {},
): OpenCodeConfigMergeResult {
  const validated = parseAndValidateConfig(source);
  const hasSchema =
    findNodeAtLocation(validated.root, ["$schema"]) !== undefined;
  const desiredReferences = requiredReferences(options);
  const existingByIdentity = new Map(
    validated.pluginReferences.map((reference) => [
      pluginPackageIdentity(reference),
      reference,
    ]),
  );
  const addedPluginReferences: string[] = [];

  for (const desiredReference of desiredReferences) {
    const identity = pluginPackageIdentity(desiredReference);
    const existingReference = existingByIdentity.get(identity);
    if (
      existingReference !== undefined &&
      existingReference !== desiredReference
    ) {
      throw new OpenCodeConfigMergeError(
        "PLUGIN_VERSION_CONFLICT",
        `Plugin ${identity} is already configured with a different reference.`,
        [existingReference, desiredReference],
      );
    }
    if (existingReference === undefined) {
      addedPluginReferences.push(desiredReference);
    }
  }

  if (addedPluginReferences.length === 0 && hasSchema) {
    return {
      content: source,
      changed: false,
      addedPluginReferences,
      pluginReferences: validated.pluginReferences,
    };
  }

  const modificationOptions = {
    formattingOptions: formattingOptions(source),
  };
  let content = source;

  if (!hasSchema) {
    content = applyEdits(
      content,
      modify(
        content,
        ["$schema"],
        OPENCODE_CONFIG_SCHEMA_URL,
        modificationOptions,
      ),
    );
  }

  if (
    addedPluginReferences.length > 0 &&
    validated.pluginNode === undefined
  ) {
    content = applyEdits(
      content,
      modify(content, ["plugin"], addedPluginReferences, modificationOptions),
    );
  } else if (addedPluginReferences.length > 0) {
    let insertionIndex = validated.pluginReferences.length;
    for (const reference of addedPluginReferences) {
      content = applyEdits(
        content,
        modify(content, ["plugin", insertionIndex], reference, {
          ...modificationOptions,
          isArrayInsertion: true,
        }),
      );
      insertionIndex += 1;
    }
  }

  const finalConfig = parseAndValidateConfig(content);
  return {
    content,
    changed: content !== source,
    addedPluginReferences,
    pluginReferences: finalConfig.pluginReferences,
  };
}

function existingConfigPath(targetDirectory: string): string | null {
  const candidates = [
    join(targetDirectory, "opencode.jsonc"),
    join(targetDirectory, "opencode.json"),
  ];
  const existing: string[] = [];

  for (const candidate of candidates) {
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        throw new OpenCodeConfigMergeError(
          "CONFIG_SYMLINK",
          `Refusing to merge a symbolic-link configuration: ${candidate}`,
        );
      }
      if (!stats.isFile()) {
        throw new OpenCodeConfigMergeError(
          "CONFIG_NOT_FILE",
          `OpenCode configuration path is not a regular file: ${candidate}`,
        );
      }
      existing.push(candidate);
    } catch (error) {
      if (error instanceof OpenCodeConfigMergeError) {
        throw error;
      }
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw new OpenCodeConfigMergeError(
          "CONFIG_READ_FAILED",
          `Unable to inspect OpenCode configuration: ${candidate}`,
          [error instanceof Error ? error.message : String(error)],
        );
      }
    }
  }

  if (existing.length > 1) {
    throw new OpenCodeConfigMergeError(
      "AMBIGUOUS_CONFIG",
      "Both opencode.json and opencode.jsonc exist; refusing to guess which one to edit.",
      existing,
    );
  }
  return existing[0] ?? null;
}

export function planOpenCodeConfigMerge(
  directory: string,
  options: OpenCodeConfigMergeOptions = {},
): OpenCodeConfigMergePlan {
  const targetDirectory = resolve(directory);
  try {
    if (!statSync(targetDirectory).isDirectory()) {
      throw new OpenCodeConfigMergeError(
        "TARGET_NOT_DIRECTORY",
        `Target is not a directory: ${targetDirectory}`,
      );
    }
  } catch (error) {
    if (error instanceof OpenCodeConfigMergeError) {
      throw error;
    }
    throw new OpenCodeConfigMergeError(
      "TARGET_NOT_DIRECTORY",
      `Target directory does not exist or cannot be read: ${targetDirectory}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const discoveredPath = existingConfigPath(targetDirectory);
  const configPath =
    discoveredPath ?? join(targetDirectory, "opencode.json");
  const existed = discoveredPath !== null;
  let originalContent = "{}\n";

  if (existed) {
    try {
      originalContent = readFileSync(configPath, "utf8");
    } catch (error) {
      throw new OpenCodeConfigMergeError(
        "CONFIG_READ_FAILED",
        `Unable to read OpenCode configuration: ${configPath}`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }

  const result = mergeOpenCodeConfigText(originalContent, options);
  return {
    ...result,
    targetDirectory,
    configPath,
    configFormat: configPath.endsWith(".jsonc") ? "jsonc" : "json",
    existed,
    originalContent,
  };
}
