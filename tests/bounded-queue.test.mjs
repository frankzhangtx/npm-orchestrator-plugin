import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, taskContract, command, run } from './queue-fixture.mjs';

const id = 'TASK-BOUNDED-QUEUE';
const testClass = 'BoundedQueueTest';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const rows = file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const evidence = f => join(f.queue.storage.runtime, 'evidence', id);
function setup({ retry = false } = {}) {
  const f = fixture({ inventoryMode: true, workspaceStrategy: 'isolatedWorktree', commitPolicy: 'autoCommit',
    lintEnabled: retry, stageFaults: retry ? [{ phase: 'integration', part: 'lint', failures: 1,
      message: "Could not GET 'https://repo.example.org/lint.jar'\nRemote host terminated the handshake" }] : [] });
  const modules = ['app', 'other'].map(name => ({ gradlePath: `:${name}`, directory: name, buildFile: `${name}/build.gradle.kts`,
    type: 'application', namespace: `example.${name}`, applicationId: `example.${name}`, dependencies: [],
    sources: ['main', 'test', 'androidTest'].map(source => ({ name: source, kind: source === 'main' ? 'production' : 'test', paths: [`${name}/src/${source}/**`] })),
    tasks: ['Debug', 'Release'].flatMap(variant => ['unit', 'assemble', 'lint', 'device'].map(kind => ({ kind, variant,
      path: `:${name}:${kind === 'unit' ? `test${variant}UnitTest` : kind === 'device' ? `connected${variant}AndroidTest` : kind + variant}` }))) }));
  f.config.androidProject.capabilities = { version: 1, buildRoot: '.', modules };
  f.config.androidProject.modules = modules.map(m => ({ gradlePath: m.gradlePath, directory: m.directory, buildFile: m.buildFile,
    dsl: 'kotlin', type: m.type, namespace: m.namespace, applicationId: m.applicationId }));
  for (const [key, kind] of [['productionPaths', 'production'], ['testPaths', 'test']])
    f.config.androidProject[key] = modules.flatMap(m => m.sources.filter(s => s.kind === kind).flatMap(s => s.paths));
  for (const [group, kind] of Object.entries({ fullUnitTestTasks: 'unit', focusedTestTasks: 'unit', assembleTasks: 'assemble', lintTasks: 'lint', deviceTestTasks: 'device' }))
    f.config.gradleVerification[group] = modules.flatMap(m => m.tasks.filter(t => t.kind === kind).map(t => t.path));
  writeFileSync(join(f.root, 'automation/config.json'), JSON.stringify(f.config, null, 2) + '\n');
  const oldTests = 'import org.junit.Test\nclass BoundedQueueTest { @Test fun legacy() {} }\n';
  const newTests = oldTests.replace(' }\n', ' @Test fun `approved behavior`() {} }\n');
  const testFile = `app/src/test/java/${id}Test.kt`;
  writeFileSync(join(f.root, testFile), oldTests);
  const agent = join(f.bin, 'opencode');
  writeFileSync(agent, readFileSync(agent, 'utf8').replace("'class RegressionTest {}\\n'", JSON.stringify(newTests)));
  let gradle = readFileSync(join(f.root, 'gradlew'), 'utf8');
  gradle = gradle.replace('JSON.stringify({cwd:process.cwd(),args,at:Date.now()})',
    "JSON.stringify({cwd:process.cwd(),args,at:Date.now(),head:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),stage:process.env.AUTOMATION_STAGE_RECOVERY_PHASE??null,inventoryPhase:args.some(a=>a.startsWith('-Dorchestrator.inventoryRequest='))?JSON.parse(fs.readFileSync(args.find(a=>a.startsWith('-Dorchestrator.inventoryRequest=')).split('=').slice(1).join('='))).phase:null})");
  gradle = gradle.replace("const part=inventoryArg?'inventory':", "const part=args.includes(':app:lintDebug')?'lint':inventoryArg?'inventory':");
  gradle = gradle.replaceAll("fs.existsSync('app/src/main/java/'+id+'.kt')", `fs.existsSync('app/src/main/java/${id}.kt')`);
  writeFileSync(join(f.root, 'gradlew'), gradle);
  command(f.root, ['add', 'automation/config.json', 'gradlew', testFile]); command(f.root, ['commit', '-qm', 'Prepare exact verification fixture']);
  return f;
}
function approve(f) {
  const retry = { version: 1, maxEnvironmentRetries: 0, maxElapsedMs: 600000,
    initialDelayMs: 1000, maxDelayMs: 1000, maxSameFailureRetries: 0 };
  const contract = { ...taskContract(f, id), schemaVersion: 8, stageRecovery: retry,
    recovery: { ...retry, scope: 'baseline', maxManualRetries: 1 },
    execution: { version: 1, maxRunMs: 300000, maxStageMs: 180000, terminationGraceMs: 1000 },
    continuity: { version: 1, isolatedAutoIntegration: true, planningRefresh: 'reject',
      planningInputs: ['app/src/main/java/Baseline.kt', `app/src/main/java/${id}.kt`, `app/src/test/java/${id}Test.kt`] } };
  contract.targetTests[0].filter = testClass;
  contract.verification.cases[0].test.className = testClass;
  contract.verification.scope = { version: 3, mode: 'bounded', maxManualRetries: 1,
    // Repeated exact targets must reuse the sealed focused evidence during
    // acceptance, while a new HEAD must still execute that focused test once.
    regressionTests: [...contract.targetTests], tasks: { assembleTasks: [':app:assembleDebug'],
      lintTasks: f.config.lintEnabled ? [':app:lintDebug'] : [], deviceTestTasks: [] } };
  const draft = f.queue.draft({ contract, plan: '# Implement the scoped behavior; keep exact targets and one final package build.\n', ...f.queue.snapshot() });
  return f.queue.enqueue(draft.key, draft.digest, f.queue.approvalText(draft));
}
function assertBoundedCalls(f, completedCommit, expectedLintCalls = 0) {
  const calls = rows(join(f.base, 'gradle-calls.jsonl'));
  assert.equal(calls.some(call => call.args.includes('help')), false, 'no diagnostic Gradle help processes');
  assert.equal(calls.some(call => call.args.includes('--dry-run')), false, 'no baseline discovery Gradle process');
  assert.equal(calls.some(call => call.inventoryPhase === 'baseline'), false, 'default baseline does not execute tests');
  assert.equal(calls.some(call => call.args.some(arg => arg.startsWith(':') && (arg.includes('Release') || arg.startsWith(':other:')) ||
    arg === 'clean' || arg.endsWith(':clean') || arg === '--rerun-tasks')), false, 'only explicit Debug verification tasks are requested');
  const collections = calls.filter(call => call.inventoryPhase);
  assert.deepEqual(collections.map(call => [call.stage, call.inventoryPhase]), [['red', 'red'], ['green', 'green'], ['integration', 'green']]);
  assert.equal(calls.filter(call => call.args.includes(':app:assembleDebug')).length, 1);
  assert.equal(calls.filter(call => call.args.includes(':app:lintDebug')).length, expectedLintCalls);
  assert(calls.every(call => call.args.includes('--build-cache') && !call.args.includes('--no-build-cache')));
  assert(calls.filter(call => call.stage === 'integration').every(call => call.head === completedCommit));
  assert(collections.filter(call => call.stage !== 'integration').every(call => call.head !== completedCommit));
  assert.equal(calls.filter(call => call.stage === 'review').length, 0);
  return calls;
}

