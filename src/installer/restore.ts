import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync,
  rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withQueueLifecycleLock } from "../queue/lifecycle.js";
import { TaskQueue } from "../queue/queue.js";
import { atomicJson, invariant, readJson, sha256 } from "../queue/storage.js";

type Entry = { kind: "file"; sha256: string; mode: number } | { kind: "directory"; mode: number } | { kind: "symlink"; target: string };
type Inventory = Record<string, Entry>;
interface RestorePoint { version: 1; root: string; paths: string[]; before: Inventory; capturedAt: string }
interface RestoreTransaction { version: 1; snapshotSha256: string; after: Inventory; state: "SEALED" | "RESTORING" | "RESTORED"; restoredAt?: string; pendingPaths?: string[] }
const validPath = (p: string) => typeof p === "string" && !isAbsolute(p) && !/[\\\u0000\r\n]/.test(p) &&
  p.split("/").every(v => v && v !== "." && v !== ".." && v !== ".git");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function safe(root: string, relative: string): string {
  invariant(validPath(relative), "Unsafe installation restoration path");
  let parent = root;
  for (const part of relative.split("/").slice(0, -1)) {
    parent = join(parent, part);
    if (existsSync(parent)) invariant(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), "Restoration parent is not a real directory");
  }
  return join(root, relative);
}
function inspect(root: string, paths: string[], backup?: string): Inventory {
  const inventory: Inventory = {};
  function walk(relative: string): void {
    const file = safe(root, relative);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file);
      invariant(!isAbsolute(target) && resolve(dirname(file), target).startsWith(root + "/"), "Restoration rejects external symlinks");
      inventory[relative] = { kind: "symlink", target };
    } else if (stat.isDirectory()) {
      inventory[relative] = { kind: "directory", mode: stat.mode & 0o777 };
      for (const name of readdirSync(file).sort()) walk(`${relative}/${name}`);
    } else {
      invariant(stat.isFile(), "Restoration rejects special files");
      const bytes = readFileSync(file), hash = sha256(bytes);
      inventory[relative] = { kind: "file", sha256: hash, mode: stat.mode & 0o777 };
      if (backup && !existsSync(join(backup, hash))) writeFileSync(join(backup, hash), bytes, {flag: "wx", mode: 0o600});
    }
  }
  for (const path of paths) walk(path);
  return Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b)));
}
function idle<T>(root: string, action: () => T): T {
  return withQueueLifecycleLock(root, () => {
    invariant(new TaskQueue(root).storage.read().paused, "Installation restoration requires a paused queue");
    return action();
  });
}
function load(snapshot: string): { point: RestorePoint; digest: string } {
  const bytes = readFileSync(join(snapshot, "snapshot.json"));
  const point = JSON.parse(bytes.toString("utf8")) as RestorePoint;
  invariant(point.version === 1 && point.root === realpathSync(point.root) && Array.isArray(point.paths) &&
    point.paths.every(validPath) && point.paths.length <= 256, "Invalid installation restore point");
  for (const [path, entry] of Object.entries(point.before)) {
    invariant(point.paths.some(p => path === p || path.startsWith(p + "/")), "Backup entry is outside restoration scope");
    safe(point.root, path);
    invariant(entry && ["file", "directory", "symlink"].includes(entry.kind), "Invalid restoration entry");
    if (entry.kind !== "symlink") invariant(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777, "Invalid restoration mode");
    if (entry.kind === "symlink") invariant(typeof entry.target === "string" && !isAbsolute(entry.target) &&
      resolve(dirname(join(point.root, path)), entry.target).startsWith(point.root + "/"), "Unsafe restoration symlink");
    if (entry.kind === "file") invariant(/^[a-f0-9]{64}$/.test(entry.sha256) &&
      sha256(readFileSync(join(snapshot, "blobs", entry.sha256))) === entry.sha256, "Restoration backup content changed");
  }
  return {point, digest: sha256(bytes)};
}

/** Capture the union of old and planned managed paths before switching source. */
export function captureInstallationRestorePoint(directory: string, destination: string, desiredPaths: string[] = []): RestorePoint {
  const root = realpathSync(directory), snapshot = resolve(destination);
  invariant(snapshot !== root && !snapshot.startsWith(root + "/"), "Keep installation restore evidence outside the target checkout");
  return idle(root, () => {
    const manifest = readJson<{files: Array<{path: string}>}>(join(root, ".automation-plugin/manifest.json"));
    const candidates = [...new Set([...manifest.files.map(f => f.path), ...desiredPaths, ".automation-plugin",
      ".opencode/package.json", ".opencode/package-lock.json", ".opencode/bun.lock", ".opencode/bun.lockb", ".opencode/node_modules",
      "opencode.json", "opencode.jsonc"])].sort();
    invariant(candidates.length <= 256 && candidates.every(validPath), "Invalid managed restoration scope");
    for (const path of [...candidates]) {
      const parts = path.split("/");
      for (let n = 1; n < parts.length; n++) {
        const parent = parts.slice(0, n).join("/");
        if (!existsSync(safe(root, parent))) { candidates.push(parent); break; }
      }
    }
    const paths = [...new Set(candidates)].sort().filter(p => !candidates.some(other => other !== p && p.startsWith(other + "/")));
    mkdirSync(snapshot); mkdirSync(join(snapshot, "blobs"));
    const point: RestorePoint = {version: 1, root, paths, before: inspect(root, paths, join(snapshot, "blobs")), capturedAt: new Date().toISOString()};
    atomicJson(join(snapshot, "snapshot.json"), point);
    return point;
  });
}

