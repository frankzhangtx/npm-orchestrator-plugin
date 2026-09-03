import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));

const expectedBaselineHashes = new Map([
  [
    "automation/config.json",
    "0d1412f68fc74399b5f64a269f8408a799d70a918314ede55480baa0e103a85d",
  ],
  [
    "automation/config.schema.json",
    "0e05fd74928f7ec43dfeabe411f218ea4c7ebc1a6a54a355119578f2460d68fd",
  ],
  [
    "automation/task-contract.schema.json",
    "3399b9ab137805fdf58324961f02bfeee5b4e5421cbfb4494483ba3a6af13121",
  ],
  [
    "automation/tasks/TASK-TEMPLATE.json.example",
    "f85aa38f761d9a45cab9c8210a78c2c84c3ac2862960aa88a08ca9631f07290e",
  ],
  [
    "docs/plans/README.md",
    "12620e9cc841353b17880d5cbde6362f8c0522175a430153d7004465833730e1",
  ],
]);

const agentsFragmentPath = "AGENTS.md.fragment";
const expectedAgentsFragmentHash =
  "84f320a639307e1acb44fa73eb349bd7f556542390a96c45485dad8e60a241c5";

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

function templatePath(absolutePath) {
  return relative(templatesRoot, absolutePath).split(sep).join("/");
}

function sha256(relativePath) {
  return createHash("sha256")
    .update(readFileSync(join(templatesRoot, relativePath)))
    .digest("hex");
}

function parseJson(relativePath) {
  return JSON.parse(readFileSync(join(templatesRoot, relativePath), "utf8"));
}

test("ships the complete non-historical infrastructure template inventory", () => {
  const actualPaths = [
    ...listFiles(join(templatesRoot, "automation")),
    ...listFiles(join(templatesRoot, "docs")),
    join(templatesRoot, agentsFragmentPath),
  ]
    .map(templatePath)
    .sort();
  const expectedPaths = [
    ...expectedBaselineHashes.keys(),
    agentsFragmentPath,
  ].sort();

  assert.deepEqual(actualPaths, expectedPaths);
});

test("locks the portable V3 infrastructure resources and file modes", () => {
  for (const [relativePath, expectedHash] of expectedBaselineHashes) {
    const absolutePath = join(templatesRoot, relativePath);
    assert.equal(sha256(relativePath), expectedHash, relativePath);
    assert.equal(statSync(absolutePath).mode & 0o111, 0, relativePath);
  }
});

test("keeps configuration, schemas, and contract example structurally aligned", () => {
  const config = parseJson("automation/config.json");
  const configSchema = parseJson("automation/config.schema.json");
  const contractSchema = parseJson("automation/task-contract.schema.json");
  const contractExample = parseJson(
    "automation/tasks/TASK-TEMPLATE.json.example",
  );

  assert.equal(
    config.schemaVersion,
    configSchema.properties.schemaVersion.const,
  );
  assert.equal(
    contractExample.schemaVersion,
    contractSchema.properties.schemaVersion.const,
  );
  for (const requiredProperty of contractSchema.required) {
    assert.ok(
      Object.hasOwn(contractExample, requiredProperty),
      requiredProperty,
    );
  }
  assert.equal(
    contractExample.planPath,
    "docs/plans/TASK-EXAMPLE-001.md",
  );
  assert.ok(contractExample.forbiddenPaths.includes("AGENTS.md"));
  assert.ok(
    config.protectedPaths.includes(".automation-worktree-allowlist"),
  );
  assert.ok(
    contractExample.forbiddenPaths.includes(
      ".automation-worktree-allowlist",
    ),
  );
  assert.ok(configSchema.required.includes("gradleVerification"));
  assert.ok(configSchema.required.includes("unitTestsEnabled"));
  assert.equal(config.unitTestsEnabled, true);
  assert.deepEqual(configSchema.properties.unitTestsEnabled, {
    type: "boolean",
    default: true,
  });
  assert.ok(configSchema.required.includes("lintEnabled"));
  assert.equal(config.lintEnabled, false);
  assert.deepEqual(configSchema.properties.lintEnabled, {
    type: "boolean",
    default: false,
  });
  assert.ok(configSchema.required.includes("longCommandTimeoutMs"));
  assert.equal(config.longCommandTimeoutMs, 1_800_000);
  assert.deepEqual(configSchema.properties.longCommandTimeoutMs, {
    type: "integer",
    minimum: 120_000,
    maximum: 7_200_000,
  });
  assert.equal(
    config.protectedPaths.includes("automation/config.json"),
    false,
    "the automation directory prefix already protects generated configuration",
  );
  assert.equal(
    config.approvalPhrases.resume,
    "恢复任务，重新捕获基线并继续自动执行。",
  );
  assert.ok(configSchema.required.includes("androidProject"));
  assert.equal(Object.hasOwn(config, "androidProject"), false);
  assert.deepEqual(
    configSchema.properties.androidProject.properties.moduleScope.enum,
    ["all", "primary"],
  );
  assert.equal(
    configSchema.properties.androidProject.required.includes("moduleScope"),
    false,
    "moduleScope stays optional so pre-feature V3 configurations remain valid",
  );
  assert.deepEqual(config.gradleVerification, {
    fullUnitTestTasks: ["testDebugUnitTest"],
    focusedTestTasks: ["testDebugUnitTest"],
    assembleTasks: ["assembleDebug"],
    lintTasks: ["lint"],
    deviceTestTasks: ["connectedDebugAndroidTest"],
  });
  assert.deepEqual(configSchema.properties.plugins.required, ["superpowers"]);
});

