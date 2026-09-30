# Tests

The current suite covers the shared OpenCode plugin API boundary, semantic
version compatibility, doctor reporting, Kotlin and Groovy Gradle projects,
project names, namespaces/application IDs, multi-module discovery, custom
module directories, negative discovery, and the audited V4 OpenCode template inventory,
hashes, modes, portability constraints, and Bash syntax. It also covers
read-only adaptive configuration rendering, primary-module selection and
ambiguity guards, repository-relative output, and lossless JSON/JSONC plugin
merging, idempotence,
the fixed Orchestrator reference, plugin options, CRLF/tab preservation, malformed input,
duplicates, version conflicts, ambiguous config files, and symbolic links. The
infrastructure resource suite additionally locks the portable V5 configuration
source, Schemas, task example, plan guide, and bounded AGENTS managed block. The
46-case Shell transaction suite runs against a non-default module path and
verifies dynamic production/test scope classification, required-prefix startup
blocking, dynamic prefix changes, and commit/evidence isolation.

The installation transaction suite covers read-only SHA-256 planning,
backup-before-manifest ordering, stale and tampered plans, unsafe and symbolic
paths, backup integrity, installed-state completion, partial-install rollback,
user-modification guards, the portable manifest Schema, sorted read-only
conflict reports, content and mode conflicts, identical-file reuse, explicit
merge handling, and no-write conflict failures.

The init suite installs the complete 52-file inventory into temporary Kotlin
and Groovy Android fixtures. It covers dynamic rendering, JSONC and AGENTS
merges, executable modes, write-before-complete verification, dependency
failure before control-state creation, repeated-init idempotence, conflict
abort, commit-prefix sidecar creation/preservation, and automatic restoration
after post-install verification failure.

The installed-doctor suite verifies a healthy installation from a module
directory, command and SDK discovery, the exact versioned inventory, packaged
template authentication, managed content and executable modes, backups,
OpenCode/AGENTS/adaptive configuration, fail-closed missing-manifest behavior,
and JSON CLI failure exit codes. It also distinguishes file-content drift from
permission drift and detects unsafe configuration or a self-consistent
manifest rewrite, while reporting an unfilled required prefix as a warning.

The upgrade suite covers read-only planning from a module directory, safe
older-version replacement, preservation of current user-owned AGENTS content,
replacement of its managed block, reconstruction of the OpenCode merge from
its first-install original, permission-drift tolerance, preserved recovery
lineage, obsolete user-file restoration, same-version byte idempotence,
ordinary managed-content and original-backup corruption refusal, malformed
AGENTS-marker refusal, downgrade refusal, tampered-plan refusal, complete
old-version restoration after post-upgrade verification failure, V4-to-V5
defaulting, and commit-prefix sidecar preservation.

The uninstall suite covers read-only planning from a module directory,
verified restoration of original merged files, removal of unchanged
plugin-created files, retention and reporting of content, permission, and
deletion drift, corrupted-backup refusal, upgrade/uninstall marker exclusion,
tampered-plan refusal, recovery and history evidence, JSON CLI output, and
complete installed-state rollback after a post-write failure. The human-owned
commit-prefix file is explicitly preserved. Only the full real OpenCode
compatibility matrix remains outside this suite.

The custom-tool suite verifies exact tool registration, task-ID schema and
runtime validation, worktree and abort boundaries, structured doctor output,
installation authentication before status execution, separate shell
expressions for the fixed script and task ID, fail-closed command and JSON
handling, the 1 MiB output bound, and unchanged filesystem state when an
installation is untrusted. Template tests also require explicit access to both
read-only tools for every scheduled agent.

The bundled-skill and package-content suites lock the five namespaced entry
points, required support files, executable mode, upstream license/provenance,
and exact npm tarball resource inventory. Run `npm run test:offline-discovery`
to launch the locally built plugin with isolated OpenCode data/configuration and
prove that all five skills are discoverable without the external Superpowers
plugin or network access.

The documentation suite locks the packaged migration, troubleshooting, and
security inventory; verifies every local Markdown link; requires fixed-version
migration paths, safe transaction-marker guidance, CLI exit-code and custom-tool
diagnostics, explicit trust limitations, and dual-version release gates; and
rejects local machine identifiers or floating `@latest` references.

## V4 test inventory

`npm test` includes shared queue/Shell contract validation, run-bound collection
validation, regression coverage, input/evidence tamper rejection, preparation
budgets, human-owned exclusions, and queue/reviewer/acceptance integration.
Regression cases also cover failed/early-rejected GREEN reruns, interrupted
sealing, baseline-inventory recovery guidance, and stale or malformed status
sidecars during a later queue execution.
Queue fixtures use real Git and Shell with model/Gradle substitutes; their
results are not a substitute for the explicit real-Gradle tests:

