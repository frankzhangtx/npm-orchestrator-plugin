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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  INSTALLATION_CONTROL_DIRECTORY,
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  ORCHESTRATOR_PACKAGE_NAME,
  ORCHESTRATOR_PACKAGE_VERSION,
  InstallationManifestError,
  applyInstallationPlan,
  completeInstallationManifest,
  detectInstallationConflicts,
  planInstallationPreparation,
  prepareInstallationBackup,
  readInstallationManifest,
  rollbackPreparedInstallation,
  verifyInstallationIntegrity,
} from "../dist/index.js";

const preparedAt = "2026-08-24T08:00:00.000Z";
const installedAt = "2026-08-24T08:05:00.000Z";
const rolledBackAt = "2026-08-24T08:10:00.000Z";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function withTemporaryDirectory(prefix, operation) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeFixtureFile(root, relativePath, content, mode = 0o644) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

function inputs() {
  return [
    {
      path: "scripts/automation/preflight.sh",
      source: "templates/scripts/automation/preflight.sh",
      strategy: "copy",
      content: "#!/usr/bin/env bash\nprintf 'ready\\n'\n",
      mode: 0o755,
    },
    {
      path: "opencode.json",
      source: "generated/opencode-config-merge",
      strategy: "merge",
      content: '{\n  "plugin": ["fixed-plugin@1.0.0"]\n}\n',
    },
  ];
}

function fixedPlan(directory, overrides = {}) {
  return planInstallationPreparation(directory, inputs(), {
    installationId: "install-test-001",
    preparedAt,
    ...overrides,
  });
}

function writePlannedFiles(plan) {
  for (const file of plan.files) {
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, file.content, {
      mode: file.manifest.mode,
    });
    chmodSync(file.absolutePath, file.manifest.mode);
  }
}

function assertManifestError(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof InstallationManifestError);
    assert.equal(error.code, code);
    return true;
  });
}

test("plans sorted SHA-256 manifest entries without writing the target", () => {
  withTemporaryDirectory("orchestrator-manifest-plan-", (directory) => {
    const original = '{\n  "theme": "existing"\n}\n';
    const configPath = writeFixtureFile(
      directory,
      "opencode.json",
      original,
      0o600,
    );

    const plan = fixedPlan(directory);

    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(plan.manifest.schemaVersion, 1);
    assert.deepEqual(plan.manifest.package, {
      name: ORCHESTRATOR_PACKAGE_NAME,
      version: ORCHESTRATOR_PACKAGE_VERSION,
    });
    assert.equal(plan.manifest.installation.state, "prepared");
    assert.deepEqual(
      plan.manifest.files.map((file) => file.path),
      ["opencode.json", "scripts/automation/preflight.sh"],
    );

    const config = plan.manifest.files[0];
    assert.equal(config.strategy, "merge");
    assert.equal(config.mode, 0o600, "merged files preserve their prior mode");
    assert.equal(config.sha256, sha256(inputs()[1].content));
    assert.deepEqual(config.previous, {
      existed: true,
      sha256: sha256(original),
      size: Buffer.byteLength(original),
      mode: 0o600,
      backupPath:
        ".automation-plugin/backups/install-test-001/opencode.json",
    });

    const script = plan.manifest.files[1];
    assert.equal(script.mode, 0o755);
    assert.equal(script.previous.existed, false);
    assert.doesNotMatch(plan.manifestContent, new RegExp(directory));
    assert.equal(plan.manifestContent, `${JSON.stringify(plan.manifest, null, 2)}\n`);
  });
});

