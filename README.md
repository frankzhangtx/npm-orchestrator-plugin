# OpenCode Android Orchestrator

Reusable OpenCode orchestration for macOS Android projects.

Version `0.2.0` is the first published lifecycle release. Version `0.3.0` adds
default all-module orchestration and stronger verification contracts. Version
`0.4.0` adds a validated, exact-path worktree allowlist for intentional local
changes while retaining the same certified OpenCode compatibility range.

## Documentation

- [Migration guide](docs/MIGRATION.md) — choose the correct path for the
  `0.1.0` scaffold, a manually copied V3 setup, or a manifest-managed install.
- [Troubleshooting](docs/TROUBLESHOOTING.md) — diagnose CLI failures, resource
  drift, OpenCode discovery, blocked tasks, and recovery evidence.
- [Security model](docs/SECURITY.md) — trust boundaries, approval guarantees,
  file/Git protections, retained evidence, and residual risks.
- [Third-party notices](THIRD_PARTY_NOTICES.md) — runtime, peer, external
  companion, and development-only dependency relationships and licenses.

## Requirements

- macOS with Node.js/npm for `npx` or the packaged CLI;
- OpenCode `1.14.22` or `1.15.13` for a certified configuration (the declared
  compatibility range is `>=1.14.22 <1.16.0`);
- a Git-backed Android Gradle project with `settings.gradle[.kts]` and an
  executable `gradlew`;
- `git`, `jq`, `rg`, `shasum`, and Java on `PATH`;
- an Android SDK resolved from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or
  `local.properties` `sdk.dir`.

Run lifecycle commands from the project root or a directory below it. Use a
clean branch and preserve an independent backup before the first installation,
even though the installer maintains its own verified recovery data.

## Quick start

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.4.0 init .
npx @frankzhang2026/opencode-android-orchestrator@0.4.0 doctor .
opencode --agent scheduled-planner .
```

New installations use all-module scope by default. Every detected Android
module's `src/main`, `src/test`, and `src/androidTest` trees can be included in
a task contract without selecting a primary module. To intentionally restrict
generated contracts to one module, opt into primary-module scope:

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.4.0 init . \
  --module-scope primary \
  --primary-module :mobile
```

In all-module scope, `--primary-module` is optional and only chooses the
default module used by the focused-test placeholder; it does not narrow which
detected modules may be modified.

### Allow intentional local worktree changes

If one or more files must stay locally modified while orchestration runs,
create `.automation-worktree-allowlist` in the Git repository root and edit it
as a normal text file:

```text
# One exact repository-relative file path per line
local/operator-note.txt
config/developer-overrides.json
```

Blank lines and lines beginning with `#` are ignored. Entries must be exact
file paths; directory entries and glob patterns are rejected. The control file
itself is automatically ignored by orchestration, so it does not need a
`.gitignore` rule merely to pass preflight.

Allowlisted tracked, untracked, and staged changes do not block startup and are
excluded from task scope, diff hashes, acceptance/abort evidence, and
deterministic commits. Existing staged entries remain staged instead of being
consumed by task or recovery commits. A rename has two paths, so both the old
and new exact path must be listed if the whole rename should remain local.
Protected orchestration, Gradle, Git, and planning paths cannot be allowlisted.
Use this only for files that the task must not modify; remove an entry before
starting a task that should change that file. The list is snapshotted at
contract approval, so edits made during a running task apply to the next task.
Task status exposes the effective snapshot to Coder and Reviewer sessions; an
isolated task worktree receives an empty effective list so task-local edits are
never hidden by source-worktree exclusions.

The install transaction manages 45 project-local paths:

| Resource group | Count | Installation behavior |
| --- | ---: | --- |
| Scheduled agents, commands, and skills | 10 | Copy exact audited templates. |
| Deterministic automation Shell files | 28 | Copy exact templates with `0755` modes. |
| Schemas and plan authoring guide | 3 | Copy fixed supporting resources. |
| Android automation config and task example | 2 | Generate from detected modules. |
| `AGENTS.md` and OpenCode JSON/JSONC | 2 | Merge bounded content without replacing unrelated settings. |

