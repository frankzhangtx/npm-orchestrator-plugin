# Troubleshooting

Use this guide for
`@frankzhang2026/opencode-android-orchestrator@0.3.0`.

## Start with read-only evidence

From the repository root, capture:

```sh
git status --short --branch
git rev-parse HEAD
opencode --version
npx @frankzhang2026/opencode-android-orchestrator@0.3.0 doctor . --json
```

If installation never completed, doctor will correctly report a missing or
invalid installed manifest. Preserve the complete error code and details from
the command that failed. Do not rerun a write command repeatedly while the
working tree or installer control state is changing.

The CLI uses these exit codes:

| Exit code | Meaning |
| ---: | --- |
| `0` | Command completed, or doctor found no failed check. Doctor warnings are allowed. |
| `1` | A lifecycle operation failed, or doctor found at least one failed check. |
| `2` | Unknown command or invalid CLI arguments. |

`doctor --json` always emits a structured report. The `--json` option on
`init`, `upgrade`, and `uninstall` structures successful results; thrown errors
remain human-readable on stderr with a stable code such as `[FILE_CONFLICT]`.

## Prerequisite and discovery failures

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| `DOCTOR_FAILED` before any write | One or more required project/tool checks failed. | Read each failed doctor check; fix only the named prerequisite, then rerun doctor or init. |
| OpenCode version failure | Installed version is below `1.14.22`, at or above `1.16.0`, or cannot be parsed/executed. | Install a certified version (`1.14.22` or `1.15.13`) for release validation. Do not bypass the version gate. |
| Git root or Android project not detected | The target is outside a Git repository, settings are missing, or no supported Android module was found. | Run from the intended repository/module and inspect `settings.gradle` or `settings.gradle.kts`. Nested Gradle roots are intentionally unsupported. |
| Gradle Wrapper failure | `gradlew` or `gradle/wrapper/gradle-wrapper.properties` is missing, or `gradlew` is not executable. | Restore the project's reviewed Wrapper files. Do not let the installer generate or replace build configuration. |
| `MODULE_SCOPE_INVALID` or an invalid `--module-scope` argument | The value is not `all` or `primary`. | Use `all` for the default all-module contract or `primary` for an intentional single-module restriction. |
| `PRIMARY_MODULE_AMBIGUOUS` | Restrictive `primary` scope has multiple possible Android modules. | Supply an exact Gradle path, for example `--module-scope primary --primary-module :mobile`, or use the default `all` scope. |
| `PRIMARY_MODULE_NOT_FOUND` | The selected Gradle path was not detected. | Use a module path reported by doctor/project detection; do not pass a filesystem directory. |
| Android SDK failure | No valid explicit SDK, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or `local.properties` `sdk.dir` was found. | Configure one real SDK root containing `platforms/` and `build-tools/`. Do not publish `local.properties`. |
| Missing `git`, `jq`, `rg`, `shasum`, or Java | Required deterministic command is unavailable on `PATH`. | Install or restore the missing command, record its version, and rerun the read-only checks. |

After installation, inspect OpenCode discovery separately:

```sh
opencode debug config
opencode debug skill
opencode debug agent scheduled-planner
opencode debug agent scheduled-coder
opencode debug agent scheduled-reviewer
```

Then run `./scripts/automation/preflight.sh --source`. It validates pinned
plugins, required skills, agent permissions, and both read-only custom tools.
If it fails, preserve its exact output. Do not broaden an agent's default-deny
permissions to make discovery pass.

## Worktree allowlist failures

Use `.automation-worktree-allowlist` only for intentional local changes that
must remain outside every task diff and commit. The file belongs in the Git
repository root, with one exact repository-relative file path per line.

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| `Git worktree is dirty` | At least one tracked or untracked change is not listed. | Inspect `git status --short`. Commit/revert the task-relevant change, or add only an intentionally local exact file path to the allowlist. |
| `must be exact file paths, not patterns` | An entry contains `*`, `?`, or bracket syntax. | Replace it with each exact file path; directory-wide bypasses are intentionally unsupported. |
| `must not include a protected path` or `reserved or unsafe` | The entry targets orchestration, Gradle, Git metadata, a plan, or another protected path. | Remove the entry. Protected control and planning files must remain visible to the gates. |
| `must be a regular file, not a symlink` | The control file is a symlink or another unsupported file type. | Replace it with a small regular text file at the repository root. |
| A task does not include a file you expected it to edit | The path was in the snapshot taken at contract approval. | Finish/abort the active task, remove the entry, then start and approve a new task. |
| A local rename still blocks startup | Only the new or old name is listed. | Add both exact paths; rename detection treats the source deletion and destination addition independently. |

