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
38-case Shell transaction suite runs against a non-default module path and
verifies dynamic production/test scope classification.

The installation transaction suite covers read-only SHA-256 planning,
backup-before-manifest ordering, stale and tampered plans, unsafe and symbolic
paths, backup integrity, installed-state completion, partial-install rollback,
user-modification guards, and the portable manifest Schema.

Managed-file conflict/application tests, the remaining lifecycle commands, and
full two-version OpenCode integration tests will be added with the remaining
implementation stages.
