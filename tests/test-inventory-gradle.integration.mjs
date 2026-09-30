import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { runPhase } = require("../templates/automation/verification/inventory.cjs");
const templates = fileURLToPath(new URL("../templates/", import.meta.url));
const read = file => JSON.parse(readFileSync(file, "utf8"));
function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}
function dependency(group, artifact) {
  const file = files(join(homedir(), ".gradle/caches/modules-2/files-2.1", group, artifact))
    .find(file => file.endsWith(".jar") && !/-sources|-javadoc/.test(file));
  assert(file, `Cache ${group}:${artifact}, or set ORCHESTRATOR_TEST_JUNIT / ORCHESTRATOR_TEST_HAMCREST`);
  return file;
}
function write(root, file, text, mode) {
  const target = join(root, file); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, mode === undefined ? undefined : { mode });
}
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
const expected = code => error => error.code === code;

test("real Gradle inventory: custom resources, parameter identities, overlapping filters, preserved skips and repeated GREEN", () => {
  const gradle = process.env.ORCHESTRATOR_TEST_GRADLE ?? files(join(homedir(), ".gradle/wrapper/dists/gradle-9.4.1-all")).find(file => file.endsWith("/bin/gradle"));
  assert(gradle, "Set ORCHESTRATOR_TEST_GRADLE to a supported Gradle executable");
  const jars = [process.env.ORCHESTRATOR_TEST_JUNIT ?? dependency("junit", "junit"),
    process.env.ORCHESTRATOR_TEST_HAMCREST ?? dependency("org.hamcrest", "hamcrest-core")];
  const root = mkdtempSync(join(process.env.ORCHESTRATOR_INVENTORY_ARTIFACTS ?? tmpdir(), "inventory-gradle-"));
  console.log(`Gradle inventory artifacts: ${root}`);
  write(root, ".gitignore", ".gradle/\n**/build/\n");
  write(root, "settings.gradle", "rootProject.name = 'inventory-proof'\ninclude 'alpha', 'beta'\n");
  write(root, "build.gradle", `subprojects {
    apply plugin: 'java'
    dependencies { testImplementation files(${jars.map(file => JSON.stringify(file)).join(", ")}) }
    sourceSets.test.java.setSrcDirs(['spec/code'])
    sourceSets.test.resources.setSrcDirs(['spec/data'])
    tasks.withType(Test).configureEach { useJUnit(); maxParallelForks = 1 }
  }\n`);
  write(root, "gradle.properties", "org.gradle.workers.max=2\n");
  write(root, "gradlew", `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nconst r=spawnSync(${JSON.stringify(gradle)},['--offline',...process.argv.slice(2)],{stdio:'inherit'});\nprocess.exit(r.status ?? 1);\n`, 0o755);
  const feature = answer => `package example; public class Feature { public static int answer() { return ${answer}; } }\n`;
  for (const module of ["alpha", "beta"]) {
    write(root, `${module}/src/main/java/example/Feature.java`, feature(1));
    write(root, `${module}/spec/data/input.txt`, "baseline resource\n");
    write(root, `${module}/spec/code/example/LegacyTest.java`, `package example;
      import org.junit.*;
      public class LegacyTest {
        @Test public void legacy() { Assert.assertNotNull(getClass().getResource("/input.txt")); }
        @Ignore("pre-existing") @Test public void ignored() { Assert.fail(); }
      }\n`);
    write(root, `${module}/spec/code/example/ParameterTest.java`, `package example;
      import org.junit.*; import org.junit.runner.RunWith; import org.junit.runners.Parameterized;
      @RunWith(Parameterized.class) public class ParameterTest {
        @Parameterized.Parameters(name="input-{0}") public static Object[] data() { return new Object[] {1,2}; }
        @Parameterized.Parameter public int input;
        @Test public void parameter() { Assert.assertTrue(input > 0); }
      }\n`);
  }
  const config = { protectedPaths: ["automation/**", "build.gradle", "settings.gradle", "gradlew", "gradle.properties"],
    androidProject: { productionPaths: ["*/src/main/**"], testPaths: [] },
    gradleVerification: { focusedTestTasks: [":alpha:test", ":beta:test"] } };
  const contract = read(join(templates, "automation/tasks/TASK-TEMPLATE.json.example"));
  Object.assign(contract, { id: "TASK-INVENTORY-REAL", title: "Return the approved answer", planPath: "docs/plans/TASK-INVENTORY-REAL.md",
    allowedPaths: ["alpha/src/main/**", "alpha/spec/**", "beta/spec/**"], forbiddenPaths: config.protectedPaths,
    acceptanceCriteria: ["The answer is 42 and previous behavior stays covered"], nonGoals: ["No public API removal"],
    targetTests: [{ gradleTask: ":alpha:test", filter: "example.*" }, { gradleTask: ":alpha:test", filter: "example.LegacyTest" },
      { gradleTask: ":beta:test", filter: "example.*" }] });
  contract.verification.inventory.existingSkips = "preserve";
  contract.verification.cases = [{ id: "ANSWER-FIX", criterion: 1, intent: "change", before: "fail", after: "pass", source: "userRequirement",
    test: { target: 0, className: "example.FeatureTest", name: "approved" },
    expectedFailure: { type: "java.lang.AssertionError", messageIncludes: "approved answer", origin: "FeatureTest approved answer assertion" } }];
  write(root, "automation/config.json", JSON.stringify(config));
  write(root, "automation/tasks/TASK-INVENTORY-REAL.json", JSON.stringify(contract));
  write(root, contract.planPath, "Return the approved answer while keeping existing tests.\n");
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "Inventory Test"); git(root, "config", "user.email", "inventory@example.invalid");
  git(root, "add", "."); git(root, "commit", "-qm", "Inventory test baseline");
  const evidence = join(root, ".git/automation-runtime/evidence", contract.id);
  write(root, ".git/automation-runtime/evidence/TASK-INVENTORY-REAL/baseline.json", JSON.stringify({ head: git(root, "rev-parse", "HEAD") }));
  let activeContract = contract;
  let activeEvidence = evidence;
  const phase = (name, quiet = false) => {
    try { return runPhase(name, join(root, `automation/tasks/${activeContract.id}.json`), join(root, "automation/config.json"), root, activeEvidence); }
    catch (error) {
      if (quiet) throw error;
      console.error(`${name}: ${error.code} ${error.message}`);
      const log = files(activeEvidence).filter(file => file.endsWith("gradle.log")).at(-1);
      if (log) console.error(readFileSync(log, "utf8").slice(-6000));
      throw error;
    }
  };
  const baseline = phase("baseline");
  assert.equal(baseline.summary.existing, 8);
  assert.equal(baseline.summary.skipped, 2);
  assert(baseline.testPatterns.includes("alpha/spec/data/**"));
  assert(baseline.testSnapshot.some(item => item.path === "alpha/spec/data/input.txt"));
  assert.equal(baseline.cases.filter(item => item.className === "example.ParameterTest").length, 4);
  write(root, "alpha/spec/code/example/FeatureTest.java", `package example; import org.junit.*;
    public class FeatureTest { @Test public void approved() { Assert.assertNull("rerun failure injection", System.getenv("ORCHESTRATOR_INVENTORY_FAIL")); Assert.assertEquals("approved answer", 42, Feature.answer()); } }\n`);
  const red = phase("red");
  assert.deepEqual(red.summary, { declared: 1, regression: 8, total: 9, expectedRed: 1, skipped: 2 });
  assert.throws(() => phase("red", true), expected("EVIDENCE_CHANGED"));
  write(root, "alpha/src/main/java/example/Feature.java", feature(42));
  const first = phase("green"), second = phase("green");
  assert.equal(first.summary.total, 9); assert.equal(second.summary.total, 9);
  const green = read(join(evidence, "green-inventory.json"));
  const collection = join(evidence, green.attemptPath, "collection");
  const log = readFileSync(join(collection, "gradle.log"), "utf8");
  assert.match(log, /:alpha:compileTestJava UP-TO-DATE/);
  assert.doesNotMatch(log, /:(alpha|beta):test (UP-TO-DATE|FROM-CACHE|SKIPPED)/);
  assert.equal(files(join(collection, "reports")).filter(file => file.endsWith(".xml")).length, 5);
  assert.equal(phase("check").valid, true);
  const previousFailureFlag = process.env.ORCHESTRATOR_INVENTORY_FAIL;
  process.env.ORCHESTRATOR_INVENTORY_FAIL = "1";
  try { assert.throws(() => phase("green", true), expected("CASE_EXPECTATION_MISMATCH")); }
  finally {
    if (previousFailureFlag === undefined) delete process.env.ORCHESTRATOR_INVENTORY_FAIL;
    else process.env.ORCHESTRATOR_INVENTORY_FAIL = previousFailureFlag;
  }
  assert.throws(() => phase("check", true), expected("EVIDENCE_CHANGED"));
  phase("green");
  assert.equal(phase("check").valid, true);
  write(root, "alpha/spec/data/input.txt", "changed resource\n");
  assert.throws(() => phase("check", true), expected("EVIDENCE_CHANGED"));
  write(root, "alpha/spec/data/input.txt", "baseline resource\n");
  assert.equal(phase("check").valid, true);
  write(root, "alpha/src/main/java/example/Feature.java", feature(43));
  assert.throws(() => phase("check", true), expected("EVIDENCE_CHANGED"));
  write(root, "alpha/src/main/java/example/Feature.java", feature(42));
  const sealedRed = readFileSync(join(evidence, "red.json"), "utf8");
  writeFileSync(join(evidence, "red.json"), sealedRed + " ");
  assert.throws(() => phase("check", true), expected("EVIDENCE_CHANGED"));
  writeFileSync(join(evidence, "red.json"), sealedRed);
  assert.equal(phase("check").valid, true);

  function scenario(id, targets, policy) {
    activeContract = structuredClone(contract);
    Object.assign(activeContract, { id, planPath: `docs/plans/${id}.md`, targetTests: targets });
    Object.assign(activeContract.verification.inventory, policy);
    activeContract.verification.cases[0].test = { target: 0, className: "example.NewTest", name: "approved" };
    write(root, `automation/tasks/${id}.json`, JSON.stringify(activeContract));
    write(root, activeContract.planPath, "Approved inventory verification scenario\n");
    write(root, "automation/config.json", JSON.stringify(config));
    git(root, "add", "."); git(root, "commit", "-qm", id);
    activeEvidence = join(root, ".git/automation-runtime/evidence", id);
    write(root, `.git/automation-runtime/evidence/${id}/baseline.json`, JSON.stringify({ head: git(root, "rev-parse", "HEAD") }));
  }
  scenario("TASK-SKIP-REJECT", [{ gradleTask: ":alpha:test", filter: "example.*" }], { existingSkips: "reject" });
  assert.throws(() => phase("baseline", true), expected("BASELINE_SKIPPED"));
  scenario("TASK-EMPTY-REJECT", [{ gradleTask: ":alpha:test", filter: "example.NewTest" }], { emptyBaseline: "reject" });
  assert.throws(() => phase("baseline", true), expected("EMPTY_BASELINE"));
  scenario("TASK-EMPTY-ALLOW", [{ gradleTask: ":alpha:test", filter: "example.NewTest" }], { emptyBaseline: "allow" });
  assert.equal(phase("baseline").summary.existing, 0);
  write(root, "alpha/spec/code/example/NewTest.java", "not valid Java\n");
  assert.throws(() => phase("red", true), expected("EXECUTION_FAILURE"));
  assert.equal(existsSync(join(activeEvidence, "red.json")), false);
  write(root, "alpha/spec/code/example/NewTest.java", `package example; import org.junit.*;
    public class NewTest { @Test public void approved() { Assert.assertEquals("approved answer", 43, Feature.answer()); } }\n`);
  const prepared = phase("red");
  assert.equal(prepared.summary.expectedRed, 1);
  assert.equal(prepared.attempt, 2);
  write(root, "alpha/src/main/java/example/Feature.java", feature(43));
  assert.equal(phase("green").summary.total, 1);
  assert.equal(phase("check").valid, true);
  write(root, "settings.gradle", "rootProject.name = 'inventory-proof'\ninclude 'alpha', 'beta', 'empty'\n");
  mkdirSync(join(root, "empty"));
  config.gradleVerification.focusedTestTasks.push(":empty:test");
  scenario("TASK-NO-SOURCE", [{ gradleTask: ":empty:test", filter: "example.NewTest" }], { emptyBaseline: "allow" });
  assert.equal(phase("baseline").summary.existing, 0);
  assert.throws(() => phase("red", true), expected("INCOMPLETE_COLLECTION"));
  assert.equal(existsSync(join(activeEvidence, "red.json")), false);
  console.log("Verified: skip rejection, empty reject/allow, new class RED/GREEN, NO-SOURCE baseline and evidence/input tamper rejection");
});
