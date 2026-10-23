import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, taskContract, command } from './queue-fixture.mjs';
import { assertAuthorized } from '../dist/queue/queue.js';
import { createQueueTools, guardExecutorCommand } from '../dist/queue/tools.js';
import { queueCli } from '../dist/queue/cli.js';
import { ApprovalLedger, PROPOSAL_APPROVAL } from '../dist/queue/approvals.js';

function capabilities(f) {
  const tasks = ['Debug', 'Release'].flatMap(variant => ['unit', 'assemble'].map(kind => ({
    path: `:app:${kind === 'unit' ? `test${variant}UnitTest` : `assemble${variant}`}`, kind, variant,
  })));
  const module = { gradlePath: ':app', directory: 'app', buildFile: 'app/build.gradle.kts', type: 'application',
    namespace: 'example.queue', applicationId: 'example.queue', dependencies: [],
    sources: [{ name: 'main', kind: 'production', paths: ['app/src/main/**'] },
      { name: 'test', kind: 'test', paths: ['app/src/test/**', 'app/src/androidTest/**'] }], tasks };
  f.config.androidProject.capabilities = { version: 1, buildRoot: '.', modules: [module] };
  f.config.gradleVerification.fullUnitTestTasks = tasks.filter(t => t.kind === 'unit').map(t => t.path);
  f.config.gradleVerification.focusedTestTasks = [...f.config.gradleVerification.fullUnitTestTasks];
  f.config.gradleVerification.assembleTasks = tasks.filter(t => t.kind === 'assemble').map(t => t.path);
  f.config.gradleVerification.lintTasks = []; f.config.gradleVerification.deviceTestTasks = []; f.config.lintEnabled = false;
  writeFileSync(join(f.root, 'automation/config.json'), `${JSON.stringify(f.config, null, 2)}\n`);
  command(f.root, ['add', 'automation/config.json']); command(f.root, ['commit', '-qm', 'Record capabilities']);
}
function input(f, id = 'TASK-BOUNDED') {
  const retry = { version: 1, maxEnvironmentRetries: 1, maxElapsedMs: 600000,
    initialDelayMs: 1000, maxDelayMs: 1000, maxSameFailureRetries: 1 };
  const contract = { ...taskContract(f, id), schemaVersion: 7, stageRecovery: retry,
    recovery: { ...retry, scope: 'baseline', maxManualRetries: 1 },
    execution: { version: 1, maxRunMs: 600000, maxStageMs: 300000, terminationGraceMs: 1000 } };
  contract.verification.scope = { version: 3, mode: 'bounded', maxManualRetries: 1,
    regressionTests: [], tasks: { assembleTasks: [], lintTasks: [], deviceTestTasks: [] } };
  return { contract, plan: '# Apply only the approved observable change and exact verification\n', ...f.queue.snapshot() };
}
function tree(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? tree(join(root, entry.name)).map(path => `${entry.name}/${path}`) : [entry.name]).sort();
}

test('API, CLI and intake previews are read-only before proposal approval and preserve a receipt', async () => {
  const f = fixture({ inventoryMode: true });
  try {
    capabilities(f); const proposed = input(f), before = tree(f.root);
    const ledger = new ApprovalLedger(), ctx = { directory: f.root, worktree: f.root, agent: 'scheduled-planner',
      sessionID: 'bounded', messageID: 'preview', abort: new AbortController().signal };
    const tool = createQueueTools(f.root, ledger).android_orchestrator_intake;
    const expected = f.queue.preview(proposed);
    assert.equal(expected.verificationPreview.scopePolicy.baseline, 'snapshot');
    assert.equal(expected.verificationPreview.scopePolicy.buildMode, 'incremental');
    assert.deepEqual(expected.verificationPreview.targetTests, proposed.contract.targetTests);
    assert.deepEqual(expected.verificationPreview.cleanTasks, []);
    assert.deepEqual(JSON.parse(await tool.execute({ action: 'preview', draftJson: JSON.stringify(proposed) }, ctx)), expected);
    assert.throws(() => ledger.peek(ctx, 'proposal', 'proposal'), /fresh, matching/);
    const hook = { tool: 'question', sessionID: ctx.sessionID, callID: 'approval' };
    ledger.before(hook, { args: { questions: [{ header: '方案确认', question: 'Approve the displayed bounded proposal?',
      options: [{ label: PROPOSAL_APPROVAL }, { label: '调整方案。' }] }] } });
    ledger.after(hook, { metadata: { answers: [[PROPOSAL_APPROVAL]] } });
    const proof = ledger.peek(ctx, 'proposal', 'proposal');
    await tool.execute({ action: 'preview', draftJson: JSON.stringify(proposed) }, ctx);
    assert.deepEqual(ledger.peek(ctx, 'proposal', 'proposal'), proof);
    const path = join(f.base, 'preview.json'); writeFileSync(path, JSON.stringify(proposed));
    assert.deepEqual(await queueCli(['preview', f.root, path]), expected);
    assert.deepEqual(tree(f.root), before);
    assert.equal(existsSync(f.queue.storage.path), false);
    assert.equal(existsSync(join(f.base, 'gradle-calls.jsonl')), false);
  } finally { f.cleanup(); }
});

