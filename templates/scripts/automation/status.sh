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

state_json="$(if [[ -f "$state_file" ]]; then jq -c . "$state_file"; else printf 'null'; fi)"
workspace_json="$(if [[ -f "$workspace_file" ]]; then jq -c . "$workspace_file"; else printf 'null'; fi)"
origin_json="$(if [[ -f "$origin_file" ]]; then jq -c . "$origin_file"; else printf 'null'; fi)"
baseline_json="$(if [[ -f "$evidence_dir/baseline.json" ]]; then jq -c . "$evidence_dir/baseline.json"; else printf 'null'; fi)"
red_json="$(if [[ -f "$evidence_dir/red.json" ]]; then jq -c . "$evidence_dir/red.json"; else printf 'null'; fi)"
ready_json="$(if [[ -f "$evidence_dir/ready.json" ]]; then jq -c . "$evidence_dir/ready.json"; else printf 'null'; fi)"
review_json="$(if [[ -f "$evidence_dir/review.json" ]]; then jq -c . "$evidence_dir/review.json"; else printf 'null'; fi)"
gate_json=null
if [[ "$ready_json" != "null" ]]; then
    coding_cycle="$(jq -r '.codingCycle // 0' <<< "$ready_json")"
    gate_file="$evidence_dir/gate-attempts-cycle-$coding_cycle.json"
    if [[ -f "$gate_file" ]]; then
        gate_json="$(jq -c . "$gate_file")"
    fi
fi

current_diff_sha=""
lease_json=null
lease_matches=null
original_head_current=""
original_branch_drifted=null
task_branch_exists=null
if [[ "$workspace_json" != "null" ]]; then
    task_root="$(jq -r '.taskRoot // .taskWorktree // empty' <<< "$workspace_json")"
    if [[ -n "$task_root" && -d "$task_root" ]]; then
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
jq -n \
    --slurpfile contract "$contract" \
    --argjson state "$state_json" \
    --argjson workspace "$workspace_json" \
    --argjson origin "$origin_json" \
    --argjson baseline "$baseline_json" \
    --argjson red "$red_json" \
    --argjson ready "$ready_json" \
    --argjson gate "$gate_json" \
    --argjson review "$review_json" \
    --argjson repositoryLease "$lease_json" \
    --argjson repositoryLeaseMatches "$lease_matches" \
    --argjson taskBranchExists "$task_branch_exists" \
    --arg originalHeadCurrent "$original_head_current" \
    --argjson originalBranchDrifted "$original_branch_drifted" \
    --arg evidence "$evidence_dir" \
    --arg currentDiffSha256 "$current_diff_sha" \
    '{contract: $contract[0], state: $state, workspace: $workspace, origin: $origin,
      runtime: {
        repositoryLease: $repositoryLease,
        repositoryLeaseMatches: $repositoryLeaseMatches,
        taskBranchExists: $taskBranchExists,
        originalHeadCurrent: ($originalHeadCurrent | if length == 0 then null else . end),
        originalBranchDrifted: $originalBranchDrifted
      },
      evidenceDirectory: $evidence,
      evidence: {
        directory: $evidence,
        baseline: $baseline,
        red: $red,
        ready: $ready,
        latestGate: $gate,
        review: $review,
        currentDiffSha256: ($currentDiffSha256 | if length == 0 then null else . end),
        sealedDiffMatches: (if ($ready == null or ($currentDiffSha256 | length) == 0)
                            then null
                            else $ready.diffSha256 == $currentDiffSha256
                            end)
      }}'
