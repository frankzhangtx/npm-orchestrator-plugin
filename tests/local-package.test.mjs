import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installLocalPackage } from '../dist/installer/local-package.js';

test('local tgz installs offline once, retains artifact and rejects installed-content drift', { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-local-install-'));
  try {
    const pkg = join(root, 'fixture');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@frankzhang2026/opencode-android-orchestrator', version: '0.0.0-test.1', type: 'module', main: './dist/opencode-plugin.js', files: ['dist/'] }));
    writeFileSync(join(pkg, 'dist/opencode-plugin.js'), 'export default async () => ({});\n');
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: pkg, encoding: 'utf8', timeout: 30000 });
    assert.equal(pack.status, 0, pack.stderr);
    const artifact = join(pkg, JSON.parse(pack.stdout)[0].filename);
    const base = join(root, 'installed');
    const first = installLocalPackage(artifact, base, true);
    assert.equal(first.version, '0.0.0-test.1');
    assert.deepEqual(installLocalPackage(artifact, base, true), first);
    assert.equal(JSON.parse(readFileSync(first.packageRoot + '.source.json')).sha256, first.sha256);
    assert.deepEqual(readFileSync(first.artifact), readFileSync(artifact));
    const lock=join(first.installation.root,'package-lock.json'), original=readFileSync(lock);
    writeFileSync(lock,original.toString()+' ');
    assert.throws(()=>installLocalPackage(artifact,base,true),/dependency.*lock/);
    writeFileSync(lock,original);
    const dependency=join(first.installation.root,'node_modules','unexpected');
    mkdirSync(dependency);writeFileSync(join(dependency,'index.js'),'unexpected dependency');
    assert.throws(()=>installLocalPackage(artifact,base,true),/dependency/);
    rmSync(dependency,{recursive:true});
    writeFileSync(join(first.packageRoot, 'dist/opencode-plugin.js'), 'export default async () => ({changed:true});\n');
    assert.throws(() => installLocalPackage(artifact, base, true), /content/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
