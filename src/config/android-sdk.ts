import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface AndroidSdkOptions {
  androidSdkDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface AndroidSdkCandidate {
  directory: string;
  source: string;
}

function localPropertiesSdkDirectory(
  targetDirectory: string,
): AndroidSdkCandidate | null {
  const localProperties = join(targetDirectory, "local.properties");
  try {
    const stats = lstatSync(localProperties);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return null;
    }
    const source = readFileSync(localProperties, "utf8");
    const value = source
      .split(/\r?\n/)
      .map((line) => /^\s*sdk\.dir\s*=\s*(.*?)\s*$/.exec(line)?.[1])
      .find((entry): entry is string => entry !== undefined && entry.length > 0);
    if (value === undefined) {
      return null;
    }
    const unescaped = value.replace(/\\([\\ :=])/g, "$1");
    return {
      directory: isAbsolute(unescaped)
        ? resolve(unescaped)
        : resolve(targetDirectory, unescaped),
      source: "local.properties sdk.dir",
    };
  } catch {
    return null;
  }
}

export function androidSdkCandidate(
  targetDirectory: string,
  options: AndroidSdkOptions = {},
): AndroidSdkCandidate | null {
  if (
    options.androidSdkDirectory !== undefined &&
    options.androidSdkDirectory.trim().length > 0
  ) {
    return {
      directory: resolve(options.androidSdkDirectory.trim()),
      source: "explicit option",
    };
  }
  const environment = options.environment ?? process.env;
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT"] as const) {
    const value = environment[name];
    if (value !== undefined && value.trim().length > 0) {
      return {
        directory: resolve(value.trim()),
        source: name,
      };
    }
  }
  return localPropertiesSdkDirectory(targetDirectory);
}
