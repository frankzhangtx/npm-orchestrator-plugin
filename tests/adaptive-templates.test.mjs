import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  AdaptiveProjectTemplateError,
  planAdaptiveProjectTemplates,
} from "../dist/index.js";

function writeFixtureFile(root, relativePath, contents, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

function addWrapper(root) {
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=fixture\n",
  );
}

function listFixture(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = join(prefix, entry.name);
      return entry.isDirectory()
        ? [relativePath, ...listFixture(root, relativePath)]
        : [relativePath];
    },
  );
}

function createAdaptiveKotlinFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-adaptive-kts-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "Adaptive Fixture"\ninclude(":mobile", ":feature:profile")\nproject(":mobile").projectDir = file("clients/mobile")\n',
  );
  writeFixtureFile(
    root,
    "clients/mobile/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid {\n    namespace = "dev.adaptive.mobile"\n    defaultConfig { applicationId = "dev.adaptive.mobile" }\n}\n',
  );
  writeFixtureFile(
    root,
    "feature/profile/build.gradle.kts",
    'plugins { id("com.android.library") }\nandroid { namespace = "dev.adaptive.profile" }\n',
  );
  addWrapper(root);
  return root;
}

test("renders portable configuration and a focused task example from Kotlin project metadata", () => {
  const root = createAdaptiveKotlinFixture();
  try {
    const before = listFixture(root);
    const plan = planAdaptiveProjectTemplates(join(root, "clients/mobile"));

    assert.deepEqual(listFixture(root), before, "render planning must be read-only");
    assert.equal(plan.projectRoot, root);
    assert.equal(plan.primaryModule.gradlePath, ":mobile");
    assert.deepEqual(plan.automationConfig.plugins, {
      superpowers:
        "superpowers@git+https://github.com/obra/superpowers.git#v6.2.0",
    });
    assert.deepEqual(plan.automationConfig.androidProject, {
      name: "Adaptive Fixture",
      gradleDsl: "kotlin",
      settingsFile: "settings.gradle.kts",
      primaryModule: ":mobile",
      modules: [
        {
          gradlePath: ":feature:profile",
          directory: "feature/profile",
          buildFile: "feature/profile/build.gradle.kts",
          dsl: "kotlin",
          type: "library",
          namespace: "dev.adaptive.profile",
          applicationId: null,
        },
        {
          gradlePath: ":mobile",
          directory: "clients/mobile",
          buildFile: "clients/mobile/build.gradle.kts",
          dsl: "kotlin",
          type: "application",
          namespace: "dev.adaptive.mobile",
          applicationId: "dev.adaptive.mobile",
        },
      ],
      productionPaths: [
        "feature/profile/src/main/**",
        "clients/mobile/src/main/**",
      ],
      testPaths: [
        "feature/profile/src/test/**",
        "feature/profile/src/androidTest/**",
        "clients/mobile/src/test/**",
        "clients/mobile/src/androidTest/**",
      ],
    });
    assert.ok(
      plan.automationConfig.protectedPaths.includes(
        "clients/mobile/build.gradle.kts",
      ),
    );
    assert.deepEqual(plan.taskContractExample.allowedPaths, [
      "clients/mobile/src/main/**",
      "clients/mobile/src/test/**",
      "clients/mobile/src/androidTest/**",
    ]);
    assert.deepEqual(plan.taskContractExample.targetTests, [
      "dev.adaptive.mobile.ReplaceWithFocusedTest",
    ]);
    assert.doesNotMatch(plan.automationConfigContent, /opencode-scheduler/);
    assert.doesNotMatch(plan.automationConfigContent, new RegExp(root));
    assert.equal(
      plan.automationConfigContent,
      `${JSON.stringify(plan.automationConfig, null, 2)}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires an explicit primary module when a Groovy project has multiple applications", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-adaptive-groovy-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFixtureFile(
      root,
      "settings.gradle",
      "rootProject.name = 'multi-app'\ninclude ':phone', ':tablet'\nproject(':tablet').projectDir = file('clients/tablet')\n",
    );
    writeFixtureFile(
      root,
      "phone/build.gradle",
      "apply plugin: 'com.android.application'\nandroid { namespace 'dev.adaptive.phone' }\n",
    );
    writeFixtureFile(
      root,
      "clients/tablet/build.gradle",
      "apply plugin: 'com.android.application'\nandroid { defaultConfig { applicationId 'dev.adaptive.tablet' } }\n",
    );
    addWrapper(root);

    assert.throws(
      () => planAdaptiveProjectTemplates(root),
      (error) =>
        error instanceof AdaptiveProjectTemplateError &&
        error.code === "PRIMARY_MODULE_AMBIGUOUS" &&
        error.details.includes(":phone") &&
        error.details.includes(":tablet"),
    );

    const plan = planAdaptiveProjectTemplates(root, {
      primaryModule: ":tablet",
    });
    assert.equal(plan.primaryModule.directory, "clients/tablet");
    assert.deepEqual(plan.taskContractExample.targetTests, [
      "dev.adaptive.tablet.ReplaceWithFocusedTest",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports an unknown explicit primary module without writing files", () => {
  const root = createAdaptiveKotlinFixture();
  try {
    const before = listFixture(root);
    assert.throws(
      () =>
        planAdaptiveProjectTemplates(root, {
          primaryModule: ":missing",
        }),
      (error) =>
        error instanceof AdaptiveProjectTemplateError &&
        error.code === "PRIMARY_MODULE_NOT_FOUND",
    );
    assert.deepEqual(listFixture(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks nested Gradle roots until transaction scripts support them", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-adaptive-nested-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFixtureFile(
      root,
      "android/settings.gradle.kts",
      'rootProject.name = "nested"\ninclude(":mobile")\n',
    );
    writeFixtureFile(
      root,
      "android/mobile/build.gradle.kts",
      'plugins { id("com.android.application") }\n',
    );
    addWrapper(join(root, "android"));

    assert.throws(
      () => planAdaptiveProjectTemplates(join(root, "android")),
      (error) =>
        error instanceof AdaptiveProjectTemplateError &&
        error.code === "NESTED_GRADLE_ROOT_UNSUPPORTED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a custom module directory outside the Git root", () => {
  const container = mkdtempSync(join(tmpdir(), "orchestrator-adaptive-escape-"));
  const root = join(container, "repository");
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFixtureFile(
      root,
      "settings.gradle.kts",
      'rootProject.name = "escape"\ninclude(":mobile")\nproject(":mobile").projectDir = file("../outside")\n',
    );
    writeFixtureFile(
      container,
      "outside/build.gradle.kts",
      'plugins { id("com.android.application") }\n',
    );
    addWrapper(root);

    assert.throws(
      () => planAdaptiveProjectTemplates(root),
      (error) =>
        error instanceof AdaptiveProjectTemplateError &&
        error.code === "PROJECT_PATH_OUTSIDE_GIT_ROOT",
    );
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});
