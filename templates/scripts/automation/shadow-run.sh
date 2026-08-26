#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

automation_info "starting read-only shadow preflight" >&2
"$SCRIPT_DIR/preflight.sh" --shadow >&2

task_count="$(find "$AUTOMATION_TASKS_DIR" -maxdepth 1 -type f -name 'TASK-*.json' | wc -l | tr -d ' ')"
automation_ensure_runtime_layout
state_count="$(find "$AUTOMATION_STATE_DIR" -maxdepth 1 -type f -name 'TASK-*.json' | wc -l | tr -d ' ')"

jq -n \
    --arg checkedAt "$(automation_now)" \
    --arg root "$AUTOMATION_ROOT" \
    --arg enabled "$(automation_config_value '.enabled')" \
    --arg mode "$(automation_config_value '.mode')" \
    --argjson taskCount "$task_count" \
    --argjson stateCount "$state_count" \
    '{checkedAt: $checkedAt, root: $root, enabled: ($enabled == "true"), mode: $mode, activeContracts: $taskCount, runtimeStates: $stateCount, mutationPerformed: false}'

automation_info "shadow run complete; no repository mutation performed" >&2
