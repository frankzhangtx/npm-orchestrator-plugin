#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
expected="${2:-}"
next="${3:-}"
actor="${4:-}"
note="${5:-}"

if [[ -z "$task_id" || -z "$expected" || -z "$next" || -z "$actor" || -z "$note" ]]; then
    printf 'Usage: %s TASK-ID EXPECTED NEXT ACTOR NOTE\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
automation_require_layout
automation_transition_state "$task_id" "$expected" "$next" "$actor" "$note"
