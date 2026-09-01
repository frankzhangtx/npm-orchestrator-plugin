import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parse } from "jsonc-parser";

import {
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  ORCHESTRATOR_PLUGIN_REFERENCE,
  ProjectUpgradeError,
  SUPERPOWERS_PLUGIN_REFERENCE,
  UNINSTALL_MARKER_RELATIVE_PATH,
  UPGRADE_MARKER_RELATIVE_PATH,
  WORKTREE_ALLOWLIST_RELATIVE_PATH,
  applyProjectUpgrade,
  formatProjectUpgradeResult,
  planProjectUpgrade,
  readInstallationManifest,
  runDoctor,
  runProjectInitialization,
  runProjectUpgrade,
  verifyInstallationIntegrity,
} from "../dist/index.js";

const upgradePreparedAt = "2026-08-24T11:00:00.000Z";
const upgradeInstalledAt = "2026-08-24T11:05:00.000Z";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function writeFixtureFile(root, relativePath, content, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
  return path;
}

function commandResult(status, stdout = "", stderr = "", error = null) {
  return { status, stdout, stderr, error };
}

function successfulRunner(calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    if (executable === "opencode" && args[0] === "--version") {
      return commandResult(0, "1.15.13\n");
    }
    if (executable.endsWith("scripts/automation/tests/run-tests.sh")) {
      return commandResult(0, "ok 42 - fixture\n1..42\n");
    }
    if (executable.endsWith("scripts/automation/shadow-run.sh")) {
      return commandResult(0, '{"mutationPerformed":false}\n');
    }
    if (args.length === 1 && ["--version", "-version"].includes(args[0])) {
      return commandResult(0, `${executable} fixture version\n`);
    }
    if (executable.endsWith("gradlew") && args[0] === "help") {
      return commandResult(
        0,
        [
          "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:assembleDebug",
          "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:connectedDebugAndroidTest",
          "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:lint",
          "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:testDebugUnitTest",
          "",
        ].join("\n"),
      );
    }
    return commandResult(1, "", `unexpected command: ${executable}`);
  };
}

function createInstalledFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-upgrade-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "Upgrade Fixture"\ninclude(":mobile")\nproject(":mobile").projectDir = file("clients/mobile")\n',
  );
  writeFixtureFile(
    root,
    "clients/mobile/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid {\n    namespace = "dev.upgrade.fixture"\n    defaultConfig { applicationId = "dev.upgrade.fixture" }\n}\n',
  );
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=fixture\n",
  );
  const originalAgents = "# Existing upgrade rules\n\nKeep this text.\n";
  const originalOpenCode =
    '{\n  // preserve upgrade fixture\n  "theme": "system",\n}\n';
  writeFixtureFile(root, "AGENTS.md", originalAgents, 0o644);
  writeFixtureFile(root, "opencode.jsonc", originalOpenCode, 0o600);
  const sdk = join(root, "fixture-sdk");
  mkdirSync(join(sdk, "platforms"), { recursive: true });
  mkdirSync(join(sdk, "build-tools"), { recursive: true });

  runProjectInitialization(root, {
    androidSdkDirectory: sdk,
    installationId: "upgrade-source-install-001",
    preparedAt: "2026-08-24T10:00:00.000Z",
    installedAt: "2026-08-24T10:05:00.000Z",
    processRunner: successfulRunner(),
  });
  return { root, sdk, originalAgents, originalOpenCode };
}

function updateManifestEntry(manifest, path, content) {
  const entry = manifest.files.find((candidate) => candidate.path === path);
  assert.ok(entry, `missing manifest entry: ${path}`);
  const value = Buffer.from(content);
  entry.sha256 = sha256(value);
  entry.size = value.byteLength;
}

function writeManifest(root, manifest) {
  const path = join(root, INSTALLATION_MANIFEST_RELATIVE_PATH);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(path, 0o600);
}

