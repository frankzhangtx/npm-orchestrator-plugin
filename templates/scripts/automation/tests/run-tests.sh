#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_SCRIPT_DIR="$(cd "$TEST_DIR/.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/scheduled-quality-gate-tests.XXXXXX")"
runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/scheduled-quality-runtime.XXXXXX")"
worktree_base="$(mktemp -d "${TMPDIR:-/tmp}/scheduled-quality-worktrees.XXXXXX")"
fixture="$(cd "$fixture" && pwd -P)"
runtime_root="$(cd "$runtime_root" && pwd -P)"
worktree_base="$(cd "$worktree_base" && pwd -P)"

cleanup() {
    if [[ -d "$fixture/.git" ]]; then
        while IFS= read -r path; do
            [[ -n "$path" && "$path" != "$fixture" ]] || continue
            git -C "$fixture" worktree remove --force "$path" >/dev/null 2>&1 || true
        done < <(git -C "$fixture" worktree list --porcelain 2>/dev/null | awk '/^worktree / { sub(/^worktree /, ""); print }')
    fi
    rm -rf "$fixture" "$runtime_root" "$worktree_base"
}
trap cleanup EXIT

pass_count=0

pass() {
    pass_count=$((pass_count + 1))
    printf 'ok %d - %s\n' "$pass_count" "$1"
}

fail() {
    printf 'not ok - %s\n' "$1" >&2
    exit 1
}

run_fixture() {
    (
        cd "$fixture"
        unset AUTOMATION_PROJECT_ROOT
        export AUTOMATION_TEST_MODE=1
        export AUTOMATION_RUNTIME_ROOT="$runtime_root"
        export AUTOMATION_WORKTREE_BASE="$worktree_base"
        "$@"
    )
}

run_task() {
    local task_root="$1"
    shift
    (
        cd "$task_root"
        unset AUTOMATION_PROJECT_ROOT
        export AUTOMATION_TEST_MODE=1
        export AUTOMATION_RUNTIME_ROOT="$runtime_root"
        export AUTOMATION_WORKTREE_BASE="$worktree_base"
        "$@"
    )
}

write_workspace() {
    local task_id="$1"
    local head branch
    head="$(git -C "$fixture" rev-parse HEAD)"
    branch="$(git -C "$fixture" symbolic-ref --short HEAD)"
    mkdir -p "$runtime_root/workspaces"
    jq -n \
        --arg taskId "$task_id" \
        --arg sourceRoot "$fixture" \
        --arg originalBranch "$branch" \
        --arg baselineHead "$head" \
        --arg taskRoot "$fixture" \
        --arg taskBranch "$branch" \
        --arg worktreeBase "$worktree_base" \
        '{taskId: $taskId, sourceRoot: $sourceRoot,
          originalBranch: $originalBranch, baselineHead: $baselineHead,
          workspaceStrategy: "inPlaceExclusive", taskRoot: $taskRoot,
          repositoryLeaseRequired: false, taskBranch: $taskBranch,
          worktreeBase: $worktreeBase, codingCycle: 0, reviewCycles: 0}' \
        > "$runtime_root/workspaces/$task_id.json"
}

mkdir -p \
    "$fixture/automation/tasks" \
    "$fixture/docs/plans" \
    "$fixture/local" \
    "$fixture/scripts/automation" \
    "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture" \
    "$fixture/mobile-client/src/test/java/dev/example/orchestratorfixture"

cp "$SOURCE_SCRIPT_DIR"/*.sh "$fixture/scripts/automation/"
chmod +x "$fixture/scripts/automation/"*.sh
printf '%s\n' '# Approved test plan' > "$fixture/docs/plans/TASK-TEST-001.md"
printf '%s\n' 'operator baseline' > "$fixture/local/operator-note.txt"
printf '%s\n' 'rename baseline' > "$fixture/local/rename-source.txt"
printf '%s\n' 'class ExistingFeature' > "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/ExistingFeature.kt"

printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'task="${1:-}"' \
    'if [[ "$task" == "testDebugUnitTest" && "${2:-}" == "--tests" && "${AUTOMATION_FAKE_GREEN:-0}" != "1" ]]; then' \
    '    printf "%s\n" "expected missing behavior"' \
    '    exit 1' \
    'fi' \
    'case "$task" in' \
    '    testDebugUnitTest|assembleDebug|lint|connectedDebugAndroidTest) printf "%s\n" "BUILD SUCCESSFUL" ;;' \
    '    *) printf "%s\n" "unexpected Gradle task: $task" >&2; exit 9 ;;' \
    'esac' \
    > "$fixture/gradlew"
chmod +x "$fixture/gradlew"

jq -n '{
    schemaVersion: 3,
    enabled: true,
    mode: "orchestrated",
    workspaceStrategy: "inPlaceExclusive",
    originalBranchDriftPolicy: "block",
    worktreeBase: "",
    maxFixLoops: 1,
    maxReviewCycles: 1,
    maxReviewerRestarts: 2,
    unitTestsEnabled: true,
    lintEnabled: false,
    longCommandTimeoutMs: 1800000,
    autoCleanupWorktrees: true,
    pushAfterAcceptance: false,
    approvalPhrases: {
        proposal: "批准方案，生成计划和任务合同。",
        contract: "合同已复核，批准自动执行到人工验收阶段。",
        acceptance: "验收通过，提交到原分支。",
        abort: "中止任务，封存修改并恢复原分支。",
        resume: "恢复任务，重新捕获基线并继续自动执行。"
    },
    plugins: {
        superpowers: "superpowers@git+https://github.com/obra/superpowers.git#v6.2.0"
    },
    requiredSkills: [
        "brainstorming",
        "writing-plans",
        "scheduled-quality-orchestrator",
        "scheduled-quality-coder",
        "scheduled-quality-reviewer",
        "test-driven-development",
        "systematic-debugging",
        "verification-before-completion"
    ],
    gradleVerification: {
        fullUnitTestTasks: ["testDebugUnitTest"],
        focusedTestTasks: ["testDebugUnitTest"],
        assembleTasks: ["assembleDebug"],
        lintTasks: ["lint"],
        deviceTestTasks: ["connectedDebugAndroidTest"]
    },
    androidProject: {
        name: "automation-shell-fixture",
        gradleDsl: "kotlin",
        settingsFile: "settings.gradle.kts",
        moduleScope: "all",
        primaryModule: ":mobile-client",
        modules: [{
            gradlePath: ":mobile-client",
            directory: "mobile-client",
            buildFile: "mobile-client/build.gradle.kts",
            dsl: "kotlin",
            type: "application",
            namespace: "dev.example.orchestratorfixture",
            applicationId: "dev.example.orchestratorfixture"
        }],
        productionPaths: ["mobile-client/src/main/**"],
        testPaths: [
            "mobile-client/src/test/**",
            "mobile-client/src/androidTest/**"
        ]
    },
    protectedPaths: [
        ".automation-worktree-allowlist",
        ".opencode/",
        ".automation-plugin/",
        "automation/",
        "scripts/automation/",
        "opencode.json",
        "opencode.jsonc",
        "AGENTS.md",
        "gradle/",
        "gradlew",
        "gradlew.bat",
        "settings.gradle",
        "settings.gradle.kts",
        "build.gradle",
        "build.gradle.kts",
        "**/build.gradle",
        "**/build.gradle.kts",
        "mobile-client/build.gradle.kts"
    ]
}' > "$fixture/automation/config.json"

