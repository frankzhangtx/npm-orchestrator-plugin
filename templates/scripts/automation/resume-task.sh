#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
approval="${2:-}"
if [[ "$#" -ne 2 ]]; then
    printf 'Usage: %s TASK-ID "RESUME-APPROVAL"\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
automation_require_orchestrated
automation_require_approval resume "$approval"

workspace_file="$(automation_workspace_path "$task_id")"
origin_file="$(automation_origin_path "$task_id")"
state_file="$(automation_state_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
transitions_file="$evidence_dir/transitions.jsonl"
resumptions_file="$evidence_dir/baseline-resumptions.jsonl"

[[ -f "$workspace_file" ]] || automation_die "workspace metadata is missing for $task_id"
[[ -f "$origin_file" ]] || automation_die "origin evidence is missing for $task_id"
[[ -f "$state_file" ]] || automation_die "state is missing for $task_id"
[[ -f "$transitions_file" ]] || automation_die "transition evidence is missing for $task_id"

automation_acquire_run_lock "$task_id"
trap 'automation_release_run_lock' EXIT

[[ "$(automation_read_state "$task_id")" == "BLOCKED" ]] || automation_die "$task_id is not BLOCKED"

source_root="$(jq -er '.sourceRoot' "$workspace_file")"
task_root="$(automation_workspace_task_root "$workspace_file")"
workspace_strategy="$(automation_workspace_strategy "$workspace_file")"
original_branch="$(jq -er '.originalBranch' "$workspace_file")"
task_branch="$(jq -er '.taskBranch' "$workspace_file")"
baseline_head="$(jq -er '.baselineHead' "$workspace_file")"

[[ "$(jq -r '.repositoryLeaseRequired // false' "$workspace_file")" == "true" ]] || \
    automation_die "baseline recovery requires a leased transactional workspace"
[[ -d "$task_root" ]] || automation_die "task root is missing: $task_root"
automation_require_repository_lease "$task_id" "$source_root" "$workspace_strategy"
task_root="$(cd "$task_root" && pwd -P)"
source_root="$(cd "$source_root" && pwd -P)"
[[ "$source_root" == "$AUTOMATION_ROOT" ]] || automation_die "workspace sourceRoot does not match this repository"
[[ "$(jq -er '.sourceRoot' "$origin_file")" == "$source_root" ]] || automation_die "origin sourceRoot does not match workspace metadata"
[[ "$(jq -er '.originalBranch' "$origin_file")" == "$original_branch" ]] || automation_die "origin branch does not match workspace metadata"
[[ "$(automation_current_branch "$task_root")" == "$task_branch" ]] || automation_die "task branch changed"
[[ "$(git -C "$task_root" rev-parse HEAD)" == "$baseline_head" ]] || automation_die "task HEAD changed before baseline sealing"
git -C "$source_root" show-ref --verify --quiet "refs/heads/$original_branch" || automation_die "recorded original branch no longer exists"
[[ "$(git -C "$source_root" rev-parse "refs/heads/$original_branch")" == "$baseline_head" ]] || automation_die "original branch drifted after task preparation"

for sealed_evidence in baseline.json red.json ready.json review.json reviews.jsonl; do
    [[ ! -e "$evidence_dir/$sealed_evidence" ]] || \
        automation_die "$sealed_evidence already exists; baseline-only recovery is forbidden"
done

state_revision="$(jq -er '.revision' "$state_file")"
if ! jq -s -e --argjson revision "$state_revision" '
    length == $revision and
    length >= 2 and
    .[-2].from == "PENDING" and
    .[-2].to == "CODING" and
    .[-2].actor == "coder-launcher" and
    .[-2].note == "preflight passed; capturing baseline" and
    .[-1].from == "CODING" and
    .[-1].to == "BLOCKED" and
    (.[-1].actor == "coder" or .[-1].actor == "preflight" or .[-1].actor == "orchestrator") and
    (.[-1].note | test("baseline|claim|基线"; "i"))
' "$transitions_file" >/dev/null; then
    automation_die "BLOCKED state is not a recoverable baseline-capture interruption"
fi

automation_assert_planning_artifacts_sealed "$task_id" "$task_root"
changed_paths=()
while IFS= read -r path; do
    [[ -n "$path" ]] && changed_paths+=("$path")
done < <(automation_changed_paths_at "$task_root")
[[ "${#changed_paths[@]}" -eq 2 ]] || automation_die "baseline recovery requires exactly the sealed plan and contract changes"
for path in "${changed_paths[@]}"; do
    automation_is_planning_artifact "$task_id" "$path" || automation_die "product or unrelated change blocks baseline recovery: $path"
    if git -C "$task_root" ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
        automation_die "planning artifact became tracked before baseline recovery: $path"
    fi
done

restart_count=0
if [[ -f "$resumptions_file" ]]; then
    restart_count="$(jq -s --arg taskId "$task_id" '[.[] | select(.taskId == $taskId)] | length' "$resumptions_file")"
fi
max_restarts=1
[[ "$restart_count" -lt "$max_restarts" ]] || automation_die "baseline restart limit exhausted"
next_restart=$((restart_count + 1))
blocked_revision="$state_revision"
current_diff_sha="$(automation_worktree_diff_sha "$task_root")"

jq -nc \
    --arg taskId "$task_id" \
    --arg kind "resume-baseline" \
    --arg at "$(automation_now)" \
    --arg diffSha256 "$current_diff_sha" \
    --argjson blockedRevision "$blocked_revision" \
    '{taskId: $taskId, kind: $kind, at: $at,
      blockedRevision: $blockedRevision, diffSha256: $diffSha256}' \
    | automation_append_json "$(automation_approvals_path "$task_id")"

automation_transition_state \
    "$task_id" \
    "BLOCKED" \
    "PENDING" \
    "human" \
    "baseline-only recovery $next_restart/$max_restarts; no product diff and baseline evidence absent"

jq -nc \
    --arg taskId "$task_id" \
    --arg at "$(automation_now)" \
    --arg diffSha256 "$current_diff_sha" \
    --argjson blockedRevision "$blocked_revision" \
    --argjson restart "$next_restart" \
    --argjson maxRestarts "$max_restarts" \
    '{taskId: $taskId, at: $at, blockedRevision: $blockedRevision,
      diffSha256: $diffSha256, restart: $restart,
      maxRestarts: $maxRestarts, route: "BLOCKED->PENDING",
      baselineEvidencePresent: false, productDiffPresent: false}' \
    | automation_append_json "$resumptions_file"

automation_info "$task_id baseline-only recovery accepted; restarting deterministic claim flow"
automation_release_run_lock
trap - EXIT

"$SCRIPT_DIR/orchestrate-task.sh" "$task_id"