The control file itself does not block orchestration and does not require a
`.gitignore` entry for that purpose. Git may still display it in ordinary
`git status`, which is separate from the orchestrator's filtered view. Staged
allowlisted entries remain staged and are not consumed by task or abort commits.

## Installation conflicts

Common fail-closed codes include:

| Code | Meaning | Response |
| --- | --- | --- |
| `FILE_CONFLICT` | Existing content or mode differs from a `copy`/`generate` target. | Compare the named path with the packaged template. Preserve local policy elsewhere or restore the audited file deliberately; there is no force flag. |
| `AMBIGUOUS_CONFIG` | Both `opencode.json` and `opencode.jsonc` exist. | Select and consolidate the user-owned configuration in a separate reviewed change. |
| `PLUGIN_VERSION_CONFLICT` | The same managed package identity has another reference/version. | Review and remove or migrate only the obsolete entry; never let init silently replace it. |
| `DUPLICATE_PLUGIN` or `DUPLICATE_PROPERTY` | Configuration identity is ambiguous. | Correct the JSON/JSONC structure without discarding unrelated fields or comments. |
| `INVALID_JSONC` or `ROOT_NOT_OBJECT` | OpenCode configuration cannot be merged safely. | Repair the user-owned file and validate it before retrying. |
| `AGENTS_BLOCK_CONFLICT` or `AGENTS_MARKERS_INVALID` | The bounded managed block is modified, partial, or duplicated. | Restore one exact managed block; keep project-specific instructions outside its markers. |
| `FILE_SYMLINK`, `TARGET_SYMLINK`, or `CONFIG_SYMLINK` | A managed target or ancestor is a symbolic link. | Replace it only after understanding ownership and destination. The installer intentionally does not follow it. |
| `PLAN_STALE` or `TARGET_MODIFIED` | A file changed between planning and application. | Stop concurrent edits, inspect the diff, and rerun from a stable state. |

An init verification failure reports `POST_INSTALL_VERIFICATION_FAILED` and
automatically rolls back the prepared installation. Confirm the original files
and inspect `.automation-plugin/history/`; do not assume a failed init left a
usable installation.

## Manifest, upgrade, and uninstall failures

Run doctor before deciding on recovery. Its installation section distinguishes
manifest identity, content drift, permission drift, backups, and semantic
configuration.

| Code or check | Meaning | Response |
| --- | --- | --- |
| `MANIFEST_MISSING`, `MANIFEST_INVALID`, or `MANIFEST_STATE` | No trustworthy installed manifest is available. | Do not invent a manifest or copy one from another project. Determine whether this is an uninstalled/manual setup or an interrupted transaction. |
| `EXISTING_INSTALLATION_DIFFERENT` | `init` found another installed inventory/version. | Use `upgrade` for a healthy older manifest. |
| `EXISTING_INSTALLATION_INVALID` or `INSTALLATION_INVALID` | Manifest, installed files, or required backups failed validation. | Preserve the project and `.automation-plugin/`; inspect doctor details and recovery history. |
| `INSTALLED_FILES_MODIFIED` | Upgrade found content, existence, mode, or backup drift. | Move intentional customization out of managed paths or choose manual recovery. Upgrade will not overwrite it. |
| `VERSION_DOWNGRADE_REFUSED` | Target package is older than the installed manifest. | Use a newer fixed package version; never edit the manifest version. |
| `UPGRADE_IN_PROGRESS` or `UNINSTALL_IN_PROGRESS` | `.automation-plugin/upgrade.json` or `uninstall.json` records an unfinished transaction. | Inspect the marker and matching recovery directory. Do not delete the marker merely to retry. |
| `POST_UPGRADE_VERIFICATION_FAILED` | New resources failed verification. | The implementation attempts a complete old-version rollback; verify the old manifest and inspect upgrade evidence. |
| `UNINSTALL_CONFLICT` | Uninstall planning/application detected unsafe state. | Keep all files and inspect the listed paths. Drift is retained by design. |
| `POST_UNINSTALL_VERIFICATION_FAILED` | Final restored/removed paths did not verify. | The implementation attempts to restore the installed state; inspect uninstall recovery evidence before another command. |
| Any `*_ROLLBACK_FAILED` | Automatic recovery could not prove completion. | Stop all automation. Preserve Git refs, the manifest, marker, backups, recovery snapshots, and logs for manual analysis. |

