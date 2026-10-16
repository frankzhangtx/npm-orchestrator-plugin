import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, enqueue, taskContract } from './queue-fixture.mjs';
const execution = { version: 1, maxRunMs: 180000, maxStageMs: 30000, terminationGraceMs: 1000 };
const recovery = { version: 1, scope: 'baseline', maxEnvironmentRetries: 0, maxManualRetries: 0, maxElapsedMs: 900000, initialDelayMs: 1000, maxDelayMs: 60000, maxSameFailureRetries: 0 };
const scope = () => ({ version: 1, runId: 'deadline-test', taskKeys: ['TASK-CANDIDATE@1'], expiresAt: new Date(Date.now()+15000).toISOString(), cleanupExpiresAt: new Date(Date.now()+60000).toISOString() });
test('scoped supervisor cannot outlive its task authorization deadline', () => {
 const f=fixture({inventoryMode:true});
 try {
  f.queue.control('pause'); const s=scope(); f.queue.setRunScope(s);
  enqueue(f,'TASK-CANDIDATE',{contract:{...taskContract(f,'TASK-CANDIDATE'),schemaVersion:6,execution,recovery}});
  const run=f.queue.reserve();
  assert.equal(run.supervision.deadline,Date.parse(s.expiresAt));
  assert.equal(run.supervision.stageDeadline,Date.parse(s.expiresAt));
 } finally { f.cleanup(); }
});
test('scoped runs never silently add supervision authority to legacy contracts', () => {
 const f=fixture();
 try {
  f.queue.control('pause'); f.queue.setRunScope(scope()); enqueue(f,'TASK-CANDIDATE');
  assert.equal(f.queue.reserve(),null);
  assert.match(f.queue.item('TASK-CANDIDATE').waitingReason,/explicitly approved/);
 } finally { f.cleanup(); }
});
