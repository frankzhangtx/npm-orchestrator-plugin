import assert from "node:assert/strict";
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
  INSTALLATION_CONTROL_DIRECTORY,
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  ORCHESTRATOR_PLUGIN_REFERENCE,
  SUPERPOWERS_PLUGIN_REFERENCE,
  InstallationManifestError,
  ProjectInitializationError,
  planProjectInitialization,
  readInstallationManifest,
  runProjectInitialization,
  verifyInstallationIntegrity,
} from "../dist/index.js";

const preparedAt = "2026-08-24T09:00:00.000Z";
const installedAt = "2026-08-24T09:05:00.000Z";

function writeFixtureFile(root, relativePath, content, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
  return path;
}

function addWrapper(root) {
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=fixture\n",
  );
}

function createKotlinFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-init-kotlin-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "Init Kotlin"\ninclude(":mobile")\nproject(":mobile").projectDir = file("clients/mobile")\n',
  );
  writeFixtureFile(
    root,
    "clients/mobile/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid {\n    namespace = "dev.init.kotlin"\n    defaultConfig { applicationId = "dev.init.kotlin" }\n}\n',
  );
  addWrapper(root);
  return root;
}

function createGroovyFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-init-groovy-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle",
    "rootProject.name = 'Init Groovy'\ninclude ':app'\nproject(':app').projectDir = file('android-app')\n",
  );
  writeFixtureFile(
    root,
    "android-app/build.gradle",
    "apply plugin: 'com.android.application'\nandroid {\n    namespace 'dev.init.groovy'\n    defaultConfig { applicationId 'dev.init.groovy' }\n}\n",
  );
  addWrapper(root);
  return root;
}

function createMultiApplicationFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-init-multi-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "Init Multi"\ninclude(":phone", ":tablet")\n',
  );
  writeFixtureFile(
    root,
    "phone/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid { namespace = "dev.init.phone" }\n',
  );
  writeFixtureFile(
    root,
    "tablet/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid { namespace = "dev.init.tablet" }\n',
  );
  addWrapper(root);
  return root;
}

function commandResult(status, stdout = "", stderr = "", error = null) {
  return { status, stdout, stderr, error };
}

