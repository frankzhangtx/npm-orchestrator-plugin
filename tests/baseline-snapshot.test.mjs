import assert from 'node:assert/strict';
import test from 'node:test';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, taskContract, command } from './queue-fixture.mjs';
import { runtime, runtimeOutput } from './runtime-fixture.mjs';
const require = createRequire(import.meta.url);
const { validateTestAdditions, describeTestSource } = require('../templates/automation/verification/baseline-snapshot.cjs');
const id = 'TASK-SNAPSHOT-001';
const original = 'import org.junit.Test\nclass ExistingTest {\n    @Test fun legacy() { check(true) }\n}\n';
const appended = original.replace('\n}\n', '\n    @Test fun `approved behavior`() { check(false) }\n}\n');
const expected = code => error => error.code === code;
function setup({ runtimeDrift = false, ...options } = {}) {
  const f = fixture({ inventoryMode: true, ...options });
  const module = { gradlePath: ':app', directory: 'app', buildFile: 'app/build.gradle.kts', type: 'application',
    namespace: 'example.queue', applicationId: 'example.queue', dependencies: [],
    sources: ['main', 'test', 'androidTest'].map(name => ({ name, kind: name === 'main' ? 'production' : 'test', paths: [`app/src/${name}/**`] })),
    tasks: ['unit', 'assemble', 'lint', 'device'].map(kind => ({ kind, variant: 'Debug',
      path: `:app:${kind === 'unit' ? 'testDebugUnitTest' : kind === 'device' ? 'connectedDebugAndroidTest' : kind + 'Debug'}` })) };
  f.config.androidProject.capabilities = { version: 1, buildRoot: '.', modules: [module] };
  for (const [group, kind] of Object.entries({ fullUnitTestTasks: 'unit', focusedTestTasks: 'unit', assembleTasks: 'assemble', lintTasks: 'lint', deviceTestTasks: 'device' }))
    f.config.gradleVerification[group] = module.tasks.filter(item => item.kind === kind).map(item => item.path);
  const configFile = join(f.root, 'automation/config.json');
  writeFileSync(configFile, JSON.stringify(f.config, null, 2) + '\n');
  const testFile = join(f.root, `app/src/test/java/${id}Test.kt`), product = join(f.root, `app/src/main/java/${id}.kt`);
  writeFileSync(testFile, original);
  const wrapper = join(f.root, 'gradlew');
  let wrapperSource = readFileSync(wrapper, 'utf8').replaceAll("fs.existsSync('app/src/main/java/'+id+'.kt')", `fs.existsSync(${JSON.stringify(`app/src/main/java/${id}.kt`)})`);
  if (runtimeDrift) {
    wrapperSource = wrapperSource.replace(`console.log(${JSON.stringify(runtimeOutput.trim())});`,
      `console.log(fs.existsSync(${JSON.stringify(`app/src/main/java/${id}.kt`)})?${JSON.stringify('ORCHESTRATOR_BUILD_RUNTIME=' + JSON.stringify({ ...runtime, javaVendor: 'Changed actual JVM' }))}:${JSON.stringify(runtimeOutput.trim())});`);
  }
  writeFileSync(wrapper, wrapperSource);
  command(f.root, ['add', '.']); command(f.root, ['commit', '-qm', 'Prepare source snapshot fixture']);
  const recovery = { version: 1, maxEnvironmentRetries: 0, maxElapsedMs: 600000, initialDelayMs: 1000, maxDelayMs: 1000, maxSameFailureRetries: 0 };
  const contract = { ...taskContract(f, id), schemaVersion: 8,
    recovery: { ...recovery, scope: 'baseline', maxManualRetries: 0 }, stageRecovery: recovery,
    execution: { version: 1, maxRunMs: 600000, maxStageMs: 600000, terminationGraceMs: 1000 },
    continuity: { version: 1, isolatedAutoIntegration: false, planningRefresh: 'reject', planningInputs: [contractPath(id)] } };
  contract.continuity.planningInputs = [`app/src/main/java/${id}.kt`, `app/src/test/java/${id}Test.kt`];
  contract.targetTests[0].filter = 'ExistingTest'; contract.verification.cases[0].test.className = 'ExistingTest';
  contract.verification.scope = { version: 3, mode: 'bounded', maxManualRetries: 0, regressionTests: [],
    tasks: { assembleTasks: [], lintTasks: [], deviceTestTasks: [] } };
  const contractFile = join(f.root, contractPath(id));
  const save = () => writeFileSync(contractFile, JSON.stringify(contract, null, 2) + '\n');
  save(); writeFileSync(join(f.root, contract.planPath), '# Approved scoped test change\n');
  const evidence = join(f.root, '.git/automation-runtime/evidence', id); mkdirSync(evidence, { recursive: true });
  const inventory = require(join(f.root, 'automation/verification/inventory.cjs'));
  return { ...f, contract, contractFile, configFile, testFile, product, evidence, save, inventory,
    phase: phase => inventory.runPhase(phase, contractFile, configFile, f.root, evidence),
    capture: () => inventory.captureSnapshotBaseline(contractFile, configFile, f.root, evidence),
    read: name => JSON.parse(readFileSync(join(evidence, name + '.json'), 'utf8')),
    calls: () => existsSync(join(f.base, 'gradle-calls.jsonl')) ? readFileSync(join(f.base, 'gradle-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}
function contractPath(taskId) { return `automation/tasks/${taskId}.json`; }

test('snapshot source protection permits common appended Java/Kotlin tests and preserves old definitions', () => {
  assert.deepEqual(validateTestAdditions(original, appended, 'ExistingTest.kt').addedMethods, ['approved behavior']);
  const java = 'import org.junit.Test;\nclass ExistingTest { @Test public void legacy() { check(true); } }';
  assert.deepEqual(validateTestAdditions(java, java.replace(/ }$/, ' @Test public void added() { check(false); } }'), 'ExistingTest.java').addedMethods, ['added']);
  const withImport = appended.replace('class ExistingTest', 'import org.junit.Assert.assertNull\nclass ExistingTest');
  assert.equal(validateTestAdditions(original, withImport, 'ExistingTest.kt').addedMethods.length, 1);
  for (const candidate of [appended.replace('check(true)', 'check(false)'), appended.replace('fun legacy()', 'fun renamed()'),
    appended.replace('@Test fun legacy()', '@Ignore @Test fun legacy()'), appended.replace('class ExistingTest', 'class OtherTest'),
    appended.replace('import org.junit.Test', 'import org.junit.jupiter.api.Test'), appended.replace('@Test fun legacy() { check(true) }', ''),
    appended.replace('class ExistingTest', 'import evil.check\nclass ExistingTest')])
    assert.throws(() => validateTestAdditions(original, candidate, 'ExistingTest.kt'), expected('SNAPSHOT_TEST_DEFINITION_CHANGED'));
  assert.throws(() => validateTestAdditions('class T : Base() {}', 'class T : Base() { @Test fun added() {} }', 'T.kt'), /inherited/);
  assert.throws(() => validateTestAdditions('old fixture', 'new fixture', 'fixture.json'), /fixtures/);
});

test('new-file source mapping refuses multiple classes and unrecognized test mechanisms', () => {
  assert.equal(describeTestSource(original, 'ExistingTest.kt').mapping, 'ordinary-tests');
  for (const source of [original + 'class ExtraTest { @Test fun extra() {} }',
    'class OuterTest { class InnerTest { @Test fun extra() {} } }',
    'class DynamicTest { @TestFactory fun factory() = generatedTests() }',
    'class ParameterTest { @ParameterizedTest fun values(value: String) {} }',
    'class RepeatTest { @RepeatedTest(2) fun again() {} }',
    'class TemplateTest { @TestTemplate fun generated() {} }',
    'class OldTest extends TestCase { public void testLegacy() {} }',
    'import org.junit.Test as JunitTest\nclass AliasedTest { @JunitTest fun generated() {} }'])
    assert.equal(describeTestSource(source, 'NewTest.kt').mapping, 'unsupported', source);
});

test('snapshot capture runs no Gradle and actual RED/GREEN bind observed cases and unchanged test definitions', () => {
  const f = setup(); try {
    f.capture(); assert.deepEqual(f.calls(), []);
    const meta = f.read('baseline'), baseline = f.read('baseline-inventory');
    assert.equal(meta.state, 'CAPTURED'); assert.equal(meta.testsExecuted, false); assert.equal(meta.outcome, null); assert.equal(meta.exitCode, null);
    assert.deepEqual(meta.command, []); assert.equal(baseline.execution, 'NOT_RUN');
    assert.equal(baseline.valid, undefined); assert.equal(baseline.cases, undefined); assert.equal(baseline.runtime, undefined);
    assert.throws(() => f.phase('baseline'), expected('EVIDENCE_CHANGED'));
    assert.deepEqual(f.calls(), []);
    writeFileSync(f.testFile, appended); const red = f.phase('red');
    assert.equal(red.testIdentityOrigin, 'RED_EXECUTION'); assert.equal(red.summary.regression, 1);
    assert.equal(red.sourceChanges[0].addedMethods[0], 'approved behavior'); assert.equal(f.calls().length, 1);
    writeFileSync(f.product, 'class ImplementedFeature\n'); f.phase('green');
    assert.equal(f.phase('check').valid, true); assert.equal(f.calls().length, 2);
    for (const call of f.calls()) {
      assert(call.args.includes('--build-cache')); assert(!call.args.includes('--no-build-cache'));
      assert(!call.args.includes('--dry-run')); assert(!call.args.includes('help'));
    }
    writeFileSync(f.testFile, appended.replace('check(false)', 'check(true)'));
    assert.throws(() => f.phase('check'), expected('EVIDENCE_CHANGED'));
  } finally { f.cleanup(); }
});

for (const change of ['delete', 'rewrite']) test(`snapshot blocks an existing test ${change} before launching RED`, () => {
  const f = setup(); try {
    f.capture();
    if (change === 'delete') unlinkSync(f.testFile); else writeFileSync(f.testFile, appended.replace('check(true)', 'check(false)'));
    assert.throws(() => f.phase('red'), expected('SNAPSHOT_TEST_DEFINITION_CHANGED'));
    assert.deepEqual(f.calls(), []); assert.equal(existsSync(join(f.evidence, 'red.json')), false);
    const preflight = f.read('test-preflight'); assert.equal(preflight.valid, false); assert.equal(preflight.issues[0].path, `app/src/test/java/${id}Test.kt`);
  } finally { f.cleanup(); }
});

test('snapshot cannot relabel failing RED regressions as a successful baseline', () => {
  const f = setup({ inventoryFailure: 'regression' }); try {
    f.capture(); writeFileSync(f.testFile, appended);
    assert.throws(() => f.phase('red'), expected('CASE_EXPECTATION_MISMATCH'));
    assert.equal(f.read('baseline').outcome, null); assert.equal(existsSync(join(f.evidence, 'red.json')), false);
  } finally { f.cleanup(); }
});

test('new test files cannot generate extra undeclared test methods', () => {
  const f = setup(); try {
    f.contract.allowedPaths.push('app/src/test/java/ExtraTest.kt'); f.save(); f.capture();
    writeFileSync(f.testFile, appended);
    writeFileSync(join(f.root, 'app/src/test/java/ExtraTest.kt'), 'import org.junit.Test\nclass ExtraTest { @Test fun surprise() { check(true) } }\n');
    assert.throws(() => f.phase('red'), expected('COVERAGE_MISMATCH'));
    assert.deepEqual(f.calls(), []); assert.equal(existsSync(join(f.evidence, 'red.json')), false);
  } finally { f.cleanup(); }
});

test('a passing undeclared runtime case in a new class cannot masquerade as an old regression', () => {
  const f = setup(); try {
    f.contract.allowedPaths.push('app/src/test/java/NewTest.kt');
    f.contract.targetTests[0].filter = 'NewTest'; f.contract.verification.cases[0].test.className = 'NewTest';
    f.save(); f.capture();
    writeFileSync(join(f.root, 'app/src/test/java/NewTest.kt'), 'import org.junit.Test\nclass NewTest { @Test fun `approved behavior`() { check(false) } }\n');
    // The Gradle fixture emits an additional successful "legacy" case in the
    // requested class. This new class has no identity in the source snapshot.
    assert.throws(() => f.phase('red'), error => error.code === 'COVERAGE_MISMATCH' && /old regressions/.test(error.message));
    assert.equal(f.calls().length, 1); assert.equal(existsSync(join(f.evidence, 'red.json')), false);
    assert.equal(f.read('baseline').testsExecuted, false);
  } finally { f.cleanup(); }
});

for (const option of [{ inventoryFailure: 'missing-green' }, { runtimeDrift: true }])
  test(`GREEN rejects ${option.runtimeDrift ? 'runtime changes after real RED' : 'missing RED case identities'}`, () => {
    const f = setup(option); try {
      f.capture(); writeFileSync(f.testFile, appended); f.phase('red'); writeFileSync(f.product, 'class ImplementedFeature\n');
      assert.throws(() => f.phase('green'), expected(option.runtimeDrift ? 'EVIDENCE_CHANGED' : 'COVERAGE_MISMATCH'));
      assert.equal(f.read('green-verification').state, 'FAILED');
      assert.equal(existsSync(join(f.evidence, 'green-inventory.json')), false);
    } finally { f.cleanup(); }
  });

for (const regression of [false, true]) test(`explicit baseline executes focused tests once with ${regression ? 'nonempty' : 'empty'} final regression scope`, () => {
  const f = setup();
  const spawn = cp.spawnSync;
  try {
    f.contract.verification.scope.baseline = 'execute';
    if (regression) f.contract.verification.scope.regressionTests = [{ gradleTask: ':app:testDebugUnitTest', filter: 'OtherRegressionTest' }];
    f.save();
    // Exercise real baseline capture and Gradle collection; only the queue's
    // already-tested plan-seal helper is replaced for this direct unit harness.
    cp.spawnSync = (exe, args, options) => {
      if (exe === 'bash' && args[2] === 'baseline-recovery') {
        const name = args[4];
        if (name === 'automation_assert_planning_artifacts_sealed') return { status: 0, stdout: '', stderr: '' };
        if (name === 'automation_changed_paths_at') return { status: 0, stdout: `${contractPath(id)}\n${f.contract.planPath}\n`, stderr: '' };
        if (name === 'automation_effective_worktree_allowlist_json_at') return { status: 0, stdout: '[]', stderr: '' };
      }
      return spawn(exe, args, options);
    };
    const recovery = require(join(f.root, 'automation/verification/recovery.cjs'));
    const result = recovery.captureBaseline(f.contractFile, f.configFile, f.root, f.evidence, 'initial', null);
    assert.equal(result.ok, true);
    const full = f.read('baseline-full'), baseline = f.read('baseline');
    assert.equal(full.state, 'NOT_REQUIRED'); assert.equal(full.testsExecuted, false); assert.deepEqual(full.command, []);
    assert.equal(baseline.testsExecuted, true); assert.equal(baseline.outcome, 'PASSED'); assert.equal(baseline.exitCode, 0);
    assert(baseline.command.includes('baseline')); assert.deepEqual(baseline.regressionTargets, []);
    assert.equal(existsSync(join(f.evidence, 'baseline-selected.json')), false);
    const collections = f.calls().filter(call => !call.args.includes('--dry-run'));
    assert.equal(collections.length, 1);
    assert(f.calls().every(call => !call.args.some(arg => arg.includes('OtherRegressionTest'))));
    writeFileSync(f.testFile, appended); f.phase('red'); writeFileSync(f.product, 'class ImplementedFeature\n'); f.phase('green');
    assert.equal(f.phase('check').valid, true);
  } finally { cp.spawnSync = spawn; f.cleanup(); }
});
