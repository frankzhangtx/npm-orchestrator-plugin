import assert from "node:assert/strict";
import cp from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { command, fixture, taskContract } from "./queue-fixture.mjs";

const require = createRequire(import.meta.url);
const expected = code => error => error.code === code;
function setup(options = {}) {
  const f = fixture({ inventoryMode: true, ...options });
  const contract = taskContract(f, "TASK-EVIDENCE-001");
  const contractFile = join(f.root, `automation/tasks/${contract.id}.json`);
  const configFile = join(f.root, "automation/config.json");
  writeFileSync(contractFile, JSON.stringify(contract));
  writeFileSync(join(f.root, contract.planPath), "Approved inventory verification\n");
  const evidence = join(f.root, ".git/automation-runtime/evidence", contract.id);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "baseline.json"), JSON.stringify({ head: command(f.root, ["rev-parse", "HEAD"]) }));
  const inventory = require(join(f.root, "automation/verification/inventory.cjs"));
  const phase = name => inventory.runPhase(name, contractFile, configFile, f.root, evidence);
  const testFile = join(f.root, `app/src/test/java/${contract.id}Test.kt`);
  const product = join(f.root, `app/src/main/java/${contract.id}.kt`);
  const read = name => JSON.parse(readFileSync(join(evidence, `${name}.json`), "utf8"));
  return { ...f, contract, contractFile, configFile, evidence, phase, testFile, product, read };
}
function seal(f) {
  f.phase("baseline"); writeFileSync(f.testFile, "class ApprovedBehaviorTest\n");
  f.phase("red"); writeFileSync(f.product, "class ImplementedFeature\n");
  f.phase("green"); assert.equal(f.phase("check").valid, true);
}

test("final inventory check rejects every bound input and evidence mutation", () => {
  const f = setup();
  try {
    seal(f);
    const red = f.read("red"), green = f.read("green-inventory");
    const paths = [f.contractFile, f.configFile, f.testFile, f.product,
      ...["baseline", "baseline-inventory", "test-preflight", "test-manifest", "red"].map(name => join(f.evidence, `${name}.json`)),
      ...red.files.map(item => join(f.evidence, item.path)), ...green.files.map(item => join(f.evidence, item.path)),
      join(f.root, "automation/verification/collect.init.gradle")];
    for (const file of paths) {
      const original = readFileSync(file);
      writeFileSync(file, Buffer.concat([original, Buffer.from("\n ")]));
      assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"), file);
      writeFileSync(file, original);
    }
    for (const file of [f.testFile, f.product]) {
      const mode = statSync(file).mode & 0o777;
      chmodSync(file, mode ^ 0o100);
      assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
      chmodSync(file, mode);
    }
    assert.equal(f.phase("check").valid, true);
    const meta = join(f.evidence, "green-inventory.json"), saved = readFileSync(meta);
    const modified = JSON.parse(saved); modified.summary.total += 1;
    writeFileSync(meta, JSON.stringify(modified));
    assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    writeFileSync(meta, "{invalid");
    assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    unlinkSync(meta);
    assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    writeFileSync(meta, saved);
    assert.equal(f.phase("check").valid, true);
  } finally { f.cleanup(); }
});

test("a failed GREEN rerun invalidates earlier success until another complete GREEN passes", () => {
  const f = setup();
  try {
    seal(f);
    const first = f.read("green-inventory");
    const spawn = cp.spawnSync;
    cp.spawnSync = (exe, args, options) => exe.endsWith("/gradlew")
      ? { status: 1, signal: null } : spawn(exe, args, options);
    try { assert.throws(() => f.phase("green"), expected("EXECUTION_FAILURE")); }
    finally { cp.spawnSync = spawn; }
    assert.equal(f.read("green-verification").state, "FAILED");
    assert.equal(f.read("green-inventory").verificationRunId, first.verificationRunId);
    assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    f.phase("green");
    assert.equal(f.phase("check").valid, true);
    assert.notEqual(f.read("green-inventory").verificationRunId, first.verificationRunId);
  } finally { f.cleanup(); }
});

test("early GREEN rejection, interrupted sealing and missing or mismatched markers cannot reuse old evidence", () => {
  const f = setup();
  try {
    seal(f);
    const original = readFileSync(f.testFile);
    writeFileSync(f.testFile, "Changed frozen test\n");
    assert.throws(() => f.phase("green"), expected("EVIDENCE_CHANGED"));
    writeFileSync(f.testFile, original);
    assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    f.phase("green");
    const marker = join(f.evidence, "green-verification.json"), saved = readFileSync(marker);
    for (const change of [{ state: "RUNNING" }, { verificationRunId: "old-run" }, { greenSha256: "wrong-hash" }]) {
      writeFileSync(marker, JSON.stringify({ ...JSON.parse(saved), ...change }));
      assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    }
    unlinkSync(marker);
    assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    writeFileSync(marker, saved);
    assert.equal(f.phase("check").valid, true);
  } finally { f.cleanup(); }
});

