cat >> tests/scaffold.test.mjs <<'EOF'

test("RED capture receives the configured timeout even when the model requests twenty minutes", async () => {
  const hooks = await plugin({ directory: process.cwd(), worktree: process.cwd(), $: () => { throw new Error("unexpected shell"); } });
  const args = { command: "./scripts/automation/record-red.sh TASK-IMGCACHE-001", timeout: 1_200_000 };
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "red-session", callID: "red-call" }, { args });
  assert.equal(args.timeout, DEFAULT_LONG_COMMAND_TIMEOUT_MS);
});
EOF
cat >> tests/test-inventory.test.mjs <<'EOF'

test("RED diagnostics identify both exception-type and assertion-origin mismatches before spending another preparation attempt", () => {
  const value = contract();
  value.verification.cases[0].expectedFailure.origin = { className: "example.FeatureTest", methodName: "approved" };
  const sample = structuredClone(red);
  const raised = sample.cases[1].failures[0];
  raised.type = "org.gradle.internal.serialize.PlaceholderAssertionError";
  raised.stack.unshift("example.FeatureTest.assertFormattedPhoneNumber(FeatureTest.kt:10)");
  const inspect = () => {
    try { evaluateCoverage(value, baseline, sample, "red"); assert.fail("invalid RED must stay rejected"); }
    catch (error) { assert.equal(error.code, "CASE_EXPECTATION_MISMATCH"); return error.issues[0]; }
  };
  assert.deepEqual(inspect().failureChecks, { singleFailure: true, type: false, message: true, origin: false });
  raised.type = "java.lang.AssertionError";
  assert.deepEqual(inspect().failureChecks, { singleFailure: true, type: true, message: true, origin: false });
  raised.stack.shift();
  assert.equal(evaluateCoverage(value, baseline, sample, "red").summary.expectedRed, 1);
});
EOF
