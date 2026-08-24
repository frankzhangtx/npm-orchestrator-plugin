# Changelog

## 0.2.0 - Unreleased

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

## 0.1.0 - 2026-08-20

- Publish the initial TypeScript/npm scaffold. The lifecycle commands and V3
  installation templates were not implemented in this release.
