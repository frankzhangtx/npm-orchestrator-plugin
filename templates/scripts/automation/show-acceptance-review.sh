#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
[[ "$#" -eq 1 ]] || { printf 'Usage: %s TASK-ID\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
[[ "$(automation_read_state "$task_id")" == "AWAITING_HUMAN" ]] || automation_die "$task_id is not AWAITING_HUMAN"

workspace_file="$(automation_workspace_path "$task_id")"
evidence_dir="$(automation_evidence_path "$task_id")"
ready_file="$evidence_dir/ready.json"
review_file="$evidence_dir/review.json"
report_file="$evidence_dir/acceptance-report.json"
[[ -f "$workspace_file" && -f "$ready_file" && -f "$review_file" ]] || \
    automation_die "acceptance evidence is incomplete"

task_root="$(automation_workspace_task_root "$workspace_file")"
[[ -d "$task_root" ]] || automation_die "recorded task root is missing: $task_root"
source_root="$(jq -er '.sourceRoot' "$workspace_file")"
original_branch="$(jq -er '.originalBranch' "$workspace_file")"
live_original_head="$(git -C "$source_root" rev-parse "refs/heads/$original_branch")"

if [[ ! -f "$report_file" ]] || \
   [[ "$(jq -r '.originalHeadCurrent // ""' "$report_file" 2>/dev/null || true)" != "$live_original_head" ]]; then
    (
        cd "$task_root"
        ./scripts/automation/acceptance-report.sh "$task_id" >/dev/null
    )
fi

[[ "$(jq -er '.taskId' "$report_file")" == "$task_id" ]] || automation_die "acceptance report task ID does not match"
[[ "$(jq -er '.state' "$report_file")" == "AWAITING_HUMAN" ]] || automation_die "acceptance report is not awaiting human review"
[[ "$(jq -er '.decision' "$review_file")" == "APPROVED" ]] || automation_die "latest independent review is not approved"

current_diff_sha="$(automation_worktree_diff_sha "$task_root")"
report_diff_sha="$(jq -er '.sealedDiffSha256' "$report_file")"
[[ "$current_diff_sha" == "$report_diff_sha" ]] || automation_die "sealed diff changed after the acceptance package was generated"
[[ "$current_diff_sha" == "$(jq -er '.diffSha256' "$ready_file")" ]] || automation_die "sealed diff no longer matches the quality gate"
[[ "$current_diff_sha" == "$(jq -er '.diffSha256' "$review_file")" ]] || automation_die "sealed diff no longer matches independent review"

changed_count="$(jq -er '.changedPaths | length' "$report_file")"
max_changed_files="$(jq -er '.maxChangedFiles' "$report_file")"
device_tests_required="$(jq -r '.deviceTestsRequired' "$report_file")"

printf '# 🔔 人工验收提醒\n\n'
printf '自动执行已停在 `AWAITING_HUMAN`。下面内容已重新核对 sealed diff；此时代码、计划与任务合同均尚未提交或集成。\n\n'
printf '| 绑定项 | 当前封存值 |\n'
printf '| --- | --- |\n'
printf '| 任务 | `%s` · %s |\n' "$task_id" "$(jq -r '.title' "$report_file")"
printf '| 原分支 | `%s` |\n' "$(jq -r '.originalBranch' "$report_file")"
printf '| 原分支当前 HEAD | `%s` |\n' "$(jq -r '.originalHeadCurrent' "$report_file")"
printf '| 原分支漂移 | `%s` |\n' "$(jq -r 'if .originalBranchDrifted then "是（集成将阻断）" else "否" end' "$report_file")"
printf '| 任务分支收尾 | 成功集成后自动删除；失败或阻塞时保留 |\n'
printf '| sealed diff SHA | `%s` |\n' "$report_diff_sha"
printf '| 变更范围 | 实际 %s 个 / 合同上限 %s 个 |\n' "$changed_count" "$max_changed_files"
printf '| 提交策略 | 代码、测试、计划与任务合同合并为一个提交 |\n'
printf '| 自动证据 | Baseline ✓ · RED ✓ · G1–G6 ✓ · Reviewer APPROVED ✓ |\n'
printf '\n## 必须重点复核\n\n'
printf '### P0 · 真实行为是否满足合同\n\n'
printf '这是人工验收的核心；请按以下条件实际操作或检查结果，不要只看测试为绿：\n\n'
jq -r '.acceptanceCriteria | to_entries[] | "\(.key + 1). \(.value)"' "$report_file"

printf '\n### P0 · 旧行为与范围是否被误伤\n\n'
printf '**实际变更文件：**\n\n'
jq -r '.changedPaths[] | "- `\(.)`"' "$report_file"
printf '\n**随产品变更一并提交的封存规划文件（不计入合同文件上限）：**\n\n'
jq -r '.planningArtifacts[] | "- `\(.)`"' "$report_file"
printf '\n**合同允许路径：**\n\n'
jq -r '.allowedPaths[] | "- `\(.)`"' "$report_file"
printf '\n**明确不应发生：**\n\n'
jq -r '.nonGoals[] | "- \(.)"' "$report_file"

printf '\n### P1 · 自动证据是否可信\n\n'
printf -- '- RED 退出码：`%s`（应为非 0，证明测试先真实失败）\n' "$(jq -r '.evidence.redExitCode' "$report_file")"
printf -- '- 质量门：`%s`，第 %s 个编码周期内共运行 %s 次\n' \
    "$(jq -r '.evidence.qualityGate' "$report_file")" \
    "$(jq -r '.evidence.codingCycle' "$report_file")" \
    "$(jq -r '.evidence.gateAttempts' "$report_file")"
printf -- '- Reviewer：`%s`，独立复验退出码 `%s`\n' \
    "$(jq -r '.evidence.reviewerDecision' "$report_file")" \
    "$(jq -r '.evidence.reviewerVerificationExitCode' "$report_file")"
printf -- '- Reviewer 摘要：%s\n' "$(jq -r '.reviewSummary' "$report_file")"
printf -- '- 聚焦测试：\n'
jq -r '.targetTests[] | "  - `\(.)`"' "$report_file"

printf '\n### P1 · 绑定与剩余风险\n\n'
printf -- '- 当前 diff 与质量门、独立 Review、验收包的 SHA 三方一致。\n'
printf -- '- 目标接收分支是 `%s`；通过后只做本地集成，`pushed: false`。\n' "$(jq -r '.originalBranch' "$report_file")"
printf -- '- 原分支安全到达已验证提交后，本地任务分支 `%s` 将被自动删除；集成失败时保留以便恢复。\n' \
    "$(jq -r '.taskBranch' "$report_file")"
if [[ "$(jq -r '.originalBranchDrifted' "$report_file")" == "true" ]]; then
    printf -- '- **原分支已偏离批准基线；当前策略会进入 `INTEGRATION_BLOCKED`，不会自动 cherry-pick。**\n'
fi
if [[ "$device_tests_required" == "true" ]]; then
    printf -- '- 合同要求设备测试，自动质量门已执行；仍应人工确认真机/模拟器上的可观察体验。\n'
else
    printf -- '- 合同未要求设备测试。如果变更涉及 UI、系统权限或真机差异，请在通过前补做人工体验。\n'
fi
printf -- '- 测试策略：`%s`。%s\n' \
    "$(jq -r '.testPolicy' "$report_file")" \
    "$(jq -r '.testPolicyReason' "$report_file")"

printf '\n## 你的决定\n\n'
printf -- '- 全部重点通过：选择 **验收通过，提交到原分支。**\n'
printf -- '- 任一项不通过：选择 **验收不通过，需要说明失败项**，并指出失败的验收条件或观察结果。\n'
printf -- '- 还未检查完：选择 **暂不决定，保持封存**；系统继续停在 `AWAITING_HUMAN`。\n'
printf '\n> 不要修改已封存的任务目录后沿用本次验收；diff 一旦变化，脚本会拒绝旧验收。\n'