After installation, start the `scheduled-planner` and use its interactive flow.
The `/acceptance <TASK-ID>`, `/resume-review <TASK-ID>`, and
`/abort-task <TASK-ID>` commands are recovery/re-entry points; they do not
replace the required fresh approval controls. The workflow never pushes and
does not register Scheduler or launchd jobs.

## Status

Version `0.1.0` was an early scaffold without a working installer. Version
`0.2.0` introduced the complete managed lifecycle, `0.3.0` added all-module
defaults and stronger verification contracts, and `0.4.0` adds the bounded
worktree allowlist described above.

The cross-version plugin entry, OpenCode version doctor, Android/Gradle project
discovery, audited V3 resources, and all deterministic V3 Shell transactions
are implemented. Read-only planning now renders project-relative automation
configuration and a focused task example from the detected Android modules.
Safe, comment-preserving OpenCode JSON/JSONC merge planning is also implemented.
The installation transaction foundation now creates verified pre-install
backups and a versioned SHA-256 manifest. Read-only conflict analysis and the
installation-plan conflict gate are also implemented. The `init` command now
installs and verifies the complete project-local resource set. The read-only
`doctor` command now verifies the installed toolchain, manifest, resources,
permissions, backups, and configuration. The `upgrade` command now replaces
only unchanged managed resources, carries original pre-install backups
forward, and restores the complete previous installation if verification
fails. The `uninstall` command now restores unchanged original files, removes
unchanged plugin-created files, and retains any content, permission, or
deletion drift for manual review.

Implemented checks include:

- OpenCode `1.14.22` and `1.15.13` certification, with guarded support for
  versions in the declared `>=1.14.22 <1.16.0` range
- Git root and Gradle settings discovery from the project root or a module
  directory
- project name, Kotlin/Groovy DSL, Android namespace/application ID,
  multi-module, custom `projectDir`, version-catalog plugin aliases, and Gradle
  Wrapper detection
- a plugin compatibility boundary restricted to API fields and hooks shared
  by both certified OpenCode versions
- project-independent templates for the three V3 agents, four commands, and
  three scheduled-quality skills
- all 28 automation Bash files with their `0755` modes; scope and test-change
  gates consume detected source-set paths instead of a fixed module name
- a portable automation configuration source, both Schemas, contract example,
  plan guide, and bounded AGENTS managed block
- adaptive configuration for every detected Android module, default
  all-module task paths, opt-in primary-module restriction, exact protected
  build files, production/test source sets, and a namespace-aware focused-test
  placeholder
- removal of the legacy Scheduler dependency and all local absolute paths from
  shipped templates
- read-only `opencode.json`/`opencode.jsonc` merge planning that preserves
  existing fields, comments, plugin order, and plugin options while adding
  fixed Superpowers and orchestrator references
- conflict guards for malformed or ambiguous configuration, duplicate plugin
  packages, different managed-plugin references, and symbolic links
- a fail-closed installation preparation transaction that records package
  version, source, strategy, desired SHA-256/size/mode, and original-file
  backup metadata in `.automation-plugin/manifest.json`
- backup-before-manifest publication, stale/tampered plan rejection, backup and
  installed-file integrity reporting, installed-state completion, and guarded
  rollback of a prepared transaction
- read-only conflict reports with existing and desired hashes, sizes, modes,
  source, and strategy; installation planning fails closed before any write
  when `copy`/`generate` content or an existing file mode would be changed
- a write-capable `init` transaction that installs 45 managed files, preserves
  Shell executable modes, merges OpenCode JSON/JSONC and one bounded AGENTS
  block, and is byte-idempotent for an unchanged installed version
- write-before-complete verification using the 42-case automation suite and a
  read-only shadow run; any failure restores original files before reporting
  the error
- an installation-aware, read-only doctor that authenticates the 45-file
  inventory against packaged templates, separates content and permission
  drift, verifies original-file backups, and semantically checks the OpenCode,
  AGENTS, adaptive Android, and task-example configuration