```sh
node --test tests/test-inventory-gradle.integration.mjs
node --test tests/test-inventory-android.integration.mjs
```

These tests keep their generated project and raw evidence and print its path.
They use a locally installed Gradle 9.4.1, Java, and cached JUnit4/Hamcrest;
set `ORCHESTRATOR_TEST_GRADLE`, `ORCHESTRATOR_TEST_JUNIT` and
`ORCHESTRATOR_TEST_HAMCREST` to override discovery. Android additionally uses
SDK 36 and AGP 9.2.1 (override `ORCHESTRATOR_TEST_AGP`), and exercises both Java
and Kotlin plus custom resources/assets/res. Set `ORCHESTRATOR_TEST_OFFLINE=1`
after dependencies are cached. This is a tested configuration, not a claim of
support for every Gradle/AGP version. JVM coverage includes multiple modules,
parameter instances, overlapping filters, skip/empty policies, NO-SOURCE,
real compilation failure and recovery, and repeated uncached Test execution.

Use `ORCHESTRATOR_INVENTORY_ARTIFACTS` to select an existing parent directory.
No real model request, publication, or target-project installation is performed
by these integration tests.

## V5 baseline recovery

`recovery-policy.test.mjs` checks explicit bounds, failure priority, jitter,
persistent independent budgets and elapsed/no-progress limits.
`queue-baseline-recovery.test.mjs` exercises the real Worker and installed Shell
chain using deterministic Gradle/Agent fixtures: full/discovery/collection
faults, retained checkpoints, service-state reload, explicit manual recovery,
budget exhaustion and input/evidence rejection. This is not a real provider,
Android Gradle, machine-restart or long-duration validation.

## V6 Worker supervision

`worker-supervision.test.mjs` covers policy bounds and identity/PID mismatch,
real marked process signals, a stopped Worker event loop, TERM-resistant Gradle
and detached descendants, an unrelated live process, continued independent
work with blocked dependencies, supervisor replacement during persisted TERM
grace, normal integration without signals and recovery of the same committed
transaction after timeout. Process and Shell behavior is real; Gradle/Agent
commands are deterministic fixtures. Sleep accounting is a clock-model test,
not a physical sleep/reboot or real provider endurance certification.


## V7 deterministic verification recovery

`stage-recovery.test.mjs` covers new approval requirements, durable counters and
backoff limits, real supervised Workers with transient RED/GREEN/Reviewer
failures, unchanged model/fix-cycle counts, exhaustion, input/log mutation during
backoff, ledger tampering and unowned checkpoint rejection, approved production
deletions, cumulative budgets across Review corrections, compilation failure
and unknown error rejection. Gradle and model
responses are fixtures; this does not certify live provider recovery.


## Android capability model

`project-capabilities.test.mjs` verifies custom roots, non-Debug tasks, reachable
JVM dependencies, complete build gates even without local tests, portable paths,
source/identity/task consistency and unsafe layouts. The shared managed validator
is invoked directly as well as through installation and doctor.

After `npm run build`, run `node --test tests/project-capabilities-android.integration.mjs`
for a real offline Gradle 9.4.1 / AGP 9.2.1 / SDK 36 multi-module fixture. It uses
custom Java/Kotlin/test-resource paths, remapped module directories, Staging unit
tests, transitive JVM dependencies and an unrelated failing JVM project. It checks
build, install, doctor, Shell config validation, upgrade preservation and uninstall.
Staging unit tests are explicitly enabled in the fixture. Gradle and compilation
are real; the OpenCode version and install-time smoke responses are fixtures.
No model requests, publishing, device runs or endurance claim are involved.
Override `ORCHESTRATOR_TEST_GRADLE`, `ORCHESTRATOR_TEST_AGP`, `ANDROID_HOME`, or
`ORCHESTRATOR_INVENTORY_ARTIFACTS` for local cached tools and retained artifacts.

`supervision-lock.test.mjs` also kills a real process immediately before and after
atomic lock publication, verifies complete owner records and exclusivity, and
checks released/replaced locks during process inspection. Partial legacy records
and unknown dead owners remain protected. Worker restart failures now emit bounded,
redacted service/lock diagnostics before fixture cleanup.

`stage-checkpoint.test.mjs` injects ledger edits before an update, immediately
after atomic publication, and inside checkpoint sealing. It checks that altered
bytes stay available for diagnosis and cannot become the approved retry budget.
Stage waiting no longer rewrites the ledger on every polling iteration.
