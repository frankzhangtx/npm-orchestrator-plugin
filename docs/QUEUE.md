# Queue and background execution

Version `1.0.2` stores proposals and approved contracts under
`<git-common-dir>/automation-runtime/inbox/queue.json`. A contract is runnable
only after its full plan, version, digest, target branch and commit policy are
approved and durably recorded. Planning reads a fixed `planningHead`, so another
Coder's active files and branch do not affect the proposal.

Planner first receives compact branch and commit metadata. It discovers paths
through bounded `list` pages and reads exact UTF-8 content through bounded
`readChunk` pages. Every cursor is tied to the same `planningHead` and query;
changing the commit, path, prefix or query rejects the cursor.

## Normal use

Start OpenCode with `scheduled-planner` and use `/change`. Approve the displayed
proposal and the returned contract question. After enqueue, Planner returns;
you can plan and approve B or C while A is executing or awaiting acceptance.
Only the current task's plan and contract enter its working diff.

Defaults are `inPlaceExclusive` and `humanApproval`. Human tasks stop at
`AWAITING_HUMAN`; `/acceptance TASK-ID` presents the latest review and candidate
and asks a new question before requesting integration. Automatic tasks must
explicitly select `autoCommit` in their reviewed contract and proceed from
`READY_TO_COMMIT` to local commit and integration without a final question.
They never produce a fabricated human-acceptance record. Completion shows the
local commit SHA, authorization source and `pushed: false` (未推送).

| Workspace policy | Commit policy | When the next independent task may start |
| --- | --- | --- |
| `inPlaceExclusive` (default) | `humanApproval` (default) | After acceptance, local integration and directory handoff, or approved abort |
| `inPlaceExclusive` | Explicitly sealed `autoCommit` | After build, full tests, Review, local commit/integration and handoff |
| `isolatedWorktree` | `humanApproval` | After the worker and its children exit and its result is safely sealed |
| `isolatedWorktree` | `autoCommit` | Rejected; fresh compatible policy approval is required |

Both workspaces use one execution slot per Git common directory. A retained
isolated candidate keeps its own directory; revalidation and integration must
reacquire that same slot. Dependencies wait for `COMPLETED`, which means
integrated locally. Review approval and commit creation alone do not satisfy a
dependency. Fixed workspaces remain occupied during failures and human waiting.

