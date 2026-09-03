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

automation_run_configured_unit_tests "$contract" "$AUTOMATION_ROOT" "integration "

automation_info "running configured integration assemble tasks"
automation_run_gradle_group "assembleTasks" "$AUTOMATION_ROOT"

automation_run_configured_lint "$AUTOMATION_ROOT"

if [[ "$(jq -r '.deviceTestsRequired' "$contract")" == "true" ]]; then
    automation_info "running configured integration device tests"
    automation_run_gradle_group "deviceTestTasks" "$AUTOMATION_ROOT"
fi

automation_info "integration candidate passed all deterministic verification"