test('preview uses committed planning inputs and drafting refuses a changed live configuration', () => {
  const f = fixture({ inventoryMode: true });
  try {
    capabilities(f); const proposed = input(f), expected = f.queue.preview(proposed);
    f.config.gradleVerification.assembleTasks.reverse();
    writeFileSync(join(f.root, 'automation/config.json'), JSON.stringify(f.config));
    assert.deepEqual(f.queue.preview(proposed), expected);
    assert.throws(() => f.queue.draft(proposed), /configuration changed after the planning snapshot/);
    assert.equal(existsSync(f.queue.storage.path), false);
  } finally { f.cleanup(); }
});

test('draft seals the exact preview, default choices and approval command ceiling', () => {
  const f = fixture({ inventoryMode: true });
  try {
    capabilities(f); const proposed = input(f), expected = f.queue.preview(proposed);
    const draft = f.queue.draft(proposed), approval = f.queue.approvalText(draft);
    assert.deepEqual(draft.verificationPreview, expected.verificationPreview);
    assert.equal(draft.verificationConfigSha256, expected.configSha256);
    assert.match(approval, /基线仅保存快照，不运行测试/); assert.match(approval, /增量编译并允许构建缓存/);
    assert.match(approval, /:app:testDebugUnitTest --tests TASK-BOUNDED/); assert.doesNotMatch(approval, /扩大至模块|Release|assemble/);
    const item = f.queue.enqueue(draft.key, draft.digest, approval); assertAuthorized(item);
    item.verificationPreview.tasks.assembleTasks.push(':app:assembleRelease');
    assert.throws(() => assertAuthorized(item), /fresh approval/);
  } finally { f.cleanup(); }
});

test('enqueue rejects configuration drift and leaves the reviewed draft unapproved', () => {
  const f = fixture({ inventoryMode: true });
  try {
    capabilities(f); const draft = f.queue.draft(input(f));
    f.config.gradleVerification.focusedTestTasks.reverse();
    writeFileSync(join(f.root, 'automation/config.json'), JSON.stringify(f.config));
    assert.throws(() => f.queue.enqueue(draft.key, draft.digest, f.queue.approvalText(draft)), /Sealed verification preview changed/);
    assert.equal(f.queue.storage.read().items.length, 0);
    assert.equal(f.queue.storage.read().drafts[0].digest, draft.digest);
  } finally { f.cleanup(); }
});

test('explicit baseline execution and clean choices appear in the sealed preview and approval', () => {
  const f = fixture({ inventoryMode: true });
  try {
    capabilities(f); const proposed = input(f);
    proposed.contract.verification.scope.baseline = 'execute';
    proposed.contract.verification.scope.buildMode = 'clean';
    proposed.contract.verification.scope.tasks.assembleTasks = [':app:assembleDebug'];
    const draft = f.queue.draft(proposed), approval = f.queue.approvalText(draft);
    assert.deepEqual(draft.verificationPreview.cleanTasks, [':app:clean']);
    assert.match(approval, /运行已列出的目标基线测试/); assert.match(approval, /明确授权所选模块干净构建/);
    assert.match(approval, /:app:clean/); assert.match(approval, /:app:assembleDebug/);
    assert.equal(existsSync(join(f.base, 'gradle-calls.jsonl')), false);
  } finally { f.cleanup(); }
});

test('new legacy scoped drafts need explicit reasons while stored approvals remain valid', () => {
  const f = fixture({ inventoryMode: true });
  try {
    const old = f.queue.draft({ contract: taskContract(f, 'TASK-OLD'), plan: '# Previously approved legacy verification\n', ...f.queue.snapshot() });
    const oldApproval = f.queue.approvalText(old);
    f.queue.enqueue(old.key, old.digest, oldApproval);
    capabilities(f); const proposed = input(f);
    proposed.contract.verification.scope = { version: 1, mode: 'affected', variants: 'debug', maxManualRetries: 1 };
    assert.throws(() => f.queue.draft(proposed), /verificationFallbackReason/);
    const legacy = f.queue.draft({ ...proposed, verificationFallbackReason: 'Explicitly test compatibility with the original affected verification protocol.' });
    assert.match(f.queue.approvalText(legacy), /旧版影响范围验证/);
    assert.equal(legacy.verificationPreview, undefined);
    assert.deepEqual(f.queue.storage.read().drafts.find(d => d.key === old.key), old);
    assertAuthorized(f.queue.enqueue(old.key, old.digest, oldApproval));
  } finally { f.cleanup(); }
});

test('active bounded contracts reject direct Gradle even for a globally configured task', () => {
  const f = fixture({ inventoryMode: true }), previous = process.env.AUTOMATION_QUEUE_RUN_ID;
  try {
    capabilities(f); const draft = f.queue.draft(input(f));
    f.queue.enqueue(draft.key, draft.digest, f.queue.approvalText(draft));
    const active = f.queue.reserve(); process.env.AUTOMATION_QUEUE_RUN_ID = active.id;
    assert.throws(() => guardExecutorCommand({ tool: 'bash' }, { args: { command: './gradlew :app:testDebugUnitTest --tests TASK-BOUNDED' } }, f.root), /Bounded verification permits only managed scripts/);
    assert.doesNotThrow(() => guardExecutorCommand({ tool: 'bash' }, { args: { command: './scripts/automation/quality-gate.sh TASK-BOUNDED' } }, f.root));
    assert.equal(existsSync(join(f.base, 'gradle-calls.jsonl')), false);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_QUEUE_RUN_ID; else process.env.AUTOMATION_QUEUE_RUN_ID = previous;
    f.cleanup();
  }
});
