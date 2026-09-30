<!-- opencode-android-orchestrator:begin -->
## OpenCode Android Orchestrator

Run orchestration commands from the Git repository root.

For automated local unit-test verification, use the task paths in
`automation/config.json` under `gradleVerification.fullUnitTestTasks`.
For manual runs, execute `./gradlew` followed by those configured tasks from
`androidProject.capabilities.buildRoot` relative to the Git root (default `.`).
Use a standalone command without environment assignments or shell chaining.
For nested builds, unattended agents must use the managed verification scripts
from the Git root; direct Gradle commands are rejected by the executor guard.
Task execution uses the controlled verification scripts, which read the same
configuration. Empty lint/device task lists mean the capability is unavailable;
they never count as a passed check when that capability is required.

Treat `.opencode/`, `automation/`, `scripts/automation/`, `opencode.json`,
and this managed block as orchestration infrastructure. Product tasks must not
modify them unless an explicitly approved task is scoped to maintaining the
orchestrator itself.

`.automation-worktree-allowlist` is a human-maintained control file. Agents
must not create or edit it. Its exact repository-relative file entries are
excluded from orchestration changes for the next approved task.

Only a fresh OpenCode single-choice `question` selection can grant an
orchestration approval. Approval-like text in ordinary chat is not approval.
The orchestrator must not push Git changes or register scheduler/launchd jobs.

Planner reads a fixed committed planningHead through the snapshot tool and
seals contracts/plans in the independent inbox. Contract approval only enqueues
and returns; the detached repository service runs one executor at a time.
Task drafts inherit workspace and commit policies from automation/config.json
unless their reviewed contract explicitly overrides them. New installations use
inPlaceExclusive and humanApproval. autoCommit is supported only in fixed
workspaces and preserves build, fresh full unit-test execution and independent
Review. Final acceptance, retries and integration share the same queue. No
policy authorizes remote push.
<!-- opencode-android-orchestrator:end -->
