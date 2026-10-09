import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { legacyRepositories } from './legacy-toolchain.mjs';
import { discoverGradleProjectConfiguration, runProjectInitialization, runProjectUpgrade,
  installationDoctorChecks, planProjectUninstall, applyProjectUninstall, runDoctor,
  INSTALLATION_MANIFEST_RELATIVE_PATH } from '../dist/index.js';

const require = createRequire(import.meta.url);
const files = root => existsSync(root) ? readdirSync(root, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]) : [];
function write(root, name, text, mode) {
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, mode === undefined ? undefined : { mode });
}

test('legacy Android installs, upgrades, diagnoses the build JVM and seals real baseline-passing review supplements', () => {
  const gradle = process.env.ORCHESTRATOR_TEST_GRADLE;
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk');
  assert(gradle && existsSync(gradle) && existsSync(sdk), 'Configure Gradle 6.7.1 and Android SDK');
  const root = mkdtempSync(join(process.env.ORCHESTRATOR_INVENTORY_ARTIFACTS ?? tmpdir(), 'legacy-lifecycle-'));
  console.log('Legacy lifecycle artifacts: ' + root);
  const cachedJar = (group, artifact) => files(join(homedir(), '.gradle/caches/modules-2/files-2.1', group, artifact))
    .find(file => file.endsWith('.jar') && !/-sources|-javadoc/.test(file));
  const junit = cachedJar('junit', 'junit'), hamcrest = cachedJar('org.hamcrest', 'hamcrest-core');
  assert(junit && hamcrest);
  write(root, '.gitignore', '.gradle/\n**/build/\nlocal.properties\n');
  write(root, 'settings.gradle', "rootProject.name='legacy-lifecycle'\ninclude ':library'\n");
  write(root, 'build.gradle', `buildscript {
    repositories { ${legacyRepositories} }
    dependencies { classpath 'com.android.tools.build:gradle:4.2.2'; classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.4.32' }
  }
  allprojects { repositories { ${legacyRepositories} } }
  `);
  write(root, 'gradle.properties', 'org.gradle.workers.max=2\norg.gradle.jvmargs=-Xmx1536m\n');
  write(root, 'local.properties', `sdk.dir=${sdk}\n`);
  write(root, 'gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=local-verified-fixture\n');
  write(root, 'gradlew', `#!/usr/bin/env node
const r=require('node:child_process').spawnSync(${JSON.stringify(gradle)},['--offline',...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);
`, 0o755);
  write(root, 'library/build.gradle', `apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'
android { compileSdkVersion 30; buildToolsVersion '30.0.3'; defaultConfig { minSdkVersion 23 }
  sourceSets { main { kotlin.setSrcDirs(['code/kotlin']) }; test { kotlin.setSrcDirs(['checks/kotlin']) } }
}
dependencies { testImplementation files(${JSON.stringify(junit)}, ${JSON.stringify(hamcrest)}) }
`);
  write(root, 'library/src/main/AndroidManifest.xml', '<manifest package="example.lifecycle" />\n');
  const feature = answer => `package example\nclass Feature { fun answer(): Int = ${answer} }\n`;
  write(root, 'library/code/kotlin/example/Feature.kt', feature(42));
  write(root, 'library/checks/kotlin/example/ExistingTest.kt', 'package example\nclass ExistingTest { @org.junit.Test fun stable() { org.junit.Assert.assertEquals(7, 3 + 4) } }\n');
  const run = (exe, args, options = {}) => {
    const result = spawnSync(exe, args, { cwd: options.cwd ?? root, env: process.env, encoding: 'utf8',
      timeout: options.timeoutMs ?? 240000, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
  };
  const git = (...args) => { const result = run('git', args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Legacy Test'); git('config', 'user.email', 'legacy@example.invalid');
  git('add', '.'); git('commit', '-qm', 'Legacy Android fixture');
  const runner = (exe, args, options) => {
    if (exe === 'opencode') return { status: 0, stdout: '1.14.22\n', stderr: '', error: null };
    if (exe.endsWith('scripts/automation/tests/run-tests.sh')) return { status: 0, stdout: '1..46\n', stderr: '', error: null };
    if (exe.endsWith('scripts/automation/shadow-run.sh')) return { status: 0, stdout: '{"mutationPerformed":false}\n', stderr: '', error: null };
    return run(exe, args, options);
  };
  const discovery = discoverGradleProjectConfiguration(root, run, { timeoutMs: 240000 });
  const installed = runProjectInitialization(root, { projectDetection: discovery.detection,
    gradleVerification: discovery.gradleVerification, androidSdkDirectory: sdk, processRunner: runner });
  assert.equal(installed.managedFileCount, 53);
  const configFile = join(root, 'automation/config.json');
  const config = JSON.parse(readFileSync(configFile));
  assert(config.androidProject.productionPaths.includes('library/code/kotlin/**'));
  assert(config.androidProject.testPaths.includes('library/checks/kotlin/**'));
  const doctor = runDoctor({ targetDirectory: root, checkDependencies: true, runCommand: runner, androidSdkDirectory: sdk });
  write(root, '.git/doctor.json', JSON.stringify(doctor, null, 2));
  assert(doctor.ok, JSON.stringify(doctor));
  assert.match(doctor.checks.find(check => check.id === 'gradle-runtime').summary, /Gradle 6\.7\.1/);
  const manifest = JSON.parse(readFileSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH)));
  manifest.package.version = '1.0.5';
  write(root, INSTALLATION_MANIFEST_RELATIVE_PATH, JSON.stringify(manifest, null, 2) + '\n');
  runProjectUpgrade(root, { refreshGradleDiscovery: true, processRunner: runner });
  assert(installationDoctorChecks(root).every(check => check.status !== 'fail'));
  const shell = run('bash', ['-euc', 'source scripts/automation/lib.sh; automation_validate_config']);
  assert.equal(shell.status, 0, shell.stderr);
  git('add', '.'); git('commit', '-qm', 'Installed legacy fixture');
  const contract = JSON.parse(readFileSync(join(root, 'automation/tasks/TASK-TEMPLATE.json.example')));
  Object.assign(contract, { id: 'TASK-LEGACY-SUPPLEMENT', title: 'Return approved answer and retain stable behavior',
    planPath: 'docs/plans/TASK-LEGACY-SUPPLEMENT.md', acceptanceCriteria: ['Return 43 and preserve existing behavior'],
    nonGoals: ['No configuration changes'], targetTests: [{ gradleTask: ':library:testDebugUnitTest', filter: 'example.*' }] });
  contract.verification.cases = [{ id: 'ANSWER', criterion: 1, intent: 'change', before: 'fail', after: 'pass', source: 'userRequirement',
    test: { target: 0, className: 'example.AddedTest', name: 'approved' },
    expectedFailure: { type: 'java.lang.AssertionError', messageIncludes: 'approved answer', origin: { className: 'example.AddedTest', methodName: 'approved' } } }];
  contract.verification.supplementalTests = { mode: 'baselinePassingNewFiles', maxRevisions: 1 };
  const contractFile = join(root, `automation/tasks/${contract.id}.json`);
  writeFileSync(contractFile, JSON.stringify(contract)); write(root, contract.planPath, 'Approved answer and baseline-passing review supplements\n');
  const evidence = join(root, '.git/automation-runtime/evidence', contract.id);
  write(evidence, 'baseline.json', JSON.stringify({ head: git('rev-parse', 'HEAD') }));
  const phase = name => require(join(root, 'automation/verification/inventory.cjs')).runPhase(name, contractFile, configFile, root, evidence);
  assert.equal(phase('baseline').summary.existing, 1);
  write(root, 'library/checks/kotlin/example/AddedTest.kt', 'package example\nclass AddedTest { @org.junit.Test fun approved() { org.junit.Assert.assertEquals("approved answer", 43, Feature().answer()) } }\n');
  assert.equal(phase('red').summary.expectedRed, 1);
  const red = readFileSync(join(evidence, 'red.json'));
  write(root, 'library/code/kotlin/example/Feature.kt', feature(43));
  assert.equal(phase('green').summary.total, 2);
  write(root, 'library/checks/kotlin/example/ReviewTest.kt', 'package example\nclass ReviewTest { @org.junit.Test fun stableBoundary() { org.junit.Assert.assertEquals(0, 0 + 0) } }\n');
  assert.equal(phase('green').summary.total, 3);
  assert.equal(phase('check').valid, true);
  assert.deepEqual(readFileSync(join(evidence, 'red.json')), red);
  const supplement = JSON.parse(readFileSync(join(evidence, 'test-supplement.json')));
  assert.equal(supplement.cases[0].className, 'example.ReviewTest');
  write(root, '.git/lifecycle-summary.json', JSON.stringify({ installed: true, doctor: true,
    upgrade: 'simulated earlier manifest with current model', realGradle: '6.7.1', baseline: 1, green: 3,
    supplementalCases: supplement.cases.length, modelCalls: false, simulatedInstallationSmoke: true }, null, 2));
  applyProjectUninstall(planProjectUninstall(root));
  assert.equal(existsSync(join(root, 'automation/config.json')), false);
});
