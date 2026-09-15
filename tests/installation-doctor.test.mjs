import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMMIT_MESSAGE_PREFIX_RELATIVE_PATH,
  EXPECTED_MANAGED_FILE_COUNT,
  INSTALLATION_MANIFEST_RELATIVE_PATH,
  formatDoctorReport,
  readInstallationManifest,
  runDoctor,
  runProjectInitialization,
  verifyInstallationIntegrity,
} from "../dist/index.js";

function writeFixtureFile(root, relativePath, content, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
  return path;
}

function commandResult(status, stdout = "", stderr = "", error = null) {
  return { status, stdout, stderr, error };
}

function successfulCommandRunner(executable, args) {
  if (executable === "opencode" && args[0] === "--version") {
    return commandResult(0, "1.15.13\n");
  }
  if (executable.endsWith("scripts/automation/tests/run-tests.sh")) {
    return commandResult(0, "ok 46 - fixture\n1..46\n");
  }
  if (executable.endsWith("scripts/automation/shadow-run.sh")) {
    return commandResult(0, '{"mutationPerformed":false}\n');
  }
  if (args.length === 1 && ["--version", "-version"].includes(args[0])) {
    return commandResult(0, `${executable} fixture version\n`);
  }
  if (executable.endsWith("gradlew") && args[0] === "help") {
    return commandResult(
      0,
      [
        "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:assembleDebug",
        "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:connectedDebugAndroidTest",
        "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:lint",
        "OPENCODE_ANDROID_ORCHESTRATOR_TASK=:mobile:testDebugUnitTest",
        "",
      ].join("\n"),
    );
  }
  return commandResult(1, "", `unexpected command: ${executable}`);
}

function createInstalledFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-installed-doctor-"));
  mkdirSync(join(root, ".git"));
  writeFixtureFile(
    root,
    "settings.gradle.kts",
    'rootProject.name = "Doctor Fixture"\ninclude(":mobile")\nproject(":mobile").projectDir = file("clients/mobile")\n',
  );
  writeFixtureFile(
    root,
    "clients/mobile/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid {\n    namespace = "dev.doctor.fixture"\n    defaultConfig { applicationId = "dev.doctor.fixture" }\n}\n',
  );
  writeFixtureFile(root, "gradlew", "#!/bin/sh\n", 0o755);
  writeFixtureFile(
    root,
    "gradle/wrapper/gradle-wrapper.properties",
    "distributionUrl=fixture\n",
  );
  writeFixtureFile(root, "AGENTS.md", "# Existing project rules\n", 0o644);
  writeFixtureFile(
    root,
    "opencode.jsonc",
    '{\n  // keep user configuration\n  "theme": "system",\n}\n',
    0o600,
  );

  const sdk = join(root, "fixture-sdk");
  mkdirSync(join(sdk, "platforms"), { recursive: true });
  mkdirSync(join(sdk, "build-tools"), { recursive: true });
  writeFixtureFile(root, "local.properties", `sdk.dir=${sdk}\n`, 0o600);
  runProjectInitialization(root, {
    androidSdkDirectory: sdk,
    installationId: "installed-doctor-001",
    preparedAt: "2026-08-24T10:00:00.000Z",
    installedAt: "2026-08-24T10:05:00.000Z",
    processRunner: successfulCommandRunner,
  });
  writeFileSync(
    join(root, COMMIT_MESSAGE_PREFIX_RELATIVE_PATH),
    "医生测试批次\n",
  );
  return { root, sdk };
}

function installedDoctor(root, overrides = {}) {
  return runDoctor({
    checkDependencies: true,
    checkInstallation: true,
    environment: {},
    runCommand: successfulCommandRunner,
    targetDirectory: join(root, "clients/mobile"),
    ...overrides,
  });
}

function check(report, id) {
  const result = report.checks.find((candidate) => candidate.id === id);
  assert.ok(result, `missing doctor check: ${id}`);
  return result;
}

