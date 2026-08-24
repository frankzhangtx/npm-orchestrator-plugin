#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
decision="${2:-}"
shift $(( $# >= 2 ? 2 : $# ))
summary="$*"

if [[ -z "$task_id" || -z "$decision" || -z "$summary" ]]; then
    printf 'Usage: %s TASK-ID APPROVED|CHANGES_REQUESTED SUMMARY\n' "$0" >&2
    exit 2
fi

automation_validate_task_id "$task_id"
[[ "$decision" == "APPROVED" || "$decision" == "CHANGES_REQUESTED" ]] || automation_die "invalid review decision: $decision"
[[ ${#summary} -ge 20 ]] || automation_die "review summary must contain at least 20 characters"
[[ "$(automation_read_state "$task_id")" == "REVIEWING" ]] || automation_die "$task_id is not REVIEWING"

evidence_dir="$(automation_evidence_path "$task_id")"
ready_meta="$evidence_dir/ready.json"
[[ -f "$ready_meta" ]] || automation_die "ready evidence is missing"
current_diff_sha="$(automation_worktree_diff_sha)"
ready_diff_sha="$(jq -er '.diffSha256' "$ready_meta")"

if [[ "$current_diff_sha" != "$ready_diff_sha" ]]; then
    decision="CHANGES_REQUESTED"
    summary="Diff changed after coder gate. $summary"
fi

review_log="$evidence_dir/review-verification.log"
verification_status=0
if [[ "$decision" == "APPROVED" ]]; then
    set +e
    "$SCRIPT_DIR/verify-task.sh" "$task_id" 2>&1 | tee "$review_log"
    verification_status=${PIPESTATUS[0]}
    set -e
    if [[ "$verification_status" -ne 0 ]]; then
        decision="CHANGES_REQUESTED"
        summary="Independent verification failed with exit $verification_status. $summary"
    fi
fi

jq -n \
    --arg taskId "$task_id" \
    --arg decision "$decision" \
    --arg summary "$summary" \
    --arg reviewedAt "$(automation_now)" \
    --arg diffSha256 "$current_diff_sha" \
    --argjson verificationExitCode "$verification_status" \
    '{taskId: $taskId, decision: $decision, summary: $summary, reviewedAt: $reviewedAt, diffSha256: $diffSha256, verificationExitCode: $verificationExitCode}' \
    | automation_record_json "$evidence_dir/review.json"
jq -nc \
    --arg taskId "$task_id" \
    --arg decision "$decision" \
    --arg summary "$summary" \
    --arg reviewedAt "$(automation_now)" \
    --arg diffSha256 "$current_diff_sha" \
    --argjson verificationExitCode "$verification_status" \
    '{taskId: $taskId, decision: $decision, summary: $summary, reviewedAt: $reviewedAt, diffSha256: $diffSha256, verificationExitCode: $verificationExitCode}' \
    | automation_append_json "$evidence_dir/reviews.jsonl"

if [[ "$decision" == "APPROVED" ]]; then
    automation_transition_state "$task_id" "REVIEWING" "AWAITING_HUMAN" "reviewer" "independent review approved; human acceptance required"
    automation_info "$task_id approved and awaiting human acceptance"
else
    automation_transition_state "$task_id" "REVIEWING" "CHANGES_REQUESTED" "reviewer" "$summary"
    automation_warn "$task_id requires changes"
    exit 1
fi
