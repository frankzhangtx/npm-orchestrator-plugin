#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
automation_require_layout

[[ "$(automation_read_state "$task_id")" == "PENDING" ]] || automation_die "$task_id is not PENDING"
evidence_dir="$(automation_evidence_path "$task_id")"
mkdir -p "$evidence_dir"
preflight_log="$evidence_dir/preflight.log"
set +e
"$SCRIPT_DIR/preflight.sh" "$task_id" 2>&1 | tee "$preflight_log"
preflight_status=${PIPESTATUS[0]}
set -e
if [[ "$preflight_status" -ne 0 ]]; then
    automation_transition_state "$task_id" "PENDING" "BLOCKED" "preflight" "preflight failed with exit $preflight_status"
    automation_die "preflight failed; task moved to BLOCKED"
fi

automation_transition_state "$task_id" "PENDING" "CODING" "coder-launcher" "preflight passed; capturing baseline"

baseline_log="$evidence_dir/baseline.log"
baseline_meta="$evidence_dir/baseline.json"
protected_hashes="$evidence_dir/protected.sha256"
started_at="$(automation_now)"
head_commit="$(git -C "$AUTOMATION_ROOT" rev-parse HEAD)"

set +e
(
    cd "$AUTOMATION_ROOT"
    ./gradlew testDebugUnitTest
) 2>&1 | tee "$baseline_log"
baseline_status=${PIPESTATUS[0]}
set -e

if [[ "$baseline_status" -ne 0 ]]; then
    jq -n \
        --arg taskId "$task_id" \
        --arg startedAt "$started_at" \
        --arg finishedAt "$(automation_now)" \
        --arg head "$head_commit" \
        --argjson exitCode "$baseline_status" \
        '{taskId: $taskId, startedAt: $startedAt, finishedAt: $finishedAt, head: $head, command: "./gradlew testDebugUnitTest", exitCode: $exitCode}' \
        | automation_record_json "$baseline_meta"
    automation_transition_state "$task_id" "CODING" "BLOCKED" "preflight" "baseline unit tests failed"
    automation_die "baseline unit tests failed"
fi

: > "$protected_hashes"
while IFS= read -r tracked; do
    while IFS= read -r protected; do
        if automation_path_matches "$tracked" "$protected"; then
            shasum -a 256 "$AUTOMATION_ROOT/$tracked" >> "$protected_hashes"
            break
        fi
    done < <(jq -r '.protectedPaths[]' "$AUTOMATION_CONFIG")
done < <(git -C "$AUTOMATION_ROOT" ls-files)

jq -n \
    --arg taskId "$task_id" \
    --arg startedAt "$started_at" \
    --arg finishedAt "$(automation_now)" \
    --arg head "$head_commit" \
    --arg worktree "$AUTOMATION_ROOT" \
    '{taskId: $taskId, startedAt: $startedAt, finishedAt: $finishedAt, head: $head, worktree: $worktree, command: "./gradlew testDebugUnitTest", exitCode: 0}' \
    | automation_record_json "$baseline_meta"

automation_info "$task_id claimed; baseline is green"
