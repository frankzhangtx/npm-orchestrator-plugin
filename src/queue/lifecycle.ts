import { existsSync } from "node:fs";
import { join } from "node:path";
import { TaskQueue } from "./queue.js";
import { fileLock, invariant, isAlive, readJson, type ProcessIdentity } from "./storage.js";

export function assertQueueIdle(directory: string): void {
  const queue = new TaskQueue(directory);
  const document = queue.storage.read();
  invariant(!document.active, "Stop or recover the active queue execution before changing installed resources");
  invariant(!document.items.some(item => item.taskRoot && !["COMPLETED", "ABORTED", "CANCELLED"].includes(item.state)), "Retained task workspaces must complete or abort before changing installed resources");
  const service = join(queue.storage.runtime, "service.json");
  invariant(!existsSync(service) || !isAlive(readJson<ProcessIdentity>(service)), "Stop the background queue service before upgrade or uninstall; queued contracts remain durable");
}

export function withQueueLifecycleLock<T>(directory: string, action: () => T): T {
  const queue = new TaskQueue(directory);
  const release = fileLock(join(queue.storage.runtime, "locks/lifecycle.lock"));
  try { assertQueueIdle(directory); return action(); } finally { release(); }
}
