# Migration guide

This guide covers migration to
`@frankzhang2026/opencode-android-orchestrator@0.10.0`. Pin the exact version and
prove the migration in a disposable clone before changing a long-lived
repository.

## Choose the migration path

| Current state | Correct command after release | Important distinction |
| --- | --- | --- |
| No orchestrator files or manifest | `npx @frankzhang2026/opencode-android-orchestrator@0.10.0 init .` | Normal new installation; all runtime-detected Android modules and registered debug verification tasks are discovered automatically. |
| Published `0.1.0` scaffold only | Remove any project-local `@0.1.0` plugin reference after review, then run `init`. | `0.1.0` did not create a usable managed installation and cannot be upgraded. |
| `0.2.0` through `0.9.0` manifest-managed installation with intact managed/backup content | Run the `0.10.0` `upgrade`; add `--refresh-gradle-discovery` when generated module/task lists are incomplete. | Refresh replaces all derived module metadata, source paths, protected build files, and task allowlists from one Gradle runtime snapshot. Module scope, operator policies, user-owned AGENTS content, and an existing commit-prefix sidecar remain preserved. |
| Manually copied V3 files, no `.automation-plugin/manifest.json` | Finish active tasks, preserve historical evidence separately, then run `init`. | Exact files can be reused; differing managed files fail as conflicts. |
| Healthy older manifest-managed installation | Run `doctor`, then the fixed target version's `upgrade`. | `upgrade` requires a valid installed manifest and intact original backups. |
| Healthy current-version manifest | Run `doctor`; repeated `init` or same-version `upgrade` is verification-only and byte-idempotent. | Do not reinstall or delete the manifest. |
| Damaged manifest, ordinary managed-content drift, or damaged backup content | Stop and investigate. | `init` and `upgrade` intentionally refuse to overwrite this state. AGENTS content outside its managed block and Unix-mode drift are handled by `0.10.0 upgrade`. |

`uninstall` is not an upgrade shortcut. It restores verified pre-install files,
removes unchanged plugin-created files, and retains drift for manual review.

## Before migration

1. Finish, explicitly abort, or otherwise account for every active automation
   task. Do not migrate while a task holds the repository lease or owns an
   active task branch/worktree.
2. Use a dedicated clean branch. Record `git status --short`, the current
   branch, and `git rev-parse HEAD`. Preserve an independent repository backup.
3. Record the current OpenCode version with `opencode --version`. Certified
   targets are exactly `1.14.22` and `1.15.13`.
4. Preserve the current `opencode.json`/`opencode.jsonc`, `AGENTS.md`,
   `.opencode/`, `automation/`, and `scripts/automation/` for review. Never
   include `.env`, signing keys, npm credentials, or `local.properties` in a
   support bundle.
5. If a managed manifest already exists, the installed version's doctor may be
   used to collect read-only evidence. A mode warning/failure or an AGENTS
   content mismatch does not by itself prevent `0.10.0 upgrade`; the target
   upgrade performs its own content-safe checks. Do not edit manifest hashes to
   make doctor pass.
6. Prove the migration in a disposable clone or temporary Android fixture
   before applying it to the intended repository.

## From the `0.1.0` scaffold

The published `0.1.0` package did not install the 47 current project resources and did
not create `.automation-plugin/manifest.json`. Treat it as an uninstalled
scaffold, not as an older managed installation.

If the project OpenCode configuration contains an exact
`@frankzhang2026/opencode-android-orchestrator@0.1.0` entry, save the file and
remove only that obsolete entry in a reviewed Git change before running
`0.10.0 init`. The merger deliberately rejects a different version of the same
managed package; it will not silently replace the reference. A global npm
installation of `0.1.0` alone does not require project-file cleanup.

