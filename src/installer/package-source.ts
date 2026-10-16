import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface LocalPackageSource {
  installation?: { root: string; lockSha256: string; files: Record<string,
    { kind: "file"; sha256: string; mode: number } | { kind: "symlink"; target: string }> };
  kind: "local-tgz";
  name: string;
  version: string;
  artifact: string;
  sha256: string;
  sha512: string;
  packageRoot: string;
  entry: string;
  files: Record<string, { sha256: string; mode: number }>;
}
export interface RegistryPackageSource { kind: "registry"; name: string; version: string }
export type PackageSource = LocalPackageSource | RegistryPackageSource;
const hash = (bytes: Uint8Array, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function validPackageVersion(version: string): boolean {
  return version.trim() === version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(version);
}
export function validatePackageSource(source: PackageSource): void {
  requireThat(source && typeof source === "object" && typeof source.name === "string" && source.name.length > 0 && typeof source.version === "string" && validPackageVersion(source.version), "Invalid package source identity");
  if (source.kind === "registry") {
    requireThat(Object.keys(source).sort().join(",") === "kind,name,version", "Invalid registry source fields");
    return;
  }
  requireThat(source.kind === "local-tgz" && Object.keys(source).filter(k => k !== "installation").sort().join(",") === "artifact,entry,files,kind,name,packageRoot,sha256,sha512,version", "Invalid local source fields");
  requireThat(typeof source.artifact === "string" && isAbsolute(source.artifact) && typeof source.packageRoot === "string" && isAbsolute(source.packageRoot), "Local source requires absolute paths");
  requireThat(/^[a-f0-9]{64}$/.test(source.sha256) && /^[a-f0-9]{128}$/.test(source.sha512), "Invalid artifact digest");
  requireThat(source.entry === pathToFileURL(join(source.packageRoot, "dist/opencode-plugin.js")).href, "Invalid local plugin entry");
  requireThat(source.files && typeof source.files === "object" && !Array.isArray(source.files) && Object.hasOwn(source.files, "package.json") && Object.hasOwn(source.files, "dist/opencode-plugin.js"), "Missing package content identity");
  for (const [name, entry] of Object.entries(source.files)) {
    requireThat(name.length > 0 && !isAbsolute(name) && !name.split(/[\\/]/).some(p => p === ".." || p === "." || !p) && !name.includes("\\"), "Invalid package content path");
    requireThat(entry && Object.keys(entry).sort().join(",") === "mode,sha256" && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777, "Invalid package content metadata");
  }
  if (source.installation) {
    const i = source.installation;
    requireThat(Object.keys(i).sort().join(",") === "files,lockSha256,root" && isAbsolute(i.root) &&
      source.packageRoot === join(i.root, "node_modules", source.name) && /^[a-f0-9]{64}$/.test(i.lockSha256) &&
      i.files && typeof i.files === "object" && !Array.isArray(i.files), "Invalid local dependency installation");
    for (const [name, entry] of Object.entries(i.files)) {
      requireThat(name.startsWith("node_modules/") && !name.includes("\\") && name.split("/").every(p => p && p !== "." && p !== ".."), "Unsafe dependency path");
      requireThat(entry && (entry.kind === "file" ? Object.keys(entry).sort().join(",") === "kind,mode,sha256" &&
        /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 :
        entry.kind === "symlink" && Object.keys(entry).sort().join(",") === "kind,target" && typeof entry.target === "string" &&
        !isAbsolute(entry.target) && resolve(i.root, dirname(name), entry.target).startsWith(join(i.root, "node_modules") + "/")), "Invalid dependency metadata");
    }
  }
}
function installationInventory(root: string, packageRoot: string): NonNullable<LocalPackageSource["installation"]> {
  root = realpathSync(root);
  const files: NonNullable<LocalPackageSource["installation"]>["files"] = Object.create(null);
  const modules = join(root, "node_modules");
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      if (file === `${packageRoot}.source.json`) continue;
      const stat = lstatSync(file), key = relative(root, file);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(file);
        requireThat(!isAbsolute(target) && realpathSync(file).startsWith(modules + "/"), "Dependency symlink escapes local installation");
        files[key] = { kind: "symlink", target };
      } else if (stat.isDirectory()) walk(file);
      else {
        requireThat(stat.isFile(), "Dependency installation contains a special file");
        files[key] = { kind: "file", sha256: hash(readFileSync(file)), mode: stat.mode & 0o777 };
      }
    }
  }
  walk(modules);
  return { root, lockSha256: hash(readFileSync(join(root, "package-lock.json"))), files: Object.fromEntries(Object.entries(files)) };
}
function contentInventory(root: string): LocalPackageSource["files"] {
  const files: LocalPackageSource["files"] = Object.create(null) as LocalPackageSource["files"];
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      // Dependencies have their own lock and installation snapshot. Do not include
      // mutable npm bookkeeping or a descriptor in the frozen package inventory.
      if (directory === root && name === "node_modules") continue;
      const file = join(directory, name), stat = lstatSync(file);
      requireThat(!stat.isSymbolicLink(), "Local package content must not contain symlinks");
      if (stat.isDirectory()) visit(file);
      else {
        requireThat(stat.isFile(), "Local package contains a non-regular file");
        files[relative(root, file).split("\\").join("/")] = { sha256: hash(readFileSync(file)), mode: stat.mode & 0o777 };
      }
    }
  }
  visit(root);
  return Object.fromEntries(Object.entries(files));
}
export function describeLocalPackage(artifact: string, packageRoot: string, installationRoot?: string): LocalPackageSource {
  artifact = realpathSync(artifact); packageRoot = realpathSync(packageRoot);
  const bytes = readFileSync(artifact), pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name: string; version: string };
  const source: LocalPackageSource = { kind: "local-tgz", name: pkg.name, version: pkg.version, artifact, packageRoot,
    sha256: hash(bytes), sha512: hash(bytes, "sha512"), entry: pathToFileURL(join(packageRoot, "dist/opencode-plugin.js")).href,
    files: contentInventory(packageRoot), ...(installationRoot ? { installation: installationInventory(installationRoot, packageRoot) } : {}) };
  validatePackageSource(source);
  return source;
}
export function verifyPackageSource(source: PackageSource): void {
  validatePackageSource(source);
  if (source.kind !== "local-tgz") return;
  requireThat(realpathSync(source.artifact) === source.artifact && realpathSync(source.packageRoot) === source.packageRoot, "Local package path changed");
  const actual = describeLocalPackage(source.artifact, source.packageRoot, source.installation?.root);
  requireThat(actual.name === source.name && actual.version === source.version && actual.sha256 === source.sha256 && actual.sha512 === source.sha512, "Local package artifact identity changed");
  requireThat(JSON.stringify(actual.files) === JSON.stringify(source.files), "Local package installed content or permissions changed");
  requireThat(JSON.stringify(actual.installation) === JSON.stringify(source.installation), "Local dependency content, permissions or lock changed");
}
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function currentPackageSource(): PackageSource {
  const pkg = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8")) as { name: string; version: string };
  const descriptor = `${runtimeRoot}.source.json`;
  if (!existsSync(descriptor)) {
    const installation = resolve(runtimeRoot, pkg.name.startsWith("@") ? "../../.." : "../..");
    requireThat(!existsSync(join(installation, "candidate.json")) && !existsSync(join(installation, "transaction.json")),
      "Local candidate source descriptor is missing");
    return { kind: "registry", name: pkg.name, version: pkg.version };
  }
  const source = JSON.parse(readFileSync(descriptor, "utf8")) as PackageSource;
  verifyPackageSource(source);
  requireThat(source.kind === "local-tgz" && source.installation && source.packageRoot === runtimeRoot && source.name === pkg.name && source.version === pkg.version, "Runtime package is not bound to the local installation");
  return source;
}

