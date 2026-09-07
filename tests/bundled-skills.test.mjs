import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const resourceRoot = fileURLToPath(
  new URL(
    "../resources/third-party/superpowers-v6.2.0/",
    import.meta.url,
  ),
);
const skillsRoot = join(resourceRoot, "skills");
const expectedSkills = [
  "android-orchestrator-brainstorming",
  "android-orchestrator-systematic-debugging",
  "android-orchestrator-test-driven-development",
  "android-orchestrator-verification-before-completion",
  "android-orchestrator-writing-plans",
];

test("ships the complete namespaced bundled skill inventory", () => {
  assert.deepEqual(
    readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    expectedSkills,
  );

  for (const skill of expectedSkills) {
    const entrypoint = join(skillsRoot, skill, "SKILL.md");
    const content = readFileSync(entrypoint, "utf8");
    assert.match(content, new RegExp(`^---\\nname: ${skill}\\n`), skill);
    assert.match(content, /\nlicense: MIT\n/, skill);
    assert.match(content, /\ncompatibility: opencode\n/, skill);
    assert.doesNotMatch(content, /superpowers:(?:using-|brainstorming|writing-|test-|systematic-|verification-)/i, skill);
  }
});

test("keeps only the runtime support files referenced by bundled skills", () => {
  for (const relativePath of [
    "android-orchestrator-test-driven-development/references/writing-good-tests.md",
    "android-orchestrator-systematic-debugging/references/root-cause-tracing.md",
    "android-orchestrator-systematic-debugging/references/defense-in-depth.md",
    "android-orchestrator-systematic-debugging/references/condition-based-waiting.md",
    "android-orchestrator-systematic-debugging/references/condition-based-waiting-example.ts",
    "android-orchestrator-systematic-debugging/scripts/find-polluter.sh",
  ]) {
    assert.equal(existsSync(join(skillsRoot, relativePath)), true, relativePath);
  }
  assert.notEqual(
    statSync(
      join(
        skillsRoot,
        "android-orchestrator-systematic-debugging/scripts/find-polluter.sh",
      ),
    ).mode & 0o111,
    0,
  );
});

test("does not bundle the visual companion or any external runtime reference", () => {
  const brainstormingFiles = readdirSync(
    join(skillsRoot, "android-orchestrator-brainstorming"),
  );
  assert.deepEqual(brainstormingFiles, ["SKILL.md"]);

  const brainstorming = readFileSync(
    join(skillsRoot, "android-orchestrator-brainstorming/SKILL.md"),
    "utf8",
  );
  const writingPlans = readFileSync(
    join(skillsRoot, "android-orchestrator-writing-plans/SKILL.md"),
    "utf8",
  );
  assert.doesNotMatch(brainstorming, /https?:\/\/|BRAINSTORM_OPEN|server\.cjs/);
  assert.doesNotMatch(
    writingPlans,
    /superpowers:|subagent-driven-development|executing-plans|docs\/superpowers/i,
  );
});

test("retains the upstream MIT license and provenance", () => {
  const license = readFileSync(join(resourceRoot, "LICENSE"), "utf8");
  const provenance = readFileSync(join(resourceRoot, "PROVENANCE.md"), "utf8");
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2025 Jesse Vincent/);
  assert.match(provenance, /obra\/superpowers/);
  assert.match(provenance, /v6\.2\.0/);
});
