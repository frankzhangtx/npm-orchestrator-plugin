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
    "d55303927ee5bbb2fc73f90930b36368a0893473fb072916f0f2052e50135807",
  ],
  [
    ".opencode/agents/scheduled-reviewer.md",
    "47f3f83eab2d7d96b483f34f90fbd2847f9d5d67c4b9d382f5273ea740a3f7ca",
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
    ".opencode/commands/resume-task.md",
    "524108e44dc7384cffd3333c29a42b4de139f76a927faca795158cd2ea6f7834",
  ],
  [
    ".opencode/skills/scheduled-quality-coder/SKILL.md",
    "79a212f551af2181fd922ea05573d38ad7fd9281a21b3db56ef9b51501884b16",
  ],
  [
    ".opencode/skills/scheduled-quality-orchestrator/SKILL.md",
    "649a5b34e5cffa390456e755f4e6723498c1ea4b625dd50e7dc1e5ada239790d",
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

test("ships the exact audited OpenCode V4 agent, command, and skill inventory", () => {
  const actualPaths = listFiles(opencodeTemplateRoot)
    .map(templatePath)
    .sort();

  assert.deepEqual(actualPaths, [...expectedHashes.keys()].sort());
});

test("preserves the audited V4 template bytes and non-executable modes", () => {
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
