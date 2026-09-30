import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { mock } from 'node:test';
const { persistStageRecord, fileHash } = createRequire(import.meta.url)('../templates/automation/verification/recovery.cjs');

test('stage checkpoints reject edits before, during publication and during sealing without adopting altered bytes', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'stage-checkpoint-'));
  const ledger = join(directory, 'red.json');
  const waiting = { state: 'WAITING', retriesUsed: 0, attempts: [1] };
  const changed = JSON.stringify({ ...waiting, retriesUsed: -1 });
  const seals = [];
  const checkpoint = (previous, next) => seals.push({ previous, next });
  try {
    const initial = persistStageRecord(ledger, waiting, '', checkpoint);
    assert.equal(initial, fileHash(ledger));
    assert.deepEqual(seals, [{ previous: '', next: initial }]);
    const bytes = fs.readFileSync(ledger);
    fs.writeFileSync(ledger, changed);
    assert.throws(() => persistStageRecord(ledger, waiting, initial, checkpoint), /changed before update/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), changed);
    fs.writeFileSync(ledger, bytes);
    const rename = fs.renameSync;
    const intercepted = mock.method(fs, 'renameSync', (source, target) => {
      rename(source, target);
      if (target === ledger) fs.writeFileSync(ledger, changed);
    });
    try {
      assert.throws(() => persistStageRecord(ledger, { ...waiting, retriesUsed: 1 }, initial, checkpoint), /changed before checkpoint/);
    } finally { intercepted.mock.restore(); }
    assert.equal(fs.readFileSync(ledger, 'utf8'), changed);
    assert.equal(seals.length, 1);
    fs.writeFileSync(ledger, bytes);
    assert.throws(() => persistStageRecord(ledger, waiting, initial, () => fs.writeFileSync(ledger, changed)), /changed during checkpoint/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), changed);
    fs.writeFileSync(ledger, bytes);
    const next = persistStageRecord(ledger, { ...waiting, retriesUsed: 1 }, initial, checkpoint);
    assert.equal(next, fileHash(ledger));
    assert.deepEqual(seals.at(-1), { previous: initial, next });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
