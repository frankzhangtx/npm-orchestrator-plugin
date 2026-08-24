# OpenCode Android Orchestrator

Reusable OpenCode orchestration for macOS Android projects.

## Status

Version `0.1.0` was published as an early scaffold and does not provide a
working installer. Development now targets `0.2.0`; it must not be published
until the installer lifecycle and release gates are complete.

The cross-version plugin entry, OpenCode version doctor, Android/Gradle project
discovery, audited V3 Agent/Command/Skill templates, and all deterministic V3
Shell transactions are implemented. The remaining V3 configuration, Schema,
task-example, plan-guide, and managed AGENTS-fragment resources are packaged as
audited templates. Safe, comment-preserving OpenCode JSON/JSONC configuration
merge planning is also implemented. The installer lifecycle and adaptive
automation configuration have not been implemented yet.

Implemented checks include:

- OpenCode `1.14.22` and `1.15.13` certification, with guarded support for
  versions in the declared `>=1.14.22 <1.16.0` range
- Git root and Gradle settings discovery from the project root or a module
  directory
- Kotlin DSL, Groovy DSL, multi-module, custom `projectDir`, version-catalog
  plugin aliases, and Gradle Wrapper detection
- a plugin compatibility boundary restricted to API fields and hooks shared
  by both certified OpenCode versions
- byte-preserved templates for the three V3 agents, four commands, and three
  scheduled-quality skills
- all 28 byte-preserved automation Bash files with their `0755` modes
- the byte-preserved V3 automation configuration, both Schemas, contract
  example, and plan guide, plus a bounded AGENTS managed block
- read-only `opencode.json`/`opencode.jsonc` merge planning that preserves
  existing fields, comments, plugin order, and plugin options while adding
  fixed Superpowers and orchestrator references
- conflict guards for malformed or ambiguous configuration, duplicate plugin
  packages, different managed-plugin references, and symbolic links

The merge planner deliberately does not write configuration yet. Backup,
manifest, conflict-safe file installation, and rollback support are added in
the following installer stages before `init` can use the plan.

## Planned usage

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.2.0 init .
opencode --agent scheduled-planner .
```

Version `0.2.0` has not been published. `init` remains intentionally unavailable
until template migration and safe installation lifecycle work are complete.

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
