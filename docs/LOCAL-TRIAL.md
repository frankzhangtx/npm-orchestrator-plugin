# Local candidate trials

This workflow is under validation. A passing deterministic fixture is not evidence
of a successful native-model or real Android project run. Do not publish a trial
artifact until its separate release checks and authorization are complete.

## Package identity

Build and pack a new version, then run:

```sh
node dist/cli.js local-package /absolute/candidate.tgz /absolute/installations
```

The result identifies the installed candidate CLI. Use that CLI for upgrades and
`trial-run SPECIFICATION.json`; do not invoke a registry CLI for the trial.
`--offline` is optional and requires cached dependencies. Installations use an
artifact SHA-256 directory, disable npm lifecycle scripts, and retain failures
for inspection. Identity checks cover tarball SHA-256/SHA-512, package files,
dependency files, modes, internal symlinks and the installation lock file.
OpenCode uses the local file URL; duplicate registry/local entries are rejected.
Changing any frozen content requires a new candidate and verification.

## Trial contract

`TrialSpecification` in `src/trial/driver.ts` defines the JSON input. It binds the
original branch and HEAD, original package and installation roots, a new trial
branch, candidate digest, task ID, original request, exact business paths and
target tests, explicit execution policies, and absolute execution/cleanup
expiry times. Evidence and batch directories must be outside the checkout.
The original package root can be inside a larger installation root containing
hoisted dependencies; preserve that entire installation.

Start only with a clean checkout, paused queue, no executor and no workspace
lease. The driver snapshots installation bytes and modes, applies the candidate,
commits the managed upgrade and queue policy, checks host loading and doctor,
and binds a delegation grant to the native `/change` session. The grant seals
plan/contract digests and is consumed atomically at enqueue. It records
`delegatedApproval`, never a fabricated human question receipt. Normal manual
approval is unchanged.

The request digest always covers the original requirement bytes. Native binding
also accepts the exact single-argument quoting used by OpenCode `run`: arguments
containing a literal space are wrapped in double quotes, with embedded double
quotes escaped. The adapter reverses only that one transport layer and requires
an exact re-encoding before checking the original digest. It does not parse JSON
or shell syntax, trim whitespace, normalize Unicode, or decode backslash escape
sequences. Extra arguments, changed content and noncanonical encodings are
rejected without binding or consuming the grant.

The batch allows at most five candidates and one task per candidate. Re-entry
must use the same specification and deadlines. The persisted run scope blocks
historical tasks, including after expiry. The model call ledger permits only an
explicitly authorized Coder continuation after an owned `STEP_BUDGET` stop with
all processes confirmed exited and an unchanged checkpoint. Ordinary exit,
model text, unknown termination, timeout, or merely reaching OpenCode's `steps`
setting is not proof of budget exhaustion. Invocation counts and deadlines do
not reset on restart.

## Restoration and results

The driver attempts restoration after success or failure, using a separate
bounded cleanup deadline. Only the authorized task may be aborted/archived.
Installation restoration checks the captured and sealed switched bytes before
writing, rejects external changes, and preserves queue evidence. Restored
tracked upgrade paths are staged only to switch to the original branch; the
candidate's business commits remain on the trial branch.

`VERIFIED` means restoration checks finished; it does **not** alone mean the
candidate passed. Success requires `phase == VERIFIED`, `result == COMPLETED`,
and `error == null`. A failed candidate with successful restoration remains a
failure. `RESTORATION_BLOCKED` requires inspection of the retained ledger and
transaction; do not start another candidate over an incomplete restoration.
The queue stays paused and the service stopped. Historical items must match
the pre-run record. The original doctor and a fresh host config hook must pass.

Low-level recovery commands are `installation-snapshot DIRECTORY DESTINATION
[DESIRED_PATHS.json]`, `installation-seal SNAPSHOT_DIRECTORY`, and
`installation-restore SNAPSHOT_DIRECTORY`. These commands restore registered
installation files, not task history or arbitrary user edits. Never replace a
current queue with a saved queue snapshot.

## Interrupted trials and final acceptance

SIGINT and SIGTERM request bounded cleanup instead of terminating the driver
immediately. The owned Planner is cancelled, the trial task is stopped using
normal queue recovery, and installation restoration runs within the original
cleanup deadline. SIGKILL or machine shutdown cannot run cleanup in-process.
Use the same frozen candidate CLI and unchanged specification to recover:

```sh
node /absolute/candidate/dist/cli.js trial-recover /absolute/specification.json
```

This command recovers only provably dead driver locks, never replays planning
or starts a new business task, and does not reset either deadline. A successful
exit means restoration passed, not that the interrupted business task passed.
If the cleanup deadline has expired or ownership cannot be proved, recovery
remains blocked; preserve the ledger and snapshots for explicit operator recovery.

A repository-wide record at `<git-common-dir>/automation-runtime/trial-restoration.json`
binds unfinished restoration to the initial branch, HEAD, specification and
installation snapshot. New batches and different delegated tasks cannot adopt
that candidate installation as a fresh baseline. Clearing queue items or changing
Git branches does not clear this record. Older trials without this record still
require their original ledger/snapshot to recover; never invent a replacement baseline.

Final acceptance compares the captured installation bytes and modes, original
branch and HEAD, clean Git state, original worktree inventory and package identity,
paused/stopped queue without a fault, doctor and actual host loading. Reopening
a VERIFIED ledger rechecks the current environment instead of returning historical
success. Acceptance is read-only with respect to restoration: a mismatched
manifest is reported, not silently rewritten. Evidence includes
`restoration-result.json`, with business result and restoration status separated.

A later checkout of a branch containing another plugin version does not switch
the ignored installation manifest. Restore a verified matching installation
before upgrading; a clean Git tree alone is insufficient. This also applies to
custom same-version retest drivers: they must honor pending restoration and must
not describe restoration to a candidate branch as restoration to the user's
original installation.

## Verification

Run `npm test` for unit/regression checks. Run
`node tests/trial-driver.integration.mjs` after building for the packaged driver
fixture: it uses real installer, plugin hooks, delegation, queue and restoration,
with deterministic model transport and Gradle output. It retains its evidence
outside the source checkout. A frozen candidate still requires independent
installation/host loading checks and the authorized real project trial.

For the native argument adapter, run `node tests/native-change-arguments.integration.mjs`
after building. This opt-in check uses the installed OpenCode CLI and the actual
binding function in a temporary project's command hook. It verifies accepted and
rejected argument transports, then deliberately stops before model invocation;
it neither creates a business task nor replaces a full real-project trial.
