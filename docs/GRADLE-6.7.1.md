# Gradle 6.7.1 review fixes (1.2.0)

These changes are included in 1.2.0 and are absent from
1.1.0. Use the pinned 1.2.2 package, including the lazy Android
test-output compatibility fix. Do not copy individual
managed files into an existing installation or reuse evidence made with the
previous collector. Keep existing evidence and approve a new task after upgrade.

## Runtime and source discovery

The collector reads its request from Gradle's start parameters before falling
back to System properties. Missing, relative and unreadable request paths fail
explicitly. Source discovery reads Gradle dynamic properties, including Kotlin
1.4.x extensions on AGP 4.2 source sets; getter failures are not silently ignored.

Doctor executes the selected wrapper's `help` with a runtime init script. It
reports the actual build JVM rather than inferring it from PATH `java`. Each
inventory run records Gradle, build JVM/home/vendor, Android/Kotlin plugin
implementation/version/artifact digest, and configured Test JVM executable/metadata.
RED/GREEN must match the baseline runtime. Environment, Gradle user properties,
init scripts, local properties and available JVM executables are fingerprinted;
changing these inputs invalidates verification or recovery evidence. This is
not an OS sandbox or a proof against malicious build scripts. Test JVM settings
are captured after project configuration; this does not observe the internals
of every forked test process or prove that custom execution hooks cannot change
its environment later.

For Gradle 6.7.1 select a compatible build JDK before starting the service, using
the project's reviewed `org.gradle.java.home` configuration or the launch
environment. Existing background services retain their environment: safely stop
active work and restart the service after an environment change. Doctor must
pass from the same environment used by the service.

Independent legacy fixtures use Gradle 6.7.1, AGP 4.2.2, Kotlin 1.4.32 and
Corretto 8u312. These versions describe a tested fixture, not the user's unknown
target project or every AGP/Kotlin/JDK combination. Keep the actual target's
Gradle version and validate its dependency repositories, SDK/NDK and variants.

## Failure origin and criterion evidence

V4–V8 expected failures now require a stack containing the exact test-body
invocation and a matching first non-assertion frame. Setup, teardown, rule and
initialization failures, missing stacks and mismatched locations cannot become
RED merely because the exception and message match. Prefer a structured origin:

```json
{
  "type": "java.lang.AssertionError",
  "messageIncludes": "approved answer",
  "origin": {
    "className": "example.InputTest",
    "methodName": "rejectsInvalidInput",
    "fileName": "InputTest.kt",
    "lineNumber": 42
  }
}
```

File/line are optional. Existing descriptive origin strings mean a direct
failure in the declared test method; they no longer authorize arbitrary helper
or fixture failures. Standard parameter suffixes are removed from the exact
test name when identifying its method. Custom runners whose identities/stacks
cannot establish that method fail closed. Review still checks assertion meaning.
The legacy V1–V3 protocol is unchanged and does not acquire these guarantees.

Every acceptance criterion must be referenced by a declared case or an explicit
`verification.criteriaEvidence` entry. An entry contains `criterion`, `kind`
and nonempty `references`: behavior case IDs for `behavior`, configured mandatory
tasks for `build`, enabled `lint`, or contract-required `device` tasks. Disabled,
unknown or empty evidence is rejected. This is an identity/coverage check;
Reviewer must still assess whether the evidence proves the stated requirement.
Do not describe manual or visual checks as automatic evidence.

## Review supplements

Original RED, its manifest, test files and resources remain immutable. A newly
approved contract may explicitly include:

```json
"supplementalTests": {
  "mode": "baselinePassingNewFiles",
  "maxRevisions": 1
}
```

Place this object inside `verification`. It authorizes one additional batch of
new Java/Kotlin/Groovy test source files within the existing allowed paths and
filters. GREEN runs the additions in an isolated checkout of the original
baseline, requires new passing case identities and unchanged baseline outcomes,
then seals `test-supplement.json`. Current GREEN must include all original and
supplemental cases. Acceptance/status expose the supplement and its digest.

Changing/removing original tests, adding resources, widening filters, changing
requirements, or adding tests that need the new implementation requires a
revised approved task. Failed or interrupted supplement attempts consume the
single revision budget; retained logs must be inspected. This policy does not
authorize new task protocols for a failing initial baseline, compile-error RED,
or tasks with no behavior-change RED. Such tasks are rejected at contract or
baseline validation; do not manufacture a failing assertion to satisfy the gate.

## Isolation and matrix boundaries

The full discovered unit-test/build matrix remains mandatory, including all
editable consumers and variants. A missing signing key, private dependency or
channel input is an environment/configuration failure, not permission to omit
that variant. Narrower matrices require a separate scope/dependency design.

An isolated task now refuses non-SDK entries in `local.properties` before Coder
starts. The error does not disclose property values. Declare required inputs in
reviewed tracked configuration, or explicitly approve a fixed-branch task;
ignored files and credentials are not automatically copied. Unknown dependencies
on other ignored files still require target-project validation. Supplemental
baseline worktrees only transfer the SDK property and enforce the same boundary.
