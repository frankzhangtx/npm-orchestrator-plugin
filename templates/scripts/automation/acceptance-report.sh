#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ "$#" -eq 1 ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
[[ "$(automation_read_state "$task_id")" == "AWAITING_HUMAN" ]] || automation_die "$task_id is not AWAITING_HUMAN"

contract="$(automation_contract_path "$task_id")"
workspace_file="$(automation_workspace_path "$task_id")"
origin_file="$(automation_origin_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
baseline_file="$evidence_dir/baseline.json"
red_file="$evidence_dir/red.json"
ready_file="$evidence_dir/ready.json"
review_file="$evidence_dir/review.json"
[[ -f "$workspace_file" && -f "$origin_file" && -f "$baseline_file" && -f "$red_file" && -f "$ready_file" && -f "$review_file" ]] || \
    automation_die "acceptance evidence is incomplete"
[[ "$(jq -er '.decision' "$review_file")" == "APPROVED" ]] || automation_die "latest independent review is not approved"
red_exit_code="$(jq -er '.exitCode' "$red_file")"
review_verification_exit_code="$(jq -er '.verificationExitCode' "$review_file")"
[[ "$red_exit_code" -ne 0 ]] || automation_die "RED evidence does not contain a failing test result"
[[ "$review_verification_exit_code" -eq 0 ]] || automation_die "independent review verification did not pass"

recorded_task_root="$(automation_workspace_task_root "$workspace_file")"
workspace_strategy="$(automation_workspace_strategy "$workspace_file")"
source_root="$(jq -er '.sourceRoot' "$workspace_file")"
original_branch="$(jq -er '.originalBranch' "$origin_file")"
baseline_head="$(jq -er '.baselineHead' "$workspace_file")"
original_head_current="$(git -C "$source_root" rev-parse "refs/heads/$original_branch")"
original_branch_drifted=false
if [[ "$original_head_current" != "$baseline_head" ]]; then
    original_branch_drifted=true
fi
[[ "$(cd "$recorded_task_root" && pwd)" == "$AUTOMATION_ROOT" ]] || automation_die "acceptance report must run in the recorded task root"
if [[ "$(jq -r '.repositoryLeaseRequired // false' "$workspace_file")" == "true" ]]; then
    automation_require_repository_lease "$task_id" "$source_root" "$workspace_strategy"
fi
current_diff_sha="$(automation_worktree_diff_sha)"
[[ "$current_diff_sha" == "$(jq -er '.diffSha256' "$ready_file")" ]] || automation_die "sealed diff changed after the quality gate"
[[ "$current_diff_sha" == "$(jq -er '.diffSha256' "$review_file")" ]] || automation_die "sealed diff changed after independent review"
automation_assert_planning_artifacts_sealed "$task_id" "$AUTOMATION_ROOT"

"$SCRIPT_DIR/scope-gate.sh" "$task_id" >/dev/null
changed_paths=()
while IFS= read -r path; do
    [[ -n "$path" ]] && changed_paths+=("$path")
