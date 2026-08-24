#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
shift $(( $# >= 1 ? 1 : $# ))
reason="$*"

if [[ -z "$task_id" || ${#reason} -lt 12 ]]; then
    printf 'Usage: %s TASK-ID REASON-OF-AT-LEAST-12-CHARACTERS\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
current="$(automation_read_state "$task_id")"
case "$current" in
    PENDING|CODING)
        automation_transition_state "$task_id" "$current" "BLOCKED" "coder" "$reason"
        ;;
    *)
        automation_die "cannot block $task_id from state $current"
        ;;
esac
