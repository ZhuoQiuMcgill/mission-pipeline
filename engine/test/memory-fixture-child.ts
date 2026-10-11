// A child process for the memory tests: another `mp` process holding the
// memory's write lock, a process lock, or crashing in the middle of a write or
// of the recovery after a move. Run with the test's TMPDIR; prints "ready"
// when it holds what it was asked to hold, and the answer of what it did.
//
//   node --experimental-strip-types test/memory-fixture-child.ts '<json>'

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRecords, commitStop, lock, openMemory, setMission, tryLock } from '../src/memory/index.ts';

type Action =
  | { readonly action: 'hold-write'; readonly project: string; readonly ms: number }
  | { readonly action: 'hold-lock'; readonly locks: string; readonly name: string; readonly dieAfterMs?: number }
  | { readonly action: 'try-lock'; readonly locks: string; readonly name: string }
  | { readonly action: 'open'; readonly project: string; readonly crashAfterStep?: number; readonly sleepAtStep?: { readonly step: number; readonly ms: number }; readonly machine?: string }
  | { readonly action: 'crash-in-write'; readonly project: string; readonly op: string; readonly document: string; readonly journal: string }
  | { readonly action: 'write-many'; readonly project: string; readonly prefix: string; readonly count: number }
  | { readonly action: 'hold-until'; readonly project: string; readonly files: readonly string[]; readonly ms: number }
  | { readonly action: 'writer'; readonly project: string; readonly role: 'normal' | 'stop'; readonly mark: string }
  | { readonly action: 'hold-both'; readonly project: string; readonly start: string; readonly stageMs: number; readonly read?: boolean }
  | { readonly action: 'write-until-marker'; readonly project: string; readonly held: string };

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(SLEEP, 0, 0, ms);
}

const a = JSON.parse(process.argv[2] ?? '{}') as Action;

switch (a.action) {
  case 'hold-write': {
    // Another mp process in the middle of a write: it holds the write lock.
    const db = new DatabaseSync(join(a.project, '.mission-pipeline', 'memory.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('ready\n');
    sleep(a.ms);
    db.exec('ROLLBACK');
    db.close();
    break;
  }
  case 'hold-lock': {
    lock(a.locks, a.name, { waitMs: 5000 });
    process.stdout.write('ready\n');
    setInterval(() => undefined, 60_000);
    // Dies without releasing anything: only the kernel frees the lock.
    if (a.dieAfterMs !== undefined) setTimeout(() => process.kill(process.pid, 'SIGKILL'), a.dieAfterMs);
    break;
  }
  case 'try-lock': {
    const l = tryLock(a.locks, a.name);
    process.stdout.write(`${l === null ? 'held-elsewhere' : 'taken'}\n`);
    l?.release();
    break;
  }
  case 'open': {
    const m = openMemory(a.project, {
      git: undefined,
      ...(a.machine !== undefined ? { machine: a.machine } : {}),
      hooks: {
        afterMoveStep: (step) => {
          if (a.sleepAtStep !== undefined && step === a.sleepAtStep.step) sleep(a.sleepAtStep.ms);
          if (step === a.crashAfterStep) process.kill(process.pid, 'SIGKILL');
        },
      },
    });
    process.stdout.write(`${JSON.stringify({ head: m.head(), place: m.status().place })}\n`);
    m.close();
    break;
  }
  case 'write-many': {
    // One of several mp processes writing at once (§11.3): every write lands, none surfaces a lock error.
    const m = openMemory(a.project, { git: null });
    for (let i = 0; i < a.count; i++) {
      const version = `req-${a.prefix}.v${i}`;
      m.write({ op: `${a.prefix}-${i}`, payload: version }, (tx) =>
        appendRecords(tx, [{ kind: 'basis.version', basisKind: 'requirement', line: `req-${a.prefix}` as never, version: version as never, mission: 'm1' as never, scope: null }]),
      );
      if (i === 0) process.stdout.write('ready\n');
    }
    m.close();
    process.stdout.write('done\n');
    break;
  }
  case 'hold-until': {
    // Holds the write lock until every named file exists (other writers waiting), then a while longer.
    const db = new DatabaseSync(join(a.project, '.mission-pipeline', 'memory.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('ready\n');
    while (!a.files.every((f) => existsSync(f))) sleep(10);
    sleep(a.ms);
    db.exec('ROLLBACK');
    db.close();
    break;
  }
  case 'write-until-marker': {
    // A write in progress while another process finds damage and marks it: it must not commit.
    const m = openMemory(a.project, { git: null, busyTimeoutMs: 5000 });
    let result: string;
    try {
      m.write({ op: 'during-break', payload: 1 }, (tx) => {
        writeFileSync(a.held, '1');
        const until = Date.now() + 5000;
        const locks = join(a.project, '.mission-pipeline', 'locks');
        while (!readdirSync(locks).some((n) => n.startsWith('chain-broken-')) && Date.now() < until) sleep(5);
        return setMission(tx, 'm2' as never, 'open');
      });
      result = 'committed';
    } catch (e) {
      result = (e as { code?: string }).code ?? String(e);
    }
    process.stdout.write(`${JSON.stringify({ result, receipt: m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'during-break'").get()!.n })}\n`);
    m.close();
    break;
  }
  case 'hold-both': {
    // Holds SQLite's write lock and the stop lock; once the writer started, frees the stop lock after one stage, SQLite's after another.
    const db = new DatabaseSync(join(a.project, '.mission-pipeline', 'memory.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    if (a.read === true) {
      // A long read instead: the writer takes the write lock at once, but its COMMIT waits for this reader.
      db.exec('BEGIN DEFERRED');
      db.prepare('SELECT COUNT(*) FROM log').get();
    } else db.exec('BEGIN IMMEDIATE');
    const held = lock(join(a.project, '.mission-pipeline', 'locks'), 'stop', { waitMs: 5000 });
    process.stdout.write('ready\n');
    while (!existsSync(a.start)) sleep(5);
    sleep(a.stageMs);
    held.release();
    sleep(a.stageMs);
    db.exec('ROLLBACK');
    db.close();
    break;
  }
  case 'writer': {
    // An ordinary writer (with an extension that runs a batch before its write) or a stop writer, both waiting for the lock.
    const m = openMemory(a.project, {
      git: null,
      busyTimeoutMs: 10_000,
      extensions:
        a.role === 'normal'
          ? [{ name: 'batch', beforeWrite: (mem) => mem.write({ op: 'batch', payload: 1 }, (tx) => appendRecords(tx, [{ kind: 'basis.version', basisKind: 'requirement', line: 'r' as never, version: 'r.v1' as never, mission: 'm1' as never, scope: null }])) }]
          : [],
    });
    writeFileSync(a.mark, a.role);
    m.write({ op: a.role, payload: 1, stop: a.role === 'stop' }, (tx) => (a.role === 'stop' ? commitStop(tx, { stop: 'S' as never, scope: { kind: 'all' }, words: 'stop', at: 1 }) : setMission(tx, 'm1' as never, 'open')));
    m.close();
    process.stdout.write('done\n');
    break;
  }
  case 'crash-in-write': {
    // Leaves written, then the process dies before the commit (§3.2 "Writing a leaf").
    const m = openMemory(a.project, { git: null, hooks: { beforeCommit: () => process.kill(process.pid, 'SIGKILL') } });
    m.write({ op: a.op, payload: { document: a.document, journal: a.journal } }, (tx) => {
      tx.leaves.writeDocument(a.document, '# the document\n');
      tx.leaves.appendEntry(a.journal, 'the entry');
      return null;
    });
    break;
  }
}
