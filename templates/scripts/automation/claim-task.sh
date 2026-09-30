#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
automation_require_queue_execution "$task_id"
automation_require_layout

[[ "$(automation_read_state "$task_id")" == "PENDING" ]] || automation_die "$task_id is not PENDING"
evidence_dir="$(automation_evidence_path "$task_id")"
mkdir -p "$evidence_dir"
preflight_log="$evidence_dir/preflight.log"
set +e
"$SCRIPT_DIR/preflight.sh" "$task_id" 2>&1 | tee "$preflight_log"
preflight_status=${PIPESTATUS[0]}
set -e
if [[ "$preflight_status" -ne 0 ]]; then
    automation_transition_state "$task_id" "PENDING" "BLOCKED" "preflight" "preflight failed with exit $preflight_status"
    automation_die "preflight failed; task moved to BLOCKED"
fi

automation_transition_state "$task_id" "PENDING" "CODING" "coder-launcher" "preflight passed; capturing baseline"

if [[ "$(jq -r '.schemaVersion' "$(automation_contract_path "$task_id")")" -ge "5" ]]; then
    queue_file="$AUTOMATION_RUNTIME_ROOT/inbox/queue.json"
    run_kind="$(jq -er --arg run "$AUTOMATION_QUEUE_RUN_ID" 'select(.active.id == $run) | .active.kind' "$queue_file")"
    case "$run_kind" in
        execute) recovery_mode=initial ;;
        retry-baseline) recovery_mode=auto ;;
        resume) recovery_mode=manual ;;
        *) automation_die "V5 baseline capture requires a queue execution or recovery reservation"; exit 1 ;;
    esac
    recovery_sha="$(jq -r --arg task "$task_id" '.items[] | select(.taskId == $task) | .baselineRecovery.sha256 // ""' "$queue_file")"
    set +e
    node "$AUTOMATION_ROOT/automation/verification/recovery.cjs" \
        "$(automation_contract_path "$task_id")" "$AUTOMATION_CONFIG" "$AUTOMATION_ROOT" "$evidence_dir" "$recovery_mode" "$recovery_sha"
    recovery_status=$?
    set -e
    if [[ "$recovery_status" -ne 0 ]]; then
        automation_transition_state "$task_id" "CODING" "BLOCKED" "preflight" "V5 baseline capture stopped; inspect baseline-recovery.json"
        exit "$recovery_status"
    fi
    automation_info "$task_id claimed; complete V5 baseline sealed"
    exit 0
fi

baseline_log="$evidence_dir/baseline.log"
baseline_meta="$evidence_dir/baseline.json"
protected_hashes="$evidence_dir/protected.sha256"
started_at="$(automation_now)"
head_commit="$(git -C "$AUTOMATION_ROOT" rev-parse HEAD)"
unit_tests_enabled="$(automation_config_value '.unitTestsEnabled')"
baseline_cwd="$(automation_gradle_build_root)"
baseline_command='[]'
if [[ "$unit_tests_enabled" == "true" ]]; then
    baseline_command="$(automation_gradle_group_command_json "fullUnitTestTasks")"
fi

if [[ "$unit_tests_enabled" == "true" ]]; then
    set +e
    automation_run_gradle_group "fullUnitTestTasks" "$AUTOMATION_ROOT" 2>&1 | tee "$baseline_log"
    baseline_status=${PIPESTATUS[0]}
    set -e
else
    automation_info "skipping baseline unit tests (unitTestsEnabled=false)" | tee "$baseline_log"
    baseline_status=0
fi

if [[ "$baseline_status" -ne 0 ]]; then
    jq -n \
        --arg taskId "$task_id" \
        --arg startedAt "$started_at" \
        --arg finishedAt "$(automation_now)" \
        --arg head "$head_commit" \
        --arg cwd "$baseline_cwd" \
        --argjson command "$baseline_command" \
        --argjson unitTestsEnabled "$unit_tests_enabled" \
        --argjson exitCode "$baseline_status" \
        '{taskId: $taskId, startedAt: $startedAt, finishedAt: $finishedAt, head: $head, command: $command, cwd: $cwd, unitTestsEnabled: $unitTestsEnabled, exitCode: $exitCode}' \
        | automation_record_json "$baseline_meta"
    automation_transition_state "$task_id" "CODING" "BLOCKED" "preflight" "baseline unit tests failed"
    automation_die "baseline unit tests failed"
fi

: > "$protected_hashes"
while IFS= read -r tracked; do
    while IFS= read -r protected; do
        if automation_path_matches "$tracked" "$protected"; then
            shasum -a 256 "$AUTOMATION_ROOT/$tracked" >> "$protected_hashes"
            break
        fi
    done < <(jq -r '.protectedPaths[]' "$AUTOMATION_CONFIG")
done < <(git -C "$AUTOMATION_ROOT" ls-files)

jq -n \
    --arg taskId "$task_id" \
    --arg startedAt "$started_at" \
    --arg finishedAt "$(automation_now)" \
    --arg head "$head_commit" \
    --arg worktree "$AUTOMATION_ROOT" \
    --arg cwd "$baseline_cwd" \
    --argjson command "$baseline_command" \
    --argjson unitTestsEnabled "$unit_tests_enabled" \
    '{taskId: $taskId, startedAt: $startedAt, finishedAt: $finishedAt, head: $head, worktree: $worktree, command: $command, cwd: $cwd, unitTestsEnabled: $unitTestsEnabled, exitCode: 0}' \
    | automation_record_json "$baseline_meta"

if [[ "$(jq -r '.schemaVersion' "$(automation_contract_path "$task_id")")" == "4" ]]; then
    if ! automation_run_inventory baseline "$task_id"; then
        automation_transition_state "$task_id" "CODING" "BLOCKED" "preflight" "baseline inventory failed; inspect inventory-status.json"
        automation_die "baseline inventory failed; Coder must not edit tests"
    fi
fi

if [[ "$unit_tests_enabled" == "true" ]]; then
    automation_info "$task_id claimed; baseline is green"
else
    automation_info "$task_id claimed; baseline unit tests were disabled by configuration"
fi