test('bounded queue skips baseline runs, reuses GREEN for Review and verifies one final build at the integrated HEAD', { timeout: 360000 }, async () => {
  const f = setup(); try {
    const baselineHead = command(f.root, ['rev-parse', 'HEAD']);
    approve(f);
    const result = await run(f, { timeoutMs: 330000 });
    assert.equal(result.item.state, 'COMPLETED', result.output + result.item.waitingReason);
    const directory = evidence(f), baseline = read(join(directory, 'baseline.json'));
    assert.equal(baseline.testsExecuted, false); assert.equal(baseline.state, 'CAPTURED');
    assert.equal(baseline.outcome, null);
    const snapshot = read(join(directory, 'baseline-inventory.json'));
    assert.equal(snapshot.execution, 'NOT_RUN');
    assert.equal(existsSync(join(directory, 'baseline-discovery.json')), false);
    const green = read(join(directory, 'stage-recovery/verification-green.json'));
    const review = read(join(directory, 'stage-recovery/verification-review.json'));
    const integration = read(join(directory, 'stage-recovery/verification-integration.json'));
    assert.equal(review.reusedFrom.phase, 'green'); assert.equal(review.attempts.length, 0);
    assert.deepEqual(green.attempts.map(attempt => attempt.part), ['focused', 'inventory-check']);
    assert.equal(integration.attempts.filter(attempt => attempt.part === 'assemble').length, 1);
    assert.equal(integration.attempts.filter(attempt => attempt.part === 'focused').length, 1);
    assert.equal(integration.reusedFrom, undefined, 'commit-sensitive verification must not reuse the earlier HEAD');
    assert.equal(integration.binding.head, result.item.completedCommit);
    assert.equal(command(f.root, ['rev-parse', 'HEAD']), result.item.completedCommit);
    assert.equal(command(f.root, ['rev-parse', `${result.item.completedCommit}^`]), baselineHead);
    assertBoundedCalls(f, result.item.completedCommit);
    assert.deepEqual(rows(join(f.base, 'agent-calls.jsonl')).map(call => call.role), ['scheduled-coder', 'scheduled-reviewer']);
    assert.equal(command(f.root, ['status', '--porcelain']), '');
  } finally { f.cleanup(); }
});

test('bounded integration recovery retries only failed lint and preserves the verified test/build checkpoints', { timeout: 420000 }, async () => {
  const f = setup({ retry: true }); try {
    approve(f);
    const failed = await run(f, { timeoutMs: 300000 });
    assert.equal(failed.item.state, 'INTEGRATION_BLOCKED', failed.output + failed.item.waitingReason);
    const directory = evidence(f), before = read(join(directory, 'stage-recovery/verification-integration.json'));
    const transaction = read(join(directory, 'commit-transaction.json'));
    assert.equal(before.state, 'EXHAUSTED'); assert(before.checkpoints.assemble); assert(before.checkpoints.focused);
    f.queue.request(id, 'recover');
    const completed = await run(f, { timeoutMs: 120000 });
    assert.equal(completed.item.state, 'COMPLETED', completed.output + completed.item.waitingReason);
    assert.equal(completed.item.completedCommit, transaction.commit);
    const after = read(join(directory, 'stage-recovery/verification-integration.json'));
    assert.equal(after.manualRetriesUsed, 1);
    assert.equal(after.attempts.filter(attempt => attempt.part === 'focused').length, 1);
    assert.equal(after.attempts.filter(attempt => attempt.part === 'assemble').length, 1);
    assert.equal(after.attempts.filter(attempt => attempt.part === 'lint').length, 2);
    assert.deepEqual(after.checkpoints.assemble, before.checkpoints.assemble);
    assertBoundedCalls(f, completed.item.completedCommit, 2);
    assert.deepEqual(rows(join(f.base, 'agent-calls.jsonl')).map(call => call.role), ['scheduled-coder', 'scheduled-reviewer']);
  } finally { f.cleanup(); }
});
