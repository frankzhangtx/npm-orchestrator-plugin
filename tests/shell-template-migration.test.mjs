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
    "644194ca949cb4a5be2be4ac157273bea70984520f4834dcd112ca76650c9b4a",
  ],
  [
    "scripts/automation/accept-and-integrate.sh",
    "376617529539648b6c9cd5149d6ba4ff3b0d657a83a4b69ed33ce56396944507",
  ],
  [
    "scripts/automation/acceptance-report.sh",
    "a3dee5d983cf2aa6cecd6b1791ac645dce337e671ae1e6bcf950143770e6e386",
  ],
  [
    "scripts/automation/approve-and-run.sh",
    "64943afcd6c1b21ed4bb7d47af96830dfab0b4e47854910664ecf5cf8b639d7a",
  ],
  [
    "scripts/automation/begin-review.sh",
    "02f0b9551e81c2f540e1bb3fc223cd6efef7ca1a84d86f2ccd87fbdf1fb45e9d",
  ],
  [
    "scripts/automation/block-task.sh",
    "86dd3c6b5f906724b530a8799c14c2d90d05176b152b67d9d435bd205cd1b893",
  ],
  [
    "scripts/automation/claim-task.sh",
    "da89a3985d8ebcf1d1589c5908b4f714c77f10150ec2b9c6d0ec0f8928da837e",
  ],
  [
    "scripts/automation/integration-scope-gate.sh",
    "1ba0d1cf566ff1015ce3070296cc83202aa26f4c4a17c483c3cdc7e1f56b5b50",
  ],
  [
    "scripts/automation/lib.sh",
    "6dcddb2911149e4fd38c2aa2bdedcdd8a0826f6cf0c52bcfd9e6100f1fc24494",
  ],
  [
    "scripts/automation/orchestrate-task.sh",
    "713cc9152abc973bad824bcbb678bb5362617219b3bd19bcecb3670cbb9213db",
  ],
  [
    "scripts/automation/preflight.sh",
    "3382698a1406d4884f398fea99ef908a8444bd6b0fd959bdcdce117f8c4b8837",
  ],
  [
    "scripts/automation/prepare-contract-review.sh",
    "c50a0a67515ea89d613b97e4e6fd625551a2c7a08ae93881e955df94c4c10430",
  ],
  [
    "scripts/automation/quality-gate.sh",
    "65eeb266f707a61fa7992a1002457359eff95210c3af7a5ce39a60e82424ae01",
  ],
  [
    "scripts/automation/queue-task.sh",
    "25ddd03d9a02291c945cade4c425d25647a9474a0a91b0de3c651c808e71c341",
  ],
  [
    "scripts/automation/record-red.sh",
    "5f5fff2c3562a3a6ad3872d28675a589f6630931a75e69fc71cf498a3eb84cb7",
  ],
  [
    "scripts/automation/resume-review-fix.sh",
    "9d56ad22c5bcf9d56f085f3b7b41680ff891f0d2f0a332f46027fb7279647bd5",
  ],
  [
    "scripts/automation/resume-review.sh",
    "dd0a73af218c4a1b7e9cf5266574b0f943fb12c61ec1e652d1fea2a6e9187592",
  ],
  [
    "scripts/automation/resume-task.sh",
    "80aa4085ac9ee95ff483bc0b487efe62cfe585d5a65dae0bbb47272dd977d601",
  ],
  [
    "scripts/automation/scope-gate.sh",
    "bb6aaf80ac0341e59b460858a4074e8a2d333fa51f25b9d55f5ad72cbe2b7578",
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
    "e8aff58b5b5080f9fee437b4c76c46546fb456117fcfd4f396250a97261c0225",
  ],
  [
    "scripts/automation/status.sh",
    "719e1bdfed4b7d2666847f5babaa2ac870371cd760923c77e124cbf54966be66",
  ],
  [
    "scripts/automation/submit-review.sh",
    "9efe0ad028014aaa6be42ee93eb568d091b67321370f32626ad569afb6b46f46",
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
    "762936699efb3a99345ad1d05bff05b8668ce022b166e3224783734120260200",
  ],
  [
    "scripts/automation/verify-integration.sh",
    "9bb30fd2214b2d0d72dd1046d49b964bd5da113e5c0ebdcf722b05be2af42cc0",
  ],
  [
    "scripts/automation/verify-task.sh",
    "26c0e2a51ebc59a687e58c598e9989d8f3d4db2a816ea93c3662e36cef3497e0",
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
