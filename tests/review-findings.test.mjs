import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { command, fixture, taskContract } from './queue-fixture.mjs';
import { runtime, runtimeOutput } from './runtime-fixture.mjs';
const require = createRequire(import.meta.url);
const { validateContract } = require('../templates/automation/verification/contract.cjs');
const { evaluateCoverage } = require('../templates/automation/verification/inventory.cjs');
const { inspectBuildRuntime, buildEnvironmentBinding, assertIsolatedBuildEnvironment } = require('../templates/automation/verification/project.cjs');

test('runtime inspection uses the configured Gradle JVM and refuses absent or incompatible evidence', () => {
  const response = value => ({ status: 0, error: null, stderr: '', stdout: 'ORCHESTRATOR_BUILD_RUNTIME=' + JSON.stringify(value) });
  const record = inspectBuildRuntime('/fixture/project', (executable, args) => {
    assert.equal(executable, '/fixture/project/gradlew');
    assert(args.includes('--project-dir'));
    assert(args.some(arg => arg.endsWith('runtime.init.gradle')));
    return response(runtime);
  });
  assert.equal(record.javaVersion, '1.8.0_312');
  assert.throws(() => inspectBuildRuntime('/fixture/project', () => response({ ...runtime, javaVersion: '21.0.11' })), /Java 8 through 15/);
  assert.throws(() => inspectBuildRuntime('/fixture/project', () => ({ status: 0, stdout: 'BUILD SUCCESSFUL', error: null })), /exactly one/);
  assert.throws(() => inspectBuildRuntime('/fixture/project', () => ({ status: 1, stderr: 'Unsupported class file major version', error: null })), /actual Gradle\/JVM/);
});

test('Gradle user JVM overrides and init scripts change the recovery binding; ignored local inputs require isolation setup', () => {
  const f = fixture();
  const previous = process.env.GRADLE_USER_HOME;
  try {
    const home = join(f.base, 'gradle-home'); mkdirSync(join(home, 'init.d'), { recursive: true });
    process.env.GRADLE_USER_HOME = home;
    const initial = buildEnvironmentBinding(f.root, runtime);
    writeFileSync(join(home, 'gradle.properties'), 'org.gradle.java.home=/different/jdk\n');
    const changed = buildEnvironmentBinding(f.root, runtime);
    assert.notEqual(changed, initial);
    writeFileSync(join(home, 'init.d/override.gradle'), 'allprojects { version="changed" }\n');
    assert.notEqual(buildEnvironmentBinding(f.root, runtime), changed);
    writeFileSync(join(f.root, 'local.properties'), '# Local SDK\nsdk.dir=/sdk\n');
    assertIsolatedBuildEnvironment(f.root);
    writeFileSync(join(f.root, 'local.properties'), 'sdk.dir=/sdk\nndk.dir=/private/ndk\nsecret=not-to-be-printed\n');
    assert.throws(() => assertIsolatedBuildEnvironment(f.root), error => /ISOLATED_ENVIRONMENT_UNDECLARED/.test(error.message) && !error.message.includes('not-to-be-printed'));
  } finally {
    if (previous === undefined) delete process.env.GRADLE_USER_HOME; else process.env.GRADLE_USER_HOME = previous;
    f.cleanup();
  }
});

test('RED rejects identical exception/message from fixtures, rules, helpers and missing stacks', () => {
  const f = fixture({ inventoryMode: true });
  try {
    const contract = taskContract(f, 'TASK-ORIGIN-FIX');
    const item = contract.verification.cases[0];
    item.test = { target: 0, className: 'example.InputTest', name: 'approved[0]' };
    item.expectedFailure.origin = { className: 'example.InputTest', methodName: 'approved', fileName: 'InputTest.kt', lineNumber: 42 };
    validateContract(contract, f.config);
    const evaluate = stack => evaluateCoverage(contract, { cases: [] }, { cases: [{ taskPath: ':app:testDebugUnitTest', ...item.test,
      result: 'FAILURE', failures: [{ type: item.expectedFailure.type, message: item.expectedFailure.messageIncludes, stack }] }] }, 'red');
    const good = ['org.junit.Assert.fail(Assert.java:89)', 'example.InputTest.approved(InputTest.kt:42)', 'java.base/java.lang.reflect.Method.invoke(Method.java:580)'];
    assert.equal(evaluate(good).summary.expectedRed, 1);
    for (const bad of [[], ['example.InputTest.setUp(InputTest.kt:42)'], ['example.InputTest.tearDown(InputTest.kt:42)'],
      ['example.FailingRule.evaluate(FailingRule.kt:42)'], ['example.InputTest.<init>(InputTest.kt:42)'],
      ['example.InputTest.helper(InputTest.kt:15)', ...good], good.map(s => s.replace(':42)', ':43)')),
      ['invalid stack', ...good]]) {
      assert.throws(() => evaluate(bad), error => error.code === 'CASE_EXPECTATION_MISMATCH');
    }
    item.expectedFailure.origin = 'Legacy explanation remains descriptive; failure must occur in the test body';
    assert.equal(evaluate(good).summary.expectedRed, 1);
    assert.throws(() => evaluate(['example.InputTest.setUp(InputTest.kt:42)']), error => error.code === 'CASE_EXPECTATION_MISMATCH');
  } finally { f.cleanup(); }
});