test("keeps the render sources project-independent and Scheduler-free", () => {
  const config = parseJson("automation/config.json");
  const configSchema = parseJson("automation/config.schema.json");
  const contractSchema = parseJson("automation/task-contract.schema.json");
  const contractExample = parseJson(
    "automation/tasks/TASK-TEMPLATE.json.example",
  );
  const combinedResources = [
    ...expectedBaselineHashes.keys(),
  ]
    .map((relativePath) =>
      readFileSync(join(templatesRoot, relativePath), "utf8"),
    )
    .join("\n");

  assert.deepEqual(config.plugins, {
    superpowers:
      "superpowers@git+https://github.com/obra/superpowers.git#v6.2.0",
  });
  assert.equal(
    configSchema.$id,
    "urn:frankzhang2026:opencode-android-orchestrator:automation-config:v3",
  );
  assert.equal(
    contractSchema.$id,
    "urn:frankzhang2026:opencode-android-orchestrator:task-contract:v1",
  );
  assert.deepEqual(contractExample.allowedPaths, [
    "**/src/main/**",
    "**/src/test/**",
    "**/src/androidTest/**",
  ]);
  assert.deepEqual(contractExample.targetTests, [
    {
      gradleTask: "testDebugUnitTest",
      filter: "*ReplaceWithFocusedTest",
    },
  ]);
  assert.doesNotMatch(
    combinedResources,
    /\/Users\/|zhanglong|cctest|opencode-scheduler/i,
  );
});

test("provides one portable and bounded AGENTS managed block", () => {
  const absolutePath = join(templatesRoot, agentsFragmentPath);
  const fragment = readFileSync(absolutePath, "utf8");
  const beginMarker = "<!-- opencode-android-orchestrator:begin -->";
  const endMarker = "<!-- opencode-android-orchestrator:end -->";

  assert.equal(fragment.match(new RegExp(beginMarker, "g"))?.length, 1);
  assert.equal(fragment.match(new RegExp(endMarker, "g"))?.length, 1);
  assert.ok(fragment.startsWith(beginMarker + "\n"));
  assert.ok(fragment.endsWith(endMarker + "\n"));
  assert.match(fragment, /\.\/gradlew testDebugUnitTest/);
  assert.match(fragment, /single-choice `question` selection/);
  assert.match(fragment, /must not push Git changes/);
  assert.match(fragment, /\.automation-worktree-allowlist/);
  assert.doesNotMatch(
    fragment,
    /# Repository Guidelines|\/Users\/|cctest|\.git\/automation-runtime/,
  );
  assert.equal(sha256(agentsFragmentPath), expectedAgentsFragmentHash);
  assert.equal(statSync(absolutePath).mode & 0o111, 0);
});
