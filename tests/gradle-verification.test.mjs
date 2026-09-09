import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  GradleVerificationDiscoveryError,
  detectAndroidProject,
  discoverGradleProjectConfiguration,
  discoverGradleVerificationConfiguration,
  inferGradleVerificationConfiguration,
  parseGradleAndroidModules,
  parseGradleTaskPaths,
} from "../dist/index.js";

const marker = "OPENCODE_ANDROID_ORCHESTRATOR_TASK=";
const moduleMarker = "OPENCODE_ANDROID_ORCHESTRATOR_MODULE=";

function runtimeModuleLine({
  gradlePath,
  directory,
  buildFile,
  pluginId,
  namespace = "",
  applicationId = "",
}) {
  const fields = [
    gradlePath,
    directory,
    buildFile,
    pluginId,
    namespace,
    applicationId,
  ].map((value) => Buffer.from(value, "utf8").toString("base64"));
  return `${moduleMarker}${fields.join(",")}`;
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

function createFlavoredFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-gradle-discovery-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle",
    "rootProject.name = 'WPAndroid'\ninclude ':WordPress', ':libs:networking'\n",
  );
  writeFixtureFile(
    root,
    "gradle/libs.versions.toml",
    '[plugins]\nandroid-application = { id = "com.android.application", version = "8.9.1" }\nandroid-library = { id = "com.android.library", version = "8.9.1" }\n',
  );
  writeFixtureFile(
    root,
    "build.gradle",
    "plugins {\n    alias(libs.plugins.android.application).apply(false)\n    alias(libs.plugins.android.library).apply(false)\n}\n",
  );
  writeFixtureFile(
    root,
    "WordPress/build.gradle",
    "apply plugin: 'com.android.application'\nandroid { namespace 'org.wordpress.android' }\n",
  );
  writeFixtureFile(
    root,
    "libs/networking/build.gradle",
    "apply plugin: 'com.android.library'\nandroid { namespace 'org.wordpress.networking' }\n",
  );
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=fixture\n",
  );
  return root;
}

const flavoredTaskPaths = [
  ":WordPress:assembleDebug",
  ":WordPress:connectedJetpackDebugAndroidTest",
  ":WordPress:connectedWordpressDebugAndroidTest",
  ":WordPress:lint",
  ":WordPress:testJetpackDebugUnitTest",
  ":WordPress:testWordpressDebugUnitTest",
  ":libs:networking:assembleDebug",
  ":libs:networking:connectedDebugAndroidTest",
  ":libs:networking:lint",
  ":libs:networking:testDebugUnitTest",
];

const expectedConfiguration = {
  fullUnitTestTasks: [
    "testDebugUnitTest",
    ":WordPress:testWordpressDebugUnitTest",
    ":WordPress:testJetpackDebugUnitTest",
  ],
  focusedTestTasks: [
    ":WordPress:testWordpressDebugUnitTest",
    ":WordPress:testJetpackDebugUnitTest",
    ":libs:networking:testDebugUnitTest",
  ],
  assembleTasks: ["assembleDebug"],
  lintTasks: ["lint"],
  deviceTestTasks: [
    "connectedDebugAndroidTest",
    ":WordPress:connectedWordpressDebugAndroidTest",
    ":WordPress:connectedJetpackDebugAndroidTest",
  ],
};

