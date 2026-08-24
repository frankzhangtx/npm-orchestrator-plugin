#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ "$#" -eq 1 ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
automation_require_orchestrated

workspace_file="$(automation_workspace_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
state_file="$(automation_state_path "$task_id")"
ready_file="$evidence_dir/ready.json"
transitions_file="$evidence_dir/transitions.jsonl"
resumptions_file="$evidence_dir/review-resumptions.jsonl"

[[ -f "$workspace_file" ]] || automation_die "workspace metadata is missing for $task_id"
[[ -f "$state_file" ]] || automation_die "state is missing for $task_id"
[[ -f "$evidence_dir/baseline.json" ]] || automation_die "baseline evidence is missing"
[[ -f "$evidence_dir/red.json" ]] || automation_die "RED evidence is missing"
[[ -f "$ready_file" ]] || automation_die "ready evidence is missing"
[[ -f "$transitions_file" ]] || automation_die "transition evidence is missing"

automation_acquire_run_lock "$task_id"
trap 'automation_release_run_lock' EXIT

[[ "$(automation_read_state "$task_id")" == "BLOCKED" ]] || automation_die "$task_id is not BLOCKED"

task_root="$(automation_workspace_task_root "$workspace_file")"
workspace_strategy="$(automation_workspace_strategy "$workspace_file")"
source_root="$(jq -er '.sourceRoot' "$workspace_file")"
source_root="$(jq -er '.sourceRoot' "$workspace_file")"
task_branch="$(jq -er '.taskBranch' "$workspace_file")"
baseline_head="$(jq -er '.baselineHead' "$workspace_file")"
coding_cycle="$(jq -er '.codingCycle // 0' "$workspace_file")"

[[ -d "$task_root" ]] || automation_die "task root is missing: $task_root"
if [[ "$(jq -r '.repositoryLeaseRequired // false' "$workspace_file")" == "true" ]]; then
    automation_require_repository_lease "$task_id" "$source_root" "$workspace_strategy"
fi
task_root="$(cd "$task_root" && pwd -P)"
source_root="$(cd "$source_root" && pwd -P)"
[[ "$source_root" == "$AUTOMATION_ROOT" ]] || automation_die "workspace sourceRoot does not match this repository"
[[ "$(automation_current_branch "$task_root")" == "$task_branch" ]] || automation_die "task branch changed"
[[ "$(git -C "$task_root" rev-parse HEAD)" == "$baseline_head" ]] || automation_die "task HEAD changed after sealing"
[[ "$(jq -er '.head' "$evidence_dir/baseline.json")" == "$baseline_head" ]] || automation_die "baseline evidence does not match workspace metadata"
[[ "$(jq -er '.head' "$ready_file")" == "$baseline_head" ]] || automation_die "ready evidence does not match the baseline"
[[ "$(jq -er '.codingCycle // 0' "$ready_file")" == "$coding_cycle" ]] || automation_die "ready evidence belongs to a different coding cycle"

if ! jq -es -e '
    ([to_entries[] |
      select(.value.from == "REVIEWING" and
             .value.to == "BLOCKED" and
             .value.actor == "orchestrator" and
             (.value.note | startswith("reviewer exited without submitting a decision")))] | last) as $failure
    | ($failure != null) and
      all(.[$failure.key + 1:][];
          (.from == "BLOCKED" and .to == "PENDING" and .actor == "human") or
          (.from == "PENDING" and .to == "BLOCKED" and
           (.actor == "coder" or .actor == "preflight" or .actor == "orchestrator")))
' "$transitions_file" >/dev/null; then
    automation_die "BLOCKED state is not a recoverable reviewer interruption"
fi

ready_diff_sha="$(jq -er '.diffSha256' "$ready_file")"
current_diff_sha="$(automation_worktree_diff_sha "$task_root")"
[[ "$current_diff_sha" == "$ready_diff_sha" ]] || automation_die "sealed diff changed; reviewer-only recovery is forbidden"

if [[ -f "$evidence_dir/reviews.jsonl" ]] &&
   jq -es -e --arg sha "$ready_diff_sha" 'any(.[]; .diffSha256 == $sha)' "$evidence_dir/reviews.jsonl" >/dev/null; then
    automation_die "a reviewer decision already exists for the sealed diff"
fi
if [[ -f "$evidence_dir/review.json" ]] &&
   jq -e --arg sha "$ready_diff_sha" '.diffSha256 == $sha' "$evidence_dir/review.json" >/dev/null; then
    automation_die "a reviewer decision already exists for the sealed diff"
fi

restart_count=0
if [[ -f "$resumptions_file" ]]; then
    restart_count="$(jq -s --arg sha "$ready_diff_sha" '[.[] | select(.diffSha256 == $sha)] | length' "$resumptions_file")"
fi
max_restarts="$(automation_config_value '.maxReviewerRestarts')"
[[ "$restart_count" -lt "$max_restarts" ]] || automation_die "reviewer restart limit exhausted for the sealed diff"
next_restart=$((restart_count + 1))

(
    cd "$task_root"
    ./scripts/automation/scope-gate.sh "$task_id" >/dev/null
)

blocked_revision="$(jq -er '.revision' "$state_file")"
automation_transition_state \
    "$task_id" \
    "BLOCKED" \
    "REVIEWING" \
    "human" \
    "reviewer-only recovery $next_restart/$max_restarts; sealed diff preserved and coder bypassed"

jq -nc \
    --arg taskId "$task_id" \
    --arg at "$(automation_now)" \
    --arg diffSha256 "$ready_diff_sha" \
    --argjson blockedRevision "$blocked_revision" \
    --argjson restart "$next_restart" \
    --argjson maxRestarts "$max_restarts" \
    --argjson codingCycle "$coding_cycle" \
    '{taskId: $taskId, at: $at, diffSha256: $diffSha256,
      blockedRevision: $blockedRevision, restart: $restart,
      maxRestarts: $maxRestarts, codingCycle: $codingCycle,
      route: "BLOCKED->REVIEWING", coderRerun: false}' \
    | automation_append_json "$resumptions_file"

automation_info "$task_id reviewer-only recovery accepted; sealed diff $ready_diff_sha"
automation_release_run_lock
trap - EXIT

"$SCRIPT_DIR/orchestrate-task.sh" "$task_id"
