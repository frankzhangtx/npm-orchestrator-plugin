#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

wanted="${1:-}"
case "$wanted" in
    PENDING|READY_FOR_REVIEW|REVIEWING) ;;
    *) printf 'Usage: %s PENDING|READY_FOR_REVIEW|REVIEWING\n' "$0" >&2; exit 2 ;;
esac

matches=()
while IFS= read -r state_file; do
    [[ -f "$state_file" ]] || continue
    state="$(jq -er '.state' "$state_file" 2>/dev/null || true)"
    task_id="$(jq -er '.taskId' "$state_file" 2>/dev/null || true)"
    if [[ "$state" == "$wanted" && "$task_id" =~ ^TASK-[A-Z0-9-]+$ ]]; then
        matches+=("$task_id")
    fi
done < <(find "$AUTOMATION_STATE_DIR" -maxdepth 1 -type f -name 'TASK-*.json' | LC_ALL=C sort)

if [[ "${#matches[@]}" -eq 0 ]]; then
    automation_info "no task is in state $wanted"
    exit 3
fi
if [[ "${#matches[@]}" -ne 1 ]]; then
    automation_die "expected one $wanted task, found ${#matches[@]}: ${matches[*]}"
    exit 4
fi

"$SCRIPT_DIR/validate-contract.sh" "${matches[0]}" >/dev/null
printf '%s\n' "${matches[0]}"