jq -n '{
    schemaVersion: 1,
    id: "TASK-TEST-001",
    title: "Add an observable greeting behavior",
    designApproved: true,
    planPath: "docs/plans/TASK-TEST-001.md",
    ambiguityPolicy: "BLOCKED",
    maxFixLoops: 1,
    maxChangedFiles: 4,
    allowedPaths: [
        "mobile-client/src/main/java/dev/example/orchestratorfixture/**",
        "mobile-client/src/test/java/dev/example/orchestratorfixture/**"
    ],
    forbiddenPaths: [
        ".automation-worktree-allowlist",
        ".opencode/**",
        ".automation-plugin/**",
        "automation/**",
        "scripts/automation/**",
        "opencode.json",
        "opencode.jsonc",
        "AGENTS.md",
        "gradle/**",
        "gradlew",
        "gradlew.bat",
        "settings.gradle",
        "settings.gradle.kts",
        "build.gradle",
        "build.gradle.kts",
        "**/build.gradle",
        "**/build.gradle.kts",
        "mobile-client/build.gradle.kts"
    ],
    allowedSuperpowers: [
        "test-driven-development",
        "systematic-debugging",
        "verification-before-completion"
    ],
    acceptanceCriteria: ["Greeting returns the approved value"],
    nonGoals: ["No unrelated refactoring"],
    targetTests: [{
        gradleTask: "testDebugUnitTest",
        filter: "dev.example.orchestratorfixture.GreetingTest"
    }],
    deviceTestsRequired: false,
    testPolicy: "required",
    testPolicyReason: "The behavior requires a focused regression test"
}' > "$fixture/automation/tasks/TASK-TEST-001.json"

(
    cd "$fixture"
    git init -q
    git config user.email 'automation-tests@example.invalid'
    git config user.name 'Automation Tests'
    git add .
    git commit -qm 'Create automation fixture'
)

printf '%s\n' \
    '# Exact repository-relative paths intentionally kept local' \
    'local/operator-note.txt' \
    'local/generated-note.txt' \
    > "$fixture/.automation-worktree-allowlist"
printf '%s\n' 'operator local edit' > "$fixture/local/operator-note.txt"
printf '%s\n' 'generated local state' > "$fixture/local/generated-note.txt"
run_fixture ./scripts/automation/preflight.sh --source >/dev/null
allowlisted_changes="$(run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths')"
[[ -z "$allowlisted_changes" ]] || fail "allowlisted paths remained visible: $allowlisted_changes"

printf '%s\n' \
    'local/operator-note.txt' \
    'local/generated-note.txt' \
    'local/rename-target.txt' \
    > "$fixture/.automation-worktree-allowlist"
git -C "$fixture" mv local/rename-source.txt local/rename-target.txt
rename_changes="$(run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths')"
[[ "$rename_changes" == "local/rename-source.txt" ]] || \
    fail "an allowlisted rename target hid its non-allowlisted source: $rename_changes"
git -C "$fixture" mv local/rename-target.txt local/rename-source.txt
printf '%s\n' \
    '# Exact repository-relative paths intentionally kept local' \
    'local/operator-note.txt' \
    'local/generated-note.txt' \
    > "$fixture/.automation-worktree-allowlist"
pass 'exact tracked and untracked entries are ignored without hiding rename sources'

printf '%s\n' 'must still block' > "$fixture/unapproved-change.txt"
if run_fixture ./scripts/automation/preflight.sh --source >/dev/null 2>&1; then
    fail 'preflight ignored a path that was not allowlisted'
fi
rm "$fixture/unapproved-change.txt"
pass 'a non-allowlisted worktree change still blocks orchestration startup'

printf '%s\n' 'automation/config.json' > "$fixture/.automation-worktree-allowlist"
if run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths >/dev/null' 2>/dev/null; then
    fail 'worktree allowlist accepted a protected automation path'
fi
printf '%s\n' 'local/*.json' > "$fixture/.automation-worktree-allowlist"
if run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths >/dev/null' 2>/dev/null; then
    fail 'worktree allowlist accepted a glob pattern'
fi
printf '%s\n' 'local' > "$fixture/.automation-worktree-allowlist"
if run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths >/dev/null' 2>/dev/null; then
    fail 'worktree allowlist accepted a directory path'
fi
printf '%s\n' 'local/operator-note.txt' 'local/operator-note.txt' > "$fixture/.automation-worktree-allowlist"
if run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths >/dev/null' 2>/dev/null; then
    fail 'worktree allowlist accepted duplicate entries'
fi
printf '%s\n' '../outside.txt' > "$fixture/.automation-worktree-allowlist"
if run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths >/dev/null' 2>/dev/null; then
    fail 'worktree allowlist accepted a path outside the repository'
fi
rm "$fixture/.automation-worktree-allowlist"
ln -s local/operator-note.txt "$fixture/.automation-worktree-allowlist"
if run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths >/dev/null' 2>/dev/null; then
    fail 'worktree allowlist accepted a symbolic-link control file'
fi
rm "$fixture/.automation-worktree-allowlist"
printf '%s\n' \
    '# Exact repository-relative paths intentionally kept local' \
    'local/operator-note.txt' \
    'local/generated-note.txt' \
    > "$fixture/.automation-worktree-allowlist"
pass 'invalid, duplicate, symbolic-link, patterned, and protected allowlist input fails closed'

run_fixture ./scripts/automation/validate-contract.sh TASK-TEST-001 >/dev/null
verification_config_backup="$(mktemp "$runtime_root/config.json.XXXXXX")"
cp "$fixture/automation/config.json" "$verification_config_backup"

unit_enabled_output="$(run_fixture env AUTOMATION_FAKE_GREEN=1 bash -c 'source ./scripts/automation/lib.sh; automation_run_configured_unit_tests ./automation/tasks/TASK-TEST-001.json')"
[[ "$unit_enabled_output" == *"running focused test"* ]] || fail 'default unit-test policy did not run the focused test'
[[ "$unit_enabled_output" == *"running full unit tests"* ]] || fail 'default unit-test policy did not run the full unit-test group'
[[ "$unit_enabled_output" == *"BUILD SUCCESSFUL"* ]] || fail 'enabled unit-test policy did not execute configured tests'
jq '.unitTestsEnabled = false' "$verification_config_backup" > "$fixture/automation/config.json"
unit_disabled_output="$(run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_run_configured_unit_tests ./automation/tasks/TASK-TEST-001.json')"
[[ "$unit_disabled_output" == *"skipping unit tests (unitTestsEnabled=false)"* ]] || fail 'disabled unit-test policy did not skip verification'
[[ "$unit_disabled_output" != *"BUILD SUCCESSFUL"* ]] || fail 'disabled unit-test policy executed a configured test'
cp "$verification_config_backup" "$fixture/automation/config.json"

lint_disabled_output="$(run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_run_configured_lint')"
[[ "$lint_disabled_output" == *"skipping Android lint (lintEnabled=false)"* ]] || fail 'default lint policy did not skip Android lint'
jq '.lintEnabled = true' "$verification_config_backup" > "$fixture/automation/config.json"
lint_enabled_output="$(run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_run_configured_lint')"
[[ "$lint_enabled_output" == *"running configured Android lint tasks"* ]] || fail 'enabled lint policy did not run Android lint'
[[ "$lint_enabled_output" == *"BUILD SUCCESSFUL"* ]] || fail 'enabled lint policy did not execute the configured lint task'
cp "$verification_config_backup" "$fixture/automation/config.json"
rm "$verification_config_backup"
run_fixture ./scripts/automation/validate-contract.sh TASK-TEST-001 >/dev/null
pass 'repository configuration defaults unit tests on and lint off and honors both switches'

if run_fixture env AUTOMATION_HUMAN_APPROVED=0 ./scripts/automation/queue-task.sh TASK-TEST-001 >/dev/null 2>&1; then
    fail 'legacy queue accepted without explicit human approval'
fi
pass 'legacy queue rejects missing human approval'

run_fixture env AUTOMATION_HUMAN_APPROVED=1 ./scripts/automation/queue-task.sh TASK-TEST-001 >/dev/null
write_workspace TASK-TEST-001
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-001.json")" == "PENDING" ]] || fail 'queue did not create PENDING state'
pass 'explicit queue creates one auditable PENDING state'

