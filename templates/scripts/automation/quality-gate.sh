#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
[[ "$(automation_read_state "$task_id")" == "CODING" ]] || automation_die "$task_id is not CODING"
"$SCRIPT_DIR/validate-contract.sh" "$task_id" >/dev/null

contract="$(automation_contract_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
mkdir -p "$evidence_dir"
workspace_file="$(automation_workspace_path "$task_id")"
coding_cycle=0
if [[ -f "$workspace_file" ]]; then
    coding_cycle="$(jq -er '.codingCycle // 0' "$workspace_file")"
fi
attempt_file="$evidence_dir/gate-attempts-cycle-$coding_cycle.json"
previous_attempts=0
if [[ -f "$attempt_file" ]]; then
    previous_attempts="$(jq -er '.attempts' "$attempt_file")"
fi
attempt=$((previous_attempts + 1))
max_fix_loops="$(jq -r '.maxFixLoops' "$contract")"
max_attempts=$((max_fix_loops + 1))
[[ "$attempt" -le "$max_attempts" ]] || automation_die "quality gate attempt limit already exhausted"

attempt_log="$evidence_dir/gate-cycle-$coding_cycle-attempt-$attempt.log"
started_at="$(automation_now)"
set +e
"$SCRIPT_DIR/verify-task.sh" "$task_id" 2>&1 | tee "$attempt_log"
gate_status=${PIPESTATUS[0]}
set -e

jq -n \
    --arg taskId "$task_id" \
    --argjson attempts "$attempt" \
    --argjson codingCycle "$coding_cycle" \
    --argjson maxAttempts "$max_attempts" \
    --arg startedAt "$started_at" \
    --arg finishedAt "$(automation_now)" \
    --argjson exitCode "$gate_status" \
    '{taskId: $taskId, codingCycle: $codingCycle, attempts: $attempts, maxAttempts: $maxAttempts, lastStartedAt: $startedAt, lastFinishedAt: $finishedAt, lastExitCode: $exitCode}' \
    | automation_record_json "$attempt_file"

if [[ "$gate_status" -ne 0 ]]; then
    if [[ "$gate_status" -eq 40 || "$gate_status" -eq 41 ]]; then
        automation_transition_state "$task_id" "CODING" "BLOCKED" "quality-gate" "scope, integrity, or evidence gate failed with exit $gate_status"
    elif [[ "$attempt" -ge "$max_attempts" ]]; then
        automation_transition_state "$task_id" "CODING" "TEST_FAILED" "quality-gate" "verification failed after $attempt attempts"
    else
        automation_warn "verification failed; one systematic fix loop remains"
    fi
    exit "$gate_status"
fi

diff_sha="$(automation_worktree_diff_sha)"
jq -n \
    --arg taskId "$task_id" \
    --arg verifiedAt "$(automation_now)" \
    --arg head "$(git -C "$AUTOMATION_ROOT" rev-parse HEAD)" \
    --arg diffSha256 "$diff_sha" \
    --argjson attempts "$attempt" \
    --argjson codingCycle "$coding_cycle" \
    '{taskId: $taskId, verifiedAt: $verifiedAt, head: $head, diffSha256: $diffSha256, gateAttempts: $attempts, codingCycle: $codingCycle}' \
    | automation_record_json "$evidence_dir/ready.json"

automation_transition_state "$task_id" "CODING" "READY_FOR_REVIEW" "quality-gate" "G1-G6 passed with fresh evidence"
