#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
approval="${2:-}"
if [[ "$#" -ne 2 ]]; then
    printf 'Usage: %s TASK-ID "ABORT-APPROVAL"\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
automation_require_orchestrated
automation_require_approval abort "$approval"

current_state="$(automation_read_state "$task_id")"
case "$current_state" in
    PREPARING|PENDING|CODING|READY_FOR_REVIEW|REVIEWING|CHANGES_REQUESTED|AWAITING_HUMAN|BLOCKED|TEST_FAILED|NEEDS_HUMAN|INTEGRATION_BLOCKED) ;;
    *) automation_die "cannot abort $task_id from state $current_state" ;;
esac

origin_file="$(automation_origin_path "$task_id")"
workspace_file="$(automation_workspace_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
[[ -f "$origin_file" && -f "$workspace_file" ]] || automation_die "abort metadata is incomplete for $task_id"

source_root="$(jq -er '.sourceRoot' "$origin_file")"
original_branch="$(jq -er '.originalBranch' "$origin_file")"
task_root="$(automation_workspace_task_root "$workspace_file")"
task_branch="$(jq -er '.taskBranch' "$workspace_file")"
workspace_strategy="$(automation_workspace_strategy "$workspace_file")"
contract="$(automation_contract_path "$task_id")"
original_ref="refs/heads/$original_branch"

[[ "$source_root" == "$AUTOMATION_ROOT" ]] || automation_die "abort must run from the recorded source root"
automation_require_repository_lease "$task_id" "$source_root" "$workspace_strategy"
git -C "$source_root" show-ref --verify --quiet "$original_ref" || automation_die "recorded original branch no longer exists"

product_commit="$(jq -r '.productCommit // ""' "$workspace_file")"
original_head="$(git -C "$source_root" rev-parse "$original_ref")"
if [[ -n "$product_commit" && "$original_head" == "$product_commit" ]]; then
    automation_die "the product commit is already on the original branch; finalize recovery instead of aborting"
fi

automation_acquire_run_lock "$task_id"
trap 'automation_release_run_lock' EXIT

recovery_commit=""
planning_only_archived_without_commit=false
: > "$evidence_dir/abort-status.txt"
: > "$evidence_dir/aborted.diff"
if [[ -d "$task_root" ]]; then
    task_current_branch="$(automation_current_branch "$task_root")"
    if [[ "$task_current_branch" == "$task_branch" ]]; then
        automation_assert_planning_artifacts_sealed "$task_id" "$task_root"
        changed_paths=()
        changed_path_count=0
        product_path_count=0
        changed_path_list="$(automation_changed_paths_at "$task_root")"
        while IFS= read -r path; do
            if [[ -n "$path" ]]; then
                changed_paths+=("$path")
                changed_path_count=$((changed_path_count + 1))
                if ! automation_is_planning_artifact "$task_id" "$path"; then
                    product_path_count=$((product_path_count + 1))
                fi
            fi
        done <<< "$changed_path_list"

        automation_worktree_status_at "$task_root" > "$evidence_dir/abort-status.txt"
        automation_worktree_patch_at "$task_root" > "$evidence_dir/aborted.diff"

        if [[ "$changed_path_count" -gt 0 ]]; then
            for path in "${changed_paths[@]}"; do
                if automation_is_planning_artifact "$task_id" "$path"; then
                    continue
                fi
                automation_array_matches_path "$contract" '.allowedPaths' "$path" || \
                    automation_die "abort refuses to archive an out-of-contract path: $path"
                if automation_array_matches_path "$contract" '.forbiddenPaths' "$path" || \
                   automation_array_matches_path "$AUTOMATION_CONFIG" '.protectedPaths' "$path"; then
                    automation_die "abort refuses to archive a protected path: $path"
                fi
            done
            if [[ "$product_path_count" -gt 0 ]]; then
                git -C "$task_root" add -- "${changed_paths[@]}"
                git -C "$task_root" commit --only -m "Archive aborted work for $task_id" -- "${changed_paths[@]}"
                recovery_commit="$(git -C "$task_root" rev-parse HEAD)"
            else
                plan_rel="$(jq -er '.planPath' "$origin_file")"
                contract_rel="$(jq -er '.contractPath' "$origin_file")"
                for planning_path in "$plan_rel" "$contract_rel"; do
                    if git -C "$task_root" ls-files --error-unmatch -- "$planning_path" >/dev/null 2>&1; then
                        automation_die "abort refuses to discard a tracked planning artifact without product changes: $planning_path"
                    fi
                    rm -f "$task_root/$planning_path"
                done
                planning_only_archived_without_commit=true
            fi
        fi
        if [[ "$changed_path_count" -eq 0 ]]; then
            recovery_commit="$(git -C "$task_root" rev-parse HEAD)"
        fi
        automation_worktree_is_clean "$task_root" || automation_die "task root is not clean after archival"
    elif [[ "$workspace_strategy" == "inPlaceExclusive" && "$task_current_branch" == "$original_branch" ]]; then
        automation_worktree_is_clean "$source_root" || automation_die "source root is dirty after a partial abort; manual recovery is required"
        recovery_commit="$(git -C "$source_root" rev-parse "refs/heads/$task_branch")"
    else
        automation_die "task root is on unexpected branch $task_current_branch"
    fi
