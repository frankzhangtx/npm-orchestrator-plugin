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
    "26a6b8dabb36b9af010b0fc2574f8d6f42a569536792693f13502a0b34cd6b71",
  ],
  [
    ".opencode/agents/scheduled-planner.md",
    "1da8fe50ace460aeb6cb70e942654785dbf65516a3196ac9054baf79ce35fc1a",
  ],
  [
    ".opencode/agents/scheduled-reviewer.md",
    "24fd61fe356b241c93118d7608e5b7e9addd425a842dd5bc61dd9f1936a3ada0",
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
    "ddbcab57d501f10dcd3dc2bb174f7ac51974b9d2dd50d42d49cb8035047dec49",
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
    "44988a5617d4e215d02882c6b9b06ca44d120fbcb7a55343eb4767acdb55e44d",
  ],
  [
    ".opencode/skills/scheduled-quality-orchestrator/SKILL.md",
    "f4cd3c46b75fd9b7e04b0da6b4421801a580e9103ef51cc7490866765a8e7a30",
  ],
  [
    ".opencode/skills/scheduled-quality-reviewer/SKILL.md",
    "5ed4187f8070e20fb3632d95ee1c7c6ceb1125464dc0bf37cb7e7e4eda7f6ee1",
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
