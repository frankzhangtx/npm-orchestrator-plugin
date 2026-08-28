#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
expected="${2:-}"
separator="${3:-}"
filter="${4:-}"

if [[ -z "$task_id" || -z "$expected" || "$separator" != "--" || -z "$filter" || "$#" -ne 4 ]]; then
    printf 'Usage: %s TASK-ID EXPECTED-FAILURE-TEXT -- TEST-FILTER\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
automation_validate_test_filter "$filter"
[[ ${#expected} -ge 3 ]] || automation_die "expected failure text is too short"
[[ "$(automation_read_state "$task_id")" == "CODING" ]] || automation_die "$task_id is not CODING"
"$SCRIPT_DIR/validate-contract.sh" "$task_id"

contract="$(automation_contract_path "$task_id")"
target_count="$(jq -er --arg filter "$filter" '[.targetTests[] | select(.filter == $filter)] | length' "$contract")"
[[ "$target_count" -eq 1 ]] || automation_die "test filter must identify exactly one declared contract target: $filter"
gradle_task="$(jq -er --arg filter "$filter" '.targetTests[] | select(.filter == $filter) | .gradleTask' "$contract")"

evidence_dir="$(automation_evidence_path "$task_id")"
mkdir -p "$evidence_dir"
red_log="$evidence_dir/red.log"
red_meta="$evidence_dir/red.json"
[[ ! -e "$red_meta" ]] || automation_die "RED evidence already exists for $task_id"
started_at="$(automation_now)"

set +e
automation_run_focused_test "$gradle_task" "$filter" "$AUTOMATION_ROOT" 2>&1 | tee "$red_log"
red_status=${PIPESTATUS[0]}
set -e

[[ "$red_status" -ne 0 ]] || automation_die "RED capture failed: focused test passed before implementation"
rg -F "$expected" "$red_log" >/dev/null || automation_die "RED output does not contain the expected failure text"

jq -n \
    --arg taskId "$task_id" \
    --arg startedAt "$started_at" \
    --arg finishedAt "$(automation_now)" \
    --arg expectedFailure "$expected" \
    --arg gradleTask "$gradle_task" \
    --arg testFilter "$filter" \
    --argjson exitCode "$red_status" \
    '{taskId: $taskId, startedAt: $startedAt, finishedAt: $finishedAt, command: ["./gradlew", $gradleTask, "--tests", $testFilter], expectedFailure: $expectedFailure, exitCode: $exitCode}' \
    | automation_record_json "$red_meta"

automation_info "$task_id RED evidence recorded"
