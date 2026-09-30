import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));
const automationRoot = join(templatesRoot, "scripts", "automation");

const expectedHashes = new Map([
  [
    "scripts/automation/abort-task.sh",
    "6c4ba86055d79887ad70fb7ca5d45ea7eaed57ac2527a30ea09541a9fe761ece",
  ],
  [
    "scripts/automation/accept-and-integrate.sh",
    "83d5a9af844ce3a9316a9f8d8bd3ef8f1fe7fa597545ac5a6aa581ec1bacc669",
  ],
  [
    "scripts/automation/acceptance-report.sh",
    "be3227d9789e594c34d8b74670b2cf82c5c7672542a3031134c937edd09ae05b",
  ],
  [
    "scripts/automation/approve-and-run.sh",
    "15443e2de6d0c7ead0c32932807534f329a56a4a58936c2649cd0998c1d916bb",
  ],
  [
    "scripts/automation/begin-review.sh",
    "ff5e276940621086399f537ce061a8de8ae05d213fe90ed8eaadb0045f86419a",
  ],
  [
    "scripts/automation/block-task.sh",
    "715814e3bdbeaae54fdd07489f01212f9a8d406943af1df8e795e57eef19c3a8",
  ],
  [
    "scripts/automation/claim-task.sh",
    "baa051bc581e79b49919b808eca341e2bf3e137c14b29f2813caccec51f54bbc",
  ],
  [
    "scripts/automation/integration-scope-gate.sh",
    "e7d29d4465ff62b5a755f276322a5c42bf9c6698318ee7dcbeff2dc99054f398",
  ],
  [
    "scripts/automation/lib.sh",
    "b7c443102d17e8c974cb8e99aadca178cecc5e1a344b439e53d56c2e188ca05a",
  ],
  [
    "scripts/automation/orchestrate-task.sh",
    "e567886880b684db8389bb0d781407f79cd7d4ffa54b9d624d9fd4586d5124a4",
  ],
  [
    "scripts/automation/preflight.sh",
    "ecdac14b3cca8621f047a3676f3d9f4073c1585690a15a60e4737bd119da2caf",
  ],
  [
    "scripts/automation/prepare-contract-review.sh",
    "57036ecd3ca8ee205a8d5b81e2569d84b9567276ba7cb9571b89db54b8b55d74",
  ],
  [
    "scripts/automation/quality-gate.sh",
    "a708289a1fb6b1263bcdbb0d6b583f0a060e4de81f43a69c2348104d5896415e",
  ],
  [
    "scripts/automation/queue-task.sh",
    "25ddd03d9a02291c945cade4c425d25647a9474a0a91b0de3c651c808e71c341",
  ],
  [
    "scripts/automation/record-red.sh",
    "c440e7dc22604f3202c8848d0b0de097447bd4206d1c747d8b622c0b80040f77",
  ],
  [
    "scripts/automation/resume-review-fix.sh",
    "185c328f950c0c285d6a96968d82989b5991f282b2e102e284cb64981430bdd9",
  ],
  [
    "scripts/automation/resume-review.sh",
    "fcec8c1afd22af2b967960aeeb792e23a8ddced8e8aaa945b5db5afbe148b96c",
  ],
  [
    "scripts/automation/resume-task.sh",
    "1f1ea091aad111333edfabe57323d0439100f3fb4d19fa41c1af4ee81e8aa26f",
  ],
  [
    "scripts/automation/scope-gate.sh",
    "d9e2a48c9ee7f5b2b70da34ab046a97daa8f832b891084d28688d56c68cfc368",
  ],
  [
    "scripts/automation/select-task.sh",
    "9e6726efe0035734c77c66426b2c778bbf7f069b3e1d73b57b01db43516731c2",
  ],
  [
    "scripts/automation/shadow-run.sh",
    "6810d5d1425d0f7c52e8a8b667539171945fdbbef864609324a557201c6b7d4b",
  ],
  [
    "scripts/automation/show-acceptance-review.sh",
    "217ab977e2d993a6a9356825e9b94a13373864b7d9365552ece6667ea6b46b96",
  ],
  [
    "scripts/automation/status.sh",
    "3251ca09523754bc6870dc86d34db0390f0037d16b6ce8773a1227189de99092",
  ],
  [
    "scripts/automation/submit-review.sh",
    "532d924706ec4f1ea23619114a0709c67980b1405aabf6299639920e6d54b8d7",
  ],
  [
    "scripts/automation/tests/run-tests.sh",
    "fa692f2447ad375845cda5721493013c1c82878b366543ca31c921dccadb4181",
  ],
  [
    "scripts/automation/transition-state.sh",
    "294d5d0e1c217d9efe3bf48d6f4d0eca1abec7a2216b27ec41da479766b5f7b7",
  ],
  [
    "scripts/automation/validate-contract.sh",
    "4726b895672a797bebf7204c5a56a7230e25b645175592b9a7bf41e2d00bea39",
  ],
  [
    "scripts/automation/verify-integration.sh",
    "828563390c3427191b4b5cb7d54b907fb340660467f495bda6f7d8ee5aea2203",
  ],
  [
    "scripts/automation/verify-task.sh",
    "71e558223878b3930892dcd175faf0234d0cb33e251bcc083ee1a132b1c8690e",
  ],
]);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function templatePath(path) {
  return relative(templatesRoot, path).split(sep).join("/");
}