test("reports sorted copy and generate content conflicts without writing", () => {
  withTemporaryDirectory("orchestrator-install-conflicts-", (directory) => {
    const alphaOriginal = "user alpha\n";
    const zetaOriginal = "user zeta\n";
    writeFixtureFile(directory, "alpha.txt", alphaOriginal, 0o600);
    writeFixtureFile(directory, "zeta.txt", zetaOriginal, 0o644);
    const conflictInputs = [
      {
        path: "zeta.txt",
        source: "generated/zeta",
        strategy: "generate",
        content: "generated zeta\n",
        mode: 0o755,
      },
      {
        path: "alpha.txt",
        source: "templates/alpha.txt",
        strategy: "copy",
        content: "template alpha\n",
        mode: 0o600,
      },
    ];

    const report = detectInstallationConflicts(directory, conflictInputs);

    assert.equal(report.ok, false);
    assert.equal(report.targetDirectory, directory);
    assert.deepEqual(
      report.conflicts.map((conflict) => conflict.path),
      ["alpha.txt", "zeta.txt"],
    );
    assert.deepEqual(report.conflicts[0], {
      path: "alpha.txt",
      source: "templates/alpha.txt",
      strategy: "copy",
      kind: "content",
      existingSha256: sha256(alphaOriginal),
      desiredSha256: sha256("template alpha\n"),
      existingSize: Buffer.byteLength(alphaOriginal),
      desiredSize: Buffer.byteLength("template alpha\n"),
      existingMode: 0o600,
      desiredMode: 0o600,
    });
    assert.equal(report.conflicts[1].kind, "content-and-mode");
    assert.equal(report.conflicts[1].existingMode, 0o644);
    assert.equal(report.conflicts[1].desiredMode, 0o755);

    assert.throws(
      () => planInstallationPreparation(directory, conflictInputs),
      (error) => {
        assert.ok(error instanceof InstallationManifestError);
        assert.equal(error.code, "FILE_CONFLICT");
        assert.equal(error.details.length, 2);
        assert.match(error.details[0], /^alpha\.txt: content conflict /);
        return true;
      },
    );
    assert.equal(readFileSync(join(directory, "alpha.txt"), "utf8"), alphaOriginal);
    assert.equal(readFileSync(join(directory, "zeta.txt"), "utf8"), zetaOriginal);
    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
  });
});

