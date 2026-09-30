import { spawnSync } from "node:child_process";
import { invariant, type ProcessIdentity } from "./storage.js";

export interface OwnedProcess extends ProcessIdentity { ppid: number; pgid: number; owned: boolean }

/** Discard command/environment text immediately: only identities may enter evidence. */
export function parseProcessTable(output: string, token: string): OwnedProcess[] {
  invariant(/^[a-f0-9]{64}$/.test(token), "Invalid Worker ownership token");
  return output.split("\n").filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s*(.*)$/);
    invariant(match, "Cannot parse process ownership snapshot");
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      started: match[4]!.trim().replace(/\s+/g, " "), zombie: match[5]!.startsWith("Z"),
      owned: (` ${match[6]} `).includes(` AUTOMATION_WORKER_TOKEN=${token} `) };
  }).filter(row => !row.zombie).map(({ zombie: _zombie, ...row }) => row);
}

export function processSnapshot(token: string): OwnedProcess[] {
  const result = spawnSync("ps", ["axeww", "-o", "pid=,ppid=,pgid=,lstart=,stat=,command="],
    { encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
  // Do not include ps stdout/stderr: it contains unrelated process environments.
  invariant(result.status === 0 && !result.error && result.stdout.trim(), "Cannot obtain complete process ownership snapshot");
  return parseProcessTable(result.stdout, token);
}

export function ownedTree(rows: OwnedProcess[], worker: ProcessIdentity, known: OwnedProcess[] = []): OwnedProcess[] {
  const root = rows.find(row => row.pid === worker.pid);
  // macOS may stop exposing an exiting process's environment before it becomes
  // a zombie. Previously witnessed identity is the same proof used for children.
  const witnessedRoot = root && known.some(p => p.pid === root.pid && p.started === root.started && p.pgid === root.pgid);
  invariant(!root || (root.started === worker.started && (root.owned || witnessedRoot)), "Worker identity changed; refusing termination");
  const selected = new Set(rows.filter(row => row.owned || known.some(p => p.pid === row.pid && p.started === row.started && p.pgid === row.pgid)).map(row => row.pid));
  if (root) selected.add(worker.pid);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
  }
  invariant(rows.filter(row => row.pgid === worker.pid).every(row => selected.has(row.pid)),
    "A Worker group member lacks ownership proof; retain execution slot");
  const tree = rows.filter(row => selected.has(row.pid));
  invariant(tree.length <= 256, "Worker process inventory exceeds the supervised limit");
  return tree;
}

export function signalOwned(token: string, expected: ProcessIdentity, signal: NodeJS.Signals, known: OwnedProcess[] = []): boolean {
  const current = processSnapshot(token).find(row => row.pid === expected.pid);
  if (!current) return false;
  const witnessed = known.some(p => p.pid === current.pid && p.started === current.started && p.pgid === current.pgid);
  invariant(current.started === expected.started && (current.owned || witnessed), "Process identity changed before signal; refusing termination");
  try { process.kill(expected.pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
