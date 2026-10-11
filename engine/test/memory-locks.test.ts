// Process locks (design 4.1 §4.1): `locks/<name>.lock`, an SQLite database held
// in an exclusive transaction for the life of its holder; the operating system
// frees it when the holder exits, however it exits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { lock, tryLock } from '../src/memory/index.ts';
import { child, tempDir, throwsCode } from './memory-fixtures.ts';

test('tryLock and lock in one process: one holder at a time; release frees it', () => {
  const dir = tempDir('mp-locks-');
  try {
    const locks = join(dir, 'locks');
    const a = tryLock(locks, 'landing');
    assert.ok(a !== null && a.held);
    assert.equal(tryLock(locks, 'landing'), null, 'a second holder is refused');
    const other = tryLock(locks, 'maintenance');
    assert.ok(other !== null, 'locks are independent');
    const t0 = Date.now();
    throwsCode(() => lock(locks, 'landing', { waitMs: 200 }), 'LOCKED', /held by another mp process/);
    assert.ok(Date.now() - t0 >= 150, 'it waited');
    a.release();
    a.release();
    const b = lock(locks, 'landing', { waitMs: 200 });
    assert.ok(b.held);
    b.release();
    other.release();
    throwsCode(() => tryLock(locks, 'Bad Name'), 'BAD_REQUEST');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by another process; the kernel frees it when that process is killed', async () => {
  const dir = tempDir('mp-locks-proc-');
  try {
    const locks = join(dir, 'locks');
    const holder = child({ action: 'hold-lock', locks, name: 'landing' });
    assert.equal(await holder.line, 'ready');
    assert.equal(tryLock(locks, 'landing'), null);
    const probe = child({ action: 'try-lock', locks, name: 'landing' });
    assert.equal(await probe.line, 'held-elsewhere');
    holder.proc.kill('SIGKILL');
    await holder.exit;
    const l = lock(locks, 'landing', { waitMs: 2000 });
    assert.ok(l.held, 'free once its holder was killed');
    const probe2 = child({ action: 'try-lock', locks, name: 'landing' });
    assert.equal(await probe2.line, 'held-elsewhere');
    l.release();
    const probe3 = child({ action: 'try-lock', locks, name: 'landing' });
    assert.equal(await probe3.line, 'taken');
    // A caller waiting on the lock gets it when its holder dies meanwhile.
    const dying = child({ action: 'hold-lock', locks, name: 'landing', dieAfterMs: 300 });
    assert.equal(await dying.line, 'ready');
    const t0 = Date.now();
    const w = lock(locks, 'landing', { waitMs: 5000 });
    assert.ok(Date.now() - t0 >= 100, 'it waited for the holder');
    w.release();
    await dying.exit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
