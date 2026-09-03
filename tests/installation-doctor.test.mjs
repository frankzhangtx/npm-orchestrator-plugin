import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_MANAGED_FILE_COUNT,
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  formatDoctorReport,
  readInstallationManifest,
  runDoctor,
  runProjectInitialization,
  verifyInstallationIntegrity,
} from "../dist/index.js";

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

function successfulCommandRunner(executable, args) {
  if (executable === "opencode" && args[0] === "--version") {
    return commandResult(0, "1.15.13\n");
  }
  if (executable.endsWith("scripts/automation/tests/run-tests.sh")) {
    return commandResult(0, "ok 44 - fixture\n1..44\n");
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
}

function createInstalledFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-installed-doctor-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "Doctor Fixture"\ninclude(":mobile")\nproject(":mobile").projectDir = file("clients/mobile")\n',
  );
  writeFixtureFile(
    root,
    "clients/mobile/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid {\n    namespace = "dev.doctor.fixture"\n    defaultConfig { applicationId = "dev.doctor.fixture" }\n}\n',
  );
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=fixture\n",
  );
  writeFixtureFile(root, "AGENTS.md", "# Existing project rules\n", 0o644);
  writeFixtureFile(
    root,
    "opencode.jsonc",
    '{\n  // keep user configuration\n  "theme": "system",\n}\n',
    0o600,
  );

  const sdk = join(root, "fixture-sdk");
  mkdirSync(join(sdk, "platforms"), { recursive: true });
  mkdirSync(join(sdk, "build-tools"), { recursive: true });
  writeFixtureFile(root, "local.properties", `sdk.dir=${sdk}\n`, 0o600);
  runProjectInitialization(root, {
    androidSdkDirectory: sdk,
    installationId: "installed-doctor-001",
    preparedAt: "2026-08-24T10:00:00.000Z",
    installedAt: "2026-08-24T10:05:00.000Z",
    processRunner: successfulCommandRunner,
  });
  return { root, sdk };
}

function installedDoctor(root, overrides = {}) {
  return runDoctor({
    checkDependencies: true,
    checkInstallation: true,
    environment: {},
    runCommand: successfulCommandRunner,
    targetDirectory: join(root, "clients/mobile"),
    ...overrides,
  });
}

function check(report, id) {
  const result = report.checks.find((candidate) => candidate.id === id);
  assert.ok(result, `missing doctor check: ${id}`);
  return result;
}

