import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { legacyRepositories } from './legacy-toolchain.mjs';
import { GRADLE_PROJECT_DISCOVERY_INIT_SCRIPT } from "../dist/installer/gradle-verification.js";
import { parseProjectCapabilities } from "../dist/installer/project-capabilities.js";

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

test("Gradle 6.7.1 AGP 4.2.2 Kotlin 1.4.32 captures legacy Android test inputs", () => {
  const gradle = process.env.ORCHESTRATOR_TEST_GRADLE;
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
  write(root, "settings.gradle", "rootProject.name='inventory-android'\ninclude ':library'\n");
  write(root, "build.gradle", `buildscript { repositories { ${legacyRepositories} }; dependencies { classpath "com.android.tools.build:gradle:4.2.2"; classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:1.4.32" } }
allprojects { repositories { ${legacyRepositories} } }
`);
  write(root, "gradle.properties", "org.gradle.workers.max=2\norg.gradle.jvmargs=-Xmx1536m\n");
  write(root, "local.properties", `sdk.dir=${sdk}\n`);
  write(root, "gradlew", `#!/usr/bin/env node\nconst offline=process.env.ORCHESTRATOR_TEST_OFFLINE==='1'?['--offline']:[];\nconst r=require('node:child_process').spawnSync(${JSON.stringify(gradle)},[...offline,...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status ?? 1);\n`, 0o755);
  write(root, "library/build.gradle", `apply plugin: 'com.android.library'
    apply plugin: 'kotlin-android'
    android { compileSdkVersion 30; buildToolsVersion '30.0.3'
      defaultConfig { minSdkVersion 23 }
      sourceSets { main { kotlin.setSrcDirs(['code/kotlin']) }; test {
        java.setSrcDirs(['checks/java']); kotlin.setSrcDirs(['checks/kotlin']); resources.setSrcDirs(['checks/resources'])
        assets.setSrcDirs(['checks/assets']); res.setSrcDirs(['checks/res'])
      } }
    }
    dependencies { testImplementation files(${JSON.stringify(junit)}, ${JSON.stringify(hamcrest)}) }\n`);
  write(root, "library/src/main/AndroidManifest.xml", '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="example.inventory" />\n');
  const feature = value => `package example; public class Feature { public static int answer() { return ${value}; } }\n`;
  write(root, "library/src/main/java/example/Feature.java", feature(1));
  write(root, "library/code/kotlin/example/Stable.kt", "package example\nclass Stable { fun value(): Int = 7 }\n");
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
  const discoveryScript = join(root, '.git/discovery.init.gradle');
  writeFileSync(discoveryScript, GRADLE_PROJECT_DISCOVERY_INIT_SCRIPT);
  const discovered = spawnSync(join(root, 'gradlew'), ['help', '--init-script', discoveryScript, '--console=plain'], { cwd: root, encoding: 'utf8', timeout: 240000 });
  writeFileSync(join(root, '.git/discovery.log'), discovered.stdout + discovered.stderr);
  assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr);
  const model = parseProjectCapabilities(discovered.stdout, root, root);
  assert(model.modules[0].sources.some(s => s.kind === 'test' && s.paths.includes('library/checks/kotlin/**')));
  assert(model.modules[0].sources.some(s => s.kind === 'production' && s.paths.includes('library/code/kotlin/**')));
  writeFileSync(join(root, '.git/capabilities.json'), JSON.stringify(model, null, 2));
  const baseline = phase("baseline");
  assert.equal(baseline.runtime.gradleVersion, '6.7.1');
  assert.match(baseline.runtime.javaVersion, /^1\.8\./);
  assert(baseline.runtime.plugins.some(p => p.id === 'kotlin-android' || p.id === 'org.jetbrains.kotlin.android'));
  assert.equal(baseline.summary.existing, 2);
  assert(baseline.testPatterns.includes("library/checks/java/**"));
  assert(baseline.testPatterns.includes("library/checks/resources/**"));
  for (const folder of ["kotlin", "assets", "res"]) assert(baseline.testPatterns.includes(`library/checks/${folder}/**`));
  write(root, "library/checks/java/example/AddedTest.java", "package example; import org.junit.*; public class AddedTest { @Test public void approved() { Assert.assertEquals(\"approved answer\", 42, Feature.answer()); } }\n");
  const approvedTest = readFileSync(join(root, 'library/checks/java/example/AddedTest.java'), 'utf8');
  write(root, 'library/checks/java/example/AddedTest.java', 'package example; import org.junit.*; public class AddedTest { @Before public void setUp() { Assert.fail("approved answer"); } @Test public void approved() {} }\n');
  assert.throws(() => phase('red'), error => error.code === 'CASE_EXPECTATION_MISMATCH');
  assert.equal(existsSync(join(evidence, 'red.json')), false);
  write(root, 'library/checks/java/example/AddedTest.java', approvedTest);
  assert.equal(phase("red").summary.expectedRed, 1);
  write(root, "library/src/main/java/example/Feature.java", feature(42));
  assert.equal(phase("green").summary.total, 3);
  assert.equal(phase("check").valid, true);
});
