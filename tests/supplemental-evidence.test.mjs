import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { command, fixture, taskContract } from './queue-fixture.mjs';
const require = createRequire(import.meta.url);
function setup(authorized = true) {
  const f = fixture({ inventoryMode: true });
  const contract = taskContract(f, 'TASK-SUPPLEMENT-001');
  contract.allowedPaths.push('app/src/test/java/ExtraTest.kt');
  if (authorized) contract.verification.supplementalTests = { mode: 'baselinePassingNewFiles', maxRevisions: 1 };
  const cf = join(f.root, `automation/tasks/${contract.id}.json`), config = join(f.root, 'automation/config.json');
  writeFileSync(cf, JSON.stringify(contract)); writeFileSync(join(f.root, contract.planPath), 'Approved regression supplement policy\n');
  const evidence = join(f.root, '.git/automation-runtime/evidence', contract.id); mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'baseline.json'), JSON.stringify({ head: command(f.root, ['rev-parse', 'HEAD']) }));
  const phase = name => require(join(f.root, 'automation/verification/inventory.cjs')).runPhase(name, cf, config, f.root, evidence);
  phase('baseline');
  const original = join(f.root, `app/src/test/java/${contract.id}Test.kt`);
  writeFileSync(original, 'class OriginalApprovedTest\n'); phase('red');
  writeFileSync(join(f.root, `app/src/main/java/${contract.id}.kt`), 'class Implementation\n');
  phase('green'); phase('check');
  return { ...f, phase, original, evidence, extra: join(f.root, 'app/src/test/java/ExtraTest.kt') };
}
test('approved new-file supplement proves original-baseline passing behavior without changing RED', () => {
  const f = setup();
  try {
    const red = readFileSync(join(f.evidence, 'red.json'));
    writeFileSync(f.extra, 'class ExtraRegressionTest\n');
    assert.equal(f.phase('green').summary.total, 3);
    assert.equal(f.phase('check').valid, true);
    assert.deepEqual(readFileSync(join(f.evidence, 'red.json')), red);
    const supplement = JSON.parse(readFileSync(join(f.evidence, 'test-supplement.json')));
    assert.equal(supplement.cases.length, 1);
    assert.equal(supplement.cases[0].result, 'SUCCESS');
    writeFileSync(f.extra, 'class ChangedRegressionTest\n');
    assert.throws(() => f.phase('green'), error => error.code === 'EVIDENCE_CHANGED');
    assert.throws(() => f.phase('check'), error => error.code === 'EVIDENCE_CHANGED');
  } finally { f.cleanup(); }
});
test('missing authorization, original-test edits and tests needing new production cannot become supplements', () => {
  for (const mode of ['no-authorization', 'modified-original', 'needs-new-production']) {
    const f = setup(mode !== 'no-authorization');
    try {
      writeFileSync(f.extra, mode === 'needs-new-production' ? 'requires-implementation\n' : 'class ExtraRegressionTest\n');
      if (mode === 'modified-original') writeFileSync(f.original, 'class WeakenedOriginalTest\n');
      assert.throws(() => f.phase('green'), error => ['EVIDENCE_CHANGED', 'CASE_EXPECTATION_MISMATCH'].includes(error.code));
      assert.equal(existsSync(join(f.evidence, 'test-supplement.json')), false);
      if (mode === 'needs-new-production') assert.throws(() => f.phase('green'), error => error.code === 'PREPARATION_BUDGET');
    } finally { f.cleanup(); }
  }
});