[[ "$(run_fixture ./scripts/automation/select-task.sh PENDING)" == "TASK-TEST-001" ]] || fail 'selector did not return the only pending task'
pass 'selector returns exactly one eligible task'

jq '.taskId = "TASK-TEST-999"' \
    "$runtime_root/state/TASK-TEST-001.json" \
    > "$runtime_root/state/TASK-TEST-999.json"
if run_fixture ./scripts/automation/select-task.sh PENDING >/dev/null 2>&1; then
    fail 'selector chose among multiple pending tasks'
fi
rm "$runtime_root/state/TASK-TEST-999.json"
pass 'selector refuses to choose among multiple eligible tasks'

mkdir -p "$runtime_root/locks/TASK-TEST-001.state.lock"
printf '%s\n' '99999999' > "$runtime_root/locks/TASK-TEST-001.state.lock/pid"
if run_fixture ./scripts/automation/transition-state.sh TASK-TEST-001 PENDING READY_FOR_REVIEW human invalid >/dev/null 2>&1; then
    fail 'illegal transition was accepted'
fi
[[ ! -d "$runtime_root/locks/TASK-TEST-001.state.lock" ]] || fail 'stale state lock was not recovered'
pass 'stopped-process locks are recovered without bypassing state rules'

if run_fixture ./scripts/automation/transition-state.sh TASK-TEST-001 PENDING READY_FOR_REVIEW human invalid >/dev/null 2>&1; then
    fail 'illegal transition was accepted after lock recovery'
fi
pass 'illegal state transition is rejected'

run_fixture ./scripts/automation/claim-task.sh TASK-TEST-001 >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-001.json")" == "CODING" ]] || fail 'claim did not create CODING state'
[[ -f "$runtime_root/evidence/TASK-TEST-001/baseline.json" ]] || fail 'baseline metadata missing'
jq -e \
    '.command == ["./gradlew", "testDebugUnitTest"]' \
    "$runtime_root/evidence/TASK-TEST-001/baseline.json" >/dev/null || fail 'baseline command does not match the configured task matrix'
pass 'claim verifies workspace identity and records a green baseline'

printf '%s\n' 'class GreetingTest { fun expectedBehavior() = Unit }' > "$fixture/mobile-client/src/test/java/dev/example/orchestratorfixture/GreetingTest.kt"
run_fixture ./scripts/automation/record-red.sh TASK-TEST-001 'expected missing behavior' -- dev.example.orchestratorfixture.GreetingTest >/dev/null
[[ "$(jq -r '.exitCode' "$runtime_root/evidence/TASK-TEST-001/red.json")" -ne 0 ]] || fail 'RED evidence exit code was not captured'
jq -e \
    '.command == ["./gradlew", "testDebugUnitTest", "--tests", "dev.example.orchestratorfixture.GreetingTest"]' \
    "$runtime_root/evidence/TASK-TEST-001/red.json" >/dev/null || fail 'RED command does not bind the configured task and filter'
pass 'focused failing test records genuine RED evidence'

printf '%s\n' 'unsafe' > "$fixture/automation/forbidden-change.txt"
if run_fixture ./scripts/automation/scope-gate.sh TASK-TEST-001 >/dev/null 2>&1; then
    fail 'scope gate accepted protected path change'
fi
rm "$fixture/automation/forbidden-change.txt"
pass 'scope gate rejects protected path changes'

printf '%s\n' 'class GreetingTest { fun expectedBehavior() { assertTrue(true) } }' > "$fixture/mobile-client/src/test/java/dev/example/orchestratorfixture/GreetingTest.kt"
printf '%s\n' 'class Greeting { fun value() = "hello" }' > "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/Greeting.kt"
if run_fixture ./scripts/automation/scope-gate.sh TASK-TEST-001 >/dev/null 2>&1; then
    fail 'scope gate accepted weakened test'
fi
pass 'scope gate rejects obvious test weakening'

printf '%s\n' 'class GreetingTest { fun expectedBehavior() { check(Greeting().value() == "hello") } }' > "$fixture/mobile-client/src/test/java/dev/example/orchestratorfixture/GreetingTest.kt"
run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/quality-gate.sh TASK-TEST-001 >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-001.json")" == "READY_FOR_REVIEW" ]] || fail 'quality gate did not create READY_FOR_REVIEW state'
pass 'G1-G6 seal all tracked and untracked product changes'

run_fixture ./scripts/automation/begin-review.sh TASK-TEST-001 >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-001.json")" == "REVIEWING" ]] || fail 'review handoff did not create REVIEWING state'
review_status="$(run_fixture ./scripts/automation/status.sh TASK-TEST-001)"
[[ "$(jq -r '.evidence.red.exitCode' <<< "$review_status")" -ne 0 ]] || fail 'review status omitted RED evidence'
[[ "$(jq -r '.evidence.latestGate.lastExitCode' <<< "$review_status")" -eq 0 ]] || fail 'review status omitted gate evidence'
[[ "$(jq -r '.evidence.sealedDiffMatches' <<< "$review_status")" == "true" ]] || fail 'review status did not verify the sealed diff'
pass 'orchestrator creates an explicit sealed reviewer handoff'

run_fixture ./scripts/automation/transition-state.sh \
    TASK-TEST-001 REVIEWING BLOCKED orchestrator \
    'reviewer exited without submitting a decision' >/dev/null
sealed_sha_before_resume="$(jq -r '.diffSha256' "$runtime_root/evidence/TASK-TEST-001/ready.json")"
run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/resume-review.sh TASK-TEST-001 >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-001.json")" == "REVIEWING" ]] || fail 'reviewer-only recovery did not return directly to REVIEWING'
[[ "$(jq -r '.codingCycle' "$runtime_root/workspaces/TASK-TEST-001.json")" -eq 0 ]] || fail 'reviewer-only recovery consumed a coding cycle'
[[ "$(jq -r '.reviewCycles' "$runtime_root/workspaces/TASK-TEST-001.json")" -eq 0 ]] || fail 'reviewer-only recovery consumed a repair cycle'
[[ "$(jq -r '.diffSha256' "$runtime_root/evidence/TASK-TEST-001/ready.json")" == "$sealed_sha_before_resume" ]] || fail 'reviewer-only recovery changed ready evidence'
[[ "$(jq -r '.coderRerun' "$runtime_root/evidence/TASK-TEST-001/review-resumptions.jsonl")" == "false" ]] || fail 'reviewer-only recovery did not audit the coder bypass'
pass 'a budget-exhausted reviewer resumes from the sealed diff without rerunning Coder'

run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/submit-review.sh TASK-TEST-001 APPROVED 'Independent diff review found no material issue.' >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-001.json")" == "AWAITING_HUMAN" ]] || fail 'review did not create AWAITING_HUMAN state'
pass 'independent approval stops at AWAITING_HUMAN'

transition_count="$(wc -l < "$runtime_root/evidence/TASK-TEST-001/transitions.jsonl" | tr -d ' ')"
[[ "$transition_count" -eq 8 ]] || fail "unexpected transition audit count: $transition_count"
pass 'append-only transition audit contains the complete gated lifecycle'

(
    cd "$fixture"
    git add mobile-client
    git commit -qm 'Preserve first fixture task'
)

printf '%s\n' '# Approved failure-loop plan' > "$fixture/docs/plans/TASK-TEST-002.md"
jq \
    '.id = "TASK-TEST-002" |
     .title = "Exercise the bounded verification failure loop" |
     .planPath = "docs/plans/TASK-TEST-002.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.FailureLoopTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-002.json"
