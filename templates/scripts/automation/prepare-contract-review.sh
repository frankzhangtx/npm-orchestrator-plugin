#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
approval="${2:-}"
if [[ "$#" -ne 2 ]]; then
    printf 'Usage: %s TASK-ID "PROPOSAL-APPROVAL"\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
automation_require_orchestrated
automation_require_approval proposal "$approval"
automation_assert_repository_lease_available "$task_id"
"$SCRIPT_DIR/validate-contract.sh" "$task_id" >/dev/null

contract="$(automation_contract_path "$task_id")"
contract_rel="automation/tasks/$task_id.json"
plan_rel="$(jq -er '.planPath' "$contract")"
plan="$AUTOMATION_ROOT/$plan_rel"
state_file="$(automation_state_path "$task_id")"
origin_file="$(automation_origin_path "$task_id")"

changed_paths=()
while IFS= read -r path; do
    [[ -n "$path" ]] && changed_paths+=("$path")
done < <(automation_changed_paths)
if [[ "${#changed_paths[@]}" -ne 2 ]] || \
   [[ " ${changed_paths[*]} " != *" $contract_rel "* ]] || \
   [[ " ${changed_paths[*]} " != *" $plan_rel "* ]]; then
    automation_die "before contract review, the only changed paths must be $plan_rel and $contract_rel"
fi
for planning_path in "$plan_rel" "$contract_rel"; do
    if git -C "$AUTOMATION_ROOT" ls-files --error-unmatch -- "$planning_path" >/dev/null 2>&1; then
        automation_die "planning artifact must be a new untracked file: $planning_path"
    fi
done

original_branch="$(automation_current_branch)"
original_head="$(git -C "$AUTOMATION_ROOT" rev-parse HEAD)"
contract_sha="$(automation_file_sha256 "$contract")"
plan_sha="$(automation_file_sha256 "$plan")"

automation_acquire_run_lock "$task_id"
trap 'automation_release_run_lock' EXIT

if [[ -f "$state_file" ]]; then
    [[ "$(automation_read_state "$task_id")" == "CONTRACT_REVIEW" ]] || \
        automation_die "task already has runtime state: $(automation_read_state "$task_id")"
    [[ -f "$origin_file" ]] || automation_die "existing contract review has no origin evidence"
    jq -e \
        --arg root "$AUTOMATION_ROOT" \
        --arg branch "$original_branch" \
        --arg head "$original_head" \
        --arg contractSha "$contract_sha" \
        --arg planSha "$plan_sha" \
        '.sourceRoot == $root and .originalBranch == $branch and
         .originalHeadBeforeContract == $head and
         .contractSha256 == $contractSha and .planSha256 == $planSha' \
        "$origin_file" >/dev/null || automation_die "contract review artifacts changed; create a new task ID"
    automation_info "$task_id is already waiting for contract review"
    "$SCRIPT_DIR/status.sh" "$task_id"
    exit 0
fi

automation_ensure_runtime_layout
mkdir -p "$(automation_evidence_path "$task_id")"
jq -n \
    --arg taskId "$task_id" \
    --arg sourceRoot "$AUTOMATION_ROOT" \
    --arg originalBranch "$original_branch" \
    --arg originalHeadBeforeContract "$original_head" \
    --arg contractPath "$contract_rel" \
    --arg planPath "$plan_rel" \
    --arg contractSha256 "$contract_sha" \
    --arg planSha256 "$plan_sha" \
    --arg preparedAt "$(automation_now)" \
    '{taskId: $taskId, sourceRoot: $sourceRoot, originalBranch: $originalBranch,
      originalHeadBeforeContract: $originalHeadBeforeContract,
      contractPath: $contractPath, planPath: $planPath,
      contractSha256: $contractSha256, planSha256: $planSha256,
      preparedAt: $preparedAt}' \
    | automation_record_json "$origin_file"

jq -nc \
    --arg taskId "$task_id" \
    --arg kind "proposal" \
    --arg at "$(automation_now)" \
    --arg contractSha256 "$contract_sha" \
    --arg planSha256 "$plan_sha" \
    '{taskId: $taskId, kind: $kind, at: $at,
      contractSha256: $contractSha256, planSha256: $planSha256}' \
    | automation_append_json "$(automation_approvals_path "$task_id")"

automation_initialize_state "$task_id" "CONTRACT_REVIEW" "planner" "proposal approved; generated artifacts await contract review"
automation_info "$task_id is ready for human contract review on $original_branch at $original_head"
"$SCRIPT_DIR/status.sh" "$task_id"
