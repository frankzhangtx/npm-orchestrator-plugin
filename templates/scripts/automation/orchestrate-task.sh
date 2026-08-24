#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ "$#" -eq 1 ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
automation_require_orchestrated

workspace_file="$(automation_workspace_path "$task_id")"
[[ -f "$workspace_file" ]] || automation_die "workspace metadata is missing for $task_id"
task_root="$(automation_workspace_task_root "$workspace_file")"
workspace_strategy="$(automation_workspace_strategy "$workspace_file")"
source_root="$(jq -er '.sourceRoot' "$workspace_file")"
[[ -d "$task_root" ]] || automation_die "task root is missing: $task_root"
if [[ "$(jq -r '.repositoryLeaseRequired // false' "$workspace_file")" == "true" ]]; then
    automation_require_repository_lease "$task_id" "$source_root" "$workspace_strategy"
fi

automation_acquire_run_lock "$task_id"
trap 'automation_release_run_lock' EXIT

if [[ "${AUTOMATION_SKIP_AGENT_RUN:-0}" == "1" ]]; then
    [[ "${AUTOMATION_TEST_MODE:-0}" == "1" ]] || automation_die "AUTOMATION_SKIP_AGENT_RUN is reserved for tests"
    automation_info "test mode: task is prepared; agent launch skipped"
    exit 0
fi
automation_require_command opencode

run_agent() {
    local role="$1"
    local prompt="$2"
    local cycle="$3"
    local attempt="${4:-0}"
    local log_file exit_code
    if [[ "$attempt" -eq 0 ]]; then
        log_file="$(automation_evidence_path "$task_id")/${role}-cycle-${cycle}.log"
    else
        log_file="$(automation_evidence_path "$task_id")/${role}-cycle-${cycle}-attempt-${attempt}.log"
    fi
    automation_info "starting $role for $task_id in $task_root"
    set +e
    (
        cd "$task_root"
        opencode run --agent "$role" -- "$prompt"
    ) 2>&1 | tee "$log_file"
    exit_code=${PIPESTATUS[0]}
    set -e
    jq -nc \
        --arg taskId "$task_id" \
        --arg role "$role" \
        --argjson cycle "$cycle" \
        --argjson attempt "$attempt" \
        --arg at "$(automation_now)" \
        --argjson exitCode "$exit_code" \
        '{taskId: $taskId, role: $role, cycle: $cycle, attempt: $attempt, at: $at, exitCode: $exitCode}' \
        | automation_append_json "$(automation_evidence_path "$task_id")/agent-runs.jsonl"
    return "$exit_code"
}

for _step in 1 2 3 4 5 6 7 8; do
    state="$(automation_read_state "$task_id")"
    case "$state" in
        PENDING|CODING)
            coding_cycle="$(jq -er '.codingCycle // 0' "$workspace_file")"
            coder_prompt="Use \$scheduled-quality-coder with $task_id. This is an orchestrated non-interactive run. Follow the deterministic state and evidence scripts. Never commit, merge, create worktrees, or push."
            run_agent scheduled-coder "$coder_prompt" "$coding_cycle" || true
            next_state="$(automation_read_state "$task_id")"
            if [[ "$next_state" == "PENDING" || "$next_state" == "CODING" ]]; then
                automation_transition_state "$task_id" "$next_state" "BLOCKED" "orchestrator" "coder exited without reaching a terminal gate state"
            fi
            ;;
        READY_FOR_REVIEW)
            (
                cd "$task_root"
                ./scripts/automation/begin-review.sh "$task_id"
            )
            ;;
        REVIEWING)
            review_cycle="$(jq -er '.reviewCycles // 0' "$workspace_file")"
            agent_runs="$(automation_evidence_path "$task_id")/agent-runs.jsonl"
            review_attempt=0
            if [[ -f "$agent_runs" ]]; then
                review_attempt="$(jq -s --argjson cycle "$review_cycle" '[.[] | select(.role == "scheduled-reviewer" and .cycle == $cycle)] | length' "$agent_runs")"
            fi
            reviewer_prompt="Use \$scheduled-quality-reviewer with $task_id. This is fresh, non-interactive, read-only review attempt $review_attempt for sealed review cycle $review_cycle. Work within the step budget. Run exactly ./scripts/automation/status.sh $task_id once; its JSON already includes baseline, RED, ready, latest gate, current diff SHA, and the sealed-SHA comparison, so do not browse the external evidence directory. Then inspect the approved contract and run exactly git diff. Submit exactly one decision. Do not browse generated build reports, list the whole repository, retry denied command variants, or run Gradle commands separately before deciding: submit-review.sh performs and records the focused tests, full unit suite, assembleDebug, and lint for APPROVED. Reserve a tool call for submit-review.sh. Never edit, commit, merge, or push."
            run_agent scheduled-reviewer "$reviewer_prompt" "$review_cycle" "$review_attempt" || true
            if [[ "$(automation_read_state "$task_id")" == "REVIEWING" ]]; then
                automation_transition_state "$task_id" "REVIEWING" "BLOCKED" "orchestrator" "reviewer exited without submitting a decision; sealed diff preserved for reviewer-only recovery"
            fi
            ;;
        CHANGES_REQUESTED)
            (
                cd "$task_root"
                ./scripts/automation/resume-review-fix.sh "$task_id"
            ) || true
            ;;
        AWAITING_HUMAN)
            automation_info "$task_id reached AWAITING_HUMAN"
            (
                cd "$task_root"
                ./scripts/automation/acceptance-report.sh "$task_id" >/dev/null
            )
            "$SCRIPT_DIR/show-acceptance-review.sh" "$task_id"
            exit 0
            ;;
        BLOCKED|TEST_FAILED|NEEDS_HUMAN|INTEGRATION_BLOCKED)
            automation_die "$task_id stopped in $state; inspect $(automation_evidence_path "$task_id")"
            ;;
        *)
            automation_die "cannot orchestrate $task_id from state $state"
            ;;
    esac
done

automation_die "$task_id exceeded the deterministic orchestration step bound"