test("installed doctor validates dependencies, inventory, files, modes, backups, and configuration", () => {
  const { root } = createInstalledFixture();
  try {
    const report = installedDoctor(root);

    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 16);
    assert.equal(report.checks.every((candidate) => candidate.status === "pass"), true);
    assert.match(
      check(report, "installation-manifest").summary,
      new RegExp(`tracks ${EXPECTED_MANAGED_FILE_COUNT} installed files`),
    );
    assert.match(check(report, "managed-permissions").summary, /29 automation scripts/);
    assert.match(check(report, "managed-configuration").summary, /consistent/);
    assert.equal(check(report, "commit-message-prefix").status, "pass");
    assert.match(formatDoctorReport(report), /Result: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor warns without failing while the required prefix is unconfigured", () => {
  const { root } = createInstalledFixture();
  try {
    writeFileSync(
      join(root, COMMIT_MESSAGE_PREFIX_RELATIVE_PATH),
      "# 请填写当前提交前缀\n",
    );

    const report = installedDoctor(root);

    assert.equal(report.ok, true);
    assert.equal(check(report, "commit-message-prefix").status, "warn");
    assert.match(
      check(report, "commit-message-prefix").summary,
      /tasks are blocked/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor accepts repository verification-policy changes", () => {
  const { root } = createInstalledFixture();
  try {
    const path = join(root, "automation/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.unitTestsEnabled = false;
    config.lintEnabled = true;
    config.commitMessagePrefixMode = "disabled";
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

    assert.equal(verifyInstallationIntegrity(root).ok, true);
    const report = installedDoctor(root);

    assert.equal(report.ok, true);
    assert.equal(check(report, "managed-resources").status, "pass");
    assert.equal(check(report, "managed-configuration").status, "pass");
    assert.match(
      check(report, "managed-configuration").details.join("\n"),
      /Unit-test verification: disabled[\s\S]*Android lint verification: enabled/,
    );
    assert.match(
      check(report, "managed-configuration").details.join("\n"),
      /Commit-message prefix mode: disabled/,
    );
    assert.equal(check(report, "commit-message-prefix").status, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed integrity rejects non-boolean verification-policy changes", () => {
  const { root } = createInstalledFixture();
  try {
    const path = join(root, "automation/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.lintEnabled = "true";
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

    assert.equal(verifyInstallationIntegrity(root).ok, false);
    const report = installedDoctor(root);
    assert.equal(check(report, "managed-resources").status, "fail");
    assert.equal(check(report, "managed-configuration").status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor reports content and executable-mode drift separately", () => {
  const { root } = createInstalledFixture();
  try {
    writeFileSync(
      join(root, ".opencode/agents/scheduled-coder.md"),
      "locally modified agent\n",
    );
    chmodSync(join(root, "scripts/automation/preflight.sh"), 0o644);

    const report = installedDoctor(root);

    assert.equal(report.ok, false);
    assert.equal(check(report, "installation-manifest").status, "pass");
    assert.equal(check(report, "managed-resources").status, "fail");
    assert.match(
      check(report, "managed-resources").details.join("\n"),
      /scheduled-coder\.md/,
    );
    assert.equal(check(report, "managed-permissions").status, "fail");
    assert.match(
      check(report, "managed-permissions").details.join("\n"),
      /preflight\.sh: mode 0644; expected 0755/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor detects unsafe adaptive configuration even when it is valid JSON", () => {
  const { root } = createInstalledFixture();
  try {
    const path = join(root, "automation/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.pushAfterAcceptance = true;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

    const report = installedDoctor(root);

    assert.equal(check(report, "managed-resources").status, "fail");
    assert.equal(check(report, "managed-configuration").status, "fail");
    assert.match(
      check(report, "managed-configuration").details.join("\n"),
      /safe defaults/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor verifies original-file backups independently", () => {
  const { root } = createInstalledFixture();
  try {
    const manifest = readInstallationManifest(root);
    const agents = manifest.files.find((file) => file.path === "AGENTS.md");
    assert.ok(agents?.previous.backupPath);
    unlinkSync(join(root, ...agents.previous.backupPath.split("/")));

    const report = installedDoctor(root);

    assert.equal(check(report, "managed-resources").status, "pass");
    assert.equal(check(report, "managed-permissions").status, "pass");
    assert.equal(check(report, "installation-backups").status, "fail");
    assert.match(
      check(report, "installation-backups").details.join("\n"),
      /AGENTS\.md: backup is missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor fails closed for a missing manifest", () => {
  const { root } = createInstalledFixture();
  try {
    unlinkSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH));

    const report = installedDoctor(root);

    assert.equal(report.ok, false);
    assert.equal(check(report, "installation-manifest").status, "fail");
    for (const id of [
      "managed-resources",
      "managed-permissions",
      "installation-backups",
      "managed-configuration",
    ]) {
      assert.equal(check(report, id).status, "fail");
      assert.match(check(report, id).details.join("\n"), /does not exist/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor rejects a self-consistent manifest rewrite of a packaged resource", () => {
  const { root } = createInstalledFixture();
  try {
    const managedPath = ".opencode/agents/scheduled-coder.md";
    const changed = Buffer.from("rewritten managed resource\n");
    writeFileSync(join(root, managedPath), changed);
    const manifestPath = join(root, INSTALLATION_MANIFEST_RELATIVE_PATH);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.files.find((file) => file.path === managedPath);
    assert.ok(entry);
    entry.sha256 = createHash("sha256").update(changed).digest("hex");
    entry.size = changed.byteLength;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = installedDoctor(root);

    assert.equal(check(report, "installation-manifest").status, "fail");
    assert.match(
      check(report, "installation-manifest").details.join("\n"),
      /does not match the packaged 1\.0\.1 template/,
    );
    assert.equal(
      check(report, "managed-resources").status,
      "pass",
      "resource hashes alone cannot authenticate a rewritten manifest",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor reports missing commands and an unavailable SDK", () => {
  const { root } = createInstalledFixture();
  try {
    const report = installedDoctor(root, {
      androidSdkDirectory: join(root, "missing-sdk"),
      runCommand: (executable, args) =>
        executable === "java"
          ? commandResult(null, "", "", "spawn java ENOENT")
          : successfulCommandRunner(executable, args),
    });

    assert.equal(report.ok, false);
    assert.equal(check(report, "java-command").status, "fail");
    assert.match(check(report, "java-command").details.join("\n"), /ENOENT/);
    assert.equal(check(report, "android-sdk").status, "fail");
    assert.match(check(report, "android-sdk").summary, /unavailable or unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor CLI enables installation checks in JSON mode and exits unsuccessfully", () => {
  const { root, sdk } = createInstalledFixture();
  try {
    unlinkSync(join(root, INSTALLATION_MANIFEST_RELATIVE_PATH));
    const fakeBin = join(root, "fake-bin");
    for (const executable of ["opencode", "git", "jq", "rg", "shasum", "java"]) {
      writeFixtureFile(
        root,
        `fake-bin/${executable}`,
        "#!/bin/sh\necho 1.15.13\n",
        0o755,
      );
    }
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cli, "doctor", join(root, "clients/mobile"), "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ANDROID_HOME: sdk,
          PATH: fakeBin,
        },
      },
    );

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(check(report, "git-command").status, "pass");
    assert.equal(check(report, "installation-manifest").status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed doctor accepts bounded queue policy changes and rejects unsupported combinations", () => {
  const { root } = createInstalledFixture();
  try {
    const path = join(root, 'automation/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.workspaceStrategy = 'isolatedWorktree';
    config.queue = { scanIntervalMs: 1000, maxWorkspaces: 2, maxWorkspaceBytes: 1024 ** 3 };
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    const valid = runDoctor({ targetDirectory: root, checkInstallation: true, checkDependencies: false });
    assert.equal(valid.checks.find(check => check.id === 'managed-configuration').status, 'pass', JSON.stringify(valid));
    assert.equal(valid.checks.find(check => check.id === 'managed-resources').status, 'pass', JSON.stringify(valid));
    config.commitPolicy = 'autoCommit';
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    const invalid = runDoctor({ targetDirectory: root, checkInstallation: true, checkDependencies: false });
    assert.equal(invalid.checks.find(check => check.id === 'managed-configuration').status, 'fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed Planner tools consume real question-hook receipts and reject approval prose", { timeout: 30000 }, async () => {
  const { root } = createInstalledFixture();
  const { TaskQueue } = await import('../dist/queue/queue.js');
  const { serviceStatus, stopService } = await import('../dist/queue/service.js');
  const { default: plugin } = await import('../dist/index.js');
  let queue;
  try {
    const git = args => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']);
    writeFileSync(join(root, '.gitignore'), '.automation-plugin/\n');
    git(['add', '.']); git(['commit', '-qm', 'Installed fixture']);
    queue = new TaskQueue(root); queue.control('pause');
    const hooks = await plugin({ directory: root, worktree: root, $: () => { throw new Error('No arbitrary shell expected'); } });
    const context = { sessionID: 'real-hook-session', messageID: 'tool-call-message', agent: 'scheduled-planner', directory: root, worktree: root, abort: new AbortController().signal };
    const snapshotTool = hooks.tool.android_orchestrator_snapshot;
    const compactSnapshot = JSON.parse(await snapshotTool.execute({ action: 'snapshot' }, context));
    assert.deepEqual(Object.keys(compactSnapshot).sort(), ['planningHead', 'sourceRoot', 'targetBranch']);
    assert.ok(Buffer.byteLength(JSON.stringify(compactSnapshot), 'utf8') < 1024);
    const pathPage = JSON.parse(await snapshotTool.execute({ action: 'list', planningHead: compactSnapshot.planningHead, query: 'TASK-TEMPLATE', limit: 10 }, context));
    assert.deepEqual(pathPage.files, ['automation/tasks/TASK-TEMPLATE.json.example']);
    const fileChunk = JSON.parse(await snapshotTool.execute({ action: 'readChunk', planningHead: compactSnapshot.planningHead, path: pathPage.files[0] }, context));
    assert.match(fileChunk.content, /schemaVersion/);
    const intake = hooks.tool.android_orchestrator_intake;
    const contract = JSON.parse(readFileSync(join(root, 'automation/tasks/TASK-TEMPLATE.json.example'), 'utf8'));
    Object.assign(contract, { id: 'TASK-RECEIPT-001', title: 'Add a bounded regression behavior', planPath: 'docs/plans/TASK-RECEIPT-001.md', acceptanceCriteria: ['The approved behavior passes its regression test'], targetTests: [{ gradleTask: queue.config().gradleVerification.focusedTestTasks[0], filter: 'dev.doctor.RegressionTest' }] });
    const draftJson = JSON.stringify({ contract, plan: '# Approved plan\n\nAdd the bounded behavior and its regression test.\n', ...queue.snapshot() });
    await assert.rejects(intake.execute({ action: 'draft', draftJson }, context), /fresh, matching/);
    const answer = async (question, selection, callID) => {
      const input = { tool: 'question', sessionID: context.sessionID, callID, args: question };
      await hooks['tool.execute.before'](input, { args: question });
      await hooks['tool.execute.after'](input, { title: 'Question answered', output: '', metadata: { answers: [[selection]] } });
    };
    await answer({ questions: [{ header: '方案确认', question: 'Approve the displayed bounded proposal?', options: [{ label: '批准方案，生成计划和任务合同。' }, { label: '调整方案。' }] }] }, '批准方案，生成计划和任务合同。', 'proposal-call');
    const draft = JSON.parse(await intake.execute({ action: 'draft', draftJson }, context));
    const enqueueArgs = { action: 'enqueue', key: draft.key, digest: draft.digest, approval: draft.approvalText };
    await assert.rejects(intake.execute(enqueueArgs, context), /fresh, matching/);
    assert.equal(queue.storage.read().items.length, 0);
    await answer(draft.question, draft.approvalText, 'contract-call');
    const result = JSON.parse(await intake.execute(enqueueArgs, context));
    assert.equal(result.state, 'QUEUED');
    assert.equal(queue.item(draft.key).authorization.proof.questionCallID, 'contract-call');
    assert.equal(queue.item(draft.key).proposalApproval.questionCallID, 'proposal-call');
    await intake.execute(enqueueArgs, context);
    assert.equal(queue.storage.read().items.length, 1);
    assert.equal(git(['status', '--porcelain']), '');
  } finally {
    if (queue && queue.storage.read().items.length > 0) {
      // Enqueue starts a detached scheduler even while consumption is paused.
      const deadline = Date.now() + 10000;
      while (!serviceStatus(queue).running && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
      stopService(queue);
      while (serviceStatus(queue).running && Date.now() < deadline + 5000) await new Promise(done => setTimeout(done, 100));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
