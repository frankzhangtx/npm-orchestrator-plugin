#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ "$#" -eq 1 ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
[[ "$(automation_read_state "$task_id")" == "CHANGES_REQUESTED" ]] || automation_die "$task_id is not CHANGES_REQUESTED"

workspace_file="$(automation_workspace_path "$task_id")"
[[ -f "$workspace_file" ]] || automation_die "workspace metadata is missing"
review_cycles="$(jq -er '.reviewCycles // 0' "$workspace_file")"
max_review_cycles="$(automation_config_value '.maxReviewCycles')"
if [[ "$review_cycles" -ge "$max_review_cycles" ]]; then
    automation_transition_state "$task_id" "CHANGES_REQUESTED" "NEEDS_HUMAN" "orchestrator" "automatic review-fix cycle limit exhausted"
    automation_die "review-fix cycle limit exhausted"
fi

next_review_cycle=$((review_cycles + 1))
coding_cycle="$(jq -er '.codingCycle // 0' "$workspace_file")"
next_coding_cycle=$((coding_cycle + 1))
jq \
    --argjson reviewCycles "$next_review_cycle" \
    --argjson codingCycle "$next_coding_cycle" \
    --arg updatedAt "$(automation_now)" \
    '.reviewCycles = $reviewCycles | .codingCycle = $codingCycle | .updatedAt = $updatedAt' \
    "$workspace_file" | automation_record_json "$workspace_file"

automation_transition_state "$task_id" "CHANGES_REQUESTED" "CODING" "orchestrator" "bounded reviewer feedback cycle $next_review_cycle started"