(
    cd "$fixture"
    git add automation/tasks/TASK-TEST-002.json docs/plans/TASK-TEST-002.md
    git commit -qm 'Add second approved fixture task'
)
run_fixture env AUTOMATION_HUMAN_APPROVED=1 ./scripts/automation/queue-task.sh TASK-TEST-002 >/dev/null
write_workspace TASK-TEST-002
run_fixture ./scripts/automation/claim-task.sh TASK-TEST-002 >/dev/null
printf '%s\n' 'class FailureLoopTest { fun expectedBehavior() = Unit }' > "$fixture/mobile-client/src/test/java/dev/example/orchestratorfixture/FailureLoopTest.kt"
run_fixture ./scripts/automation/record-red.sh TASK-TEST-002 'expected missing behavior' -- dev.example.orchestratorfixture.FailureLoopTest >/dev/null
printf '%s\n' 'class FailureLoop { fun value() = "still failing" }' > "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/FailureLoop.kt"

if run_fixture ./scripts/automation/quality-gate.sh TASK-TEST-002 >/dev/null 2>&1; then
    fail 'first failing gate attempt unexpectedly passed'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-002.json")" == "CODING" ]] || fail 'first failure did not preserve CODING'
pass 'first verification failure allows one systematic fix attempt'

if run_fixture ./scripts/automation/quality-gate.sh TASK-TEST-002 >/dev/null 2>&1; then
    fail 'second failing gate attempt unexpectedly passed'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-002.json")" == "TEST_FAILED" ]] || fail 'second failure did not create TEST_FAILED'
pass 'second verification failure deterministically stops in TEST_FAILED'

(
    cd "$fixture"
    git add mobile-client
    git commit -qm 'Preserve second fixture outcome'
)
printf '%s\n' '# Approved preflight-block plan' > "$fixture/docs/plans/TASK-TEST-003.md"
jq \
    '.id = "TASK-TEST-003" |
     .title = "Verify dirty worktree preflight blocking" |
     .planPath = "docs/plans/TASK-TEST-003.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.PreflightBlockTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-003.json"
(
    cd "$fixture"
    git add automation/tasks/TASK-TEST-003.json docs/plans/TASK-TEST-003.md
    git commit -qm 'Add preflight-block fixture task'
)
run_fixture env AUTOMATION_HUMAN_APPROVED=1 ./scripts/automation/queue-task.sh TASK-TEST-003 >/dev/null
write_workspace TASK-TEST-003
printf '%s\n' 'dirty' > "$fixture/unapproved-change.txt"
if run_fixture ./scripts/automation/claim-task.sh TASK-TEST-003 >/dev/null 2>&1; then
    fail 'claim accepted a dirty worktree'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-003.json")" == "BLOCKED" ]] || fail 'preflight failure did not create BLOCKED'
if run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/resume-review.sh TASK-TEST-003 >/dev/null 2>&1; then
    fail 'reviewer-only recovery accepted a non-review blocker'
fi
if run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/resume-task.sh TASK-TEST-003 '恢复任务，重新捕获基线并继续自动执行。' >/dev/null 2>&1; then
    fail 'baseline-only recovery accepted a preflight blocker'
fi
rm "$fixture/unapproved-change.txt"
pass 'preflight blocks dirty task roots without retrying implicitly'
pass 'reviewer and baseline recovery reject unrelated BLOCKED states'

printf '%s\n' '# Approved reviewer-fix plan' > "$fixture/docs/plans/TASK-TEST-005.md"
jq \
    '.id = "TASK-TEST-005" |
     .title = "Exercise the bounded reviewer repair cycle" |
     .planPath = "docs/plans/TASK-TEST-005.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.ReviewerFixTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-005.json"
(
    cd "$fixture"
    git add automation/tasks/TASK-TEST-005.json docs/plans/TASK-TEST-005.md
    git commit -qm 'Add reviewer-fix fixture task'
)
run_fixture env AUTOMATION_HUMAN_APPROVED=1 ./scripts/automation/queue-task.sh TASK-TEST-005 >/dev/null
write_workspace TASK-TEST-005
run_fixture ./scripts/automation/claim-task.sh TASK-TEST-005 >/dev/null
printf '%s\n' 'class ReviewerFixTest { fun expectedBehavior() = Unit }' > "$fixture/mobile-client/src/test/java/dev/example/orchestratorfixture/ReviewerFixTest.kt"
run_fixture ./scripts/automation/record-red.sh TASK-TEST-005 'expected missing behavior' -- dev.example.orchestratorfixture.ReviewerFixTest >/dev/null
printf '%s\n' 'class ReviewerFix { fun value() = "first pass" }' > "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/ReviewerFix.kt"
run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/quality-gate.sh TASK-TEST-005 >/dev/null
run_fixture ./scripts/automation/begin-review.sh TASK-TEST-005 >/dev/null
if run_fixture ./scripts/automation/submit-review.sh TASK-TEST-005 CHANGES_REQUESTED 'Reviewer found one material in-contract behavior issue.' >/dev/null 2>&1; then
    fail 'changes-requested review unexpectedly returned success'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-005.json")" == "CHANGES_REQUESTED" ]] || fail 'review finding did not create CHANGES_REQUESTED'
pass 'reviewer findings are recorded as a distinct state'

run_fixture ./scripts/automation/resume-review-fix.sh TASK-TEST-005 >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-005.json")" == "CODING" ]] || fail 'bounded repair did not return to CODING'
[[ "$(jq -r '.codingCycle' "$runtime_root/workspaces/TASK-TEST-005.json")" -eq 1 ]] || fail 'repair did not create a fresh gate cycle'
pass 'one configured reviewer repair gets a fresh quality-gate cycle'

printf '%s\n' 'class ReviewerFix { fun value() = "second pass" }' > "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/ReviewerFix.kt"
run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/quality-gate.sh TASK-TEST-005 >/dev/null
run_fixture ./scripts/automation/begin-review.sh TASK-TEST-005 >/dev/null
if run_fixture ./scripts/automation/submit-review.sh TASK-TEST-005 CHANGES_REQUESTED 'Fresh reviewer still found a material behavior issue.' >/dev/null 2>&1; then
    fail 'second changes-requested review unexpectedly returned success'
fi
if run_fixture ./scripts/automation/resume-review-fix.sh TASK-TEST-005 >/dev/null 2>&1; then
    fail 'review repair limit was bypassed'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-005.json")" == "NEEDS_HUMAN" ]] || fail 'repair exhaustion did not create NEEDS_HUMAN'
pass 'reviewer repair limit prevents an unbounded agent loop'

(
    cd "$fixture"
    git add mobile-client
    git commit -qm 'Preserve reviewer-fix fixture outcome'
)

printf '%s\n' '# End-to-end orchestrated plan' > "$fixture/docs/plans/TASK-TEST-004.md"
jq \
    '.id = "TASK-TEST-004" |
     .title = "Exercise in-place transactional integration" |
     .planPath = "docs/plans/TASK-TEST-004.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.OrchestratedFlowTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-004.json"

if run_fixture ./scripts/automation/prepare-contract-review.sh TASK-TEST-004 '确认' >/dev/null 2>&1; then
    fail 'proposal preparation accepted an unbound confirmation'
fi
pass 'proposal gate requires the configured approval option token'

run_fixture ./scripts/automation/prepare-contract-review.sh TASK-TEST-004 '批准方案，生成计划和任务合同。' >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-004.json")" == "CONTRACT_REVIEW" ]] || fail 'proposal gate did not enter CONTRACT_REVIEW'
pass 'approved proposal seals plan, contract, branch, HEAD, and hashes'

if run_fixture ./scripts/automation/approve-and-run.sh TASK-TEST-004 '确认执行' >/dev/null 2>&1; then
    fail 'contract execution accepted an unbound confirmation'
fi
pass 'contract gate rejects execution without the exact approval option token'

