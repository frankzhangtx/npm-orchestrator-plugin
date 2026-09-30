import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, enqueue, taskContract, command, run } from "./queue-fixture.mjs";

function removeOptionalCapabilities(f) {
  f.config.gradleVerification.lintTasks = [];
  f.config.gradleVerification.deviceTestTasks = [];
  writeFileSync(join(f.root, "automation/config.json"), JSON.stringify(f.config, null, 2) + "\n");
  command(f.root, ["add", "automation/config.json"]);
  command(f.root, ["commit", "-qm", "Record unavailable optional verification capabilities"]);
}

test("queue completes all required gates with absent optional lint and device tasks", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    removeOptionalCapabilities(f);
    enqueue(f, "TASK-CAPABILITIES", { commitPolicy: "autoCommit" });
    const result = await run(f);
    assert.equal(result.item.state, "COMPLETED", result.output);
    const calls = readFileSync(join(f.base, "gradle-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert(calls.some(call => call.args.includes("assembleDebug")));
    assert(calls.every(call => !call.args.some(arg => /lint|connected/.test(arg))));
  } finally { f.cleanup(); }
});

for (const inventoryMode of [false, true]) {
  test(`required device capability is rejected before approval, V4=${inventoryMode}`, () => {
    const f = fixture({ inventoryMode });
    try {
      removeOptionalCapabilities(f);
      const contract = { ...taskContract(f, "TASK-DEVICE"), deviceTestsRequired: true };
      assert.throws(() => f.queue.draft({ contract, plan: "# Approved device validation plan\n", ...f.queue.snapshot() }),
        /Device tests are required.*no device test tasks/);
      assert.equal(f.queue.storage.read().items.length, 0);
    } finally { f.cleanup(); }
  });
}
