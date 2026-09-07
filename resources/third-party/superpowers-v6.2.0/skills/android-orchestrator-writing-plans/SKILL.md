---
name: android-orchestrator-writing-plans
description: Convert an approved Android Orchestrator proposal into an implementation-ready plan that matches its sealed task contract
license: MIT
compatibility: opencode
metadata:
  upstream: obra/superpowers@v6.2.0
  workflow: scheduled-coding
---

# Android Orchestrator writing plans

Write a plan detailed enough for the restricted Coder to implement without
guessing. The approved proposal is the scope ceiling.

## Required output

Create only the plan path selected by `scheduled-quality-orchestrator`:
`docs/plans/<TASK-ID>.md`. The matching JSON contract is created separately at
`automation/tasks/<TASK-ID>.json`; both artifacts must describe the same task.

The plan must include:

- task ID and title;
- current and desired observable behavior;
- acceptance criteria and edge cases;
- exact files to create or modify;
- implementation sequence with concrete symbols and interfaces;
- the first failing behavior test and expected RED reason;
- focused and full verification commands;
- allowed paths, forbidden paths, maximum changed-file count, and non-goals;
- device/emulator policy and any residual risk.

## Plan quality

- Use small ordered steps: test, verify RED, minimal implementation, verify
  GREEN, then the configured quality gate.
- Derive expected values independently from production code.
- Do not use placeholders such as TODO, TBD, “add suitable handling”, or
  “similar to the previous step”.
- Keep names, signatures, resources, and paths consistent across every step
  and with the task contract.
- Do not introduce unapproved refactors or dependencies.

## Handoff

Do not offer alternate execution modes, dispatch subagents, commit, or start
implementation. Return control to `scheduled-quality-orchestrator`, which
validates and seals the plan and contract before the separate Coder and
Reviewer sessions can run.