/** Check the effective (project plus global) loader configuration. */
export function assertConfiguredPackageSource(source: PackageSource, references: unknown): void {
  validatePackageSource(source);
  if (source.kind !== "local-tgz") return;
  requireThat(Array.isArray(references) && references.every(ref => typeof ref === "string"), "Invalid effective plugin references");
  requireThat(references.filter(ref => ref === source.entry).length === 1, "Local plugin entry must be configured exactly once");
  requireThat(!references.some(ref => ref === source.name || ref.startsWith(source.name + "@")), "Registry and local Orchestrator plugins cannot load together");
  for (const reference of references) {
    if (reference === source.entry || !reference.startsWith("file:")) continue;
    let directory: string;
    try { directory = dirname(realpathSync(fileURLToPath(reference))); }
    catch { throw new Error("Cannot verify an additional local plugin entry"); }
    for (;;) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {name?: string};
        requireThat(pkg.name !== source.name, "Multiple local Orchestrator sources cannot load together");
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
}

export function packageRuntimeIdentity(): {kind: PackageSource["kind"]; name: string; version: string; packageRoot: string; artifactSha256: string | null} {
  const source = currentPackageSource();
  return {kind: source.kind, name: source.name, version: source.version, packageRoot: runtimeRoot,
    artifactSha256: source.kind === "local-tgz" ? source.sha256 : null};
}
