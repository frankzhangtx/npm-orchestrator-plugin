#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
"$SCRIPT_DIR/validate-contract.sh" "$task_id" >/dev/null

contract="$(automation_contract_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
[[ -f "$evidence_dir/baseline.json" ]] || { automation_die "baseline evidence is missing"; exit 41; }
[[ -f "$evidence_dir/red.json" ]] || { automation_die "RED evidence is missing"; exit 41; }

contract_schema="$(jq -er '.schemaVersion' "$contract")"
if [[ "$contract_schema" == "3" ]]; then
    preflight_meta="$evidence_dir/test-preflight.json"
    manifest_meta="$evidence_dir/test-manifest.json"
    red_meta="$evidence_dir/red.json"
    [[ -f "$preflight_meta" && -f "$manifest_meta" ]] || { automation_die "structured RED evidence is incomplete"; exit 41; }
    [[ "$(jq -er '.valid' "$preflight_meta")" == "true" ]] || { automation_die "structured RED preflight was not valid"; exit 41; }
    [[ "$(jq -er '.contractSha256' "$red_meta")" == "$(automation_file_sha256 "$contract")" ]] || { automation_die "RED contract binding changed"; exit 41; }
    [[ "$(jq -er '.baselineHead' "$red_meta")" == "$(jq -er '.head' "$evidence_dir/baseline.json")" ]] || { automation_die "RED baseline binding changed"; exit 41; }
    [[ "$(jq -er '.testDiffSha256' "$red_meta")" == "$(automation_test_diff_sha "$task_id" "$AUTOMATION_ROOT")" ]] || { automation_die "tests changed after structured RED"; exit 41; }
    [[ "$(jq -er '.preflightSha256' "$red_meta")" == "$(automation_file_sha256 "$preflight_meta")" ]] || { automation_die "RED preflight evidence changed"; exit 41; }
    [[ "$(jq -er '.manifestSha256' "$red_meta")" == "$(automation_file_sha256 "$manifest_meta")" ]] || { automation_die "RED test manifest changed"; exit 41; }
fi

"$SCRIPT_DIR/scope-gate.sh" "$task_id"

automation_run_configured_unit_tests "$contract" "$AUTOMATION_ROOT"

automation_info "running configured assemble tasks"
automation_run_gradle_group "assembleTasks" "$AUTOMATION_ROOT"

automation_run_configured_lint "$AUTOMATION_ROOT"

if [[ "$(jq -r '.deviceTestsRequired' "$contract")" == "true" ]]; then
    automation_info "running configured device tests"
    automation_run_gradle_group "deviceTestTasks" "$AUTOMATION_ROOT"
fi

automation_info "all deterministic verification commands passed"
if [[ -n "${AUTOMATION_QUEUE_RUN_ID:-}" ]]; then
    [[ -n "${AUTOMATION_FULL_TEST_LOG:-}" ]] || automation_die "fresh full unit-test evidence is missing"
    jq -n \
        --arg taskId "$task_id" \
        --arg runId "$AUTOMATION_QUEUE_RUN_ID" \
        --arg diffSha256 "$(automation_worktree_diff_sha)" \
        --arg log "$AUTOMATION_FULL_TEST_LOG" \
        --argjson elapsedSeconds "$AUTOMATION_FULL_TEST_ELAPSED" \
        --argjson tasks "$(jq -c '.gradleVerification.fullUnitTestTasks' "$AUTOMATION_CONFIG")" \
        '{taskId: $taskId, runId: $runId, diffSha256: $diffSha256,
          fullTestsExecuted: true, tasks: $tasks, log: $log, elapsedSeconds: $elapsedSeconds}' \
        | automation_record_json "$evidence_dir/full-test-verification.json"
fi
