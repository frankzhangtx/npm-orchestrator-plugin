#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
automation_require_layout

contract="$(automation_contract_path "$task_id")"
state_file="$(automation_state_path "$task_id")"
workspace_file="$(automation_workspace_path "$task_id")"
origin_file="$(automation_origin_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"

if [[ "${2:-}" == "--evidence" ]]; then
    exec node "$AUTOMATION_DIR/verification/status.cjs" "$AUTOMATION_ROOT" "$AUTOMATION_RUNTIME_ROOT" "$task_id" "${@:2}"
fi
[[ "$#" -eq 1 ]] || automation_die "unexpected status arguments"
workspace_json="$(if [[ -f "$workspace_file" ]]; then jq -c . "$workspace_file"; else printf 'null'; fi)"

current_diff_sha=""
effective_worktree_allowlist_json='[]'
lease_json=null
lease_matches=null
original_head_current=""
original_branch_drifted=null
task_branch_exists=null
if [[ "$workspace_json" != "null" ]]; then
    task_root="$(jq -r '.taskRoot // .taskWorktree // empty' <<< "$workspace_json")"
    if [[ -n "$task_root" && -d "$task_root" ]]; then
        effective_worktree_allowlist_json="$(automation_effective_worktree_allowlist_json_at "$task_root")"
        current_diff_sha="$(automation_worktree_diff_sha "$task_root")"
    fi
    source_root="$(jq -r '.sourceRoot // empty' <<< "$workspace_json")"
    original_branch="$(jq -r '.originalBranch // empty' <<< "$workspace_json")"
    task_branch="$(jq -r '.taskBranch // empty' <<< "$workspace_json")"
    baseline_head="$(jq -r '.baselineHead // empty' <<< "$workspace_json")"
    if [[ -n "$source_root" && -n "$task_branch" ]]; then
        if git -C "$source_root" show-ref --verify --quiet "refs/heads/$task_branch"; then
            task_branch_exists=true
        else
            task_branch_exists=false
        fi
    fi
    if [[ -n "$source_root" && -n "$original_branch" ]] && \
       git -C "$source_root" show-ref --verify --quiet "refs/heads/$original_branch"; then
        original_head_current="$(git -C "$source_root" rev-parse "refs/heads/$original_branch")"
        if [[ -n "$baseline_head" && "$original_head_current" != "$baseline_head" ]]; then
            original_branch_drifted=true
        else
            original_branch_drifted=false
        fi
    fi
    if [[ "$(jq -r '.repositoryLeaseRequired // false' <<< "$workspace_json")" == "true" ]]; then
        lease_file="$(automation_repository_lease_dir)/lease.json"
        if [[ -f "$lease_file" ]]; then
            lease_json="$(jq -c . "$lease_file")"
            if jq -e \
                --arg taskId "$task_id" \
                --arg sourceRoot "$source_root" \
                --arg strategy "$(jq -r '.workspaceStrategy' <<< "$workspace_json")" \
                '.taskId == $taskId and .sourceRoot == $sourceRoot and .workspaceStrategy == $strategy' \
                "$lease_file" >/dev/null; then
                lease_matches=true
            else
                lease_matches=false
            fi
        else
            lease_matches=false
        fi
    fi
fi

[[ -f "$contract" ]] || automation_die "contract not found: $contract"
jq -nc \
    --argjson repositoryLease "$lease_json" \
    --argjson repositoryLeaseMatches "$lease_matches" \
    --argjson taskBranchExists "$task_branch_exists" \
    --argjson effectiveWorktreeAllowlist "$effective_worktree_allowlist_json" \
    --arg originalHeadCurrent "$original_head_current" \
    --argjson originalBranchDrifted "$original_branch_drifted" \
    --arg currentDiffSha256 "$current_diff_sha" \
    '{currentDiffSha256: $currentDiffSha256, runtime: {
        repositoryLease: $repositoryLease,
        repositoryLeaseMatches: $repositoryLeaseMatches,
        taskBranchExists: $taskBranchExists,
        effectiveWorktreeAllowlist: $effectiveWorktreeAllowlist,
        originalHeadCurrent: ($originalHeadCurrent | if length == 0 then null else . end),
        originalBranchDrifted: $originalBranchDrifted
    }}' | node "$AUTOMATION_DIR/verification/status.cjs" "$AUTOMATION_ROOT" "$AUTOMATION_RUNTIME_ROOT" "$task_id"
