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
    "ff76cddd22aaf5974c7a2b88bb75a4ffce67eb8ab0fdce79f781a7e7d8203d45",
  ],
  [
    ".opencode/agents/scheduled-planner.md",
    "2e70352abee6c4cc6ce15d80dba5a1f4ecf450de49f31834f6de0ee3342e2577",
  ],
  [
    ".opencode/agents/scheduled-reviewer.md",
    "a681c0d0c7ee34a039ed7ff28c962c04e0818237e554f5ddf61b7ae447fa5f49",
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
    "a1c81a3bdc00d59e2e57f9571bc50fc8a5c28665c30a55b42a73c615c4e693f0",
  ],
  [
    ".opencode/skills/scheduled-quality-orchestrator/SKILL.md",
    "3a25a4a65d23c5957aa017331533d844b14a77751cc25dc579b9e8622612d0ec",
  ],
  [
    ".opencode/skills/scheduled-quality-reviewer/SKILL.md",
    "3f7ac69ac393ba484d9c39ebd7693cc13892182d36e9c28deb9ebbbb0b6c9750",
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
