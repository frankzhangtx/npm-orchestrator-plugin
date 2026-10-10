import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { discoverGradleProjectConfiguration, runInitProcess } from "../dist/index.js";
import { lazyTestOutputFixture } from "./lazy-test-output-fixture.mjs";

const require = createRequire(import.meta.url);
const { runPhase } = require("../templates/automation/verification/inventory.cjs");
const templates = fileURLToPath(new URL("../templates/", import.meta.url));
function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}
function write(root, name, text, mode) {
  const file = join(root, name); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, mode === undefined ? undefined : { mode });
}
function git(root, ...args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}

test("real Android mapped test outputs support discovery and baseline/RED/GREEN collection", () => {
  const gradle = process.env.ORCHESTRATOR_TEST_GRADLE ?? files(join(homedir(), ".gradle/wrapper/dists/gradle-9.4.1-all")).find(file => file.endsWith("/bin/gradle"));
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
  assert(gradle && existsSync(sdk), "Configure ORCHESTRATOR_TEST_GRADLE and ANDROID_HOME");
  const root = mkdtempSync(join(process.env.ORCHESTRATOR_INVENTORY_ARTIFACTS ?? tmpdir(), "inventory-android-"));
  console.log(`Android inventory artifacts: ${root}`);
  const jar = (group, artifact) => files(join(homedir(), ".gradle/caches/modules-2/files-2.1", group, artifact))
    .find(file => file.endsWith(".jar") && !/-sources|-javadoc/.test(file));
  const junit = process.env.ORCHESTRATOR_TEST_JUNIT ?? jar("junit", "junit");
  const hamcrest = process.env.ORCHESTRATOR_TEST_HAMCREST ?? jar("org.hamcrest", "hamcrest-core");
  assert(junit && hamcrest, "JUnit4 and Hamcrest are required");
  write(root, ".gitignore", ".gradle/\n**/build/\nlocal.properties\n");
  write(root, "settings.gradle", "pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositories { google(); mavenCentral() } }\nrootProject.name='inventory-android'\ninclude ':library'\n");
  write(root, "build.gradle", `plugins { id 'com.android.library' version '${process.env.ORCHESTRATOR_TEST_AGP ?? "9.2.1"}' apply false }\n`);
  write(root, "gradle/wrapper/gradle-wrapper.properties", "distributionUrl=local-verified-fixture\n");
  write(root, "gradle.properties", "org.gradle.workers.max=2\n");
  write(root, "local.properties", `sdk.dir=${sdk}\n`);
  write(root, "gradlew", `#!/usr/bin/env node\nconst offline=process.env.ORCHESTRATOR_TEST_OFFLINE==='1'?['--offline']:[];\nconst r=require('node:child_process').spawnSync(${JSON.stringify(gradle)},[...offline,...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status ?? 1);\n`, 0o755);
  write(root, "library/build.gradle", `plugins { id 'com.android.library' }
    android { namespace='example.inventory'; compileSdk=36
      defaultConfig { minSdk=23 }
      sourceSets { test {
        java.setSrcDirs(['checks/java']); kotlin.setSrcDirs(['checks/kotlin']); resources.setSrcDirs(['checks/resources'])
        assets.setSrcDirs(['checks/assets']); res.setSrcDirs(['checks/res'])
      } }
    }
    dependencies { testImplementation files(${JSON.stringify(junit)}, ${JSON.stringify(hamcrest)}) }
    ${lazyTestOutputFixture}\n`);
  write(root, "library/src/main/AndroidManifest.xml", "<manifest />\n");
  const feature = value => `package example; public class Feature { public static int answer() { return ${value}; } }\n`;
  write(root, "library/src/main/java/example/Feature.java", feature(1));
  write(root, "library/checks/resources/sample.txt", "stable resource\n");
  write(root, "library/checks/assets/sample.json", "{\"baseline\":true}\n");
  write(root, "library/checks/res/values/test_strings.xml", "<resources><string name=\"test_value\">baseline</string></resources>\n");
  write(root, "library/checks/kotlin/example/KotlinTest.kt", "package example\nclass KotlinTest { @org.junit.Test fun legacyKotlin() { org.junit.Assert.assertEquals(2, 1 + 1) } }\n");
  write(root, "library/checks/java/example/ExistingTest.java", "package example; import org.junit.*; public class ExistingTest { @Test public void resource() { Assert.assertNotNull(getClass().getResource(\"/sample.txt\")); } }\n");
  const config = { protectedPaths: ["automation/**", "gradlew", "gradle.properties", "settings.gradle", "build.gradle", "library/build.gradle"],
    androidProject: { productionPaths: ["library/src/main/**"], testPaths: ["library/src/test/**"] },
    gradleVerification: { focusedTestTasks: [":library:testDebugUnitTest"] } };
  const contract = JSON.parse(readFileSync(join(templates, "automation/tasks/TASK-TEMPLATE.json.example"), "utf8"));
  Object.assign(contract, { id: "TASK-ANDROID-INVENTORY", title: "Return the approved answer", planPath: "docs/plans/TASK-ANDROID-INVENTORY.md",
    allowedPaths: ["library/src/main/java/**", "library/checks/**"], forbiddenPaths: config.protectedPaths,
    targetTests: [{ gradleTask: ":library:testDebugUnitTest", filter: "example.*" }],
    acceptanceCriteria: ["Return answer 42 and preserve existing tests"], nonGoals: ["No unrelated API changes"] });
  contract.verification.cases = [{ id: "ANSWER-FIX", criterion: 1, intent: "change", before: "fail", after: "pass", source: "userRequirement",
    test: { target: 0, className: "example.AddedTest", name: "approved" },
    expectedFailure: { type: "java.lang.AssertionError", messageIncludes: "approved answer", origin: "AddedTest approved assertion" } }];
  write(root, "automation/config.json", JSON.stringify(config));
  write(root, `automation/tasks/${contract.id}.json`, JSON.stringify(contract));
  write(root, contract.planPath, "Approved answer behavior and regression preservation\n");
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "Inventory Test"); git(root, "config", "user.email", "inventory@example.invalid");
  git(root, "add", "."); git(root, "commit", "-qm", "Android inventory baseline");
  const evidence = join(root, ".git/automation-runtime/evidence", contract.id);
  write(root, `.git/automation-runtime/evidence/${contract.id}/baseline.json`, JSON.stringify({ head: git(root, "rev-parse", "HEAD") }));
  function phase(name) {
    try { return runPhase(name, join(root, `automation/tasks/${contract.id}.json`), join(root, "automation/config.json"), root, evidence); }
    catch (error) {
      console.error(name, error.code, error.message);
      for (const file of files(evidence).filter(file => file.endsWith("gradle.log")).slice(-2)) console.error(readFileSync(file, "utf8").slice(-6000));
      throw error;
    }
  }
  const discovery = discoverGradleProjectConfiguration(root, runInitProcess);
  assert(discovery.gradleVerification.focusedTestTasks.includes(":library:testDebugUnitTest"));
  assert(discovery.detection.capabilities.modules[0].sources.some(source => source.kind === "test" && source.paths.includes("library/checks/java/**")));
  const baseline = phase("baseline");
  assert.equal(baseline.summary.existing, 2);
  const events = name => readFileSync(join(evidence, baseline.attemptPath, name, "events.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  const discoveredTask = events("discovery").find(event => event.kind === "task");
  const collectedTask = events("collection").find(event => event.kind === "task");
  assert.deepEqual(discoveredTask.testClassesDirs, []);
  assert(collectedTask.testClassesDirs.some(directory => directory.includes("/mapped-test-classes/testDebugUnitTest")));
  assert.deepEqual(discoveredTask.sourceRoots, collectedTask.sourceRoots);
  assert(baseline.testPatterns.includes("library/checks/java/**"));
  assert(baseline.testPatterns.includes("library/checks/resources/**"));
  for (const folder of ["kotlin", "assets", "res"]) assert(baseline.testPatterns.includes(`library/checks/${folder}/**`));
  write(root, "library/checks/java/example/AddedTest.java", "package example; import org.junit.*; public class AddedTest { @Test public void approved() { Assert.assertEquals(\"approved answer\", 42, Feature.answer()); } }\n");
  assert.equal(phase("red").summary.expectedRed, 1);
  write(root, "library/src/main/java/example/Feature.java", feature(42));
  assert.equal(phase("green").summary.total, 3);
  assert.equal(phase("check").valid, true);
});
