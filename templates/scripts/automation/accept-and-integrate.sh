#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
approval="${2:-}"
if [[ "$#" -ne 2 ]]; then
    printf 'Usage: %s TASK-ID "FINAL-ACCEPTANCE"\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
automation_require_orchestrated
automation_require_approval acceptance "$approval"
[[ "$(automation_read_state "$task_id")" == "AWAITING_HUMAN" ]] || automation_die "$task_id is not awaiting human acceptance"
[[ "$(automation_config_value '.pushAfterAcceptance')" == "false" ]] || automation_die "automatic push is forbidden"
[[ "$(automation_config_value '.originalBranchDriftPolicy')" == "block" ]] || automation_die "unsupported original branch drift policy"

origin_file="$(automation_origin_path "$task_id")"
workspace_file="$(automation_workspace_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
ready_file="$evidence_dir/ready.json"
review_file="$evidence_dir/review.json"
[[ -f "$origin_file" && -f "$workspace_file" && -f "$ready_file" && -f "$review_file" ]] || automation_die "integration evidence is incomplete"

source_root="$(jq -er '.sourceRoot' "$origin_file")"
original_branch="$(jq -er '.originalBranch' "$origin_file")"
baseline_head="$(jq -er '.baselineHead' "$workspace_file")"
task_root="$(automation_workspace_task_root "$workspace_file")"
task_branch="$(jq -er '.taskBranch' "$workspace_file")"
workspace_strategy="$(automation_workspace_strategy "$workspace_file")"
original_ref="refs/heads/$original_branch"
task_ref="refs/heads/$task_branch"

[[ "$source_root" == "$AUTOMATION_ROOT" ]] || automation_die "final acceptance must run from the recorded source root"
[[ -d "$task_root" ]] || automation_die "task root is missing: $task_root"
[[ "$task_branch" != "$original_branch" ]] || automation_die "task branch must differ from the recorded original branch"
git -C "$source_root" show-ref --verify --quiet "$task_ref" || automation_die "recorded task branch no longer exists: $task_branch"
[[ "$(automation_current_branch "$task_root")" == "$task_branch" ]] || automation_die "task branch identity changed"
[[ "$(git -C "$task_root" rev-parse HEAD)" == "$baseline_head" ]] || automation_die "task branch HEAD changed before deterministic commit"
automation_require_repository_lease "$task_id" "$source_root" "$workspace_strategy"

case "$workspace_strategy" in
    inPlaceExclusive)
        [[ "$task_root" == "$source_root" ]] || automation_die "in-place task root must equal the source root"
        ;;
    isolatedWorktree)
        [[ "$task_root" != "$source_root" ]] || automation_die "isolated task root must differ from the source root"
        [[ "$(automation_current_branch "$source_root")" == "$original_branch" ]] || automation_die "source root is no longer on $original_branch"
        automation_worktree_is_clean "$source_root" || automation_die "source root must be clean before integration"
        ;;
    *)
        automation_die "unsupported workspace strategy: $workspace_strategy"
        ;;
esac

git -C "$source_root" show-ref --verify --quiet "$original_ref" || automation_die "recorded original branch no longer exists: $original_branch"
source_head="$(git -C "$source_root" rev-parse "$original_ref")"
git -C "$source_root" merge-base --is-ancestor "$baseline_head" "$source_head" || automation_die "original branch no longer contains the recorded pre-task baseline"

automation_assert_planning_artifacts_sealed "$task_id" "$task_root"
sealed_diff_sha="$(automation_worktree_diff_sha "$task_root")"
[[ "$sealed_diff_sha" == "$(jq -er '.diffSha256' "$ready_file")" ]] || automation_die "task diff changed after quality gate"
[[ "$sealed_diff_sha" == "$(jq -er '.diffSha256' "$review_file")" ]] || automation_die "task diff changed after review"
[[ "$(jq -er '.decision' "$review_file")" == "APPROVED" ]] || automation_die "latest review is not approved"

(
    cd "$task_root"
    ./scripts/automation/scope-gate.sh "$task_id" >/dev/null
    ./scripts/automation/acceptance-report.sh "$task_id" >/dev/null
)
report_file="$evidence_dir/acceptance-report.json"
[[ "$(jq -er '.sealedDiffSha256' "$report_file")" == "$sealed_diff_sha" ]] || automation_die "acceptance report is stale"

