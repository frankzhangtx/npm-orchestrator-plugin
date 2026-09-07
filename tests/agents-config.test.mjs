import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENTS_MANAGED_BLOCK_BEGIN,
  AGENTS_MANAGED_BLOCK_END,
  AgentsConfigMergeError,
  mergeAgentsConfigForUpgradeText,
  mergeAgentsConfigText,
  planAgentsConfigMerge,
} from "../dist/index.js";

function withTemporaryDirectory(prefix, operation) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertAgentsError(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof AgentsConfigMergeError);
    assert.equal(error.code, code);
    return true;
  });
}

test("plans a new AGENTS managed block without writing", () => {
  withTemporaryDirectory("orchestrator-agents-new-", (directory) => {
    const plan = planAgentsConfigMerge(directory);

    assert.equal(plan.targetDirectory, directory);
    assert.equal(plan.agentsPath, join(directory, "AGENTS.md"));
    assert.equal(plan.existed, false);
    assert.equal(plan.originalContent, "");
    assert.equal(plan.changed, true);
    assert.ok(plan.content.startsWith(`${AGENTS_MANAGED_BLOCK_BEGIN}\n`));
    assert.ok(plan.content.endsWith(`${AGENTS_MANAGED_BLOCK_END}\n`));
    assert.equal(existsSync(plan.agentsPath), false);
  });
});

test("appends one CRLF managed block and is byte-idempotent", () => {
  withTemporaryDirectory("orchestrator-agents-crlf-", (directory) => {
    const agentsPath = join(directory, "AGENTS.md");
    const original = "# Existing rules\r\n\r\nKeep this text.\r\n";
    writeFileSync(agentsPath, original);

    const plan = planAgentsConfigMerge(directory);

    assert.equal(plan.originalContent, original);
    assert.equal(plan.changed, true);
    assert.ok(plan.content.startsWith(original + "\r\n"));
    assert.equal(plan.content.replaceAll("\r\n", "").includes("\n"), false);
    assert.equal(
      plan.content.match(new RegExp(AGENTS_MANAGED_BLOCK_BEGIN, "g"))?.length,
      1,
    );
    assert.equal(readFileSync(agentsPath, "utf8"), original);

    writeFileSync(agentsPath, plan.content);
    const repeated = planAgentsConfigMerge(directory);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.content, plan.content);
  });
});

test("refuses a modified or malformed managed block", () => {
  withTemporaryDirectory("orchestrator-agents-conflict-", (directory) => {
    const agentsPath = join(directory, "AGENTS.md");
    writeFileSync(
      agentsPath,
      `${AGENTS_MANAGED_BLOCK_BEGIN}\nuser changed this block\n${AGENTS_MANAGED_BLOCK_END}\n`,
    );
    assertAgentsError("AGENTS_BLOCK_CONFLICT", () =>
      planAgentsConfigMerge(directory),
    );

    writeFileSync(agentsPath, `${AGENTS_MANAGED_BLOCK_BEGIN}\npartial\n`);
    assertAgentsError("AGENTS_MARKERS_INVALID", () =>
      planAgentsConfigMerge(directory),
    );
  });
});

test("upgrade preserves user AGENTS changes outside the managed block", () => {
  const original = "# Existing rules\n\nKeep this text.\n";
  const userContent =
    "# Existing rules\n\nKeep this text.\n\nUse the company review gate.\n";
  const installed = mergeAgentsConfigText(original);
  const legacy = installed.replace(
    "## OpenCode Android Orchestrator",
    "## OpenCode Android Orchestrator Legacy",
  );
  const changed = legacy.replace(original, userContent);
  const userOwnedOutside = `${userContent}\n`;

  const merged = mergeAgentsConfigForUpgradeText(changed, original);

  assert.equal(merged.previousContent, userOwnedOutside);
  assert.equal(merged.content, mergeAgentsConfigText(userOwnedOutside));
  assert.doesNotMatch(merged.content, /Orchestrator Legacy/);
  assert.equal(
    merged.content.match(new RegExp(AGENTS_MANAGED_BLOCK_BEGIN, "g"))?.length,
    1,
  );
  assert.equal(
    merged.content.match(new RegExp(AGENTS_MANAGED_BLOCK_END, "g"))?.length,
    1,
  );
});

test("upgrade adopts an AGENTS file whose managed markers were removed", () => {
  const current = "# Company rules\n\nUse the internal review gate.\n";

  const merged = mergeAgentsConfigForUpgradeText(
    current,
    "# Rules before installation\n",
  );

  assert.equal(merged.previousContent, current);
  assert.equal(merged.content, mergeAgentsConfigText(current));
});

test("upgrade refuses malformed or duplicate AGENTS markers", () => {
  assertAgentsError("AGENTS_MARKERS_INVALID", () =>
    mergeAgentsConfigForUpgradeText(
      `${AGENTS_MANAGED_BLOCK_BEGIN}\npartial\n`,
      null,
    ),
  );
  assertAgentsError("AGENTS_MARKERS_INVALID", () =>
    mergeAgentsConfigForUpgradeText(
      `${AGENTS_MANAGED_BLOCK_BEGIN}\none\n${AGENTS_MANAGED_BLOCK_END}\n${AGENTS_MANAGED_BLOCK_BEGIN}\ntwo\n${AGENTS_MANAGED_BLOCK_END}\n`,
      null,
    ),
  );
});

test("refuses symbolic-link and non-file AGENTS targets", () => {
  withTemporaryDirectory("orchestrator-agents-path-", (directory) => {
    const outside = join(directory, "outside.md");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(directory, "AGENTS.md"));
    assertAgentsError("AGENTS_SYMLINK", () =>
      planAgentsConfigMerge(directory),
    );
  });

  withTemporaryDirectory("orchestrator-agents-directory-", (directory) => {
    mkdirSync(join(directory, "AGENTS.md"));
    assertAgentsError("AGENTS_NOT_FILE", () =>
      planAgentsConfigMerge(directory),
    );
  });
});
