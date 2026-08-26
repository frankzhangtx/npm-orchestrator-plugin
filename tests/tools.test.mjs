import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ORCHESTRATOR_DOCTOR_TOOL_NAME,
  ORCHESTRATOR_STATUS_TOOL_NAME,
  READ_ONLY_TOOL_NAMES,
  ReadOnlyToolError,
  createReadOnlyTools,
} from "../dist/index.js";

function createContext(worktree, directory = worktree) {
  const metadata = [];
  const controller = new AbortController();
  return {
    context: {
      sessionID: "session-001",
      messageID: "message-001",
      agent: "scheduled-planner",
      directory,
      worktree,
      abort: controller.signal,
      metadata(value) {
        metadata.push(value);
      },
      ask() {
        throw new Error("read-only tools must not request permissions");
      },
    },
    controller,
    metadata,
  };
}

function passingInstallationChecks() {
  return [
    "installation-manifest",
    "managed-resources",
    "managed-permissions",
  ].map((id) => ({
    id,
    label: id,
    status: "pass",
    summary: `${id} passed`,
    details: [],
  }));
}

async function withTemporaryWorktree(run) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-tools-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("registers exactly the two read-only tools with a strict task ID schema", async () => {
  await withTemporaryWorktree((root) => {
    const tools = createReadOnlyTools({ directory: root, worktree: root });

    assert.deepEqual(Object.keys(tools), [...READ_ONLY_TOOL_NAMES]);
    assert.equal(
      tools[ORCHESTRATOR_STATUS_TOOL_NAME].args.taskId.safeParse(
        "TASK-TOOLS-001",
      ).success,
      true,
    );
    assert.equal(
      tools[ORCHESTRATOR_STATUS_TOOL_NAME].args.taskId.safeParse(
        "TASK-TOOLS-001; touch escaped",
      ).success,
      false,
    );
    assert.deepEqual(
      Object.keys(tools[ORCHESTRATOR_DOCTOR_TOOL_NAME].args),
      [],
    );
  });
});

test("doctor is bounded to the loaded worktree and returns structured read-only diagnostics", async () => {
  await withTemporaryWorktree(async (root) => {
    const moduleDirectory = join(root, "clients", "mobile");
    mkdirSync(moduleDirectory, { recursive: true });
    let receivedOptions;
    const tools = createReadOnlyTools({
      directory: moduleDirectory,
      worktree: root,
      doctorRunner(options) {
        receivedOptions = options;
        return {
          ok: false,
          checks: [
            {
              id: "fixture-check",
              label: "Fixture check",
              status: "fail",
              summary: "Fixture failure",
              details: [],
            },
          ],
        };
      },
    });
    const { context, metadata } = createContext(root, moduleDirectory);

    const result = await tools[ORCHESTRATOR_DOCTOR_TOOL_NAME].execute(
      {},
      context,
    );

    assert.deepEqual(receivedOptions, {
      checkDependencies: true,
      checkInstallation: true,
      targetDirectory: resolve(moduleDirectory),
    });
    assert.deepEqual(JSON.parse(result.output), {
      ok: false,
      checks: [
        {
          id: "fixture-check",
          label: "Fixture check",
          status: "fail",
          summary: "Fixture failure",
          details: [],
        },
      ],
    });
    assert.deepEqual(result.metadata, {
      readOnly: true,
      ok: false,
      targetDirectory: resolve(moduleDirectory),
    });
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].metadata.readOnly, true);
  });
});

test("status authenticates its installation and invokes only the fixed script for one task", async () => {
  await withTemporaryWorktree(async (root) => {
    let receivedInput;
    const tools = createReadOnlyTools({
      directory: root,
      worktree: root,
      installationCheckRunner: passingInstallationChecks,
      async statusRunner(input) {
        receivedInput = input;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            contract: { id: "TASK-TOOLS-001", title: "Fixture" },
            state: { status: "PENDING" },
          }),
          stderr: "",
        };
      },
    });
    const { context, metadata } = createContext(root);

    const result = await tools[ORCHESTRATOR_STATUS_TOOL_NAME].execute(
      { taskId: "TASK-TOOLS-001" },
      context,
    );

    assert.deepEqual(receivedInput, {
      scriptPath: join(root, "scripts/automation/status.sh"),
      targetDirectory: root,
      taskId: "TASK-TOOLS-001",
    });
    assert.equal(JSON.parse(result.output).contract.id, "TASK-TOOLS-001");
    assert.deepEqual(result.metadata, {
      readOnly: true,
      taskId: "TASK-TOOLS-001",
    });
    assert.equal(metadata[0].metadata.taskId, "TASK-TOOLS-001");
  });
});

