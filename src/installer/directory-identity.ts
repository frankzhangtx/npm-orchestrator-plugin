import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { invariant, sha256 } from "../queue/storage.js";

export interface DirectoryIdentity {
  mode: number;
  entries: Record<string, {kind: "directory"; mode: number} | {kind: "file"; mode: number; sha256: string} | {kind: "symlink"; target: string}>;
}
export function directoryIdentity(root: string, incomplete = false): DirectoryIdentity {
  invariant(!lstatSync(root).isSymbolicLink(), "Directory identity rejects a symlink root");
  root = realpathSync(root);
  const entries: DirectoryIdentity["entries"] = Object.create(null);
  function visit(directory: string, prefix: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
                invariant(!isAbsolute(target) && resolve(dirname(path), target).startsWith(root + "/"), "Package snapshot symlink escapes its directory");
        try { invariant(realpathSync(path).startsWith(root + "/"), "Package snapshot symlink escapes its directory"); }
        catch (error) { if (!incomplete || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        entries[relative] = {kind: "symlink", target};
      } else if (stat.isDirectory()) {
        entries[relative] = {kind: "directory", mode: stat.mode & 0o777}; visit(path, relative + "/");
      } else {
        invariant(stat.isFile(), "Package snapshot contains a special file");
        entries[relative] = {kind: "file", mode: stat.mode & 0o777, sha256: sha256(readFileSync(path))};
      }
    }
  }
  visit(root, ""); return {mode: lstatSync(root).mode & 0o777, entries: Object.fromEntries(Object.entries(entries))};
}
export function verifyDirectoryIdentity(root: string, expected: DirectoryIdentity): void {
  invariant(JSON.stringify(directoryIdentity(root)) === JSON.stringify(expected), "Package directory differs from its preserved identity");
}
/** Existing cache contents are never overwritten. Missing caches use a staged copy. */
export function restoreMissingPackageDirectory(backup: string, target: string, expected: DirectoryIdentity, runId: string): void {
  verifyDirectoryIdentity(backup, expected);
  if (existsSync(target)) { verifyDirectoryIdentity(target, expected); return; }
  invariant(/^[A-Za-z0-9-]{1,100}$/.test(runId), "Invalid package restoration identity");
  const staging = `${target}.restore-${runId}`;
  mkdirSync(dirname(target), {recursive: true});
  if (existsSync(staging)) {
    const partial = directoryIdentity(staging, true);
    invariant(partial.mode === expected.mode, "Interrupted package copy root mode changed");
    for (const [path, value] of Object.entries(partial.entries)) {
      const original = expected.entries[path];
      if (JSON.stringify(value) === JSON.stringify(original)) continue;
      invariant(value.kind === "file" && original?.kind === "file", "Interrupted package copy contains unrecognized entries");
      const bytes = readFileSync(join(staging, path)), source = readFileSync(join(backup, path));
      invariant(bytes.length <= source.length && bytes.equals(source.subarray(0, bytes.length)), "Interrupted package copy contains unrecognized bytes");
      unlinkSync(join(staging, path));
    }
  }
  cpSync(backup, staging, {recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: false});
  verifyDirectoryIdentity(staging, expected); renameSync(staging, target);
}
