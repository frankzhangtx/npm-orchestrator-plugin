import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const resourceRoot = "resources/third-party/superpowers-v6.2.0";
const expectedResourcePaths = [
  `${resourceRoot}/LICENSE`,
  `${resourceRoot}/PROVENANCE.md`,
  `${resourceRoot}/skills/android-orchestrator-brainstorming/SKILL.md`,
  `${resourceRoot}/skills/android-orchestrator-systematic-debugging/references/condition-based-waiting-example.ts`,
  `${resourceRoot}/skills/android-orchestrator-systematic-debugging/references/condition-based-waiting.md`,
  `${resourceRoot}/skills/android-orchestrator-systematic-debugging/references/defense-in-depth.md`,
  `${resourceRoot}/skills/android-orchestrator-systematic-debugging/references/root-cause-tracing.md`,
  `${resourceRoot}/skills/android-orchestrator-systematic-debugging/scripts/find-polluter.sh`,
  `${resourceRoot}/skills/android-orchestrator-systematic-debugging/SKILL.md`,
  `${resourceRoot}/skills/android-orchestrator-test-driven-development/references/writing-good-tests.md`,
  `${resourceRoot}/skills/android-orchestrator-test-driven-development/SKILL.md`,
  `${resourceRoot}/skills/android-orchestrator-verification-before-completion/SKILL.md`,
  `${resourceRoot}/skills/android-orchestrator-writing-plans/SKILL.md`,
].sort();

test("packs the complete minimal bundled workflow skill inventory", () => {
  const cacheDirectory = mkdtempSync(
    join(tmpdir(), "orchestrator-pack-cache-"),
  );
  try {
    const result = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: cacheDirectory },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const records = JSON.parse(result.stdout);
    assert.equal(records.length, 1);
    const files = records[0].files;
    const resourceFiles = files
      .map(({ path }) => path)
      .filter((path) => path.startsWith(`${resourceRoot}/`))
      .sort();

    assert.deepEqual(resourceFiles, expectedResourcePaths);
    assert.equal(
      files.find(
        ({ path }) =>
          path ===
          `${resourceRoot}/skills/android-orchestrator-systematic-debugging/scripts/find-polluter.sh`,
      ).mode & 0o111,
      0o111,
    );
    assert.equal(
      resourceFiles.some((path) =>
        /server\.cjs|brainstorm-server|visual-companion|\.(?:png|svg)$/i.test(path),
      ),
      false,
    );
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});
