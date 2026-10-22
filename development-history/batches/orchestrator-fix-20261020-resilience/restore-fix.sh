python3 - <<'PY'
from pathlib import Path
p=Path('src/config/long-command-timeout.ts');s=p.read_text().replace('  "quality-gate.sh",','  "quality-gate.sh",\n  "record-red.sh",');p.write_text(s)
p=Path('templates/automation/verification/inventory.cjs');s=p.read_text().replace('    let valid;','    let valid, failureChecks = null;')
a='''      const matched = result.result === "FAILURE" && failure && result.failures.length === 1 &&
        result.failures[0].type === failure.type && (!failure.messageIncludes || result.failures[0].message.includes(failure.messageIncludes)) &&
        matchesFailureOrigin(failure, result.failures[0], item);'''
b='''      if (result.result === "FAILURE" && failure) {
        const single = result.failures.length === 1;
        // Evaluate every constraint independently: fixing the exception type must
        // not consume a second attempt just to discover an already-wrong origin.
        failureChecks = {
          singleFailure: single,
          type: single && result.failures[0].type === failure.type,
          message: single && (!failure.messageIncludes || result.failures[0].message.includes(failure.messageIncludes)),
          origin: single && matchesFailureOrigin(failure, result.failures[0], item),
        };
      }
      const matched = failureChecks && Object.values(failureChecks).every(Boolean);'''
assert a in s;s=s.replace(a,b).replace('      expectedFailure: item.expectedFailure ?? null, actualFailureTypes:', '      failureChecks, expectedFailure: item.expectedFailure ?? null, actualFailureTypes:')
s=s.replace('Inspect each listed case; fix test preparation only within the approved requirements, otherwise revise the contract.', 'Inspect all failureChecks (singleFailure, type, message, origin) together before retrying. Match the declared exception and assertion location; fix test preparation only within the approved requirements, otherwise revise the contract.')
p.write_text(s)
p=Path('templates/.opencode/skills/scheduled-quality-coder/SKILL.md');s=p.read_text();needle='5. If RED evidence does not already exist'
pos=s.index(needle);s=s[:pos]+'''   Before the first RED run, compare every new assertion with the sealed
   `expectedFailure.type` and `expectedFailure.origin`. The first non-framework
   stack frame must match the declared origin, and the test body must appear in
   the stack. When the contract declares `java.lang.AssertionError` at the test
   method, throw that exact error inline at a failed behavior comparison; do not
   move the assertion into a helper or assume AssertJ/JUnit string assertions
   produce that exact exception. Preserve meaningful expected/actual comparisons.
   Read every `failureChecks` field together before using a preparation retry.
''' +s[pos:]
s+='''
## Interrupted verification commands

Use the configured long-command timeout for `record-red.sh` as for GREEN.
If a tool reports command timeout/interruption, inspect bounded status and the
phase ledger once. An existing phase lock or a `RUNNING` ledger without a durable
outcome requires ownership recovery; repeating the command cannot repair it.
Do not spend the remaining model steps rereading unchanged logs or trying denied
process commands. Preserve evidence and invoke the allowed `block-task.sh` with
the exact phase and interruption reason, then stop. Never delete a lock, edit a
ledger, reset a budget, or treat a timed-out compile as valid RED.
''';p.write_text(s)
p=Path('templates/.opencode/agents/scheduled-planner.md');s=p.read_text()+'''
When specifying RED evidence, align the planned assertion with both
`expectedFailure.type` and `expectedFailure.origin`. A generic
`java.lang.AssertionError` contract with the test method as origin requires an
inline assertion that throws that exact type. Existing AssertJ/JUnit string
assertions may use ComparisonFailure or a Gradle serialization wrapper; inspect
the implementation rather than assuming their exception type. Explain this
constraint in the plan before approval, without changing the requested behavior.
''';p.write_text(s)
p=Path('docs/TROUBLESHOOTING.md');s=p.read_text()+'''
## RED preparation mismatches and interrupted commands

`CASE_EXPECTATION_MISMATCH` includes per-case `failureChecks` for exception count,
exact type, message and origin. Inspect all four before using a preparation retry.
A helper assertion can fail origin matching even when its caller is the correct
test. AssertJ/JUnit string comparisons can throw ComparisonFailure (or appear as
Gradle's PlaceholderAssertionError), which is not an exact java.lang.AssertionError.
Keep the approved behavior and either align test preparation with the contract or
approve a revised contract; compilation failures never count as RED.

`record-red.sh` now receives the same configured long-command timeout floor as
GREEN and other managed commands. A larger value can be selected through the
supported upgrade `--long-command-timeout-ms` option; it does not extend approved
Worker deadlines. A timeout does not prove a stalled Gradle compiler.

If interruption leaves a stage lock and RUNNING ledger, stop after recording the
phase and cause. Do not repeatedly run RED, delete locks or reset counters. Queue
`recover-execution` only reconciles executor ownership; it is not a general repair
for an interrupted RED ledger. Preserve the candidate for explicit recovery or
approved abort/replanning. These changes prevent the missing timeout protection
and improve diagnosis; they do not add automatic adoption of interrupted ledgers.
''';p.write_text(s)
PY
