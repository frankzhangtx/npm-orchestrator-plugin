import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const AGENTS_MANAGED_BLOCK_BEGIN =
  "<!-- opencode-android-orchestrator:begin -->";
export const AGENTS_MANAGED_BLOCK_END =
  "<!-- opencode-android-orchestrator:end -->";

export type AgentsConfigMergeErrorCode =
  | "AGENTS_BLOCK_CONFLICT"
  | "AGENTS_MARKERS_INVALID"
  | "AGENTS_NOT_FILE"
  | "AGENTS_READ_FAILED"
  | "AGENTS_SYMLINK"
  | "TARGET_NOT_DIRECTORY"
  | "TEMPLATE_INVALID";

export class AgentsConfigMergeError extends Error {
  readonly code: AgentsConfigMergeErrorCode;
  readonly details: readonly string[];

  constructor(
    code: AgentsConfigMergeErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "AgentsConfigMergeError";
    this.code = code;
    this.details = details;
  }
}

export interface AgentsConfigMergePlan {
  targetDirectory: string;
  agentsPath: string;
  existed: boolean;
  originalContent: string;
  content: string;
  changed: boolean;
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

function markerCount(content: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(marker, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + marker.length;
  }
}

function packagedFragment(): string {
  const fragmentUrl = new URL(
    "../../templates/AGENTS.md.fragment",
    import.meta.url,
  );
  let fragment: string;
  try {
    fragment = readFileSync(fragmentUrl, "utf8");
  } catch (error) {
    throw new AgentsConfigMergeError(
      "TEMPLATE_INVALID",
      "Unable to read the packaged AGENTS managed block.",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  if (
    markerCount(fragment, AGENTS_MANAGED_BLOCK_BEGIN) !== 1 ||
    markerCount(fragment, AGENTS_MANAGED_BLOCK_END) !== 1 ||
    !fragment.startsWith(`${AGENTS_MANAGED_BLOCK_BEGIN}\n`) ||
    !fragment.endsWith(`${AGENTS_MANAGED_BLOCK_END}\n`)
  ) {
    throw new AgentsConfigMergeError(
      "TEMPLATE_INVALID",
      "The packaged AGENTS managed block markers are invalid.",
    );
  }
  return fragment;
}

function lineEnding(content: string): "\n" | "\r\n" {
  const withoutCrLf = content.replaceAll("\r\n", "");
  return content.includes("\r\n") && !withoutCrLf.includes("\n")
    ? "\r\n"
    : "\n";
}

function convertLineEndings(content: string, ending: "\n" | "\r\n"): string {
  return ending === "\n"
    ? content
    : content.replaceAll("\n", "\r\n");
}

function appendManagedBlock(original: string, fragment: string): string {
  if (original.length === 0) {
    return fragment;
  }
  const ending = lineEnding(original);
  const convertedFragment = convertLineEndings(fragment, ending);
  const separator = original.endsWith(`${ending}${ending}`)
    ? ""
    : original.endsWith(ending)
      ? ending
      : `${ending}${ending}`;
  return `${original}${separator}${convertedFragment}`;
}

function mergeAgentsContent(original: string, fragment: string): string {
  const beginCount = markerCount(original, AGENTS_MANAGED_BLOCK_BEGIN);
  const endCount = markerCount(original, AGENTS_MANAGED_BLOCK_END);
  if (beginCount === 0 && endCount === 0) {
    return appendManagedBlock(original, fragment);
  }
  if (beginCount !== 1 || endCount !== 1) {
    throw new AgentsConfigMergeError(
      "AGENTS_MARKERS_INVALID",
      "AGENTS.md contains partial or duplicate orchestrator markers.",
    );
  }

  const begin = original.indexOf(AGENTS_MANAGED_BLOCK_BEGIN);
  const end = original.indexOf(AGENTS_MANAGED_BLOCK_END);
  if (begin < 0 || end < begin) {
    throw new AgentsConfigMergeError(
      "AGENTS_MARKERS_INVALID",
      "AGENTS.md orchestrator markers are out of order.",
    );
  }

  const existingBlock = original.slice(
    begin,
    end + AGENTS_MANAGED_BLOCK_END.length,
  );
  const expectedBlock = convertLineEndings(
    fragment.trimEnd(),
    lineEnding(original),
  );
  if (existingBlock !== expectedBlock) {
    throw new AgentsConfigMergeError(
      "AGENTS_BLOCK_CONFLICT",
      "The existing orchestrator block in AGENTS.md differs from this package.",
      ["Refusing to overwrite a modified managed block."],
    );
  }
  return original;
}

export function mergeAgentsConfigText(source: string): string {
  return mergeAgentsContent(source, packagedFragment());
}

export function planAgentsConfigMerge(
  directory: string,
): AgentsConfigMergePlan {
  const targetDirectory = resolve(directory);
  try {
    const stats = lstatSync(targetDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AgentsConfigMergeError(
        "TARGET_NOT_DIRECTORY",
        `Target is not a regular directory: ${targetDirectory}`,
      );
    }
  } catch (error) {
    if (error instanceof AgentsConfigMergeError) {
      throw error;
    }
    throw new AgentsConfigMergeError(
      "TARGET_NOT_DIRECTORY",
      `Target directory does not exist or cannot be read: ${targetDirectory}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const agentsPath = join(targetDirectory, "AGENTS.md");
  let existed = false;
  let originalContent = "";
  try {
    const stats = lstatSync(agentsPath);
    if (stats.isSymbolicLink()) {
      throw new AgentsConfigMergeError(
        "AGENTS_SYMLINK",
        `Refusing to merge a symbolic-link AGENTS.md: ${agentsPath}`,
      );
    }
    if (!stats.isFile()) {
      throw new AgentsConfigMergeError(
        "AGENTS_NOT_FILE",
        `AGENTS.md is not a regular file: ${agentsPath}`,
      );
    }
    existed = true;
    originalContent = readFileSync(agentsPath, "utf8");
  } catch (error) {
    if (error instanceof AgentsConfigMergeError) {
      throw error;
    }
    if (filesystemErrorCode(error) !== "ENOENT") {
      throw new AgentsConfigMergeError(
        "AGENTS_READ_FAILED",
        `Unable to read AGENTS.md: ${agentsPath}`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }

  const content = mergeAgentsConfigText(originalContent);
  return {
    targetDirectory,
    agentsPath,
    existed,
    originalContent,
    content,
    changed: content !== originalContent,
  };
}
