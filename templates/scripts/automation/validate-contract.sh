#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
    printf 'Usage: %s TASK-ID|/path/to/contract.json\n' "$0" >&2
}

input="${1:-}"
[[ -n "$input" ]] || { usage; exit 2; }
automation_require_command jq
automation_require_layout
automation_validate_config

if [[ "$input" == */* || "$input" == *.json || "$input" == *.example ]]; then
    contract="$input"
    [[ "$contract" == /* ]] || contract="$AUTOMATION_ROOT/$contract"
else
    automation_validate_task_id "$input"
    contract="$(automation_contract_path "$input")"
fi

[[ -f "$contract" ]] || automation_die "contract not found: $contract"
jq -e . "$contract" >/dev/null || automation_die "contract is not valid JSON: $contract"

jq -e '
    (.schemaVersion == 1 or .schemaVersion == 2 or .schemaVersion == 3) and
    (.id | type == "string" and test("^TASK-[A-Z0-9-]+$")) and
    (.title | type == "string" and length > 0) and
    .designApproved == true and
    (.planPath | type == "string" and length > 0) and
    .ambiguityPolicy == "BLOCKED" and
    (.maxFixLoops | type == "number" and . >= 0 and . <= 1 and floor == .) and
    (.maxChangedFiles | type == "number" and . >= 1 and . <= 12 and floor == .) and
    (.allowedPaths | type == "array" and length > 0) and
    (.forbiddenPaths | type == "array" and length > 0) and
    (if .schemaVersion == 1 then
        .allowedSuperpowers == ["test-driven-development", "systematic-debugging", "verification-before-completion"]
     else
        .allowedWorkflowSkills == ["android-orchestrator-test-driven-development", "android-orchestrator-systematic-debugging", "android-orchestrator-verification-before-completion"] and
        (has("allowedSuperpowers") | not)
     end) and
    (.acceptanceCriteria | type == "array" and length > 0) and
    (.nonGoals | type == "array" and length > 0) and
    (.targetTests | type == "array" and length > 0 and all(.[];
        type == "object" and
        keys == ["filter", "gradleTask"] and
        (.gradleTask | type == "string" and test("^(?:[A-Za-z][A-Za-z0-9_.-]*|(?::[A-Za-z0-9_.-]+)+)$")) and
        (.filter | type == "string" and test("^[A-Za-z0-9_.#$*-]+$")))) and
    ([.targetTests[].filter] | length == (unique | length)) and
    (.deviceTestsRequired | type == "boolean") and
    (.testPolicy == "required" or .testPolicy == "not-required") and
    (if .testPolicy == "not-required" then (.testPolicyReason | type == "string" and length >= 20) else true end) and
    (if .schemaVersion == 3 then
        (.acceptanceCriteria | length) as $criterionCount |
        (.targetTests | length) as $targetCount |
        (.verification | type == "object" and
         keys == ["cases", "maxPreparationFixes", "version"] and
         .version == 1 and
         (.maxPreparationFixes | type == "number" and floor == . and . >= 0 and . <= 1) and
         (.cases | type == "array" and length > 0) and
         ([.cases[].id] | length == (unique | length)) and
         ([.cases[] | [.test.target, .test.className, .test.name] | @json] | length == (unique | length)) and
         (any(.cases[]; .intent == "change")) and
         all(.cases[];
            type == "object" and
            ([keys[]] - ["id", "criterion", "intent", "before", "after", "source", "test", "expectedFailure"] | length == 0) and
            (.id | type == "string" and test("^[A-Z][A-Z0-9-]{2,63}$")) and
            (.criterion | type == "number" and floor == . and . >= 1 and . <= $criterionCount) and
            .after == "pass" and
            (.test | type == "object" and keys == ["className", "name", "target"] and
             (.target | type == "number" and floor == . and . >= 0 and . < $targetCount) and
             (.className | type == "string" and length > 0) and
             (.name | type == "string" and length > 0)) and
            (if .intent == "preserve" then
                 .before == "pass" and
                 (.source == "existingTest" or .source == "baselineCapture" or .source == "measuredFact") and
                 (has("expectedFailure") | not)
             elif .intent == "change" then
                 .before == "fail" and .source == "userRequirement" and
                 (.expectedFailure | type == "object" and
                  ([keys[]] - ["type", "messageIncludes", "origin"] | length == 0) and
                  (.type | type == "string" and length > 0) and
                  (.origin | type == "string" and length >= 12) and
                  (if has("messageIncludes") then (.messageIncludes | type == "string" and length >= 3) else true end))
             elif .intent == "observe" then
                 .before == "observe" and
                 (.source == "userRequirement" or .source == "existingTest" or .source == "baselineCapture" or .source == "measuredFact") and
                 (if has("expectedFailure") then
                    (.expectedFailure | type == "object" and
                     ([keys[]] - ["type", "messageIncludes", "origin"] | length == 0) and
                     (.type | type == "string" and length > 0) and
                     (.origin | type == "string" and length >= 12) and
                     (if has("messageIncludes") then (.messageIncludes | type == "string" and length >= 3) else true end))
                  else true end)
             else false end)))
     else true end)
' "$contract" >/dev/null || automation_die "contract is missing required fields or violates limits"

task_id="$(jq -r '.id' "$contract")"
automation_validate_task_id "$task_id"

if [[ "$contract" == "$AUTOMATION_TASKS_DIR/"* ]]; then
    expected_contract="$(automation_contract_path "$task_id")"
    [[ "$contract" == "$expected_contract" ]] || automation_die "contract filename must match id: $(basename "$expected_contract")"
fi

while IFS= read -r value; do
    [[ "$value" != /* ]] || automation_die "paths must be repository-relative: $value"
    [[ "$value" != *".."* ]] || automation_die "paths may not contain '..': $value"
    [[ "$value" =~ ^[A-Za-z0-9._/?*-]+$ ]] || automation_die "unsupported path pattern: $value"
done < <(jq -r '.allowedPaths[], .forbiddenPaths[]' "$contract")

while IFS= read -r protected; do
    if automation_array_matches_path "$contract" '.allowedPaths' "$protected"; then
        automation_die "allowedPaths overlaps protected path: $protected"
    fi
    if ! automation_array_matches_path "$contract" '.forbiddenPaths' "$protected"; then
        automation_die "forbiddenPaths must cover protected path: $protected"
    fi
done < <(jq -r '.protectedPaths[]' "$AUTOMATION_CONFIG")

while IFS=$'\t' read -r gradle_task filter; do
    automation_validate_gradle_task "$gradle_task"
    automation_validate_test_filter "$filter"
    jq -e \
        --arg task "$gradle_task" \
        '.gradleVerification.focusedTestTasks | index($task) != null' \
        "$AUTOMATION_CONFIG" >/dev/null || \
        automation_die "target test Gradle task is not allowed by automation/config.json: $gradle_task"
done < <(jq -r '.targetTests[] | [.gradleTask, .filter] | @tsv' "$contract")

if rg -n -i 'replace with|TASK-EXAMPLE|todo|tbd|placeholder' "$contract" >/dev/null; then
    automation_die "contract still contains template placeholders"
fi

plan_path="$(jq -r '.planPath' "$contract")"
if [[ "$plan_path" == /* || "$plan_path" == *".."* ]]; then
    automation_die "planPath must be a safe repository-relative path"
fi
[[ "$plan_path" == "docs/plans/$task_id.md" ]] || automation_die "planPath must be docs/plans/$task_id.md"
[[ -f "$AUTOMATION_ROOT/$plan_path" ]] || automation_die "approved plan does not exist: $plan_path"

automation_info "contract valid: $task_id"
