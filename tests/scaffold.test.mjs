import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin, {
  CERTIFIED_OPENCODE_VERSIONS,
  COMMON_HOOK_NAMES,
  DEFAULT_LONG_COMMAND_TIMEOUT_MS,
  ORCHESTRATOR_DIRECTORY_ENV,
  ORCHESTRATOR_DOCTOR_TOOL_NAME,
  ORCHESTRATOR_STATUS_TOOL_NAME,
  ORCHESTRATOR_WORKTREE_ENV,
  defineCompatibleHooks,
} from "../dist/index.js";

test("keeps the package root plugin-only for the OpenCode loader", async () => {
  const entry = await import(
    "@frankzhang2026/opencode-android-orchestrator"
  );
  const api = await import(
    "@frankzhang2026/opencode-android-orchestrator/api"
  );

  assert.deepEqual(Object.keys(entry), ["default"]);
  assert.equal(typeof entry.default, "function");
  assert.equal(typeof api.runDoctor, "function");
  assert.equal(typeof api.runProjectInitialization, "function");
});

test("exports a loadable OpenCode plugin using only common hooks", async () => {
  const hooks = await plugin({
    directory: process.cwd(),
    worktree: process.cwd(),
    $: () => {
      throw new Error("status shell should not run during plugin loading");
    },
  });

  assert.deepEqual(Object.keys(hooks), [
    "tool",
    "shell.env",
    "tool.execute.before",
  ]);
  assert.deepEqual(Object.keys(hooks.tool), [
    ORCHESTRATOR_STATUS_TOOL_NAME,
    ORCHESTRATOR_DOCTOR_TOOL_NAME,
  ]);
  assert.ok(COMMON_HOOK_NAMES.includes("tool"));
  assert.ok(COMMON_HOOK_NAMES.includes("shell.env"));
  assert.ok(Object.keys(hooks).every((name) => COMMON_HOOK_NAMES.includes(name)));

  const output = { env: {} };
  await hooks["shell.env"]({ cwd: process.cwd() }, output);

  assert.equal(output.env[ORCHESTRATOR_DIRECTORY_ENV], process.cwd());
  assert.equal(output.env[ORCHESTRATOR_WORKTREE_ENV], process.cwd());
  assert.deepEqual(CERTIFIED_OPENCODE_VERSIONS, ["1.14.22", "1.15.13"]);
});

test("raises managed long commands to the default timeout without shortening callers", async () => {
  const hooks = await plugin({
    directory: process.cwd(),
    worktree: process.cwd(),
    $: () => {
      throw new Error("shell should not run while applying a tool hook");
    },
  });
  const before = hooks["tool.execute.before"];
  assert.equal(typeof before, "function");

  const defaultArgs = {
    command: "./scripts/automation/claim-task.sh TASK-EXAMPLE-001",
    timeout: 120_000,
  };
  await before(
    { tool: "bash", sessionID: "session", callID: "call" },
    { args: defaultArgs },
  );
  assert.equal(defaultArgs.timeout, DEFAULT_LONG_COMMAND_TIMEOUT_MS);

  const higherArgs = {
    command: "./scripts/automation/approve-and-run.sh TASK-EXAMPLE-001 token",
    timeout: 3_600_000,
  };
  await before(
    { tool: "bash", sessionID: "session", callID: "call" },
    { args: higherArgs },
  );
  assert.equal(higherArgs.timeout, 3_600_000);

  const unrelatedArgs = { command: "./gradlew testDebugUnitTest", timeout: 1 };
  await before(
    { tool: "bash", sessionID: "session", callID: "call" },
    { args: unrelatedArgs },
  );
  assert.equal(unrelatedArgs.timeout, 1);
});

test("loads a configurable managed long-command timeout from the worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-timeout-"));
  try {
    mkdirSync(join(root, "automation"));
    writeFileSync(
      join(root, "automation", "config.json"),
      `${JSON.stringify({ longCommandTimeoutMs: 3_600_000 })}\n`,
    );
    const hooks = await plugin({
      directory: root,
      worktree: root,
      $: () => {
        throw new Error("shell should not run while applying a tool hook");
      },
    });
    const args = {
      command: "./scripts/automation/resume-task.sh TASK-EXAMPLE-001 token",
    };
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "session", callID: "call" },
      { args },
    );
    assert.equal(args.timeout, 3_600_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.match(help.stdout, /--module-scope <all\|primary>/);
  assert.match(help.stdout, /Default module scope: all/);
  assert.match(help.stdout, /--primary-module <gradle-path>/);
  assert.match(help.stdout, /--gradle-verification-config <json-path>/);
  assert.match(help.stdout, /--long-command-timeout-ms <milliseconds>/);
  assert.match(help.stdout, /1800000 ms \(30 minutes\)/);
  assert.match(help.stdout, /Gradle verification: auto-discovered/);
  assert.match(help.stdout, /Worktree allowlist: created automatically/);
  assert.match(help.stdout, /--json/);

  const invalid = spawnSync(
    process.execPath,
    ["dist/cli.js", "init", "--primary-module"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unexpected init argument/);

  const invalidScope = spawnSync(
    process.execPath,
    ["dist/cli.js", "init", "--module-scope", "unsupported"],
    { encoding: "utf8" },
  );
  assert.equal(invalidScope.status, 2);
  assert.match(invalidScope.stderr, /Unexpected init argument/);

  const invalidTimeout = spawnSync(
    process.execPath,
    ["dist/cli.js", "init", "--long-command-timeout-ms", "119999"],
    { encoding: "utf8" },
  );
  assert.equal(invalidTimeout.status, 2);
  assert.match(invalidTimeout.stderr, /Unexpected init argument/);
});

test("CLI exposes upgrade options and rejects an incomplete module selection", () => {
  const help = spawnSync(
    process.execPath,
    ["dist/cli.js", "upgrade", "--help"],
    { encoding: "utf8" },
  );

  assert.equal(help.status, 0);
  assert.match(help.stdout, /upgrade \[directory\]/);
  assert.match(help.stdout, /--module-scope <all\|primary>/);
  assert.match(help.stdout, /legacy installations default to primary/);
  assert.match(help.stdout, /--primary-module <gradle-path>/);
  assert.match(help.stdout, /--gradle-verification-config <json-path>/);
  assert.match(help.stdout, /--long-command-timeout-ms <milliseconds>/);
  assert.match(help.stdout, /legacy installations default to 1800000 ms/);
  assert.match(help.stdout, /--json/);

  const invalid = spawnSync(
    process.execPath,
    ["dist/cli.js", "upgrade", "--primary-module"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unexpected upgrade argument/);

  const invalidScope = spawnSync(
    process.execPath,
    ["dist/cli.js", "upgrade", "--module-scope=unsupported"],
    { encoding: "utf8" },
  );
  assert.equal(invalidScope.status, 2);
  assert.match(invalidScope.stderr, /Unexpected upgrade argument/);
});

test("CLI exposes uninstall options and rejects unknown flags", () => {
  const help = spawnSync(
    process.execPath,
    ["dist/cli.js", "uninstall", "--help"],
    { encoding: "utf8" },
  );

  assert.equal(help.status, 0);
  assert.match(help.stdout, /uninstall \[directory\] \[--json\]/);

  const invalid = spawnSync(
    process.execPath,
    ["dist/cli.js", "uninstall", "--force"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unexpected uninstall argument/);
});
