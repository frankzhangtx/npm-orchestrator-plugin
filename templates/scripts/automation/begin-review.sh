#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ "$#" -eq 1 ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
[[ "$(automation_read_state "$task_id")" == "READY_FOR_REVIEW" ]] || automation_die "$task_id is not READY_FOR_REVIEW"

ready_file="$(automation_evidence_path "$task_id")/ready.json"
[[ -f "$ready_file" ]] || automation_die "ready evidence is missing"
current_diff_sha="$(automation_worktree_diff_sha)"
[[ "$current_diff_sha" == "$(jq -er '.diffSha256' "$ready_file")" ]] || automation_die "diff changed after quality gate"

automation_transition_state "$task_id" "READY_FOR_REVIEW" "REVIEWING" "orchestrator" "sealed diff handed to a fresh read-only reviewer"