After release, initialize with the fixed version:

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.10.0 init .
```

New installations default to all-module scope, so multiple application modules
do not require a selection. Use
`--module-scope primary --primary-module :mobile` only when generated task
contracts must be restricted to `:mobile`. In all-module scope,
`--primary-module :mobile` merely chooses the focused-test placeholder's
default module.

## From a manually copied V3 setup

Manual V3 installations have no installer manifest, so the installer cannot
know which files were copied, customized, or created by the user. Apply these
rules:

- Historical task contracts, plans, and `.git/automation-runtime/` evidence are
  not imported into the new installation. Preserve or archive them separately;
  do not copy them into package templates or `.automation-plugin/`.
- A fixed managed file is reusable only when its bytes and effective mode
  already match the packaged template. Any differing `copy` or `generate`
  target is a `FILE_CONFLICT`; there is no force flag.
- Move legitimate local policy out of managed agent, command, skill, or Shell
  files before installation. Put project rules in the unmanaged portion of
  `AGENTS.md` and product behavior in normal project sources. Editing ordinary
  managed file content after installation creates drift and blocks a future
  upgrade.
- `AGENTS.md` is merged through one bounded marker block. Existing content
  outside that block remains user-owned.
- OpenCode JSON/JSONC is merged structurally. Existing fields, comments, plugin
  order, and plugin options are retained. Duplicate package identities,
  malformed JSONC, both `opencode.json` and `opencode.jsonc`, symbolic links,
  or another orchestrator version are hard conflicts.
- The installer does not remove an unrelated legacy Scheduler plugin. Review
  and remove that reference only as a separate Git diff after the new
  installation passes discovery, shadow, and rollback review.

Run `init` only after resolving conflicts explicitly. Replacing a customized
managed template with the packaged version is a migration decision: preserve
the old file outside the managed path, review the diff, and never rely on the
installer to guess which customization should survive.

## From a manifest-managed version

Use the lifecycle command selected by the active manifest:

```sh
npx --yes --registry=https://registry.npmjs.org/ \
  @frankzhang2026/opencode-android-orchestrator@0.10.0 upgrade . --json
```

The command-level Registry option is useful when a company-wide npm Registry
points to an internal host that cannot serve the public package. It does not
change the saved npm configuration.

`upgrade` verifies the installed manifest, ordinary managed-file content, and
first-install backup content before it creates recovery state. It ignores
Unix-mode differences during this preflight, snapshots the actual bytes and
modes for rollback, and writes the target package modes. It reconstructs the
OpenCode merge from its original pre-install file. For `AGENTS.md`, it removes
the one well-formed old managed block, preserves all current content outside
that block, appends the new managed block, and carries the preserved user
content into the new uninstall backup. If both markers were removed, the whole
current file is preserved before the new block is appended.

Upgrade preserves an installed `androidProject.moduleScope`. A legacy
manifest-managed configuration without that field is treated as `primary`,
which prevents an upgrade from silently expanding its editable module set. To
adopt all-module scope during a version upgrade, pass `--module-scope all` and
review the regenerated task example before approving automation.

Versions through `0.8.1` could undercount modules when `settings.gradle[.kts]`
computed includes dynamically or a company convention plugin applied
`com.android.*` indirectly. If `androidProject.modules` or
`gradleVerification.focusedTestTasks` is incomplete, use the one-shot refresh:

```sh
npx --yes --registry=https://registry.npmjs.org/ \
  @frankzhang2026/opencode-android-orchestrator@0.10.0 upgrade . \
  --refresh-gradle-discovery --json
