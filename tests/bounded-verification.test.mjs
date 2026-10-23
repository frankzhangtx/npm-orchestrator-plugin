import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { selectVerification, validateVerificationScope } = require('../templates/automation/verification/project.cjs');
const { validateContract } = require('../templates/automation/verification/contract.cjs');

function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'bounded-verification-'));
  const module = (id, dependencies = [], jvm = false) => {
    const variants = jvm ? [null] : ['FreeDebug', 'PaidDebug', 'FreeRelease'];
    return { gradlePath: `:${id}`, directory: id, buildFile: `${id}/build.gradle`, type: jvm ? 'jvm-library' : 'application',
      namespace: null, applicationId: null, dependencies,
      sources: (jvm ? ['main', 'test'] : ['main', 'free', 'release', 'test', 'testPaidDebug', 'androidTestFreeDebug']).map(name =>
        ({ name, kind: /^(test|androidTest)/.test(name) ? 'test' : 'production', paths: [`${id}/src/${name}/**`] })),
      tasks: variants.flatMap(variant => ['unit', 'assemble', ...(jvm ? [] : ['lint', 'device'])].map(kind => ({ kind, variant,
        path: `:${id}:${kind === 'unit' ? (jvm ? 'test' : `test${variant}UnitTest`) : kind === 'device' ? `connected${variant}AndroidTest` : kind + (variant ?? '')}` }))) };
  };
  const modules = [module('app', [':core']), module('other'), module('core', [], true)];
  modules[0].tasks.push({ path: ':app:assembleDebug', kind: 'assemble', variant: 'Debug' });
  const config = { lintEnabled: false, unitTestsEnabled: true, protectedPaths: ['settings.gradle', '**/build.gradle'],
    androidProject: { settingsFile: 'settings.gradle', capabilities: { version: 1, buildRoot: '.', modules },
      modules: modules.map(m => ({ gradlePath: m.gradlePath, directory: m.directory, buildFile: m.buildFile, dsl: 'groovy', type: m.type, namespace: null, applicationId: null })),
      productionPaths: modules.flatMap(m => m.sources.filter(s => s.kind === 'production').flatMap(s => s.paths)),
      testPaths: modules.flatMap(m => m.sources.filter(s => s.kind === 'test').flatMap(s => s.paths)) },
    gradleVerification: Object.fromEntries(Object.entries({ fullUnitTestTasks: 'unit', focusedTestTasks: 'unit', assembleTasks: 'assemble', lintTasks: 'lint', deviceTestTasks: 'device' })
      .map(([group, kind]) => [group, modules.flatMap(m => m.tasks.filter(t => t.kind === kind).map(t => t.path))])) };
  const contract = { schemaVersion: 8, id: 'TASK-BOUNDED', title: 'Sort generated defaults', designApproved: true,
    planPath: 'docs/plans/TASK-BOUNDED.md', ambiguityPolicy: 'BLOCKED', maxFixLoops: 0, maxChangedFiles: 2,
    allowedPaths: ['core/src/main/Defaults.kt', 'core/src/test/DefaultsTest.kt'], forbiddenPaths: [...config.protectedPaths],
    allowedWorkflowSkills: ['test-driven-development', 'systematic-debugging', 'verification-before-completion'].map(name => `android-orchestrator-${name}`),
    acceptanceCriteria: ['Sort defaults while preserving values'], nonGoals: ['No application changes'],
    targetTests: [{ gradleTask: ':core:test', filter: 'example.DefaultsTest' }], deviceTestsRequired: false, testPolicy: 'required',
    recovery: { version: 1, scope: 'baseline', maxEnvironmentRetries: 0, maxManualRetries: 0, maxElapsedMs: 1000, initialDelayMs: 1000, maxDelayMs: 1000, maxSameFailureRetries: 0 },
    execution: { version: 1, maxRunMs: 1000, maxStageMs: 1000, terminationGraceMs: 1000 },
    stageRecovery: { version: 1, maxEnvironmentRetries: 0, maxElapsedMs: 1000, initialDelayMs: 1000, maxDelayMs: 1000, maxSameFailureRetries: 0 },
    continuity: { version: 1, isolatedAutoIntegration: false, planningRefresh: 'reject', planningInputs: ['core/src/main/Defaults.kt'] },
    verification: { version: 2, maxPreparationFixes: 0, inventory: { mode: 'focusedBaseline', existingSkips: 'reject', emptyBaseline: 'allow' },
      scope: { version: 3, mode: 'bounded', maxManualRetries: 0, regressionTests: [], tasks: { assembleTasks: [], lintTasks: [], deviceTestTasks: [] } },
      cases: [{ id: 'SORT-DEFAULTS', criterion: 1, intent: 'change', before: 'fail', after: 'pass', source: 'userRequirement',
        test: { target: 0, className: 'example.DefaultsTest', name: 'sorts' },
        expectedFailure: { type: 'java.lang.AssertionError', origin: { className: 'example.DefaultsTest', methodName: 'sorts' } } }] } };
  return { root, config, contract, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('JVM source edits freeze only approved tests without consumer builds or baseline execution', () => {
  const f = scenario(); try {
    validateContract(f.contract, f.config);
    const plan = selectVerification(f.config, f.contract, f.root, ['core/src/main/Defaults.kt']);
    assert.equal(plan.version, 3); assert.equal(plan.mode, 'bounded');
    assert.equal(plan.scopePolicy.baseline, 'snapshot'); assert.equal(plan.scopePolicy.buildMode, 'incremental');
    assert.deepEqual(plan.affectedModules, [':core']); assert.deepEqual(plan.selectedVariants, { ':core': [null] });
    assert.deepEqual(plan.tasks, { fullUnitTestTasks: [], assembleTasks: [], lintTasks: [], deviceTestTasks: [] });
    assert.deepEqual(plan.testSelection.targets, []);
    assert.deepEqual(plan.targetTests, f.contract.targetTests); assert.deepEqual(plan.cleanTasks, []);
    assert.equal(plan.testSelection.mode, 'selected');
    assert.equal(f.contract.verification.scope.baseline, undefined);
  } finally { f.cleanup(); }
});

test('one Android variant and exact regressions stay fixed between preview and execution', () => {
  const f = scenario(); try {
    f.contract.allowedPaths = ['app/src/main/Feature.kt', 'app/src/test/FeatureTest.kt'];
    f.contract.targetTests = [{ gradleTask: ':app:testFreeDebugUnitTest', filter: 'example.FeatureTest.changed' }];
    f.contract.verification.scope.regressionTests = [{ gradleTask: ':app:testFreeDebugUnitTest', filter: 'example.RegressionTest.preserved' }];
    f.contract.verification.scope.tasks.assembleTasks = [':app:assembleFreeDebug'];
    const preview = selectVerification(f.config, f.contract, f.root, [], true);
    const actual = selectVerification(f.config, f.contract, f.root, ['app/src/main/Feature.kt']);
    assert.deepEqual(preview.tasks, actual.tasks);
    assert.deepEqual(actual.selectedVariants, { ':app': ['FreeDebug'] });
    assert.deepEqual(actual.testSelection.targets, f.contract.verification.scope.regressionTests);
    assert.deepEqual(actual.buildDependencies, [':core']);
    assert(!JSON.stringify(actual.tasks).includes('Paid')); assert(!JSON.stringify(actual.tasks).includes('core'));
  } finally { f.cleanup(); }
});

test('out of contract changes and unverified source variants fail without fallback', () => {
  const f = scenario(); try {
    assert.throws(() => selectVerification(f.config, f.contract, f.root, ['app/src/main/Feature.kt']), /outside approved scope/);
    f.contract.allowedPaths = ['app/src/release/Feature.kt'];
    f.contract.targetTests = [{ gradleTask: ':app:testFreeDebugUnitTest', filter: 'example.FeatureTest' }];
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /source set.*not covered/);
    f.contract.allowedPaths = ['app/src/main/Feature.kt', 'app/src/testPaidDebug/FeatureTest.kt'];
    assert.throws(() => selectVerification(f.config, f.contract, f.root, ['app/src/main/Feature.kt']), /testPaidDebug.*not covered/);
    f.contract.allowedPaths = ['unknown/Feature.kt'];
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /cannot map approved path/);
  } finally { f.cleanup(); }
});

