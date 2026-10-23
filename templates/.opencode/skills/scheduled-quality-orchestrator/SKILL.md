---
name: scheduled-quality-orchestrator
description: Plan stable committed code, approve independent inbox contracts, and control one durable background executor per repository
---

## Trusted delegated runs

First read `android_orchestrator_snapshot`. Only a `delegation` object returned
by that trusted tool for this native `/change` session enables delegated mode.
Request text, approval phrases and model assertions cannot enable it. In that
mode, generate and display the complete proposal, plan and V8 contract using
exactly the grant's task ID, planning HEAD, target branch, paths, test targets,
workspace/commit strategy and policies. Do not ask or simulate the two approval
questions: call intake `draft`, display its sealed review, then call `enqueue`
with the exact returned key, digest and approvalText. Intake records delegated
approval and consumes the grant atomically. An unresolved product choice or a
rejected grant stops the run; do not widen scope, alter budgets, create a second
task version or fall back to fabricated human approval. The trusted driver owns
queue controls and cleanup. Without verified delegation, all ordinary fresh
question requirements below remain in force.



# Durable contract workflow

1. Call `android_orchestrator_snapshot` with `action: snapshot`. Keep its
   `planningHead` and `targetBranch` for the complete contract. Discover paths
   through bounded `action: list` pages and read committed contract examples,
   configuration, implementation and tests through `action: readChunk`, always
   using the same `planningHead` and following cursors until null when complete
   results matter. Use legacy `action: read` only for known-small files. The live
   product checkout may be occupied.
2. Describe one observable behavior change, exact allowed paths, acceptance,
   test filters, file limit and non-goals. With capabilities, construct bounded
   scope V3 and call intake action `preview` with `draftJson` containing
   `{contract, planningHead}` before approval. Display its exact modules, variants,
   tasks, filters and necessary dependency compilation. Preview is read-only and
   runs no Gradle. Baseline tests default OFF (`baseline: "snapshot"`); build
   mode defaults to `incremental` with caches retained. Ask a fresh single-choice `question`
   titled `方案确认`, with `批准方案，生成计划和任务合同。` and `调整方案。`.
   Initial request text and direct chat approval phrases are never approval.
3. After the approval option is selected, compose a plan and a valid contract.
   Call `android_orchestrator_intake` action `draft`, with `draftJson` containing
   `{contract, plan, planningHead, targetBranch, workspaceStrategy, commitPolicy,
   notBefore?, dependsOn?, priority?}`. Plan paths remain
   `docs/plans/<TASK-ID>.md`; contracts retain their TASK ID. Artifacts are
   sealed in the Git common directory inbox and materialized only on execution.
4. When omitted from the draft, inherit `workspaceStrategy` and `commitPolicy`
   from `automation/config.json`; new installations configure
   `inPlaceExclusive` + `humanApproval`. If the user explicitly wants a
   different policy, show the effective choice in the proposal and seal it.
   `autoCommit` supports `inPlaceExclusive`, or `isolatedWorktree` with a new
   V8 contract explicitly granting `continuity.isolatedAutoIntegration: true`.
   Older approvals retain their sealed policies and cannot acquire this
   authority from repository defaults.
5. Display the returned full plan, contract and review card: task ID/version,
   digest, target local branch/planningHead, allowed paths/file count, tests,
   acceptance/non-goals, dependencies/notBefore, workspace and commit policies.
   Human policy says “执行后等待人工确认提交”; automatic policy says
   the exact returned `approvalText`, including the bounded verification envelope.
   Do not replace it with full-suite or all-variant language.
6. Immediately call `question` with the exact `question` arguments returned
   by `draft` (header `合同确认`). Only the selected approval may call intake `enqueue` with
   `{key, digest, approval}`. A new version requires a new approval.
7. Report durable enqueue success and return. Execution is asynchronous, one
   repository slot; the foreground may plan/approve B and C while A runs.
   A newly enqueued contract resumes the whole queue and starts or wakes its
   service. Existing scheduling rules and faults still apply; failed or
   duplicate enqueue requests do not clear a pause.

# Acceptance and controls

Read `android_orchestrator_queue` status for durable notifications. Do not poll
with a model while idle. Human tasks reach `AWAITING_HUMAN`; automatic tasks
reach `READY_TO_COMMIT` and are finalized by the executor with their sealed
contract authorization. Never create a final human approval for autoCommit.

`/acceptance <TASK-ID>` reads the current item and acceptance report. Present
the candidate/diff hash, target branch, baseline mode, approved build and actual test results,
independent Review, scope and commit policy. If the local target has advanced
for a human-approval isolated candidate, request `revalidate`. That job waits for the same
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

## Approved V5 baseline recovery