function successfulRunner(calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    if (executable === "opencode" && args.length === 1 && args[0] === "--version") {
      return commandResult(0, "1.14.22\n");
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

function initOptions(runner, installationId) {
  return {
    processRunner: runner,
    androidSdkDirectory: tmpdir(),
    installationId,
    preparedAt,
    installedAt,
  };
}

test("plans and installs all managed resources in a Kotlin DSL project", () => {
  const root = createKotlinFixture();
  try {
    const originalAgents = "# Existing project rules\n\nKeep this section.\n";
    const originalOpenCode = '{\n  // keep this setting\n  "theme": "system",\n}\n';
    writeFixtureFile(root, "AGENTS.md", originalAgents, 0o644);
    writeFixtureFile(root, "opencode.jsonc", originalOpenCode, 0o600);
    const calls = [];
    const runner = successfulRunner(calls);

    const plan = planProjectInitialization(
      join(root, "clients/mobile"),
      initOptions(runner, "init-kotlin-plan-001"),
    );
    assert.equal(plan.targetDirectory, root);
    assert.equal(plan.installation.files.length, 45);
    assert.equal(
      existsSync(join(root, INSTALLATION_CONTROL_DIRECTORY)),
      false,
      "planning must be read-only",
    );

    const result = runProjectInitialization(
      join(root, "clients/mobile"),
      initOptions(runner, "init-kotlin-001"),
    );

    assert.equal(result.status, "installed");
    assert.equal(result.targetDirectory, root);
    assert.equal(result.moduleScope, "all");
    assert.equal(result.primaryModule, ":mobile");
    assert.equal(result.managedFileCount, 45);
    assert.equal(result.writtenFileCount, 45);
    assert.equal(result.reusedFileCount, 0);
    assert.equal(result.doctor.ok, true);
    assert.equal(result.verification.ok, true);
    assert.deepEqual(
      result.verification.checks.map(({ id, status }) => ({ id, status })),
      [
        { id: "automation-tests", status: "pass" },
        { id: "shadow-run", status: "pass" },
      ],
    );

    const automationConfig = JSON.parse(
      readFileSync(join(root, "automation/config.json"), "utf8"),
    );
    assert.equal(automationConfig.androidProject.name, "Init Kotlin");
    assert.equal(automationConfig.androidProject.moduleScope, "all");
    assert.equal(automationConfig.androidProject.primaryModule, ":mobile");
    assert.deepEqual(automationConfig.androidProject.productionPaths, [
      "clients/mobile/src/main/**",
    ]);
    assert.deepEqual(automationConfig.gradleVerification, {
      fullUnitTestTasks: ["testDebugUnitTest"],
      focusedTestTasks: ["testDebugUnitTest"],
      assembleTasks: ["assembleDebug"],
      lintTasks: ["lint"],
      deviceTestTasks: ["connectedDebugAndroidTest"],
    });
    const taskExample = JSON.parse(
      readFileSync(
        join(root, "automation/tasks/TASK-TEMPLATE.json.example"),
        "utf8",
      ),
    );
    assert.deepEqual(taskExample.targetTests, [
      {
        gradleTask: "testDebugUnitTest",
        filter: "dev.init.kotlin.ReplaceWithFocusedTest",
      },
    ]);

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith(originalAgents + "\n"));
    assert.match(agents, /opencode-android-orchestrator:begin/);
    const openCode = readFileSync(join(root, "opencode.jsonc"), "utf8");
    assert.match(openCode, /\/\/ keep this setting/);
    assert.deepEqual(parse(openCode).plugin, [
      SUPERPOWERS_PLUGIN_REFERENCE,
      ORCHESTRATOR_PLUGIN_REFERENCE,
    ]);
    assert.equal(
      lstatSync(join(root, "scripts/automation/preflight.sh")).mode & 0o777,
      0o755,
    );
    assert.equal(
      lstatSync(join(root, "scripts/automation/tests/run-tests.sh")).mode & 0o777,
      0o755,
    );
    assert.equal(readInstallationManifest(root).installation.state, "installed");
    assert.equal(verifyInstallationIntegrity(root).ok, true);
    assert.equal(calls.length, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installs a multi-application project in all-module mode without primary selection", () => {
  const root = createMultiApplicationFixture();
  try {
    const result = runProjectInitialization(
      root,
      initOptions(successfulRunner(), "init-multi-001"),
    );
    const taskExample = JSON.parse(
      readFileSync(
        join(root, "automation/tasks/TASK-TEMPLATE.json.example"),
        "utf8",
      ),
    );

    assert.equal(result.status, "installed");
    assert.equal(result.moduleScope, "all");
    assert.equal(result.primaryModule, ":phone");
    assert.ok(taskExample.allowedPaths.includes("phone/src/main/**"));
    assert.ok(taskExample.allowedPaths.includes("tablet/src/main/**"));
    assert.ok(taskExample.allowedPaths.includes("phone/src/test/**"));
    assert.ok(taskExample.allowedPaths.includes("tablet/src/androidTest/**"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated init is byte-idempotent for an unchanged installation", () => {
  const root = createKotlinFixture();
  try {
    const calls = [];
    const runner = successfulRunner(calls);
    const options = initOptions(runner, "init-idempotent-001");
    const first = runProjectInitialization(root, options);
    const manifestBefore = readFileSync(
      join(root, INSTALLATION_MANIFEST_RELATIVE_PATH),
      "utf8",
    );
    const configBefore = readFileSync(join(root, "automation/config.json"));

    const repeated = runProjectInitialization(root, options);

    assert.equal(first.status, "installed");
    assert.equal(repeated.status, "already-installed");
    assert.equal(repeated.writtenFileCount, 0);
    assert.equal(repeated.reusedFileCount, 45);
    assert.equal(
      readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH), "utf8"),
      manifestBefore,
    );
    assert.deepEqual(
      readFileSync(join(root, "automation/config.json")),
      configBefore,
    );
    assert.equal(calls.length, 16, "prerequisites and verifiers run each time");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installs dynamic resources in a Groovy DSL project", () => {
  const root = createGroovyFixture();
  try {
    const result = runProjectInitialization(
      root,
      initOptions(successfulRunner(), "init-groovy-001"),
    );
    const config = JSON.parse(
      readFileSync(join(root, "automation/config.json"), "utf8"),
    );

    assert.equal(result.status, "installed");
    assert.equal(result.moduleScope, "all");
    assert.equal(result.primaryModule, ":app");
    assert.equal(config.androidProject.gradleDsl, "groovy");
    assert.equal(config.androidProject.modules[0].directory, "android-app");
    assert.deepEqual(config.androidProject.testPaths, [
      "android-app/src/test/**",
      "android-app/src/androidTest/**",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init fails dependency checks before creating installation state", () => {
  const root = createKotlinFixture();
  try {
    const baseRunner = successfulRunner();
    const runner = (executable, args, options) =>
      executable === "java"
        ? commandResult(null, "", "", "java fixture is missing")
        : baseRunner(executable, args, options);

    assert.throws(
      () =>
        runProjectInitialization(
          root,
          initOptions(runner, "init-dependency-failure-001"),
        ),
      (error) =>
        error instanceof ProjectInitializationError &&
        error.code === "DOCTOR_FAILED" &&
        error.details.some((detail) => detail.includes("Java command")),
    );
    assert.equal(existsSync(join(root, INSTALLATION_CONTROL_DIRECTORY)), false);
    assert.equal(existsSync(join(root, ".opencode")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init stops on a template conflict before creating control state", () => {
  const root = createKotlinFixture();
  try {
    const userContent = "user-owned agent\n";
    writeFixtureFile(
      root,
      ".opencode/agents/scheduled-coder.md",
      userContent,
      0o644,
    );
    const calls = [];

    assert.throws(
      () =>
        runProjectInitialization(
          root,
          initOptions(successfulRunner(calls), "init-conflict-001"),
        ),
      (error) =>
        error instanceof InstallationManifestError &&
        error.code === "FILE_CONFLICT",
    );
    assert.equal(
      readFileSync(
        join(root, ".opencode/agents/scheduled-coder.md"),
        "utf8",
      ),
      userContent,
    );
    assert.equal(existsSync(join(root, ".opencode/commands")), false);
    assert.equal(existsSync(join(root, INSTALLATION_CONTROL_DIRECTORY)), false);
    assert.equal(calls.length, 6, "only pre-install prerequisites run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init restores original files when post-install verification fails", () => {
  const root = createKotlinFixture();
  try {
    const originalAgents = "# User rules\n";
    const originalOpenCode = '{ "theme": "system" }\n';
    writeFixtureFile(root, "AGENTS.md", originalAgents, 0o644);
    writeFixtureFile(root, "opencode.json", originalOpenCode, 0o600);
    const runner = (executable, args, options) => {
      if (executable === "opencode" && args.length === 1 && args[0] === "--version") {
        return commandResult(0, "1.15.13\n");
      }
      if (args.length === 1 && ["--version", "-version"].includes(args[0])) {
        return commandResult(0, `${executable} fixture version\n`);
      }
      if (executable.endsWith("scripts/automation/tests/run-tests.sh")) {
        return commandResult(1, "not ok 1 - fixture\n", "fixture failure\n");
      }
      if (executable.endsWith("scripts/automation/shadow-run.sh")) {
        return commandResult(
          0,
          `${JSON.stringify({ mutationPerformed: false })}\n`,
        );
      }
      return commandResult(1, "", `unexpected command in ${options.cwd}`);
    };

    assert.throws(
      () =>
        runProjectInitialization(
          root,
          initOptions(runner, "init-verification-failure-001"),
        ),
      (error) =>
        error instanceof ProjectInitializationError &&
        error.code === "POST_INSTALL_VERIFICATION_FAILED",
    );

    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), originalAgents);
    assert.equal(
      readFileSync(join(root, "opencode.json"), "utf8"),
      originalOpenCode,
    );
    assert.equal(existsSync(join(root, ".opencode")), false);
    assert.equal(existsSync(join(root, "automation")), false);
    assert.equal(existsSync(join(root, "scripts")), false);
    assert.equal(existsSync(join(root, "docs")), false);
    assert.equal(
      existsSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH)),
      false,
    );
    assert.equal(
      existsSync(
        join(
          root,
          ".automation-plugin/history/init-verification-failure-001.rolled-back.json",
        ),
      ),
      true,
    );
    assert.equal(
      existsSync(
        join(
          root,
          ".automation-plugin/backups/init-verification-failure-001/AGENTS.md",
        ),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
