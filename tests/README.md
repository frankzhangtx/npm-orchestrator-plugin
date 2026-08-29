# Tests

The current suite covers the shared OpenCode plugin API boundary, semantic
version compatibility, doctor reporting, Kotlin and Groovy Gradle projects,
project names, namespaces/application IDs, multi-module discovery, custom
module directories, negative discovery, and the audited V3 template inventory,
hashes, modes, portability constraints, and Bash syntax. It also covers
read-only adaptive configuration rendering, primary-module selection and
ambiguity guards, repository-relative output, and lossless JSON/JSONC plugin
merging, idempotence,
fixed references, plugin options, CRLF/tab preservation, malformed input,
duplicates, version conflicts, ambiguous config files, and symbolic links. The
infrastructure resource suite additionally locks the portable V3 configuration
source, Schemas, task example, plan guide, and bounded AGENTS managed block. The
42-case Shell transaction suite runs against a non-default module path and
verifies dynamic production/test scope classification.

The installation transaction suite covers read-only SHA-256 planning,
backup-before-manifest ordering, stale and tampered plans, unsafe and symbolic
paths, backup integrity, installed-state completion, partial-install rollback,
user-modification guards, the portable manifest Schema, sorted read-only
conflict reports, content and mode conflicts, identical-file reuse, explicit
merge handling, and no-write conflict failures.

The init suite installs the complete 45-file inventory into temporary Kotlin
and Groovy Android fixtures. It covers dynamic rendering, JSONC and AGENTS
merges, executable modes, write-before-complete verification, dependency
failure before control-state creation, repeated-init idempotence, conflict
abort, and automatic restoration after post-install verification failure.

The installed-doctor suite verifies a healthy installation from a module
directory, command and SDK discovery, the exact versioned inventory, packaged
template authentication, managed content and executable modes, backups,
OpenCode/AGENTS/adaptive configuration, fail-closed missing-manifest behavior,
and JSON CLI failure exit codes. It also distinguishes file-content drift from
permission drift and detects unsafe configuration or a self-consistent
manifest rewrite.

The upgrade suite covers read-only planning from a module directory, safe
older-version replacement, reconstruction of AGENTS and OpenCode merges from
their first-install originals, preserved recovery lineage, obsolete user-file
restoration, same-version byte idempotence, managed-file and original-backup
drift refusal, downgrade refusal, tampered-plan refusal, and complete
old-version restoration after post-upgrade verification failure.

The uninstall suite covers read-only planning from a module directory,
verified restoration of original merged files, removal of unchanged
plugin-created files, retention and reporting of content, permission, and
deletion drift, corrupted-backup refusal, upgrade/uninstall marker exclusion,
tampered-plan refusal, recovery and history evidence, JSON CLI output, and
complete installed-state rollback after a post-write failure. Only the full
real OpenCode compatibility matrix remains outside this suite.

The custom-tool suite verifies exact tool registration, task-ID schema and
runtime validation, worktree and abort boundaries, structured doctor output,
installation authentication before status execution, separate shell
expressions for the fixed script and task ID, fail-closed command and JSON
handling, the 1 MiB output bound, and unchanged filesystem state when an
installation is untrusted. Template tests also require explicit access to both
read-only tools for every scheduled agent.

The documentation suite locks the packaged migration, troubleshooting, and
security inventory; verifies every local Markdown link; requires fixed-version
migration paths, safe transaction-marker guidance, CLI exit-code and custom-tool
diagnostics, explicit trust limitations, and dual-version release gates; and
rejects local machine identifiers or floating `@latest` references.