test("RED refuses premature production edits and keeps failed preparation attempts within budget", () => {
  const f = setup();
  try {
    f.phase("baseline"); writeFileSync(f.testFile, "class ApprovedBehaviorTest\n");
    writeFileSync(f.product, "class PrematureImplementation\n");
    assert.throws(() => f.phase("red"), expected("EVIDENCE_CHANGED"));
    assert.equal(existsSync(join(f.evidence, "red.json")), false);
    unlinkSync(f.product);
    assert.equal(f.phase("red").attempt, 2);
    assert.equal(readdirSync(join(f.evidence, "inventory-attempts")).filter(name => name.startsWith("red-")).length, 2);
    assert.throws(() => f.phase("red"), expected("EVIDENCE_CHANGED"));
  } finally { f.cleanup(); }
  const exhausted = setup({ inventoryFailure: "regression" });
  try {
    exhausted.phase("baseline"); writeFileSync(exhausted.testFile, "class ApprovedBehaviorTest\n");
    for (let n = 0; n < 2; n++) assert.throws(() => exhausted.phase("red"), expected("CASE_EXPECTATION_MISMATCH"));
    assert.throws(() => exhausted.phase("red"), expected("PREPARATION_BUDGET"));
    assert.equal(existsSync(join(exhausted.evidence, "red.json")), false);
    assert.equal(readdirSync(join(exhausted.evidence, "inventory-attempts")).filter(name => name.startsWith("red-")).length, 2);
  } finally { exhausted.cleanup(); }
});

test("partial sealing consumes a preparation attempt without replacing an existing RED", () => {
  const f = setup();
  try {
    f.phase("baseline"); writeFileSync(f.testFile, "class ApprovedBehaviorTest\n");
    mkdirSync(join(f.evidence, "inventory-attempts/red-001-interrupted"));
    writeFileSync(join(f.evidence, "test-manifest.json"), "{unfinished");
    assert.equal(f.phase("red").attempt, 2);
    const sealed = readFileSync(join(f.evidence, "red.json"), "utf8");
    assert.throws(() => f.phase("red"), expected("EVIDENCE_CHANGED"));
    assert.equal(readFileSync(join(f.evidence, "red.json"), "utf8"), sealed);
  } finally { f.cleanup(); }
});

test("human-owned files stay outside evidence and exclusion policy changes invalidate the binding", () => {
  const f = setup();
  try {
    const workspaceDir = join(f.root, ".git/automation-runtime/workspaces");
    mkdirSync(workspaceDir, { recursive: true });
    const workspaceFile = join(workspaceDir, `${f.contract.id}.json`);
    writeFileSync(workspaceFile, JSON.stringify({ worktreeAllowlist: ["personal-notes.md"] }));
    writeFileSync(join(f.root, "personal-notes.md"), "Private draft\n");
    writeFileSync(join(f.root, "automation/automation-commit-prefix"), "local: ");
    seal(f);
    writeFileSync(join(f.root, "personal-notes.md"), "Edited by a person\n");
    writeFileSync(join(f.root, "automation/automation-commit-prefix"), "feature: ");
    assert.equal(f.phase("check").valid, true);
    writeFileSync(workspaceFile, JSON.stringify({ worktreeAllowlist: ["personal-notes.md", "app/src/main/java/Hidden.kt"] }));
    assert.throws(() => f.phase("check"), expected("EVIDENCE_CHANGED"));
    const { snapshot } = require(join(f.root, "automation/verification/inventory.cjs"));
    assert.throws(() => snapshot(f.root, f.config, ["app/src/test/**"], [`app/src/test/java/${f.contract.id}Test.kt`]), expected("UNSUPPORTED_TEST_INPUT"));
  } finally { f.cleanup(); }
});

test("discovery rejects external, generated, symlink and production-overlap test inputs", () => {
  const f = setup();
  try {
    const { testPatterns, snapshot, isTest } = require(join(f.root, "automation/verification/inventory.cjs"));
    const canonical = require("node:fs").realpathSync(f.root);
    for (const source of [f.base, join(canonical, "build/generated-tests")])
      assert.throws(() => testPatterns(canonical, f.config, [{ sourceRoots: [source] }]), expected("UNSUPPORTED_TEST_INPUT"));
    const linked = join(f.root, "app/src/test/linked");
    symlinkSync(join(f.root, "app/src/main"), linked);
    assert.throws(() => snapshot(f.root, f.config, ["app/src/test/**"]), expected("UNSUPPORTED_TEST_INPUT"));
    unlinkSync(linked);
    assert.equal(isTest(f.config, ["app/src/**"], "app/src/main/java/Baseline.kt"), false);
    assert.throws(() => snapshot(f.root, f.config, ["app/src/**"]), expected("UNSUPPORTED_TEST_INPUT"));
  } finally { f.cleanup(); }
});
