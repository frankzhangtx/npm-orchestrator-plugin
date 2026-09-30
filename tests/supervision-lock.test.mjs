import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import test, { mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { initialSupervision, recoverOwnedTransaction } from '../dist/queue/supervision.js';
import { fileLock, recoverLock } from '../dist/queue/storage.js';
import { fixture } from './queue-fixture.mjs';

const policy = { version: 1, maxRunMs: 180000, maxStageMs: 30000, terminationGraceMs: 1000 };

test('a crash before or after lock publication never leaves an anonymous owner', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    for (const published of [false, true]) {
      const code = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { fileLock } from ${JSON.stringify(new URL('../dist/queue/storage.js', import.meta.url).href)};
        const link = fs.linkSync;
        fs.linkSync = (...args) => {
          if (${published}) link(...args);
          fs.writeSync(1, 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        };
        syncBuiltinESMExports();
        fileLock(${JSON.stringify(f.queue.storage.lockPath)});
      `;
      const child = childProcess.spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      const ended = once(child, 'exit');
      try {
        await once(child.stdout, 'data');
        assert.equal(existsSync(f.queue.storage.lockPath), published);
        if (published) {
          const owner = JSON.parse(readFileSync(f.queue.storage.lockPath));
          assert.equal(owner.pid, child.pid);
          assert.equal(typeof owner.started, 'string');
          assert.equal(typeof owner.token, 'string');
          assert.throws(() => fileLock(f.queue.storage.lockPath, 0), /occupied/);
        }
      } finally { child.kill('SIGKILL'); await ended; }
      if (published) assert.equal(recoverLock(f.queue.storage.lockPath), true);
      fileLock(f.queue.storage.lockPath)();
      assert.equal(existsSync(f.queue.storage.lockPath), false);
    }
  } finally { f.cleanup(); }
});

test('supervision leaves an owner record being written intact without stealing its lock', () => {
  const f = fixture();
  try {
    const release = fileLock(f.queue.storage.lockPath);
    const ownerBytes = readFileSync(f.queue.storage.lockPath);
    try {
      for (const incomplete of ['', '{"pid":']) {
        writeFileSync(f.queue.storage.lockPath, incomplete);
        recoverOwnedTransaction(f.queue, initialSupervision(policy, Date.now()), null);
        assert.equal(readFileSync(f.queue.storage.lockPath, 'utf8'), incomplete);
        assert.throws(() => fileLock(f.queue.storage.lockPath, 0), /occupied/);
      }
    } finally { writeFileSync(f.queue.storage.lockPath, ownerBytes); release(); }
    assert.equal(existsSync(f.queue.storage.lockPath), false);
  } finally { f.cleanup(); }
});

test('a lock released or replaced during the process probe is neither rejected nor recovered', () => {
  const f = fixture();
  const originalSpawn = childProcess.spawnSync;
  try {
    fileLock(f.queue.storage.lockPath)();
    const dead = { pid: 2147483647, started: 'exited transaction', token: 'old-lock' };
    const replacement = { ...dead, token: 'new-lock' };
    for (const action of ['release', 'replace']) {
      writeFileSync(f.queue.storage.lockPath, JSON.stringify(dead));
      const mocked = mock.method(childProcess, 'spawnSync', (command, args, options) => {
        if (command === 'ps' && args[0] === '-p' && args[1] === String(dead.pid)) {
          if (action === 'release') unlinkSync(f.queue.storage.lockPath);
          else writeFileSync(f.queue.storage.lockPath, JSON.stringify(replacement));
          return { status: 1, stdout: '', stderr: '' };
        }
        return originalSpawn(command, args, options);
      });
      syncBuiltinESMExports();
      try { recoverOwnedTransaction(f.queue, initialSupervision(policy, Date.now()), null); }
      finally { mocked.mock.restore(); syncBuiltinESMExports(); }
      if (action === 'release') assert.equal(existsSync(f.queue.storage.lockPath), false);
      else assert.deepEqual(JSON.parse(readFileSync(f.queue.storage.lockPath)), replacement);
    }
    assert.equal(recoverLock(f.queue.storage.lockPath, dead), false);
    assert.deepEqual(JSON.parse(readFileSync(f.queue.storage.lockPath)), replacement);
  } finally { f.cleanup(); }
});

test('supervision retains live and unowned dead locks and only recovers an owned dead lock', () => {
  const f = fixture();
  try {
    const record = initialSupervision(policy, Date.now());
    const release = fileLock(f.queue.storage.lockPath);
    try {
      const before = readFileSync(f.queue.storage.lockPath);
      recoverOwnedTransaction(f.queue, record, null);
      assert.deepEqual(readFileSync(f.queue.storage.lockPath), before);
    } finally { release(); }
    const dead = { pid: 2147483647, started: 'not a running process', token: 'test-lock' };
    writeFileSync(f.queue.storage.lockPath, JSON.stringify(dead));
    assert.throws(() => recoverOwnedTransaction(f.queue, record, null), /does not belong/);
    assert.equal(existsSync(f.queue.storage.lockPath), true);
    recoverOwnedTransaction(f.queue, record, dead);
    assert.equal(existsSync(f.queue.storage.lockPath), false);
  } finally { f.cleanup(); }
});
