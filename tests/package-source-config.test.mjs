import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { describeLocalPackage, assertConfiguredPackageSource } from '../dist/installer/package-source.js';

test('effective configuration rejects duplicate registry and local plugin sources', () => {
  const root=mkdtempSync(join(tmpdir(),'orchestrator-source-config-'));
  try {
    mkdirSync(join(root,'dist'));
    writeFileSync(join(root,'package.json'), JSON.stringify({name:'@frankzhang2026/opencode-android-orchestrator',version:'1.3.4-rc.1'}));
    writeFileSync(join(root,'dist/opencode-plugin.js'),'export default async()=>({});');
    const artifact=join(root,'artifact.tgz');writeFileSync(artifact,'fixture');
    const source=describeLocalPackage(artifact,root);
    assertConfiguredPackageSource(source,[source.entry]);
    assert.throws(()=>assertConfiguredPackageSource(source,[]),/exactly once/);
    assert.throws(()=>assertConfiguredPackageSource(source,[source.entry,source.entry]),/exactly once/);
    assert.throws(()=>assertConfiguredPackageSource(source,[source.entry,source.name+'@1.3.3']),/cannot load together/);
    const alias=join(root,'alias');mkdirSync(join(alias,'dist'),{recursive:true});
    writeFileSync(join(alias,'package.json'),JSON.stringify({name:source.name,version:'1.3.3'}));
    writeFileSync(join(alias,'dist','plugin.js'),'export default async()=>({});');
    assert.throws(()=>assertConfiguredPackageSource(source,[source.entry,pathToFileURL(join(alias,'dist','plugin.js')).href]),/cannot load together/);
    assert.throws(()=>assertConfiguredPackageSource(source,[source.entry,'file:///missing/plugin.js']),/Cannot verify/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