test("status passes the script path and task ID as separate shell expressions", async () => {
  await withTemporaryWorktree(async (root) => {
    const calls = [];
    const shell = (strings, ...expressions) => {
      const promise = Promise.resolve({
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({ contract: { id: "TASK-SHELL-001" } }),
        ),
        stderr: Buffer.from(""),
      });
      promise.cwd = (directory) => {
        calls.push({ type: "cwd", directory });
        return promise;
      };
      promise.quiet = () => {
        calls.push({ type: "quiet" });
        return promise;
      };
      promise.nothrow = () => {
        calls.push({ type: "nothrow" });
        return promise;
      };
      calls.push({ type: "command", strings: [...strings], expressions });
      return promise;
    };
    const tools = createReadOnlyTools({
      directory: root,
      worktree: root,
      shell,
      installationCheckRunner: passingInstallationChecks,
    });

    await tools[ORCHESTRATOR_STATUS_TOOL_NAME].execute(
      { taskId: "TASK-SHELL-001" },
      createContext(root).context,
    );

    assert.deepEqual(calls[0], {
      type: "command",
      strings: ["", " ", ""],
      expressions: [
        join(root, "scripts/automation/status.sh"),
        "TASK-SHELL-001",
      ],
    });
    assert.deepEqual(calls.slice(1), [
      { type: "cwd", directory: root },
      { type: "quiet" },
      { type: "nothrow" },
    ]);
  });
});

test("status rejects invalid task IDs before integrity checks or command execution", async () => {
  await withTemporaryWorktree(async (root) => {
    let checksCalled = false;
    let commandCalled = false;
    const tools = createReadOnlyTools({
      directory: root,
      worktree: root,
      installationCheckRunner() {
        checksCalled = true;
        return passingInstallationChecks();
      },
      async statusRunner() {
        commandCalled = true;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await assert.rejects(
      tools[ORCHESTRATOR_STATUS_TOOL_NAME].execute(
        { taskId: "TASK-OK; touch escaped" },
        createContext(root).context,
      ),
      (error) => {
        assert.ok(error instanceof ReadOnlyToolError);
        assert.equal(error.code, "INVALID_TASK_ID");
        return true;
      },
    );
    assert.equal(checksCalled, false);
    assert.equal(commandCalled, false);
  });
});

test("status fails closed on an unauthenticated installation without changing the worktree", async () => {
  await withTemporaryWorktree(async (root) => {
    const before = readdirSync(root);
    let commandCalled = false;
    const tools = createReadOnlyTools({
      directory: root,
      worktree: root,
      async statusRunner() {
        commandCalled = true;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await assert.rejects(
      tools[ORCHESTRATOR_STATUS_TOOL_NAME].execute(
        { taskId: "TASK-TOOLS-002" },
        createContext(root).context,
      ),
      (error) => {
        assert.ok(error instanceof ReadOnlyToolError);
        assert.equal(error.code, "UNTRUSTED_INSTALLATION");
        assert.match(error.details.join("\n"), /installation-manifest/);
        return true;
      },
    );
    assert.equal(commandCalled, false);
    assert.deepEqual(readdirSync(root), before);
  });
});

test("read-only tools reject contexts outside the workspace or aborted before execution", async () => {
  await withTemporaryWorktree(async (root) => {
    const tools = createReadOnlyTools({
      directory: root,
      worktree: root,
      doctorRunner() {
        throw new Error("doctor runner must not be reached");
      },
    });
    const outside = createContext(join(root, "other"), join(root, "other"));
    await assert.rejects(
      tools[ORCHESTRATOR_DOCTOR_TOOL_NAME].execute({}, outside.context),
      (error) => error instanceof ReadOnlyToolError && error.code === "WORKSPACE_MISMATCH",
    );

    const aborted = createContext(root);
    aborted.controller.abort();
    await assert.rejects(
      tools[ORCHESTRATOR_DOCTOR_TOOL_NAME].execute({}, aborted.context),
      (error) => error instanceof ReadOnlyToolError && error.code === "TOOL_ABORTED",
    );
  });
});

test("status rejects failed commands, malformed task output, and oversized output", async (t) => {
  const cases = [
    {
      name: "failed command",
      result: { exitCode: 7, stdout: "", stderr: "fixture failure" },
      code: "STATUS_COMMAND_FAILED",
    },
    {
      name: "malformed JSON",
      result: { exitCode: 0, stdout: "not json", stderr: "" },
      code: "INVALID_STATUS_OUTPUT",
    },
    {
      name: "wrong contract",
      result: {
        exitCode: 0,
        stdout: JSON.stringify({ contract: { id: "TASK-OTHER-001" } }),
        stderr: "",
      },
      code: "INVALID_STATUS_OUTPUT",
    },
    {
      name: "oversized JSON",
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          contract: { id: "TASK-TOOLS-003" },
          padding: "x".repeat(1024 * 1024),
        }),
        stderr: "",
      },
      code: "STATUS_OUTPUT_TOO_LARGE",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withTemporaryWorktree(async (root) => {
        const tools = createReadOnlyTools({
          directory: root,
          worktree: root,
          installationCheckRunner: passingInstallationChecks,
          async statusRunner() {
            return fixture.result;
          },
        });

        await assert.rejects(
          tools[ORCHESTRATOR_STATUS_TOOL_NAME].execute(
            { taskId: "TASK-TOOLS-003" },
            createContext(root).context,
          ),
          (error) =>
            error instanceof ReadOnlyToolError && error.code === fixture.code,
        );
      });
    });
  }
});