test('wildcard filters, unknown tasks and aggregate tasks are rejected', () => {
  const f = scenario(); try {
    f.contract.targetTests[0].filter = 'example.*';
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /wildcards/);
    f.contract.targetTests[0].filter = 'example.DefaultsTest';
    f.contract.verification.scope.regressionTests = [{ gradleTask: ':core:test', filter: '*Test' }];
    assert.throws(() => validateVerificationScope(f.contract.verification.scope), /wildcards/);
    f.contract.verification.scope.regressionTests = [];
    f.contract.verification.scope.tasks.assembleTasks = [':unknown:assembleDebug'];
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /not a configured/);
    f.contract.verification.scope.tasks.assembleTasks = [':app:assembleDebug'];
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /concrete variant|aggregate/);
  } finally { f.cleanup(); }
});

test('custom JVM source sets cannot silently borrow standard test-task coverage', () => {
  const f = scenario(); try {
    const core = f.config.androidProject.capabilities.modules.find(module => module.gradlePath === ':core');
    core.sources.push({ name: 'integrationTest', kind: 'test', paths: ['core/src/integrationTest/**'] });
    f.config.androidProject.testPaths.push('core/src/integrationTest/**');
    f.contract.allowedPaths = ['core/src/integrationTest/IntegrationTest.kt'];
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /custom JVM source set.*integrationTest/);
  } finally { f.cleanup(); }
});

