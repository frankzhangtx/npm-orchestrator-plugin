import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import test from "node:test";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));
const opencodeTemplateRoot = join(templatesRoot, ".opencode");

const expectedHashes = new Map([
  [
    ".opencode/agents/scheduled-coder.md",
    "0ddbae54fea9763fa04003ec2e5b08f658334f8b5d1555bcbcf4302db721a90f",
  ],
  [
    ".opencode/agents/scheduled-planner.md",
    "9745066a5d40b80e310f6edfb9c628457871c82eb3a12aa37dd8d952200993a1",
  ],
  [
    ".opencode/agents/scheduled-reviewer.md",
    "47f3f83eab2d7d96b483f34f90fbd2847f9d5d67c4b9d382f5273ea740a3f7ca",
  ],
  [
    ".opencode/commands/abort-task.md",
    "d35ebe358916280e151fad06de290be02b35785472396bc8d46a4af29b0ce1f7",
  ],
  [
    ".opencode/commands/acceptance.md",
    "b910108e63244eaa9dfcfe859ea7e8127ff21e808eb9fbed4fc439db2add573f",
  ],
  [
    ".opencode/commands/change.md",
    "096bf0487e64b0a2bf79d4845e67e4d6f54a06c1dc147693a12a0249df7ff3b2",
  ],
  [
    ".opencode/commands/resume-review.md",
    "f2b9cd32bbcd545e26dd2510640b243b1af7977fd3a617093c722624d7342e14",
  ],
  [
    ".opencode/commands/resume-task.md",
    "9f32fb95b13081ea18a5af4e07ec97a595b6b56292ef282fb3c9231554d41a7b",
  ],
  [
    ".opencode/skills/scheduled-quality-coder/SKILL.md",
    "79a212f551af2181fd922ea05573d38ad7fd9281a21b3db56ef9b51501884b16",
  ],
  [
    ".opencode/skills/scheduled-quality-orchestrator/SKILL.md",
    "96003e23977dea7fe39bc769f1bf8863224c9cf8831d842abfa2c4e6ddb6fe5c",
  ],
  [
    ".opencode/skills/scheduled-quality-reviewer/SKILL.md",
    "7657ad3cf1d1a8b1ad557b94f4ee4c2701dc2a51d49b80cc59a4dd8354a81c80",
  ],
]);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function templatePath(path) {
  return relative(templatesRoot, path).split(sep).join("/");
}

test("ships the exact audited OpenCode queue agent, command, and skill inventory", () => {
  const actualPaths = listFiles(opencodeTemplateRoot)
    .map(templatePath)
    .sort();

  assert.deepEqual(actualPaths, [...expectedHashes.keys()].sort());
});

test("preserves the audited queue template bytes and non-executable modes", () => {
  for (const [path, expectedHash] of expectedHashes) {
    const absolutePath = join(templatesRoot, path);
    const contents = readFileSync(absolutePath);
    const actualHash = createHash("sha256").update(contents).digest("hex");

    assert.equal(actualHash, expectedHash, path);
    assert.equal(statSync(absolutePath).mode & 0o111, 0, path);
  }
});

test("keeps migrated templates project-independent and structurally valid", () => {
  for (const path of expectedHashes.keys()) {
    const contents = readFileSync(join(templatesRoot, path), "utf8");

    assert.match(contents, /^---\n(?:.|\n)+?\n---\n/, path);
    assert.doesNotMatch(contents, /\/Users\/|zhanglong|cctest/i, path);
    assert.doesNotMatch(contents, /\.git\/automation-runtime/, path);
  }

  for (const path of [
    ".opencode/agents/scheduled-coder.md",
    ".opencode/agents/scheduled-reviewer.md",
    ".opencode/skills/scheduled-quality-coder/SKILL.md",
    ".opencode/skills/scheduled-quality-reviewer/SKILL.md",
  ]) {
    const contents = readFileSync(join(templatesRoot, path), "utf8");
    assert.match(contents, /runtime\.effectiveWorktreeAllowlist/, path);
  }
});

test("grants every scheduled agent only the two read-only orchestrator tools", () => {
  for (const agent of [
    "scheduled-coder.md",
    "scheduled-planner.md",
    "scheduled-reviewer.md",
  ]) {
    const contents = readFileSync(
      join(opencodeTemplateRoot, "agents", agent),
      "utf8",
    );
    assert.match(contents, /permission:\n  "\*": deny\n/, agent);
    assert.match(contents, /  android_orchestrator_status: allow\n/, agent);
    assert.match(contents, /  android_orchestrator_doctor: allow\n/, agent);
    assert.equal(
      (contents.match(/android_orchestrator_status/g) ?? []).length,
      1,
      agent,
    );
    assert.equal(
      (contents.match(/android_orchestrator_doctor/g) ?? []).length,
      1,
      agent,
    );
  }
});
