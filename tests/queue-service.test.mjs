import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isAlive, processIdentity, processGroupAlive, fileLock, recoverLock } from "../dist/queue/storage.js";
import { serviceStatus, wakeService } from "../dist/queue/service.js";
import { fixture, enqueue } from "./queue-fixture.mjs";

const cli = fileURLToPath(new URL('../dist/queue/cli.js', import.meta.url));
async function until(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
function launch(f) {
  const child = spawn(process.execPath, [cli, '_serve', f.root], { env: f.env, detached: true, stdio: 'ignore' });
  const ended = new Promise(done => child.once('exit', done));
  return { child, ended };
}

test("concurrent daemons and repeated wakeups share one executor; restarting scheduler keeps its live worker", { timeout: 120000 }, async () => {
  const f = fixture();
  const services = [];
  try {
    enqueue(f, "TASK-A");
    services.push(launch(f), launch(f));
    await until(() => Boolean(f.queue.storage.read().active?.worker), 'worker start');
    const first = f.queue.storage.read().active;
    assert.ok(first.worker);
    enqueue(f, "TASK-B");
    for (let count = 0; count < 8; count++) wakeService(f.queue);
    assert.equal(f.queue.storage.read().active.id, first.id);
    assert.throws(() => f.queue.recoverExecution(), /still alive/);
    const scheduler = serviceStatus(f.queue);
    process.kill(scheduler.owner.pid, 'SIGTERM');
    await until(() => !serviceStatus(f.queue).running, 'scheduler stop');
    assert.equal(isAlive(first.worker), true, 'detached execution survives scheduler termination');
    services.push(launch(f));
    await until(() => f.queue.item('TASK-A').state === 'AWAITING_HUMAN' && !f.queue.storage.read().active, 'durable human waiting state');
    assert.equal(f.queue.item('TASK-B').state, 'QUEUED');
    assert.equal(f.queue.storage.read().runs.length, 1);
    const calls = readFileSync(join(f.base, 'agent-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(call => call.role), ['scheduled-coder', 'scheduled-reviewer']);
    assert.ok(f.queue.storage.read().notifications.some(notification => notification.state === 'AWAITING_HUMAN'));
  } finally {
    for (const { child, ended } of services) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await ended;
    }
    const active = f.queue.storage.read().active;
    if (active?.worker && processGroupAlive(active.worker.pid)) {
      process.kill(-active.worker.pid, 'SIGKILL');
      await until(() => !processGroupAlive(active.worker.pid), 'fixture process cleanup');
    }
    f.cleanup();
  }
});

test("dead transaction owners need explicit recovery and live owners are never stolen", async () => {
  const f = fixture();
  try {
    const lock = join(f.queue.storage.runtime, 'locks/crash.lock');
    const release = fileLock(lock);
    assert.throws(() => recoverLock(lock), /still alive/);
    release();
    const storage = fileURLToPath(new URL('../dist/queue/storage.js', import.meta.url));
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {fileLock} from ${JSON.stringify(storage)}; fileLock(${JSON.stringify(lock)});`]);
    await new Promise((done, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error('lock fixture failed'))); });
    assert.equal(existsSync(lock), true);
    assert.equal(recoverLock(lock), true);
    const releaseNew = fileLock(lock);
    releaseNew();
  } finally { f.cleanup(); }
});