run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/approve-and-run.sh TASK-TEST-004 '合同已复核，批准自动执行到人工验收阶段。' >/dev/null
task_root="$(jq -er '.taskRoot' "$runtime_root/workspaces/TASK-TEST-004.json")"
approved_baseline="$(jq -er '.baselineHead' "$runtime_root/workspaces/TASK-TEST-004.json")"
[[ "$task_root" == "$fixture" ]] || fail 'in-place strategy did not keep the task in the source directory'
[[ "$(jq -r '.workspaceStrategy' "$runtime_root/workspaces/TASK-TEST-004.json")" == "inPlaceExclusive" ]] || fail 'workspace strategy was not recorded'
[[ "$(git -C "$fixture" symbolic-ref --short HEAD)" == "automation/task-test-004" ]] || fail 'source directory did not switch to the task branch'
[[ "$(git -C "$fixture" rev-list --count "$approved_baseline..automation/task-test-004")" -eq 0 ]] || fail 'contract approval created a planning-only commit'
[[ "$(jq -r '.contractCommit' "$runtime_root/evidence/TASK-TEST-004/origin.json")" == "null" ]] || fail 'contract approval recorded a commit before product integration'
[[ "$(git -C "$fixture" status --porcelain --untracked-files=all -- docs/plans/TASK-TEST-004.md automation/tasks/TASK-TEST-004.json | wc -l | tr -d ' ')" -eq 2 ]] || fail 'sealed planning artifacts were not left pending on the task branch'
[[ -f "$runtime_root/locks/repository.workspace.lease/lease.json" ]] || fail 'persistent repository lease was not created'
leased_status="$(run_fixture ./scripts/automation/status.sh TASK-TEST-004)"
[[ "$(jq -r '.runtime.repositoryLeaseMatches' <<< "$leased_status")" == "true" ]] || fail 'status did not verify the repository lease'
[[ "$(jq -r '.runtime.originalBranchDrifted' <<< "$leased_status")" == "false" ]] || fail 'status reported false branch drift'
[[ "$(jq -c '.runtime.effectiveWorktreeAllowlist' <<< "$leased_status")" == '["local/operator-note.txt","local/generated-note.txt"]' ]] || \
    fail 'status did not expose the approved in-place allowlist snapshot'
if run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_acquire_repository_lease TASK-TEST-999 "$PWD" inPlaceExclusive' >/dev/null 2>&1; then
    fail 'a second task acquired the persistent repository lease'
fi
pass 'persistent repository lease rejects a concurrent automation task'
[[ "$(git -C "$fixture" worktree list --porcelain | awk '/^worktree / { count++ } END { print count + 0 }')" -eq 1 ]] || fail 'in-place preparation created an unexpected worktree'
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-004.json")" == "PENDING" ]] || fail 'prepared task did not become PENDING'
pass 'contract approval switches to a leased task branch while deferring the sealed plan and contract to the product commit'

git -C "$fixture" add -- \
    .automation-worktree-allowlist \
    local/operator-note.txt \
    local/generated-note.txt
run_task "$task_root" ./scripts/automation/claim-task.sh TASK-TEST-004 >/dev/null
printf '%s\n' 'class OrchestratedFlowTest { fun expectedBehavior() = Unit }' > "$task_root/mobile-client/src/test/java/dev/example/orchestratorfixture/OrchestratedFlowTest.kt"
run_task "$task_root" ./scripts/automation/record-red.sh TASK-TEST-004 'expected missing behavior' -- dev.example.orchestratorfixture.OrchestratedFlowTest >/dev/null
printf '%s\n' 'class OrchestratedFlow { fun value() = "integrated" }' > "$task_root/mobile-client/src/main/java/dev/example/orchestratorfixture/OrchestratedFlow.kt"
run_task "$task_root" env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/quality-gate.sh TASK-TEST-004 >/dev/null
run_task "$task_root" ./scripts/automation/begin-review.sh TASK-TEST-004 >/dev/null
run_task "$task_root" env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/submit-review.sh TASK-TEST-004 APPROVED 'Fresh review confirms the sealed behavior and scope.' >/dev/null
run_task "$task_root" ./scripts/automation/acceptance-report.sh TASK-TEST-004 >/dev/null
[[ "$(jq -r '.changedPaths | length' "$runtime_root/evidence/TASK-TEST-004/acceptance-report.json")" -eq 2 ]] || fail 'acceptance package omitted product paths'
if jq -e '.changedPaths | any(. == "local/operator-note.txt" or . == "local/generated-note.txt")' \
    "$runtime_root/evidence/TASK-TEST-004/acceptance-report.json" >/dev/null; then
    fail 'acceptance package included an allowlisted local path'
fi
if rg -F 'diff --git a/local/operator-note.txt b/local/operator-note.txt' "$runtime_root/evidence/TASK-TEST-004/sealed.diff" >/dev/null || \
   rg -F 'diff --git a/local/generated-note.txt b/local/generated-note.txt' "$runtime_root/evidence/TASK-TEST-004/sealed.diff" >/dev/null || \
   rg -F 'diff --git a/.automation-worktree-allowlist b/.automation-worktree-allowlist' "$runtime_root/evidence/TASK-TEST-004/sealed.diff" >/dev/null; then
    fail 'sealed diff included allowlisted local content'
fi
[[ "$(jq -r '.evidence.qualityGate' "$runtime_root/evidence/TASK-TEST-004/acceptance-report.json")" == "PASSED" ]] || fail 'acceptance package omitted quality-gate status'
acceptance_card="$(run_fixture ./scripts/automation/show-acceptance-review.sh TASK-TEST-004)"
[[ "$acceptance_card" == *"人工验收提醒"* ]] || fail 'acceptance review did not actively identify the human gate'
[[ "$acceptance_card" == *"P0 · 真实行为是否满足合同"* ]] || fail 'acceptance review omitted behavioral focus'
[[ "$acceptance_card" == *"P0 · 旧行为与范围是否被误伤"* ]] || fail 'acceptance review omitted regression and scope focus'
[[ "$acceptance_card" == *"sealed diff SHA"* ]] || fail 'acceptance review omitted sealed binding'
[[ "$acceptance_card" == *"成功集成后自动删除；失败或阻塞时保留"* ]] || fail 'acceptance review omitted task branch cleanup policy'
pass 'automated evidence becomes one focused, SHA-verified human acceptance card'

printf '%s\n' 'class OrchestratedFlow { fun value() = "tampered after review" }' > "$task_root/mobile-client/src/main/java/dev/example/orchestratorfixture/OrchestratedFlow.kt"
if run_fixture ./scripts/automation/show-acceptance-review.sh TASK-TEST-004 >/dev/null 2>&1; then
    fail 'acceptance review displayed a diff changed after sealing'
fi
printf '%s\n' 'class OrchestratedFlow { fun value() = "integrated" }' > "$task_root/mobile-client/src/main/java/dev/example/orchestratorfixture/OrchestratedFlow.kt"
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-004.json")" == "AWAITING_HUMAN" ]] || fail 'read-only acceptance display changed task state'
pass 'acceptance display rejects a changed diff and never advances state'

original_branch="$(jq -er '.originalBranch' "$runtime_root/evidence/TASK-TEST-004/origin.json")"
if run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/accept-and-integrate.sh TASK-TEST-004 '拒绝' >/dev/null 2>&1; then
    fail 'integrator accepted an invalid final confirmation'
fi
pass 'integrator requires final acceptance bound to the sealed diff'

