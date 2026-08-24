import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import plugin, {
  CERTIFIED_OPENCODE_VERSIONS,
  COMMON_HOOK_NAMES,
  ORCHESTRATOR_DIRECTORY_ENV,
  ORCHESTRATOR_WORKTREE_ENV,
  defineCompatibleHooks,
} from "../dist/index.js";

test("exports a loadable OpenCode plugin using only common hooks", async () => {
  const hooks = await plugin({
    directory: process.cwd(),
    worktree: process.cwd(),
  });

  assert.deepEqual(Object.keys(hooks), ["shell.env"]);
  assert.ok(COMMON_HOOK_NAMES.includes("shell.env"));
  assert.ok(Object.keys(hooks).every((name) => COMMON_HOOK_NAMES.includes(name)));

  const output = { env: {} };
  await hooks["shell.env"]({ cwd: process.cwd() }, output);

  assert.equal(output.env[ORCHESTRATOR_DIRECTORY_ENV], process.cwd());
  assert.equal(output.env[ORCHESTRATOR_WORKTREE_ENV], process.cwd());
  assert.deepEqual(CERTIFIED_OPENCODE_VERSIONS, ["1.14.22", "1.15.13"]);
});

test("rejects hooks outside the certified common API", () => {
  assert.throws(
    () => defineCompatibleHooks({ dispose: async () => {} }),
    /Unsupported OpenCode hook\(s\): dispose/,
  );
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

test("CLI exposes doctor-specific help", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/cli.js", "doctor", "--help"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /doctor \[directory\] \[--json\]/);
});

test("CLI exposes init options and rejects an incomplete module selection", () => {
  const help = spawnSync(
    process.execPath,
    ["dist/cli.js", "init", "--help"],
    { encoding: "utf8" },
  );

  assert.equal(help.status, 0);
  assert.match(help.stdout, /init \[directory\]/);
  assert.match(help.stdout, /--primary-module <gradle-path>/);
  assert.match(help.stdout, /--json/);

  const invalid = spawnSync(
    process.execPath,
    ["dist/cli.js", "init", "--primary-module"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unexpected init argument/);
});

test("CLI exposes upgrade options and rejects an incomplete module selection", () => {
  const help = spawnSync(
    process.execPath,
    ["dist/cli.js", "upgrade", "--help"],
    { encoding: "utf8" },
  );

  assert.equal(help.status, 0);
  assert.match(help.stdout, /upgrade \[directory\]/);
  assert.match(help.stdout, /--primary-module <gradle-path>/);
  assert.match(help.stdout, /--json/);

  const invalid = spawnSync(
    process.execPath,
    ["dist/cli.js", "upgrade", "--primary-module"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unexpected upgrade argument/);
});
