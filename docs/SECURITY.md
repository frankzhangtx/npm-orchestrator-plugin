# Security model

This document describes the security properties of
`@frankzhang2026/opencode-android-orchestrator@0.7.0`. The lifecycle foundation
completed the real OpenCode `1.14.22` and `1.15.13` release matrix in `0.2.0`;
`0.7.0` retains that compatibility boundary.

## Security goals and non-goals

The orchestrator is designed to reduce accidental or model-initiated scope
expansion in a local Android repository. It aims to:

- keep human proposal, contract, and final-result approval explicit;
- constrain Coder edits to contract-approved Android source/test paths;
- keep Reviewer read-only;
- authenticate packaged and installed orchestration resources;
- preserve original files and recover complete installer transactions;
- block silent overwrites, unsafe symlinks, stale plans, branch drift, pushes,
  unbounded retries, and Scheduler/launchd registration;
- create one local product-and-planning commit only after sealed verification.

It is not a privilege boundary against a malicious local user, a compromised
OpenCode binary/provider, a compromised npm/Git dependency, or another process
running as the same operating-system account. It does not sandbox Gradle,
OpenCode, Java, Git hooks, or project tests. A hostile build script or test can
perform actions outside the orchestrator's intended scope.

## Trust boundaries

| Boundary | Trusted input | Untrusted or separately verified input |
| --- | --- | --- |
| Package installation | The exact reviewed npm tarball and its pinned version | Existing project files, paths, modes, symlinks, and concurrent edits |
| OpenCode interaction | A fresh single-choice result handled by the scheduled planner | Ordinary chat text, command arguments, and model-generated approval phrases |
| Product implementation | The sealed task contract, baseline HEAD, allowed paths, and deterministic scripts | Coder summaries and any unsealed worktree change |
| Review | The approved contract and independently recomputed diff/evidence | Coder claims and stale report content |
| Integration | Task ID, repository lease, sealed diff SHA, approved review, original branch/ref, and fresh acceptance | Branch drift, manual commits, changed worktrees, or a reused acceptance package |
| Recovery | Manifest, markers, hashes, modes, original backups, snapshots, and Git refs | Guessed cleanup steps or copied state from another repository |

## Human approval boundary

The normal workflow has three fresh OpenCode `question` selections: proposal,
sealed contract, and final result. Direct chat prose, silence, a dismissed
question, or a copied option label is not a normal-path approval. Baseline-only
recovery and exceptional abort each have their own fresh status/question
boundary.

Approval phrases stored in `automation/config.json` are validation tokens, not
secrets or cryptographic proof. Security depends on the scheduled planner
showing the current review material, the user acting at that boundary, and the
fixed Shell script independently verifying state, hashes, refs, scope, and
leases. Anyone with direct shell and repository write access can invoke or
modify local files; this package does not claim to protect against that actor.

OpenCode permission prompts are also not semantic workflow approval. They can
be accepted for the remainder of a session and may be auto-approved. For that
reason `0.7.0` exposes only `android_orchestrator_status` and
`android_orchestrator_doctor` as custom tools. State-changing wrappers remain a
NO-GO until a one-use, non-model-forgeable receipt can bind the approval kind,
task, session/message, sealed SHA or branch, time, and nonce.

## Agent and tool permissions

All three installed agents start with `"*": deny` and add exact permissions.
The planner can write only new planning artifacts and invoke the small set of
orchestration scripts. The Coder can edit detected production/test source sets
but not Gradle, OpenCode, automation, or control files. Reviewer edit access is
denied. Subagents, Scheduler/job tools, external directories, web access, push,
merge/rebase, destructive Git commands, shell composition, and launchd are
denied where applicable.

Permissions are defense in depth, not a substitute for script checks. The
source preflight resolves each agent and verifies its effective high-risk
permissions and custom-tool discovery.

The read-only status tool additionally:

- validates `TASK-[A-Z0-9-]+` at Schema and execution time;
- binds execution to the worktree that loaded the plugin;
- authenticates the installation manifest, managed resources, and executable
  modes before running anything;
