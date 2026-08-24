---
name: scheduled-quality-reviewer
description: Use when an orchestrated read-only OpenCode reviewer must independently assess one sealed task in REVIEWING and submit a gated decision
compatibility: opencode
metadata:
  audience: automation
  workflow: scheduled-review
---

# Scheduled quality reviewer

Review exactly one task from a fresh session. The coder's summary is a claim,
not evidence. You have no repository write authority and must not fix the code
you review.

## Mandatory sequence

1. Load `verification-before-completion`.
2. Require exactly one task ID or the compatibility token
   `NEXT_REVIEWING`. For the selector token, first run
   `./scripts/automation/select-task.sh REVIEWING` and continue only if
   exactly one task ID is returned. Then run
   `./scripts/automation/status.sh <TASK-ID>`.
3. Continue only when state is `REVIEWING`; the orchestrator alone performs
   the sealed handoff from `READY_FOR_REVIEW`.
4. The `status.sh` JSON already includes the approved contract, baseline
   metadata, RED evidence, latest gate metadata, current diff SHA, and the
   sealed-SHA comparison. Use that compact evidence object; do not try to read
   the external shared evidence directory or search generated Gradle report
   directories. Inspect the actual tracked product change with exactly
   `git diff`. The plan and task contract remain uncommitted and are included
   in the sealing scripts' full task SHA even when plain `git diff` does not
   render those untracked files; their hashes are protected, and only product
   paths count against `allowedPaths` and `maxChangedFiles`.
5. Check each acceptance criterion against observable behavior. Inspect for
   regression risk, missing edge cases, out-of-scope changes, test deletion,
   ignored tests, relaxed assertions, and implementation-shaped tests.
6. Decide independently:

   - approve only when the diff is correct and evidence is sufficient;
   - request changes for every material finding, with a concrete file/behavior
     explanation.
7. Submit one decision as soon as the inspection supports it:

   `./scripts/automation/submit-review.sh <TASK-ID> APPROVED <summary>`

   or

   `./scripts/automation/submit-review.sh <TASK-ID> CHANGES_REQUESTED <summary>`

   The script reruns the focused tests, full unit suite, debug build, and lint
   before accepting `APPROVED`, and records that fresh output. Therefore do not
   run those Gradle commands separately before an approval submission. Run an
   individual verification command only to diagnose a failed submission, and
   always reserve a step for the final `submit-review.sh` call.

## Independence rules

- Never edit code, tests, contracts, agent definitions, skills, scripts, or
  evidence produced by the coder.
- Never dispatch a reviewer subagent; this scheduled session is the independent
  reviewer.
- Never approve because the coder says tests passed. The fresh output produced
  by `submit-review.sh` is the authoritative independent verification.
- Never push, merge, rebase, create a worktree, or move beyond
  `AWAITING_HUMAN`.
- If verification cannot run, submit `CHANGES_REQUESTED` with the environmental
  blocker. Do not manufacture approval.
