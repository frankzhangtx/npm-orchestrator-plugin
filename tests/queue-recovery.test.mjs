import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, enqueue, command, run } from "./queue-fixture.mjs";

for (const stage of ["INTENT", "COMMITTED", "VERIFIED", "INTEGRATED", "COMPLETED"]) {
  test(`crash at commit transaction ${stage} preserves ownership and recovers one local commit`, { timeout: 180000 }, async () => {
    const f = fixture();
    try {
      const baseline = command(f.root, ["rev-parse", "main"]);
      enqueue(f, "TASK-A", { commitPolicy: "autoCommit" });
      enqueue(f, "TASK-B");
      const preload = join(f.base, "interrupt.mjs");
      const marker = join(f.base, "interrupted");
      writeFileSync(preload, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst rename = fs.renameSync;\nfs.renameSync = (...args) => {\n rename(...args);\n if(String(args[1]).endsWith('/commit-transaction.json') && !fs.existsSync(${JSON.stringify(marker)})) {\n  const transaction=JSON.parse(fs.readFileSync(args[1]));\n  if(transaction.stage===${JSON.stringify(stage)}) {\n   fs.writeFileSync(${JSON.stringify(marker)},transaction.id);\n   process.kill(-process.pid,'SIGKILL');\n  }\n }\n};\nsyncBuiltinESMExports();\n`);
      f.env.NODE_OPTIONS = `--import=${preload}`;
      const interrupted = await run(f, { allowCrash: true });
      assert.equal(existsSync(marker), true, interrupted.output);
      assert.equal(interrupted.item.state, "BLOCKED");
      assert.equal(f.queue.reserve(), null, "fixed workspace must remain owned until recovery");
      delete f.env.NODE_OPTIONS;
      f.queue.request("TASK-A", "recover");
      const recovered = await run(f);
      assert.equal(recovered.item.state, "COMPLETED", recovered.output + recovered.item.waitingReason);
      assert.equal(command(f.root, ["rev-list", "--count", `${baseline}..main`]), "1");
      assert.equal(command(f.root, ["status", "--porcelain"]), "");
      const transaction = JSON.parse(readFileSync(join(f.queue.storage.runtime, "evidence/TASK-A/commit-transaction.json")));
      assert.equal(transaction.stage, "COMPLETED");
      assert.equal(transaction.pushed, false);
      assert.equal(transaction.id, readFileSync(marker, "utf8"));
      assert.equal(f.queue.reserve().key, "TASK-B@1");
    } finally { f.cleanup(); }
  });
}
