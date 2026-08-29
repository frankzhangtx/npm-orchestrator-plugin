#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ -n "$task_id" ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
"$SCRIPT_DIR/validate-contract.sh" "$task_id" >/dev/null

contract="$(automation_contract_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
baseline_meta="$evidence_dir/baseline.json"
[[ -f "$baseline_meta" ]] || { automation_die "baseline evidence is missing"; exit 40; }

baseline_head="$(jq -er '.head' "$baseline_meta")"
current_head="$(git -C "$AUTOMATION_ROOT" rev-parse HEAD)"
[[ "$baseline_head" == "$current_head" ]] || { automation_die "HEAD changed after baseline"; exit 40; }

workspace_file="$(automation_workspace_path "$task_id")"
planning_commit_policy="$(jq -r '.planningArtifactsCommitPolicy // "legacyCommittedSeparately"' "$workspace_file")"
if [[ "$planning_commit_policy" == "withProductChanges" ]]; then
    automation_assert_planning_artifacts_sealed "$task_id" "$AUTOMATION_ROOT" || exit 40
    changed_file_list="$(automation_product_changed_paths_at "$task_id" "$AUTOMATION_ROOT")"
    [[ -n "$changed_file_list" ]] || { automation_die "task has no product changes beyond its sealed planning artifacts"; exit 40; }
else
    changed_file_list="$(automation_changed_paths)"
    [[ -n "$changed_file_list" ]] || { automation_die "task has no changed files"; exit 40; }
fi

max_changed="$(jq -r '.maxChangedFiles' "$contract")"
changed_count="$(printf '%s\n' "$changed_file_list" | awk 'NF { count++ } END { print count + 0 }')"
[[ "$changed_count" -le "$max_changed" ]] || { automation_die "changed file count $changed_count exceeds limit $max_changed"; exit 40; }

production_changed=0
test_changed=0
while IFS= read -r path; do
    [[ -n "$path" ]] || continue

    while IFS= read -r protected; do
        if automation_path_matches "$path" "$protected"; then
            automation_die "protected path changed: $path"
            exit 40
        fi
    done < <(jq -r '.protectedPaths[]' "$AUTOMATION_CONFIG")

    if automation_array_matches_path "$contract" '.forbiddenPaths' "$path"; then
        automation_die "forbidden path changed: $path"
        exit 40
    fi
    if ! automation_array_matches_path "$contract" '.allowedPaths' "$path"; then
        automation_die "path is outside allowedPaths: $path"
        exit 40
    fi

    if automation_array_matches_path "$AUTOMATION_CONFIG" '.androidProject.productionPaths' "$path"; then
        production_changed=1
    fi
    if automation_array_matches_path "$AUTOMATION_CONFIG" '.androidProject.testPaths' "$path"; then
        test_changed=1
    fi
done <<< "$changed_file_list"

deleted_tests="$(
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        if [[ -n "$(git -C "$AUTOMATION_ROOT" diff --no-renames --name-only --diff-filter=D HEAD -- "$path")" ]] && \
           automation_array_matches_path "$AUTOMATION_CONFIG" '.androidProject.testPaths' "$path"; then
            printf '%s\n' "$path"
        fi
    done <<< "$changed_file_list"
)"
[[ -z "$deleted_tests" ]] || { automation_die "test deletion is forbidden: $deleted_tests"; exit 40; }

test_policy="$(jq -r '.testPolicy' "$contract")"
if [[ "$production_changed" == "1" && "$test_policy" == "required" && "$test_changed" != "1" ]]; then
    automation_die "production code changed without a test change"
    exit 40
fi

added_test_lines="$(
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        if automation_array_matches_path "$AUTOMATION_CONFIG" '.androidProject.testPaths' "$path"; then
            git -C "$AUTOMATION_ROOT" diff --no-renames --unified=0 HEAD -- "$path"
        fi
    done <<< "$changed_file_list" \
        | awk '/^\+\+\+/ { next } /^\+/ { sub(/^\+/, ""); print }'
)"
weakening_pattern='@Ignore|@Disabled|assumeTrue\(false\)|assertTrue\(true\)|assertFalse\(false\)'
if printf '%s\n' "$added_test_lines" | rg -n "$weakening_pattern" >/dev/null; then
    automation_die "potential test weakening detected in added lines"
    exit 40
fi

while IFS= read -r untracked_test; do
    [[ -n "$untracked_test" ]] || continue
    if ! git -C "$AUTOMATION_ROOT" ls-files --error-unmatch -- "$untracked_test" >/dev/null 2>&1 && \
       automation_array_matches_path "$AUTOMATION_CONFIG" '.androidProject.testPaths' "$untracked_test" && \
        rg -n "$weakening_pattern" "$AUTOMATION_ROOT/$untracked_test" >/dev/null; then
        automation_die "potential test weakening detected in new test: $untracked_test"
        exit 40
    fi
done <<< "$changed_file_list"

if [[ "$planning_commit_policy" == "withProductChanges" ]]; then
    automation_info "scope gate passed ($changed_count product files; sealed planning artifacts excluded from the contract limit)"
else
    automation_info "scope gate passed ($changed_count changed files)"
fi
printf '%s\n' "$changed_file_list"
