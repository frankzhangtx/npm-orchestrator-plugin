import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import plugin, {
  CERTIFIED_OPENCODE_VERSIONS,
} from "../dist/index.js";

test("exports a loadable no-op OpenCode plugin entry", async () => {
  const hooks = await plugin({
    directory: process.cwd(),
    worktree: process.cwd(),
  });

  assert.deepEqual(hooks, {});
  assert.deepEqual(CERTIFIED_OPENCODE_VERSIONS, ["1.14.22", "1.15.13"]);
});

test("CLI exposes the planned lifecycle commands", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /upgrade/);
  assert.match(result.stdout, /uninstall/);
});
