# Changelog

## Unreleased

- Add the human-maintained `.automation-worktree-allowlist` for exact local
  file paths that must not block orchestration. Approved tasks snapshot the
  validated list and exclude those changes consistently from scope, hashes,
  evidence, archival, and deterministic commits, including when the local
  entries were already staged.
- Reject patterns, directories, duplicates, unsafe paths, symlinks, oversized
  control files, and protected orchestration, Gradle, Git, or planning paths;
  treat renames as separate source and destination paths; expand the audited
  Shell transaction suite from 38 to 42 cases.

## 0.3.0 - 2026-08-28

- Add `all` and `primary` module scopes and make all-module task contracts the
  default for new installations. Multi-application projects no longer require
  a primary selection; upgrades from configurations without the scope field
  remain in `primary` mode unless explicitly widened.
- Add configurable Gradle verification task matrices to `init` and `upgrade`,
  and bind focused-test contract entries to both an allowed Gradle task and a
  test filter.
- Harden task-contract validation, source-scope enforcement, RED evidence,
  verification output, and integration checks while preserving protected
  Gradle and orchestration files.
- Retry OpenCode configuration discovery only for its known transient SQLite
  checkpoint failure.
- Expand multi-module, lifecycle, CLI, schema, migration, and compatibility
  coverage to 124 Node tests and the audited 38-case Shell suite.

## 0.2.0 - 2026-08-26

- Add the complete MIT license, packaged third-party notices, public repository
  metadata, draft release notes, and a fail-closed `0.2.0` authorization record.
- Keep the package root plugin-only for OpenCode's loader and expose lifecycle
  and diagnostic APIs from the explicit `./api` subpath.
- Keep shadow-run diagnostics on stderr so stdout remains one strict JSON
  document for installer verification and automation consumers.
- Restrict the plugin implementation to OpenCode APIs shared by `1.14.22` and
  `1.15.13`.
- Add certified OpenCode version detection and a functional `doctor` command.
- Add Git, Android module, Gradle DSL, custom module directory, version catalog,
  and Gradle Wrapper discovery.
- Add Kotlin DSL, Groovy DSL, compatibility, and doctor tests.
- Migrate the audited V3 agents, commands, and scheduled-quality skills as
  project-independent installation templates.
- Migrate all 28 audited V3 automation Shell files while preserving their
  executable modes and nested test-runner path.
- Migrate the remaining V3 configuration, Schemas, task example, and plan guide,
  and add a bounded AGENTS managed-block template.
- Add a safe, idempotent OpenCode JSON/JSONC configuration merge planner that
  retains comments, formatting, existing fields, plugin order, and options.
- Pin the installed Superpowers and orchestrator references, and reject
  ambiguous files, symbolic links, malformed configuration, duplicates, and
  managed-plugin version conflicts.
- Add a read-only adaptive template planner that derives the project name,
  modules, namespaces/application IDs, protected Gradle files, source-set
  paths, and focused-test placeholder without writing the target repository.
- Make agent permissions and deterministic scope gates work with detected
  Android module directories, including custom `projectDir` mappings.
- Remove the legacy Scheduler dependency, project-specific identifiers, and
  local absolute paths from all shipped templates.
- Treat absent legacy Scheduler tools as disabled during OpenCode discovery
  while retaining explicit deny rules and rejecting any enabled tool.
- Add the installation transaction foundation with verified pre-install
  backups, a portable versioned manifest Schema, per-file SHA-256/size/mode and
  recovery metadata, fail-closed plan validation, integrity reporting,
  installed-state completion, and guarded prepared-state rollback.
- Add read-only, structured managed-file conflict reporting and make
  installation planning reject differing `copy`/`generate` content and all
  requested changes to existing file modes before writing control state.
- Implement `init` with the complete 45-file project resource plan, adaptive
  Kotlin/Groovy output, lossless OpenCode JSON/JSONC and bounded AGENTS merges,
  executable-mode preservation, and unchanged-installation idempotence.
- Add pre-write OpenCode, Android, Gradle Wrapper, toolchain, Java, and SDK
  gates, then require the 38 automation tests and a mutation-free shadow run
  before completing the manifest; verification failures roll back originals.
- Complete the read-only installed-state `doctor` with command and SDK
  discovery, exact manifest/package inventory validation, packaged-template
  authentication, separate managed-content and permission checks, backup
  integrity, semantic configuration checks, JSON output, and failure exit
  codes.
- Implement `upgrade` with semantic-version and same-version guards, immutable
  managed-file and original-backup checks, reconstruction of merged files from
  first-install originals, immediate recovery snapshots, preserved recovery
  lineage, obsolete-resource restoration, transactional manifest replacement,
  upgrade history, idempotence, and automatic whole-version rollback when the
  automation or shadow verification fails.
- Implement `uninstall` with read-only planning, exact content/size/mode guards,
  verified restoration of first-install originals, removal of unchanged
  plugin-created files, retention and reporting of user drift, cross-transaction
  markers, recovery/history evidence, JSON output, and automatic pre-commit
  rollback.
- Add project-bounded `android_orchestrator_status` and
  `android_orchestrator_doctor` custom tools with strict task IDs, authenticated
  fixed-script execution, bounded and validated JSON output, default-deny agent
  permissions, and preflight discovery checks.
- Add packaged migration, troubleshooting, and security guides; expand the
  README with fixed-version prerequisites, a post-release quick start, the
  exact 45-resource installation inventory, workflow entry points, and links to
  operational recovery guidance.

## 0.1.0 - 2026-08-20

- Publish the initial TypeScript/npm scaffold. The lifecycle commands and V3
  installation templates were not implemented in this release.
