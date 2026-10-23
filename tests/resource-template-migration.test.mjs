import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));

const expectedBaselineHashes = new Map([
  ["automation/verification/baseline-snapshot.cjs", "6d71cdd0efc3622d450541faf165c28a1128e218f3cee5694d50ac02a125d687"],
  ["automation/verification/bounded-scope.cjs", "bc1ade1a33c2f7f3128b79129845e4417fef326bff67d4bcf3e4bb0b0220d792"],
  ["automation/verification/bounded-execution.cjs", "675aefb04efe559c8958b8b2879b0e411fe149d1196dcd81e3181ffed1b29dcd"],
  ["automation/verification/bounded.init.gradle", "152e77c2148e5581656229b4d197cadbc90a32b8746d77d035c295b2ad451cca"],
  ["automation/verification/verification-reuse.cjs", "07d3bfd24b80ac69c942930d827f3068a1711bfa11a78d4d0860272c433efe4b"],
  ["automation/verification/selected-tests.cjs", "0ba7be4ce331394b0f6e467049f117d1a4333e02bc41b109553b038597225af6"],
  ["automation/verification/test-selection.cjs", "a44d49770d4f4d9249b39a6ac19aa3b00857e0bd3361549803eee85ab082b305"],
  ["automation/verification/status.cjs", "3eb1ea2a4bbc50be4e6fa5dad1ef8d94ed73a952e04bae4f52b7133d41007ec1"],
  ["automation/verification/worktree.cjs", "2ad71c57580ca2fd97f0abdcc87e80f3081fefbd293f3379fabc699587b3ed8c"],
  ["automation/verification/runtime.init.gradle", "3d3645fdc4197ba5f1c7d04f0d475cca8242a258759f01a24dfd6c0757b1e4f8"],
  ["automation/verification/project.cjs", "4352c058a4596fed5cd0231533fdbf0a90e99735692a721b95edcc9a848e679b"],
  ["automation/verification/recovery.cjs", "94464ea4a057dea5fd62eb0c655b1d093142410ae5ed963bb1653d703ef3d2ff"],
  ["automation/verification/contract.cjs", "ccb64928ecd78099dd21120432b90eaf3c0e834e301f2ec2389bdbb6d3d9370b"],
  ["automation/verification/inventory.cjs", "48b6f11318723c08d4355673b792f0b6fe93ae9d9babf1f00a2a8b6ada36c4dc"],
  ["automation/verification/collect.init.gradle", "9c3d9095876c26f65537fdae4a6cf52d9226f28b9a4c61cb2b91ada65e70a743"],
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
    "56070e93c63cabfbda96fb8dff923d1ef76b758f122072915a02bc25252ad5d6",
  ],
  [
    "automation/tasks/TASK-TEMPLATE.json.example",
    "5b562b9194319619ec17e356434da7268b3e2f1f52adde17f918dd02b639a9eb",
  ],
  [
    "docs/plans/README.md",
    "12620e9cc841353b17880d5cbde6362f8c0522175a430153d7004465833730e1",
  ],
]);

const agentsFragmentPath = "AGENTS.md.fragment";
const expectedAgentsFragmentHash =
  "0f450d14d028f5f641394f8d54e97700da08abdfed07a314c03cd6555566ee14";

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
  assert.match(fragment, /matching delegation for the[\s\S]*native `\/change` session/);
  assert.match(fragment, /With no verified grant, use ordinary approval/);
  assert.match(fragment, /must not push Git changes/);
  assert.match(fragment, /\.automation-worktree-allowlist/);
  assert.doesNotMatch(
    fragment,
    /# Repository Guidelines|\/Users\/|cctest|\.git\/automation-runtime/,
  );
  assert.equal(sha256(agentsFragmentPath), expectedAgentsFragmentHash);
  assert.equal(statSync(absolutePath).mode & 0o111, 0);
});
