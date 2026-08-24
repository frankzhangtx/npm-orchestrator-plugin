# OpenCode Android Orchestrator

Reusable OpenCode orchestration for macOS Android projects.

## Status

Version `0.1.0` was published as an early scaffold and does not provide a
working installer. Development now targets `0.2.0`; it must not be published
until the installer lifecycle and release gates are complete.

The cross-version plugin entry, OpenCode version doctor, Android/Gradle project
discovery, audited V3 resources, and all deterministic V3 Shell transactions
are implemented. Read-only planning now renders project-relative automation
configuration and a focused task example from the detected Android modules.
Safe, comment-preserving OpenCode JSON/JSONC merge planning is also implemented.
The write-capable installer lifecycle has not been implemented yet.

Implemented checks include:

- OpenCode `1.14.22` and `1.15.13` certification, with guarded support for
  versions in the declared `>=1.14.22 <1.16.0` range
- Git root and Gradle settings discovery from the project root or a module
  directory
- project name, Kotlin/Groovy DSL, Android namespace/application ID,
  multi-module, custom `projectDir`, version-catalog plugin aliases, and Gradle
  Wrapper detection
- a plugin compatibility boundary restricted to API fields and hooks shared
  by both certified OpenCode versions
- project-independent templates for the three V3 agents, four commands, and
  three scheduled-quality skills
- all 28 automation Bash files with their `0755` modes; scope and test-change
  gates consume detected source-set paths instead of a fixed module name
- a portable automation configuration source, both Schemas, contract example,
  plan guide, and bounded AGENTS managed block
- adaptive configuration for every detected Android module, an unambiguous or
  explicitly selected primary module, exact protected build files, production
  and test source sets, and a namespace-aware focused-test placeholder
- removal of the legacy Scheduler dependency and all local absolute paths from
  shipped templates
- read-only `opencode.json`/`opencode.jsonc` merge planning that preserves
  existing fields, comments, plugin order, and plugin options while adding
  fixed Superpowers and orchestrator references
- conflict guards for malformed or ambiguous configuration, duplicate plugin
  packages, different managed-plugin references, and symbolic links

Both planners deliberately avoid filesystem writes. The adaptive planner also
blocks ambiguous primary modules, paths outside the Git root, and nested Gradle
roots that the current root-relative transaction scripts cannot safely run.
Backup, manifest, conflict-safe file installation, and rollback support are
added in the following installer stages before `init` can apply either plan.

## Adaptive template planning

```js
import {
  planAdaptiveProjectTemplates,
} from "@frankzhang2026/opencode-android-orchestrator";

const plan = planAdaptiveProjectTemplates("/path/to/android-project", {
  primaryModule: ":mobile", // optional when exactly one application is found
});

console.log(plan.automationConfigContent);
console.log(plan.taskContractExampleContent);
```

The returned JSON contains repository-relative paths only. This API plans
content in memory; it does not create or modify target-project files.

## Planned usage

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.2.0 init .
opencode --agent scheduled-planner .
```

Version `0.2.0` has not been published. `init` remains intentionally unavailable
until the safe installation lifecycle is complete.

## Doctor

```sh
opencode-android-orchestrator doctor /path/to/android-project
opencode-android-orchestrator doctor /path/to/android-project --json
```

The command exits unsuccessfully when OpenCode is missing or incompatible,
the target is not a Git Android project, or the Gradle Wrapper is incomplete.

## Development

```sh
npm run typecheck
npm test
npm run pack:check
```