- invokes only the fixed `scripts/automation/status.sh` path with separate
  shell expressions;
- rejects a failed command, malformed/mismatched JSON, or output above 1 MiB.

Doctor invokes read-only project, dependency, SDK, and installation checks and
returns their failures instead of repairing the project.

The compatible `tool.execute.before` hook may only raise the timeout argument
for a fixed list of direct managed long-running scripts. Its generated config
value is an integer from `120000` through `7200000` milliseconds, defaults to
`1800000`, never shortens a larger caller timeout, and does not rewrite the
command or authorize a state change.

## Filesystem and configuration safety

The installer never follows a symbolic link at a managed file or required
ancestor. Paths must be relative, normalized, unique, within the detected Git
root, and regular files where required. Existing content, size, and effective
mode are captured during planning and rechecked before the first write. A stale
or tampered plan fails closed.

Installation strategies are deliberately distinct:

- `copy` and `generate` accept a missing target or an exact content/mode match;
  any differing existing file is a conflict;
- `merge` accepts only output produced by the structure-aware OpenCode JSON/JSONC
  or bounded AGENTS merge planner;
- no lifecycle command has a force-overwrite flag.

OpenCode JSON/JSONC merging preserves unrelated fields, comments, order, and
plugin options. It rejects malformed/ambiguous files, duplicate identities,
different managed-plugin versions, and symlinks. AGENTS merging owns only one
marked block and rejects partial, duplicate, or modified markers.

New installations generate task examples in `all` module scope: every detected
Android module's `src/main`, `src/test`, and `src/androidTest` path is eligible,
while Gradle settings/build files and orchestration resources remain protected.
`primary` scope narrows the generated paths to one module. Upgrade treats a
legacy configuration with no scope field as `primary`, preventing an implicit
permission expansion.

`unitTestsEnabled` and `lintEnabled` are the only operator-editable fields in
the otherwise manifest-managed `automation/config.json`. Upgrade authenticates
the remaining generated content before preserving those values, and doctor
validates the resulting adaptive configuration. Task agents still cannot edit
the protected file. Unit tests default on and lint defaults off; disabling unit
verification does not remove the mandatory RED evidence step. Assemble, scope,
evidence, and required device-test gates are unaffected.

The optional repository-root `.automation-worktree-allowlist` is controlled by
the local human operator, not by task agents. It accepts at most 256 exact,
normalized repository-relative file paths in a regular file no larger than 64
KiB. Patterns, directories, duplicates, Git metadata, planning artifacts, and
configured protected paths fail closed. The control file itself is protected
and excluded from orchestration change views.

The installed manifest is `0600`. Installer control, backup, recovery, and
history directories are created with private `0700` defaults; backup files
preserve the original file mode where recovery requires it. Shell resources
must be exact packaged bytes with `0755`; other copied templates are
non-executable.

## Transaction and recovery safety

`init` writes original-file backups before publishing a prepared manifest. It
then applies validated files, runs the 44-case transaction suite and a shadow
run, verifies final hashes/modes, and only then marks the manifest installed.
Failure before completion restores originals and removes safely unchanged new
files.

`upgrade` requires a healthy installed manifest and original backups. It saves
the exact old manifest and immediate pre-upgrade snapshots, reconstructs merge
targets from first-install originals, writes the new version, and replaces the
manifest only after verification. Failure attempts a whole-version rollback.

`uninstall` restores an original or removes a plugin-created path only when the
current path still matches a safe known state. Content, permission, deletion,
or existence drift is retained and reported. Before changes it saves the
active manifest and every affected installed file. Failure before commit
attempts to restore the installed state.

An `*_ROLLBACK_FAILED` result is a hard stop. Do not delete markers or recovery
data and do not guess at partial cleanup. Preserve the repository and inspect
the recorded before/after hashes and Git refs.

## Git and orchestration invariants

- The source repository must have an identifiable original branch and baseline
  HEAD. Original-branch drift blocks integration.
- The persistent repository lease prevents concurrent orchestrated tasks from
  sharing a mutable repository workspace.
