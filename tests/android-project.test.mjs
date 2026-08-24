import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { detectAndroidProject, runDoctor } from "../dist/index.js";

function writeFixtureFile(root, relativePath, contents, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

function createKotlinFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-android-kts-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "fixture"\ninclude(\n    ":app",\n    ":feature:profile",\n)\n',
  );
  writeFixtureFile(
    root,
    "gradle/libs.versions.toml",
    '[plugins]\nandroid-application = { id = "com.android.application", version = "8.9.1" }\n',
  );
  writeFixtureFile(
    root,
    "app/build.gradle.kts",
    "plugins { alias(libs.plugins.android.application) }\n",
  );
  writeFixtureFile(
    root,
    "feature/profile/build.gradle.kts",
    'plugins { id("com.android.library") }\n',
  );
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=https\\://services.gradle.org/distributions/gradle.zip\n",
  );
  return root;
}

test("detects a Kotlin DSL multi-module Android project from a module directory", () => {
  const root = createKotlinFixture();
  try {
    const detection = detectAndroidProject(join(root, "app"));

    assert.equal(detection.gitRoot, root);
    assert.equal(detection.projectRoot, root);
    assert.equal(detection.dsl, "kotlin");
    assert.equal(detection.isGitRepository, true);
    assert.equal(detection.isAndroidProject, true);
    assert.equal(detection.gradleWrapper.complete, true);
    assert.equal(detection.gradleWrapper.executable, true);
    assert.deepEqual(
      detection.modules.map(({ gradlePath, type }) => ({ gradlePath, type })),
      [
        { gradlePath: ":app", type: "application" },
        { gradlePath: ":feature:profile", type: "library" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects Groovy DSL modules with a custom projectDir mapping", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-android-groovy-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFixtureFile(
      root,
      "settings.gradle",
      "include ':mobile', ':shared'\nproject(':mobile').projectDir = file('android-app')\n",
    );
    writeFixtureFile(
      root,
      "android-app/build.gradle",
      "apply plugin: 'com.android.application'\n",
    );
    writeFixtureFile(
      root,
      "shared/build.gradle",
      "plugins { id 'com.android.library' }\n",
    );
    writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
    writeFixtureFile(
      root,
      "gradle/wrapper/gradle-wrapper.properties",
      "distributionUrl=fixture\n",
    );

    const detection = detectAndroidProject(root);
    assert.equal(detection.dsl, "groovy");
    assert.equal(detection.isAndroidProject, true);
    assert.equal(detection.modules[0].directory, join(root, "android-app"));
    assert.deepEqual(
      detection.modules.map((module) => module.type),
      ["application", "library"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects an Android plugin applied directly to the Gradle root project", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-android-root-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFixtureFile(
      root,
      "settings.gradle.kts",
      'rootProject.name = "root-app"\n',
    );
    writeFixtureFile(
      root,
      "build.gradle.kts",
      'plugins { id("com.android.application") }\n',
    );
    writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
    writeFixtureFile(
      root,
      "gradle/wrapper/gradle-wrapper.properties",
      "distributionUrl=fixture\n",
    );

    const detection = detectAndroidProject(root);
    assert.equal(detection.isAndroidProject, true);
    assert.deepEqual(
      detection.modules.map(({ gradlePath, type }) => ({ gradlePath, type })),
      [{ gradlePath: ":", type: "application" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a directory that is neither Git nor an Android Gradle project", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-not-android-"));
  try {
    const detection = detectAndroidProject(root);
    assert.equal(detection.isGitRepository, false);
    assert.equal(detection.isAndroidProject, false);
    assert.match(detection.errors.join("\n"), /No Git root/);
    assert.match(detection.errors.join("\n"), /No settings\.gradle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor combines OpenCode and Android project checks", () => {
  const root = createKotlinFixture();
  try {
    const report = runDoctor({
      targetDirectory: root,
      runCommand: () => ({
        status: 0,
        stdout: "1.14.22",
        stderr: "",
        error: null,
      }),
    });

    assert.equal(report.ok, true);
    assert.deepEqual(
      report.checks.map(({ id, status }) => ({ id, status })),
      [
        { id: "opencode-version", status: "pass" },
        { id: "git-root", status: "pass" },
        { id: "android-project", status: "pass" },
        { id: "gradle-wrapper", status: "pass" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
