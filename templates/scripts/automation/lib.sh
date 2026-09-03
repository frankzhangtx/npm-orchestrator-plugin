#!/usr/bin/env bash

# Shared helpers for the scheduled coding quality gate. This file is sourced by
# command scripts; it intentionally does not enable set -e for its callers.

AUTOMATION_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${AUTOMATION_PROJECT_ROOT:-}" ]]; then
    if [[ "${AUTOMATION_TEST_MODE:-0}" != "1" ]]; then
        printf 'ERROR: AUTOMATION_PROJECT_ROOT is reserved for the test suite.\n' >&2
        return 1 2>/dev/null || exit 1
    fi
    AUTOMATION_ROOT="$(cd "$AUTOMATION_PROJECT_ROOT" && pwd)"
else
    AUTOMATION_ROOT="$(git -C "$AUTOMATION_SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
        printf 'ERROR: scripts must run inside a Git worktree.\n' >&2
        return 1 2>/dev/null || exit 1
    }
fi

AUTOMATION_DIR="$AUTOMATION_ROOT/automation"
AUTOMATION_CONFIG="$AUTOMATION_DIR/config.json"
AUTOMATION_TASKS_DIR="$AUTOMATION_DIR/tasks"

automation_git_common_dir="$(git -C "$AUTOMATION_ROOT" rev-parse --git-common-dir 2>/dev/null)" || {
    printf 'ERROR: unable to resolve Git common directory.\n' >&2
    return 1 2>/dev/null || exit 1
}
if [[ "$automation_git_common_dir" != /* ]]; then
    automation_git_common_dir="$AUTOMATION_ROOT/$automation_git_common_dir"
fi
AUTOMATION_GIT_COMMON_DIR="$(cd "$automation_git_common_dir" && pwd)"
unset automation_git_common_dir

if [[ -n "${AUTOMATION_RUNTIME_ROOT:-}" ]]; then
    if [[ "${AUTOMATION_TEST_MODE:-0}" != "1" ]]; then
        printf 'ERROR: AUTOMATION_RUNTIME_ROOT is reserved for the test suite.\n' >&2
        return 1 2>/dev/null || exit 1
    fi
elif [[ "${AUTOMATION_TEST_MODE:-0}" == "1" ]]; then
    AUTOMATION_RUNTIME_ROOT="$AUTOMATION_DIR"
else
    AUTOMATION_RUNTIME_ROOT="$AUTOMATION_GIT_COMMON_DIR/automation-runtime"
fi

AUTOMATION_STATE_DIR="$AUTOMATION_RUNTIME_ROOT/state"
AUTOMATION_EVIDENCE_DIR="$AUTOMATION_RUNTIME_ROOT/evidence"
AUTOMATION_LOCKS_DIR="$AUTOMATION_RUNTIME_ROOT/locks"
AUTOMATION_WORKSPACES_DIR="$AUTOMATION_RUNTIME_ROOT/workspaces"
AUTOMATION_WORKTREE_ALLOWLIST_RELATIVE_PATH=".automation-worktree-allowlist"
AUTOMATION_WORKTREE_ALLOWLIST_MAX_BYTES=65536
AUTOMATION_WORKTREE_ALLOWLIST_MAX_ENTRIES=256

automation_info() {
    printf '[automation] %s\n' "$*"
}

automation_warn() {
    printf '[automation] WARN: %s\n' "$*" >&2
}

automation_die() {
    printf '[automation] ERROR: %s\n' "$*" >&2
    return 1
}

automation_now() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

automation_require_command() {
    command -v "$1" >/dev/null 2>&1 || automation_die "required command is missing: $1"
}

automation_resolve_opencode_config() {
    local output_file="$1"
    local error_file="$2"
    local checkpoint_error="Failed to run the query 'PRAGMA wal_checkpoint(PASSIVE)'"

    if opencode debug config > "$output_file" 2> "$error_file"; then
        return 0
    fi
    if ! rg -F "$checkpoint_error" "$error_file" >/dev/null; then
        return 1
    fi

    automation_warn "OpenCode database checkpoint failed once; retrying resolved config discovery"
    sleep 1
    opencode debug config > "$output_file" 2> "$error_file"
}

automation_require_layout() {
    [[ -f "$AUTOMATION_CONFIG" ]] || automation_die "missing $AUTOMATION_CONFIG"
    [[ -d "$AUTOMATION_TASKS_DIR" ]] || automation_die "missing $AUTOMATION_TASKS_DIR"
}

automation_validate_config() {
    automation_require_layout
    jq -e '
        def repository_path:
            type == "string" and
            length > 0 and
            (startswith("/") | not) and
            (test("^[A-Za-z]:[/\\\\]") | not) and
            (test("(^|/)\\.\\.(/|$)") | not);
        def gradle_task:
            type == "string" and
            test("^(?:[A-Za-z][A-Za-z0-9_.-]*|(?::[A-Za-z0-9_.-]+)+)$");
        def gradle_task_list:
            type == "array" and
            length > 0 and
            length == (unique | length) and
            all(.[]; gradle_task);
        .schemaVersion == 3 and
        (.enabled | type == "boolean") and
        (.mode == "shadow" or .mode == "orchestrated") and
        (.workspaceStrategy == "inPlaceExclusive" or .workspaceStrategy == "isolatedWorktree") and
        .originalBranchDriftPolicy == "block" and
        (.worktreeBase | type == "string") and
        (.maxFixLoops | type == "number" and . >= 0 and . <= 1 and floor == .) and
        (.maxReviewCycles | type == "number" and . >= 0 and . <= 2 and floor == .) and
        (.maxReviewerRestarts | type == "number" and . >= 0 and . <= 3 and floor == .) and
        (.unitTestsEnabled | type == "boolean") and
        (.lintEnabled | type == "boolean") and
        (.longCommandTimeoutMs | type == "number" and . >= 120000 and . <= 7200000 and floor == .) and
        (.autoCleanupWorktrees | type == "boolean") and
        .pushAfterAcceptance == false and
        (.approvalPhrases.proposal | type == "string" and length >= 4) and
        (.approvalPhrases.contract | type == "string" and length >= 4) and
        (.approvalPhrases.acceptance | type == "string" and length >= 4) and
        (.approvalPhrases.abort | type == "string" and length >= 4) and
        (.approvalPhrases.resume | type == "string" and length >= 4) and
        (.plugins | type == "object" and keys == ["superpowers"]) and
        (.plugins.superpowers | type == "string" and length > 0) and
        (.requiredSkills | type == "array" and length >= 6) and
        (.gradleVerification as $verification |
            ($verification | type == "object") and
            ($verification | keys == [
                "assembleTasks",
                "deviceTestTasks",
                "focusedTestTasks",
                "fullUnitTestTasks",
                "lintTasks"
            ]) and
            ($verification.fullUnitTestTasks | gradle_task_list) and
            ($verification.focusedTestTasks | gradle_task_list) and
            ($verification.assembleTasks | gradle_task_list) and
            ($verification.lintTasks | gradle_task_list) and
            ($verification.deviceTestTasks | gradle_task_list)) and
        (.androidProject as $project |
            ($project | type == "object") and
            ($project.name | type == "string" and length > 0) and
            ($project.gradleDsl == "kotlin" or $project.gradleDsl == "groovy" or $project.gradleDsl == "mixed") and
            ($project.settingsFile | repository_path) and
            ((($project | has("moduleScope")) | not) or $project.moduleScope == "all" or $project.moduleScope == "primary") and
            ($project.primaryModule | type == "string" and test("^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$")) and
            ($project.modules | type == "array" and length > 0 and all(.[];
                (.gradlePath | type == "string" and test("^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$")) and
                (.directory | repository_path) and
                (.buildFile | repository_path) and
                (.dsl == "kotlin" or .dsl == "groovy") and
                (.type == "application" or .type == "library" or .type == "dynamic-feature" or .type == "test" or .type == "asset-pack") and
                (.namespace == null or (.namespace | type == "string" and length > 0)) and
                (.applicationId == null or (.applicationId | type == "string" and length > 0)))) and
            any($project.modules[]; .gradlePath == $project.primaryModule) and
            ($project.productionPaths | type == "array" and length > 0 and all(.[];
                repository_path and test("(^|/)src/main/\\*\\*$"))) and
            ($project.testPaths | type == "array" and length > 0 and all(.[];
                repository_path and test("(^|/)src/(?:test|androidTest)/\\*\\*$")))) and
        (.protectedPaths | type == "array" and length > 0 and all(.[]; repository_path))
    ' "$AUTOMATION_CONFIG" >/dev/null || automation_die "automation/config.json is invalid"
}

automation_require_orchestrated() {
    automation_validate_config
    [[ "$(automation_config_value '.enabled')" == "true" ]] || automation_die "automation is disabled"
    [[ "$(automation_config_value '.mode')" == "orchestrated" ]] || automation_die "automation mode is not orchestrated"
}

automation_ensure_runtime_layout() {
    mkdir -p \
        "$AUTOMATION_STATE_DIR" \
        "$AUTOMATION_EVIDENCE_DIR" \
        "$AUTOMATION_LOCKS_DIR" \
        "$AUTOMATION_WORKSPACES_DIR"
}

automation_validate_task_id() {
    local task_id="${1:-}"
    [[ "$task_id" =~ ^TASK-[A-Z0-9-]+$ ]] || automation_die "invalid task ID: ${task_id:-<empty>}"
}

automation_contract_path() {
    local task_id="$1"
    printf '%s/%s.json\n' "$AUTOMATION_TASKS_DIR" "$task_id"
}

automation_contract_relative_path() {
    local task_id="$1"
    printf 'automation/tasks/%s.json\n' "$task_id"
}

automation_state_path() {
    local task_id="$1"
    printf '%s/%s.json\n' "$AUTOMATION_STATE_DIR" "$task_id"
}

automation_evidence_path() {
    local task_id="$1"
    printf '%s/%s\n' "$AUTOMATION_EVIDENCE_DIR" "$task_id"
}

automation_workspace_path() {
    local task_id="$1"
    printf '%s/%s.json\n' "$AUTOMATION_WORKSPACES_DIR" "$task_id"
}

automation_workspace_strategy() {
    local workspace_file="$1"
    jq -er '.workspaceStrategy // "isolatedWorktree"' "$workspace_file"
}

automation_workspace_task_root() {
    local workspace_file="$1"
    jq -er '.taskRoot // .taskWorktree' "$workspace_file"
}

automation_origin_path() {
    local task_id="$1"
    printf '%s/origin.json\n' "$(automation_evidence_path "$task_id")"
}

automation_approvals_path() {
    local task_id="$1"
    printf '%s/approvals.jsonl\n' "$(automation_evidence_path "$task_id")"
}

automation_read_state() {
    local task_id="$1"
    local state_file
    state_file="$(automation_state_path "$task_id")"
    [[ -f "$state_file" ]] || automation_die "state does not exist for $task_id"
    jq -er '.state' "$state_file"
}

automation_config_value() {
    local query="$1"
    jq -r "$query" "$AUTOMATION_CONFIG"
}

automation_validate_gradle_task() {
    local task="${1:-}"
    local safe_task_pattern='^([A-Za-z][A-Za-z0-9_.-]*|(:[A-Za-z0-9_.-]+)+)$'
    [[ "$task" =~ $safe_task_pattern ]] || automation_die "unsafe Gradle task: ${task:-<empty>}"
}

automation_validate_test_filter() {
    local filter="${1:-}"
    local safe_filter_pattern='^[A-Za-z0-9_.#$*-]+$'
    [[ "$filter" =~ $safe_filter_pattern ]] || automation_die "unsafe test filter: ${filter:-<empty>}"
}

automation_validate_gradle_group() {
    local group="${1:-}"
    case "$group" in
        fullUnitTestTasks|focusedTestTasks|assembleTasks|lintTasks|deviceTestTasks) ;;
        *)
            automation_die "unknown Gradle verification group: ${group:-<empty>}"
            return 1
            ;;
    esac
}

automation_gradle_group_command_json() {
    local group="$1"
    automation_validate_gradle_group "$group" || return 1
    automation_validate_config || return 1
    jq -ce \
        --arg group "$group" \
        '["./gradlew"] + .gradleVerification[$group]' \
        "$AUTOMATION_CONFIG"
}

automation_run_gradle_group() {
    local group="$1"
    local root="${2:-$AUTOMATION_ROOT}"
    local task
    local -a tasks=()

    automation_validate_gradle_group "$group" || return 1
    automation_validate_config || return 1
    while IFS= read -r task; do
        automation_validate_gradle_task "$task" || return 1
        tasks[${#tasks[@]}]="$task"
    done < <(jq -er --arg group "$group" '.gradleVerification[$group][]' "$AUTOMATION_CONFIG")
    [[ "${#tasks[@]}" -gt 0 ]] || {
        automation_die "Gradle verification group is empty: $group"
        return 1
    }

    (
        cd "$root"
        ./gradlew "${tasks[@]}"
    )
}

automation_run_configured_unit_tests() {
    local contract="${1:-}"
    local root="${2:-$AUTOMATION_ROOT}"
    local context="${3:-}"

    [[ -n "$contract" && -f "$contract" ]] || automation_die "unit-test contract does not exist: $contract"
    automation_validate_config || return 1
    if [[ "$(automation_config_value '.unitTestsEnabled')" != "true" ]]; then
        automation_info "skipping ${context}unit tests (unitTestsEnabled=false)"
        return 0
    fi

    while IFS=$'\t' read -r gradle_task filter; do
        automation_info "running ${context}focused test ($gradle_task): $filter"
        automation_run_focused_test "$gradle_task" "$filter" "$root"
    done < <(jq -r '.targetTests[] | [.gradleTask, .filter] | @tsv' "$contract")

    automation_info "running ${context}full unit tests"
    automation_run_gradle_group "fullUnitTestTasks" "$root"
}

automation_run_configured_lint() {
    local root="${1:-$AUTOMATION_ROOT}"

    automation_validate_config || return 1
    if [[ "$(automation_config_value '.lintEnabled')" != "true" ]]; then
        automation_info "skipping Android lint (lintEnabled=false)"
        return 0
    fi

    automation_info "running configured Android lint tasks"
    automation_run_gradle_group "lintTasks" "$root"
}

automation_run_focused_test() {
    local task="$1"
    local filter="$2"
    local root="${3:-$AUTOMATION_ROOT}"

    automation_validate_config || return 1
    automation_validate_gradle_task "$task" || return 1
    automation_validate_test_filter "$filter" || return 1
    jq -e \
        --arg task "$task" \
        '.gradleVerification.focusedTestTasks | index($task) != null' \
        "$AUTOMATION_CONFIG" >/dev/null || {
            automation_die "focused Gradle task is not allowed by automation/config.json: $task"
            return 1
        }

    (
        cd "$root"
        ./gradlew "$task" --tests "$filter"
    )
}

automation_require_approval() {
    local kind="$1"
    local supplied="$2"
    local expected
    expected="$(jq -er --arg kind "$kind" '.approvalPhrases[$kind]' "$AUTOMATION_CONFIG")" || {
        automation_die "unknown approval kind: $kind"
        return 1
    }
    [[ "$supplied" == "$expected" ]] || automation_die "approval option token does not match the configured $kind confirmation"
}

automation_file_sha256() {
    local file="$1"
    [[ -f "$file" ]] || automation_die "file does not exist: $file"
    shasum -a 256 "$file" | awk '{print $1}'
}

automation_current_branch() {
    local root="${1:-$AUTOMATION_ROOT}"
    local branch
    branch="$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null)" || {
        automation_die "detached HEAD is not supported: $root"
        return 1
    }
    printf '%s\n' "$branch"
}

automation_path_matches() {
    local path="$1"
    local pattern="$2"
    local prefix

    if [[ "$pattern" == */ ]]; then
        [[ "$path" == "$pattern"* ]]
        return
    fi

    if [[ "$pattern" == *'/**' ]]; then
        prefix="${pattern:0:${#pattern}-3}"
        [[ "$path" == "$prefix" || "$path" == "$prefix/"* ]]
        return
    fi

    case "$path" in
        $pattern) return 0 ;;
        *) return 1 ;;
    esac
}