The worker resolves the Android SDK from `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
then the source repository's `local.properties` and passes the resolved location
to its shell and Gradle processes. Isolated worktrees do not copy that local file.
Every mutating task script binds the workspace queue key and run ID to the
active Worker. The script may share the Worker's process group or be a proven
descendant in a separate OpenCode tool process group; an unrelated process is
rejected even if it copies the visible run ID.

## Service and scheduling

The first enqueue starts the package-owned detached service. Closing the
Planner does not stop it. Enqueue notifications, deadlines, worker completion,
startup recovery and periodic scans all use the same atomic reservation logic.
Idle scans do not call a model. No launchd or external Scheduler is registered.
The machine must be awake; a restarted service scans overdue entries once
through normal arbitration. Recurring task-template generation is not exposed
in this release; each approved contract has at most one initial execution.

`notBefore` requires an ISO timestamp with an explicit timezone, for example
`2026-09-14T22:00:00+08:00`. `dependsOn` contains previously approved task IDs.
Default ordering is FIFO; priority ranges from -100 to 100, higher first, without
preempting active work. Duplicate approval of a version returns its queue item.
To revise an unstarted approval, cancel it and approve a new draft version.
An executing version stays sealed; use a new task ID for later changes.

```sh
opencode-android-orchestrator queue status .
opencode-android-orchestrator queue status . TASK-A
opencode-android-orchestrator queue pause .
opencode-android-orchestrator queue resume .
opencode-android-orchestrator queue priority . TASK-B 10
opencode-android-orchestrator queue cancel . TASK-C
opencode-android-orchestrator queue stop .
opencode-android-orchestrator queue start .
```

An unsuccessful OpenCode agent process pauses consumption as a shared execution
fault; inspect its log and fix provider/environment failures before clearing it.

Pause stops new reservations. Stop terminates the scheduler while preserving
its active detached worker. Resume does not clear a fault. Notifications are
persisted until acknowledged, so the original Planner session need not remain
open. `queue --help` lists direct local-operator commands; interactive agents
use bounded plugin tools and actual question receipts instead of the CLI.

## Policy, capacity and verification

Pause and finish/abort retained workspaces before changing repository mode:

```sh
opencode-android-orchestrator queue pause .
opencode-android-orchestrator queue policy . isolatedWorktree humanApproval
```

Review and commit the changed `automation/config.json` before resuming. The
queued task fixes its workspace strategy when claimed. Its commit authorization
remains exactly the approved choice: changing a default cannot grant autoCommit
to an older task. Direct configuration drift while a workspace is retained
blocks scheduling; restore the recorded strategy before recovery.

Schema V6 queue defaults are `scanIntervalMs: 5000`, `maxWorkspaces: 3` and
`maxWorkspaceBytes: 21474836480`. Capacity includes retained isolated workspaces,
including completed directories when automatic cleanup is disabled. Reaching
count or disk limits pauses new isolated execution while still accepting intake;
acceptance, recovery and cleanup of existing tasks remain eligible. Occupied or
failed directories are never deleted simply to free queue capacity.

Queued execution requires `unitTestsEnabled: true`. A temporary Gradle init
script disables up-to-date and output-cache reuse only for Test tasks, records
actual suite results and rejects missing/skipped-only evidence. The invocation
uses `--no-configuration-cache`; compilation and build caches remain usable.
It does not run `clean` or rerun all dependency tasks. Coder, Reviewer and local
integration perform the configured full suite and build gates. Evidence records
fresh-test logs, configured tasks and elapsed seconds.

## Baselines and recovery

Before execution, changes to contract-relevant files or execution configuration
since planning require a revised contract and fresh approval. Planning files of
other completed queue tasks are not treated as execution configuration changes.
For an isolated waiting candidate whose local target advanced, request
`revalidate`; it preserves the original evidence, rebases a nonconflicting
uncommitted candidate in the same worktree, reruns build/full tests/Review and
produces a new candidate ID. Conflicts or policy changes preserve the workspace
and block progress. Old final acceptance cannot approve the new candidate.

All local commits use a persisted transaction: `INTENT`, `COMMITTED`, `VERIFIED`,
`INTEGRATED`, `COMPLETED`. Recovery checks the sealed tree, parent, target,
authorization and local refs before reusing a commit or completing handoff.
It never force-updates the target or pushes. A fixed directory is reusable only
after local integration and handoff succeed.

```sh
opencode-android-orchestrator queue recover-lock .
opencode-android-orchestrator queue recover-execution .
opencode-android-orchestrator queue recover . TASK-A
opencode-android-orchestrator queue clear-fault .
```

Inspect status and evidence first. Lock recovery proves the recorded owner has
exited; a heartbeat timeout alone never steals a live lock. Execution recovery
also checks the whole worker process group. If a reservation has no registered
worker, stop its recorded launcher before recovering it. Unknown ownership
retains the execution slot. `recover` is only for an existing sealed commit
transaction; baseline/Reviewer interruptions use `/resume-task` or
`/resume-review`. Running cancellation uses `/abort-task` and waits for a safe
agent boundary before archival through the execution slot. A hung external
process must be diagnosed and stopped before ownership recovery can succeed.

Upgrade and uninstall require the service stopped, no active execution, and no
retained unfinished workspace. Inbox, notifications and audit data remain in
the Git common directory. Commit-message prefix and worktree-allowlist sidecars
remain human-owned. See [Migration](MIGRATION.md), [Troubleshooting](TROUBLESHOOTING.md)
and [Security](SECURITY.md) for lifecycle and trust boundaries.