Installer control paths are:

- active manifest: `.automation-plugin/manifest.json` (`0600`);
- first-install/original backups: `.automation-plugin/backups/<id>/`;
- upgrade marker and snapshots: `.automation-plugin/upgrade.json` and
  `.automation-plugin/upgrades/<id>/`;
- uninstall marker and snapshots: `.automation-plugin/uninstall.json` and
  `.automation-plugin/uninstalls/<id>/`;
- completed/rolled-back records: `.automation-plugin/history/`.

These files are evidence, not cache.

## Read-only custom tool failures

`android_orchestrator_status` accepts exactly one `TASK-[A-Z0-9-]+` ID. It
authenticates the installation before invoking the fixed status script.

| Code | Meaning |
| --- | --- |
| `INVALID_TASK_ID` | The ID contains invalid characters, extra text, or an unsupported format. |
| `WORKSPACE_MISMATCH` | The tool context differs from the worktree that loaded the plugin. |
| `UNTRUSTED_INSTALLATION` | Manifest, packaged resource, or executable-mode checks could not authenticate the installed status script. |
| `STATUS_RUNNER_UNAVAILABLE` | OpenCode did not supply the compatible shell adapter. |
| `STATUS_COMMAND_FAILED` | The authenticated status script returned a nonzero exit. Its details usually identify a missing contract or invalid runtime layout. |
| `INVALID_STATUS_OUTPUT` | Output was not valid JSON or identified another task. |
| `STATUS_OUTPUT_TOO_LARGE` | Output exceeded the 1 MiB safety bound. |
| `TOOL_ABORTED` | The OpenCode call was cancelled before execution. |

Do not bypass `UNTRUSTED_INSTALLATION` by calling a different script path. Run
doctor, restore the exact managed installation, or perform a reviewed recovery.

## Automation task recovery

Use `./scripts/automation/status.sh <TASK-ID>` or the read-only status tool to
identify the state, workspace, original branch, sealed diff, and evidence.

- `AWAITING_HUMAN`: use `/acceptance <TASK-ID>` to regenerate the verified
  review card and fresh result question.
- `BLOCKED` after a Reviewer exited without submitting a decision: use
  `/resume-review <TASK-ID>`. The script accepts only the bounded reviewer-only
  recovery and proves the sealed diff has not changed.
- A supported stopped state that should be abandoned: use
  `/abort-task <TASK-ID>`, inspect the status card, and complete its explicit
  confirmation. It archives contract-scoped work before restoring the original
  branch.
- `INTEGRATION_BLOCKED`: preserve the task branch, original branch, lease, and
  integration evidence. Do not reset, cherry-pick, merge, or rerun the
  integrator until the recorded refs and failure are understood.
- `TEST_FAILED` or `NEEDS_HUMAN`: inspect the contract and evidence. Do not
  broaden scope or silently queue the same task again.

## Actions to avoid

Never use a troubleshooting shortcut that destroys the evidence needed to
prove recovery:

- do not run `git reset --hard`, `git clean`, an improvised merge/rebase, or a
  manual branch deletion;
- do not edit manifest hashes, state JSON, approvals, or sealed evidence;
- do not recursively delete `.automation-plugin/` or
  `.git/automation-runtime/`;
- do not chmod all managed files to silence permission drift;
- do not replace a pinned package reference with `latest`;
- do not expose `.env`, signing keys, keystores, `local.properties`, npm tokens,
  model-provider credentials, or recovery diffs in public reports.

For escalation, provide the command, exit code, stable error code, redacted
details, OpenCode version, package version, current branch/HEAD, and the list of
affected paths. Share file contents only after applying the guidance in
[Security](SECURITY.md).
