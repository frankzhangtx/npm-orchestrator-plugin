# Queue and background execution

Version `1.1.0` stores proposals and approved contracts under
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

New installations configure `inPlaceExclusive` and `humanApproval` in
`automation/config.json`. A draft that omits either policy inherits the
repository configuration; an explicit value in the reviewed contract overrides
that configured default. Human tasks stop at `AWAITING_HUMAN`;
`/acceptance TASK-ID` presents the latest review and candidate and asks a new
question before requesting integration. Automatic tasks proceed from
`READY_TO_COMMIT` to local commit and integration without a final question.
They never produce a fabricated human-acceptance record. Completion shows the
local commit SHA, authorization source and `pushed: false` (未推送).

| Workspace policy | Commit policy | When the next independent task may start |
| --- | --- | --- |
| `inPlaceExclusive` (new-install default) | `humanApproval` (new-install default) | After acceptance, local integration and directory handoff, or approved abort |
| `inPlaceExclusive` | `autoCommit` (configured default or explicitly sealed override) | After build, full tests, Review, local commit/integration and handoff |
| `isolatedWorktree` | `humanApproval` | After the worker and its children exit and its result is safely sealed |
| `isolatedWorktree` | `autoCommit` | V8 must explicitly authorize isolated auto integration; after verified local handoff, or safe sealing and confirmed exit on a pre-commit failure |

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

Each newly approved contract atomically clears the queue's pause flag when it
is enqueued, then starts or wakes the package-owned detached service. This
resumes the entire queue; existing tasks keep their normal priority/FIFO order,
deadlines and dependencies. Failed or duplicate enqueue requests do not clear
the pause flag, and enqueue never clears a fault or replaces an active executor.
Closing the Planner does not stop the service. Enqueue notifications, deadlines,
worker completion, startup recovery and periodic scans all use the same atomic
reservation logic.
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

An unsuccessful OpenCode agent process retains its task's logs and stopped
candidate. Its exit code alone does not establish a shared execution fault.
In isolated mode, independent tasks can continue after sealing and confirmed
process exit; dependent tasks still wait for successful local integration.
Fixed mode continues to hold the directory until approved recovery or abort.
Unknown ownership, incomplete repository leases and shared scheduler failures
still block consumption. No automatic environment retry is implied.

Reviewer interruption recovery uses the approved queue `resume-review` request
and the one-argument Shell entry. It rechecks the sealed diff and does not rerun
Coder. The orchestration step bound supports zero, one or two configured Review
corrections, including a final budget-exhaustion state check.

Pause stops new reservations until explicit resume or a new contract is
successfully enqueued. Stop terminates the scheduler while preserving
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

Avoid approving new contracts during this maintenance pause: a new enqueue
resumes queue consumption. Review and commit the changed
`automation/config.json` before resuming. The queued task fixes its workspace
strategy when claimed. Its commit authorization
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

The 1.1.0 templates generate task-contract schema V4 with verification
version 2. npm publication of 1.1.0 is pending; the published 1.0.5 package
does not include this protocol. Every verification case
has a stable ID, a one-based acceptance-criterion reference, an evidence source,
an exact test identity, and a pre-change classification:

- `preserve` must pass before and after implementation;
- `change` must fail before implementation with the approved exception type and
  optional message fragment, then pass afterwards;
- `observe` may record a previously uncertain boundary, but a failure is
  accepted only when the contract declares its expected cause.

Planner declares only the task behavior cases. Before Coder edits any test,
`claim-task.sh` captures every existing case in the approved focused scope.
Fully qualified configured Gradle Test paths distinguish modules; overlapping
filters are combined per task. Each parameter instance must have a distinct,
stable `(taskPath, className, name)` identity. Ambiguous identities are rejected.

The sealed contract explicitly includes:

```json
"inventory": {
  "mode": "focusedBaseline",
  "existingSkips": "reject",
  "emptyBaseline": "reject"
}
```

Use `existingSkips: preserve` only to preserve already skipped regression cases;
it never permits a new skip or skipped behavior case. Use `emptyBaseline: allow`
only for an intentionally empty task/filter scope, such as a new test class.
An empty RED/GREEN is still rejected. Policies apply per task, not only to the
combined result count. Baseline failures always block before test edits.

