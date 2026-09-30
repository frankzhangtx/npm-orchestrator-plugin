import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));

const expectedBaselineHashes = new Map([
  ["automation/verification/project.cjs", "818dcf0a20dee93b0e416d051cc1bb5a524b84627c5e1debeedbc42902d2ed62"],
  ["automation/verification/recovery.cjs", "443fe0af443df650b6cd1c5327cdbf50f6b1e734e988a64985646a0f166aeebb"],
  ["automation/verification/contract.cjs", "b794d439188dc3d0321fcd474c76600698d49bfaeebe3776702e79b6a680509f"],
  ["automation/verification/inventory.cjs", "9adea93ed212971f288d7495fee52041b37b97ff6057527a9f729df9e5a210b0"],
  ["automation/verification/collect.init.gradle", "04a80b880d8813e61d97c19846544a23083a71f341d006e7bb25c8f74cc8010f"],
  [
    "automation/config.json",
    "f53ffef792ee63f17b520f86d18a619c3097dc09f301abd9e76de19fad01c14e",
  ],
  [
    "automation/config.schema.json",
    "f18a41d8d5d15ce7c2a388d4774146c64a829389957451a325b67676d5f39afb",
  ],
  [
    "automation/task-contract.schema.json",
    "1096fa14748e1c8a14c595271d561276a5f90d0a14e10ddf3f9475076345939f",
  ],
  [
    "automation/tasks/TASK-TEMPLATE.json.example",
    "abc87cd83c875960be0d77743b74b554d4237ebc792a55b36765faf404ca89d6",
  ],
  [
    "docs/plans/README.md",
    "12620e9cc841353b17880d5cbde6362f8c0522175a430153d7004465833730e1",
  ],
]);

const agentsFragmentPath = "AGENTS.md.fragment";
const expectedAgentsFragmentHash =
  "29b3ca2a591ca96be89915fed5da7af391c29e5a36e445fe861e0a8615585d5b";

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

test("locks the portable V6 infrastructure resources and file modes", () => {
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
  assert.ok(contractSchema.properties.schemaVersion.enum.includes(contractExample.schemaVersion));
  assert.equal(contractExample.schemaVersion, 4);
  assert.equal(contractExample.verification.version, 2);
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
  assert.ok(configSchema.required.includes("commitMessagePrefixMode"));
  assert.equal(config.commitMessagePrefixMode, "required");
  assert.deepEqual(configSchema.properties.commitMessagePrefixMode, {
    enum: ["required", "disabled"],
    default: "required",
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
  assert.equal(Object.hasOwn(configSchema.properties, "plugins"), false);
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

  assert.equal(Object.hasOwn(config, "plugins"), false);
  assert.equal(
    configSchema.$id,
    "urn:frankzhang2026:opencode-android-orchestrator:automation-config:v6",
  );
  assert.equal(
    contractSchema.$id,
    "urn:frankzhang2026:opencode-android-orchestrator:task-contract:v8",
  );
  assert.deepEqual(contractExample.allowedPaths, [
    "**/src/main/**",
    "**/src/test/**",
    "**/src/androidTest/**",
  ]);
  assert.deepEqual(contractExample.targetTests, [
    {
      gradleTask: ":app:testDebugUnitTest",
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
  assert.match(fragment, /gradleVerification\.fullUnitTestTasks/);
  assert.doesNotMatch(fragment, /\.\/gradlew testDebugUnitTest/);
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
