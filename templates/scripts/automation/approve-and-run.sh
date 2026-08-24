#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
approval="${2:-}"
if [[ "$#" -ne 2 ]]; then
    printf 'Usage: %s TASK-ID "CONTRACT-APPROVAL"\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
automation_require_orchestrated
automation_require_approval contract "$approval"
"$SCRIPT_DIR/validate-contract.sh" "$task_id" >/dev/null
[[ "$(automation_read_state "$task_id")" == "CONTRACT_REVIEW" ]] || automation_die "$task_id is not awaiting contract review"

origin_file="$(automation_origin_path "$task_id")"
[[ -f "$origin_file" ]] || automation_die "origin evidence is missing"
source_root="$(jq -er '.sourceRoot' "$origin_file")"
original_branch="$(jq -er '.originalBranch' "$origin_file")"
original_head="$(jq -er '.originalHeadBeforeContract' "$origin_file")"
contract_rel="$(jq -er '.contractPath' "$origin_file")"
plan_rel="$(jq -er '.planPath' "$origin_file")"
contract="$source_root/$contract_rel"
plan="$source_root/$plan_rel"

[[ "$source_root" == "$AUTOMATION_ROOT" ]] || automation_die "approval must run from the recorded source worktree"
[[ "$(automation_current_branch "$source_root")" == "$original_branch" ]] || automation_die "original branch changed after contract review began"
[[ "$(git -C "$source_root" rev-parse HEAD)" == "$original_head" ]] || automation_die "original HEAD changed after contract review began"
[[ "$(automation_file_sha256 "$contract")" == "$(jq -er '.contractSha256' "$origin_file")" ]] || automation_die "contract changed after proposal approval"
[[ "$(automation_file_sha256 "$plan")" == "$(jq -er '.planSha256' "$origin_file")" ]] || automation_die "plan changed after proposal approval"

changed_paths=()
while IFS= read -r path; do
    [[ -n "$path" ]] && changed_paths+=("$path")
done < <(automation_changed_paths_at "$source_root")
if [[ "${#changed_paths[@]}" -ne 2 ]] || \
   [[ " ${changed_paths[*]} " != *" $contract_rel "* ]] || \
   [[ " ${changed_paths[*]} " != *" $plan_rel "* ]]; then
    automation_die "contract approval requires exactly the sealed plan and contract changes"
fi
for planning_path in "$plan_rel" "$contract_rel"; do
    if git -C "$source_root" ls-files --error-unmatch -- "$planning_path" >/dev/null 2>&1; then
        automation_die "planning artifact must remain a new untracked file until the combined task commit: $planning_path"
    fi
done

automation_require_command git
automation_require_command jq
automation_require_command shasum
if [[ "${AUTOMATION_TEST_MODE:-0}" != "1" ]]; then
    automation_require_command opencode
    [[ -n "${ANDROID_HOME:-}" ]] || automation_die "ANDROID_HOME is not set; export it before approving the contract"
    [[ -d "$ANDROID_HOME" ]] || automation_die "ANDROID_HOME does not exist: $ANDROID_HOME"
fi
git -C "$source_root" config user.name >/dev/null || automation_die "Git user.name is not configured"
git -C "$source_root" config user.email >/dev/null || automation_die "Git user.email is not configured"

workspace_strategy="$(automation_config_value '.workspaceStrategy')"
worktree_base=""
task_slug="$(tr '[:upper:]' '[:lower:]' <<< "$task_id")"
task_branch="$(automation_task_branch "$task_id")"
task_root="$source_root"
if [[ "$workspace_strategy" == "isolatedWorktree" ]]; then
    worktree_base="$(automation_worktree_base)"
    task_root="$worktree_base/$task_slug"
    [[ ! -e "$task_root" ]] || automation_die "task worktree path already exists: $task_root"
fi
if git -C "$source_root" show-ref --verify --quiet "refs/heads/$task_branch"; then
    automation_die "task branch already exists: $task_branch"
fi

automation_acquire_run_lock "$task_id"
preparation_complete=0
lease_acquired=0
workspace_materialized=0
approval_exit() {
    local exit_code=$?
    trap - EXIT
    if [[ "$preparation_complete" != "1" ]] && [[ -f "$(automation_state_path "$task_id")" ]] && \
       [[ "$(automation_read_state "$task_id" 2>/dev/null || true)" == "PREPARING" ]]; then
        automation_transition_state "$task_id" "PREPARING" "BLOCKED" "orchestrator" "task workspace preparation failed" || true
    fi
    if [[ "$lease_acquired" == "1" && "$workspace_materialized" != "1" ]]; then
        automation_release_repository_lease "$task_id" || true
    fi
    automation_release_run_lock
    exit "$exit_code"
}
trap approval_exit EXIT

