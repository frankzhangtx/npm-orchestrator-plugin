#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

shadow=0
source_mode=0
task_id=""
for arg in "$@"; do
    case "$arg" in
        --shadow) shadow=1 ;;
        --source) source_mode=1 ;;
        TASK-*) task_id="$arg" ;;
        *) printf 'Usage: %s [--shadow|--source] [TASK-ID]\n' "$0" >&2; exit 2 ;;
    esac
done
[[ "$shadow" != "1" || "$source_mode" != "1" ]] || automation_die "--shadow and --source are mutually exclusive"

fail_or_warn() {
    if [[ "$shadow" == "1" ]]; then
        automation_warn "$1"
        return 0
    fi
    automation_die "$1"
}

automation_require_layout
automation_require_command git
automation_require_command jq
automation_require_command rg
automation_require_command shasum
if [[ "${AUTOMATION_TEST_MODE:-0}" != "1" ]]; then
    automation_require_command opencode
fi
[[ -x "$AUTOMATION_ROOT/gradlew" ]] || automation_die "gradlew is missing or not executable"

automation_validate_config
workspace_strategy="$(automation_config_value '.workspaceStrategy')"
if [[ "$workspace_strategy" == "isolatedWorktree" ]]; then
    automation_worktree_base >/dev/null
fi

enabled="$(automation_config_value '.enabled')"
mode="$(automation_config_value '.mode')"

[[ "$enabled" == "true" ]] || fail_or_warn "automation is disabled"
[[ "$mode" == "orchestrated" ]] || fail_or_warn "automation mode is $mode, not orchestrated"

if [[ "${AUTOMATION_TEST_MODE:-0}" != "1" ]]; then
    [[ -n "${ANDROID_HOME:-}" ]] || fail_or_warn "ANDROID_HOME is not set; configure the Android SDK environment before running OpenCode"
    if [[ -n "${ANDROID_HOME:-}" ]]; then
        [[ -d "$ANDROID_HOME" ]] || fail_or_warn "ANDROID_HOME does not exist: $ANDROID_HOME"
    fi
fi

if [[ -z "$task_id" ]] && ! automation_worktree_is_clean; then
    fail_or_warn "Git worktree is dirty"
fi

if [[ "$source_mode" == "1" ]]; then
    repository_lease_file="$(automation_repository_lease_dir)/lease.json"
    if [[ -f "$repository_lease_file" ]]; then
        fail_or_warn "repository workspace is leased by $(jq -r '.taskId // "an unknown task"' "$repository_lease_file")"
    elif [[ -d "$(automation_repository_lease_dir)" ]]; then
        fail_or_warn "repository workspace lease is malformed"
    fi
    automation_current_branch >/dev/null
    git -C "$AUTOMATION_ROOT" config user.name >/dev/null || automation_die "Git user.name is not configured"
    git -C "$AUTOMATION_ROOT" config user.email >/dev/null || automation_die "Git user.email is not configured"
fi

