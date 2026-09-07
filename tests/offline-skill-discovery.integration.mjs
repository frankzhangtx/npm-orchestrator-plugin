import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const expectedSkillIds = [
  "android-orchestrator-brainstorming",
  "android-orchestrator-systematic-debugging",
  "android-orchestrator-test-driven-development",
  "android-orchestrator-verification-before-completion",
  "android-orchestrator-writing-plans",
];

test("OpenCode discovers all bundled skills without an external plugin or network", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-offline-discovery-"));
  try {
    const pluginDirectory = join(root, ".opencode", "plugins");
    const configDirectory = join(root, "config");
    const dataDirectory = join(root, "data");
    const stateDirectory = join(root, "state");
    for (const directory of [
      pluginDirectory,
      configDirectory,
      dataDirectory,
      stateDirectory,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    symlinkSync(
      resolve("dist/opencode-plugin.js"),
      join(pluginDirectory, "orchestrator.js"),
    );

    const result = spawnSync("opencode", ["debug", "skill"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: configDirectory,
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        XDG_DATA_HOME: dataDirectory,
        XDG_STATE_HOME: stateDirectory,
      },
      timeout: 120_000,
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const discovered = JSON.parse(result.stdout);
    const bundled = discovered
      .filter(({ name }) => name.startsWith("android-orchestrator-"))
      .map(({ name }) => name)
      .sort();
    assert.deepEqual(bundled, expectedSkillIds);
    for (const skill of discovered.filter(({ name }) =>
      name.startsWith("android-orchestrator-"),
    )) {
      assert.match(skill.location, /resources\/third-party\/superpowers-v6\.2\.0\/skills/);
    }
    assert.equal(
      discovered.some(({ name }) =>
        [
          "using-superpowers",
          "brainstorming",
          "writing-plans",
          "test-driven-development",
          "systematic-debugging",
          "verification-before-completion",
        ].includes(name),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