automation_array_matches_path() {
    local json_file="$1"
    local query="$2"
    local path="$3"
    local pattern

    while IFS= read -r pattern; do
        if automation_path_matches "$path" "$pattern"; then
            return 0
        fi
    done < <(jq -r "$query[]" "$json_file")

    return 1
}

automation_validate_worktree_allowlist_entry_at() {
    local root="$1"
    local path="$2"
    local config_file="$root/automation/config.json"
    local protected

    if [[ -z "$path" ]]; then
        automation_die "worktree allowlist entries must not be empty"
        return 1
    fi
    if [[ "$path" == [[:space:]]* || "$path" == *[[:space:]] ]]; then
        automation_die "worktree allowlist entries must not have leading or trailing whitespace: $path"
        return 1
    fi
    case "$path" in
        *[[:cntrl:]]*|*'\\'*)
            automation_die "worktree allowlist entries must use plain repository-relative paths: $path"
            return 1
            ;;
        *'*'*|*'?'*|*'['*|*']'*)
            automation_die "worktree allowlist entries must be exact file paths, not patterns: $path"
            return 1
            ;;
    esac
    case "/$path/" in
        *'//'*|*'/./'*|*'/../'*)
            automation_die "worktree allowlist entries must be normalized repository-relative paths: $path"
            return 1
            ;;
    esac
    case "$path" in
        /*|./*|.|..|.git|.git/*|docs/plans|docs/plans/*|"$AUTOMATION_WORKTREE_ALLOWLIST_RELATIVE_PATH")
            automation_die "worktree allowlist entry is reserved or unsafe: $path"
            return 1
            ;;
    esac
    if [[ -d "$root/$path" ]]; then
        automation_die "worktree allowlist entries must identify files, not directories: $path"
        return 1
    fi

    if [[ ! -f "$config_file" ]]; then
        automation_die "missing automation configuration while validating worktree allowlist: $config_file"
        return 1
    fi
    if ! jq -e '.protectedPaths | type == "array" and all(.[]; type == "string" and length > 0)' \
        "$config_file" >/dev/null; then
        automation_die "automation protectedPaths are invalid while validating the worktree allowlist"
        return 1
    fi
    while IFS= read -r protected; do
        if automation_path_matches "$path" "$protected"; then
            automation_die "worktree allowlist must not include a protected path: $path"
            return 1
        fi
    done < <(jq -r '.protectedPaths[]' "$config_file")
    return 0
}

automation_worktree_allowlist_file_entries_at() {
    local root="$1"
    local allowlist_file="$root/$AUTOMATION_WORKTREE_ALLOWLIST_RELATIVE_PATH"
    local byte_count line existing
    local entry_count=0
    local -a entries=()

    if [[ ! -e "$allowlist_file" && ! -L "$allowlist_file" ]]; then
        return 0
    fi
    if [[ -L "$allowlist_file" || ! -f "$allowlist_file" ]]; then
        automation_die "worktree allowlist must be a regular file, not a symlink: $allowlist_file"
        return 1
    fi
    byte_count="$(wc -c < "$allowlist_file" | tr -d '[:space:]')"
    if [[ ! "$byte_count" =~ ^[0-9]+$ ]] || \
       [[ "$byte_count" -gt "$AUTOMATION_WORKTREE_ALLOWLIST_MAX_BYTES" ]]; then
        automation_die "worktree allowlist exceeds $AUTOMATION_WORKTREE_ALLOWLIST_MAX_BYTES bytes: $allowlist_file"
        return 1
    fi

    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ -n "$line" && "$line" != \#* ]] || continue
        automation_validate_worktree_allowlist_entry_at "$root" "$line" || return 1
        if [[ "$entry_count" -gt 0 ]]; then
            for existing in "${entries[@]}"; do
                if [[ "$existing" == "$line" ]]; then
                    automation_die "duplicate worktree allowlist entry: $line"
                    return 1
                fi
            done
        fi
        entry_count=$((entry_count + 1))
        if [[ "$entry_count" -gt "$AUTOMATION_WORKTREE_ALLOWLIST_MAX_ENTRIES" ]]; then
            automation_die "worktree allowlist exceeds $AUTOMATION_WORKTREE_ALLOWLIST_MAX_ENTRIES entries"
            return 1
        fi
        entries[${#entries[@]}]="$line"
    done < "$allowlist_file"

    if [[ "$entry_count" -gt 0 ]]; then
        for line in "${entries[@]}"; do
            printf '%s\n' "$line"
        done
    fi
    return 0
}

automation_worktree_allowlist_entries_json() {
    local entries="$1"
    if [[ -z "$entries" ]]; then
        printf '[]\n'
    else
        printf '%s\n' "$entries" | jq -Rsc 'split("\n") | map(select(length > 0))'
    fi
}

automation_worktree_allowlist_file_json_at() {
    local root="$1"
    local entries
    entries="$(automation_worktree_allowlist_file_entries_at "$root")" || return 1
    automation_worktree_allowlist_entries_json "$entries"
}

automation_effective_worktree_allowlist_entries_at() {
    local root="$1"
    local resolved_root
    local lease_file="$AUTOMATION_LOCKS_DIR/repository.workspace.lease/lease.json"
    local task_id workspace_file source_root task_root resolved_source resolved_task entry

    resolved_root="$(cd "$root" && pwd -P)" || {
        automation_die "unable to resolve worktree root for allowlist: $root"
        return 1
    }
    if [[ -f "$lease_file" ]]; then
        task_id="$(jq -er '.taskId' "$lease_file")" || {
            automation_die "repository lease is invalid while resolving the worktree allowlist"
            return 1
        }
        workspace_file="$(automation_workspace_path "$task_id")"
        if [[ -f "$workspace_file" ]] && jq -e 'has("worktreeAllowlist")' "$workspace_file" >/dev/null; then
            jq -e \
                --argjson max "$AUTOMATION_WORKTREE_ALLOWLIST_MAX_ENTRIES" \
                '.worktreeAllowlist as $entries |
                 ($entries | type == "array") and
                 ($entries | length <= $max) and
                 ($entries | length == (unique | length)) and
                 all($entries[]; type == "string" and length > 0)' \
                "$workspace_file" >/dev/null || {
                    automation_die "workspace worktreeAllowlist snapshot is invalid: $workspace_file"
                    return 1
                }
            source_root="$(jq -er '.sourceRoot' "$workspace_file")" || return 1
            task_root="$(automation_workspace_task_root "$workspace_file")" || return 1
            resolved_source="$(cd "$source_root" 2>/dev/null && pwd -P || true)"
            resolved_task="$(cd "$task_root" 2>/dev/null && pwd -P || true)"
            if [[ "$resolved_root" == "$resolved_source" ]]; then
                while IFS= read -r entry; do
                    [[ -n "$entry" ]] || continue
                    automation_validate_worktree_allowlist_entry_at "$root" "$entry" || return 1
                    printf '%s\n' "$entry"
                done < <(jq -r '.worktreeAllowlist[]' "$workspace_file")
                return 0
            fi
            if [[ "$resolved_root" == "$resolved_task" ]]; then
                return 0
            fi
        fi
    fi

    automation_worktree_allowlist_file_entries_at "$root"
}

automation_effective_worktree_allowlist_json_at() {
    local root="$1"
    local entries
    entries="$(automation_effective_worktree_allowlist_entries_at "$root")" || return 1
    automation_worktree_allowlist_entries_json "$entries"
}

automation_worktree_path_is_allowlisted() {
    local path="$1"
    local entries="$2"
    local entry

    [[ "$path" == "$AUTOMATION_WORKTREE_ALLOWLIST_RELATIVE_PATH" ]] && return 0
    while IFS= read -r entry; do
        [[ -n "$entry" ]] || continue
        [[ "$path" == "$entry" ]] && return 0
    done <<< "$entries"
    return 1
}

automation_filter_worktree_paths_at() {
    local root="$1"
    local paths="$2"
    local allowlist path

    allowlist="$(automation_effective_worktree_allowlist_entries_at "$root")" || return 1
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        if ! automation_worktree_path_is_allowlisted "$path" "$allowlist"; then
            printf '%s\n' "$path"
        fi
    done <<< "$paths"
    return 0
}

automation_tracked_changed_paths_at() {
    local root="$1"
    local paths
    paths="$(git -C "$root" diff --no-renames --name-only HEAD -- | LC_ALL=C sort -u)" || return 1
    automation_filter_worktree_paths_at "$root" "$paths"
}

automation_untracked_paths_at() {
    local root="$1"
    local paths
    paths="$(git -C "$root" ls-files --others --exclude-standard | LC_ALL=C sort -u)" || return 1
    automation_filter_worktree_paths_at "$root" "$paths"
}

automation_changed_paths_at() {
    local root="$1"
    local tracked untracked

    tracked="$(automation_tracked_changed_paths_at "$root")" || return 1
    untracked="$(automation_untracked_paths_at "$root")" || return 1
    printf '%s\n%s\n' "$tracked" "$untracked" | awk 'NF' | LC_ALL=C sort -u
}

automation_changed_paths() {
    automation_changed_paths_at "$AUTOMATION_ROOT"
}

automation_assert_planning_artifacts_sealed() {
    local task_id="$1"
    local root="${2:-$AUTOMATION_ROOT}"
    local origin_file contract_rel plan_rel contract_path plan_path

    origin_file="$(automation_origin_path "$task_id")"
    [[ -f "$origin_file" ]] || automation_die "origin evidence is missing for $task_id"
    contract_rel="$(jq -er '.contractPath' "$origin_file")"
    plan_rel="$(jq -er '.planPath' "$origin_file")"
    contract_path="$root/$contract_rel"
    plan_path="$root/$plan_rel"

    [[ "$(automation_file_sha256 "$contract_path")" == "$(jq -er '.contractSha256' "$origin_file")" ]] || \
        automation_die "approved contract changed after contract review"
    [[ "$(automation_file_sha256 "$plan_path")" == "$(jq -er '.planSha256' "$origin_file")" ]] || \
        automation_die "approved plan changed after contract review"
}

automation_is_planning_artifact() {
    local task_id="$1"
    local path="$2"
    local origin_file contract_rel plan_rel

    origin_file="$(automation_origin_path "$task_id")"
    [[ -f "$origin_file" ]] || return 1
    contract_rel="$(jq -er '.contractPath' "$origin_file")" || return 1
    plan_rel="$(jq -er '.planPath' "$origin_file")" || return 1
    [[ "$path" == "$contract_rel" || "$path" == "$plan_rel" ]]
}

automation_product_changed_paths_at() {
    local task_id="$1"
    local root="${2:-$AUTOMATION_ROOT}"
    local path

    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        if ! automation_is_planning_artifact "$task_id" "$path"; then
            printf '%s\n' "$path"
        fi
    done < <(automation_changed_paths_at "$root")
}

automation_product_changed_paths_between() {
    local task_id="$1"
    local base="$2"
    local head="$3"
    local root="${4:-$AUTOMATION_ROOT}"
    local path

    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        if ! automation_is_planning_artifact "$task_id" "$path"; then
            printf '%s\n' "$path"
        fi
    done < <(git -C "$root" diff --name-only "$base" "$head" -- | LC_ALL=C sort -u)
}

automation_changed_paths_between() {
    local base="$1"
    local head="$2"
    git -C "$AUTOMATION_ROOT" diff --name-only "$base" "$head" -- | LC_ALL=C sort -u
}

automation_worktree_diff_sha() {
    local root="${1:-$AUTOMATION_ROOT}"
    local tracked_paths untracked_paths path
    tracked_paths="$(automation_tracked_changed_paths_at "$root")" || return 1
    untracked_paths="$(automation_untracked_paths_at "$root")" || return 1
    {
        while IFS= read -r path; do
            [[ -n "$path" ]] || continue
            git -C "$root" diff --binary --no-renames HEAD -- "$path"
        done <<< "$tracked_paths"
        while IFS= read -r path; do
            [[ -n "$path" ]] || continue
            printf 'UNTRACKED %s\0' "$path"
            git -C "$root" hash-object -- "$path"
        done <<< "$untracked_paths"
    } | shasum -a 256 | awk '{print $1}'
}

automation_worktree_diff_stat_at() {
    local root="${1:-$AUTOMATION_ROOT}"
    local tracked_paths path
    local -a paths=()

    tracked_paths="$(automation_tracked_changed_paths_at "$root")" || return 1
    while IFS= read -r path; do
        [[ -n "$path" ]] && paths[${#paths[@]}]="$path"
    done <<< "$tracked_paths"
    if [[ "${#paths[@]}" -gt 0 ]]; then
        git -C "$root" diff --stat --no-renames HEAD -- "${paths[@]}"
    fi
    return 0
}

automation_worktree_patch_at() {
    local root="${1:-$AUTOMATION_ROOT}"
    local tracked_paths untracked_paths path

    tracked_paths="$(automation_tracked_changed_paths_at "$root")" || return 1
    untracked_paths="$(automation_untracked_paths_at "$root")" || return 1
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        git -C "$root" diff --binary --no-renames HEAD -- "$path"
    done <<< "$tracked_paths"
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        git -C "$root" diff --binary --no-index -- /dev/null "$root/$path" || [[ "$?" -eq 1 ]]
    done <<< "$untracked_paths"
    return 0
}

automation_worktree_status_at() {
    local root="${1:-$AUTOMATION_ROOT}"
    local changed_paths path

    changed_paths="$(automation_changed_paths_at "$root")" || return 1
    printf 'branch %s\n' "$(automation_current_branch "$root")"
    while IFS= read -r path; do
        [[ -n "$path" ]] && printf 'changed %s\n' "$path"
    done <<< "$changed_paths"
    return 0
}

automation_worktree_is_clean() {
    local root="${1:-$AUTOMATION_ROOT}"
    local changed_paths
    changed_paths="$(automation_changed_paths_at "$root")" || return 1
    [[ -z "$changed_paths" ]]
}

automation_create_lock_dir() {
    local lock_dir="$1"
    local label="$2"
    local owner_pid=""
    if mkdir "$lock_dir" 2>/dev/null; then
        return 0
    fi

    if [[ -f "$lock_dir/pid" ]]; then
        owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    fi
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
        automation_warn "removing stale $label lock owned by stopped PID $owner_pid"
        rm -f "$lock_dir/pid" "$lock_dir/acquired-at"
        rmdir "$lock_dir" 2>/dev/null || true
        if mkdir "$lock_dir" 2>/dev/null; then
            return 0
        fi
    fi

    automation_die "$label lock is already held${owner_pid:+ by PID $owner_pid}"
}

automation_acquire_lock() {
    local task_id="$1"
    local lock_dir="$AUTOMATION_LOCKS_DIR/$task_id.state.lock"
    automation_ensure_runtime_layout
    automation_create_lock_dir "$lock_dir" "task state $task_id" || return 1
    printf '%s\n' "$$" > "$lock_dir/pid"
    printf '%s\n' "$(automation_now)" > "$lock_dir/acquired-at"
    AUTOMATION_HELD_LOCK="$lock_dir"
}

automation_release_lock() {
    if [[ -n "${AUTOMATION_HELD_LOCK:-}" && -d "$AUTOMATION_HELD_LOCK" ]]; then
        rm -f "$AUTOMATION_HELD_LOCK/pid" "$AUTOMATION_HELD_LOCK/acquired-at"
        rmdir "$AUTOMATION_HELD_LOCK" 2>/dev/null || true
    fi
    AUTOMATION_HELD_LOCK=""
}

automation_acquire_run_lock() {
    local task_id="$1"
    local lock_dir="$AUTOMATION_LOCKS_DIR/$task_id.run.lock"
    automation_ensure_runtime_layout
    automation_create_lock_dir "$lock_dir" "task orchestration $task_id" || return 1
    printf '%s\n' "$$" > "$lock_dir/pid"
    printf '%s\n' "$(automation_now)" > "$lock_dir/acquired-at"
    AUTOMATION_HELD_RUN_LOCK="$lock_dir"
}

automation_release_run_lock() {
    if [[ -n "${AUTOMATION_HELD_RUN_LOCK:-}" && -d "$AUTOMATION_HELD_RUN_LOCK" ]]; then
        rm -f "$AUTOMATION_HELD_RUN_LOCK/pid" "$AUTOMATION_HELD_RUN_LOCK/acquired-at"
        rmdir "$AUTOMATION_HELD_RUN_LOCK" 2>/dev/null || true
    fi
    AUTOMATION_HELD_RUN_LOCK=""
}

automation_repository_lease_dir() {
    printf '%s/repository.workspace.lease\n' "$AUTOMATION_LOCKS_DIR"
}

automation_assert_repository_lease_available() {
    local task_id="$1"
    local lease_dir lease_file owner
    lease_dir="$(automation_repository_lease_dir)"
    lease_file="$lease_dir/lease.json"
    [[ -d "$lease_dir" ]] || return 0
    [[ -f "$lease_file" ]] || {
        automation_die "repository workspace lease is malformed: $lease_dir"
        return 1
    }
    owner="$(jq -er '.taskId' "$lease_file")" || return 1
    [[ "$owner" == "$task_id" ]] || {
        automation_die "repository workspace is leased by $owner"
        return 1
    }
}

automation_acquire_repository_lease() {
    local task_id="$1"
    local source_root="$2"
    local strategy="$3"
    local lease_dir lease_file tmp
    automation_ensure_runtime_layout
    lease_dir="$(automation_repository_lease_dir)"
    lease_file="$lease_dir/lease.json"

    if ! mkdir "$lease_dir" 2>/dev/null; then
        automation_assert_repository_lease_available "$task_id" || return 1
        jq -e \
            --arg taskId "$task_id" \
            --arg sourceRoot "$source_root" \
            --arg strategy "$strategy" \
            '.taskId == $taskId and .sourceRoot == $sourceRoot and .workspaceStrategy == $strategy' \
            "$lease_file" >/dev/null || {
                automation_die "repository workspace lease does not match the current task metadata"
                return 1
            }
        return 0
    fi

    tmp="$(mktemp "$lease_dir/.lease.XXXXXX")"
    jq -n \
        --arg taskId "$task_id" \
        --arg sourceRoot "$source_root" \
        --arg strategy "$strategy" \
        --arg acquiredAt "$(automation_now)" \
        '{taskId: $taskId, sourceRoot: $sourceRoot,
          workspaceStrategy: $strategy, acquiredAt: $acquiredAt}' > "$tmp"
    mv "$tmp" "$lease_file"
}

automation_require_repository_lease() {
    local task_id="$1"
    local source_root="$2"
    local strategy="$3"
    local lease_file
    lease_file="$(automation_repository_lease_dir)/lease.json"
    [[ -f "$lease_file" ]] || {
        automation_die "repository workspace lease is missing for $task_id"
        return 1
    }
    jq -e \
        --arg taskId "$task_id" \
        --arg sourceRoot "$source_root" \
        --arg strategy "$strategy" \
        '.taskId == $taskId and .sourceRoot == $sourceRoot and .workspaceStrategy == $strategy' \
        "$lease_file" >/dev/null || {
            automation_die "repository workspace lease is owned by another task or workspace"
            return 1
        }
}

automation_release_repository_lease() {
    local task_id="$1"
    local lease_dir lease_file owner
    lease_dir="$(automation_repository_lease_dir)"
    lease_file="$lease_dir/lease.json"
    [[ -d "$lease_dir" ]] || return 0
    [[ -f "$lease_file" ]] || {
        automation_die "repository workspace lease is malformed: $lease_dir"
        return 1
    }
    owner="$(jq -er '.taskId' "$lease_file")" || return 1
    [[ "$owner" == "$task_id" ]] || {
        automation_die "cannot release repository workspace lease owned by $owner"
        return 1
    }
    rm -f "$lease_file"
    rmdir "$lease_dir"
}

automation_transition_allowed() {
    local from="$1"
    local to="$2"
    local actor="$3"

    case "$from:$to:$actor" in
        CONTRACT_REVIEW:APPROVED_CONTRACT:human) return 0 ;;
        APPROVED_CONTRACT:PREPARING:orchestrator) return 0 ;;
        PREPARING:PENDING:orchestrator) return 0 ;;
        PREPARING:BLOCKED:orchestrator) return 0 ;;
        APPROVED_CONTRACT:PENDING:human) return 0 ;;
        TEST_FAILED:PENDING:human) return 0 ;;
        BLOCKED:PENDING:human) return 0 ;;
        CHANGES_REQUESTED:PENDING:human) return 0 ;;
        PENDING:CODING:coder-launcher) return 0 ;;
        PENDING:BLOCKED:preflight) return 0 ;;
        PENDING:BLOCKED:coder) return 0 ;;
        PENDING:BLOCKED:orchestrator) return 0 ;;
        CODING:BLOCKED:preflight) return 0 ;;
        CODING:BLOCKED:coder) return 0 ;;
        CODING:BLOCKED:orchestrator) return 0 ;;
        CODING:READY_FOR_REVIEW:quality-gate) return 0 ;;
        CODING:TEST_FAILED:quality-gate) return 0 ;;
        CODING:BLOCKED:quality-gate) return 0 ;;
        READY_FOR_REVIEW:REVIEWING:orchestrator) return 0 ;;
        READY_FOR_REVIEW:BLOCKED:orchestrator) return 0 ;;
        REVIEWING:AWAITING_HUMAN:reviewer) return 0 ;;
        REVIEWING:CHANGES_REQUESTED:reviewer) return 0 ;;
        REVIEWING:BLOCKED:orchestrator) return 0 ;;
        BLOCKED:REVIEWING:human) return 0 ;;
        CHANGES_REQUESTED:CODING:orchestrator) return 0 ;;
        CHANGES_REQUESTED:NEEDS_HUMAN:orchestrator) return 0 ;;
        AWAITING_HUMAN:INTEGRATING:integrator) return 0 ;;
        INTEGRATING:COMPLETED:integrator) return 0 ;;
        INTEGRATING:INTEGRATION_BLOCKED:integrator) return 0 ;;
        PREPARING:ABORTED:human|PENDING:ABORTED:human|CODING:ABORTED:human|READY_FOR_REVIEW:ABORTED:human|REVIEWING:ABORTED:human|CHANGES_REQUESTED:ABORTED:human|AWAITING_HUMAN:ABORTED:human|BLOCKED:ABORTED:human|TEST_FAILED:ABORTED:human|NEEDS_HUMAN:ABORTED:human|INTEGRATION_BLOCKED:ABORTED:human) return 0 ;;
        *) return 1 ;;
    esac
}

automation_initialize_state() {
    local task_id="$1"
    local initial_state="$2"
    local actor="$3"
    local note="$4"
    local state_file evidence_dir tmp now

    automation_ensure_runtime_layout
    state_file="$(automation_state_path "$task_id")"
    [[ ! -e "$state_file" ]] || automation_die "state already exists for $task_id"
    evidence_dir="$(automation_evidence_path "$task_id")"
    mkdir -p "$evidence_dir"
    now="$(automation_now)"
    tmp="$(mktemp "$AUTOMATION_STATE_DIR/.${task_id}.XXXXXX")"
    jq -n \
        --arg taskId "$task_id" \
        --arg state "$initial_state" \
        --arg updatedAt "$now" \
        --arg updatedBy "$actor" \
        --arg note "$note" \
        '{taskId: $taskId, state: $state, revision: 1, updatedAt: $updatedAt, updatedBy: $updatedBy, note: $note}' \
        > "$tmp"
    mv "$tmp" "$state_file"
    jq -nc \
        --arg taskId "$task_id" \
        --arg from "" \
        --arg to "$initial_state" \
        --arg actor "$actor" \
        --arg at "$now" \
        --arg note "$note" \
        '{taskId: $taskId, from: $from, to: $to, actor: $actor, at: $at, note: $note}' \
        >> "$evidence_dir/transitions.jsonl"
}

automation_transition_state() {
    local task_id="$1"
    local expected="$2"
    local next="$3"
    local actor="$4"
    local note="$5"
    local state_file evidence_dir actual revision now tmp

    automation_acquire_lock "$task_id" || return 1
    state_file="$(automation_state_path "$task_id")"
    evidence_dir="$(automation_evidence_path "$task_id")"
    mkdir -p "$evidence_dir"

    if [[ ! -f "$state_file" ]]; then
        automation_release_lock
        automation_die "state does not exist for $task_id"
        return 1
    fi

    actual="$(jq -er '.state' "$state_file")" || {
        automation_release_lock
        automation_die "invalid state file for $task_id"
        return 1
    }
    if [[ "$actual" != "$expected" ]]; then
        automation_release_lock
        automation_die "state mismatch for $task_id: expected $expected, found $actual"
        return 1
    fi
    if ! automation_transition_allowed "$expected" "$next" "$actor"; then
        automation_release_lock
        automation_die "forbidden transition: $expected -> $next by $actor"
        return 1
    fi

    revision="$(jq -er '.revision' "$state_file")"
    revision=$((revision + 1))
    now="$(automation_now)"
    tmp="$(mktemp "$AUTOMATION_STATE_DIR/.${task_id}.XXXXXX")"
    jq \
        --arg state "$next" \
        --argjson revision "$revision" \
        --arg updatedAt "$now" \
        --arg updatedBy "$actor" \
        --arg note "$note" \
        '.state = $state | .revision = $revision | .updatedAt = $updatedAt | .updatedBy = $updatedBy | .note = $note' \
        "$state_file" > "$tmp"
    mv "$tmp" "$state_file"
    jq -nc \
        --arg taskId "$task_id" \
        --arg from "$expected" \
        --arg to "$next" \
        --arg actor "$actor" \
        --arg at "$now" \
        --arg note "$note" \
        '{taskId: $taskId, from: $from, to: $to, actor: $actor, at: $at, note: $note}' \
        >> "$evidence_dir/transitions.jsonl"
    automation_release_lock
    automation_info "$task_id: $expected -> $next"
}

automation_record_json() {
    local destination="$1"
    local tmp
    mkdir -p "$(dirname "$destination")"
    tmp="$(mktemp "$(dirname "$destination")/.record.XXXXXX")"
    cat > "$tmp"
    mv "$tmp" "$destination"
}

automation_append_json() {
    local destination="$1"
    local value
    mkdir -p "$(dirname "$destination")"
    value="$(cat)"
    jq -ce . <<< "$value" >> "$destination"
}

automation_worktree_base() {
    local configured repo_parent repo_name
    configured="$(jq -r '.worktreeBase // ""' "$AUTOMATION_CONFIG")"
    if [[ -n "${AUTOMATION_WORKTREE_BASE:-}" ]]; then
        if [[ "${AUTOMATION_TEST_MODE:-0}" != "1" ]]; then
            automation_die "AUTOMATION_WORKTREE_BASE is reserved for the test suite"
            return 1
        fi
        configured="$AUTOMATION_WORKTREE_BASE"
    fi
    if [[ -z "$configured" ]]; then
        repo_parent="$(dirname "$AUTOMATION_ROOT")"
        repo_name="$(basename "$AUTOMATION_ROOT")"
        configured="$repo_parent/$repo_name-worktrees"
    elif [[ "$configured" != /* ]]; then
        configured="$AUTOMATION_ROOT/$configured"
    fi
    case "$configured/" in
        "$AUTOMATION_ROOT/"*)
            automation_die "worktree base must be outside the source repository: $configured"
            return 1
            ;;
    esac
    printf '%s\n' "$configured"
}

automation_task_branch() {
    local task_id="$1"
    printf 'automation/%s\n' "$(tr '[:upper:]' '[:lower:]' <<< "$task_id")"
}