if [[ -n "$task_id" ]]; then
    automation_validate_task_id "$task_id"
    "$SCRIPT_DIR/validate-contract.sh" "$task_id"
    workspace_file="$(automation_workspace_path "$task_id")"
    [[ -f "$workspace_file" ]] || fail_or_warn "workspace metadata is missing for $task_id"
    if [[ -f "$workspace_file" ]]; then
        task_root="$(automation_workspace_task_root "$workspace_file")"
        task_strategy="$(automation_workspace_strategy "$workspace_file")"
        source_root="$(jq -er '.sourceRoot' "$workspace_file")"
        task_branch="$(jq -er '.taskBranch' "$workspace_file")"
        baseline_head="$(jq -er '.baselineHead' "$workspace_file")"
        resolved_task_root="$(cd "$task_root" 2>/dev/null && pwd || true)"
        [[ "$resolved_task_root" == "$AUTOMATION_ROOT" ]] || fail_or_warn "run must occur in the recorded task root: $task_root"
        [[ "$(automation_current_branch)" == "$task_branch" ]] || fail_or_warn "current branch does not match task branch: $task_branch"
        [[ "$(git -C "$AUTOMATION_ROOT" rev-parse HEAD)" == "$baseline_head" ]] || fail_or_warn "task HEAD changed outside the deterministic integrator"
        planning_commit_policy="$(jq -r '.planningArtifactsCommitPolicy // "legacyCommittedSeparately"' "$workspace_file")"
        if [[ "$planning_commit_policy" == "withProductChanges" ]]; then
            automation_assert_planning_artifacts_sealed "$task_id" "$AUTOMATION_ROOT" || \
                fail_or_warn "approved planning artifact validation failed for $task_id"
            pending_path_count=0
            while IFS= read -r pending_path; do
                [[ -n "$pending_path" ]] || continue
                pending_path_count=$((pending_path_count + 1))
                automation_is_planning_artifact "$task_id" "$pending_path" || \
                    fail_or_warn "unexpected change exists before Coder starts: $pending_path"
                if git -C "$AUTOMATION_ROOT" ls-files --error-unmatch -- "$pending_path" >/dev/null 2>&1; then
                    fail_or_warn "planning artifact was committed before product changes: $pending_path"
                fi
            done < <(automation_changed_paths)
            [[ "$pending_path_count" -eq 2 ]] || fail_or_warn "task must start with exactly two sealed, uncommitted planning artifacts"
        elif ! automation_worktree_is_clean; then
            fail_or_warn "Git worktree is dirty"
        fi
        if [[ "$task_strategy" == "inPlaceExclusive" ]]; then
            [[ "$task_root" == "$source_root" ]] || fail_or_warn "in-place task root must equal the recorded source root"
        elif [[ "$task_strategy" == "isolatedWorktree" ]]; then
            [[ "$task_root" != "$source_root" ]] || fail_or_warn "isolated task root must differ from the source root"
        else
            fail_or_warn "unsupported workspace strategy: $task_strategy"
        fi
        if [[ "$(jq -r '.repositoryLeaseRequired // false' "$workspace_file")" == "true" ]]; then
            automation_require_repository_lease "$task_id" "$source_root" "$task_strategy" || \
                fail_or_warn "repository workspace lease validation failed for $task_id"
        fi
    fi
fi

if [[ "${AUTOMATION_TEST_MODE:-0}" == "1" ]]; then
    automation_info "test mode: OpenCode discovery checks skipped"
