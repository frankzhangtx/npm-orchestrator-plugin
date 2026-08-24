export const MINIMUM_OPENCODE_VERSION = "1.14.22";
export const MAXIMUM_OPENCODE_VERSION = "1.16.0";
export const CERTIFIED_OPENCODE_VERSIONS = ["1.14.22", "1.15.13"] as const;

export interface ParsedSemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
  normalized: string;
}

export type OpenCodeVersionSupport =
  | "certified"
  | "supported-uncertified"
  | "unsupported"
  | "invalid";

export interface OpenCodeVersionCheck {
  input: string;
  installedVersion: string | null;
  support: OpenCodeVersionSupport;
  compatible: boolean;
  certified: boolean;
  message: string;
}

const semanticVersionPattern =
  /(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=$|[^0-9A-Za-z])/;

export function parseOpenCodeVersion(
  value: string,
): ParsedSemanticVersion | null {
  const match = semanticVersionPattern.exec(value.trim());
  if (match === null) {
    return null;
  }

  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (
    majorText === undefined ||
    minorText === undefined ||
    patchText === undefined
  ) {
    return null;
  }

  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);
  const patch = Number.parseInt(patchText, 10);
  const prerelease = match[4]?.split(".") ?? [];
  const normalized = `${major}.${minor}.${patch}${
    prerelease.length === 0 ? "" : `-${prerelease.join(".")}`
  }`;

  return { major, minor, patch, prerelease, normalized };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumber = /^[0-9]+$/.test(left) ? Number.parseInt(left, 10) : null;
  const rightNumber = /^[0-9]+$/.test(right)
    ? Number.parseInt(right, 10)
    : null;

  if (leftNumber !== null && rightNumber !== null) {
    return Math.sign(leftNumber - rightNumber);
  }
  if (leftNumber !== null) {
    return -1;
  }
  if (rightNumber !== null) {
    return 1;
  }
  return left.localeCompare(right);
}

export function compareSemanticVersions(
  left: ParsedSemanticVersion,
  right: ParsedSemanticVersion,
): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const identifierCount = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }

    const comparison = comparePrereleaseIdentifiers(
      leftIdentifier,
      rightIdentifier,
    );
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

export function checkOpenCodeVersion(input: string): OpenCodeVersionCheck {
  const installed = parseOpenCodeVersion(input);
  const minimum = parseOpenCodeVersion(MINIMUM_OPENCODE_VERSION);
  const maximum = parseOpenCodeVersion(MAXIMUM_OPENCODE_VERSION);

  if (installed === null || minimum === null || maximum === null) {
    return {
      input,
      installedVersion: null,
      support: "invalid",
      compatible: false,
      certified: false,
      message: `Unable to parse an OpenCode version from: ${input.trim() || "<empty>"}`,
    };
  }

  const compatible =
    compareSemanticVersions(installed, minimum) >= 0 &&
    compareSemanticVersions(installed, maximum) < 0;
  const certified = CERTIFIED_OPENCODE_VERSIONS.some(
    (version) => version === installed.normalized,
  );

  if (!compatible) {
    return {
      input,
      installedVersion: installed.normalized,
      support: "unsupported",
      compatible: false,
      certified: false,
      message: `OpenCode ${installed.normalized} is outside the supported range >=${MINIMUM_OPENCODE_VERSION} <${MAXIMUM_OPENCODE_VERSION}.`,
    };
  }

  if (!certified) {
    return {
      input,
      installedVersion: installed.normalized,
      support: "supported-uncertified",
      compatible: true,
      certified: false,
      message: `OpenCode ${installed.normalized} is in the supported range but has not been certified.`,
    };
  }

  return {
    input,
    installedVersion: installed.normalized,
    support: "certified",
    compatible: true,
    certified: true,
    message: `OpenCode ${installed.normalized} is certified.`,
  };
}