test("installed doctor validates dependencies, inventory, files, modes, backups, and configuration", () => {
  const { root } = createInstalledFixture();
  try {
    const report = installedDoctor(root);

    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 15);
    assert.equal(report.checks.every((candidate) => candidate.status === "pass"), true);
    assert.match(
      check(report, "installation-manifest").summary,
      new RegExp(`tracks ${EXPECTED_MANAGED_FILE_COUNT} installed files`),
    );
    assert.match(check(report, "managed-permissions").summary, /29 automation scripts/);
    assert.match(check(report, "managed-configuration").summary, /consistent/);
    assert.match(formatDoctorReport(report), /Result: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor accepts repository verification-policy changes", () => {
  const { root } = createInstalledFixture();
  try {
    const path = join(root, "automation/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.unitTestsEnabled = false;
    config.lintEnabled = true;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

    assert.equal(verifyInstallationIntegrity(root).ok, true);
    const report = installedDoctor(root);

    assert.equal(report.ok, true);
    assert.equal(check(report, "managed-resources").status, "pass");
    assert.equal(check(report, "managed-configuration").status, "pass");
    assert.match(
      check(report, "managed-configuration").details.join("\n"),
      /Unit-test verification: disabled[\s\S]*Android lint verification: enabled/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed integrity rejects non-boolean verification-policy changes", () => {
  const { root } = createInstalledFixture();
  try {
    const path = join(root, "automation/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.lintEnabled = "true";
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

    assert.equal(verifyInstallationIntegrity(root).ok, false);
    const report = installedDoctor(root);
    assert.equal(check(report, "managed-resources").status, "fail");
    assert.equal(check(report, "managed-configuration").status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor reports content and executable-mode drift separately", () => {
  const { root } = createInstalledFixture();
  try {
    writeFileSync(
      join(root, ".opencode/agents/scheduled-coder.md"),
      "locally modified agent\n",
    );
    chmodSync(join(root, "scripts/automation/preflight.sh"), 0o644);

    const report = installedDoctor(root);

    assert.equal(report.ok, false);
    assert.equal(check(report, "installation-manifest").status, "pass");
    assert.equal(check(report, "managed-resources").status, "fail");
    assert.match(
      check(report, "managed-resources").details.join("\n"),
      /scheduled-coder\.md/,
    );
    assert.equal(check(report, "managed-permissions").status, "fail");
    assert.match(
      check(report, "managed-permissions").details.join("\n"),
      /preflight\.sh: mode 0644; expected 0755/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor detects unsafe adaptive configuration even when it is valid JSON", () => {
  const { root } = createInstalledFixture();
  try {
    const path = join(root, "automation/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.pushAfterAcceptance = true;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

    const report = installedDoctor(root);

    assert.equal(check(report, "managed-resources").status, "fail");
    assert.equal(check(report, "managed-configuration").status, "fail");
    assert.match(
      check(report, "managed-configuration").details.join("\n"),
      /safe defaults/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor verifies original-file backups independently", () => {
  const { root } = createInstalledFixture();
  try {
    const manifest = readInstallationManifest(root);
    const agents = manifest.files.find((file) => file.path === "AGENTS.md");
    assert.ok(agents?.previous.backupPath);
    unlinkSync(join(root, ...agents.previous.backupPath.split("/")));

    const report = installedDoctor(root);

    assert.equal(check(report, "managed-resources").status, "pass");
    assert.equal(check(report, "managed-permissions").status, "pass");
    assert.equal(check(report, "installation-backups").status, "fail");
    assert.match(
      check(report, "installation-backups").details.join("\n"),
      /AGENTS\.md: backup is missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor fails closed for a missing manifest", () => {
  const { root } = createInstalledFixture();
  try {
    unlinkSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH));

    const report = installedDoctor(root);

    assert.equal(report.ok, false);
    assert.equal(check(report, "installation-manifest").status, "fail");
    for (const id of [
      "managed-resources",
      "managed-permissions",
      "installation-backups",
      "managed-configuration",
    ]) {
      assert.equal(check(report, id).status, "fail");
      assert.match(check(report, id).details.join("\n"), /does not exist/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor rejects a self-consistent manifest rewrite of a packaged resource", () => {
  const { root } = createInstalledFixture();
  try {
    const managedPath = ".opencode/agents/scheduled-coder.md";
    const changed = Buffer.from("rewritten managed resource\n");
    writeFileSync(join(root, managedPath), changed);
    const manifestPath = join(root, INSTALLATION_MANIFEST_RELATIVE_PATH);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.files.find((file) => file.path === managedPath);
    assert.ok(entry);
    entry.sha256 = createHash("sha256").update(changed).digest("hex");
    entry.size = changed.byteLength;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = installedDoctor(root);

    assert.equal(check(report, "installation-manifest").status, "fail");
    assert.match(
      check(report, "installation-manifest").details.join("\n"),
      /does not match the packaged 0\.7\.0 template/,
    );
    assert.equal(
      check(report, "managed-resources").status,
      "pass",
      "resource hashes alone cannot authenticate a rewritten manifest",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor reports missing commands and an unavailable SDK", () => {
  const { root } = createInstalledFixture();
  try {
    const report = installedDoctor(root, {
      androidSdkDirectory: join(root, "missing-sdk"),
      runCommand: (executable, args) =>
        executable === "java"
          ? commandResult(null, "", "", "spawn java ENOENT")
          : successfulCommandRunner(executable, args),
    });

    assert.equal(report.ok, false);
    assert.equal(check(report, "java-command").status, "fail");
    assert.match(check(report, "java-command").details.join("\n"), /ENOENT/);
    assert.equal(check(report, "android-sdk").status, "fail");
    assert.match(check(report, "android-sdk").summary, /unavailable or unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor CLI enables installation checks in JSON mode and exits unsuccessfully", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    unlinkSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH));
    const fakeBin = join(root, "fake-bin");
    for (const executable of ["opencode", "git", "jq", "rg", "shasum", "java"]) {
      writeFixtureFile(
        root,
        `fake-bin/${executable}`,
        "#!/bin/sh\necho 1.15.13\n",
        0o755,
      );
    }
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cli, "doctor", join(root, "clients/mobile"), "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ANDROID_HOME: sdk,
          PATH: fakeBin,
        },
      },
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(check(report, "git-command").status, "pass");
    assert.equal(check(report, "installation-manifest").status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