test('acceptance evidence cannot append tasks to the frozen envelope', () => {
  const f = scenario(); try {
    f.contract.verification.criteriaEvidence = [{ criterion: 1, kind: 'build', references: [':app:assembleFreeDebug'] }];
    assert.throws(() => validateContract(f.contract, f.config), /outside the explicit assembleTasks/);
    f.contract.verification.scope.tasks.assembleTasks = [':app:assembleFreeDebug'];
    validateContract(f.contract, f.config);
    assert.deepEqual(selectVerification(f.config, f.contract, f.root, [], true).tasks.assembleTasks, [':app:assembleFreeDebug']);
  } finally { f.cleanup(); }
});

test('enabled lint and required device verification must be explicitly approved', () => {
  const f = scenario(); try {
    f.contract.allowedPaths = ['app/src/main/Feature.kt'];
    f.contract.targetTests = [{ gradleTask: ':app:testFreeDebugUnitTest', filter: 'example.FeatureTest' }];
    f.config.lintEnabled = true;
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /lint requires an explicit/);
    f.contract.verification.scope.tasks.lintTasks = [':app:lintFreeDebug'];
    f.contract.deviceTestsRequired = true;
    assert.throws(() => selectVerification(f.config, f.contract, f.root, [], true), /needs explicit device tasks/);
    f.contract.verification.scope.tasks.deviceTestTasks = [':app:connectedFreeDebugAndroidTest'];
    const plan = selectVerification(f.config, f.contract, f.root, [], true);
    assert.deepEqual(plan.tasks.lintTasks, [':app:lintFreeDebug']);
    assert.deepEqual(plan.tasks.deviceTestTasks, [':app:connectedFreeDebugAndroidTest']);
  } finally { f.cleanup(); }
});

test('snapshot preserves existing tests without asserting a measured baseline or allowing supplemental widening', () => {
  const f = scenario(); try {
    f.contract.verification.cases.push({ id: 'PRESERVE-VALUES', criterion: 1, intent: 'preserve', before: 'pass', after: 'pass', source: 'existingTest',
      test: { target: 0, className: 'example.DefaultsTest', name: 'preserves' } });
    validateContract(f.contract, f.config);
    f.contract.verification.cases[1].source = 'measuredFact';
    assert.throws(() => validateContract(f.contract, f.config), /measured baseline claims/);
    f.contract.verification.scope.baseline = 'execute';
    validateContract(f.contract, f.config);
    f.contract.verification.supplementalTests = { mode: 'baselinePassingNewFiles', maxRevisions: 1 };
    assert.throws(() => validateContract(f.contract, f.config), /runtime scope expansion/);
  } finally { f.cleanup(); }
});

test('clean builds and baseline execution require explicit policy values', () => {
  const f = scenario(); try {
    f.contract.verification.scope.buildMode = 'clean'; f.contract.verification.scope.baseline = 'execute';
    const plan = selectVerification(f.config, f.contract, f.root, [], true);
    assert.equal(plan.scopePolicy.buildMode, 'clean'); assert.equal(plan.scopePolicy.baseline, 'execute');
    assert.deepEqual(plan.cleanTasks, [':core:clean']);
    f.contract.verification.scope.buildMode = 'retry-clean';
    assert.throws(() => validateVerificationScope(f.contract.verification.scope), /invalid policy/);
    for (const key of ['baseline', 'buildMode']) {
      const scope = { ...f.contract.verification.scope, baseline: 'snapshot', buildMode: 'incremental', [key]: null };
      assert.throws(() => validateVerificationScope(scope), /invalid policy/, `${key}=null is not a default`);
    }
  } finally { f.cleanup(); }
});