test("ignores root plugin aliases declared with apply(false)", () => {
  const root = createFlavoredFixture();
  try {
    const detection = detectAndroidProject(root);

    assert.deepEqual(
      detection.modules.map(({ gradlePath, type }) => ({ gradlePath, type })),
      [
        { gradlePath: ":WordPress", type: "application" },
        { gradlePath: ":libs:networking", type: "library" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("infers a complete flavored matrix and prefers the module-named flavor", () => {
  const root = createFlavoredFixture();
  try {
    const detection = detectAndroidProject(root);
    assert.deepEqual(
      inferGradleVerificationConfiguration(detection, flavoredTaskPaths),
      expectedConfiguration,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disables configuration cache and discovers marker output on repeated calls", () => {
  const root = createFlavoredFixture();
  const initScripts = [];
  try {
    const runner = (executable, args, options) => {
      assert.equal(executable, join(root, "gradlew"));
      assert.deepEqual(args.slice(0, 3), [
        "help",
        "--no-configuration-cache",
        "--init-script",
      ]);
      const initScript = args[3];
      assert.equal(typeof initScript, "string");
      assert.deepEqual(args.slice(4), ["--console=plain", "--quiet"]);
      assert.equal(existsSync(initScript), true);
      assert.equal(statSync(initScript).mode & 0o777, 0o600);
      assert.match(readFileSync(initScript, "utf8"), /projectsEvaluated/);
      assert.equal(options.cwd, root);
      initScripts.push(initScript);
      return {
        status: 0,
        stdout: [
          "Gradle heading that must be ignored",
          runtimeModuleLine({
            gradlePath: ":WordPress",
            directory: join(root, "WordPress"),
            buildFile: join(root, "WordPress/build.gradle"),
            pluginId: "com.android.application",
            namespace: "org.wordpress.android",
          }),
          runtimeModuleLine({
            gradlePath: ":libs:networking",
            directory: join(root, "libs/networking"),
            buildFile: join(root, "libs/networking/build.gradle"),
            pluginId: "com.android.library",
            namespace: "org.wordpress.networking",
          }),
          ...flavoredTaskPaths.map((path) => `${marker}${path}`),
          `${marker}:unsafe task`,
          "",
        ].join("\n"),
        stderr: "",
        error: null,
      };
    };

    const firstDiscovery = discoverGradleProjectConfiguration(
      root,
      runner,
    );
    const secondConfiguration = discoverGradleVerificationConfiguration(
      root,
      runner,
    );

    assert.deepEqual(firstDiscovery.gradleVerification, expectedConfiguration);
    assert.deepEqual(
      firstDiscovery.detection.modules.map(({ gradlePath, type }) => ({
        gradlePath,
        type,
      })),
      [
        { gradlePath: ":WordPress", type: "application" },
        { gradlePath: ":libs:networking", type: "library" },
      ],
    );
    assert.deepEqual(secondConfiguration, expectedConfiguration);
    assert.equal(initScripts.length, 2);
    assert.notEqual(initScripts[0], initScripts[1]);
    for (const initScript of initScripts) {
      assert.equal(existsSync(initScript), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses Gradle runtime modules for dynamic includes and convention plugins", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-runtime-modules-"));
  const gradlePaths = [
    ":app",
    ":component_me",
    ...Array.from({ length: 32 }, (_, index) =>
      `:feature_${String(index + 1).padStart(2, "0")}`,
    ),
  ];
  try {
    mkdirSync(join(root, ".git"));
    writeFixtureFile(
      root,
      "settings.gradle.kts",
      [
        'rootProject.name = "Runtime Discovery"',
        `val companyModules = listOf(${gradlePaths
          .map((path) => `"${path.slice(1)}"`)
          .join(", ")})`,
        'companyModules.forEach { include(":$it") }',
        "",
      ].join("\n"),
    );
    for (const gradlePath of gradlePaths) {
      const directory = gradlePath.slice(1);
      writeFixtureFile(
        root,
        `${directory}/build.gradle.kts`,
        'plugins { id("company.android.convention") }\n',
      );
    }
    writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
    writeFixtureFile(
      root,
      "gradle/wrapper/gradle-wrapper.properties",
      "distributionUrl=fixture\n",
    );

    assert.equal(detectAndroidProject(root).modules.length, 0);
    const runner = (_executable, _args, _options) => ({
      status: 0,
      stdout: gradlePaths
        .flatMap((gradlePath) => {
          const directory = join(root, gradlePath.slice(1));
          const pluginId =
            gradlePath === ":app"
              ? "com.android.application"
              : "com.android.library";
          return [
            runtimeModuleLine({
              gradlePath,
              directory,
              buildFile: join(directory, "build.gradle.kts"),
              pluginId,
              namespace: `dev.runtime.${gradlePath.slice(1)}`,
            }),
            `${marker}${gradlePath}:assembleDebug`,
            `${marker}${gradlePath}:connectedDebugAndroidTest`,
            `${marker}${gradlePath}:lint`,
            `${marker}${gradlePath}:testDebugUnitTest`,
          ];
        })
        .join("\n"),
      stderr: "",
      error: null,
    });

    const discovery = discoverGradleProjectConfiguration(root, runner);

    assert.equal(discovery.detection.modules.length, gradlePaths.length);
    assert.ok(
      discovery.detection.modules.some(
        ({ gradlePath }) => gradlePath === ":component_me",
      ),
    );
    assert.equal(
      discovery.gradleVerification.focusedTestTasks.length,
      gradlePaths.length,
    );
    assert.ok(
      discovery.gradleVerification.focusedTestTasks.includes(
        ":component_me:testDebugUnitTest",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed runtime module markers", () => {
  assert.deepEqual(
    parseGradleAndroidModules(
      [
        `${moduleMarker}not-base64`,
        runtimeModuleLine({
          gradlePath: ":valid",
          directory: "/project/valid",
          buildFile: "/project/valid/build.gradle.kts",
          pluginId: "com.android.library",
        }),
        runtimeModuleLine({
          gradlePath: ":invalid:",
          directory: "/project/invalid",
          buildFile: "/project/invalid/build.gradle",
          pluginId: "com.android.library",
        }),
      ].join("\n"),
    ).map(({ gradlePath }) => gradlePath),
    [":valid"],
  );
});

test("fails clearly when discovered tasks cannot form every required group", () => {
  const root = createFlavoredFixture();
  try {
    const detection = detectAndroidProject(root);
    assert.throws(
      () =>
        inferGradleVerificationConfiguration(
          detection,
          flavoredTaskPaths.filter((path) => !path.includes("connected")),
        ),
      (error) =>
        error instanceof GradleVerificationDiscoveryError &&
        error.code === "GRADLE_TASK_MATRIX_INCOMPLETE" &&
        error.details.some((detail) => detail.includes("deviceTestTasks")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes root task paths and rejects non-marker output", () => {
  assert.deepEqual(
    parseGradleTaskPaths(
      [
        "Build tasks",
        `${marker}:lint`,
        `${marker}:app:testDebugUnitTest`,
        `${marker}:app:testDebugUnitTest`,
        `${marker}:bad task`,
      ].join("\n"),
    ),
    [":app:testDebugUnitTest", "lint"],
  );
});
