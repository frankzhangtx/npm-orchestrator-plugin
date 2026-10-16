import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { describeLocalPackage, verifyPackageSource, validPackageVersion } from '../dist/installer/package-source.js';

test('local identity binds artifact digests, prerelease version, entry, content and modes', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-source-'));
  try {
    const pkg = join(root, 'package'), tgz = join(root, 'candidate.tgz');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@scope/plugin', version: '1.3.4-rc.1+test' }));
    writeFileSync(join(pkg, 'dist/opencode-plugin.js'), 'export default () => ({});');
    writeFileSync(tgz, 'fixture artifact');
    const source = describeLocalPackage(tgz, pkg);
    verifyPackageSource(source);
    assert.equal(source.version, '1.3.4-rc.1+test');
    assert.equal(source.sha256.length, 64);
    assert.equal(source.sha512.length, 128);
    chmodSync(join(pkg, 'dist/opencode-plugin.js'), 0o700);
    assert.throws(() => verifyPackageSource(source), /permissions/);
    chmodSync(join(pkg, 'dist/opencode-plugin.js'), source.files['dist/opencode-plugin.js'].mode);
    writeFileSync(join(pkg, 'dist/extra.js'), 'unexpected');
    assert.throws(() => verifyPackageSource(source), /content/);
    rmSync(join(pkg, 'dist/extra.js'));
    writeFileSync(tgz, 'different artifact');
    assert.throws(() => verifyPackageSource(source), /identity/);
    assert.throws(() => verifyPackageSource({ ...source, entry: 'file:///other.js' }), /entry/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source versions retain complete SemVer and reject invalid numeric identifiers', () => {
  for (const v of ['1.3.3', '1.3.4-rc.1', '1.3.4+build.01', '1.3.4-1a']) assert.equal(validPackageVersion(v), true, v);
  for (const v of ['1.3', '01.3.4', '1.3.4-01', '1.3.4-', '1.3.4\n']) assert.equal(validPackageVersion(v), false, v);
});
