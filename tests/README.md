# Tests

The current suite covers the shared OpenCode plugin API boundary, semantic
version compatibility, doctor reporting, Kotlin and Groovy Gradle projects,
multi-module discovery, custom module directories, negative discovery, and the
audited V3 template inventory, hashes, modes, portability constraints, and
Bash syntax. It also covers lossless JSON/JSONC plugin merging, idempotence,
fixed references, plugin options, CRLF/tab preservation, malformed input,
duplicates, version conflicts, ambiguous config files, and symbolic links.

Installer lifecycle and full two-version OpenCode integration tests will be
added with the remaining implementation stages.
