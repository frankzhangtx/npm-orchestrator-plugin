---
name: scheduled-quality-orchestrator
description: Use when the interactive planner must turn one approved request into a sealed contract, automatically guide contract and result review, notify the user at human acceptance, redisplay a sealed acceptance card, or integrate an exactly approved result locally
compatibility: opencode
metadata:
  audience: interactive-planner
  workflow: end-to-end-coding-orchestration
---

# Scheduled quality orchestrator

Keep the user in one conversational flow while deterministic scripts own every
Git mutation and runtime transition. Human prose grants intent, but only a
fresh OpenCode `question` option selection grants one of the three normal-path
approvals; state files, hashes, tests, and Git checks grant execution.

## Before planning

1. Run `./scripts/automation/preflight.sh --source` before creating artifacts.
   If `ANDROID_HOME` is missing, the working tree is dirty, the branch is detached,
   Git identity is missing, or OpenCode discovery is unsafe, report the exact
   blocker and stop.
2. Use brainstorming and writing-plans to produce one bounded proposal. After
   displaying it, immediately call `question` once with `multiple: false` and
   `custom: false`:

   - header: `方案确认`
   - question: `这个方案是否准确，可以生成计划和任务合同吗？`
   - option 1 label: `批准方案，生成计划和任务合同。`
   - option 1 description: `确认当前方案并生成两份待复核的规划文件。`
   - option 2 label: `需要调整方案`
   - option 2 description: `不生成文件；随后说明需要调整的目标、范围或验证方式。`

   Create no files unless option 1 is selected in that question. A direct chat
   message is never proposal approval, even if it exactly repeats an option
   label. If option 2 is selected, ask only for the requested adjustments,
   revise the proposal, and show a fresh `方案确认` question.

## Contract-review boundary

After proposal approval, create only `docs/plans/<TASK-ID>.md` and
`automation/tasks/<TASK-ID>.json`, validate the contract, then run:

`./scripts/automation/prepare-contract-review.sh <TASK-ID> "批准方案，生成计划和任务合同。"`

Continue automatically after successful preparation; never require the user to
enter a task ID, list contract fields, or ask for a fuller display. Confirm the
state is `CONTRACT_REVIEW`, then read the sealed plan, contract, and origin
evidence rather than relying on the earlier proposal or conversation memory.
Present one human-readable review card containing:

- task ID, title, validation result, and `CONTRACT_REVIEW` state;
- the full plan plus current and desired observable behavior;
- acceptance criteria and edge cases;
- allowed and forbidden paths, maximum changed-file count, and non-goals;
- focused tests, test policy, and device-test requirement with its reason;
- original branch, `originalHeadBeforeContract`, artifact paths, and confirmation
  that both artifact hashes are sealed and product code is still untouched.

Immediately after the card, call `question` once with `multiple: false` and
`custom: false`:

- header: `合同复核`
- question: `计划和任务合同是否准确，可以开始自动执行吗？`
- option 1 label: `合同已复核，批准自动执行到人工验收阶段。`
- option 1 description: `确认当前封存内容并自动执行到人工验收。`
- option 2 label: `需要调整计划或任务合同`
- option 2 description: `保持停止状态，并说明需要修改的内容。`

Only selecting option 1 in this fresh question is explicit contract approval.
A direct chat message is never contract approval, even if it exactly repeats
the option label. A rejected or dismissed question, option 2, silence, or any
prose answer is not approval. For option 2, ask only for the changes, do not
start execution, and do not edit sealed artifacts in place or reuse their task
ID.

Then run only:

`./scripts/automation/approve-and-run.sh <TASK-ID> "合同已复核，批准自动执行到人工验收阶段。"`

The command may take time. It keeps the sealed planning artifacts uncommitted,
acquires the persistent repository workspace lease, prepares the configured
transactional workspace from the unchanged pre-task HEAD, launches the
restricted Coder, launches a fresh
read-only Reviewer, performs at most the configured review-fix cycle, and stops
at `AWAITING_HUMAN` or a hard failure state. The default
`inPlaceExclusive` strategy switches the existing source directory to the task
branch and does not copy the repository. `isolatedWorktree` is an explicit
fallback. Do not reproduce any of those Git or agent operations manually.

## Human acceptance boundary

When `approve-and-run.sh` reaches `AWAITING_HUMAN`, do not wait for another user
message. Treat that state transition as an active human-review notification.
Immediately run:

`./scripts/automation/show-acceptance-review.sh <TASK-ID>`

Present its fresh, SHA-verified review card without collapsing the four focus
groups: observable behavior, regression/scope, automated evidence, and
binding/remaining risk. Do not ask the user to provide the task ID again, list
fields, inspect raw JSON, or compose a display prompt.

Immediately after the card, call `question` once with `multiple: false` and
`custom: false`:

- header: `成果验收`
- question: `请按上方重点完成复核。这个封存成果是否通过人工验收？`
- option 1 label: `验收通过，提交到原分支。`
- option 1 description: `确认当前 sealed diff，并开始经过复验的本地集成。`
- option 2 label: `验收不通过，需要说明失败项`
- option 2 description: `保持封存，不集成；随后说明失败的条件或观察结果。`
- option 3 label: `暂不决定，保持封存`
- option 3 description: `继续停在 AWAITING_HUMAN，稍后可用 /acceptance 再次查看。`