test("ships exactly the 29 audited V3 automation shell files", () => {
  const actualPaths = listFiles(automationRoot).map(templatePath).sort();
  assert.deepEqual(actualPaths, [...expectedHashes.keys()].sort());
});

test("preserves audited shell bytes and executable modes", () => {
  for (const [path, expectedHash] of expectedHashes) {
    const absolutePath = join(templatesRoot, path);
    const contents = readFileSync(absolutePath);
    const actualHash = createHash("sha256").update(contents).digest("hex");

    assert.equal(actualHash, expectedHash, path);
    assert.equal(statSync(absolutePath).mode & 0o777, 0o755, path);
  }
});

test("all migrated automation files are valid Bash scripts", () => {
  for (const path of expectedHashes.keys()) {
    const absolutePath = join(templatesRoot, path);
    const contents = readFileSync(absolutePath, "utf8");
    const syntaxCheck = spawnSync("bash", ["-n", absolutePath], {
      encoding: "utf8",
      shell: false,
    });

    assert.match(contents, /^#!\/usr\/bin\/env bash\n/, path);
    assert.equal(
      syntaxCheck.status,
      0,
      `${path}: ${syntaxCheck.stderr.trim()}`,
    );
    assert.doesNotMatch(contents, /\r\n/, path);
    assert.doesNotMatch(
      contents,
      /\b(?:launchctl|launchd|npm publish|git push)\b/,
      path,
    );
    assert.doesNotMatch(
      contents,
      /\/Users\/|zhanglong|cctest|opencode-scheduler/i,
      path,
    );
  }
});

test("preflight accepts absent legacy Scheduler tools but rejects enabled ones", () => {
  const contents = readFileSync(join(automationRoot, "preflight.sh"), "utf8");
  const commonPermissions = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "android_orchestrator_status", pattern: "*", action: "allow" },
    { permission: "android_orchestrator_doctor", pattern: "*", action: "allow" },
    { permission: "schedule_job", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
  ];
  const commonTools = {
    android_orchestrator_status: true,
    android_orchestrator_doctor: true,
    task: false,
  };
  const cases = [
    {
      file: "planner-agent.json",
      tools: { ...commonTools, question: true },
      permissions: [
        ...commonPermissions,
        { permission: "edit", pattern: "docs/plans/**", action: "allow" },
        { permission: "edit", pattern: "automation/tasks/**", action: "allow" },
        { permission: "edit", pattern: "**/src/**", action: "deny" },
        ...[
          "prepare-contract-review.sh",
          "approve-and-run.sh",
          "resume-task.sh",
          "resume-review.sh",
          "accept-and-integrate.sh",
          "abort-task.sh",
        ].map((script) => ({
          permission: "bash",
          pattern: `./scripts/automation/${script} *`,
          action: "allow",
        })),
      ],
    },
    {
      file: "coder-agent.json",
      tools: commonTools,
      permissions: [
        ...commonPermissions,
        { permission: "edit", pattern: "**/src/main/**", action: "allow" },
        { permission: "edit", pattern: ".opencode/skills/**", action: "deny" },
      ],
    },
    {
      file: "reviewer-agent.json",
      tools: commonTools,
      permissions: [
        ...commonPermissions,
        { permission: "edit", pattern: "*", action: "deny" },
      ],
    },
  ];

  for (const fixture of cases) {
    const marker = `' "$discovery_dir/${fixture.file}"`;
    const filterEnd = contents.indexOf(marker);
    const filterStart = contents.lastIndexOf("    jq -e '", filterEnd);
    assert.notEqual(filterEnd, -1, `missing jq target for ${fixture.file}`);
    assert.notEqual(filterStart, -1, `missing jq filter for ${fixture.file}`);
    const filter = contents.slice(filterStart + "    jq -e '".length, filterEnd);

    const safeResult = spawnSync("jq", ["-e", filter], {
      encoding: "utf8",
      input: JSON.stringify({
        tools: fixture.tools,
        permission: fixture.permissions,
      }),
      shell: false,
    });
    assert.equal(safeResult.status, 0, `${fixture.file}: ${safeResult.stderr}`);

    const unsafeResult = spawnSync("jq", ["-e", filter], {
      encoding: "utf8",
      input: JSON.stringify({
        tools: { ...fixture.tools, schedule_job: true },
        permission: fixture.permissions,
      }),
      shell: false,
    });
    assert.notEqual(unsafeResult.status, 0, fixture.file);
  }
});