test("accepts an identical existing file without changing it", () => {
  withTemporaryDirectory("orchestrator-install-identical-", (directory) => {
    const content = "already installed\n";
    writeFixtureFile(directory, "managed.txt", content, 0o600);
    const identicalInput = [{
      path: "managed.txt",
      source: "templates/managed.txt",
      strategy: "copy",
      content,
    }];

    const report = detectInstallationConflicts(directory, identicalInput);
    const plan = planInstallationPreparation(directory, identicalInput, {
      installationId: "identical-test-001",
      preparedAt,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.conflicts, []);
    assert.equal(plan.manifest.files[0].previous.sha256, sha256(content));
    assert.equal(plan.manifest.files[0].mode, 0o600);
    assert.equal(readFileSync(join(directory, "managed.txt"), "utf8"), content);
    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
  });
});

test("treats an existing-file mode change as a conflict", () => {
  withTemporaryDirectory("orchestrator-install-mode-conflict-", (directory) => {
    const content = "#!/usr/bin/env bash\n";
    const scriptPath = writeFixtureFile(directory, "script.sh", content, 0o644);
    const modeInput = [{
      path: "script.sh",
      source: "templates/script.sh",
      strategy: "copy",
      content,
      mode: 0o755,
    }];

    const report = detectInstallationConflicts(directory, modeInput);

    assert.equal(report.ok, false);
    assert.equal(report.conflicts[0].kind, "mode");
    assert.equal(report.conflicts[0].existingSha256, report.conflicts[0].desiredSha256);
    assert.equal(report.conflicts[0].existingMode, 0o644);
    assert.equal(report.conflicts[0].desiredMode, 0o755);
    assertManifestError("FILE_CONFLICT", () =>
      planInstallationPreparation(directory, modeInput),
    );
    assert.equal(lstatSync(scriptPath).mode & 0o777, 0o644);
    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
  });
});

test("allows explicit merged content but still blocks a merged-file mode change", () => {
  withTemporaryDirectory("orchestrator-install-merge-conflict-", (directory) => {
    const original = '{\n  "theme": "existing"\n}\n';
    writeFixtureFile(directory, "opencode.json", original, 0o600);
    const mergeInput = [{
      path: "opencode.json",
      source: "generated/opencode-config-merge",
      strategy: "merge",
      content: '{\n  "theme": "existing",\n  "plugin": ["fixed"]\n}\n',
    }];

    assert.deepEqual(
      detectInstallationConflicts(directory, mergeInput).conflicts,
      [],
    );
    const plan = planInstallationPreparation(directory, mergeInput, {
      installationId: "merge-test-001",
      preparedAt,
    });
    assert.equal(plan.manifest.files[0].previous.sha256, sha256(original));
    assert.equal(plan.manifest.files[0].mode, 0o600);

    const modeChangingMerge = [{ ...mergeInput[0], mode: 0o644 }];
    const report = detectInstallationConflicts(directory, modeChangingMerge);
    assert.equal(report.ok, false);
    assert.equal(report.conflicts[0].kind, "mode");
    assertManifestError("FILE_CONFLICT", () =>
      planInstallationPreparation(directory, modeChangingMerge),
    );
    assert.equal(lstatSync(join(directory, "opencode.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(directory, "opencode.json"), "utf8"), original);
    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
  });
});

test("backs up existing files before publishing a prepared manifest", () => {
  withTemporaryDirectory("orchestrator-manifest-prepare-", (directory) => {
    const original = "original config\n";
    const configPath = writeFixtureFile(
      directory,
      "opencode.json",
      original,
      0o600,
    );
    const plan = fixedPlan(directory);

    const prepared = prepareInstallationBackup(plan);
    const manifest = readInstallationManifest(directory);
    const backupPath = join(
      directory,
      ".automation-plugin/backups/install-test-001/opencode.json",
    );

    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(readFileSync(backupPath, "utf8"), original);
    assert.equal(lstatSync(backupPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(prepared.manifestPath).mode & 0o777, 0o600);
    assert.equal(prepared.backedUpFileCount, 1);
    assert.equal(prepared.manifestSha256, sha256(plan.manifestContent));
    assert.deepEqual(manifest, plan.manifest);

    const report = verifyInstallationIntegrity(directory);
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks, [
      { path: "opencode.json", installed: "not-checked", backup: "match" },
      {
        path: "scripts/automation/preflight.sh",
        installed: "not-checked",
        backup: "not-required",
      },
    ]);
    assertManifestError("MANIFEST_EXISTS", () =>
      prepareInstallationBackup(plan),
    );
  });
});

test("refuses stale plans before creating installer control state", () => {
  withTemporaryDirectory("orchestrator-manifest-stale-", (directory) => {
    writeFixtureFile(directory, "opencode.json", "before\n", 0o600);
    const plan = fixedPlan(directory);
    writeFixtureFile(directory, "opencode.json", "changed later\n", 0o600);

    assertManifestError("PLAN_STALE", () =>
      prepareInstallationBackup(plan),
    );
    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
  });
});

test("refuses tampered plan paths before writing outside installer control state", () => {
  withTemporaryDirectory("orchestrator-manifest-plan-paths-", (directory) => {
    writeFixtureFile(directory, "opencode.json", "before\n", 0o600);
    const outsideBackup = `${directory}-outside-backup`;
    try {
      const plan = fixedPlan(directory);
      plan.backupDirectory = outsideBackup;

      assertManifestError("PLAN_STALE", () =>
        prepareInstallationBackup(plan),
      );
      assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
      assert.equal(existsSync(outsideBackup), false);
    } finally {
      rmSync(outsideBackup, { recursive: true, force: true });
    }
  });
});

test("refuses tampered manifest content and file metadata before writing", () => {
  withTemporaryDirectory("orchestrator-manifest-plan-metadata-", (directory) => {
    writeFixtureFile(directory, "opencode.json", "before\n", 0o600);

    const changedManifest = fixedPlan(directory);
    changedManifest.manifestContent = changedManifest.manifestContent.replace(
      `\"version\": \"${ORCHESTRATOR_PACKAGE_VERSION}\"`,
      '\"version\": \"9.9.9\"',
    );
    assertManifestError("PLAN_STALE", () =>
      prepareInstallationBackup(changedManifest),
    );

    const changedFile = fixedPlan(directory);
    changedFile.files[0].absolutePath = `${directory}-outside-file`;
    assertManifestError("PLAN_STALE", () =>
      prepareInstallationBackup(changedFile),
    );

    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
    assert.equal(existsSync(`${directory}-outside-file`), false);
  });
});

test("cleans partial backup state when backup integrity verification fails", () => {
  withTemporaryDirectory("orchestrator-manifest-cleanup-", (directory) => {
    writeFixtureFile(directory, "opencode.json", "before\n", 0o600);
    const plan = fixedPlan(directory);
    plan.files[0].previousContent[0] ^= 0xff;

    assertManifestError("BACKUP_INTEGRITY_FAILED", () =>
      prepareInstallationBackup(plan),
    );
    assert.equal(existsSync(join(directory, INSTALLATION_CONTROL_DIRECTORY)), false);
    assert.equal(readFileSync(join(directory, "opencode.json"), "utf8"), "before\n");
  });
});

test("rejects unsafe, duplicate, and symbolic-link managed paths", () => {
  withTemporaryDirectory("orchestrator-manifest-paths-", (directory) => {
    for (const path of [
      "../outside.txt",
      "/absolute.txt",
      ".automation-plugin/manifest.json",
      "folder\\file.txt",
    ]) {
      assertManifestError("INVALID_FILE_PATH", () =>
        planInstallationPreparation(directory, [
          {
            path,
            source: "generated/test",
            strategy: "generate",
            content: "value",
          },
        ]),
      );
    }

    assertManifestError("DUPLICATE_FILE", () =>
      planInstallationPreparation(directory, [
        {
          path: "same.txt",
          source: "generated/one",
          strategy: "generate",
          content: "one",
        },
        {
          path: "same.txt",
          source: "generated/two",
          strategy: "generate",
          content: "two",
        },
      ]),
    );

    const outside = writeFixtureFile(directory, "outside.txt", "outside\n");
    symlinkSync(outside, join(directory, "linked.txt"));
    assertManifestError("FILE_SYMLINK", () =>
      planInstallationPreparation(directory, [
        {
          path: "linked.txt",
          source: "generated/link",
          strategy: "generate",
          content: "replacement",
        },
      ]),
    );

    mkdirSync(join(directory, "real-parent"));
    symlinkSync(join(directory, "real-parent"), join(directory, "linked-parent"));
    assertManifestError("FILE_SYMLINK", () =>
      planInstallationPreparation(directory, [
        {
          path: "linked-parent/file.txt",
          source: "generated/link-parent",
          strategy: "generate",
          content: "replacement",
        },
      ]),
    );
  });
});

test("marks a manifest installed only after every file and backup verifies", () => {
  withTemporaryDirectory("orchestrator-manifest-complete-", (directory) => {
    writeFixtureFile(directory, "opencode.json", "before\n", 0o600);
    const plan = fixedPlan(directory);
    prepareInstallationBackup(plan);

    assertManifestError("INSTALLATION_INCOMPLETE", () =>
      completeInstallationManifest(directory, { installedAt }),
    );

    writePlannedFiles(plan);
    const manifest = completeInstallationManifest(directory, { installedAt });
    assert.equal(manifest.installation.state, "installed");
    assert.equal(manifest.installation.installedAt, installedAt);

    const report = verifyInstallationIntegrity(directory);
    assert.equal(report.ok, true);
    assert.ok(report.checks.every((check) => check.installed === "match"));
    assertManifestError("MANIFEST_STATE", () =>
      completeInstallationManifest(directory, { installedAt }),
    );
  });
});

test("applies managed files and completes the manifest after verification", () => {
  withTemporaryDirectory("orchestrator-manifest-apply-", (directory) => {
    writeFixtureFile(directory, "opencode.json", "before\n", 0o600);
    const plan = fixedPlan(directory);
    let verificationCount = 0;

    const applied = applyInstallationPlan(plan, {
      installedAt,
      verify: () => {
        verificationCount += 1;
        assert.equal(
          readInstallationManifest(directory).installation.state,
          "prepared",
        );
        assert.equal(
          readFileSync(join(directory, "opencode.json"), "utf8"),
          inputs()[1].content,
        );
      },
    });

    assert.equal(verificationCount, 1);
    assert.equal(applied.manifest.installation.state, "installed");
    assert.equal(applied.writtenFileCount, 2);
    assert.equal(applied.reusedFileCount, 0);
    assert.equal(
      lstatSync(join(directory, "scripts/automation/preflight.sh")).mode & 0o777,
      0o755,
    );
    assert.equal(verifyInstallationIntegrity(directory).ok, true);
  });
});

test("automatically rolls managed files back when verification fails", () => {
  withTemporaryDirectory("orchestrator-manifest-apply-rollback-", (directory) => {
    const original = "before\n";
    writeFixtureFile(directory, "opencode.json", original, 0o600);
    const plan = fixedPlan(directory);
    const verificationFailure = new Error("verification fixture failed");

    assert.throws(
      () =>
        applyInstallationPlan(plan, {
          verify: () => {
            throw verificationFailure;
          },
        }),
      (error) => error === verificationFailure,
    );

    assert.equal(readFileSync(join(directory, "opencode.json"), "utf8"), original);
    assert.equal(existsSync(join(directory, "scripts")), false);
    assert.equal(
      existsSync(join(directory, INSTALLATION_MANIFEST_RELATIVE_PATH)),
      false,
    );
    assert.equal(
      existsSync(
        join(
          directory,
          ".automation-plugin/history/install-test-001.rolled-back.json",
        ),
      ),
      true,
    );
    assert.equal(
      existsSync(
        join(
          directory,
          ".automation-plugin/backups/install-test-001/opencode.json",
        ),
      ),
      true,
    );
  });
});

test("detects a tampered backup before installation completion", () => {
  withTemporaryDirectory("orchestrator-manifest-tamper-", (directory) => {
    writeFixtureFile(directory, "opencode.json", "before\n", 0o600);
    const plan = fixedPlan(directory);
    prepareInstallationBackup(plan);
    writePlannedFiles(plan);
    writeFixtureFile(
      directory,
      ".automation-plugin/backups/install-test-001/opencode.json",
      "tampered\n",
      0o600,
    );

    const report = verifyInstallationIntegrity(directory);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].backup, "mismatch");
    assertManifestError("BACKUP_INTEGRITY_FAILED", () =>
      completeInstallationManifest(directory, { installedAt }),
    );
    assert.equal(readInstallationManifest(directory).installation.state, "prepared");
  });
});

test("rolls a partially applied prepared installation back to original hashes", () => {
  withTemporaryDirectory("orchestrator-manifest-rollback-", (directory) => {
    const original = "before\n";
    writeFixtureFile(directory, "opencode.json", original, 0o600);
    const plan = fixedPlan(directory);
    prepareInstallationBackup(plan);
    writePlannedFiles(plan);

    const manifest = rollbackPreparedInstallation(directory, { rolledBackAt });
    const historyPath = join(
      directory,
      ".automation-plugin/history/install-test-001.rolled-back.json",
    );

    assert.equal(manifest.installation.state, "rolledBack");
    assert.equal(manifest.installation.rolledBackAt, rolledBackAt);
    assert.equal(readFileSync(join(directory, "opencode.json"), "utf8"), original);
    assert.equal(lstatSync(join(directory, "opencode.json")).mode & 0o777, 0o600);
    assert.equal(
      existsSync(join(directory, "scripts/automation/preflight.sh")),
      false,
    );
    assert.equal(
      existsSync(join(directory, INSTALLATION_MANIFEST_RELATIVE_PATH)),
      false,
    );
    assert.equal(JSON.parse(readFileSync(historyPath, "utf8")).installation.state, "rolledBack");
    assert.equal(
      existsSync(
        join(
          directory,
          ".automation-plugin/backups/install-test-001/opencode.json",
        ),
      ),
      true,
    );
  });
});

test("rollback refuses user-modified paths before restoring anything", () => {
  withTemporaryDirectory("orchestrator-manifest-rollback-guard-", (directory) => {
    const original = "before\n";
    writeFixtureFile(directory, "opencode.json", original, 0o600);
    const plan = fixedPlan(directory);
    prepareInstallationBackup(plan);
    writePlannedFiles(plan);
    writeFixtureFile(
      directory,
      "scripts/automation/preflight.sh",
      "user modification\n",
      0o755,
    );

    assertManifestError("TARGET_MODIFIED", () =>
      rollbackPreparedInstallation(directory, { rolledBackAt }),
    );
    assert.equal(
      readFileSync(join(directory, "opencode.json"), "utf8"),
      inputs()[1].content,
      "preflight failure must prevent partial restoration",
    );
    assert.equal(readInstallationManifest(directory).installation.state, "prepared");
  });
});

test("ships a portable JSON Schema for installation manifests", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../templates/installation-manifest.schema.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    schema.$id,
    "urn:frankzhang2026:opencode-android-orchestrator:installation-manifest:v1",
  );
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.installation.properties.state.enum, [
    "prepared",
    "installed",
    "rolledBack",
  ]);
});
