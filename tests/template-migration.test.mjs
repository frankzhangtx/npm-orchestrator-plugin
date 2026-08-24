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
    "9baa967ee91ace5c3f217dae5efdbc931eb2220a0bd0568c372f86ceb0b1a6c2",
  ],
  [
    ".opencode/agents/scheduled-planner.md",
    "1296184096eff58420f83d16f6293eaa62309fea1e9e96fa7568fd69eb929f92",
  ],
  [
    ".opencode/agents/scheduled-reviewer.md",
    "252f473080b050f58401717586f5097973c7a47b9335173c9d4a88589738098c",
  ],
  [
    ".opencode/commands/abort-task.md",
    "c7fcd3b08d30526d9311c8dba47787d6354ae677522d55f360ecaa3e4556f212",
  ],
  [
    ".opencode/commands/acceptance.md",
    "43db19cb558fc73f69184cc0c75914009512c745cd726af4bd939e97e057f749",
  ],
  [
    ".opencode/commands/change.md",
    "23b576d5f1556829bc3e666599e4bbd0fcd8dd383bec4022e3e76c26ada93e79",
  ],
  [
    ".opencode/commands/resume-review.md",
    "be85c63d766785f77f0d03ce31761999efd3bde8eb74cdcfcaa99d05ba177bd8",
  ],
  [
    ".opencode/skills/scheduled-quality-coder/SKILL.md",
    "d88438c0fdff50918ee3ab130751134b0018d2caa84578836de5e8b5904bfb4f",
  ],
  [
    ".opencode/skills/scheduled-quality-orchestrator/SKILL.md",
    "3a25a4a65d23c5957aa017331533d844b14a77751cc25dc579b9e8622612d0ec",
  ],
  [
    ".opencode/skills/scheduled-quality-reviewer/SKILL.md",
    "53e7a92b663a5245f3f860a781a48fbfe84cb3376329edba64ff8e888a6dba95",
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

test("ships the exact audited OpenCode V3 agent, command, and skill inventory", () => {
  const actualPaths = listFiles(opencodeTemplateRoot)
    .map(templatePath)
    .sort();

  assert.deepEqual(actualPaths, [...expectedHashes.keys()].sort());
});

test("preserves the audited V3 template bytes and non-executable modes", () => {
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
});
