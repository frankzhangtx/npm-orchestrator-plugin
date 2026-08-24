# Human-approved automation plans

Every orchestrated coding contract must reference one plan in this directory.
Planning is interactive and happens before a task is approved for execution; unattended agents
must not create, broaden, or reinterpret these plans.

The normal entry point is a natural-language task description entered in an
interactive `scheduled-planner` OpenCode session. The planner must inspect the
repository, present the proposed scope and acceptance criteria, and receive
explicit human approval before it creates this plan and the matching JSON
contract.

A plan should contain:

- one observable behavior change;
- acceptance criteria and edge cases;
- allowed and forbidden repository paths;
- the focused test class/filter that will provide RED evidence;
- explicit non-goals;
- device/emulator requirements, if any;
- a dated human approval statement.

After proposal approval, Planner seals both artifacts in `CONTRACT_REVIEW`.
The matching contract belongs in `automation/tasks/TASK-<ID>.json`. A missing
plan, placeholder text, or mismatched task ID causes contract validation to
fail.