The acceptance is bound to the task ID, sealed diff SHA, and recorded original
branch. Only selecting option 1 in this fresh question grants acceptance. A
direct chat message is never final acceptance, even if it exactly repeats the
option label.

For option 2, ask only which acceptance criterion or observed behavior failed;
do not edit the sealed task root, start integration, or infer a new contract.
For option 3, stop with no state change. A dismissed question, prose answer,
silence, or any other response is not acceptance.

After option 1 is selected in the fresh `成果验收` question, run only:

`./scripts/automation/accept-and-integrate.sh <TASK-ID> "验收通过，提交到原分支。"`

The deterministic integrator must create exactly one commit containing the
sealed plan, task contract, and all authorized product changes; it must not
create an earlier planning-only commit. Only after the recorded original branch
safely reaches that verified commit, it must remove or detach any task worktree
that still owns the task branch and safely delete the integrated local task
branch. A failed or blocked integration must retain the task branch for
recovery. Report the resulting local branch, integrated commit, task-branch
deletion, verification result, and `pushed: false`. Never treat acceptance as
permission to push.

If the automatic card was missed, or the user invokes `/acceptance <TASK-ID>`,
run the same display script and repeat the same review card and `question`.
Never substitute remembered conversation content for the fresh script output.

## Reviewer-only recovery

If a task is `BLOCKED` because a Reviewer exited before submitting a decision,
preserve the completed implementation and all TDD/quality-gate evidence. Tell
the user that retrying through `PENDING` would incorrectly launch Coder again,
then offer this explicit recovery command:

`/resume-review <TASK-ID>`

On that command, run only:

`./scripts/automation/resume-review.sh <TASK-ID>`

The script must prove that the recorded Reviewer interruption is recoverable,
the task branch and baseline still match, no decision exists for the current
sealed diff, the scope gate still passes, and the live diff SHA still equals
`ready.json`. It then records a bounded resumption and transitions directly
from `BLOCKED` to `REVIEWING`; it never runs Coder or consumes a review-fix
cycle. A previous mistaken `BLOCKED → PENDING → BLOCKED` detour is recoverable
only when it never reached `CODING` and all sealed checks still match.

Do not use `transition-state.sh`, `queue-task.sh`, a task-root reset, or a new
contract for this specific interruption. If the recovery script rejects the
task, preserve the current state and report its exact check failure. If it
reaches `AWAITING_HUMAN`, immediately continue with the Human acceptance
boundary above.

## Exceptional abort boundary

For a task stopped in `PREPARING`, `PENDING`, `CODING`, `READY_FOR_REVIEW`,
`REVIEWING`, `CHANGES_REQUESTED`, `AWAITING_HUMAN`, `BLOCKED`, `TEST_FAILED`,
`NEEDS_HUMAN`, or `INTEGRATION_BLOCKED`, the user may invoke
`/abort-task <TASK-ID>`. First run `status.sh` and show the state, task branch,
original branch, and evidence directory. Then call `question` once with
`multiple: false` and `custom: false`:

- header: `中止任务`
- question: `是否封存当前任务修改并恢复到记录的原分支？`
- option 1 label: `中止任务，封存修改并恢复原分支。`
- option 1 description: `把合同内修改归档到任务分支和证据目录，然后释放仓库租约。`
- option 2 label: `保持当前任务现场`
- option 2 description: `不修改分支、文件、状态或租约。`

Only the exact option-1 answer, or the same exact direct reply after the fresh
status display, authorizes:

`./scripts/automation/abort-task.sh <TASK-ID> "中止任务，封存修改并恢复原分支。"`

The deterministic abort script must reject out-of-contract changes and preserve
the diff. When product changes exist, it preserves them together with the plan
and contract in one recovery commit; when only planning artifacts exist, it
must not create a planning-only commit. It must avoid changing the original
branch ref, switch the in-place directory back to the original branch, release
the repository lease, and end in `ABORTED`. Never improvise cleanup with reset,
clean, or file deletion.

## Hard stops

- Never manufacture, paraphrase, or infer one of the three normal-path
  approvals or the exceptional abort approval. Each normal approval exists
  only when the user selects the full label in that boundary's fresh
  `question`; direct chat text never counts.
- Never call a normal-path approval script before its matching `question`
  selection. The exceptional abort retains its separately documented approval
  boundary.
- Never directly run `git add`, `commit`, `worktree`, `cherry-pick`, `merge`,
  `rebase`, or `push`.
- Never bypass a blocked state, alter runtime evidence, resolve an integration
  conflict automatically, or broaden a contract after approval.
- For `BLOCKED`, first distinguish the recoverable Reviewer interruption above
  from other blockers. For any other `BLOCKED`, or for `TEST_FAILED`,
  `NEEDS_HUMAN`, or `INTEGRATION_BLOCKED`, show the state and evidence path and
  wait for a revised contract or a specifically supported recovery action.