- a fail-closed `upgrade` transaction that rejects managed-file or original
  backup drift, preserves the first installation's recovery state, records an
  immediate pre-upgrade snapshot and history, restores obsolete user files,
  reruns both post-write verifiers, and rolls the whole old version back on
  failure
- a transactional `uninstall` that validates the installed manifest, restores
  verified first-install originals, removes only exact managed-file matches,
  retains content, permission, and deletion drift, records recovery/history
  evidence, and automatically restores the installed state on pre-commit
  failure

The planners deliberately avoid filesystem writes. The adaptive planner blocks
ambiguous primary-module selections only in `primary` scope, as well as paths
outside the Git root and nested Gradle roots that the current root-relative
transaction scripts cannot safely run.
The transaction layer writes only installer control state and recovery
evidence until `init`, `upgrade`, or `uninstall` explicitly applies a validated
plan.

## Adaptive template planning

```js
import {
  planAdaptiveProjectTemplates,
} from "@frankzhang2026/opencode-android-orchestrator";

const plan = planAdaptiveProjectTemplates("/path/to/android-project", {
  moduleScope: "all", // optional; this is the default
  primaryModule: ":mobile", // optional focused-test default in all mode
});

console.log(plan.automationConfigContent);
console.log(plan.taskContractExampleContent);
```

The returned JSON contains repository-relative paths only. This API plans
content in memory; it does not create or modify target-project files.

## Conflict policy

`detectInstallationConflicts` is read-only and returns conflicts sorted by
target path. Missing files and files whose content and effective mode already
match are safe. Existing `copy`/`generate` files with different content are
conflicts, as is any requested mode change. `planInstallationPreparation`
enforces the same policy and throws `FILE_CONFLICT` before creating installer
control state; there is no silent-overwrite option.

The `merge` strategy permits a content difference only when the caller has
already produced the desired content with a structure-aware merge planner,
such as the OpenCode JSON/JSONC merger. It preserves the existing mode by
default, and an explicit mode change still conflicts. Backup preparation then
rechecks the planned original hash, size, and mode to close the gap between
conflict analysis and the first write.

## Installation preparation transaction

`planInstallationPreparation` snapshots every managed path in memory.
`prepareInstallationBackup` then verifies that the plan is unchanged, writes
original files below `.automation-plugin/backups/<installation-id>/`, verifies
their hashes and modes, and only then publishes a `prepared` manifest. A caller
may mark it `installed` only after every desired file matches the manifest.
`rollbackPreparedInstallation` restores originals and removes newly created
files only when their hashes still match a safe prepared state.

This API is the transaction foundation used by `init`. Callers must not treat
preparation alone as resource installation;
`applyInstallationPlan` performs the guarded write and completion transaction.

## Init

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.4.0 init .
opencode --agent scheduled-planner .
```

All detected modules are enabled by default, including multi-application
projects. Use the restrictive mode only when a task contract must stay within
one module:

```sh
opencode-android-orchestrator init . \
  --module-scope primary \
  --primary-module :mobile
```

Before writing, `init` requires a compatible OpenCode version, a Git-backed
Android Gradle project, an executable Gradle Wrapper, `git`, `jq`, `rg`,
`shasum`, Java, and an Android SDK directory from `ANDROID_HOME` or
`ANDROID_SDK_ROOT`. It then:

1. renders project-specific configuration and plans both safe merges;
2. rejects all unresolved content or mode conflicts;
3. backs up every existing managed path and publishes a `prepared` manifest;
4. writes missing or approved merged files with verified hashes and modes;
5. runs the 42 automation tests and `shadow-run.sh`;
6. marks the manifest `installed` only after both checks pass.

Verification failure automatically restores originals and records rollback
history; recovery backups remain below `.automation-plugin/backups/`. Repeating
`init` on an unchanged, healthy installation performs no managed-file writes.

Pin the exact package version in long-lived repositories and review the
generated installation diff before starting the scheduled planner.

## Doctor

```sh
opencode-android-orchestrator doctor /path/to/android-project
opencode-android-orchestrator doctor /path/to/android-project --json
```

The command exits unsuccessfully when OpenCode is missing or incompatible,
the target is not a Git Android project, the Gradle Wrapper or a required
command is unavailable, the SDK cannot be resolved, or any installed state is
unhealthy. SDK lookup uses an explicit API option, `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, then `local.properties` `sdk.dir`; an existing SDK root
without detectable `platforms` or `build-tools` is reported as a warning.