run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/accept-and-integrate.sh TASK-TEST-004 '验收通过，提交到原分支。' >/dev/null
combined_commit="$(jq -er '.productCommit' "$runtime_root/workspaces/TASK-TEST-004.json")"
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-004.json")" == "COMPLETED" ]] || fail 'final integration did not reach COMPLETED'
[[ "$(git -C "$fixture" symbolic-ref --short HEAD)" == "$original_branch" ]] || fail 'integrator changed the original branch identity'
[[ -f "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/OrchestratedFlow.kt" ]] || fail 'product change was not integrated into original branch'
[[ "$(git -C "$fixture" rev-list --count "$approved_baseline..$combined_commit")" -eq 1 ]] || fail 'final integration created more than one task commit'
for combined_path in \
    docs/plans/TASK-TEST-004.md \
    automation/tasks/TASK-TEST-004.json \
    mobile-client/src/main/java/dev/example/orchestratorfixture/OrchestratedFlow.kt \
    mobile-client/src/test/java/dev/example/orchestratorfixture/OrchestratedFlowTest.kt; do
    git -C "$fixture" diff-tree --no-commit-id --name-only -r "$combined_commit" | \
        awk -v expected="$combined_path" '$0 == expected { found = 1 } END { exit !found }' || \
        fail "combined task commit omitted $combined_path"
done
if git -C "$fixture" diff-tree --no-commit-id --name-only -r "$combined_commit" | \
    rg -x 'local/(operator-note|generated-note)\.txt|\.automation-worktree-allowlist' >/dev/null; then
    fail 'combined task commit included an allowlisted local path or its control file'
fi
[[ "$(cat "$fixture/local/operator-note.txt")" == "operator local edit" ]] || fail 'tracked allowlisted content changed during integration'
[[ "$(cat "$fixture/local/generated-note.txt")" == "generated local state" ]] || fail 'untracked allowlisted content changed during integration'
staged_allowlist_paths="$(git -C "$fixture" diff --cached --name-only HEAD -- | LC_ALL=C sort)"
for staged_allowlist_path in \
    .automation-worktree-allowlist \
    local/generated-note.txt \
    local/operator-note.txt; do
    printf '%s\n' "$staged_allowlist_paths" | \
        awk -v expected="$staged_allowlist_path" '$0 == expected { found = 1 } END { exit !found }' || \
        fail "integration consumed a staged allowlisted path: $staged_allowlist_path"
done
run_fixture bash -c 'source ./scripts/automation/lib.sh; automation_worktree_is_clean' || fail 'allowlisted local state made the integrated source root dirty'
pass 'in-place integration preserves allowlisted local state without evidence or commit leakage'
git -C "$fixture" restore --staged -- \
    .automation-worktree-allowlist \
    local/operator-note.txt \
    local/generated-note.txt
[[ "$(jq -r '.contractCommit' "$runtime_root/evidence/TASK-TEST-004/origin.json")" == "$combined_commit" ]] || fail 'origin evidence did not bind the contract to the combined task commit'
[[ "$(jq -r '.pushed' "$runtime_root/evidence/TASK-TEST-004/integration.json")" == "false" ]] || fail 'integration evidence did not forbid push'
[[ "$(jq -r '.method' "$runtime_root/evidence/TASK-TEST-004/integration.json")" == "inPlaceExclusive-fast-forward" ]] || fail 'integration did not use the in-place fast-forward path'
[[ "$(jq -r '.taskBranchDeleted' "$runtime_root/evidence/TASK-TEST-004/integration.json")" == "true" ]] || fail 'integration evidence did not record task branch deletion'
[[ "$(jq -r '.taskBranchDeleted' "$runtime_root/workspaces/TASK-TEST-004.json")" == "true" ]] || fail 'workspace metadata did not record task branch deletion'
if git -C "$fixture" show-ref --verify --quiet refs/heads/automation/task-test-004; then
    fail 'successful in-place integration left the local task branch behind'
fi
completed_status="$(run_fixture ./scripts/automation/status.sh TASK-TEST-004)"
[[ "$(jq -r '.runtime.taskBranchExists' <<< "$completed_status")" == "false" ]] || fail 'completed status did not report task branch deletion'
[[ ! -d "$runtime_root/locks/repository.workspace.lease" ]] || fail 'successful integration did not release the repository lease'
[[ "$(git -C "$fixture" worktree list --porcelain | awk '/^worktree / { count++ } END { print count + 0 }')" -eq 1 ]] || fail 'final integration created an unexpected candidate worktree'
pass 'one verified commit reaches the original branch and deletes the integrated local task branch without push'

printf '%s\n' '# Abort archival safety plan' > "$fixture/docs/plans/TASK-TEST-008.md"
jq \
    '.id = "TASK-TEST-008" |
     .title = "Archive an interrupted in-place task" |
     .planPath = "docs/plans/TASK-TEST-008.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.AbortArchiveTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-008.json"
run_fixture ./scripts/automation/prepare-contract-review.sh TASK-TEST-008 '批准方案，生成计划和任务合同。' >/dev/null
run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/approve-and-run.sh TASK-TEST-008 '合同已复核，批准自动执行到人工验收阶段。' >/dev/null
git -C "$fixture" add -- \
    .automation-worktree-allowlist \
    local/operator-note.txt \
    local/generated-note.txt
printf '%s\n' 'class AbortArchive { fun value() = "preserved" }' > "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/AbortArchive.kt"
printf '%s\n' 'must not be archived automatically' > "$fixture/out-of-contract.txt"
if run_fixture ./scripts/automation/abort-task.sh TASK-TEST-008 '中止任务，封存修改并恢复原分支。' >/dev/null 2>&1; then
    fail 'abort archived an out-of-contract path'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-008.json")" == "PENDING" ]] || fail 'rejected abort changed task state'
[[ -d "$runtime_root/locks/repository.workspace.lease" ]] || fail 'rejected abort released the repository lease'
rm "$fixture/out-of-contract.txt"
run_fixture ./scripts/automation/abort-task.sh TASK-TEST-008 '中止任务，封存修改并恢复原分支。' >/dev/null
abort_recovery_commit="$(jq -er '.recoveryCommit' "$runtime_root/evidence/TASK-TEST-008/abort.json")"
git -C "$fixture" cat-file -e "$abort_recovery_commit:mobile-client/src/main/java/dev/example/orchestratorfixture/AbortArchive.kt" || fail 'abort recovery commit omitted the allowed change'
git -C "$fixture" cat-file -e "$abort_recovery_commit:docs/plans/TASK-TEST-008.md" || fail 'abort recovery commit omitted the sealed plan'
git -C "$fixture" cat-file -e "$abort_recovery_commit:automation/tasks/TASK-TEST-008.json" || fail 'abort recovery commit omitted the sealed contract'
if git -C "$fixture" diff-tree --no-commit-id --name-only -r "$abort_recovery_commit" | \
    rg -x 'local/(operator-note|generated-note)\.txt|\.automation-worktree-allowlist' >/dev/null; then
    fail 'abort recovery commit included an allowlisted local path or its control file'
fi
staged_abort_allowlist_paths="$(git -C "$fixture" diff --cached --name-only HEAD -- | LC_ALL=C sort)"
for staged_allowlist_path in \
    .automation-worktree-allowlist \
    local/generated-note.txt \
    local/operator-note.txt; do
    printf '%s\n' "$staged_abort_allowlist_paths" | \
        awk -v expected="$staged_allowlist_path" '$0 == expected { found = 1 } END { exit !found }' || \
        fail "abort consumed a staged allowlisted path: $staged_allowlist_path"
done
[[ ! -f "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/AbortArchive.kt" ]] || fail 'abort left archived code on the original branch'
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-008.json")" == "ABORTED" ]] || fail 'allowed abort did not reach ABORTED'
[[ ! -d "$runtime_root/locks/repository.workspace.lease" ]] || fail 'allowed abort did not release the repository lease'
pass 'abort refuses unrelated files and archives allowed uncommitted changes in a recovery commit'
git -C "$fixture" restore --staged -- \
    .automation-worktree-allowlist \
    local/operator-note.txt \
    local/generated-note.txt