```

This does not run or parse `tasks --all`. It configures Gradle once with a
temporary init script, asks each evaluated project which Android plugin is
actually applied, and reads registered task names without realizing the full
task report. The resulting module/path/task configuration is written through
the normal verified upgrade transaction. Omit the flag when the installed task
matrix was intentionally supplied with `--gradle-verification-config` and must
remain unchanged. An explicit refresh may be rerun on an already installed
`0.10.0` after the Gradle module graph changes; if its generated resources are
unchanged, the operation remains byte-idempotent.

Upgrade also preserves an installed `longCommandTimeoutMs`. Installations from
before `0.6.1` have no value to preserve and receive `1800000` milliseconds.
To choose another value during migration, pass
`--long-command-timeout-ms <milliseconds>`; the accepted range is `120000`
through `7200000`.

Unit-test and Android lint verification are repository policies in
`automation/config.json`. Existing boolean values are preserved. Older
configurations receive `unitTestsEnabled: true` and `lintEnabled: false`.
After migration, change only those two values or `commitMessagePrefixMode` in
place and commit the configuration; there are no `init` or `upgrade` flags for
these policies.

Schema V5 defaults `commitMessagePrefixMode` to `required`. Upgrade from
`0.8.1` or any other earlier managed release succeeds and creates
`automation/automation-commit-prefix` only when that human-owned file is
absent. The created comments-only template is intentionally unconfigured:
before starting a new task, edit it and put the current company prefix on one
non-comment line. Do not add the prefix file to the installation manifest; it
is excluded from task diffs and preserved across later upgrades and uninstall.
If repository policy intentionally does not require a prefix, set the mode to
`disabled` in a separate reviewed configuration change.

Upgrading a healthy `0.7.0` installation removes the exact managed Superpowers
v6.2.0 plugin reference that the older Orchestrator added. Upgrade rebuilds the
OpenCode merge from the verified original pre-install file, so ownership stays
bounded: if that exact reference was already present before Orchestrator was
installed, it remains user-owned and is preserved. Other Superpowers versions,
plugin entries, options, comments, and configuration fields are not silently
removed. Version `0.8.0` instead registers its five package-local,
`android-orchestrator-*` workflow skills through the OpenCode `config` hook.

The command refuses:

- a downgrade or malformed semantic version;
- a missing, non-installed, foreign-package, or modified manifest;
- content or existence drift in ordinary managed files;
- missing or content-modified original backups;
- partial, out-of-order, or duplicate AGENTS markers;
- an unfinished upgrade or uninstall marker;
- a stale plan or changed file between planning and application.

Do not repair those conditions by editing the manifest or its hashes. Diagnose
the source of drift and use the recorded recovery data.

## Post-migration verification

Run all checks from the detected Git root:

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.10.0 doctor .
opencode debug config
opencode debug skill
opencode debug agent scheduled-planner
opencode debug agent scheduled-coder
opencode debug agent scheduled-reviewer
./scripts/automation/preflight.sh --source
./scripts/automation/tests/run-tests.sh
./scripts/automation/shadow-run.sh
```

Verify all of the following before switching normal work to the plugin:

- doctor has no failed check;
- all three agents, five commands, three scheduled-quality skills, and five
  `android-orchestrator-*` workflow skills are discoverable;
- both read-only custom tools resolve for the scheduled agents;
- `automation/automation-commit-prefix` contains the reviewed current prefix
  when `commitMessagePrefixMode` is `required`;
- the Shell suite ends with `1..46`;
- shadow output contains `"mutationPerformed": false`;
- `git status --short` contains only the reviewed installation diff;
- no Git push, launchd registration, extra candidate worktree, or copied Android
  project was created.

Complete one small task in a disposable project before accepting the migration
for a long-lived repository.

## Rollback

- A failed `init` automatically restores pre-install files before reporting
  failure. It retains verified backups and rollback history under
  `.automation-plugin/` for diagnosis.
- A failed `upgrade` automatically restores the complete old manifest and old
  managed resources. Inspect `.automation-plugin/upgrades/<upgrade-id>/` and
  `.automation-plugin/history/`.
- After a successful install, use the fixed version's `uninstall` command for
  a guarded removal. It restores original files, removes exact plugin-created
  matches, and leaves drift untouched.
- Never delete `.automation-plugin/upgrade.json`,
  `.automation-plugin/uninstall.json`, the manifest, backups, or recovery
  directories merely to make a command continue. An unfinished marker means
  the transaction requires evidence-based recovery.
- Switching an existing production repository from its old orchestration setup
  remains a separate human approval and Git commit from package installation.

See [Troubleshooting](TROUBLESHOOTING.md) for failure-specific diagnostics and
[Security](SECURITY.md) before sharing recovery evidence.
