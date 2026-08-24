# Changelog

## 0.2.0 - Unreleased

- Restrict the plugin implementation to OpenCode APIs shared by `1.14.22` and
  `1.15.13`.
- Add certified OpenCode version detection and a functional `doctor` command.
- Add Git, Android module, Gradle DSL, custom module directory, version catalog,
  and Gradle Wrapper discovery.
- Add Kotlin DSL, Groovy DSL, compatibility, and doctor tests.
- Migrate the audited V3 agents, commands, and scheduled-quality skills as
  byte-preserved installation templates.
- Migrate all 28 audited V3 automation Shell files while preserving their
  executable modes and nested test-runner path.
- Add a safe, idempotent OpenCode JSON/JSONC configuration merge planner that
  retains comments, formatting, existing fields, plugin order, and options.
- Pin the installed Superpowers and orchestrator references, and reject
  ambiguous files, symbolic links, malformed configuration, duplicates, and
  managed-plugin version conflicts.

## 0.1.0 - 2026-08-20

- Publish the initial TypeScript/npm scaffold. The lifecycle commands and V3
  installation templates were not implemented in this release.