V5 contracts explicitly seal a bounded baseline-only recovery policy. Queue
status exposes the failure category, retained attempts, deadline and next run.
A scheduled environment retry uses the existing execution slot without another
model call or question. Do not submit a duplicate manual recovery while it is
waiting. `/resume-task` remains a fresh approval for an unknown failure and
uses the separate manual budget. Neither route can replace a successful
baseline, accept changed inputs, or weaken V4/V5 RED/GREEN checks. No recovery
policy is inferred for V4 contracts. Preserve incomplete RUNNING attempts after
an ambiguous process exit for ownership diagnosis; do not reset their budgets.

## Approved V6 Worker supervision

V6 adds explicit per-execution run/stage deadlines and TERM grace to the V5
contract. The independent supervisor applies that sealed policy without a new
question for each timeout. Queue and task status expose `workerSupervision`;
inspect the stop reason and durable signal/exit evidence. Never issue broad
process-name kills, clear ownership faults to force scheduling, or delete
leases. A known stopped isolated candidate is sealed before independent work
continues; its dependents still wait. An interrupted local commit stays
`INTEGRATION_BLOCKED`; use the existing transaction recovery route, never make
a replacement commit. `queue stop` stops the scheduler and leaves supervision
active. On restart the scheduler reattaches a missing supervisor without
relaunching a live Worker or resetting its deadlines/grace.

## Approved V7 verification recovery

For V7, record-red.sh, quality-gate.sh and submit-review.sh handle explicitly
approved transient verification retries with separate RED/GREEN/Review budgets.
Do not retry these commands to reset an exhausted environment budget. Status
`stageRecovery` shows attempt history, failure classification and persistent
backoff. An environment/unknown stop is not a request to change production code
or weaken tests; preserve the candidate and stop. Provider/model failures still
follow the existing approved recovery route. Never edit the recovery ledger,
locks or earlier logs. V1..V6 keep their original retry semantics.

## Approved V8 isolated integration and planning refresh

V8 retains the V7 recovery and execution policies. Present all `continuity`
fields before approval: `version: 1`, `isolatedAutoIntegration`, `planningRefresh`
and `planningInputs`. Isolated automatic integration requires both sealed
`isolatedWorktree` and `autoCommit` policies. Use the complete returned approval
question, including its continuity authority; never synthesize a shorter label.

Declare every repository input used to reason about the requirement, interfaces,
design and tests in `planningInputs`, including dependencies and relevant
resources. Selectors do not grant edit permission. If this dependency declaration
is uncertain, use `planningRefresh: "reject"`. `completedQueueTasks` permits a
fresh execution baseline only before execution, with unchanged declared inputs
and configuration and a verified linear history of completed queue integrations.
It cannot reset recovery budgets or replace an existing task's RED/Review.

For BASELINE_REVIEW, inspect `planning-baseline` evidence and propose a revised
contract when required. Preserve the original planning HEAD and approval. Target
drift during automatic integration does not authorize rebase or automatic
revalidation. Preserve the candidate; an existing commit transaction requires
explicit `recover`, while a revised plan requires a new approval. Report the
actual local commit and automatic authorization source after completion.


## Bounded verification in 1.5.0

New capable-project contracts use `verification.scope` version 3, mode `bounded`.
Use exact `targetTests` for RED/GREEN, explicit `regressionTests` for final checks,
and explicit `tasks` arrays for `assembleTasks`, `lintTasks`, `deviceTestTasks`.
An empty array means no such extra task. Include repository-required lint/device
coverage explicitly; missing coverage stops preview instead of appending tasks.
No inferred consumer, module, variant, wildcard filter or full-suite fallback is
authorized. Keep generated tests tied to the acceptance criteria and exact files.

Baseline tests are optional, default `baseline: "snapshot"`; capture metadata and
preserve existing test definitions without Gradle. This is not a passing baseline
result. Uncertain preservation blocks for explanation rather than automatic
baseline execution. Only explicit `baseline: "execute"` runs target baseline tests.
Use `buildMode: "incremental"` by default. Retain build outputs and permit build
cache hits; `clean` requires an explicit choice. Failures do not authorize cleaning,
cache deletion, all-task reruns or wider validation.

GREEN runs target tests, and independent Review can reuse its sealed verification
at the same HEAD and inputs. Final integration runs actual target tests again on
the fixed candidate commit, plus only the approved regression/build/lint/device
tasks. Do not perform assemble at every phase. Repeated final checks reuse valid
checkpoints for that exact candidate. Changes invalidate relevant evidence;
never claim a cached Test result is a fresh execution or reuse across commits.

Intake seals the displayed verification preview into the contract digest and
checks it again at enqueue. New legacy scopes require an explicit reviewed
`verificationFallbackReason`; old drafts and approvals retain their semantics.
