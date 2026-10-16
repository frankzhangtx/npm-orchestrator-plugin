import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fixture, taskContract } from './queue-fixture.mjs';
const { MAX_BYTES, resources, page } = createRequire(import.meta.url)('../templates/automation/verification/status.cjs');

test('large shell status is bounded; digest-bound pages reconstruct original UTF-8 evidence', () => {
  const f = fixture();
  try {
    const id = 'TASK-STATUS';
    writeFileSync(join(f.root, 'automation/tasks', id + '.json'), JSON.stringify(taskContract(f, id)));
    const evidence = join(f.queue.storage.runtime, 'evidence', id);
    mkdirSync(evidence, { recursive: true });
    const original = JSON.stringify({ valid: false, reasonCode: 'EXPECTED_EXCEPTION_MISMATCH', cases: Array.from({ length: 30000 }, (_, n) => ({ name: `中文😀${n}`, expected: 'AssertionError', actual: 'NullPointerException' })) });
    writeFileSync(join(evidence, 'red.json'), original);
    const args = ['scripts/automation/status.sh', id];
    const result = spawnSync('bash', args, { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert(Buffer.byteLength(result.stdout) <= MAX_BYTES);
    const status = JSON.parse(result.stdout);
    assert.equal(status.evidence.red.reasonCode, 'EXPECTED_EXCEPTION_MISMATCH');
    assert.equal(status.evidence.red.cases.count, 30000);
    assert.equal(status.runtime.repositoryLeaseMatches, null);
    assert.equal(status.summaryOnly, true);
    const index = status.evidenceIndex.red;
    const all = resources(f.root, f.queue.storage.runtime, id);
    let offset = 0;
    const chunks = [];
    do {
      const part = page(all, 'red', index.sha256, String(offset));
      chunks.push(Buffer.from(part.content, 'base64'));
      offset = part.nextOffset;
    } while (offset !== null);
    assert.equal(Buffer.concat(chunks).toString('utf8'), original);
    const paged = spawnSync('bash', [...args, '--evidence', 'red', index.sha256, '0'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(paged.status, 0, paged.stderr);
    assert.equal(JSON.parse(paged.stdout).nextOffset, 4096);
    assert.throws(() => page(all, '../../config', index.sha256), /Unknown/);
    assert.throws(() => page(all, 'red', '0'.repeat(64)), /digest/);
    assert.throws(() => page(all, 'red', index.sha256, '-1'), /offset/);
    writeFileSync(join(evidence, 'red.json'), '{}');
    assert.throws(() => page(resources(f.root, f.queue.storage.runtime, id), 'red', index.sha256), /digest/);
  } finally { f.cleanup(); }
});
