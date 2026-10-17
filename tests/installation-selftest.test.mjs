import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('installation transaction self-test runs all 46 checks with shipped templates', { timeout: 310_000 }, () => {
  const root = fileURLToPath(new URL('../templates/', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AUTOMATION_')));
  const result = spawnSync('bash', ['scripts/automation/tests/run-tests.sh'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /(?:^|\n)1\.\.46(?:\n|$)/);
  assert.equal((result.stdout.match(/^ok \d+ - /gm) ?? []).length, 46);
});