test("OpenCode config discovery retries only the transient checkpoint failure", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-opencode-retry-"));
  const script = join(root, "exercise-retry.sh");
  const output = join(root, "config.json");
  const error = join(root, "config.err");
  const count = join(root, "attempts.txt");

  try {
    const gitInit = spawnSync("git", ["init", "-q"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(gitInit.status, 0, gitInit.stderr);
    writeFileSync(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
source "$RETRY_TEST_LIB"
attempts=0
opencode() {
    attempts=$((attempts + 1))
    printf '%s\\n' "$attempts" > "$RETRY_TEST_COUNT"
    if [[ "$RETRY_TEST_MODE" == "transient" && "$attempts" -eq 1 ]]; then
        printf '%s\\n' "Failed to run the query 'PRAGMA wal_checkpoint(PASSIVE)'" >&2
        return 1
    fi
    if [[ "$RETRY_TEST_MODE" == "permanent" ]]; then
        printf '%s\\n' "invalid OpenCode configuration" >&2
        return 1
    fi
    printf '%s\\n' '{"plugin":[]}'
}
automation_resolve_opencode_config "$RETRY_TEST_OUTPUT" "$RETRY_TEST_ERROR"
`,
    );
    chmodSync(script, 0o755);
    const environment = {
      ...process.env,
      AUTOMATION_PROJECT_ROOT: root,
      AUTOMATION_TEST_MODE: "1",
      RETRY_TEST_COUNT: count,
      RETRY_TEST_ERROR: error,
      RETRY_TEST_LIB: join(automationRoot, "lib.sh"),
      RETRY_TEST_OUTPUT: output,
    };

    const transient = spawnSync(script, [], {
      cwd: root,
      encoding: "utf8",
      env: { ...environment, RETRY_TEST_MODE: "transient" },
      shell: false,
    });
    assert.equal(transient.status, 0, transient.stderr);
    assert.equal(readFileSync(count, "utf8").trim(), "2");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { plugin: [] });
    assert.equal(readFileSync(error, "utf8"), "");
    assert.match(transient.stderr, /retrying resolved config discovery/);

    const permanent = spawnSync(script, [], {
      cwd: root,
      encoding: "utf8",
      env: { ...environment, RETRY_TEST_MODE: "permanent" },
      shell: false,
    });
    assert.notEqual(permanent.status, 0);
    assert.equal(readFileSync(count, "utf8").trim(), "1");
    assert.match(readFileSync(error, "utf8"), /invalid OpenCode configuration/);
    assert.doesNotMatch(permanent.stderr, /retrying resolved config discovery/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shadow run reserves stdout for one machine-readable JSON document", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-shadow-output-"));
  const scripts = join(root, "scripts");
  const tasks = join(root, "tasks");
  const state = join(root, "state");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tasks, { recursive: true });
  mkdirSync(state, { recursive: true });

  try {
    copyFileSync(join(automationRoot, "shadow-run.sh"), join(scripts, "shadow-run.sh"));
    writeFileSync(
      join(scripts, "lib.sh"),
      `AUTOMATION_ROOT="$SHADOW_TEST_ROOT"\n` +
        `AUTOMATION_TASKS_DIR="$SHADOW_TEST_ROOT/tasks"\n` +
        `AUTOMATION_STATE_DIR="$SHADOW_TEST_ROOT/state"\n` +
        'automation_info() { printf "[automation] %s\\n" "$*"; }\n' +
        "automation_ensure_runtime_layout() { mkdir -p \"$AUTOMATION_STATE_DIR\"; }\n" +
        'automation_now() { printf "2026-08-25T00:00:00Z\\n"; }\n' +
        'automation_config_value() { case "$1" in .enabled) printf "true\\n" ;; .mode) printf "orchestrated\\n" ;; esac; }\n',
    );
    writeFileSync(
      join(scripts, "preflight.sh"),
      '#!/usr/bin/env bash\nprintf "[automation] preflight completed\\n"\n',
    );
    chmodSync(join(scripts, "shadow-run.sh"), 0o755);
    chmodSync(join(scripts, "preflight.sh"), 0o755);

    const result = spawnSync(join(scripts, "shadow-run.sh"), [], {
      encoding: "utf8",
      env: { ...process.env, SHADOW_TEST_ROOT: root },
      shell: false,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mutationPerformed, false);
    assert.doesNotMatch(result.stdout, /\[automation\]/);
    assert.match(result.stderr, /starting read-only shadow preflight/);
    assert.match(result.stderr, /preflight completed/);
    assert.match(result.stderr, /shadow run complete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