- Planning artifacts remain uncommitted until the verified product change is
  ready. Successful integration creates exactly one combined local commit.
- Scope gates inspect tracked and untracked changes, reject protected paths and
  obvious test weakening, and bind the accepted result to a diff SHA.
- An approved task snapshots the validated worktree allowlist. Listed local
  changes are excluded consistently from cleanliness, scope, hashes, evidence,
  archival, and commits; explicit commit pathsets preserve allowlisted staged
  entries, and rename detection cannot hide an unlisted source path. Changing
  the control file mid-task cannot widen the active snapshot. Status exposes
  the effective list to Coder and Reviewer sessions and returns an empty list
  inside isolated task worktrees.
- Integration reruns verification before a fast-forward. It never pushes.
- Baseline-only recovery is accepted at most once and only when the recorded
  task and original refs remain at the baseline, the lease and final
  transitions match, no baseline/downstream evidence exists, and the worktree
  still contains only the two sealed untracked planning artifacts.
- A successfully integrated task branch is deleted only after the original
  branch reaches the verified commit. Failure preserves the branch for
  recovery.
- Abort rejects out-of-contract/protected paths, archives the diff, and avoids
  changing the original branch ref.

Git hooks and Git configuration remain part of the host repository's trust
surface. Review them before running a workflow in an untrusted project.

## Dependencies and network behavior

Use fixed package references. The installer adds the exact orchestrator
version and the configured pinned Superpowers Git tag; it does not use
`latest`. The package is compiled against `@opencode-ai/plugin@1.14.22` and
declares the bounded peer range `>=1.14.22 <1.16.0`.

The orchestrator does not contain a telemetry uploader and the deterministic
Shell flow forbids Git push. Network activity can still occur outside that
code when npm/npx downloads a package, OpenCode resolves a pinned plugin,
OpenCode contacts the configured model provider, or project build/test tooling
uses the network. Apply the host organization's normal npm, Git, OpenCode,
provider, proxy, certificate, and dependency-review policy.

## Secrets and retained evidence

Installed agents deny reads of `.env`, `.env.*`, `local.properties`, `*.jks`,
and `*.keystore`. Do not put secrets in task descriptions, plans, source code,
test output, commit messages, model prompts, or approval summaries.

The following may contain sensitive source, paths, branch names, test logs,
diffs, or review findings:

- `.git/automation-runtime/evidence/`;
- `.git/automation-runtime/workspaces/` and state/transition records;
- `.automation-plugin/backups/`, `upgrades/`, `uninstalls/`, and `history/`;
- generated acceptance, abort, integration, and rollback evidence.

These paths are excluded from package templates but remain local audit data.
Keep repository and filesystem access appropriately restricted. Redact user
names, absolute paths, proprietary source/diffs, provider details, tokens, SDK
paths, and signing information before sharing a diagnostic bundle. Do not
commit installer recovery data unless an explicit internal policy requires it.

## Residual risks

- Hashes prove byte identity against the running package; they do not prove the
  package itself is trustworthy. Review the tarball and its provenance.
- A same-user process can race filesystem or Git state around checks. The
  implementation rechecks critical snapshots and locks cooperative workflows,
  but it is not an operating-system sandbox.
- Gradle tests, Git hooks, OpenCode, model providers, and third-party plugins
  execute outside this package's file planner and may have broader behavior.
- `inPlaceExclusive` intentionally switches the current worktree to a task
  branch. Use the explicitly configured isolated-worktree strategy only after
  validating its storage and cleanup policy.
- Recovery evidence improves auditability but increases local sensitive-data
  retention.
- A human can intentionally hide a product-file change by allowlisting its
  exact path. Such a file is outside the task's reviewed and committed result;
  remove it from the list before any task that is expected to modify it.
- Real dual-version end-to-end acceptance and a clean install from the final
  tarball remain mandatory release gates.

When reporting a suspected security problem, preserve exact versions, error
codes, hashes, and redacted evidence. Do not publish credentials, proprietary
diffs, recovery archives, or exploit details that would expose another
project. See [Troubleshooting](TROUBLESHOOTING.md) for safe first-response
commands.