/** Seal immediately after the controlled switch, before any model is launched. */
export function sealInstallationSwitch(snapshot: string): RestoreTransaction {
  const {point, digest} = load(snapshot);
  return idle(point.root, () => {
    const file = join(snapshot, "transaction.json");
    invariant(!existsSync(file), "Installation switch is already sealed");
    const transaction: RestoreTransaction = {version: 1, snapshotSha256: digest, after: inspect(point.root, point.paths), state: "SEALED"};
    atomicJson(file, transaction); return transaction;
  });
}

/** Restore only registered installation paths. Queue/task audits are never copied. */
export function restoreInstallation(snapshot: string): RestoreTransaction {
  const {point, digest} = load(snapshot), transactionFile = join(snapshot, "transaction.json");
  return idle(point.root, () => {
    const transaction = readJson<RestoreTransaction>(transactionFile);
    invariant(transaction.version === 1 && transaction.snapshotSha256 === digest &&
      ["SEALED", "RESTORING", "RESTORED"].includes(transaction.state), "Restoration transaction changed");
    const current = inspect(point.root, point.paths);
    const paths = [...new Set([...Object.keys(point.before), ...Object.keys(transaction.after), ...Object.keys(current)])];
    // Preflight every path before the first mutation; a restart can see either
    // original or sealed-switch bytes, but never silently overwrite new edits.
    for (const path of paths) {
      let interrupted = false;
      if (transaction.state === "RESTORING" && transaction.pendingPaths?.includes(path)) {
        const actual = current[path], original = point.before[path];
        interrupted = actual === undefined;
        if (actual?.kind === "file" && original?.kind === "file") {
          const partial = readFileSync(safe(point.root, path)), bytes = readFileSync(join(snapshot, "blobs", original.sha256));
          interrupted = partial.length <= bytes.length && partial.equals(bytes.subarray(0, partial.length));
        }
      }
      invariant(same(current[path], point.before[path]) || same(current[path], transaction.after[path]) || interrupted,
        `Installation changed outside the sealed switch: ${path}`);
    }
    if (transaction.state === "RESTORED") {
      invariant(same(current, point.before), "Restored installation drifted"); return transaction;
    }
    if (transaction.state === "SEALED") transaction.pendingPaths = paths.filter(p => !same(current[p], point.before[p]));
    transaction.state = "RESTORING"; atomicJson(transactionFile, transaction);
    for (const path of paths.sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a))) {
      const actual = current[path], original = point.before[path];
      if (!actual || same(actual, original) || actual.kind === "directory" && original?.kind === "directory") continue;
      const file = safe(point.root, path);
      if (actual.kind === "directory") rmdirSync(file); else unlinkSync(file);
    }
    for (const [path, original] of Object.entries(point.before).sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
      const file = safe(point.root, path);
      if (original.kind === "directory") { mkdirSync(file, {recursive: true}); chmodSync(file, original.mode); }
      else if (!same(current[path], original)) {
        mkdirSync(dirname(file), {recursive: true});
        if (original.kind === "symlink") symlinkSync(original.target, file);
        else {
          // Services remain stopped for this entire transaction. The durable
          // intent permits retrying an absent file or a prefix of these exact
          // backup bytes if the process dies during the write.
          writeFileSync(file, readFileSync(join(snapshot, "blobs", original.sha256)), {flag: "wx", mode: original.mode});
          chmodSync(file, original.mode);
        }
      }
    }
    invariant(same(inspect(point.root, point.paths), point.before), "Restoration verification failed");
    transaction.state = "RESTORED"; transaction.restoredAt = new Date().toISOString();
    atomicJson(transactionFile, transaction); return transaction;
  });
}

/** Read-only acceptance: never repair drift while reporting restoration success. */
export function verifyInstallationRestorePoint(snapshot: string): void {
  const {point, digest} = load(snapshot);
  const transaction = readJson<RestoreTransaction>(join(snapshot, "transaction.json"));
  invariant(transaction.version === 1 && transaction.snapshotSha256 === digest && transaction.state === "RESTORED",
    "Installation restoration has not completed");
  invariant(same(inspect(point.root, point.paths), point.before), "Restored installation drifted from the original snapshot");
}
