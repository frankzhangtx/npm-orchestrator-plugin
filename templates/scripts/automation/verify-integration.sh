#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
base="${2:-}"
head="${3:-}"
[[ "$#" -eq 3 ]] || { printf 'Usage: %s TASK-ID BASE-COMMIT HEAD-COMMIT\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
[[ "$(automation_read_state "$task_id")" == "INTEGRATING" ]] || automation_die "$task_id is not INTEGRATING"
contract="$(automation_contract_path "$task_id")"
"$SCRIPT_DIR/validate-contract.sh" "$task_id" >/dev/null

"$SCRIPT_DIR/integration-scope-gate.sh" "$task_id" "$base" "$head"

while IFS=$'\t' read -r gradle_task filter; do
    automation_info "running integration focused test ($gradle_task): $filter"
    automation_run_focused_test "$gradle_task" "$filter" "$AUTOMATION_ROOT"
done < <(jq -r '.targetTests[] | [.gradleTask, .filter] | @tsv' "$contract")

automation_info "running integration full unit tests"
automation_run_gradle_group "fullUnitTestTasks" "$AUTOMATION_ROOT"

automation_info "running configured integration assemble tasks"
automation_run_gradle_group "assembleTasks" "$AUTOMATION_ROOT"

automation_info "running configured integration Android lint tasks"
automation_run_gradle_group "lintTasks" "$AUTOMATION_ROOT"

if [[ "$(jq -r '.deviceTestsRequired' "$contract")" == "true" ]]; then
    automation_info "running configured integration device tests"
    automation_run_gradle_group "deviceTestTasks" "$AUTOMATION_ROOT"
fi

automation_info "integration candidate passed all deterministic verification"
