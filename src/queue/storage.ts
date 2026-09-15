import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function git(root: string, args: readonly string[], input?: string): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  invariant(result.status === 0, result.error?.message ?? result.stderr.trim() ?? "Git command failed");
  return result.stdout.trimEnd();
}

/** Read exact Git output bytes for snapshot content and NUL-delimited paths. */
export function gitBuffer(root: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    encoding: null, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  invariant(result.status === 0, result.error?.message ?? result.stderr.toString("utf8").trim() ?? "Git command failed");
  return result.stdout;
}

export function safePath(root: string, path: string): string {
  invariant(path.length > 0 && !path.includes("\0") && !isAbsolute(path), "Expected a repository-relative path");
  invariant(!path.split(/[\\/]/).some(part => part === ".." || part === ".git"), "Unsafe repository path");
  const target = resolve(root, path);
  invariant(target.startsWith(`${resolve(root)}${sep}`), "Path escapes the repository");
  for (let cursor = target; cursor !== resolve(root); cursor = dirname(cursor)) {
    if (existsSync(cursor)) invariant(!lstatSync(cursor).isSymbolicLink(), `Symbolic link is not allowed: ${cursor}`);
  }
  return target;
}

export function readJson<T>(path: string): T {
  invariant(!lstatSync(path).isSymbolicLink(), `Refusing symbolic-link runtime file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Replace a complete document; flush both bytes and its directory entry. */
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) invariant(!lstatSync(path).isSymbolicLink(), `Refusing symbolic link: ${path}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export interface ProcessIdentity { pid: number; started: string }

export function processIdentity(pid: number): ProcessIdentity | null {
  invariant(Number.isInteger(pid) && pid > 0, "Invalid process ID");
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat="], { encoding: "utf8" });
  invariant(!result.error, `Cannot inspect process ownership: ${result.error?.message}`);
  if (result.status === 1 && !result.stdout.trim()) return null;
  invariant(result.status === 0 && result.stdout.trim(), "Cannot prove process ownership; recovery required");
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.at(-1)?.startsWith("Z")) return null;
  return { pid, started: parts.slice(0, -1).join(" ") };
}

export function isAlive(owner: ProcessIdentity): boolean {
  return processIdentity(owner.pid)?.started === owner.started;
}

export function processGroupAlive(pid: number): boolean {
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  invariant(result.status === 0, "Cannot inspect executor process group; recovery required");
  return result.stdout.split("\n").some(line => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && !state?.startsWith("Z");
  });
}

/** Exclusive creation has no timeout takeover. Unknown/dead owners fail closed.
 * Only a verified dead owner may be removed by explicit recovery. */
export function fileLock(path: string, waitMs = 5000): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const identity = processIdentity(process.pid);
  invariant(identity, "Cannot record lock owner");
  const token = randomUUID();
  let descriptor: number;
  for (let attempt = 0; ; attempt += 1) {
    try { descriptor = openSync(path, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt * 20 >= waitMs) {
        throw new Error(`Queue transaction is occupied; retry or recover its recorded owner: ${path}`, { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ ...identity, token }));
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  return () => {
    const owner = readJson<ProcessIdentity & { token: string }>(path);
    invariant(owner.token === token, "Queue lock ownership changed");
    unlinkSync(path);
  };
}

export function recoverLock(path: string): boolean {
  if (!existsSync(path)) return false;
  const release = fileLock(`${path}.recovery`);
  try {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, "utf8");
  const owner = readJson<ProcessIdentity>(path);
  invariant(!isAlive(owner), "Lock owner is still alive; refusing recovery");
  invariant(readFileSync(path, "utf8") === before, "Lock changed during recovery");
  // Atomic rename preserves the original record for diagnosis. Never remove a
  // live lock because its heartbeat is old.
  renameSync(path, `${path}.recovered-${randomUUID()}`);
  return true;
  } finally { release(); }
}

export class QueueStorage<T> {
  readonly root: string;
  readonly runtime: string;
  readonly path: string;
  readonly lockPath: string;
  constructor(directory: string, private readonly initial: () => T) {
    this.root = realpathSync(git(resolve(directory), ["rev-parse", "--show-toplevel"]));
    const common = git(this.root, ["rev-parse", "--git-common-dir"]);
    const commonRoot = realpathSync(resolve(this.root, common));
    this.runtime = join(commonRoot, "automation-runtime");
    if (existsSync(this.runtime)) invariant(!lstatSync(this.runtime).isSymbolicLink(), "Runtime must not be a symbolic link");
    for (const path of ["inbox", "locks", "evidence", "workspaces", "state"]) safePath(this.runtime, path);
    this.path = safePath(this.runtime, "inbox/queue.json");
    this.lockPath = safePath(this.runtime, "locks/queue.transaction.lock");
  }
  read(): T { return existsSync(this.path) ? readJson<T>(this.path) : this.initial(); }
  transaction<R>(action: (document: T) => R): R {
    const release = fileLock(this.lockPath);
    try {
      const document = this.read();
      const result = action(document);
      atomicJson(this.path, document);
      return result;
    } finally { release(); }
  }
  relativeRuntime(path: string): string {
    return relative(this.runtime, path);
  }
}
