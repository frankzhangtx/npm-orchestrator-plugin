import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {TaskQueue} from './source/dist/queue/queue.js';
import {fileLock,git,sha256} from './source/dist/queue/storage.js';
import {serviceStatus} from './source/dist/queue/service.js';
import {assertQueueIdle} from './source/dist/queue/lifecycle.js';
import {restoreInstallation,verifyInstallationRestorePoint} from './source/dist/installer/restore.js';
import {verifyDirectoryIdentity} from './source/dist/installer/directory-identity.js';
import {recordRestoration} from './source/dist/trial/restoration.js';

const batch=dirname(fileURLToPath(import.meta.url)), evidence=join(batch,'trial-rc3');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const spec=read(join(evidence,'specification.json')), queue=new TaskQueue(spec.repository);
// Cleanup stays within this trial's existing, separately bounded cleanup window.
const operatorCleanupDeadline=Date.parse(spec.runScope.cleanupExpiresAt);
const release=fileLock(join(queue.storage.runtime,'locks/trial-driver.lock'));
try {
  const ledger=read(join(evidence,'trial.json'));
  assert.equal(ledger.phase,'RESTORATION_BLOCKED');
  assert.equal(ledger.specificationSha256,sha256(JSON.stringify(spec)));
  assert.ok(Date.now()<operatorCleanupDeadline,'Operator cleanup window expired');
  assertQueueIdle(spec.repository);
  assert.equal(serviceStatus(queue).running,false);
  assert.equal(queue.storage.read().paused,true);
  assert.equal(queue.storage.read().fault,null);
  assert.equal(git(spec.repository,['branch','--show-current']),spec.originalBranch);
  assert.equal(git(spec.repository,['rev-parse','HEAD']),spec.originalHead);
  assert.equal(git(spec.repository,['status','--porcelain']),'');
  assert.equal(git(spec.repository,['worktree','list','--porcelain']),read(join(evidence,'original-worktrees.json')));
  const historical=queue.storage.read().items.filter(i=>!spec.runScope.taskKeys.includes(i.key));
  assert.deepEqual(historical,read(join(evidence,'historical-items.json')));
  const doctor=spawnSync(process.execPath,[join(spec.originalPackageRoot,'dist/cli.js'),'doctor',spec.repository,'--json'],{cwd:spec.repository,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
  assert.equal(doctor.status,0,doctor.stderr);assert.equal(JSON.parse(doctor.stdout).ok,true);
  writeFileSync(join(evidence,'operator-restored-doctor.json'),doctor.stdout);
  const host=spawnSync('opencode',['debug','config'],{cwd:spec.repository,encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});
  assert.equal(host.status,0,host.stderr);
  const config=JSON.parse(host.stdout);
  assert.ok(config.plugin.includes('@frankzhang2026/opencode-android-orchestrator@1.3.6'));
  assert.ok(config.skills.paths.includes(join(spec.originalPackageRoot,'resources/third-party/superpowers-v6.2.0/skills/')));
  // The new, tested restoration helper permits only exact sealed additions.
  // Preserve the failed trial ledger; this is operator cleanup, not trial success.
  restoreInstallation(join(evidence,'installation-restore'),{replaySealedHostAdditions:true});
  verifyInstallationRestorePoint(join(evidence,'installation-restore'));
  verifyDirectoryIdentity(spec.originalInstallationRoot,read(join(evidence,'original-package-identity.json')));
  assertQueueIdle(spec.repository);
  assert.equal(serviceStatus(queue).running,false);
  const owner=read(join(queue.storage.runtime,'trial-restoration.json'));
  assert.equal(owner.specificationSha256,ledger.specificationSha256);
  writeFileSync(join(evidence,'operator-restoration-result.json'),JSON.stringify({
    at:new Date().toISOString(),restoration:'VERIFIED',businessResult:ledger.result,
    trialErrorRetained:ledger.error,originalHostLoaded:true,installationSnapshotMatches:true,
    method:'Explicit bounded cleanup of exact sealed host additions after successful original doctor and host probe',
    originalCleanupDeadline:ledger.cleanupDeadline,operatorCleanupDeadline,
    authorization:'Authorized trial cleanup only; original execution and cleanup deadlines remain unchanged',
  },null,2)+'\n');
  recordRestoration(queue.storage.runtime,{...owner,state:'VERIFIED'});
  console.log('Operator restoration verified; original failed/interrupted trial ledger retained.');
} finally { release(); }