automation_acquire_run_lock "$task_id"
integration_complete=0
integration_exit() {
    local exit_code=$?
    trap - EXIT
    if [[ "$integration_complete" != "1" ]] && [[ -f "$(automation_state_path "$task_id")" ]] && \
       [[ "$(automation_read_state "$task_id" 2>/dev/null || true)" == "INTEGRATING" ]]; then
        jq -n \
            --arg taskId "$task_id" \
            --arg failedAt "$(automation_now)" \
            --arg originalBranch "$original_branch" \
            --arg originalHead "$(git -C "$source_root" rev-parse "$original_ref" 2>/dev/null || true)" \
            --arg productCommit "$(jq -r '.productCommit // ""' "$workspace_file" 2>/dev/null || true)" \
            --argjson exitCode "$exit_code" \
            '{taskId: $taskId, failedAt: $failedAt, exitCode: $exitCode,
              originalBranch: $originalBranch, originalHead: $originalHead,
              productCommit: ($productCommit | if length == 0 then null else . end),
              message: "Integration stopped. Inspect the recorded refs before recovery; no automatic conflict resolution was attempted."}' \
            | automation_record_json "$evidence_dir/integration-failure.json" || true
        automation_transition_state "$task_id" "INTEGRATING" "INTEGRATION_BLOCKED" "integrator" "candidate verification or fast-forward failed" || true
    fi
    automation_release_run_lock
    exit "$exit_code"
}
trap integration_exit EXIT

jq -nc \
    --arg taskId "$task_id" \
    --arg kind "acceptance" \
    --arg at "$(automation_now)" \
    --arg originalBranch "$original_branch" \
    --arg sealedDiffSha256 "$sealed_diff_sha" \
    '{taskId: $taskId, kind: $kind, at: $at,
      originalBranch: $originalBranch, sealedDiffSha256: $sealedDiffSha256}' \
    | automation_append_json "$(automation_approvals_path "$task_id")"
jq -n \
    --arg taskId "$task_id" \
    --arg acceptedAt "$(automation_now)" \
    --arg originalBranch "$original_branch" \
    --arg sealedDiffSha256 "$sealed_diff_sha" \
    '{taskId: $taskId, acceptedAt: $acceptedAt,
      originalBranch: $originalBranch, sealedDiffSha256: $sealedDiffSha256}' \
    | automation_record_json "$evidence_dir/acceptance.json"

automation_transition_state "$task_id" "AWAITING_HUMAN" "INTEGRATING" "integrator" "human accepted the sealed diff for the recorded original branch"

product_paths=()
while IFS= read -r path; do
    [[ -n "$path" ]] && product_paths+=("$path")
done < <(automation_product_changed_paths_at "$task_id" "$task_root")
[[ "${#product_paths[@]}" -gt 0 ]] || automation_die "no product paths remain to commit with the planning artifacts"

commit_paths=()
while IFS= read -r path; do
    [[ -n "$path" ]] && commit_paths+=("$path")
done < <(automation_changed_paths_at "$task_root")
[[ "${#commit_paths[@]}" -ge 3 ]] || automation_die "final commit must contain product changes and both planning artifacts"
git -C "$task_root" add -- "${commit_paths[@]}"
title="$(jq -er '.title' "$task_root/automation/tasks/$task_id.json")"
git -C "$task_root" commit -m "Implement $title ($task_id)"
product_commit="$(git -C "$task_root" rev-parse HEAD)"
automation_worktree_is_clean "$task_root" || automation_die "task root is dirty after the combined task commit"
git -C "$task_root" merge-base --is-ancestor "$baseline_head" "$product_commit" || automation_die "combined task commit is not based on the recorded pre-task baseline"
[[ "$(git -C "$task_root" rev-list --count "$baseline_head..$product_commit")" -eq 1 ]] || \
    automation_die "task history must contain exactly one combined product-and-planning commit"

jq \
    --arg contractCommit "$product_commit" \
    --arg committedAt "$(automation_now)" \
    '.contractCommit = $contractCommit |
     .planningArtifactsCommittedWithProduct = true |
     .planningArtifactsCommittedAt = $committedAt' \
    "$origin_file" | automation_record_json "$origin_file"

jq \
    --arg productCommit "$product_commit" \
    --arg candidateHead "$product_commit" \
    --arg sourceHeadAtIntegration "$source_head" \
    --arg integrationMethod "$workspace_strategy-fast-forward" \
    --arg updatedAt "$(automation_now)" \
    '.productCommit = $productCommit |
     .candidateHead = $candidateHead |
     .sourceHeadAtIntegration = $sourceHeadAtIntegration |
     .integrationMethod = $integrationMethod |
     .updatedAt = $updatedAt' \
    "$workspace_file" | automation_record_json "$workspace_file"

[[ "$source_head" == "$baseline_head" ]] || automation_die "original branch drifted from $baseline_head to $source_head; policy requires manual resolution"
[[ "$(automation_file_sha256 "$task_root/automation/tasks/$task_id.json")" == "$(jq -er '.contractSha256' "$origin_file")" ]] || \
    automation_die "approved contract changed on the verified candidate"

set +e
(
    cd "$task_root"
    ./scripts/automation/verify-integration.sh "$task_id" "$baseline_head" "$product_commit"
) 2>&1 | tee "$evidence_dir/integration-verification.log"
verification_status=${PIPESTATUS[0]}
set -e
[[ "$verification_status" -eq 0 ]] || automation_die "integration verification failed with exit $verification_status"

