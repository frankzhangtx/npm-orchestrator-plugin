# Installation templates

The project-local OpenCode agents, commands, and skills in `.opencode/` are
byte-for-byte copies of the verified Android orchestration V3 baseline at
source commit `829693652e3737ad94c7cc75214b09fb2b58715b`.

Migrated template roots:

- `.opencode/agents`: `scheduled-planner`, `scheduled-coder`, and
  `scheduled-reviewer`
- `.opencode/commands`: `change`, `acceptance`, `resume-review`, and
  `abort-task`
- `.opencode/skills`: the three `scheduled-quality-*` skills
- `scripts/automation`: all 28 deterministic V3 Bash transactions and their
  test runner, preserved as executable files
- `automation`: the V3 configuration, both JSON Schemas, and the task contract
  example
- `docs/plans/README.md`: the human-approved plan authoring contract
- `AGENTS.md.fragment`: a bounded managed block for later non-destructive
  merging into an existing project `AGENTS.md`

Still planned:

- adapt the baseline configuration, schema identifiers, module paths, and test
  filters to the detected Android project
- remove the legacy Scheduler field while keeping Superpowers pinned
- implement conflict-safe merging of the managed AGENTS block

Historical tasks, runtime evidence, backups, and Android product code are not
included.

`tests/template-migration.test.mjs` locks the migrated inventory, source
SHA-256 values, file modes, and portability constraints.

`tests/shell-template-migration.test.mjs` additionally locks the Shell file
inventory, source SHA-256 values, `0755` modes, Bash syntax, and no-push/no-
publish/no-launchd constraints. The scripts remain byte-identical in this
stage, so `preflight.sh` still contains the original local Android SDK example
and the test runner still uses its `cctest` fixture namespace. Both are tracked
for parameterization in the configuration step that immediately follows this
migration; `init` and release remain blocked until that work is complete.

`tests/resource-template-migration.test.mjs` locks the five byte-identical V3
infrastructure resources, validates their structural alignment, and verifies
that the AGENTS fragment has exactly one portable managed block. The baseline
configuration still declares Scheduler, and the Schema identifiers and task
example still contain `cctest`; these are explicit adaptation blockers rather
than release-ready defaults.
