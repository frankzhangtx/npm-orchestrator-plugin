---
name: scheduled-quality-coder
description: Use when an orchestrated OpenCode coder must execute or repair exactly one human-approved Android task under state, scope, TDD, and quality gates
compatibility: opencode
metadata:
  audience: automation
  workflow: scheduled-coding
---

# Scheduled quality coder

Execute one task contract. This skill narrows Superpowers into a deterministic,
non-interactive Android workflow. The scripts are the source of truth for state;
your prose is never proof of completion.

## Required input

The prompt must contain either one task ID matching `TASK-[A-Z0-9-]+` or the
compatibility selector token `NEXT_PENDING`. For `NEXT_PENDING`, first run
`./scripts/automation/select-task.sh PENDING`; continue only if it returns one
task ID. Zero or multiple matches are a clean stop, not permission to choose.
The resolved contract must exist at `automation/tasks/<TASK-ID>.json` and must
have `designApproved: true`.

If neither accepted input form is present, stop without editing.
When a blocker is discovered after the task has been queued or claimed, record
it with `./scripts/automation/block-task.sh <TASK-ID> <reason>` before stopping.

## Mandatory sequence

1. Load `test-driven-development` and
   `verification-before-completion`. Do not load any other implementation
   workflow skill.
2. Run `./scripts/automation/status.sh <TASK-ID>` and read the contract.
3. Branch by deterministic state:

   - For `PENDING`, run `./scripts/automation/claim-task.sh <TASK-ID>`. It
     performs preflight, verifies that the only orchestration-visible initial
     changes are the two sealed, uncommitted planning artifacts, captures the
     green baseline, and changes the task to `CODING`. The status JSON's
     `runtime.effectiveWorktreeAllowlist` contains human-owned local paths that
     are outside the task; do not edit, stage, report, or reason from those
     paths or from `.automation-worktree-allowlist`. Never edit, stage, or
     remove the planning artifacts; the integrator will include them in the
     final combined commit.
   - For `CODING` with reviewer feedback, read `review.json` and implement only
     the requested in-contract repair. Do not claim again and do not replace
     the original RED evidence.
   - For `CODING` after an interrupted initial run, inspect existing evidence
     and continue from the first incomplete mandatory action.

4. On the initial coding cycle, add or change the smallest behavior test
   permitted by `allowedPaths`.
5. If RED evidence does not already exist, capture a genuine RED result with:

   `./scripts/automation/record-red.sh <TASK-ID> <expected-failure-text> -- <test-filter>`

   The final argument after `--` is a Gradle `--tests` filter, not an arbitrary
   command. Confirm the test failed for the missing behavior, not a typo or
   environment error.
6. Implement the minimum product change needed to make that test pass. Stay
   inside the contract's path and file-count limits. Do not refactor unrelated
   code.
7. Run `./scripts/automation/quality-gate.sh <TASK-ID>`.
8. If the first gate attempt in the current coding cycle fails while state
   remains `CODING`, load
   `systematic-debugging`, diagnose the root cause, and make at most one fix
   loop. Then run the gate once more. If it fails again, stop in
   `TEST_FAILED`.
9. When the gate succeeds, report the changed files and evidence paths. Do not
   write `READY_FOR_REVIEW`; only the gate script may do that.

## Stop conditions

Stop immediately when any of these occur:

- requirement ambiguity or conflict;
- any orchestration-visible initial task-root change beyond the two sealed
  planning artifacts;
- missing plugin, skill, tool, device, or dependency;
- a requested edit outside `allowedPaths` or inside protected paths;
- no meaningful failing test can be written;
- more than one fix loop would be needed;
- a test must be deleted, ignored, weakened, or changed merely to accept the
  implementation;
- the contract asks for push, merge, rebase, worktree creation, dependency
  upgrades, or automation-rule changes.

Do not ask a question during an orchestrated run. State the blocker and stop so a
human can revise and requeue the contract.

## Forbidden capabilities

Do not invoke `brainstorming`, `writing-plans`, `using-git-worktrees`,
`finishing-a-development-branch`, `requesting-code-review`, parallel agents, or
subagent-driven development. Planning and approval happen before this session;
review happens in a separate fresh read-only session.