Installation checks are deliberately read-only and cover:

- manifest schema, installed state, fixed package version, `0600` mode, exact
  45-file inventory, sources, strategies, and packaged-template hashes;
- each managed file's SHA-256, size, and mode, including all 28 executable
  automation scripts;
- every original-file backup required for future recovery;
- pinned OpenCode and Superpowers references, the exact bounded AGENTS block,
  and adaptive automation/task configuration against the currently detected
  Android modules.

Human output and `--json` expose the same checks. Exit code `0` means there are
no failures (`warn` is allowed), `1` means at least one check failed, and `2`
means the CLI arguments were invalid. Doctor reports drift but never repairs or
rewrites the project.

## Read-only OpenCode tools

Loading the plugin registers two project-scoped custom tools:

- `android_orchestrator_status` accepts one required `taskId` matching
  `TASK-[A-Z0-9-]+` and returns the task contract, runtime state, and evidence
  as JSON;
- `android_orchestrator_doctor` accepts no arguments and returns the complete
  project, dependency, SDK, and installation report as JSON.

Both tools reject a call whose runtime context is outside the worktree that
loaded the plugin. Before `status` invokes anything, it authenticates the
installed manifest, managed-resource hashes, and executable modes against the
packaged version. It then invokes only the fixed
`scripts/automation/status.sh` path, passes the validated task ID as a separate
shell expression, bounds the output to 1 MiB, and verifies that the returned
contract ID matches the request. Neither tool asks for permission or writes
project state. The installed planner, coder, and reviewer agents explicitly
allow these two tool names while retaining their default-deny policy; source
preflight verifies both resolved permissions and tool discovery.

### Phase 2 mutating-tool decision