[[ "$(git -C "$source_root" rev-parse "$original_ref")" == "$baseline_head" ]] || automation_die "original branch advanced during candidate verification"
if [[ "$workspace_strategy" == "inPlaceExclusive" ]]; then
    [[ "$(automation_current_branch "$source_root")" == "$task_branch" ]] || automation_die "in-place task branch changed during verification"
    git -C "$source_root" switch "$original_branch"
else
    [[ "$(automation_current_branch "$source_root")" == "$original_branch" ]] || automation_die "source branch changed during candidate verification"
    [[ "$(git -C "$source_root" rev-parse HEAD)" == "$baseline_head" ]] || automation_die "source HEAD changed during candidate verification"
    automation_worktree_is_clean "$source_root" || automation_die "source root became dirty during candidate verification"
fi

git -C "$source_root" merge --ff-only "$product_commit"
integrated_head="$(git -C "$source_root" rev-parse HEAD)"
[[ "$integrated_head" == "$product_commit" ]] || automation_die "original branch did not reach the verified combined task commit"
integration_method="$workspace_strategy-fast-forward"
cleanup_log="$evidence_dir/cleanup.log"
task_worktree_disposition="source-root-reused"

if [[ "$workspace_strategy" == "isolatedWorktree" ]]; then
    if [[ "$(automation_config_value '.autoCleanupWorktrees')" == "true" ]]; then
        git -C "$source_root" worktree remove "$task_root" >> "$cleanup_log" 2>&1 || \
            automation_die "could not remove isolated task worktree: $task_root"
        printf '%s removed isolated task worktree %s\n' "$(automation_now)" "$task_root" >> "$cleanup_log"
        task_worktree_disposition="removed"
    else
        git -C "$task_root" switch --detach "$product_commit" >> "$cleanup_log" 2>&1 || \
            automation_die "could not detach retained isolated task worktree: $task_root"
        printf '%s retained isolated task worktree in detached state at %s\n' \
            "$(automation_now)" "$product_commit" >> "$cleanup_log"
        task_worktree_disposition="retained-detached"
    fi
fi

[[ "$(git -C "$source_root" rev-parse "$task_ref")" == "$product_commit" ]] || \
    automation_die "task branch no longer points to the verified combined task commit"
[[ "$(automation_current_branch "$source_root")" == "$original_branch" ]] || \
    automation_die "source root must be on the original branch before task branch deletion"
git -C "$source_root" branch -d -- "$task_branch" >> "$cleanup_log" 2>&1 || \
    automation_die "could not safely delete integrated task branch: $task_branch"
if git -C "$source_root" show-ref --verify --quiet "$task_ref"; then
    automation_die "integrated task branch still exists after deletion: $task_branch"
fi
task_branch_deleted_at="$(automation_now)"
printf '%s deleted integrated local task branch %s at %s\n' \
    "$task_branch_deleted_at" "$task_branch" "$product_commit" >> "$cleanup_log"

jq \
    --arg taskBranchDeletedAt "$task_branch_deleted_at" \
    --arg taskWorktreeDisposition "$task_worktree_disposition" \
    --arg updatedAt "$(automation_now)" \
    '.taskBranchDeleted = true |
     .taskBranchDeletedAt = $taskBranchDeletedAt |
     .taskWorktreeDisposition = $taskWorktreeDisposition |
     .updatedAt = $updatedAt' \
    "$workspace_file" | automation_record_json "$workspace_file"

jq -n \
    --arg taskId "$task_id" \
    --arg integratedAt "$(automation_now)" \
    --arg originalBranch "$original_branch" \
    --arg sourceHeadBeforeIntegration "$source_head" \
    --arg productCommit "$product_commit" \
    --arg integratedHead "$integrated_head" \
    --arg method "$integration_method" \
    --arg workspaceStrategy "$workspace_strategy" \
    --arg taskBranch "$task_branch" \
    --arg taskBranchDeletedAt "$task_branch_deleted_at" \
    --arg taskWorktreeDisposition "$task_worktree_disposition" \
    --argjson verificationExitCode "$verification_status" \
    '{taskId: $taskId, integratedAt: $integratedAt,
      originalBranch: $originalBranch,
      sourceHeadBeforeIntegration: $sourceHeadBeforeIntegration,
      productCommit: $productCommit, integratedHead: $integratedHead,
      method: $method, workspaceStrategy: $workspaceStrategy,
      taskBranch: $taskBranch, taskBranchDeleted: true,
      taskBranchDeletedAt: $taskBranchDeletedAt,
      taskWorktreeDisposition: $taskWorktreeDisposition,
      verificationExitCode: $verificationExitCode, pushed: false}' \
    | automation_record_json "$evidence_dir/integration.json"

automation_transition_state "$task_id" "INTEGRATING" "COMPLETED" "integrator" "verified combined task commit fast-forwarded into the recorded original branch and the integrated local task branch was deleted; not pushed"
integration_complete=1

automation_release_repository_lease "$task_id"
automation_release_run_lock
trap - EXIT
jq . "$evidence_dir/integration.json"