`record-red.sh TASK-ID` runs the shared collector on unchanged production code.
It combines the captured regression cases and approved behavior cases into one
manifest. Missing/extra cases, new skips, ambiguous identities, unexpected
failures, incomplete events and build failures cannot become RED. GREEN must
cover the same manifest. No stale XML, cached Test result or discovery dry-run
is accepted as an actual execution. JUnit XML and Gradle logs are retained with
the run-bound event stream; the stream and its completion/count records drive
the decision. See [Gradle Test](https://docs.gradle.org/9.4.1/dsl/org.gradle.api.tasks.testing.Test.html)
for the underlying execution and listener APIs.

Evidence binds the contract, configuration, original execution baseline,
collector, full test/resource snapshot and attempt files. JVM source sets and
Android test source providers discover custom inputs without expanding contract
or agent edit permissions. Symlink, external and generated inputs fail with a
specific unsupported-input reason. Test and resource inputs freeze after RED.
The final check also binds GREEN to the verified HEAD and working files.
Each GREEN invocation first invalidates the previous success in
`green-verification.json`. Final checks require a PASSED marker bound to the
same verification run and report digest; failed, interrupted or early-rejected
reruns cannot reuse an older successful report.
Human-owned commit-prefix and snapshotted worktree-allowlist files remain outside
the evidence; changing the exclusion policy invalidates its binding. Such files
cannot also be test inputs. An isolated candidate can revalidate an advanced
production baseline, but incoming changes to frozen test inputs block it and
require a newly approved task, not replacement of the original RED.

Failed attempts remain under `inventory-attempts/`; only a complete valid RED
is sealed. Queue details and `status.sh` expose `baselineInventory`,
`testManifest`, `greenInventory` and `inventoryStatus` (queue details use the
hyphenated file names). Status includes the phase, reason code, offending cases
and next action. Acceptance reports include baseline/RED/GREEN coverage and
the permitted skips. `processExitCode` is the actual Gradle status; for V4 the
legacy `red.exitCode: 1` means `approved-case-failure`, because the collector
allows Test tasks to complete and classifies failures itself. The reviewer must
still check the semantic origin of the expected failure, beyond type/message.
Structured errors carry the queue execution ID. Errors from older executions
or malformed status sidecars do not replace the current script's failure.

V1/V2 retain the legacy failure-text command. Existing V3 contracts retain their
declared-case-only verification. New inventory coverage requires a V4 contract
and fresh approval, not an in-place rewrite of old evidence. Upgrading templates
and executor must be done together after the development build is versioned;
same-version production installations remain verification-only.

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
transaction; baseline interruptions before `baseline.json` exists may use the
bounded `/resume-task` route; Reviewer interruptions use `/resume-review`.
V4 inventory capture happens after `baseline.json` is written, so an interruption
at that stage cannot use baseline-only resume. Inspect the retained attempt,
request approved `/abort-task` archival, correct the cause and approve a new task.
Do not delete or overwrite baseline/RED evidence to make recovery pass.
Running cancellation uses `/abort-task` and waits for a safe
agent boundary before archival through the execution slot. A hung external
process must be diagnosed and stopped before ownership recovery can succeed.

Upgrade and uninstall require the service stopped, no active execution, and no
retained unfinished workspace. Inbox, notifications and audit data remain in
the Git common directory. Commit-message prefix and worktree-allowlist sidecars
remain human-owned. See [Migration](MIGRATION.md), [Troubleshooting](TROUBLESHOOTING.md)
and [Security](SECURITY.md) for lifecycle and trust boundaries.

## V5 baseline checkpoint recovery (1.1.0)

V4 remains the default contract example. A new V5 contract keeps verification
version 2 and every V4 inventory/RED/GREEN gate, and additionally requires an
explicitly approved `recovery` object. Adding it to V4 is rejected. For example:

```json
{
  "version": 1,
  "scope": "baseline",
  "maxEnvironmentRetries": 2,
  "maxManualRetries": 1,
  "maxSameFailureRetries": 2,
  "maxElapsedMs": 900000,
  "initialDelayMs": 1000,
  "maxDelayMs": 60000
}
```

Retry counts must each be 0..3. The elapsed window is 1000..86400000 ms;
initial/maximum backoff must be 1000..600000 ms with maximum at least initial.
Backoff grows exponentially with jitter. Zero retries disables that budget.
The window starts at initial capture and stops new stages/attempts after its
deadline; it does not forcibly terminate a stalled Gradle or Worker process.

The queue runs deterministic capture before Coder starts. Full unit-test
success seals `baseline-full.json`; successful focused discovery seals
`baseline-discovery.json`; collection seals `baseline-inventory.json`.
`baseline.json` is published only after all stages succeed. Recovery reuses
completed checkpoints without changing their bytes. `baseline-recovery.json`
retains each attempted stage, command/process logs, input binding, evidence
hashes, failure category and persistent next-run time. One retry spends one
budget entry even if it completes multiple stages. RED preparation,
implementation and Review budgets are independent; capture invokes no models.

Only positive network/429 signatures on failed commands authorize automatic
retry. Test assertion/compilation, authentication and integrity failures take
precedence over incidental network text. Real historical failures require a
separate correction/revised task. Unknown failures remain blocked and may use
`/resume-task` only after fresh approval within the manual retry budget.
A manual retry has its own budget but shares the elapsed window. There is no
public `retry-baseline` request; it is reserved for the approved scheduler.

Resume requires unchanged contract, execution/target HEAD, repository inputs,
configuration and recorded toolchain/environment binding. Human-owned files
excluded by the sealed worktree allowlist remain outside that input snapshot;
the exclusion policy itself is bound. All retained attempt
artifacts and checkpoints must still match the queue-sealed ledger. Revocation,
pause, dependency, process ownership and workspace lease checks still apply.
Service restarts retain counters and backoff; an ambiguous interrupted RUNNING
attempt is not automatically replayed. A rejected recovery consumes its wake,
so corrupted evidence cannot create an automatic retry loop. Successful
baseline/RED evidence is never replaced. Source or target-branch changes need
a revised contract. Baseline recovery does not refresh a stale planning head.

Inspect `queue status <directory> <key>` evidence `baseline-recovery` and `status.sh` evidence
`baselineRecovery`; queue item `baselineRecovery.nextRunAt` is the authoritative
scheduled wake (it can be null after rejection even when retained evidence has
an old time). Failed isolated tasks retain their workspace; independent tasks
may continue after process exit and sealing. Fixed-directory tasks still hold
the directory while waiting. Automatic recovery does not change commit policy.

## V6 Worker safety deadlines (1.1.0)

New V6 contracts retain V5 baseline recovery and inventory verification and
add an explicitly approved execution policy, for example:

```json
{
  "version": 1,
  "maxRunMs": 1800000,
  "maxStageMs": 600000,
  "terminationGraceMs": 15000
}
```

Place this object in `execution`. Run and stage limits are 1000..86400000 ms,
stage must not exceed run, and TERM grace is 1000..60000 ms. They apply per
reserved Worker invocation, including resume, Review recovery, integration,
revalidation and abort; V5's baseline retry count/window still spans its own
attempts. V4 remains the default example. V1..V5 never gain kill authority by
upgrading. Normal contract approval covers this policy; no repeated approval
is needed for an in-policy timeout.

The detached supervisor is outside the Worker process group, so a blocked
Worker event loop cannot disable the deadline. The durable record tracks
preparation, baseline, coding, review, integration and abort stages. Stage
changes reset only the stage limit, bounded by the original run deadline.
Log output and silence do not affect either limit. Wall-clock deadlines include
sleep; after wake an elapsed deadline triggers termination. A backwards clock
or unreadable process inventory stops supervision for ownership review.

Before TERM and each later KILL, process identity must match a fresh process
table: a unique inherited run marker or previously witnessed ancestry plus
PID, start time and process group. Detached descendants retain the marker;
ordinary Shell descendants are also recorded because macOS may hide inherited
environments. No signal targets a process name or a whole process group.
Unknown members, changed identities or unprovable locks preserve the active
slot and lease with `OWNERSHIP_BLOCKED`. Commands must preserve the ownership
environment and must not launch persistent external services. Controlled
Gradle commands use `--no-daemon`; supervised tools also inherit
`-Dorg.gradle.daemon=false` so shared Gradle daemons are not reused or killed.

TERM intent/result and grace start are persisted before escalation. Restarting
the scheduler keeps its detached supervisor alive; if the supervisor crashes,
the next scheduler scan reattaches to the same Worker. Run/stage deadlines,
known identities and TERM grace are retained. An unregistered ambiguous launch
is not replayed. A dead queue lock can be archived automatically only when its
recorded owner belongs to this supervised execution or its previous supervisor.
Lock creation writes and flushes the owner record before publishing an exclusive
hard link in the same directory. A process killed before publication can leave a
pending file, but no occupied transaction lock; after publication the complete
owner remains available for recovery. Older incomplete or unknown lock records
still require explicit diagnosis. A live or unknown lock is never stolen.
A machine reboot still requires the
operator to start the service; this change does not install a system daemon.

Two empty ownership snapshots are required before the run can be reconciled.
On timeout, all attempts and product changes remain. A safely sealed isolated
candidate becomes BLOCKED, allowing independent tasks to continue; dependent
tasks keep waiting. Fixed-directory tasks retain their directory. If a local
commit transaction exists, the task becomes INTEGRATION_BLOCKED and retains
its lease and transaction; `recover` verifies and integrates that same commit
without creating another one. Timeout never implies acceptance or authorizes
new retries. The supervisor does not roll back visible commits.

`queue status`, `queue status <directory> <key>` and `status.sh` expose supervision
state/deadlines. `worker-stop-<runId>.json` records signal intents/results and
confirmed exit, while `worker-stop-<runId>-blocked.json` preserves ownership
failures. Raw process environments and the ownership token are not included
in public status or evidence. `queue stop` stops scheduling, not supervision.
After an ownership failure, inspect the recorded identities and preserve the
workspace. `recover-execution` refuses live/unknown descendants and retains
the interrupted workspace; then use the existing approved recovery/archive
workflow. Do not clear leases or edit evidence to bypass a refusal.


## V7 verification environment recovery (1.1.0)

V7 adds required `stageRecovery` alongside the V5 `recovery` and V6 `execution`
policies. The default contract example remains V4; old tasks never acquire new
retry authority from an installation upgrade.

```json
{
  "version": 1,
  "maxEnvironmentRetries": 2,
  "maxSameFailureRetries": 1,
  "maxElapsedMs": 900000,
  "initialDelayMs": 1000,
  "maxDelayMs": 60000
}
```

Retry limits are 0..3, elapsed time is 1000..86400000 ms, delays are
1000..600000 ms with maximum at least initial. RED, GREEN and Reviewer
verification each share one cumulative budget across calls and correction
cycles. The phase recovery window starts at its first verification. Successful
verification resets the consecutive-failure counter, never the retry counter
or elapsed window. This is not a model-cost or cross-phase task-time budget.

Only identified transient network/rate-limit failures of deterministic
verification may retry. Real assertions, compilation failures, configuration,
unknown errors, scope/integrity failures and signal termination never grant
retry authority. RED still requires the approved behavior failure and all
existing regression checks. Environment retries do not consume preparation
fixes, implementation gate attempts or Review correction cycles. Review
verification exhaustion becomes BLOCKED without creating CHANGES_REQUESTED.
The same model invocation remains responsible for the script result; no model
call, approval, local commit or integration transaction is automatically replayed.

Backoff is exponential with jitter and a persisted next-run time. The bounded
wait retains the Worker slot; V6 supervision still enforces its deadline and
covers blocked commands. Scheduler restart leaves that Worker running. Attempts,
counts and deadlines live under `evidence/<task>/stage-recovery/`. Logs and
inventory attempts are retained and checked before retries, along with the
contract, HEAD, working files, configuration, tool environment and sealed
baseline/RED evidence. New calls never reuse a previous successful verification.
The queue seals each phase ledger's SHA-256 through the active supervised
Worker. Rewriting or deleting a ledger cannot reset its counters or backoff;
unowned checkpoint calls are rejected. Approved product deletions remain part
of the input snapshot, and restoring a deleted file during backoff invalidates it.

Changed inputs or evidence stop the phase. A crashed attempt with no durable
outcome or an occupied recovery lock also stops; no timeout steals a lock.
An exhausted phase cannot be reset by re-invoking a command. Preserve evidence
and use the existing approved archive/revised-contract workflow. This protocol
does not add automatic recovery of unknown outcomes, provider errors, or retries
after a Worker termination. `queue status <directory> <key>` and `status.sh`
expose `stageRecovery`; real Android/provider and physical sleep/reboot tests
remain separate acceptance work.


## V8 isolated integration and planning refresh (1.1.0)

V8 retains all V7 inventory, baseline recovery, stage recovery and Worker deadline
policies, and requires `continuity`:

```json
{
  "version": 1,
  "isolatedAutoIntegration": true,
  "planningRefresh": "completedQueueTasks",
  "planningInputs": [
    "app/src/main/java/example/Feature.kt",
    "app/src/main/java/example/Dependency.kt",
    "app/src/test/java/example/FeatureTest.kt",
    "app/src/test/resources/**"
  ]
}
```

Set `isolatedAutoIntegration: true` only with both `workspaceStrategy:
"isolatedWorktree"` and `commitPolicy: "autoCommit"` in the sealed draft. The
approval question explicitly grants automatic local integration. Existing
contracts, including queued fixed-directory auto-commit tasks, do not gain this
authority from a default policy change. V8 also binds the workspace strategy at
approval; restore it or approve a revised task after a repository policy change.
The default example remains V4 and new-install defaults remain human approval.

After fresh full tests, build and independent Review, the same repository slot
verifies and fast-forwards the approved local target. The persisted five-stage
commit transaction binds the candidate, parent, tree and original authorization.
No remote operation or fabricated human-acceptance record is produced. Pause
prevents new reservations; revocation or an abort request prevents starting an
automatic commit. Target drift, source checkout drift or unsealed changes stop
integration. This does not authorize an automatic merge, rebase or new model
attempt. An existing transaction keeps its lease for explicit `recover`, which
reuses its recorded commit. Before a transaction exists, a failed isolated task
can be safely sealed and released after process exit, so independent tasks can
continue; its dependents still wait for actual COMPLETED integration.

`planningInputs` declares the files and selectors whose contents informed the
requirement, interfaces, design and approved test meaning. Include dependencies
and relevant tests/resources, not just editable files. At draft time the queue
seals a digest of matched paths, Git blob IDs, modes and selectors at the fixed
planning HEAD. Empty matches represent absent inputs, so future additions are
also detected. Symlink and submodule inputs are rejected. The selectors grant
no edit permission and do not replace `allowedPaths`. An incomplete declaration
cannot prove semantic independence; Planner must disclose uncertainty and use
`planningRefresh: "reject"` when dependencies cannot be stated reliably.

With `completedQueueTasks`, prepare may advance the execution baseline only if:

- Every declared planning input is unchanged, including matched file additions,
  deletions and executable modes.
- Execution configuration is unchanged. Other completed tasks' sealed plan and
  contract files are exempt; build scripts and verification configuration are not.
- Every intervening commit forms one linear chain of completed queue integrations
  on the same local target, with matching approval and persisted transaction.
  Unrecorded external commits and merge commits require a revised contract.

Changed inputs or denied refresh enter BASELINE_REVIEW before workspace creation
or model execution. Use `planningRefresh: "reject"` to require reapproval on any
HEAD advance. Legacy contracts retain their existing allowed-path drift rules.
The original contract, planning HEAD and input digest remain unchanged; queue
`planning-baseline` evidence records the actual execution HEAD, prior integrated
tasks and decision. Prepare and capture a new baseline on that execution HEAD;
never reuse another task's baseline, RED or Review evidence. Refresh is available
only before execution, not a way to reset an existing task's retry budgets.