test('every criterion requires a case or an enabled mandatory verification task', () => {
  const f = fixture({ inventoryMode: true });
  try {
    const contract = taskContract(f, 'TASK-COVERAGE-FIX');
    contract.acceptanceCriteria.push('Release output builds successfully');
    assert.throws(() => validateContract(contract, f.config), /Every acceptance criterion/);
    contract.verification.criteriaEvidence = [{ criterion: 2, kind: 'build', references: f.config.gradleVerification.assembleTasks }];
    validateContract(contract, f.config);
    contract.verification.criteriaEvidence[0] = { criterion: 2, kind: 'lint', references: f.config.gradleVerification.lintTasks };
    f.config.lintEnabled = false;
    assert.throws(() => validateContract(contract, f.config), /mandatory enabled/);
    contract.verification.criteriaEvidence[0] = { criterion: 2, kind: 'behavior', references: ['UNKNOWN-CASE'] };
    assert.throws(() => validateContract(contract, f.config), /mandatory enabled/);
    contract.verification.criteriaEvidence[0].references = [contract.verification.cases[0].id];
    validateContract(contract, f.config);
    contract.verification.criteriaEvidence.push(structuredClone(contract.verification.criteriaEvidence[0]));
    assert.throws(() => validateContract(contract, f.config), /duplicate criterion/);
  } finally { f.cleanup(); }
});

test('inventory rejects an actual JVM change with unchanged source and launch environment', () => {
  const f = fixture({ inventoryMode: true });
  try {
    const runtimeFile = join(f.base, 'actual-runtime.json');
    writeFileSync(runtimeFile, JSON.stringify(runtime));
    const wrapper = join(f.root, 'gradlew');
    const original = readFileSync(wrapper, 'utf8');
    const updated = original.replace(`console.log(${JSON.stringify(runtimeOutput.trim())});`,
      `console.log('ORCHESTRATOR_BUILD_RUNTIME=' + fs.readFileSync(${JSON.stringify(runtimeFile)}, 'utf8'));`);
    assert.notEqual(updated, original);
    writeFileSync(wrapper, updated);
    command(f.root, ['add', 'gradlew']); command(f.root, ['commit', '-qm', 'Use external simulated JVM record']);
    const contract = taskContract(f, 'TASK-RUNTIME-BINDING');
    const cf = join(f.root, `automation/tasks/${contract.id}.json`);
    writeFileSync(cf, JSON.stringify(contract));
    writeFileSync(join(f.root, contract.planPath), 'Approved runtime binding verification\n');
    const evidence = join(f.root, '.git/automation-runtime/evidence', contract.id);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'baseline.json'), JSON.stringify({ head: command(f.root, ['rev-parse', 'HEAD']) }));
    const phase = name => require(join(f.root, 'automation/verification/inventory.cjs'))
      .runPhase(name, cf, join(f.root, 'automation/config.json'), f.root, evidence);
    phase('baseline');
    writeFileSync(join(f.root, `app/src/test/java/${contract.id}Test.kt`), 'class ApprovedTest\n');
    writeFileSync(runtimeFile, JSON.stringify({ ...runtime, javaVendor: 'Different actual JVM' }));
    assert.throws(() => phase('red'), error => error.code === 'EVIDENCE_CHANGED' && /Actual Gradle/.test(error.message));
    assert.equal(existsSync(join(evidence, 'red.json')), false);
    writeFileSync(runtimeFile, JSON.stringify(runtime));
    phase('red');
    writeFileSync(join(f.root, `app/src/main/java/${contract.id}.kt`), 'class Implementation\n');
    phase('green'); phase('check');
    writeFileSync(runtimeFile, JSON.stringify({ ...runtime, javaVendor: 'Different actual JVM' }));
    assert.throws(() => phase('green'), error => error.code === 'EVIDENCE_CHANGED');
    assert.throws(() => phase('check'), error => error.code === 'EVIDENCE_CHANGED');
  } finally { f.cleanup(); }
});
