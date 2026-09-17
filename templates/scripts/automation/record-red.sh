#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: %s TASK-ID [LEGACY-EXPECTED -- LEGACY-FILTER]\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
automation_require_queue_execution "$task_id"
[[ "$(automation_read_state "$task_id")" == "CODING" ]] || automation_die "$task_id is not CODING"
"$SCRIPT_DIR/validate-contract.sh" "$task_id"

contract="$(automation_contract_path "$task_id")"
schema_version="$(jq -er '.schemaVersion' "$contract")"
evidence_dir="$(automation_evidence_path "$task_id")"
mkdir -p "$evidence_dir"
red_meta="$evidence_dir/red.json"
[[ ! -e "$red_meta" ]] || automation_die "RED evidence already exists for $task_id"

# Preserve the exact V1/V2 behavior for already approved contracts.
if [[ "$schema_version" != "3" ]]; then
    expected="${2:-}"
    separator="${3:-}"
    filter="${4:-}"
    if [[ -z "$expected" || "$separator" != "--" || -z "$filter" || "$#" -ne 4 ]]; then
        printf 'Usage: %s TASK-ID EXPECTED-FAILURE-TEXT -- TEST-FILTER\n' "$0" >&2
        exit 2
    fi
    automation_validate_test_filter "$filter"
    [[ ${#expected} -ge 3 ]] || automation_die "expected failure text is too short"
    target_count="$(jq -er --arg filter "$filter" '[.targetTests[] | select(.filter == $filter)] | length' "$contract")"
    [[ "$target_count" -eq 1 ]] || automation_die "test filter must identify exactly one declared contract target: $filter"
    gradle_task="$(jq -er --arg filter "$filter" '.targetTests[] | select(.filter == $filter) | .gradleTask' "$contract")"
    red_log="$evidence_dir/red.log"
    started_at="$(automation_now)"
    set +e
    automation_run_focused_test "$gradle_task" "$filter" "$AUTOMATION_ROOT" 2>&1 | tee "$red_log"
    red_status=${PIPESTATUS[0]}
    set -e
    [[ "$red_status" -ne 0 ]] || automation_die "RED capture failed: focused test passed before implementation"
    rg -F "$expected" "$red_log" >/dev/null || automation_die "RED output does not contain the expected failure text"
    jq -n --arg taskId "$task_id" --arg startedAt "$started_at" --arg finishedAt "$(automation_now)" \
        --arg expectedFailure "$expected" --arg gradleTask "$gradle_task" --arg testFilter "$filter" \
        --argjson exitCode "$red_status" \
        '{taskId: $taskId, startedAt: $startedAt, finishedAt: $finishedAt,
          command: ["./gradlew", $gradleTask, "--tests", $testFilter],
          expectedFailure: $expectedFailure, exitCode: $exitCode}' | automation_record_json "$red_meta"
    automation_info "$task_id legacy RED evidence recorded"
    exit 0
fi

[[ "$#" -eq 1 ]] || { printf 'Schema V3 usage: %s TASK-ID\n' "$0" >&2; exit 2; }
"$SCRIPT_DIR/scope-gate.sh" "$task_id" >/dev/null

# RED must be captured before any production change. Planning artifacts are
# excluded; test sources and fixtures are the only permitted product changes.
while IFS= read -r changed_path; do
    [[ -n "$changed_path" ]] || continue
    if ! automation_array_matches_path "$AUTOMATION_CONFIG" '.androidProject.testPaths' "$changed_path"; then
        automation_die "RED preflight requires unchanged production code; non-test path changed: $changed_path"
    fi
done < <(automation_product_changed_paths_at "$task_id" "$AUTOMATION_ROOT")

previous_attempt=0
preflight_meta="$evidence_dir/test-preflight.json"
if [[ -f "$preflight_meta" ]]; then
    previous_attempt="$(jq -er '.attempt' "$preflight_meta")"
fi
attempt=$((previous_attempt + 1))
max_fixes="$(jq -er '.verification.maxPreparationFixes' "$contract")"
if [[ "$attempt" -gt $((max_fixes + 1)) ]]; then
    automation_die "test preparation retry budget exhausted; revise the contract or abort the task"
fi

attempt_id="$(printf '%03d' "$attempt")"
attempt_dir="$evidence_dir/attempts/red-preflight-$attempt_id"
mkdir -p "$attempt_dir"
observed_file="$attempt_dir/observed.jsonl"
: > "$observed_file"
execution_failures='[]'
started_at="$(automation_now)"
target_index=0
while IFS=$'\t' read -r gradle_task filter; do
    result_file="$attempt_dir/target-$target_index.jsonl"
    log_file="$attempt_dir/target-$target_index.log"
    set +e
    automation_run_classified_focused_test "$gradle_task" "$filter" "$AUTOMATION_ROOT" "$result_file" "$log_file"
    gradle_status=$?
    set -e
    if [[ "$gradle_status" -ne 0 ]]; then
        execution_failures="$(jq -nc --argjson current "$execution_failures" --argjson target "$target_index" \
            --arg task "$gradle_task" --arg filter "$filter" --argjson exitCode "$gradle_status" \
            '$current + [{target: $target, gradleTask: $task, filter: $filter, exitCode: $exitCode}]')"
    fi
    if [[ -s "$result_file" ]]; then
        while IFS= read -r result_line; do
            if ! jq -e . >/dev/null 2>&1 <<< "$result_line"; then
                execution_failures="$(jq -nc --argjson current "$execution_failures" --argjson target "$target_index" \
                    '$current + [{target: $target, reason: "invalid structured test output"}]')"
                continue
            fi
            jq -c --argjson target "$target_index" '. + {target: $target}' <<< "$result_line" >> "$observed_file"
        done < "$result_file"
    else
        execution_failures="$(jq -nc --argjson current "$execution_failures" --argjson target "$target_index" \
            '$current + [{target: $target, reason: "no structured test results"}]')"
    fi
    target_index=$((target_index + 1))
done < <(jq -r '.targetTests[] | [.gradleTask, .filter] | @tsv' "$contract")

contract_sha="$(automation_file_sha256 "$contract")"
baseline_head="$(jq -er '.head' "$evidence_dir/baseline.json")"
test_diff_sha="$(automation_test_diff_sha "$task_id" "$AUTOMATION_ROOT")"
finished_at="$(automation_now)"

jq -n \
    --slurpfile contract "$contract" \
    --slurpfile observed "$observed_file" \
    --arg taskId "$task_id" \
    --arg startedAt "$started_at" \
    --arg finishedAt "$finished_at" \
    --arg contractSha256 "$contract_sha" \
    --arg baselineHead "$baseline_head" \
    --arg testDiffSha256 "$test_diff_sha" \
    --argjson attempt "$attempt" \
    --argjson executionFailures "$execution_failures" '
      def failure_matches($decl; $actual):
        ($actual.result == "FAILURE") and
        ($actual.exceptionType == $decl.expectedFailure.type) and
        (($decl.expectedFailure.messageIncludes // "") as $fragment |
          ($fragment == "" or (($actual.exceptionMessage // "") | contains($fragment))));
      ($contract[0].verification.cases | map(
        . as $decl |
        [$observed[] | select(.kind == "case" and .target == $decl.test.target and
          .className == $decl.test.className and .name == $decl.test.name)] as $matches |
        (if ($matches | length) == 1 then $matches[0] else null end) as $actual |
        (if ($matches | length) != 1 then false
         elif $decl.before == "pass" then $actual.result == "SUCCESS"
         elif $decl.before == "fail" then failure_matches($decl; $actual)
         elif $actual.result == "SUCCESS" then true
         elif ($decl | has("expectedFailure")) then failure_matches($decl; $actual)
         else false end) as $valid |
        {id: $decl.id, criterion: $decl.criterion, intent: $decl.intent,
         expectedBefore: $decl.before, test: $decl.test, expectedFailure: ($decl.expectedFailure // null),
         matches: ($matches | length), actual: $actual, valid: $valid}
      )) as $cases |
      [$observed[] | select(.kind == "case") as $actual |
        select(any($contract[0].verification.cases[];
          .test.target == $actual.target and .test.className == $actual.className and .test.name == $actual.name) | not)] as $undeclared |
      [$observed[] | select(.kind == "suite")] as $suites |
      ($executionFailures | length == 0 and
       ($suites | length) >= ($contract[0].targetTests | length) and
       ($cases | all(.valid)) and ($undeclared | length == 0) and
       ($cases | any(.intent == "change" and .actual.result == "FAILURE"))) as $valid |
      {taskId: $taskId, attempt: $attempt, startedAt: $startedAt, finishedAt: $finishedAt,
       contractSha256: $contractSha256, baselineHead: $baselineHead,
       testDiffSha256: $testDiffSha256, valid: $valid,
       reasonCode: (if $valid then "VALID_RED"
                    elif ($executionFailures | length) > 0 then "EXECUTION_FAILURE"
                    elif ($undeclared | length) > 0 then "UNDECLARED_TEST_RESULT"
                    else "CASE_EXPECTATION_MISMATCH" end),
       summary: {declared: ($cases | length), valid: ([$cases[] | select(.valid)] | length),
                 invalid: ([$cases[] | select(.valid | not)] | length),
                 expectedRed: ([$cases[] | select(.intent == "change" and .actual.result == "FAILURE")] | length),
                 undeclared: ($undeclared | length)},
       cases: $cases, undeclaredCases: $undeclared, suites: $suites,
       executionFailures: $executionFailures}' | automation_record_json "$preflight_meta"

cp "$preflight_meta" "$attempt_dir/evaluation.json"
if [[ "$(jq -r '.valid' "$preflight_meta")" != "true" ]]; then
    reason="$(jq -r '.reasonCode' "$preflight_meta")"
    invalid="$(jq -r '[.cases[] | select(.valid | not) | .id] | join(", ")' "$preflight_meta")"
    automation_die "RED preflight rejected ($reason); invalid cases: ${invalid:-none}; evidence: $preflight_meta"
fi

jq '{taskId, contractSha256, baselineHead, testDiffSha256,
     cases: [.cases[] | {id, criterion, intent, test, actual}]}' "$preflight_meta" \
    | automation_record_json "$evidence_dir/test-manifest.json"
preflight_sha="$(automation_file_sha256 "$preflight_meta")"
manifest_sha="$(automation_file_sha256 "$evidence_dir/test-manifest.json")"
jq -n --arg taskId "$task_id" --arg startedAt "$started_at" --arg finishedAt "$finished_at" \
    --arg contractSha256 "$contract_sha" --arg baselineHead "$baseline_head" \
    --arg testDiffSha256 "$test_diff_sha" --arg preflightSha256 "$preflight_sha" \
    --arg manifestSha256 "$manifest_sha" --arg attemptPath "attempts/red-preflight-$attempt_id" \
    --argjson attempt "$attempt" \
    '{taskId: $taskId, schemaVersion: 3, startedAt: $startedAt, finishedAt: $finishedAt,
      contractSha256: $contractSha256, baselineHead: $baselineHead,
      testDiffSha256: $testDiffSha256, preflightSha256: $preflightSha256,
      manifestSha256: $manifestSha256, attempt: $attempt, attemptPath: $attemptPath,
      structuredCasesVerified: true, exitCode: 1}' | automation_record_json "$red_meta"

automation_info "$task_id structured RED evidence recorded"
