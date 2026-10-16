import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, enqueue, taskContract } from './queue-fixture.mjs';
import { TaskQueue } from '../dist/queue/queue.js';
import { scopeAllows, validateRunScope } from '../dist/queue/run-scope.js';
const execution = { version: 1, maxRunMs: 180000, maxStageMs: 30000, terminationGraceMs: 1000 };
const recovery = { version: 1, scope: 'baseline', maxEnvironmentRetries: 0, maxManualRetries: 0, maxElapsedMs: 900000, initialDelayMs: 1000, maxDelayMs: 60000, maxSameFailureRetries: 0 };
const scope = () => ({ version: 1, runId: 'test-validation', taskKeys: ['TASK-CANDIDATE@1'], expiresAt: new Date(Date.now() + 60000).toISOString(), cleanupExpiresAt: new Date(Date.now() + 120000).toISOString() });

test('durable scope excludes historical tasks through enqueue, reload and resume', () => {
  const f = fixture({ inventoryMode: true });
  try {
    enqueue(f, 'TASK-HISTORICAL');
    f.queue.control('pause');
    f.queue.setRunScope(scope());
    const historical = structuredClone(f.queue.item('TASK-HISTORICAL'));
    enqueue(f, 'TASK-CANDIDATE', { contract: { ...taskContract(f, 'TASK-CANDIDATE'), schemaVersion: 6, execution, recovery } });
    const reloaded = new TaskQueue(f.root);
    assert.equal(reloaded.reserve().key, 'TASK-CANDIDATE@1');
    assert.deepEqual(reloaded.item('TASK-HISTORICAL'), historical);
  } finally { f.cleanup(); }
});

test('expired scope remains closed across resume; only bounded scoped cleanup is allowed', () => {
  const f = fixture({ inventoryMode: true });
  try {
    enqueue(f, 'TASK-HISTORICAL');
    f.queue.control('pause');
    const s = scope(); s.expiresAt = new Date(Date.now() - 1000).toISOString();
    f.queue.setRunScope(s);
    enqueue(f, 'TASK-CANDIDATE', { contract: { ...taskContract(f, 'TASK-CANDIDATE'), schemaVersion: 6, execution, recovery } });
    assert.equal(f.queue.storage.read().paused, true);
    f.queue.control('resume');
    assert.equal(f.queue.reserve(), null);
    assert.equal(scopeAllows(s, 'TASK-CANDIDATE@1', true), true);
    assert.equal(scopeAllows(s, 'TASK-HISTORICAL@1', true), false);
    assert.equal(scopeAllows(s, 'TASK-CANDIDATE@1', true, Date.parse(s.cleanupExpiresAt)), false);
    assert.throws(() => scopeAllows({ ...s, version: 2 }, 'TASK-CANDIDATE@1'), /scope/);
    f.queue.control('pause');
    assert.throws(() => f.queue.setRunScope({ ...s, taskKeys: ['TASK-HISTORICAL@1'] }), /immutable/);
  } finally { f.cleanup(); }
});

test('five explicitly scoped candidates are accepted but a sixth or duplicate is rejected',()=>{
 const s={...scope(),taskKeys:Array.from({length:5},(_,i)=>`TASK-CANDIDATE-${i+1}@1`)};
 validateRunScope(s);
 assert.equal(scopeAllows(s,'TASK-CANDIDATE-5@1'),true);
 assert.equal(scopeAllows(s,'TASK-CANDIDATE-6@1'),false);
 assert.throws(()=>validateRunScope({...s,taskKeys:[...s.taskKeys,'TASK-CANDIDATE-6@1']}),/task keys/);
 assert.throws(()=>validateRunScope({...s,taskKeys:[...s.taskKeys.slice(0,4),s.taskKeys[0]]}),/task keys/);
});