The 2026-08-25 evaluation remains **NO-GO for mutating custom tools in
`0.4.0`**.
The fixed Shell allowlist remains the only entry point for state transitions,
Git mutations, and agent launches. OpenCode custom tools provide typed arguments
and workspace context, but a normal permission prompt is not the workflow's
fresh semantic approval: permission requests can be approved for the rest of a
session and can be auto-approved unless explicitly denied. In addition, the
certified SDK declarations disagree on `ToolContext.ask` (`Effect.Effect<void>`
in `1.14.22`, `Promise<void>` in `1.15.13`), so it is not part of this plugin's
two-version common execution surface. See the OpenCode documentation for
[custom-tool context](https://opencode.ai/docs/custom-tools) and
[permission behavior](https://opencode.ai/docs/permissions/).

| Existing entry point | Material effects | Decision before a later phase |
| --- | --- | --- |
| `prepare-contract-review.sh` | Writes approval/origin evidence and initializes `CONTRACT_REVIEW` | Defer until a fresh proposal selection can produce a one-use receipt. |
| `approve-and-run.sh` | Acquires a repository lease, creates or switches a task branch/worktree, and launches agents | Do not wrap without a contract-approval receipt and cancellable long-running execution. |
| `show-acceptance-review.sh` | Reads sealed evidence but may regenerate `acceptance-report.json` | First split out a genuinely read-only, in-memory preview; that preview is the earliest suitable candidate. |
| `resume-review.sh` | Records a bounded resumption, changes `BLOCKED` to `REVIEWING`, and launches Reviewer | Consider only after command-bound authorization and subprocess cancellation are proven on both versions. |
| `accept-and-integrate.sh` | Creates the combined commit, fast-forwards the original branch, removes a worktree, and deletes the task branch | Do not wrap until final acceptance is bound to task ID, sealed diff, branch, session, and a consumed nonce. |
| `abort-task.sh` | Archives work, may create a recovery commit, switches/removes worktrees, and releases the lease | Do not wrap until an equally bound, one-use abort receipt exists. |

A future mutating tool must never accept an approval phrase as a model-provided
argument. It must atomically consume a machine-verifiable receipt created from
the immediately preceding `question` result and bind at least the approval
kind, task ID, session, message, relevant sealed SHA/branch, timestamp, and
nonce. It must also retain fixed-script authentication, strict state
preconditions, project/worktree bounds, abort propagation that terminates child
processes, bounded structured output, exact per-agent permissions, the 42-case
transaction suite, and real `1.14.22`/`1.15.13` integration tests. Internal
Coder/Reviewer transition scripts remain private orchestration details rather
than public tools.

## Upgrade

```sh
opencode-android-orchestrator upgrade /path/to/android-project
opencode-android-orchestrator upgrade . --module-scope all --json
```

`upgrade` accepts either the Git root or a directory below it. It first validates
the installed manifest, every managed file, and every original-file backup. It
refuses downgrades, user-modified managed resources, damaged backups, ambiguous
Android modules in restrictive `primary` scope, same-version resource rewrites,
and an unfinished upgrade marker before creating recovery state.

Upgrade preserves the installed module scope. Installations created before the
scope field existed are interpreted as `primary` so an upgrade cannot silently
widen write access; pass `--module-scope all` during a real version upgrade to
opt in explicitly.

For an older healthy installation, the command:

1. reconstructs merged AGENTS and OpenCode configuration from the original
   pre-install files rather than layering new output over an older merge;
2. saves the exact old manifest and immediate pre-upgrade file snapshots below
   `.automation-plugin/upgrades/<upgrade-id>/`;
3. carries the first installation's original backups into a new verified
   backup set;
4. writes only changed managed resources and restores or removes resources no
   longer managed by the new version;
5. runs the 42 automation tests and a mutation-free shadow run before swapping
   the active manifest;
6. records upgrade history below `.automation-plugin/history/`.

A verification failure automatically restores the old manifest and all old
managed resources. Recovery evidence remains available for inspection. Running
the command again on the current, unchanged version is byte-idempotent: it
rechecks prerequisites and post-install verification without creating upgrade
history or recovery state.

## Uninstall

```sh
opencode-android-orchestrator uninstall /path/to/android-project
opencode-android-orchestrator uninstall . --json
```

`uninstall` accepts the project root or a directory below it and does not
require the Android toolchain to remain healthy. It validates the installed
manifest and refuses another active upgrade or uninstall transaction before
creating recovery state. For every managed path it then applies one of these
rules:

1. if the content, size, and mode still match the installed manifest, restore
   the verified pre-install file or remove a plugin-created file;
2. if the path already matches its original state or is already absent when no
   original existed, leave it untouched;
3. if content, permissions, or existence drifted, retain the current state and
   list the path for manual review.

Before changing a file, the command records the active manifest and every
affected installed file below `.automation-plugin/uninstalls/<uninstall-id>/`
and publishes an uninstall marker. It verifies all final paths before removing
the active manifest and records completion below `.automation-plugin/history/`.
Any failure before that commit restores the complete installed state. Original
installation backups and uninstall evidence are intentionally retained for
audit and manual recovery; user-created or pre-existing empty directories are
never guessed at or recursively removed.

## Development

The package root exports only the default OpenCode plugin factory because the
OpenCode loader treats each root export as a plugin. Programmatic lifecycle and
diagnostic APIs are available from
`@frankzhang2026/opencode-android-orchestrator/api`.

```sh
npm run typecheck
npm test
npm run pack:check
```

## License

This project is available under the [MIT License](LICENSE). Third-party
software is licensed by its respective owners; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency scope,
copyright notices, and license texts. Superpowers is referenced as a pinned
external plugin and is not bundled into this package.