done < <(automation_product_changed_paths_at "$task_id" "$AUTOMATION_ROOT")
changed_paths_json="$(printf '%s\n' "${changed_paths[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
planning_artifacts_json="$(jq -c '[.planPath, .contractPath]' "$origin_file")"
diff_stat="$(git -C "$AUTOMATION_ROOT" diff --stat HEAD --)"
untracked_paths="$(git -C "$AUTOMATION_ROOT" ls-files --others --exclude-standard | LC_ALL=C sort)"

sealed_diff="$evidence_dir/sealed.diff"
{
    git -C "$AUTOMATION_ROOT" diff --binary HEAD --
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        git -C "$AUTOMATION_ROOT" diff --binary --no-index -- /dev/null "$AUTOMATION_ROOT/$path" || [[ "$?" -eq 1 ]]
    done <<< "$untracked_paths"
} > "$sealed_diff"

report_file="$evidence_dir/acceptance-report.json"
jq -n \
    --arg taskId "$task_id" \
    --arg title "$(jq -er '.title' "$contract")" \
    --arg generatedAt "$(automation_now)" \
    --arg originalBranch "$original_branch" \
    --arg originalHeadBeforeContract "$(jq -er '.originalHeadBeforeContract' "$origin_file")" \
    --arg baselineHead "$baseline_head" \
    --arg originalHeadCurrent "$original_head_current" \
    --arg taskBranch "$(jq -er '.taskBranch' "$workspace_file")" \
    --arg workspaceStrategy "$workspace_strategy" \
    --arg taskRoot "$AUTOMATION_ROOT" \
    --arg sealedDiffSha256 "$current_diff_sha" \
    --arg diffStat "$diff_stat" \
    --arg sealedDiffPath "$sealed_diff" \
    --arg reviewSummary "$(jq -er '.summary' "$review_file")" \
    --arg testPolicy "$(jq -er '.testPolicy' "$contract")" \
    --arg testPolicyReason "$(jq -r '.testPolicyReason // "Not specified"' "$contract")" \
    --argjson maxChangedFiles "$(jq -er '.maxChangedFiles' "$contract")" \
    --argjson deviceTestsRequired "$(jq -r '.deviceTestsRequired' "$contract")" \
    --argjson redExitCode "$red_exit_code" \
    --argjson gateAttempts "$(jq -er '.gateAttempts' "$ready_file")" \
    --argjson codingCycle "$(jq -er '.codingCycle' "$ready_file")" \
    --argjson reviewVerificationExitCode "$review_verification_exit_code" \
    --argjson changedPaths "$changed_paths_json" \
    --argjson planningArtifacts "$planning_artifacts_json" \
    --argjson originalBranchDrifted "$original_branch_drifted" \
    --argjson allowedPaths "$(jq -c '.allowedPaths' "$contract")" \
    --argjson acceptanceCriteria "$(jq -c '.acceptanceCriteria' "$contract")" \
    --argjson nonGoals "$(jq -c '.nonGoals' "$contract")" \
    --argjson targetTests "$(jq -c '.targetTests' "$contract")" \
    '{taskId: $taskId, title: $title, state: "AWAITING_HUMAN",
      generatedAt: $generatedAt, originalBranch: $originalBranch,
      originalHeadBeforeContract: $originalHeadBeforeContract,
      baselineHead: $baselineHead, originalHeadCurrent: $originalHeadCurrent,
      originalBranchDrifted: $originalBranchDrifted, taskBranch: $taskBranch,
      taskBranchCleanupPolicy: "deleteAfterSuccessfulIntegration",
      workspaceStrategy: $workspaceStrategy, taskRoot: $taskRoot,
      sealedDiffSha256: $sealedDiffSha256,
      changedPaths: $changedPaths, maxChangedFiles: $maxChangedFiles,
      planningArtifacts: $planningArtifacts,
      planningArtifactsCommitPolicy: "withProductChanges",
      allowedPaths: $allowedPaths, diffStat: $diffStat,
      sealedDiffPath: $sealedDiffPath, acceptanceCriteria: $acceptanceCriteria,
      nonGoals: $nonGoals, targetTests: $targetTests,
      testPolicy: $testPolicy, testPolicyReason: $testPolicyReason,
      deviceTestsRequired: $deviceTestsRequired,
      evidence: {
        baselineRecorded: true,
        redRecorded: true,
        redExitCode: $redExitCode,
        qualityGate: "PASSED",
        gateAttempts: $gateAttempts,
        codingCycle: $codingCycle,
        reviewerDecision: "APPROVED",
        reviewerVerificationExitCode: $reviewVerificationExitCode
      },
      bindingChecks: {
        state: "VERIFIED",
        sealedDiffMatchesReady: true,
        sealedDiffMatchesReview: true
      },
      reviewSummary: $reviewSummary, pushed: false}' \
    | automation_record_json "$report_file"

jq . "$report_file"