function simulateOlderInstallation(
  root,
  { legacyFile = false, omitModuleScope = false } = {},
) {
  const manifest = JSON.parse(
    readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
  );
  manifest.package.version = "0.2.0";

  const oldAgent = "legacy scheduled coder\n";
  writeFileSync(join(root, ".opencode/agents/scheduled-coder.md"), oldAgent);
  updateManifestEntry(
    manifest,
    ".opencode/agents/scheduled-coder.md",
    oldAgent,
  );

  const agentsPath = join(root, "AGENTS.md");
  const oldAgents = readFileSync(agentsPath, "utf8").replace(
    "## OpenCode Android Orchestrator",
    "## OpenCode Android Orchestrator Legacy",
  );
  writeFileSync(agentsPath, oldAgents);
  updateManifestEntry(manifest, "AGENTS.md", oldAgents);

  const openCodePath = join(root, "opencode.jsonc");
  const oldOpenCode = readFileSync(openCodePath, "utf8").replace(
    ORCHESTRATOR_PLUGIN_REFERENCE,
    "@frankzhang2026/opencode-android-orchestrator@0.2.0",
  );
  writeFileSync(openCodePath, oldOpenCode);
  chmodSync(openCodePath, 0o600);
  updateManifestEntry(manifest, "opencode.jsonc", oldOpenCode);

  if (omitModuleScope) {
    const configPath = join(root, "automation/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    delete config.androidProject.moduleScope;
    const configContent = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(configPath, configContent);
    updateManifestEntry(manifest, "automation/config.json", configContent);
  }

  if (legacyFile) {
    const path = "legacy/user-note.txt";
    const installedContent = Buffer.from("legacy managed value\n");
    const originalContent = Buffer.from("user value before plugin\n");
    writeFixtureFile(root, path, installedContent, 0o644);
    const backupPath = `${manifest.backupDirectory}/${path}`;
    writeFixtureFile(root, backupPath, originalContent, 0o600);
    manifest.files.push({
      path,
      source: "templates/legacy/user-note.txt",
      strategy: "copy",
      sha256: sha256(installedContent),
      size: installedContent.byteLength,
      mode: 0o644,
      previous: {
        existed: true,
        sha256: sha256(originalContent),
        size: originalContent.byteLength,
        mode: 0o600,
        backupPath,
      },
    });
    manifest.files.sort((left, right) => left.path.localeCompare(right.path));
  }

  writeManifest(root, manifest);
  assert.equal(verifyInstallationIntegrity(root).ok, true);
  return {
    manifestContent: readFileSync(
      join(root, INSTALLATION_MANIFEST_RELATIVE_PATH),
      "utf8",
    ),
    oldAgent,
    oldAgents,
    oldOpenCode,
  };
}

function upgradeOptions(sdk, runner = successfulRunner(), id = "upgrade-test-001") {
  return {
    androidSdkDirectory: sdk,
    upgradeId: id,
    preparedAt: upgradePreparedAt,
    installedAt: upgradeInstalledAt,
    processRunner: runner,
  };
}

test("plans an older-version upgrade without writing recovery or managed files", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    const old = simulateOlderInstallation(root);
    const beforeAgent = readFileSync(
      join(root, ".opencode/agents/scheduled-coder.md"),
      "utf8",
    );

    const plan = planProjectUpgrade(
      join(root, "clients/mobile"),
      upgradeOptions(sdk),
    );

    assert.equal(plan.status, "upgrade");
    assert.equal(plan.targetDirectory, root);
    assert.equal(plan.moduleScope, "all");
    assert.equal(plan.primaryModule, ":mobile");
    assert.equal(plan.fromVersion, "0.2.0");
    assert.equal(plan.toVersion, "0.6.0");
    assert.equal(plan.desiredFiles.length, 45);
    assert.equal(plan.removedFiles.length, 0);
    assert.equal(existsSync(plan.recoveryDirectory), false);
    assert.equal(existsSync(plan.backupDirectory), false);
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
    assert.equal(
      readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
      old.manifestContent,
    );
    assert.equal(
      readFileSync(
        join(root, ".opencode/agents/scheduled-coder.md"),
        "utf8",
      ),
      beforeAgent,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrades legacy configurations without moduleScope in primary mode", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    simulateOlderInstallation(root, { omitModuleScope: true });

    const allModulePlan = planProjectUpgrade(root, {
      ...upgradeOptions(
        sdk,
        successfulRunner(),
        "upgrade-legacy-scope-plan-001",
      ),
      moduleScope: "all",
    });
    assert.equal(allModulePlan.moduleScope, "all");

    const result = runProjectUpgrade(
      root,
      upgradeOptions(sdk, successfulRunner(), "upgrade-legacy-scope-001"),
    );
    const config = JSON.parse(
      readFileSync(join(root, "automation/config.json"), "utf8"),
    );

    assert.equal(result.status, "upgraded");
    assert.equal(result.moduleScope, "primary");
    assert.equal(config.androidProject.moduleScope, "primary");
    assert.equal(result.doctor.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrades unchanged managed files, preserves original merges, and restores obsolete user files", () => {
  const { root, sdk, originalAgents, originalOpenCode } = createInstalledFixture();
  try {
    const customAllowlist = "config/developer-overrides.json\n";
    writeFileSync(
      join(root, WORKTREE_ALLOWLIST_RELATIVE_PATH),
      customAllowlist,
    );
    const old = simulateOlderInstallation(root, { legacyFile: true });

    const result = runProjectUpgrade(
      join(root, "clients/mobile"),
      upgradeOptions(sdk, successfulRunner(), "upgrade-success-001"),
    );

    assert.equal(result.status, "upgraded");
    assert.equal(result.moduleScope, "all");
    assert.equal(result.fromVersion, "0.2.0");
    assert.equal(result.toVersion, "0.6.0");
    assert.equal(result.managedFileCount, 45);
    assert.equal(result.writtenFileCount, 3);
    assert.equal(result.reusedFileCount, 42);
    assert.equal(result.restoredOrRemovedFileCount, 1);
    assert.deepEqual(result.cleanupWarnings, []);
    assert.equal(result.verification.ok, true);
    assert.equal(
      readFileSync(join(root, "legacy/user-note.txt"), "utf8"),
      "user value before plugin\n",
    );
    assert.equal(lstatSync(join(root, "legacy/user-note.txt")).mode & 0o777, 0o600);

    const manifest = readInstallationManifest(root);
    assert.equal(manifest.package.version, "0.6.0");
    assert.equal(manifest.installation.id, "upgrade-success-001");
    assert.equal(manifest.installation.state, "installed");
    assert.equal(verifyInstallationIntegrity(root).ok, true);
    assert.equal(
      readFileSync(join(root, WORKTREE_ALLOWLIST_RELATIVE_PATH), "utf8"),
      customAllowlist,
      "upgrade must preserve the human-maintained allowlist",
    );
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
    assert.equal(existsSync(result.recoveryDirectory), true);
    assert.equal(existsSync(result.historyPath), true);
    assert.equal(
      readFileSync(join(result.recoveryDirectory, "previous-manifest.json"), "utf8"),
      old.manifestContent,
    );
    assert.equal(
      readFileSync(join(result.backupDirectory, "AGENTS.md"), "utf8"),
      originalAgents,
    );
    assert.equal(
      readFileSync(join(result.backupDirectory, "opencode.jsonc"), "utf8"),
      originalOpenCode,
    );

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith(`${originalAgents}\n`));
    assert.doesNotMatch(agents, /Legacy/);
    const openCode = readFileSync(join(root, "opencode.jsonc"), "utf8");
    assert.match(openCode, /preserve upgrade fixture/);
    assert.deepEqual(parse(openCode).plugin, [
      SUPERPOWERS_PLUGIN_REFERENCE,
      ORCHESTRATOR_PLUGIN_REFERENCE,
    ]);

    const doctor = runDoctor({
      androidSdkDirectory: sdk,
      checkDependencies: true,
      checkInstallation: true,
      runCommand: successfulRunner(),
      targetDirectory: root,
    });
    assert.equal(doctor.ok, true);
    assert.match(formatProjectUpgradeResult(result), /Result: UPGRADED/);
    assert.match(formatProjectUpgradeResult(result), /Module scope: all/);
    assert.match(formatProjectUpgradeResult(result), /0\.2\.0 -> 0\.6\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated upgrade is byte-idempotent for the current version", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    const manifestBefore = readFileSync(
      join(root, INSTALLATION_MANIFEST_RELATIVE_PATH),
      "utf8",
    );
    const result = runProjectUpgrade(
      root,
      upgradeOptions(sdk, successfulRunner(), "upgrade-noop-001"),
    );

    assert.equal(result.status, "already-current");
    assert.equal(result.moduleScope, "all");
    assert.equal(result.writtenFileCount, 0);
    assert.equal(result.reusedFileCount, 45);
    assert.equal(result.recoveryDirectory, null);
    assert.equal(result.historyPath, null);
    assert.equal(
      readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
      manifestBefore,
    );
    assert.equal(
      existsSync(join(root, ".automation-plugin/upgrades/upgrade-noop-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-version upgrade refuses a self-consistent managed-resource rewrite", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    const path = "scripts/automation/preflight.sh";
    const content = "#!/usr/bin/env bash\necho rewritten current version\n";
    writeFileSync(join(root, path), content);
    const manifest = readInstallationManifest(root);
    updateManifestEntry(manifest, path, content);
    writeManifest(root, manifest);
    assert.equal(verifyInstallationIntegrity(root).ok, true);

    assert.throws(
      () =>
        planProjectUpgrade(
          root,
          upgradeOptions(sdk, successfulRunner(), "upgrade-rewrite-001"),
        ),
      (error) =>
        error instanceof ProjectUpgradeError &&
        error.code === "UPGRADE_NOT_REQUIRED",
    );
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
    assert.equal(
      existsSync(join(root, ".automation-plugin/upgrades/upgrade-rewrite-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade refuses an unfinished transaction marker before planning writes", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    simulateOlderInstallation(root);
    writeFixtureFile(
      root,
      UPGRADE_MARKER_RELATIVE_PATH,
      '{"state":"prepared"}\n',
      0o600,
    );

    assert.throws(
      () =>
        planProjectUpgrade(
          root,
          upgradeOptions(sdk, successfulRunner(), "upgrade-marker-001"),
        ),
      (error) =>
        error instanceof ProjectUpgradeError &&
        error.code === "UPGRADE_IN_PROGRESS",
    );
    assert.equal(
      existsSync(join(root, ".automation-plugin/upgrades/upgrade-marker-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade refuses an unfinished uninstall marker before planning writes", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    simulateOlderInstallation(root);
    writeFixtureFile(
      root,
      UNINSTALL_MARKER_RELATIVE_PATH,
      '{"state":"prepared"}\n',
      0o600,
    );

    assert.throws(
      () =>
        planProjectUpgrade(
          root,
          upgradeOptions(sdk, successfulRunner(), "upgrade-uninstall-marker-001"),
        ),
      (error) =>
        error instanceof ProjectUpgradeError &&
        error.code === "UPGRADE_IN_PROGRESS" &&
        error.details.some((detail) => detail.endsWith("uninstall.json")),
    );
    assert.equal(
      existsSync(join(root, ".automation-plugin/upgrades/upgrade-uninstall-marker-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade refuses a user-modified managed file before creating recovery state", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    simulateOlderInstallation(root);
    writeFileSync(
      join(root, "scripts/automation/preflight.sh"),
      "#!/bin/sh\necho user change\n",
    );

    assert.throws(
      () =>
        runProjectUpgrade(
          root,
          upgradeOptions(sdk, successfulRunner(), "upgrade-modified-001"),
        ),
      (error) =>
        error instanceof ProjectUpgradeError &&
        error.code === "INSTALLED_FILES_MODIFIED" &&
        error.details.some((detail) => detail.includes("preflight.sh")),
    );
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
    assert.equal(
      existsSync(join(root, ".automation-plugin/upgrades/upgrade-modified-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade refuses a corrupted original backup before writing", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    simulateOlderInstallation(root);
    const manifest = readInstallationManifest(root);
    const agents = manifest.files.find((file) => file.path === "AGENTS.md");
    assert.ok(agents?.previous.backupPath);
    writeFileSync(
      join(root, ...agents.previous.backupPath.split("/")),
      "corrupted backup\n",
    );

    assert.throws(
      () =>
        runProjectUpgrade(
          root,
          upgradeOptions(sdk, successfulRunner(), "upgrade-backup-bad-001"),
        ),
      (error) =>
        error instanceof ProjectUpgradeError &&
        error.code === "INSTALLED_FILES_MODIFIED" &&
        error.details.some((detail) => detail.includes("AGENTS.md")),
    );
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-upgrade verification failure restores the complete older installation", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    const old = simulateOlderInstallation(root, { legacyFile: true });
    const before = new Map(
      [
        ".opencode/agents/scheduled-coder.md",
        "AGENTS.md",
        "opencode.jsonc",
        "legacy/user-note.txt",
      ].map((path) => [path, readFileSync(join(root, path))]),
    );
    const baseRunner = successfulRunner();
    const failingRunner = (executable, args, options) =>
      executable.endsWith("scripts/automation/tests/run-tests.sh")
        ? commandResult(1, "not ok 1 - upgrade fixture\n", "verification failed\n")
        : baseRunner(executable, args, options);

    assert.throws(
      () =>
        runProjectUpgrade(
          root,
          upgradeOptions(sdk, failingRunner, "upgrade-rollback-001"),
        ),
      (error) =>
        error instanceof ProjectUpgradeError &&
        error.code === "POST_UPGRADE_VERIFICATION_FAILED",
    );

    assert.equal(
      readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
      old.manifestContent,
    );
    for (const [path, content] of before) {
      assert.deepEqual(readFileSync(join(root, path)), content, path);
    }
    assert.equal(verifyInstallationIntegrity(root).ok, true);
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
    assert.equal(
      existsSync(join(root, ".automation-plugin/backups/upgrade-rollback-001")),
      false,
    );
    const recovery = join(
      root,
      ".automation-plugin/upgrades/upgrade-rollback-001",
    );
    assert.equal(existsSync(recovery), true);
    assert.equal(
      JSON.parse(readFileSync(join(recovery, "transaction.json"), "utf8")).state,
      "rolledBack",
    );
    assert.equal(
      existsSync(
        join(root, ".automation-plugin/history/upgrade-rollback-001.upgraded.json"),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply refuses a tampered upgrade plan before creating control state", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    simulateOlderInstallation(root);
    const plan = planProjectUpgrade(
      root,
      upgradeOptions(sdk, successfulRunner(), "upgrade-plan-tamper-001"),
    );
    plan.desiredFiles[0].content[0] ^= 0xff;

    assert.throws(
      () => applyProjectUpgrade(plan),
      (error) =>
        error instanceof ProjectUpgradeError && error.code === "PLAN_STALE",
    );
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
    assert.equal(
      existsSync(join(root, ".automation-plugin/upgrades/upgrade-plan-tamper-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade refuses to downgrade a newer installed package", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
    );
    manifest.package.version = "0.7.0";
    writeManifest(root, manifest);

    assert.throws(
      () =>
        planProjectUpgrade(
          root,
          upgradeOptions(sdk, successfulRunner(), "upgrade-downgrade-001"),
        ),
      (error) =>
        error instanceof ProjectUpgradeError &&
        error.code === "VERSION_DOWNGRADE_REFUSED",
    );
    assert.equal(existsSync(join(root, UPGRADE_MARKER_RELATIVE_PATH)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
