# OpenCode Android Orchestrator

Reusable OpenCode orchestration for macOS Android projects.

## Status

Version `0.1.0` was published as an early scaffold and does not provide a
working installer. Development now targets `0.2.0`; it must not be published
until the installer lifecycle and release gates are complete.

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
fails. Version `0.2.0` is still local-only and has not passed the release gates.

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
- adaptive configuration for every detected Android module, an unambiguous or
  explicitly selected primary module, exact protected build files, production
  and test source sets, and a namespace-aware focused-test placeholder
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
- write-before-complete verification using the 38-case automation suite and a
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

Both planners deliberately avoid filesystem writes. The adaptive planner also
blocks ambiguous primary modules, paths outside the Git root, and nested Gradle
roots that the current root-relative transaction scripts cannot safely run.
The transaction layer writes only installer control state and backups until
`init` or `upgrade` explicitly applies a conflict-free plan. Safe uninstall
remains a separate development stage.

## Adaptive template planning

```js
import {
  planAdaptiveProjectTemplates,
} from "@frankzhang2026/opencode-android-orchestrator";

const plan = planAdaptiveProjectTemplates("/path/to/android-project", {
  primaryModule: ":mobile", // optional when exactly one application is found
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
npx @frankzhang2026/opencode-android-orchestrator@0.2.0 init .
opencode --agent scheduled-planner .
```

For a multi-application project, select the primary module explicitly:

```sh
opencode-android-orchestrator init . --primary-module :mobile
```

Before writing, `init` requires a compatible OpenCode version, a Git-backed
Android Gradle project, an executable Gradle Wrapper, `git`, `jq`, `rg`,
`shasum`, Java, and an Android SDK directory from `ANDROID_HOME` or
`ANDROID_SDK_ROOT`. It then:

1. renders project-specific configuration and plans both safe merges;
2. rejects all unresolved content or mode conflicts;
3. backs up every existing managed path and publishes a `prepared` manifest;
4. writes missing or approved merged files with verified hashes and modes;
5. runs the 38 automation tests and `shadow-run.sh`;
6. marks the manifest `installed` only after both checks pass.

Verification failure automatically restores originals and records rollback
history; recovery backups remain below `.automation-plugin/backups/`. Repeating
`init` on an unchanged, healthy installation performs no managed-file writes.

Version `0.2.0` has not been published, so the `npx` example is the intended
post-release command rather than an instruction to publish or switch a live
project now.

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

## Upgrade

```sh
opencode-android-orchestrator upgrade /path/to/android-project
opencode-android-orchestrator upgrade . --primary-module :mobile --json
```

`upgrade` accepts either the Git root or a directory below it. It first validates
the installed manifest, every managed file, and every original-file backup. It
refuses downgrades, user-modified managed resources, damaged backups, ambiguous
Android modules, same-version resource rewrites, and an unfinished upgrade
marker before creating recovery state.

For an older healthy installation, the command:

1. reconstructs merged AGENTS and OpenCode configuration from the original
   pre-install files rather than layering new output over an older merge;
2. saves the exact old manifest and immediate pre-upgrade file snapshots below
   `.automation-plugin/upgrades/<upgrade-id>/`;
3. carries the first installation's original backups into a new verified
   backup set;
4. writes only changed managed resources and restores or removes resources no
   longer managed by the new version;
5. runs the 38 automation tests and a mutation-free shadow run before swapping
   the active manifest;
6. records upgrade history below `.automation-plugin/history/`.

A verification failure automatically restores the old manifest and all old
managed resources. Recovery evidence remains available for inspection. Running
the command again on the current, unchanged version is byte-idempotent: it
rechecks prerequisites and post-install verification without creating upgrade
history or recovery state.

Version `0.2.0` has not been published. These commands document the intended
post-release lifecycle and are not instructions to upgrade a live project yet.

## Development

```sh
npm run typecheck
npm test
npm run pack:check
```
