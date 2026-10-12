import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, enqueue, taskContract, command } from './queue-fixture.mjs';
import { atomicJson, processIdentity } from '../dist/queue/storage.js';
import { assertAuthorized } from '../dist/queue/queue.js';
import { initialSupervision } from '../dist/queue/supervision.js';
import { queueCli } from '../dist/queue/cli.js';
import { createQueueTools } from '../dist/queue/tools.js';
import { ApprovalLedger } from '../dist/queue/approvals.js';

function running(f) {
  const item = enqueue(f, 'TASK-PROGRESS');
  const run = f.queue.reserve();
  f.queue.storage.transaction(doc => {
    doc.active.worker = processIdentity(process.pid);
    doc.items[0].state = 'PENDING'; doc.items[0].taskRoot = f.root;
  });
  const workspace = { taskId: item.taskId, queueKey: item.key, sourceRoot: item.sourceRoot, taskRoot: f.root, executionRunId: run.id };
  const state = { taskId: item.taskId, queueRunId: run.id, state: 'CODING', updatedAt: new Date().toISOString(), note: 'Running approved tests' };
  const workspacePath = join(f.queue.storage.runtime, 'workspaces', `${item.taskId}.json`);
  const statePath = join(f.queue.storage.runtime, 'state', `${item.taskId}.json`);
  atomicJson(workspacePath, workspace); atomicJson(statePath, state);
  return { item, run, workspace, state, workspacePath, statePath };
}

test('CLI and tools project a live Shell stage without changing queue or approvals', async () => {
  const f = fixture();
  try {
    const { item, run } = running(f);
    const before = readFileSync(f.queue.storage.path);
    const tool = createQueueTools(f.root, new ApprovalLedger()).android_orchestrator_queue;
    const ctx = { directory: f.root, worktree: f.root, agent: 'scheduled-planner', sessionID: 'progress', messageID: 'read', abort: new AbortController().signal };
    const views = [f.queue.details(item.key), (await queueCli(['status', f.root])).items[0], await queueCli(['status', f.root, item.key]),
      JSON.parse(await tool.execute({ action: 'status', key: item.key }, ctx)),
      JSON.parse(await tool.execute({ action: 'status' }, ctx)).items[0]];
    for (const view of views) {
      assert.equal(view.state, 'CODING'); assert.equal(view.recordedState, 'PENDING');
      assert.equal(view.progress.runId, run.id); assert.equal(view.progress.workerAlive, true);
      assert(view.progress.stageElapsedMs >= 0); assert(view.progress.runElapsedMs >= 0);
    }
    assert.deepEqual(readFileSync(f.queue.storage.path), before);
    assert.equal(f.queue.item(item.key).state, 'PENDING'); assertAuthorized(f.queue.item(item.key));
  } finally { f.cleanup(); }
});

test('legacy initial runs and supervised runs expose bounded live notes', () => {
  const f = fixture();
  try {
    const { item, state, statePath } = running(f);
    delete state.queueRunId; state.note = '😀'.repeat(4000); atomicJson(statePath, state);
    assert.equal(f.queue.details(item.key).state, 'CODING');
    assert.equal(Array.from(f.queue.details(item.key).progress.note).length, 180);
    f.queue.storage.transaction(doc => { doc.active.supervision = initialSupervision({ maxRunMs: 60000, maxStageMs: 30000 }, Date.now()); });
    assert.equal(f.queue.details(item.key).state, 'CODING');
    f.queue.storage.transaction(doc => { doc.active.supervision.state = 'TERM_SENT'; });
    assert.equal(f.queue.details(item.key).progress, null);
  } finally { f.cleanup(); }
});

test('stale, malformed, terminal and foreign runtime records never replace queue outcomes', () => {
  const f = fixture();
  try {
    const { item, state, statePath, workspace, workspacePath } = running(f);
    const before = readFileSync(f.queue.storage.path);
    for (const altered of [ { ...state, queueRunId: 'old-run' }, { ...state, taskId: 'TASK-OTHER' },
      { ...state, updatedAt: '2000-01-01T00:00:00Z' }, { ...state, updatedAt: 'invalid' },
      { ...state, updatedAt: '2999-01-01T00:00:00Z' }, { ...state, state: 'COMPLETED' },
      { ...state, state: 'AWAITING_HUMAN' }, { ...state, state: 'arbitrary' }, { ...state, note: 'x'.repeat(70000) } ]) {
      atomicJson(statePath, altered); assert.equal(f.queue.details(item.key).state, 'PENDING');
    }
    writeFileSync(statePath, '{'); assert.equal(f.queue.details(item.key).progress, null);
    atomicJson(statePath, state); atomicJson(workspacePath, { ...workspace, queueKey: 'TASK-OTHER@1' });
    assert.equal(f.queue.details(item.key).progress, null);
    atomicJson(workspacePath, { ...workspace, executionRunId: 'previous-run' });
    assert.equal(f.queue.details(item.key).state, 'CODING'); // Explicit state binding supports resume.
    delete state.queueRunId; atomicJson(statePath, state);
    assert.equal(f.queue.details(item.key).progress, null);
    assert.deepEqual(readFileSync(f.queue.storage.path), before);
    f.queue.storage.transaction(doc => { doc.active.worker = { pid: 99999999, started: 'missing' }; });
    assert.equal(f.queue.details(item.key).progress, null);
  } finally { f.cleanup(); }
});

