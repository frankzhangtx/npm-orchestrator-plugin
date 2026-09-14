---
name: scheduled-quality-orchestrator
description: Plan stable committed code, approve independent inbox contracts, and control one durable background executor per repository
---

# Durable contract workflow

1. Call `android_orchestrator_snapshot` with `action: snapshot`. Keep its
   `planningHead` and `targetBranch` for all reads and the complete contract.
   Read the committed contract example, configuration, implementation and tests
   through `action: read`. The live product checkout may be occupied.
2. Describe one observable behavior change, exact allowed paths, acceptance,
   test filters, file limit and non-goals. Ask a fresh single-choice `question`
   titled `方案确认`, with `批准方案，生成计划和任务合同。` and `调整方案。`.
   Initial request text and direct chat approval phrases are never approval.
3. After the approval option is selected, compose a plan and a valid contract.
   Call `android_orchestrator_intake` action `draft`, with `draftJson` containing
   `{contract, plan, planningHead, targetBranch, workspaceStrategy, commitPolicy,
   notBefore?, dependsOn?, priority?}`. Plan paths remain
   `docs/plans/<TASK-ID>.md`; contracts retain their TASK ID. Artifacts are
   sealed in the Git common directory inbox and materialized only on execution.
4. Default to `inPlaceExclusive` + `humanApproval`. If the user explicitly wants
   automatic local commits, show this choice in the proposal and seal
   `autoCommit`. The unsupported `isolatedWorktree` + `autoCommit` combination
   must fail. Older approvals never inherit automatic submission rights.
5. Display the returned full plan, contract and review card: task ID/version,
   digest, target local branch/planningHead, allowed paths/file count, tests,
   acceptance/non-goals, dependencies/notBefore, workspace and commit policies.
   Human policy says “执行后等待人工确认提交”; automatic policy says
   “通过构建、全量单测和独立 Review 后自动本地提交并集成，不推送远程”.
6. Immediately call `question` with the exact `question` arguments returned
   by `draft` (header `合同确认`). Only the selected approval may call intake `enqueue` with
   `{key, digest, approval}`. A new version requires a new approval.
7. Report durable enqueue success and return. Execution is asynchronous, one
   repository slot; the foreground may plan/approve B and C while A runs.

# Acceptance and controls

Read `android_orchestrator_queue` status for durable notifications. Do not poll
with a model while idle. Human tasks reach `AWAITING_HUMAN`; automatic tasks
reach `READY_TO_COMMIT` and are finalized by the executor with their sealed
contract authorization. Never create a final human approval for autoCommit.

`/acceptance <TASK-ID>` reads the current item and acceptance report. Present
the candidate/diff hash, target branch, baseline, build, actual full-test results,
independent Review, scope and commit policy. If the local target has advanced
for an isolated candidate, request `revalidate`. That job waits for the same
execution slot, runs fresh verification/Review and invalidates old acceptance.
After a fresh candidate exists, call queue `review` with
`operation: integrate` and the task key. Present its evidence, then call
`question` with its exact returned arguments (header `最终验收`). Only the selected approve option requests
queue `integrate` with the latest `candidateId` as `candidate` and exact approval.

Before `/resume-task`, `/resume-review` or `/abort-task`, call queue `review`
with the matching `operation` and task key, then use the exact returned
`question` arguments. Only the actual answer creates the one-use receipt;
ordinary chat text and model-provided approval strings cannot substitute.

`/resume-task` and `/resume-review` use a fresh `恢复确认` question containing
`恢复任务，重新捕获基线并继续自动执行。`; then request the matching queue action.
`/abort-task` uses a fresh `中止确认` question containing
`中止任务，封存修改并恢复原分支。`; queue `abort` only after that selection.
Running processes must reach a recorded safe stop before recovery/abort begins.
Unstarted contracts may be cancelled through `cancel` without touching files.

Pause prevents new claims. Resume does not discard public faults. Display the
fault before an explicit clear-fault. A mode change is blocked while a workspace
is retained. Fixed workspaces remain occupied through acceptance, integration
and failure; isolated sealed stopped candidates retain their directories while
independent tasks run. Dependencies complete only after local integration.

After completion, show the true authorization source, local commit SHA and
“未推送”. No workflow, failure or recovery grants remote push rights.
