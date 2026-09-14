export interface QueuePolicy {
  workspaceStrategy: "inPlaceExclusive" | "isolatedWorktree";
  commitPolicy: "humanApproval" | "autoCommit";
  worktreeBase: string;
  queue: { scanIntervalMs: number; maxWorkspaces: number; maxWorkspaceBytes: number };
}

export function queuePolicy(value: Partial<Record<keyof QueuePolicy, unknown>>): QueuePolicy {
  const workspaceStrategy = value.workspaceStrategy ?? "inPlaceExclusive";
  const commitPolicy = value.commitPolicy ?? "humanApproval";
  const worktreeBase = value.worktreeBase ?? "";
  const settings = value.queue as Partial<QueuePolicy["queue"]> | undefined;
  const queue = { scanIntervalMs: 5000, maxWorkspaces: 3, maxWorkspaceBytes: 20 * 1024 ** 3, ...settings };
  if (!["inPlaceExclusive", "isolatedWorktree"].includes(String(workspaceStrategy)) ||
      !["humanApproval", "autoCommit"].includes(String(commitPolicy)) ||
      (workspaceStrategy === "isolatedWorktree" && commitPolicy === "autoCommit") ||
      typeof worktreeBase !== "string" || !queue ||
      !Number.isInteger(queue.scanIntervalMs) || queue.scanIntervalMs < 1000 || queue.scanIntervalMs > 60000 ||
      !Number.isInteger(queue.maxWorkspaces) || queue.maxWorkspaces < 1 || queue.maxWorkspaces > 32 ||
      !Number.isSafeInteger(queue.maxWorkspaceBytes) || queue.maxWorkspaceBytes < 1) {
    throw new Error("Invalid queue/workspace policy; isolatedWorktree + autoCommit is unsupported");
  }
  return { workspaceStrategy, commitPolicy, worktreeBase, queue } as QueuePolicy;
}
