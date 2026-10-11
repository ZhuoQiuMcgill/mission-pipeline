// The project memory's layout, opening and write path (design 4.1 §3.1, §3.2, §4.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  appendRecords,
  claimDispatch,
  commitStop,
  initMemory,
  LAYOUT_DIRS,
  openMemory,
  queueTask,
  recordsByKind,
  setMission,
  STATE_TABLES,
  tryLock,
  type MemoryExtension,
  type WriteTx,
} from '../src/memory/index.ts';
import { id, type BasisLineId, type BasisVersionId, type MissionId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { child, git, kinds, project, repo, tempDir, throwsCode } from './memory-fixtures.ts';

const M = id<MissionId>('m1');

function basis(n: number): BaseRecord {
  return { kind: 'basis.version', basisKind: 'requirement', line: id<BasisLineId>('req-a'), version: id<BasisVersionId>(`req-a.v${n}`), mission: M, scope: null };
}

test('init creates the layout, memory.db (journal mode DELETE) and the exclude line; it is idempotent; open needs it', () => {
  const base = tempDir('mp-mem-init-');
  try {
    const dir = join(base, 'p');
    git(base, 'init', '-q', dir);
    throwsCode(() => openMemory(dir), 'NOT_INITIALIZED', /run mp init/);
    const r = initMemory(dir);
    assert.equal(r.created, true);
    assert.equal(r.exclude, 'added');
    assert.deepEqual(r.layout.warnings, []);
    for (const d of LAYOUT_DIRS) assert.ok(existsSync(join(dir, '.mission-pipeline', d)), d);
    assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.mission-pipeline\/$/m);
    assert.equal(git(dir, 'status', '--porcelain'), '', 'the memory is not seen by git');
    const again = initMemory(dir);
    assert.deepEqual([again.created, again.exclude], [false, 'present']);
    const m = openMemory(dir);
    try {
      assert.equal((m.connection.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
      assert.equal(Number((m.connection.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous), 2, 'FULL');
      assert.deepEqual(kinds(m), ['memory.init'], 'init is idempotent: one first event');
      const st = m.status();
      assert.equal(st.place.path, dir);
      assert.equal(st.format, 'mp-memory-1');
      assert.equal(st.movePending, null);
    } finally {
      m.close();
    }
    // A project folder below the repository's top: the line is anchored there; the git directory lies outside it (warned).
    const sub = join(dir, 'services', 'api');
    mkdirSync(sub, { recursive: true });
    const r2 = initMemory(sub);
    assert.equal(r2.exclude, 'added');
    assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/services\/api\/\.mission-pipeline\/$/m);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(r2.layout.gitDirOutside, true);
    assert.match(r2.layout.warnings.join('\n'), /git directory .* lies outside the project folder/);
    // A folder that is not a repository still gets its memory.
    const plain = join(base, 'plain');
    mkdirSync(plain, { recursive: true });
    assert.equal(initMemory(plain).exclude, 'no-repository');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('idempotent writes: the same op and payload return the recorded answer and append nothing; another payload is OP_CONFLICT', () => {
  const w = project();
  try {
    const { m } = w;
    const a = m.write({ op: 'op-1', payload: { records: [basis(1)] } }, (tx) => appendRecords(tx, [basis(1)]));
    const head = m.head();
    let ran = false;
    const b = m.write({ op: 'op-1', payload: { records: [basis(1)] } }, () => {
      ran = true;
      return null;
    });
    assert.deepEqual(b, a);
    assert.equal(ran, false, 'a retry does not run again');
    assert.equal(m.head(), head, 'a retry appends nothing');
    throwsCode(() => m.write({ op: 'op-1', payload: { records: [basis(2)] } }, (tx) => appendRecords(tx, [basis(2)])), 'OP_CONFLICT');
    throwsCode(() => m.write({ op: 'no-payload' }, () => null), 'BAD_REQUEST', /names no payload/);
    throwsCode(() => m.write({ op: 'x\ny', payload: 1 }, () => null), 'BAD_REQUEST');
    // The receipt is a log event, so a rebuild keeps the answer.
    m.rebuild();
    assert.deepEqual(m.write({ op: 'op-1', payload: { records: [basis(1)] } }, () => null), a);
    // A refused write commits nothing, not even its receipt.
    throwsCode(() => m.write({ op: 'op-2', payload: 2 }, (tx) => appendRecords(tx, [{ kind: 'nonsense' } as never])), 'KIND_NOT_ALLOWED');
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'op-2'").get()!.n, 0);
  } finally {
    w.cleanup();
  }
});

test('a PM command records the PM’s filler with its operation (§3.2 item 13)', () => {
  const w = project();
  try {
    w.m.write({ op: 'pm-open-1', payload: { mission: M }, command: 'open', filler: { harness: 'codex', model: 'gpt-x' } }, (tx) => setMission(tx, M, 'open'));
    w.m.write({ op: 'pm-open-2', payload: { mission: 'm2' }, command: 'open', filler: { harness: 'claude-code', model: null } }, (tx) => setMission(tx, id<MissionId>('m2'), 'open'));
    const rows = w.m.stmt('SELECT op, command, harness, model FROM pm_commands ORDER BY rev').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { op: 'pm-open-1', command: 'open', harness: 'codex', model: 'gpt-x' },
      { op: 'pm-open-2', command: 'open', harness: 'claude-code', model: null },
    ]);
    throwsCode(() => w.m.write({ command: 'open', payload: 1 }, () => null), 'BAD_REQUEST', /operation id/);
    throwsCode(() => w.m.write({ op: 'f', payload: 1, filler: { harness: '' } as never }, () => null), 'BAD_REQUEST', /filler/);
  } finally {
    w.cleanup();
  }
});

test('busy: a write waits for the lock up to the busy limit, then BUSY with nothing written', async () => {
  const w = project({ busyTimeoutMs: 300 });
  try {
    const holder = child({ action: 'hold-write', project: w.dir, ms: 1500 });
    assert.equal(await holder.line, 'ready');
    const head = w.m.head();
    const t0 = Date.now();
    throwsCode(() => w.m.write({ op: 'b1', payload: 1 }, (tx) => setMission(tx, M, 'open')), 'BUSY', /nothing was written: retry/);
    assert.ok(Date.now() - t0 >= 250, 'it waited');
    await holder.exit;
    assert.equal(w.m.head(), head);
    // Once the holder is gone, the retry goes through.
    w.m.write({ op: 'b1', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    assert.equal(w.m.stmt('SELECT state FROM missions').get()!.state, 'open');
  } finally {
    w.cleanup();
  }
});

test('several mp processes writing at once: every write lands once, in one unbroken chain (§11.3)', async () => {
  const w = project();
  try {
    const writers = ['a', 'b', 'c', 'd'].map((prefix) => child({ action: 'write-many', project: w.dir, prefix, count: 25 }));
    assert.deepEqual(await Promise.all(writers.map((c) => c.exit)), [0, 0, 0, 0]);
    assert.equal(w.m.stmt("SELECT COUNT(*) AS n FROM facts WHERE kind = 'basis.version'").get()!.n, 100);
    assert.equal(w.m.stmt('SELECT COUNT(*) AS n FROM ops').get()!.n, 100);
    assert.equal(w.m.verifyChain().ok, true);
  } finally {
    w.cleanup();
  }
});

test('review #4: a write runs synchronously: an async callback is refused and rolled back; an ended transaction cannot be used', async () => {
  const w = project();
  try {
    const { m } = w;
    let late: unknown = null;
    throwsCode(
      () =>
        m.write({ op: 'async-op', payload: 1 }, async (tx) => {
          setMission(tx, M, 'open');
          await Promise.resolve();
          try {
            setMission(tx, id<MissionId>('m2'), 'open');
          } catch (e) {
            late = e;
          }
        }),
      'BAD_REQUEST',
      /runs synchronously/,
    );
    await new Promise((r) => setImmediate(r));
    assert.match(String((late as Error | null)?.message), /has ended/, 'the code after the await runs on an ended transaction and fails');
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM missions').get()!.n, 0, 'nothing of it was written');
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'async-op'").get()!.n, 0, 'no receipt');
    let kept: WriteTx | null = null;
    m.write({}, (tx) => {
      kept = tx;
      return setMission(tx, M, 'open');
    });
    const tx = kept as unknown as WriteTx;
    for (const use of [() => tx.stmt('SELECT 1'), () => tx.append({ kind: 'cursor.set', cursor: 'x', rev: 0 }), () => tx.data.put('x'), () => tx.leaves.writeDocument('x.md', 'x'), () => setMission(tx, M, 'closed')]) {
      throwsCode(use, 'BAD_REQUEST', /has ended/);
    }
    assert.equal(m.verifyChain().ok, true);
  } finally {
    w.cleanup();
  }
});

test('review round 2 #1: a statement obtained through the transaction cannot run once the write ended (kept past an await, or kept past the write)', async () => {
  const w = project();
  try {
    const { m } = w;
    m.write({ op: 'queue', payload: 1 }, (tx) => queueTask(tx, { task: 'T', lineage: 'L', mission: M, card: tx.data.put('spec') }));
    m.write({ op: 'stop', payload: 1, stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
    let late: unknown = null;
    // The reviewer's repro: a statement cached before an await, run after the write was refused.
    throwsCode(
      () =>
        m.write({ op: 'async', payload: 1 }, async (tx) => {
          const statement = tx.stmt("DELETE FROM stops WHERE stop = 'S'");
          await Promise.resolve();
          try {
            late = statement.run();
          } catch (e) {
            late = e;
          }
        }),
      'BAD_REQUEST',
    );
    await new Promise((r) => setImmediate(r));
    assert.match(String((late as Error | null)?.message), /has ended/);
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM stops').get()!.n, 1, 'the stop stays');
    throwsCode(() => m.write({ op: 'claim', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D', task: 'T', seat: 'reviewer' })), 'STOPPED');
    // A statement kept past a committed write.
    let kept: StatementSync | null = null;
    m.write({}, (tx) => {
      kept = tx.stmt('UPDATE missions SET state = ? WHERE mission = ?');
      return null;
    });
    throwsCode(() => (kept as unknown as StatementSync).run('closed', 'm1'), 'BAD_REQUEST', /has ended/);
    assert.equal(m.verifyChain().ok, true);
  } finally {
    w.cleanup();
  }
});

test('review round 2 #4: one busy limit for the whole write: waiting for the stop lock and then for SQLite’s lock never adds up past it', async () => {
  const w = project({ busyTimeoutMs: 600 });
  try {
    const { m } = w;
    const start = join(w.dir, 'writer-started');
    // The holder frees the stop lock 400 ms after the writer starts, SQLite's lock 400 ms later: 800 ms in all.
    const holder = child({ action: 'hold-both', project: w.dir, start, stageMs: 400 });
    assert.equal(await holder.line, 'ready');
    const head = m.head();
    writeFileSync(start, '1');
    const t0 = Date.now();
    throwsCode(() => m.write({ op: 'late', payload: 1 }, (tx) => setMission(tx, M, 'open')), 'BUSY', /nothing was written/);
    const waited = Date.now() - t0;
    assert.ok(waited >= 500 && waited < 790, `gave up at the one limit (${waited} ms)`);
    assert.equal(m.head(), head);
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'late'").get()!.n, 0, 'no receipt');
    await holder.exit;
    m.write({ op: 'late', payload: 1 }, (tx) => setMission(tx, M, 'open'));
  } finally {
    w.cleanup();
  }
});

test('review round 3 #1: an iterator from a statement of the transaction cannot step once the write ended', async () => {
  const w = project();
  try {
    const { m } = w;
    m.write({ op: 'queue', payload: 1 }, (tx) => queueTask(tx, { task: 'T', lineage: 'L', mission: M, card: tx.data.put('spec') }));
    m.write({ op: 'stop', payload: 1, stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
    let late: unknown = null;
    // The reviewer's repro: a DELETE ... RETURNING iterator taken before an await, stepped after the write was refused.
    throwsCode(
      () =>
        m.write({ op: 'async', payload: 1 }, async (tx) => {
          const it = tx.stmt("DELETE FROM stops WHERE stop = 'S' RETURNING stop").iterate();
          await Promise.resolve();
          try {
            late = it.next();
          } catch (e) {
            late = e;
          }
        }),
      'BAD_REQUEST',
    );
    await new Promise((r) => setImmediate(r));
    assert.match(String((late as Error | null)?.message), /has ended/);
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM stops').get()!.n, 1, 'the stop stays');
    throwsCode(() => m.write({ op: 'claim', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D', task: 'T', seat: 'reviewer' })), 'STOPPED');
    // Kept past a committed write: no step, not even through for...of.
    let kept: Iterator<unknown> & Iterable<unknown> = [][Symbol.iterator]();
    m.write({}, (tx) => {
      kept = tx.stmt('SELECT rev FROM log').iterate() as unknown as Iterator<unknown> & Iterable<unknown>;
      return null;
    });
    throwsCode(() => kept.next(), 'BAD_REQUEST', /has ended/);
    throwsCode(() => {
      for (const _ of kept) void _;
    }, 'BAD_REQUEST', /has ended/);
    // Inside its write, the iterator works as usual.
    assert.ok(m.write({}, (tx) => [...(tx.stmt('SELECT rev FROM log').iterate() as unknown as Iterable<unknown>)].length) > 0);
  } finally {
    w.cleanup();
  }
});

test('review round 3 #2: a beforeCommit that returns a promise rolls the whole write back', async () => {
  // @ts-expect-error a beforeCommit is synchronous: an async one does not type-check.
  const typed: MemoryExtension = { name: 'x', beforeCommit: async () => undefined };
  void typed;
  let rejected = false;
  const ext = {
    name: 'async-propagation',
    beforeCommit: async (tx: WriteTx) => {
      await Promise.resolve();
      rejected = true;
      tx.append({ kind: 'cursor.set', cursor: 'labels', rev: 0 });
    },
  } as unknown as MemoryExtension;
  const w = project({ extensions: [ext] });
  try {
    const { m } = w;
    const head = m.head();
    throwsCode(() => m.write({ op: 'o', payload: 1 }, (tx) => setMission(tx, M, 'open')), 'BAD_REQUEST', /beforeCommit returned a promise/);
    await new Promise((r) => setImmediate(r));
    assert.equal(rejected, true, 'its later part ran, on an ended transaction, and its rejection was handled');
    assert.equal(m.head(), head, 'nothing written');
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM missions').get()!.n, 0);
  } finally {
    w.cleanup();
  }
});

test('review round 3 #3: a damaged event seen by a read or a write is recorded and stops the writes, even when the caller caught or converted the error', () => {
  for (const where of ['read-caught', 'write-caught', 'write-other-error'] as const) {
    const w = project();
    try {
      const { m } = w;
      m.write({ op: 'inputs', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
      m.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
      m.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
      let caught = '';
      const inspect = (db: Parameters<typeof recordsByKind>[0]): void => {
        try {
          recordsByKind(db, { kinds: ['basis.version'] });
        } catch (e) {
          caught = (e as { code?: string }).code ?? '';
        }
      };
      if (where === 'read-caught') {
        m.read((db) => inspect(db));
      } else {
        assert.throws(() =>
          m.write({ op: 'inspect', payload: 1 }, (tx) => {
            inspect(tx);
            if (where === 'write-other-error') throw new Error('rendered as another error');
            return setMission(tx, id<MissionId>('m2'), 'open');
          }),
        );
        assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'inspect'").get()!.n, 0, `${where}: the write that saw it did not commit`);
      }
      assert.equal(caught, 'CHAIN_BROKEN', where);
      assert.notEqual(m.status().chainBroken, null, `${where}: the break is recorded`);
      throwsCode(() => m.write({ op: 'next', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open')), 'CHAIN_BROKEN');
    } finally {
      w.cleanup();
    }
  }
});

test('review round 3 #4: the COMMIT waits only for what is left of the one busy limit; past it nothing is written', async () => {
  const w = project({ busyTimeoutMs: 600 });
  try {
    const { m } = w;
    const start = join(w.dir, 'writer-started');
    // A long reader and the stop lock: the stop lock is free at 400 ms, the reader ends at 800 ms; the COMMIT waits for it.
    const holder = child({ action: 'hold-both', project: w.dir, start, stageMs: 400, read: true });
    assert.equal(await holder.line, 'ready');
    const head = m.head();
    writeFileSync(start, '1');
    const t0 = Date.now();
    throwsCode(() => m.write({ op: 'late', payload: 1 }, (tx) => setMission(tx, M, 'open')), 'BUSY', /waiting to commit/);
    const waited = Date.now() - t0;
    assert.ok(waited >= 500 && waited < 790, `gave up at the one limit (${waited} ms)`);
    assert.equal(m.head(), head);
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'late'").get()!.n, 0, 'no receipt');
    await holder.exit;
    m.write({ op: 'late', payload: 1 }, (tx) => setMission(tx, M, 'open'));
  } finally {
    w.cleanup();
  }
});

test('extensions: beforeCommit runs at the end of every write (an op id or not, a stop too), inside it and before its receipt; not for a retry', () => {
  const calls: string[] = [];
  const ext: MemoryExtension = {
    name: 'propagation',
    beforeCommit: (tx) => {
      calls.push(tx.op ?? '(none)');
      tx.append({ kind: 'cursor.set', cursor: 'labels', rev: Number(tx.head()) });
    },
  };
  const w = project({ extensions: [ext] });
  try {
    const { m } = w;
    m.write({}, (tx) => setMission(tx, M, 'open'));
    m.write({ op: 'o1', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m2'), 'open'));
    m.write({ op: 'o1', payload: 1 }, () => null);
    m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
    assert.deepEqual(calls, ['(none)', 'o1', '(none)']);
    const o1 = (m.stmt("SELECT kind FROM log WHERE op = 'o1' ORDER BY rev").all() as Array<{ kind: string }>).map((r) => r.kind);
    assert.deepEqual(o1, ['mission.state', 'cursor.set', 'op.receipt']);
  } finally {
    w.cleanup();
  }
});

test('review #16: the first answer of an operation is the recorded one (undefined is null, objects in their recorded form)', () => {
  const w = project();
  try {
    const first = w.m.write({ op: 'nothing', payload: 1 }, () => undefined);
    assert.equal(first, null);
    assert.equal(w.m.write({ op: 'nothing', payload: 1 }, () => undefined), null);
    const a = w.m.write({ op: 'obj', payload: 1 }, () => ({ b: 1, a: undefined as unknown, c: [1] }));
    assert.deepEqual(a, { b: 1, c: [1] });
    assert.deepEqual(w.m.write({ op: 'obj', payload: 1 }, () => null), a);
  } finally {
    w.cleanup();
  }
});

test('review #5: the memory needs neither node:sqlite’s `timeout` option nor `isTransaction` (Node 22.12-22.15 have neither)', () => {
  // A connection without `isTransaction` (as on Node 22.12): a failed write is rolled back, the next one works.
  const w = project();
  try {
    const { m } = w;
    const raw = m.connection;
    (m as unknown as { statements: { db: unknown } }).statements.db = { exec: raw.exec.bind(raw), prepare: raw.prepare.bind(raw), close: raw.close.bind(raw), isTransaction: undefined };
    assert.throws(() =>
      m.write({ op: 'f', payload: 1 }, (tx) => {
        setMission(tx, M, 'open');
        throw new Error('rollback me');
      }),
    /rollback me/);
    m.write({ op: 'g', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m2'), 'open'));
    assert.deepEqual(m.stmt('SELECT mission FROM missions').all().map((r) => r.mission), ['m2']);
  } finally {
    w.cleanup();
  }
  // And no source of the memory asks for them.
  const dir = fileURLToPath(new URL('../src/memory/', import.meta.url));
  for (const f of [...readdirSync(dir).map((n) => join(dir, n)), ...readdirSync(join(dir, 'domain')).map((n) => join(dir, 'domain', n))].filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\.isTransaction\b/, f);
    assert.doesNotMatch(src, /new DatabaseSync\([^)]*,/, `${f}: a DatabaseSync opened with options`);
  }
});

test('review #9: a retry of a committed operation stays within the work budget too', () => {
  const w = project();
  try {
    const { m } = w;
    m.write({ op: 'first', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    // The reviewer's repro: every data insert does 2.1 s of work.
    m.connection.function('slow_work', () => {
      const until = performance.now() + 2100;
      while (performance.now() < until) {
        /* work */
      }
      return 0;
    });
    m.connection.exec('CREATE TRIGGER slow_data BEFORE INSERT ON data BEGIN SELECT slow_work(); END;');
    const h = m.data.put('staged before a retry');
    throwsCode(() => m.write({ op: 'first', payload: 1 }, () => null), 'OVER_BUDGET', /nothing was written/);
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM data WHERE hash = ?').get(h)!.n, 0);
    m.connection.exec('DROP TRIGGER slow_data');
    assert.deepEqual(m.write({ op: 'first', payload: 1 }, () => null), { mission: M, state: 'open' });
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM data WHERE hash = ?').get(h)!.n, 1, 'still staged, written by the next write');
  } finally {
    w.cleanup();
  }
});

test('review #10: while a stop is announced (another process holds the stop lock), ordinary writes wait for it and write nothing', async () => {
  const w = project({ busyTimeoutMs: 300 });
  let announcing: ReturnType<typeof child> | null = null;
  try {
    const { m } = w;
    announcing = child({ action: 'hold-lock', locks: join(w.dir, '.mission-pipeline', 'locks'), name: 'stop' });
    assert.equal(await announcing.line, 'ready');
    const head = m.head();
    throwsCode(() => m.write({ op: 'n1', payload: 1 }, (tx) => setMission(tx, M, 'open')), 'BUSY', /stops/);
    assert.equal(m.head(), head, 'nothing written');
    throwsCode(() => m.write({ op: 's1', payload: 1, stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S1'), scope: { kind: 'all' }, words: 'stop', at: 1 })), 'BUSY', /stops/);
    announcing.proc.kill('SIGKILL');
    await announcing.exit;
    m.write({ op: 'n1', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    assert.equal(m.stmt('SELECT state FROM missions').get()!.state, 'open');
  } finally {
    announcing?.proc.kill('SIGKILL');
    w.cleanup();
  }
});

test('review #10: a writer that got the write lock while a stop announced itself gives it back at once, with nothing written', () => {
  let announced: ReturnType<typeof tryLock> = null;
  let probe: string | null = null;
  let locks: string | null = null;
  const w = project({
    busyTimeoutMs: 300,
    hooks: {
      afterBegin: (stop) => {
        if (stop || locks === null || announced !== null || probe !== null) return;
        // A stop writer in another process announces itself now, while this writer holds SQLite's lock.
        announced = tryLock(locks, 'stop');
      },
    },
  });
  try {
    const { m } = w;
    locks = join(w.dir, '.mission-pipeline', 'locks');
    const head = m.head();
    throwsCode(() => m.write({ op: 'n1', payload: 1 }, (tx) => setMission(tx, M, 'open')), 'BUSY');
    // It gave SQLite's lock back: another connection writes at once.
    const other = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
    try {
      other.exec('PRAGMA busy_timeout = 0');
      other.exec('BEGIN IMMEDIATE');
      other.exec('ROLLBACK');
      probe = 'free';
    } finally {
      other.close();
    }
    assert.equal(probe, 'free');
    assert.equal(m.head(), head, 'nothing written');
    (announced as { release(): void } | null)?.release();
    m.write({ op: 'n1', payload: 1 }, (tx) => setMission(tx, M, 'open'));
  } finally {
    w.cleanup();
  }
});

// A scenario check, not a regression test: SQLite's busy back-off alone often lets the later stop win here; the two tests above fail without the stop lock.
test('scenario (review #10): a stop is written before writers that waited longer, in other processes', async () => {
  const w = project();
  try {
    const marks = join(w.dir, 'marks');
    mkdirSync(marks);
    const normalMark = join(marks, 'normal');
    const stopMark = join(marks, 'stop');
    const holder = child({ action: 'hold-until', project: w.dir, files: [normalMark, stopMark], ms: 600 });
    assert.equal(await holder.line, 'ready');
    const normal = child({ action: 'writer', project: w.dir, role: 'normal', mark: normalMark });
    while (!existsSync(normalMark)) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    const stop = child({ action: 'writer', project: w.dir, role: 'stop', mark: stopMark });
    assert.deepEqual(await Promise.all([holder.exit, normal.exit, stop.exit]), [0, 0, 0]);
    const order = (w.m.stmt("SELECT kind, op FROM log WHERE op IN ('batch', 'normal', 'stop') ORDER BY rev").all() as Array<{ kind: string; op: string }>).map((r) => `${r.op}:${r.kind}`);
    assert.equal(order[0], 'stop:stop.committed', order.join(', '));
    assert.ok(order.indexOf('batch:basis.version') > order.indexOf('stop:op.receipt'));
    assert.ok(order.indexOf('normal:mission.state') > order.indexOf('stop:op.receipt'));
  } finally {
    w.cleanup();
  }
});

test('the work budget: a write over it is rolled back with nothing written (leaves included); batches check budgetLeft()', () => {
  const w = project({ workBudgetMs: 50 });
  try {
    const head = w.m.head();
    throwsCode(
      () =>
        w.m.write({ op: 'slow', payload: 1 }, (tx) => {
          setMission(tx, M, 'open');
          tx.leaves.writeDocument('missions/m1/plans/p1.md', '# plan\n');
          const until = performance.now() + 80;
          while (performance.now() < until) {
            /* work */
          }
          return null;
        }),
      'OVER_BUDGET',
      /nothing was written/,
    );
    assert.equal(w.m.head(), head);
    assert.equal(existsSync(join(w.dir, '.mission-pipeline', 'missions', 'm1', 'plans', 'p1.md')), false, 'the leaf was removed');
    assert.equal(w.m.status().pendingLeaves, false);
    // A batching caller stops in time.
    const done = w.m.write({ op: 'batch', payload: 1 }, (tx) => {
      let n = 0;
      while (tx.budgetLeft() > 25) n++;
      return n > 0;
    });
    assert.equal(done, true);
  } finally {
    w.cleanup();
  }
});

test('a write may carry its own work budget: Infinity commits past the default; never for a stop', () => {
  const w = project({ workBudgetMs: 50 });
  try {
    const { m } = w;
    const slow = (tx: WriteTx) => {
      const until = performance.now() + 80;
      while (performance.now() < until) {
        /* work */
      }
      return setMission(tx, M, 'open');
    };
    throwsCode(() => m.write({ op: 'default', payload: 1 }, slow), 'OVER_BUDGET');
    let left = 0;
    m.write({ op: 'exempt', payload: 1, workBudgetMs: Number.POSITIVE_INFINITY }, (tx) => {
      const out = slow(tx);
      left = tx.budgetLeft();
      return out;
    });
    assert.equal(left, Number.POSITIVE_INFINITY);
    assert.equal(m.stmt('SELECT state FROM missions').get()!.state, 'open');
    throwsCode(() => m.write({ op: 'own', payload: 1, workBudgetMs: 20 }, slow), 'OVER_BUDGET');
    for (const bad of [0, -1, Number.NaN, '5' as unknown as number]) throwsCode(() => m.write({ workBudgetMs: bad }, () => null), 'BAD_REQUEST', /positive number/);
    throwsCode(
      () => m.write({ stop: true, workBudgetMs: Number.POSITIVE_INFINITY }, (tx) => commitStop(tx, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: 'stop', at: 1 })),
      'BAD_REQUEST',
      /stop gets no work budget/,
    );
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM stops').get()!.n, 0);
  } finally {
    w.cleanup();
  }
});

test('data: a value put outside a write is inserted by the next write; get checks the hash; lists keep their count', () => {
  const w = project();
  try {
    const { m } = w;
    const h = m.data.put('spec of T1');
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM data WHERE hash = ?').get(h)!.n, 0, 'staged, not written yet');
    assert.equal(m.data.text(h), 'spec of T1', 'readable while staged');
    m.write({ op: 'q', payload: 1 }, (tx) => queueTask(tx, { task: 'T1', lineage: 'L1', mission: M, card: h }));
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM data WHERE hash = ?').get(h)!.n, 1, 'written with the record that names it');
    const list = m.data.putList(['a', 'b']);
    assert.deepEqual(m.write({}, () => m.data.getList(list)), ['a', 'b']);
    throwsCode(() => m.data.getList({ ...list, count: 3 }), 'RECORD_INVALID');
    throwsCode(() => m.data.get('f'.repeat(64)), 'CONTENT_MISSING');
    // A damaged value is never served.
    m.connection.prepare("UPDATE data SET body = CAST('tampered' AS BLOB) WHERE hash = ?").run(h);
    throwsCode(() => m.data.get(h), 'CONTENT_MISSING', /damaged/);
  } finally {
    w.cleanup();
  }
});

test('stops are written before anything queued: a stop write skips the extensions’ work before writes', () => {
  let batches = 0;
  const ext: MemoryExtension = {
    name: 'counter',
    beforeWrite: (m) => {
      batches++;
      // One bounded batch, as its own write: never recursive.
      m.write({}, () => null);
    },
  };
  const w = project({ extensions: [ext] });
  try {
    w.m.write({}, (tx) => setMission(tx, M, 'open'));
    assert.equal(batches, 1);
    w.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S1'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
    assert.equal(batches, 1, 'the stop did not wait for a batch');
  } finally {
    w.cleanup();
  }
});

test('extensions: their tables are created, maintained by every append and rebuilt from the log', () => {
  const ext: MemoryExtension = {
    name: 'kinds',
    schema: 'CREATE TABLE IF NOT EXISTS ext_kinds (kind TEXT PRIMARY KEY, n INTEGER NOT NULL);',
    tables: ['ext_kinds'],
    stateTables: ['ext_kinds'],
    project: (tx, rec) => {
      tx.stmt('INSERT INTO ext_kinds (kind, n) VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET n = n + 1').run(rec.kind);
    },
  };
  const w = project({ extensions: [ext] });
  try {
    w.m.write({ op: 'a', payload: 1 }, (tx) => appendRecords(tx, [basis(1), basis(2)]));
    const before = w.m.stmt('SELECT * FROM ext_kinds ORDER BY kind').all().map((r) => ({ ...r }));
    assert.deepEqual(before.find((r) => r.kind === 'basis.version'), { kind: 'basis.version', n: 2 });
    w.m.rebuild();
    assert.deepEqual(w.m.stmt('SELECT * FROM ext_kinds ORDER BY kind').all().map((r) => ({ ...r })), before);
  } finally {
    w.cleanup();
  }
});

test('every state table is rebuilt from the log, row for row, after a varied workload', async () => {
  const { domainWorkload } = await import('./memory-workload.ts');
  const w = project();
  try {
    domainWorkload(w.m);
    const dump = (): Record<string, unknown[]> => Object.fromEntries(STATE_TABLES.map((t) => [t, w.m.stmt(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...r }))]));
    const before = dump();
    assert.ok(STATE_TABLES.filter((t) => before[t]!.length > 0).length >= 20, `most tables hold rows: ${STATE_TABLES.filter((t) => before[t]!.length === 0).join(', ')} are empty`);
    w.m.rebuild();
    assert.deepEqual(dump(), before);
    // Also after reopening a copy of the database file.
    w.m.close();
    const db = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
    db.exec('DELETE FROM dispatches; DELETE FROM leaves;');
    db.close();
    const m = w.reopen();
    m.rebuild();
    assert.deepEqual(dump(), before);
  } finally {
    w.cleanup();
  }
});

test('a write cannot start inside another; reads see one snapshot', () => {
  const w = project();
  try {
    assert.throws(() => w.m.write({}, () => w.m.write({}, () => null)), /cannot start inside another/);
    const out = w.m.read((db) => [db.stmt('SELECT COUNT(*) AS n FROM log').get()!.n, db.stmt('SELECT COUNT(*) AS n FROM log').get()!.n]);
    assert.equal(out[0], out[1]);
  } finally {
    w.cleanup();
  }
});

test('a repository with one commit: init reports no warning', () => {
  const base = tempDir('mp-mem-repo-');
  try {
    repo(base);
    assert.deepEqual(initMemory(base).layout.warnings, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
