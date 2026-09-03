import { createHash } from "node:crypto";

export const AUTOMATION_CONFIG_RELATIVE_PATH = "automation/config.json";
export const DEFAULT_LINT_ENABLED = false;
export const DEFAULT_UNIT_TESTS_ENABLED = true;

export interface VerificationPolicy {
  lintEnabled: boolean;
  unitTestsEnabled: boolean;
}

interface ContentFingerprint {
  sha256: string;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function setOptionalBoolean(
  value: Record<string, unknown>,
  key: keyof VerificationPolicy,
  configured: boolean | undefined,
): void {
  if (configured === undefined) {
    delete value[key];
  } else {
    value[key] = configured;
  }
}

/**
 * Accept an otherwise byte-identical generated configuration when an operator
 * changed only the two supported verification-policy booleans. Enumerating the
 * previous boolean states lets upgrades authenticate the remaining managed
 * content against the installed manifest without storing another file copy.
 */
export function matchesManifestModuloVerificationPolicy(
  content: Uint8Array,
  expected: ContentFingerprint,
): boolean {
  if (
    content.byteLength === expected.size &&
    sha256(content) === expected.sha256
  ) {
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  if (
    typeof parsed.lintEnabled !== "boolean" ||
    typeof parsed.unitTestsEnabled !== "boolean"
  ) {
    return false;
  }

  const states: readonly (boolean | undefined)[] = [undefined, false, true];
  for (const unitTestsEnabled of states) {
    for (const lintEnabled of states) {
      const candidate = { ...parsed };
      setOptionalBoolean(candidate, "unitTestsEnabled", unitTestsEnabled);
      setOptionalBoolean(candidate, "lintEnabled", lintEnabled);
      const rendered = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
      if (
        rendered.byteLength === expected.size &&
        sha256(rendered) === expected.sha256
      ) {
        return true;
      }
    }
  }
  return false;
}