test('a resumed worker projects fresh run-bound state over its retained BLOCKED record', () => {
  const f = fixture();
  try {
    const { item, workspace, workspacePath, state, statePath } = running(f);
    atomicJson(workspacePath, { ...workspace, executionRunId: 'previous-run' });
    f.queue.storage.transaction(doc => { doc.active.kind = 'resume'; doc.items[0].state = 'BLOCKED'; });
    assert.equal(f.queue.details(item.key).state, 'CODING');
    assert.equal(f.queue.details(item.key).recordedState, 'BLOCKED');
    atomicJson(statePath, { ...state, queueRunId: 'previous-run' });
    assert.equal(f.queue.details(item.key).state, 'BLOCKED');
    atomicJson(statePath, state);
    f.queue.storage.transaction(doc => { doc.active.outcome = { state: 'BLOCKED', error: 'Finished' }; });
    assert.equal(f.queue.details(item.key).progress, null);
  } finally { f.cleanup(); }
});

function capabilities(f) {
  const tasks = ['Debug', 'Release'].flatMap(variant => ['unit', 'assemble'].map(kind => ({ path: `:app:${kind === 'unit' ? `test${variant}UnitTest` : `assemble${variant}`}`, kind, variant })));
  f.config.androidProject.capabilities = { version: 1, buildRoot: '.', modules: [{ gradlePath: ':app', directory: 'app', buildFile: 'app/build.gradle.kts', type: 'application', namespace: 'example.queue', applicationId: 'example.queue', dependencies: [],
    sources: [{ name: 'main', kind: 'production', paths: ['app/src/main/**'] }, { name: 'test', kind: 'test', paths: ['app/src/test/**', 'app/src/androidTest/**'] }], tasks }] };
  f.config.gradleVerification.fullUnitTestTasks = tasks.filter(t => t.kind === 'unit').map(t => t.path);
  f.config.gradleVerification.focusedTestTasks = [':app:testDebugUnitTest'];
  f.config.gradleVerification.lintTasks = []; f.config.gradleVerification.deviceTestTasks = [];
  f.config.gradleVerification.assembleTasks = tasks.filter(t => t.kind === 'assemble').map(t => t.path);
  writeFileSync(join(f.root, 'automation/config.json'), JSON.stringify(f.config));
  command(f.root, ['add', 'automation/config.json']); command(f.root, ['commit', '-qm', 'Record capabilities']);
}

test('new unscoped drafts require a sealed and visible full-verification reason when capabilities exist', () => {
  const f = fixture({ inventoryMode: true });
  try {
    capabilities(f);
    const input = { contract: taskContract(f, 'TASK-FULL'), plan: '# Explicit legacy full verification contract\n', ...f.queue.snapshot() };
    assert.throws(() => f.queue.draft(input), /verificationFallbackReason/);
    for (const reason of ['', 'short', '全量'.repeat(100), 42]) assert.throws(() => f.queue.draft({ ...input, verificationFallbackReason: reason }), /verificationFallbackReason/);
    const reason = 'Release compatibility is explicitly required for this task.';
    const d = f.queue.draft({ ...input, verificationFallbackReason: reason });
    assert(f.queue.approvalText(d).includes(reason));
    assert.equal(f.queue.details(d.key).verificationFallbackReason, reason);
    const item = f.queue.enqueue(d.key, d.digest, f.queue.approvalText(d)); assertAuthorized(item);
    item.verificationFallbackReason += 'changed'; assert.throws(() => assertAuthorized(item), /fresh approval/);
  } finally { f.cleanup(); }
});

test('capability defaults accept affected Debug V7 and do not rewrite older stored drafts', () => {
  const f = fixture({ inventoryMode: true });
  try {
    const legacy = f.queue.draft({ contract: taskContract(f, 'TASK-LEGACY'), plan: '# Previously reviewed legacy full verification\n', ...f.queue.snapshot() });
    const approval = f.queue.approvalText(legacy);
    f.queue.enqueue(legacy.key, legacy.digest, approval);
    capabilities(f);
    const policy = { version: 1, maxEnvironmentRetries: 1, maxElapsedMs: 600000, initialDelayMs: 1000, maxDelayMs: 1000, maxSameFailureRetries: 1 };
    const contract = { ...taskContract(f, 'TASK-SCOPED'), schemaVersion: 7, stageRecovery: policy, recovery: { ...policy, scope: 'baseline', maxManualRetries: 1 }, execution: { version: 1, maxRunMs: 600000, maxStageMs: 300000, terminationGraceMs: 1000 } };
    contract.verification.scope = { version: 1, mode: 'affected', variants: 'debug', maxManualRetries: 1 };
    const input = { contract, plan: '# Explicit approved affected Debug verification\n', ...f.queue.snapshot() };
    const scoped = f.queue.draft(input);
    assert.equal(scoped.contract.verification.scope.variants, 'debug');
    const preview = f.queue.verificationPreview(contract);
    assert(!JSON.stringify(preview).includes('Release'));
    assert.throws(() => f.queue.draft({ ...input, verificationFallbackReason: 'Unnecessary full verification reason' }), /scoped contracts must omit/);
    const stored = f.queue.storage.read().drafts.find(d => d.key === legacy.key);
    assert.deepEqual(stored, legacy); assert.equal(f.queue.approvalText(stored), approval);
    // Only intake is stricter: old approved schema and approval text stay valid.
    const oldItem = f.queue.enqueue(legacy.key, legacy.digest, approval); assertAuthorized(oldItem);
    assert.equal(oldItem.contract.verification.scope, undefined);
  } finally { f.cleanup(); }
});

test('Planner reads generated capabilities/template and presents scoped policies before approval', () => {
  const planner = readFileSync(new URL('../templates/.opencode/agents/scheduled-planner.md', import.meta.url), 'utf8');
  assert.match(planner, /TASK-TEMPLATE\.json\.example/); assert.match(planner, /generated V7 template/);
  assert.match(planner, /mode: affected, variants: debug/); assert.match(planner, /verificationFallbackReason/);
  assert.doesNotMatch(planner, /Use schema V4 with verification version 2 unless/);
});
