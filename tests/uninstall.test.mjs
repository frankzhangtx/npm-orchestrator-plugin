import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  UNINSTALL_MARKER_RELATIVE_PATH,
  InstallationManifestError,
  ProjectUninstallError,
  applyProjectUninstall,
  formatProjectUninstallResult,
  planProjectUninstall,
  readInstallationManifest,
  runProjectInitialization,
  runProjectUninstall,
  verifyInstallationIntegrity,
} from "../dist/index.js";

const initPreparedAt = "2026-08-25T01:00:00.000Z";
const initInstalledAt = "2026-08-25T01:05:00.000Z";
const uninstallPreparedAt = "2026-08-25T02:00:00.000Z";
const uninstalledAt = "2026-08-25T02:05:00.000Z";

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

function successfulRunner() {
  return (executable, args) => {
    if (executable === "opencode" && args.length === 1 && args[0] === "--version") {
      return commandResult(0, "1.15.13\n");
    }
    if (args.length === 1 && ["--version", "-version"].includes(args[0])) {
      return commandResult(0, `${executable} fixture version\n`);
    }
    if (executable.endsWith("scripts/automation/tests/run-tests.sh")) {
      return commandResult(0, "ok 38 - fixture\n1..38\n");
    }
    if (executable.endsWith("scripts/automation/shadow-run.sh")) {
      return commandResult(
        0,
        `${JSON.stringify({ mutationPerformed: false })}\n`,
      );
    }
    return commandResult(1, "", `unexpected command: ${executable}`);
  };
}

function createInstalledFixture(installationId) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-uninstall-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "Uninstall Fixture"\ninclude(":mobile")\nproject(":mobile").projectDir = file("clients/mobile")\n',
  );
  writeFixtureFile(
    root,
    "clients/mobile/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid {\n    namespace = "dev.uninstall.fixture"\n    defaultConfig { applicationId = "dev.uninstall.fixture" }\n}\n',
  );
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=fixture\n",
  );
  const originalAgents = "# Existing uninstall rules\n\nKeep this text.\n";
  const originalOpenCode =
    '{\n  // preserve uninstall fixture\n  "theme": "system",\n}\n';
  writeFixtureFile(root, "AGENTS.md", originalAgents, 0o644);
  writeFixtureFile(root, "opencode.jsonc", originalOpenCode, 0o600);
  runProjectInitialization(root, {
    androidSdkDirectory: tmpdir(),
    installationId,
    installedAt: initInstalledAt,
    preparedAt: initPreparedAt,
    processRunner: successfulRunner(),
  });
  return { root, originalAgents, originalOpenCode };
}

function uninstallOptions(uninstallId) {
  return {
    uninstallId,
    preparedAt: uninstallPreparedAt,
    uninstalledAt,
  };
}

function disposition(plan, path) {
  return plan.files.find((file) => file.path === path)?.disposition;
}

function assertManifestMissing(root) {
  assert.throws(
    () => readInstallationManifest(root),
    (error) =>
      error instanceof InstallationManifestError &&
      error.code === "MANIFEST_MISSING",
  );
}