planning_only_baseline="$(git -C "$fixture" rev-parse HEAD)"
printf '%s\n' '# Planning-only abort plan' > "$fixture/docs/plans/TASK-TEST-009.md"
jq \
    '.id = "TASK-TEST-009" |
     .title = "Abort before product editing" |
     .planPath = "docs/plans/TASK-TEST-009.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.PlanningOnlyAbortTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-009.json"
run_fixture ./scripts/automation/prepare-contract-review.sh TASK-TEST-009 '批准方案，生成计划和任务合同。' >/dev/null
run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/approve-and-run.sh TASK-TEST-009 '合同已复核，批准自动执行到人工验收阶段。' >/dev/null
run_fixture ./scripts/automation/abort-task.sh TASK-TEST-009 '中止任务，封存修改并恢复原分支。' >/dev/null
[[ "$(jq -r '.recoveryCommit' "$runtime_root/evidence/TASK-TEST-009/abort.json")" == "null" ]] || fail 'planning-only abort created a recovery commit'
[[ "$(jq -r '.planningOnlyArchivedWithoutCommit' "$runtime_root/evidence/TASK-TEST-009/abort.json")" == "true" ]] || fail 'planning-only abort did not record its no-commit archival policy'
[[ "$(git -C "$fixture" rev-parse HEAD)" == "$planning_only_baseline" ]] || fail 'planning-only abort changed original branch history'
[[ ! -e "$fixture/docs/plans/TASK-TEST-009.md" && ! -e "$fixture/automation/tasks/TASK-TEST-009.json" ]] || fail 'planning-only abort left generated artifacts in the original worktree'
pass 'aborting before product edits archives planning artifacts without creating a planning-only commit'

printf '%s\n' '# Baseline interruption recovery plan' > "$fixture/docs/plans/TASK-TEST-010.md"
jq \
    '.id = "TASK-TEST-010" |
     .title = "Recover one interrupted baseline capture" |
     .planPath = "docs/plans/TASK-TEST-010.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.BaselineRecoveryTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-010.json"
run_fixture ./scripts/automation/prepare-contract-review.sh TASK-TEST-010 '批准方案，生成计划和任务合同。' >/dev/null
run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/approve-and-run.sh TASK-TEST-010 '合同已复核，批准自动执行到人工验收阶段。' >/dev/null
run_fixture ./scripts/automation/transition-state.sh TASK-TEST-010 PENDING CODING coder-launcher 'preflight passed; capturing baseline' >/dev/null
run_fixture ./scripts/automation/block-task.sh TASK-TEST-010 'claim baseline capture interrupted before metadata sealing' >/dev/null
if run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/resume-task.sh TASK-TEST-010 '拒绝' >/dev/null 2>&1; then
    fail 'baseline recovery accepted an invalid confirmation'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-010.json")" == "BLOCKED" ]] || fail 'rejected baseline recovery changed task state'
run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/resume-task.sh TASK-TEST-010 '恢复任务，重新捕获基线并继续自动执行。' >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-010.json")" == "PENDING" ]] || fail 'baseline recovery did not return to PENDING'
[[ "$(jq -s 'length' "$runtime_root/evidence/TASK-TEST-010/baseline-resumptions.jsonl")" -eq 1 ]] || fail 'baseline recovery did not record one bounded resumption'
[[ "$(jq -s -r '.[-1].kind' "$runtime_root/evidence/TASK-TEST-010/approvals.jsonl")" == "resume-baseline" ]] || fail 'baseline recovery approval was not audited'
[[ ! -f "$runtime_root/evidence/TASK-TEST-010/baseline.json" ]] || fail 'baseline recovery manufactured baseline evidence'
pass 'one explicitly approved baseline interruption resumes through PENDING without product changes'

run_fixture ./scripts/automation/transition-state.sh TASK-TEST-010 PENDING CODING coder-launcher 'preflight passed; capturing baseline' >/dev/null
run_fixture ./scripts/automation/block-task.sh TASK-TEST-010 'claim baseline capture interrupted a second time before metadata sealing' >/dev/null
if run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/resume-task.sh TASK-TEST-010 '恢复任务，重新捕获基线并继续自动执行。' >/dev/null 2>&1; then
    fail 'baseline recovery exceeded its one-restart limit'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-010.json")" == "BLOCKED" ]] || fail 'exhausted baseline recovery changed task state'
pass 'baseline recovery stops after one auditable restart'
run_fixture ./scripts/automation/abort-task.sh TASK-TEST-010 '中止任务，封存修改并恢复原分支。' >/dev/null

isolated_config_tmp="$(mktemp "$fixture/automation/.config.XXXXXX")"
jq '.workspaceStrategy = "isolatedWorktree"' "$fixture/automation/config.json" > "$isolated_config_tmp"
mv "$isolated_config_tmp" "$fixture/automation/config.json"
(
    cd "$fixture"
    git add automation/config.json
    git commit -qm 'Use isolated workspace fixture mode'
)
printf '%s\n' '# Optional isolated-workspace plan' > "$fixture/docs/plans/TASK-TEST-007.md"
jq \
    '.id = "TASK-TEST-007" |
     .title = "Keep optional isolated workspace support" |
     .planPath = "docs/plans/TASK-TEST-007.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.IsolatedFlowTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-007.json"
run_fixture ./scripts/automation/prepare-contract-review.sh TASK-TEST-007 '批准方案，生成计划和任务合同。' >/dev/null
run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/approve-and-run.sh TASK-TEST-007 '合同已复核，批准自动执行到人工验收阶段。' >/dev/null
isolated_task_root="$(jq -er '.taskRoot' "$runtime_root/workspaces/TASK-TEST-007.json")"
[[ "$isolated_task_root" != "$fixture" && -d "$isolated_task_root" ]] || fail 'optional isolated strategy did not create a separate task root'
[[ "$(jq -r '.worktreeAllowlist | length' "$runtime_root/workspaces/TASK-TEST-007.json")" -eq 2 ]] || fail 'isolated workspace did not retain the approved allowlist snapshot'
[[ -f "$isolated_task_root/docs/plans/TASK-TEST-007.md" && -f "$isolated_task_root/automation/tasks/TASK-TEST-007.json" ]] || fail 'isolated task root did not receive the sealed planning artifacts'
[[ ! -e "$fixture/docs/plans/TASK-TEST-007.md" && ! -e "$fixture/automation/tasks/TASK-TEST-007.json" ]] || fail 'isolated preparation left duplicate planning artifacts in the source root'
[[ "$(git -C "$fixture" worktree list --porcelain | awk '/^worktree / { count++ } END { print count + 0 }')" -eq 2 ]] || fail 'isolated strategy created more than one additional worktree'
isolated_status="$(run_task "$isolated_task_root" ./scripts/automation/status.sh TASK-TEST-007)"
[[ "$(jq -c '.runtime.effectiveWorktreeAllowlist' <<< "$isolated_status")" == '[]' ]] || \
    fail 'status applied the source allowlist inside an isolated task root'
