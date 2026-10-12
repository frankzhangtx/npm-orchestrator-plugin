"use strict";
const { spawnSync } = require("node:child_process");
const PREFIX = "automation/automation-commit-prefix";
function exempt(path, allowlist = []) {
  return path === PREFIX || path === ".automation-worktree-allowlist" || allowlist.includes(path);
}
function changes(root, allowlist = []) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.error || result.status !== 0) throw new Error(`WORKTREE_CHECK_FAILED: git status exit=${result.status} signal=${result.signal}: ${result.error?.message || result.stderr?.trim() || "no diagnostic output"}`);
  const records = result.stdout.split("\0");
  if (records.pop() !== "") throw new Error("WORKTREE_CHECK_FAILED: incomplete Git status");
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i], status = record.slice(0, 2), path = record.slice(3);
    if (record[2] !== " " || !path) throw new Error("WORKTREE_CHECK_FAILED: malformed Git status");
    if (!exempt(path, allowlist)) paths.push({ path, status });
    if (/[RC]/.test(status)) {
      const source = records[++i];
      if (!source) throw new Error("WORKTREE_CHECK_FAILED: missing rename source");
      if (!exempt(source, allowlist)) paths.push({ path: source, status, destination: path });
    }
  }
  return paths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
module.exports = { PREFIX, exempt, changes };
if (require.main === module) {
  try {
    const rows = changes(process.argv[2], JSON.parse(process.argv[3] || "[]"));
    if (rows.length) {
      console.error(`WORKTREE_DIRTY: ${rows.length} changed paths; review and resolve before starting. ${JSON.stringify(rows.slice(0, 20))}`);
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