test("plans read-only and safely uninstalls unchanged managed resources", () => {
  const { root, originalAgents, originalOpenCode } = createInstalledFixture(
    "uninstall-source-clean-001",
  );
  try {
    const manifestBefore = readFileSync(
      join(root, INSTALLATION_MANIFEST_RELATIVE_PATH),
      "utf8",
    );
    const options = uninstallOptions("uninstall-clean-001");
    const plan = planProjectUninstall(join(root, "clients/mobile"), options);

    assert.equal(plan.targetDirectory, root);
    assert.equal(plan.files.length, 45);
    assert.equal(disposition(plan, "AGENTS.md"), "restore-original");
    assert.equal(disposition(plan, "opencode.jsonc"), "restore-original");
    assert.equal(
      disposition(plan, "scripts/automation/preflight.sh"),
      "remove-installed",
    );
    assert.equal(existsSync(plan.recoveryDirectory), false);
    assert.equal(existsSync(join(root, UNINSTALL_MARKER_RELATIVE_PATH)), false);
    assert.equal(
      readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
      manifestBefore,
    );

    const result = runProjectUninstall(join(root, "clients/mobile"), options);

    assert.equal(result.status, "uninstalled");
    assert.equal(result.managedFileCount, 45);
    assert.equal(result.restoredFileCount, 2);
    assert.equal(result.removedFileCount, 43);
    assert.equal(result.alreadyCleanFileCount, 0);
    assert.equal(result.retainedFileCount, 0);
    assert.deepEqual(result.retainedPaths, []);
    assert.deepEqual(result.cleanupWarnings, []);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), originalAgents);
    assert.equal(
      readFileSync(join(root, "opencode.jsonc"), "utf8"),
      originalOpenCode,
    );
    assert.equal(lstatSync(join(root, "AGENTS.md")).mode & 0o777, 0o644);
    assert.equal(lstatSync(join(root, "opencode.jsonc")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(root, ".opencode/agents/scheduled-coder.md")), false);
    assert.equal(existsSync(join(root, "scripts/automation/preflight.sh")), false);
    assertManifestMissing(root);
    assert.equal(existsSync(join(root, UNINSTALL_MARKER_RELATIVE_PATH)), false);
    assert.equal(existsSync(result.recoveryDirectory), true);
    assert.equal(existsSync(result.historyPath), true);
    assert.equal(existsSync(result.backupDirectory), true);
    assert.equal(
      JSON.parse(readFileSync(join(result.recoveryDirectory, "transaction.json"), "utf8")).state,
      "uninstalled",
    );
    assert.equal(
      JSON.parse(readFileSync(result.historyPath, "utf8")).state,
      "uninstalled",
    );
    assert.match(formatProjectUninstallResult(result), /Result: UNINSTALLED/);
    assert.match(formatProjectUninstallResult(result), /Restored original files: 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains content, permission, and deletion drift while uninstalling safe files", () => {
  const { root } = createInstalledFixture("uninstall-source-retain-001");
  try {
    const modifiedAgents = `${readFileSync(join(root, "AGENTS.md"), "utf8")}\nUser edit after install.\n`;
    writeFileSync(join(root, "AGENTS.md"), modifiedAgents);
    chmodSync(join(root, "scripts/automation/preflight.sh"), 0o644);
    unlinkSync(join(root, "opencode.jsonc"));
    unlinkSync(join(root, ".opencode/agents/scheduled-coder.md"));
    const options = uninstallOptions("uninstall-retain-001");
    const plan = planProjectUninstall(root, options);

    assert.equal(disposition(plan, "AGENTS.md"), "retain-modified");
    assert.equal(
      disposition(plan, "scripts/automation/preflight.sh"),
      "retain-modified",
    );
    assert.equal(disposition(plan, "opencode.jsonc"), "retain-missing");
    assert.equal(
      disposition(plan, ".opencode/agents/scheduled-coder.md"),
      "already-absent",
    );

    const result = runProjectUninstall(root, options);

    assert.equal(result.status, "uninstalled-with-retained-files");
    assert.equal(result.restoredFileCount, 0);
    assert.equal(result.removedFileCount, 41);
    assert.equal(result.alreadyCleanFileCount, 1);
    assert.equal(result.retainedFileCount, 3);
    assert.deepEqual(
      new Set(result.retainedPaths),
      new Set([
        "AGENTS.md",
        "opencode.jsonc",
        "scripts/automation/preflight.sh",
      ]),
    );
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), modifiedAgents);
    assert.equal(
      lstatSync(join(root, "scripts/automation/preflight.sh")).mode & 0o777,
      0o644,
    );
    assert.equal(existsSync(join(root, "opencode.jsonc")), false);
    assert.equal(
      existsSync(join(root, ".opencode/agents/scheduled-coder.md")),
      false,
    );
    assert.equal(existsSync(join(root, ".opencode/commands/change.md")), false);
    assertManifestMissing(root);
    assert.match(
      formatProjectUninstallResult(result),
      /UNINSTALLED WITH RETAINED FILES/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a corrupted original backup before creating uninstall state", () => {
  const { root } = createInstalledFixture("uninstall-source-backup-001");
  try {
    const manifest = readInstallationManifest(root);
    const agents = manifest.files.find((file) => file.path === "AGENTS.md");
    assert.ok(agents?.previous.backupPath);
    writeFileSync(
      join(root, ...agents.previous.backupPath.split("/")),
      "corrupted original backup\n",
    );

    assert.throws(
      () =>
        planProjectUninstall(
          root,
          uninstallOptions("uninstall-corrupt-backup-001"),
        ),
      (error) =>
        error instanceof ProjectUninstallError &&
        error.code === "INSTALLATION_INVALID" &&
        error.message.includes("Original backup failed"),
    );
    assert.equal(existsSync(join(root, UNINSTALL_MARKER_RELATIVE_PATH)), false);
    assert.equal(
      existsSync(join(root, ".automation-plugin/uninstalls/uninstall-corrupt-backup-001")),
      false,
    );
    assert.equal(existsSync(join(root, "scripts/automation/preflight.sh")), true);
    assert.equal(readInstallationManifest(root).installation.state, "installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses an unfinished upgrade marker before planning writes", () => {
  const { root } = createInstalledFixture("uninstall-source-marker-001");
  try {
    writeFixtureFile(
      root,
      ".automation-plugin/upgrade.json",
      '{"state":"prepared"}\n',
      0o600,
    );
    assert.throws(
      () =>
        planProjectUninstall(
          root,
          uninstallOptions("uninstall-upgrade-marker-001"),
        ),
      (error) =>
        error instanceof ProjectUninstallError &&
        error.code === "UNINSTALL_IN_PROGRESS" &&
        error.details.some((detail) => detail.endsWith("upgrade.json")),
    );
    assert.equal(
      existsSync(join(root, ".automation-plugin/uninstalls/uninstall-upgrade-marker-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply refuses a tampered uninstall plan before creating recovery state", () => {
  const { root } = createInstalledFixture("uninstall-source-tamper-001");
  try {
    const plan = planProjectUninstall(
      root,
      uninstallOptions("uninstall-plan-tamper-001"),
    );
    const removal = plan.files.find(
      (file) => file.disposition === "remove-installed",
    );
    assert.ok(removal?.before.content);
    removal.before.content[0] ^= 0xff;

    assert.throws(
      () => applyProjectUninstall(plan),
      (error) =>
        error instanceof ProjectUninstallError && error.code === "PLAN_STALE",
    );
    assert.equal(existsSync(join(root, UNINSTALL_MARKER_RELATIVE_PATH)), false);
    assert.equal(existsSync(plan.recoveryDirectory), false);
    assert.equal(readInstallationManifest(root).installation.state, "installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-write failure rolls the complete installed state back", () => {
  const { root } = createInstalledFixture("uninstall-source-rollback-001");
  try {
    const plan = planProjectUninstall(
      root,
      uninstallOptions("uninstall-rollback-001"),
    );
    const manifestBefore = readFileSync(
      join(root, INSTALLATION_MANIFEST_RELATIVE_PATH),
      "utf8",
    );

    assert.throws(
      () =>
        applyProjectUninstall(plan, () => {
          throw new Error("fixture post-write verification failure");
        }),
      (error) =>
        error instanceof ProjectUninstallError &&
        error.code === "POST_UNINSTALL_VERIFICATION_FAILED",
    );

    assert.equal(
      readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
      manifestBefore,
    );
    assert.equal(verifyInstallationIntegrity(root).ok, true);
    assert.equal(existsSync(join(root, UNINSTALL_MARKER_RELATIVE_PATH)), false);
    assert.equal(existsSync(plan.historyPath), false);
    assert.equal(existsSync(plan.recoveryDirectory), true);
    assert.equal(
      JSON.parse(readFileSync(join(plan.recoveryDirectory, "transaction.json"), "utf8")).state,
      "rolledBack",
    );
    assert.equal(existsSync(join(root, "scripts/automation/preflight.sh")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI uninstall supports structured JSON output", () => {
  const { root } = createInstalledFixture("uninstall-source-cli-001");
  try {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cli, "uninstall", join(root, "clients/mobile"), "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "uninstalled");
    assert.equal(output.targetDirectory, root);
    assert.equal(output.managedFileCount, 45);
    assert.equal(output.restoredFileCount, 2);
    assert.equal(output.removedFileCount, 43);
    assertManifestMissing(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