printf '%s\n' 'task-local edit must stay visible' > "$isolated_task_root/local/operator-note.txt"
isolated_visible_paths="$(run_task "$isolated_task_root" bash -c 'source ./scripts/automation/lib.sh; automation_changed_paths')"
printf '%s\n' "$isolated_visible_paths" | rg -x 'local/operator-note.txt' >/dev/null || fail 'source allowlist hid a task-local isolated-worktree edit'
git -C "$isolated_task_root" restore -- local/operator-note.txt
run_task "$isolated_task_root" ./scripts/automation/claim-task.sh TASK-TEST-007 >/dev/null
printf '%s\n' 'class IsolatedFlowTest { fun expectedBehavior() = Unit }' > "$isolated_task_root/mobile-client/src/test/java/dev/example/orchestratorfixture/IsolatedFlowTest.kt"
run_task "$isolated_task_root" ./scripts/automation/record-red.sh TASK-TEST-007 'expected missing behavior' -- dev.example.orchestratorfixture.IsolatedFlowTest >/dev/null
printf '%s\n' 'class IsolatedFlow { fun value() = "integrated" }' > "$isolated_task_root/mobile-client/src/main/java/dev/example/orchestratorfixture/IsolatedFlow.kt"
run_task "$isolated_task_root" env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/quality-gate.sh TASK-TEST-007 >/dev/null
run_task "$isolated_task_root" ./scripts/automation/begin-review.sh TASK-TEST-007 >/dev/null
run_task "$isolated_task_root" env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/submit-review.sh TASK-TEST-007 APPROVED 'Independent review approves the isolated fixture.' >/dev/null
run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/accept-and-integrate.sh TASK-TEST-007 '验收通过，提交到原分支。' >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-007.json")" == "COMPLETED" ]] || fail 'isolated task did not reach COMPLETED'
[[ "$(jq -r '.method' "$runtime_root/evidence/TASK-TEST-007/integration.json")" == "isolatedWorktree-fast-forward" ]] || fail 'isolated task used the wrong integration method'
[[ ! -d "$isolated_task_root" ]] || fail 'isolated task root was not cleaned after successful integration'
[[ "$(git -C "$fixture" worktree list --porcelain | awk '/^worktree / { count++ } END { print count + 0 }')" -eq 1 ]] || fail 'isolated integration left an extra candidate worktree'
if git -C "$fixture" show-ref --verify --quiet refs/heads/automation/task-test-007; then
    fail 'successful isolated integration left the local task branch behind'
fi
[[ "$(jq -r '.taskBranchDeleted' "$runtime_root/evidence/TASK-TEST-007/integration.json")" == "true" ]] || fail 'isolated integration did not record task branch deletion'
[[ -f "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/IsolatedFlow.kt" ]] || fail 'isolated product change was not integrated'
pass 'optional isolation removes its task worktree and integrated local task branch without a second candidate'

in_place_config_tmp="$(mktemp "$fixture/automation/.config.XXXXXX")"
jq '.workspaceStrategy = "inPlaceExclusive"' "$fixture/automation/config.json" > "$in_place_config_tmp"
mv "$in_place_config_tmp" "$fixture/automation/config.json"
(
    cd "$fixture"
    git add automation/config.json
    git commit -qm 'Restore in-place fixture mode'
)

printf '%s\n' '# Advanced-original integration plan' > "$fixture/docs/plans/TASK-TEST-006.md"
jq \
    '.id = "TASK-TEST-006" |
     .title = "Block an advanced original branch" |
     .planPath = "docs/plans/TASK-TEST-006.md" |
     .targetTests = [{gradleTask: "testDebugUnitTest", filter: "dev.example.orchestratorfixture.AdvancedOriginalTest"}]' \
    "$fixture/automation/tasks/TASK-TEST-001.json" \
    > "$fixture/automation/tasks/TASK-TEST-006.json"
run_fixture ./scripts/automation/prepare-contract-review.sh TASK-TEST-006 '批准方案，生成计划和任务合同。' >/dev/null
run_fixture env AUTOMATION_SKIP_AGENT_RUN=1 ./scripts/automation/approve-and-run.sh TASK-TEST-006 '合同已复核，批准自动执行到人工验收阶段。' >/dev/null
advanced_task_root="$(jq -er '.taskRoot' "$runtime_root/workspaces/TASK-TEST-006.json")"
run_task "$advanced_task_root" ./scripts/automation/claim-task.sh TASK-TEST-006 >/dev/null
printf '%s\n' 'class AdvancedOriginalTest { fun expectedBehavior() = Unit }' > "$advanced_task_root/mobile-client/src/test/java/dev/example/orchestratorfixture/AdvancedOriginalTest.kt"
run_task "$advanced_task_root" ./scripts/automation/record-red.sh TASK-TEST-006 'expected missing behavior' -- dev.example.orchestratorfixture.AdvancedOriginalTest >/dev/null
printf '%s\n' 'class AdvancedOriginal { fun value() = "must not integrate after drift" }' > "$advanced_task_root/mobile-client/src/main/java/dev/example/orchestratorfixture/AdvancedOriginal.kt"
run_task "$advanced_task_root" env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/quality-gate.sh TASK-TEST-006 >/dev/null
run_task "$advanced_task_root" ./scripts/automation/begin-review.sh TASK-TEST-006 >/dev/null
run_task "$advanced_task_root" env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/submit-review.sh TASK-TEST-006 APPROVED 'Independent review approves the advanced-branch fixture.' >/dev/null

advanced_baseline="$(jq -er '.baselineHead' "$runtime_root/workspaces/TASK-TEST-006.json")"
advanced_original_branch="$(jq -er '.originalBranch' "$runtime_root/workspaces/TASK-TEST-006.json")"
advanced_original_commit="$(printf '%s\n' 'Advance original branch independently' | git -C "$fixture" commit-tree "$advanced_baseline^{tree}" -p "$advanced_baseline")"
git -C "$fixture" update-ref "refs/heads/$advanced_original_branch" "$advanced_original_commit" "$advanced_baseline"
[[ "$(git -C "$fixture" rev-parse "refs/heads/$advanced_original_branch")" == "$advanced_original_commit" ]] || fail 'original branch did not advance for drift test'
pass 'a clean descendant commit is recognized as original-branch drift'

if run_fixture env AUTOMATION_FAKE_GREEN=1 ./scripts/automation/accept-and-integrate.sh TASK-TEST-006 '验收通过，提交到原分支。' >/dev/null 2>&1; then
    fail 'integrator accepted an original branch that drifted from the recorded pre-task baseline'
fi
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-006.json")" == "INTEGRATION_BLOCKED" ]] || fail 'branch drift did not create INTEGRATION_BLOCKED'
[[ "$(git -C "$fixture" rev-parse "refs/heads/$advanced_original_branch")" == "$advanced_original_commit" ]] || fail 'blocked integration changed the advanced original branch'
git -C "$fixture" show-ref --verify --quiet refs/heads/automation/task-test-006 || fail 'blocked integration deleted the recoverable task branch'
[[ ! -f "$runtime_root/evidence/TASK-TEST-006/integration.json" ]] || fail 'blocked integration recorded false success evidence'
pass 'original-branch drift blocks integration while preserving the original and task branches'

if run_fixture ./scripts/automation/abort-task.sh TASK-TEST-006 '中止' >/dev/null 2>&1; then
    fail 'abort accepted an unbound confirmation'
fi
run_fixture ./scripts/automation/abort-task.sh TASK-TEST-006 '中止任务，封存修改并恢复原分支。' >/dev/null
[[ "$(jq -r '.state' "$runtime_root/state/TASK-TEST-006.json")" == "ABORTED" ]] || fail 'deterministic abort did not reach ABORTED'
[[ "$(git -C "$fixture" symbolic-ref --short HEAD)" == "$advanced_original_branch" ]] || fail 'abort did not restore the source directory to the original branch'
[[ "$(git -C "$fixture" rev-parse HEAD)" == "$advanced_original_commit" ]] || fail 'abort changed the advanced original branch ref'
[[ "$(jq -r '.recoveryCommit' "$runtime_root/evidence/TASK-TEST-006/abort.json")" == "$(jq -r '.productCommit' "$runtime_root/workspaces/TASK-TEST-006.json")" ]] || fail 'abort did not preserve the product commit as recovery evidence'
[[ ! -f "$fixture/mobile-client/src/main/java/dev/example/orchestratorfixture/AdvancedOriginal.kt" ]] || fail 'aborted product code remained in the restored original working tree'
[[ ! -d "$runtime_root/locks/repository.workspace.lease" ]] || fail 'abort did not release the repository lease'
pass 'explicit abort preserves recovery evidence and restores the original branch without changing its ref'

printf '1..%d\n' "$pass_count"