else
    discovery_dir="$(mktemp -d "${TMPDIR:-/tmp}/opencode-android-orchestrator-preflight.XXXXXX")"
    trap 'rm -rf "$discovery_dir"' EXIT

    if ! opencode debug config > "$discovery_dir/config.json" 2> "$discovery_dir/config.err"; then
        automation_die "OpenCode resolved config failed; see $discovery_dir/config.err"
    fi
    superpowers_pin="$(jq -r '.plugins.superpowers' "$AUTOMATION_CONFIG")"
    rg -F "$superpowers_pin" "$discovery_dir/config.json" >/dev/null || automation_die "resolved OpenCode config is missing pinned Superpowers"

    if ! opencode debug skill > "$discovery_dir/skills.txt" 2> "$discovery_dir/skills.err"; then
        automation_die "OpenCode skill discovery failed; see $discovery_dir/skills.err"
    fi
    while IFS= read -r skill; do
        rg -F "\"$skill\"" "$discovery_dir/skills.txt" >/dev/null || \
            rg -F "$skill" "$discovery_dir/skills.txt" >/dev/null || \
            automation_die "required skill is not discoverable: $skill"
    done < <(jq -r '.requiredSkills[]' "$AUTOMATION_CONFIG")

    opencode debug agent scheduled-coder > "$discovery_dir/coder-agent.json" 2> "$discovery_dir/coder-agent.err" || \
        automation_die "scheduled-coder agent is not discoverable"
    opencode debug agent scheduled-reviewer > "$discovery_dir/reviewer-agent.json" 2> "$discovery_dir/reviewer-agent.err" || \
        automation_die "scheduled-reviewer agent is not discoverable"
    opencode debug agent scheduled-planner > "$discovery_dir/planner-agent.json" 2> "$discovery_dir/planner-agent.err" || \
        automation_die "scheduled-planner agent is not discoverable"

    jq -e '
        def last_rule($permission; $pattern):
            [.permission[] | select(.permission == $permission and .pattern == $pattern) | .action][-1];
        (last_rule("*"; "*") == "deny") and
        (last_rule("edit"; "docs/plans/**") == "allow") and
        (last_rule("edit"; "automation/tasks/**") == "allow") and
        (last_rule("edit"; "**/src/**") == "deny") and
        (last_rule("bash"; "./scripts/automation/prepare-contract-review.sh *") == "allow") and
        (last_rule("bash"; "./scripts/automation/approve-and-run.sh *") == "allow") and
        (last_rule("bash"; "./scripts/automation/resume-review.sh *") == "allow") and
        (last_rule("bash"; "./scripts/automation/accept-and-integrate.sh *") == "allow") and
        (last_rule("bash"; "./scripts/automation/abort-task.sh *") == "allow") and
        (last_rule("android_orchestrator_status"; "*") == "allow") and
        (last_rule("android_orchestrator_doctor"; "*") == "allow") and
        (last_rule("schedule_job"; "*") == "deny") and
        (last_rule("task"; "*") == "deny") and
        (.tools.question == true) and
        (.tools.android_orchestrator_status == true) and
        (.tools.android_orchestrator_doctor == true) and
        (.tools.schedule_job == false) and
        (.tools.task == false)
    ' "$discovery_dir/planner-agent.json" >/dev/null || automation_die "scheduled-planner resolved permissions are unsafe"

    jq -e '
        def last_rule($permission; $pattern):
            [.permission[] | select(.permission == $permission and .pattern == $pattern) | .action][-1];
        (last_rule("*"; "*") == "deny") and
        (last_rule("edit"; "**/src/main/**") == "allow") and
        (last_rule("edit"; ".opencode/skills/**") == "deny") and
        (last_rule("android_orchestrator_status"; "*") == "allow") and
        (last_rule("android_orchestrator_doctor"; "*") == "allow") and
        (last_rule("schedule_job"; "*") == "deny") and
        (last_rule("task"; "*") == "deny") and
        (.tools.android_orchestrator_status == true) and
        (.tools.android_orchestrator_doctor == true) and
        (.tools.schedule_job == false) and
        (.tools.delete_job == false) and
        (.tools.task == false)
    ' "$discovery_dir/coder-agent.json" >/dev/null || automation_die "scheduled-coder resolved permissions are unsafe"

    jq -e '
        def last_rule($permission; $pattern):
            [.permission[] | select(.permission == $permission and .pattern == $pattern) | .action][-1];
        (last_rule("*"; "*") == "deny") and
        (last_rule("edit"; "*") == "deny") and
        (last_rule("android_orchestrator_status"; "*") == "allow") and
        (last_rule("android_orchestrator_doctor"; "*") == "allow") and
        (last_rule("schedule_job"; "*") == "deny") and
        (last_rule("task"; "*") == "deny") and
        (.tools.android_orchestrator_status == true) and
        (.tools.android_orchestrator_doctor == true) and
        (.tools.schedule_job == false) and
        (.tools.delete_job == false) and
        (.tools.task == false)
    ' "$discovery_dir/reviewer-agent.json" >/dev/null || automation_die "scheduled-reviewer resolved permissions are unsafe"
fi

automation_info "preflight completed (mode=$mode, shadow=$shadow, source=$source_mode${task_id:+, task=$task_id}, sdk=${ANDROID_HOME:-unset})"
