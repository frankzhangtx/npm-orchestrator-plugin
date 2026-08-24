#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: AUTOMATION_HUMAN_APPROVED=1 %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
automation_require_layout

[[ "${AUTOMATION_HUMAN_APPROVED:-0}" == "1" ]] || automation_die "set AUTOMATION_HUMAN_APPROVED=1 after explicit human approval"
[[ "$(automation_config_value '.enabled')" == "true" ]] || automation_die "automation is disabled"
[[ "$(automation_config_value '.mode')" == "orchestrated" ]] || automation_die "automation mode is not orchestrated"

"$SCRIPT_DIR/validate-contract.sh" "$task_id"
state_file="$(automation_state_path "$task_id")"

if [[ ! -f "$state_file" ]]; then
    automation_initialize_state "$task_id" "APPROVED_CONTRACT" "human" "legacy manual queue initialized"
fi

current="$(automation_read_state "$task_id")"
case "$current" in
    APPROVED_CONTRACT|TEST_FAILED|BLOCKED|CHANGES_REQUESTED)
        automation_transition_state "$task_id" "$current" "PENDING" "human" "explicit human queue approval"
        ;;
    PENDING)
        automation_info "$task_id is already PENDING"
        ;;
    *)
        automation_die "cannot queue $task_id from state $current"
        ;;
esac
