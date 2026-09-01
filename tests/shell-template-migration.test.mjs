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
    "734c05f82db7f77dba7b0ac8ae1fc92d3c02cb8e877b9309944269cbd853464d",
  ],
  [
    "scripts/automation/accept-and-integrate.sh",
    "b1fc65b31b275de79621714d48175bf00cd63647db92d9aeb4841fd382c055fa",
  ],
  [
    "scripts/automation/acceptance-report.sh",
    "a3dee5d983cf2aa6cecd6b1791ac645dce337e671ae1e6bcf950143770e6e386",
  ],
  [
    "scripts/automation/approve-and-run.sh",
    "6f15ce1a95dd3886fc053d7f00d0b6d1c6ef58e38bd93fe2a1fa98e92fa56f2b",
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
    "f20dc032b7ba97623def068e9eb9fc7056ae8cc5a09858612e25cf478d243947",
  ],
  [
    "scripts/automation/integration-scope-gate.sh",
    "1ba0d1cf566ff1015ce3070296cc83202aa26f4c4a17c483c3cdc7e1f56b5b50",
  ],
  [
    "scripts/automation/lib.sh",
    "d81f063ec1a73900327a658b07bbdcc40a4e5f70b464e3cd2e9452258832aa5a",
  ],
  [
    "scripts/automation/orchestrate-task.sh",
    "1a2ea9925caf6ba67c216c2ee1e58fd7625401a674c4a2d5f1e532c5affec288",
  ],
  [
    "scripts/automation/preflight.sh",
    "e04531b02530616632026b63e803be4764813d2d4a1469d1ea277e91f5190e08",
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
    "5586bfcf240eea11f738829deff8a4d21fa6ab7a378c574a79b958caaa08a18b",
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
    "0fa9df61c26af0fdfd1baa0ec6c0a6ac1edfb01fe08b3404d7c4aba61934f0c5",
  ],
  [
    "scripts/automation/transition-state.sh",
    "294d5d0e1c217d9efe3bf48d6f4d0eca1abec7a2216b27ec41da479766b5f7b7",
  ],
  [
    "scripts/automation/validate-contract.sh",
    "bc0f1e62be119b8bf3907f17b1787bb6c85906d8bcdb4cf1fb9ab0a9ed2836e1",
  ],
  [
    "scripts/automation/verify-integration.sh",
    "287d8280f14738f3a248c560360b5373572b8c93221a5cdf740623aee7c0cfce",
  ],
  [
    "scripts/automation/verify-task.sh",
    "39276cc40d470edfb1c78685bf8557b65ec600e8cf8c7eb9e7f9682b684743e3",
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
