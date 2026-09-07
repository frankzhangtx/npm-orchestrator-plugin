---
name: android-orchestrator-brainstorming
description: Refine one Android Orchestrator coding request into a bounded observable behavior proposal before plan and contract creation
license: MIT
compatibility: opencode
metadata:
  upstream: obra/superpowers@v6.2.0
  workflow: scheduled-coding
---

# Android Orchestrator brainstorming

Turn a rough request into one small, testable behavior change. This is an
interactive planning aid; it never edits product code, creates planning files,
starts execution, or grants approval.

## Workflow

1. Inspect the relevant repository code, tests, and project instructions.
2. Summarize current observable behavior and the requested behavior.
3. Identify ambiguity in scope, acceptance behavior, edge cases, or test
   strategy. Ask one focused question at a time only when the answer changes
   the proposal.
4. Consider two or three approaches when a meaningful tradeoff exists. Lead
   with the recommended approach and explain the material tradeoff.
5. Converge on exactly one bounded behavior change with:
   - observable acceptance criteria;
   - important edge cases;
   - exact allowed implementation and test paths;
   - maximum changed-file count;
   - focused test filter and device-test policy;
   - protected paths and explicit non-goals.
6. Hand the proposal back to `scheduled-quality-orchestrator` for its formal
   `方案确认` boundary.

## Boundaries

- Never treat discussion or agreement in prose as approval.
- Never broaden a request merely to make the implementation cleaner.
- Never propose dependency, build-system, automation-rule, push, merge, or
  worktree changes unless the user explicitly put them in scope.
- Use text-only interaction. This bundled skill contains no localhost server,
  browser launcher, remote image, or telemetry path.