automation_acquire_repository_lease "$task_id" "$source_root" "$workspace_strategy"
lease_acquired=1

jq -nc \
    --arg taskId "$task_id" \
    --arg kind "contract" \
    --arg at "$(automation_now)" \
    --arg originalBranch "$original_branch" \
    --arg originalHead "$original_head" \
    --arg contractSha256 "$(automation_file_sha256 "$contract")" \
    '{taskId: $taskId, kind: $kind, at: $at, originalBranch: $originalBranch,
      originalHead: $originalHead, contractSha256: $contractSha256,
      planningArtifactsCommitPolicy: "withProductChanges"}' \
    | automation_append_json "$(automation_approvals_path "$task_id")"

baseline_head="$original_head"

jq \
    --arg approvedAt "$(automation_now)" \
    --arg baselineHead "$baseline_head" \
    '.approvedAt = $approvedAt |
     .baselineHead = $baselineHead |
     .planningArtifactsCommitPolicy = "withProductChanges" |
     .contractCommit = null' \
    "$origin_file" | automation_record_json "$origin_file"

automation_transition_state "$task_id" "CONTRACT_REVIEW" "APPROVED_CONTRACT" "human" "sealed contract explicitly approved"
automation_transition_state "$task_id" "APPROVED_CONTRACT" "PREPARING" "orchestrator" "preparing transactional task workspace"

if [[ "$workspace_strategy" == "inPlaceExclusive" ]]; then
    git -C "$source_root" switch -c "$task_branch" "$baseline_head"
else
    mkdir -p "$worktree_base"
    git -C "$source_root" worktree add "$task_root" -b "$task_branch" "$baseline_head"
    mkdir -p "$(dirname "$task_root/$plan_rel")" "$(dirname "$task_root/$contract_rel")"
    cp "$plan" "$task_root/$plan_rel"
    cp "$contract" "$task_root/$contract_rel"
    [[ "$(automation_file_sha256 "$task_root/$plan_rel")" == "$(jq -er '.planSha256' "$origin_file")" ]] || \
        automation_die "isolated task plan transfer changed its sealed content"
    [[ "$(automation_file_sha256 "$task_root/$contract_rel")" == "$(jq -er '.contractSha256' "$origin_file")" ]] || \
        automation_die "isolated task contract transfer changed its sealed content"
    rm -f "$plan" "$contract"
    automation_worktree_is_clean "$source_root" || automation_die "source worktree is not clean after moving planning artifacts to the isolated task root"
fi
workspace_materialized=1
automation_assert_planning_artifacts_sealed "$task_id" "$task_root"
materialized_paths=()
while IFS= read -r path; do
    [[ -n "$path" ]] && materialized_paths+=("$path")
done < <(automation_changed_paths_at "$task_root")
if [[ "${#materialized_paths[@]}" -ne 2 ]] || \
   [[ " ${materialized_paths[*]} " != *" $contract_rel "* ]] || \
   [[ " ${materialized_paths[*]} " != *" $plan_rel "* ]]; then
    automation_die "prepared task root must contain only the sealed, uncommitted plan and contract"
fi
workspace_file="$(automation_workspace_path "$task_id")"
jq -n \
    --arg taskId "$task_id" \
    --arg sourceRoot "$source_root" \
    --arg originalBranch "$original_branch" \
    --arg baselineHead "$baseline_head" \
    --arg workspaceStrategy "$workspace_strategy" \
    --arg taskRoot "$task_root" \
    --arg taskBranch "$task_branch" \
    --arg worktreeBase "$worktree_base" \
    --arg createdAt "$(automation_now)" \
    '{taskId: $taskId, sourceRoot: $sourceRoot, originalBranch: $originalBranch,
      baselineHead: $baselineHead, workspaceStrategy: $workspaceStrategy,
      taskRoot: $taskRoot, repositoryLeaseRequired: true,
      planningArtifactsCommitPolicy: "withProductChanges",
      taskBranch: $taskBranch, worktreeBase: $worktreeBase,
      codingCycle: 0, reviewCycles: 0, createdAt: $createdAt}' \
    | automation_record_json "$workspace_file"

automation_transition_state "$task_id" "PREPARING" "PENDING" "orchestrator" "$workspace_strategy task workspace prepared and queued"
preparation_complete=1
automation_release_run_lock
trap - EXIT

"$SCRIPT_DIR/orchestrate-task.sh" "$task_id"