else
    [[ "$workspace_strategy" == "isolatedWorktree" ]] || automation_die "in-place task root is missing"
    recovery_commit="$(git -C "$source_root" rev-parse "refs/heads/$task_branch")"
fi

if [[ "$workspace_strategy" == "inPlaceExclusive" ]]; then
    if [[ "$(automation_current_branch "$source_root")" == "$task_branch" ]]; then
        git -C "$source_root" switch "$original_branch"
    fi
    [[ "$(automation_current_branch "$source_root")" == "$original_branch" ]] || automation_die "source root did not return to the original branch"
elif [[ -d "$task_root" ]]; then
    cleanup_log="$evidence_dir/cleanup.log"
    git -C "$source_root" worktree remove "$task_root" >> "$cleanup_log" 2>&1
    printf '%s removed aborted isolated task worktree %s\n' "$(automation_now)" "$task_root" >> "$cleanup_log"
fi

jq -n \
    --arg taskId "$task_id" \
    --arg abortedAt "$(automation_now)" \
    --arg previousState "$current_state" \
    --arg originalBranch "$original_branch" \
    --arg originalHead "$(git -C "$source_root" rev-parse "$original_ref")" \
    --arg taskBranch "$task_branch" \
    --arg recoveryCommit "$recovery_commit" \
    --arg workspaceStrategy "$workspace_strategy" \
    --arg archivedDiffSha256 "$(automation_file_sha256 "$evidence_dir/aborted.diff")" \
    --argjson planningOnlyArchivedWithoutCommit "$planning_only_archived_without_commit" \
    '{taskId: $taskId, abortedAt: $abortedAt, previousState: $previousState,
      originalBranch: $originalBranch, originalHead: $originalHead,
      taskBranch: $taskBranch,
      recoveryCommit: ($recoveryCommit | if length == 0 then null else . end),
      workspaceStrategy: $workspaceStrategy,
      planningOnlyArchivedWithoutCommit: $planningOnlyArchivedWithoutCommit,
      archivedDiffSha256: $archivedDiffSha256, pushed: false}' \
    | automation_record_json "$evidence_dir/abort.json"

jq -nc \
    --arg taskId "$task_id" \
    --arg kind "abort" \
    --arg at "$(automation_now)" \
    --arg previousState "$current_state" \
    --arg originalBranch "$original_branch" \
    --arg recoveryCommit "$recovery_commit" \
    '{taskId: $taskId, kind: $kind, at: $at,
      previousState: $previousState, originalBranch: $originalBranch,
      recoveryCommit: ($recoveryCommit | if length == 0 then null else . end)}' \
    | automation_append_json "$(automation_approvals_path "$task_id")"

automation_transition_state "$task_id" "$current_state" "ABORTED" "human" "human aborted the task after deterministic archival"
automation_release_repository_lease "$task_id"
automation_release_run_lock
trap - EXIT
jq . "$evidence_dir/abort.json"
