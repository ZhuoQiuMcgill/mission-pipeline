// The event log's hash chain (design 4.1 §3.3 step 3, §11.8): every event
// carries the hash of the one before and marks the end of its write; the
// verifier names the last valid event; a broken chain stops every write and is
// never rebuilt from; the PM continues from the last whole write before the
// break (or copies again).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id, type BasisLineId, type BasisVersionId, type MissionId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { eventHash } from '../src/memory/chain.ts';
import { appendRecords, claimDispatch, commitStop, dispatchInfo, factById, GENESIS, openMemory, queueTask, rebuildState, recordsByKind, releaseDispatch, setMission, taskInfo, verifyChain, walkChain } from '../src/memory/index.ts';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { child, childJson, kinds, project, throwsCode } from './memory-fixtures.ts';

const M = id<MissionId>('m1');
const basis = (n: number): BaseRecord => ({ kind: 'basis.version', basisKind: 'requirement', line: id<BasisLineId>('req-a'), version: id<BasisVersionId>(`req-a.v${n}`), mission: M, scope: null });

type Row = { rev: number; kind: string; op: string | null; record: string; committed_at: number; prev: string; hash: string; txn_end: number };

test('every event carries the hash of the one before and marks the end of its write; the verifier walks the whole chain', () => {
  const w = project();
  try {
    for (let i = 1; i <= 5; i++) w.m.write({ op: `b${i}`, payload: i }, (tx) => appendRecords(tx, [basis(i)]));
    const rows = w.m.stmt('SELECT rev, kind, op, record, committed_at, prev, hash, txn_end FROM log ORDER BY rev').all() as unknown as Row[];
    assert.equal(rows[0]!.prev, GENESIS);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.prev, rows[i - 1]!.hash);
    for (const r of rows) assert.equal(eventHash({ rev: r.rev, kind: r.kind, op: r.op, record: r.record, committedAt: r.committed_at, prev: r.prev, end: r.txn_end === 1 }), r.hash);
    // Each write: its fact, then its receipt, which ends it.
    assert.deepEqual(rows.slice(1, 3).map((r) => [r.kind, r.txn_end]), [['basis.version', 0], ['op.receipt', 1]]);
    const rep = w.m.verifyChain();
    assert.deepEqual(rep, { ok: true, events: rows.length, lastValid: rows.length, lastWhole: rows.length, brokenAt: null, reason: null });
  } finally {
    w.cleanup();
  }
});

test('an event changed by hand breaks the chain at that event; the last valid event is the one before', () => {
  const w = project();
  try {
    for (let i = 1; i <= 5; i++) w.m.write({ op: `b${i}`, payload: i }, (tx) => appendRecords(tx, [basis(i)]));
    const target = Number(w.m.stmt("SELECT rev FROM log WHERE op = 'b3' AND kind = 'basis.version'").get()!.rev);
    w.m.connection.prepare('UPDATE log SET record = replace(record, ?, ?) WHERE rev = ?').run('req-a.v3', 'req-a.v9', target);
    const rep = verifyChain(w.m);
    assert.deepEqual([rep.ok, rep.brokenAt, rep.lastValid, rep.lastWhole], [false, target, target - 1, target - 1]);
    assert.match(rep.reason!, /changed after it was recorded/);
  } finally {
    w.cleanup();
  }
});

test('an event removed from the middle, or from the end, is detected', () => {
  const w = project();
  try {
    for (let i = 1; i <= 5; i++) w.m.write({ op: `b${i}`, payload: i }, (tx) => appendRecords(tx, [basis(i)]));
    const head = Number(w.m.head());
    w.m.connection.prepare('DELETE FROM log WHERE rev = ?').run(head - 3);
    const mid = verifyChain(w.m);
    assert.deepEqual([mid.ok, mid.brokenAt, mid.lastValid], [false, head - 3, head - 4]);
    assert.match(mid.reason!, /missing/);
  } finally {
    w.cleanup();
  }
  const w2 = project();
  try {
    for (let i = 1; i <= 3; i++) w2.m.write({ op: `b${i}`, payload: i }, (tx) => appendRecords(tx, [basis(i)]));
    const head = Number(w2.m.head());
    w2.m.connection.prepare('DELETE FROM log WHERE rev = ?').run(head);
    const tail = verifyChain(w2.m);
    assert.deepEqual([tail.ok, tail.lastValid, tail.brokenAt], [false, head - 1, head]);
    assert.match(tail.reason!, /removed/);
  } finally {
    w2.cleanup();
  }
});

test('review #1: a log with a removed or changed event is never rebuilt from; the open finds a removed one and stops every write', () => {
  const w = project();
  try {
    const { m } = w;
    m.write({ op: 'queue', payload: 1 }, (tx) => queueTask(tx, { task: 'T', lineage: 'L', mission: M, card: tx.data.put('spec') }));
    m.write({ op: 'stop', payload: 1, stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
    m.write({ op: 'later', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    // The reviewer's repro: the stop's event removed from the middle of the log.
    const rev = Number(m.stmt("SELECT rev FROM log WHERE kind = 'stop.committed'").get()!.rev);
    m.connection.prepare('DELETE FROM log WHERE rev = ?').run(rev);
    // A fresh open finds it without hashing the whole log (revisions no longer contiguous) and records the break.
    const w2 = openMemory(w.dir, { git: null });
    try {
      assert.equal(w2.status().chainBroken?.brokenAt, rev);
      throwsCode(() => w2.write({}, (tx) => setMission(tx, M, 'closed')), 'CHAIN_BROKEN');
    } finally {
      w2.close();
    }
    throwsCode(() => m.rebuild(), 'CHAIN_BROKEN', /not rebuilt from a damaged log/);
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM stops').get()!.n, 1, 'the stop stays in force');
    throwsCode(() => m.write({ op: 'claim', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D', task: 'T', seat: 'reviewer' })), 'CHAIN_BROKEN');
  } finally {
    w.cleanup();
  }
  // An event changed in place (the structure intact): the rebuild verifies every event and refuses.
  const v = project();
  try {
    v.m.write({ op: 'a', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    v.m.write({ op: 'b', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m2'), 'open'));
    v.m.connection.prepare("UPDATE log SET record = replace(record, '\"open\"', '\"closed\"') WHERE kind = 'mission.state' AND op = 'a'").run();
    throwsCode(() => v.m.rebuild(), 'CHAIN_BROKEN');
    assert.deepEqual(v.m.stmt('SELECT mission, state FROM missions ORDER BY mission').all().map((r) => [r.mission, r.state]), [['m1', 'open'], ['m2', 'open']], 'the state is as it was');
    assert.notEqual(v.m.status().chainBroken, null, 'the break is recorded: writes refused');
  } finally {
    v.cleanup();
  }
});

test('a broken chain stops every write, stops included; the PM continues from the last whole write before the break', () => {
  const w = project();
  try {
    for (let i = 1; i <= 4; i++) w.m.write({ op: `b${i}`, payload: i }, (tx) => appendRecords(tx, [basis(i)]));
    // The last event edited by hand: the next write's own check finds it.
    const head = Number(w.m.head());
    w.m.connection.prepare('UPDATE log SET committed_at = committed_at + 1 WHERE rev = ?').run(head);
    throwsCode(() => w.m.write({}, (tx) => setMission(tx, M, 'open')), 'CHAIN_BROKEN');
    assert.equal(w.m.status().chainBroken?.brokenAt, head, 'the break is recorded with the last valid event');
    throwsCode(() => w.m.write({ stop: true }, (tx) => setMission(tx, M, 'open')), 'CHAIN_BROKEN', /last valid event is/);
    // b4's fact is valid, its receipt is not: the whole of b4 goes (a write is atomic).
    assert.deepEqual(w.m.continueFromLastValid(), { lastValid: head - 1, kept: head - 2, removed: 2 });
    assert.equal(w.m.status().chainBroken, null);
    assert.equal(w.m.stmt("SELECT COUNT(*) AS n FROM facts WHERE kind = 'basis.version'").get()!.n, 3);
    w.m.write({ op: 'b4', payload: 4 }, (tx) => appendRecords(tx, [basis(4)]));
    assert.equal(w.m.stmt("SELECT COUNT(*) AS n FROM facts WHERE kind = 'basis.version'").get()!.n, 4, 'the retry writes it again');
    w.m.write({}, (tx) => setMission(tx, M, 'open'));
    assert.equal(verifyChain(w.m).ok, true);
    assert.ok(kinds(w.m).includes('memory.truncated'));
    // A middle event edited: found by a verification, then every write is refused.
    const mid = Number(w.m.stmt("SELECT rev FROM log WHERE op = 'b2' AND kind = 'basis.version'").get()!.rev);
    w.m.connection.prepare('UPDATE log SET op = ? WHERE rev = ?').run('forged', mid);
    assert.equal(w.m.verifyChain().ok, false);
    throwsCode(() => w.m.write({}, (tx) => setMission(tx, M, 'closed')), 'CHAIN_BROKEN');
  } finally {
    w.cleanup();
  }
});

test('review #2: the recovery keeps no write in part: a release whose re-queue event was damaged goes whole, and its retry re-queues the step', () => {
  const w = project();
  try {
    const { m } = w;
    m.write({ op: 'queue', payload: 1 }, (tx) => queueTask(tx, { task: 'T', lineage: 'L', mission: M, card: tx.data.put('spec') }));
    m.write({ op: 'claim', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D', task: 'T', seat: 'reviewer' }));
    m.write({ op: 'release', payload: 1 }, (tx) => releaseDispatch(tx, { dispatch: 'D', how: 'ended' }));
    const claimEnd = Number(m.stmt("SELECT rev FROM log WHERE op = 'claim' AND txn_end = 1").get()!.rev);
    const rev = Number(m.stmt("SELECT rev FROM log WHERE op = 'release' AND kind = 'task.queued'").get()!.rev);
    m.connection.prepare('UPDATE log SET committed_at = committed_at + 1 WHERE rev = ?').run(rev);
    const out = m.continueFromLastValid();
    assert.deepEqual([out.lastValid, out.kept], [rev - 1, claimEnd], 'cut after the claim, not inside the release');
    assert.equal(dispatchInfo(m, 'D')?.state, 'in-flight');
    assert.deepEqual(m.write({ op: 'release', payload: 1 }, (tx) => releaseDispatch(tx, { dispatch: 'D', how: 'ended' })), { released: true, requeued: true });
    assert.equal(taskInfo(m, 'T')?.state, 'queued');
    assert.equal(dispatchInfo(m, 'D')?.state, 'released');
  } finally {
    w.cleanup();
  }
});

test('review #3: the recovery verifies and cuts in one write transaction: no other write lands between them', () => {
  let other: ReturnType<typeof openMemory> | null = null;
  const seen: string[] = [];
  const w = project({
    busyTimeoutMs: 2000,
    hooks: {
      afterBegin: () => {
        if (other === null) return;
        try {
          other.write({ op: 'concurrent', payload: 1 }, (tx) => setMission(tx, id<MissionId>('valid'), 'open'));
          seen.push('written');
        } catch (e) {
          seen.push((e as { code?: string }).code ?? String(e));
        }
      },
    },
  });
  try {
    const { m } = w;
    m.write({ op: 'a', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    m.write({ op: 'b', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m2'), 'open'));
    m.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'mission.state' AND op = 'a'").run();
    other = openMemory(w.dir, { git: null, busyTimeoutMs: 100 });
    const out = m.continueFromLastValid();
    assert.deepEqual(seen, ['BUSY'], 'the other writer waited for the recovery, nothing landed in between');
    other.write({ op: 'concurrent', payload: 1 }, (tx) => setMission(tx, id<MissionId>('valid'), 'open'));
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'concurrent'").get()!.n, 1, 'written after the recovery, kept');
    assert.ok(out.removed > 0);
    assert.equal(m.verifyChain().ok, true);
  } finally {
    (other as ReturnType<typeof openMemory> | null)?.close();
    w.cleanup();
  }
});

test('review round 2 #2: an event damaged in place is never used for a decision: the operation is refused and the break recorded', () => {
  const w = project();
  try {
    let { m } = w;
    const empty = m.data.putList([]);
    const evidence = (e: string, exit: string): BaseRecord => ({ kind: 'evidence', evidence: e as never, envLine: 'py' as never, envSnapshot: 's' as never, runClass: 'declared', fields: { exit } });
    const judgment = { kind: 'judgment', judgment: 'J', target: 'P', review: 'r', executor: 'reviewer', verdict: 'pass', evidence: m.data.putList(['E1']), bases: empty, constraints: empty, reliesOn: empty, issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [] } as unknown as BaseRecord;
    const plan = { kind: 'object.version', object: 'P', objectKind: 'plan', mission: M, module: null, content: m.data.put('body P'), prerequisites: empty, scope: { paths: ['p.md'], taskType: 'plan' }, reviews: [{ review: 'r', basisLines: [], reliesOn: [] }] } as unknown as BaseRecord;
    m.write({ op: 'inputs', payload: 1 }, (tx) => appendRecords(tx, [plan, evidence('E1', '0'), evidence('E2', '1'), judgment]));
    const renewal = { kind: 'evidence.renewal', judgment: 'J', original: 'E1', replacement: 'E2' } as unknown as BaseRecord;
    throwsCode(() => m.write({ op: 'renew', payload: 1 }, (tx) => appendRecords(tx, [renewal])), 'RENEWAL_REFUSED');
    // The reviewer's repro: E2's exit changed to 0 in place, its stored hash kept; a later write; a fresh open (structure intact).
    const row = m.stmt("SELECT rev, record FROM log WHERE kind = 'evidence' AND json_extract(record, '$.evidence') = 'E2'").get() as { rev: number; record: string };
    const altered = JSON.parse(row.record) as { fields: Record<string, string> };
    altered.fields.exit = '0';
    m.connection.prepare('UPDATE log SET record = ? WHERE rev = ?').run(JSON.stringify(altered), row.rev);
    m.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    m = w.reopen();
    assert.equal(m.status().chainBroken, null, 'the cheap gate does not hash the middle of the log');
    throwsCode(() => m.write({ op: 'renew', payload: 1 }, (tx) => appendRecords(tx, [renewal])), 'CHAIN_BROKEN', /never used/);
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'evidence.renewal'").get()!.n, 0);
    assert.equal(m.status().chainBroken?.brokenAt, Number(row.rev), 'the break is recorded');
    throwsCode(() => m.write({}, (tx) => setMission(tx, M, 'closed')), 'CHAIN_BROKEN');
  } finally {
    w.cleanup();
  }
  // A read for a decision outside a write records the break too.
  const v = project();
  try {
    const plan = (o: string) => ({ kind: 'object.version', object: o, objectKind: 'plan', mission: M, module: null, content: v.m.data.put(`body ${o}`), prerequisites: v.m.data.putList([]), scope: { paths: ['p.md'], taskType: 'plan' }, reviews: [{ review: 'r', basisLines: [], reliesOn: [] }] }) as unknown as BaseRecord;
    v.m.write({ op: 'p', payload: 1 }, (tx) => appendRecords(tx, [plan('A'), plan('B')]));
    v.m.write({ op: 'q', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    v.m.connection.prepare(`UPDATE log SET record = replace(record, '"plan"', '"product"') WHERE kind = 'object.version' AND json_extract(record, '$.object') = 'A'`).run();
    throwsCode(() => v.m.read((db) => factById(db, 'object.version', 'A')), 'CHAIN_BROKEN');
    throwsCode(() => recordsByKind(v.m, { kinds: ['object.version'] }), 'CHAIN_BROKEN');
    assert.notEqual(v.m.status().chainBroken, null);
  } finally {
    v.cleanup();
  }
});

test('review round 2: the transaction mark is 0 or 1, and its stored value is what the hash covers', () => {
  const w = project();
  try {
    for (let i = 1; i <= 3; i++) w.m.write({ op: `b${i}`, payload: i }, (tx) => appendRecords(tx, [basis(i)]));
    const mid = Number(w.m.stmt("SELECT rev FROM log WHERE op = 'b2' AND kind = 'basis.version'").get()!.rev);
    assert.throws(() => w.m.connection.prepare('UPDATE log SET txn_end = 2 WHERE rev = ?').run(mid), /CHECK constraint/);
    w.m.connection.exec('PRAGMA ignore_check_constraints = ON');
    w.m.connection.prepare('UPDATE log SET txn_end = 2 WHERE rev = ?').run(mid);
    const rep = verifyChain(w.m);
    assert.deepEqual([rep.ok, rep.brokenAt], [false, mid]);
    assert.match(rep.reason!, /invalid transaction mark/);
  } finally {
    w.cleanup();
  }
});

test('review round 4: a break seen while the database is busy is never forgotten: marker first, refused writes, a reopen too, until the PM recovers', () => {
  const cases = [
    ['read', 'begin'],
    ['read', 'commit'],
    ['direct-read', 'begin'],
    ['direct-read', 'commit'],
    ['write', 'commit'],
  ] as const;
  for (const [mode, blocked] of cases) {
    const w = project({ busyTimeoutMs: 80 });
    try {
      let { m } = w;
      m.write({ op: 'inputs', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
      m.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
      m.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
      // The reviewer's repro: another connection blocks the recording's BEGIN (a writer) or its COMMIT (a reader).
      const other = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
      if (blocked === 'begin') other.exec('BEGIN IMMEDIATE');
      else {
        other.exec('BEGIN DEFERRED');
        other.prepare('SELECT COUNT(*) FROM log').get();
      }
      let caught = '';
      const inspect = (db: Parameters<typeof recordsByKind>[0]): void => {
        try {
          recordsByKind(db, { kinds: ['basis.version'] });
        } catch (e) {
          caught = (e as { code?: string }).code ?? '';
        }
      };
      try {
        if (mode === 'read') m.read((db) => inspect(db));
        else if (mode === 'direct-read') inspect(m);
        else m.write({ op: 'inspect', payload: 1 }, (tx) => (inspect(tx), setMission(tx, id<MissionId>('m2'), 'open')));
      } catch {
        /* the write refuses to commit */
      }
      other.exec('ROLLBACK');
      other.close();
      const label = `${mode}, ${blocked} blocked`;
      assert.equal(caught, 'CHAIN_BROKEN', label);
      assert.equal(m.getMeta('chain_broken'), null, `${label}: the database could not record it`);
      assert.ok(m.readMarker() !== null, `${label}: the marker holds it`);
      assert.notEqual(m.status().chainBroken, null, label);
      throwsCode(() => m.write({ op: 'next', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open')), 'CHAIN_BROKEN');
      m = w.reopen({ busyTimeoutMs: 80 });
      throwsCode(() => m.write({ op: 'after-reopen', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m4'), 'open')), 'CHAIN_BROKEN');
      assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op IN ('inspect', 'next', 'after-reopen')").get()!.n, 0, `${label}: no write answered after the break`);
      // The PM recovers: only then is the break forgotten.
      const out = m.continueFromLastValid();
      assert.ok(out.removed > 0, label);
      assert.equal(m.readMarker(), null);
      assert.equal(m.status().chainBroken, null);
      m.write({ op: 'next', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open'));
    } finally {
      w.cleanup();
    }
  }
});

test('review round 4: a break that neither the marker nor the database could record is reported, even when the caller caught the error', () => {
  const w = project({ busyTimeoutMs: 80 });
  try {
    const { m } = w;
    m.write({ op: 'inputs', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    m.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    m.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    // The marker cannot be written (its folder is read-only) and the database is busy.
    const locks = join(w.dir, '.mission-pipeline', 'locks');
    chmodSync(locks, 0o555);
    const other = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
    other.exec('BEGIN IMMEDIATE');
    try {
      throwsCode(
        () =>
          m.read((db) => {
            try {
              recordsByKind(db, { kinds: ['basis.version'] });
            } catch {
              /* caught by the caller */
            }
            return null;
          }),
        'CHAIN_BROKEN',
        /could not be recorded/,
      );
    } finally {
      other.exec('ROLLBACK');
      other.close();
      chmodSync(locks, 0o755);
    }
    // This process still refuses every write; the next write records the break in the database.
    throwsCode(() => m.write({ op: 'next', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open')), 'CHAIN_BROKEN');
    assert.notEqual(m.getMeta('chain_broken'), null);
  } finally {
    w.cleanup();
  }
});

test('review round 5 #1: a rebuild that found damage cannot commit, even when the caller caught its error', () => {
  const w = project();
  try {
    const { m } = w;
    m.write({ op: 'queue', payload: 1 }, (tx) => queueTask(tx, { task: 'T', lineage: 'L', mission: M, card: tx.data.put('spec') }));
    m.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    m.write({ op: 'stop', payload: 1, stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
    m.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    m.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    // The reviewer's repro: the rebuild's CHAIN_BROKEN caught inside the write.
    let caught = '';
    throwsCode(
      () =>
        m.write({ op: 'rebuild-caught', payload: 1 }, (tx) => {
          try {
            rebuildState(tx, m.extensions);
          } catch (e) {
            caught = (e as { code?: string }).code ?? '';
          }
          return null;
        }),
      'CHAIN_BROKEN',
    );
    assert.equal(caught, 'CHAIN_BROKEN');
    assert.equal(m.stmt('SELECT COUNT(*) AS n FROM stops').get()!.n, 1, 'the stop stays: the partial rebuild was rolled back');
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'rebuild-caught'").get()!.n, 0);
    assert.ok(m.readMarker() !== null && m.getMeta('chain_broken') !== null, 'the break is marked and recorded');
    throwsCode(() => m.write({ op: 'claim', payload: 1 }, (tx) => claimDispatch(tx, { dispatch: 'D', task: 'T', seat: 'reviewer' })), 'CHAIN_BROKEN');
  } finally {
    w.cleanup();
  }
});

test('review round 5 #2: a write in progress in another process does not commit once a break was marked; a recovery elsewhere lets this process write again', async () => {
  const w = project({ busyTimeoutMs: 5000 });
  try {
    const { m } = w;
    m.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    m.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    m.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    // The reviewer's two-process repro: the writer holds its transaction; this process finds the damage meanwhile.
    const held = join(w.dir, 'writer-held');
    const writer = child({ action: 'write-until-marker', project: w.dir, held });
    while (!existsSync(held)) await new Promise((r) => setTimeout(r, 10));
    let caught = '';
    m.read((db) => {
      try {
        recordsByKind(db, { kinds: ['basis.version'] });
      } catch (e) {
        caught = (e as { code?: string }).code ?? '';
      }
    });
    assert.equal(caught, 'CHAIN_BROKEN');
    assert.deepEqual(childJson(await writer.line), { result: 'CHAIN_BROKEN', receipt: 0 }, 'the other process’s write was refused at its commit');
    await writer.exit;
    // Another process (here: a second connection) recovers; this one, latched, may write again afterwards.
    const other = openMemory(w.dir, { git: null });
    try {
      assert.ok(other.continueFromLastValid().removed > 0);
    } finally {
      other.close();
    }
    assert.equal(m.readMarker(), null);
    m.write({ op: 'after', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open'));
  } finally {
    w.cleanup();
  }
});

test('review round 6 #1: a recovery removes only the reports it handled; a latched process unlatches only on its own clean verification', () => {
  const w = project();
  try {
    const a = w.m;
    a.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    a.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    a.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    assert.equal(a.verifyChain().ok, false, 'the first damage, latched in a');
    // The reviewer's repro: right after the recovery's commit (before it cleans up), new damage that it did not handle.
    const b = openMemory(w.dir, { git: null });
    const maintenance = b.maintenance.bind(b);
    let seen = '';
    b.maintenance = ((fn: Parameters<typeof b.maintenance>[0], opts: Parameters<typeof b.maintenance>[1]) => {
      const out = maintenance(fn, opts);
      b.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'memory.init'").run();
      a.read((db) => {
        try {
          recordsByKind(db, { kinds: ['memory.init'] });
        } catch (e) {
          seen = (e as { code?: string }).code ?? '';
        }
      });
      return out;
    }) as typeof b.maintenance;
    try {
      b.continueFromLastValid();
    } finally {
      b.close();
    }
    assert.equal(seen, 'CHAIN_BROKEN');
    assert.ok(a.readMarker() !== null, 'the newer report stays');
    throwsCode(() => a.write({ op: 'after-second-damage', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open')), 'CHAIN_BROKEN');
    assert.equal(a.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'after-second-damage'").get()!.n, 0);
    assert.equal(verifyChain(a).ok, false);
  } finally {
    w.cleanup();
  }
  // Without new damage: once another process recovered, the latched process verifies for itself and writes again.
  const v = project();
  try {
    const a = v.m;
    a.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    a.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    a.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    assert.equal(a.verifyChain().ok, false);
    const b = openMemory(v.dir, { git: null });
    try {
      b.continueFromLastValid();
    } finally {
      b.close();
    }
    assert.equal(a.readMarker(), null);
    a.write({ op: 'after', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open'));
  } finally {
    v.cleanup();
  }
});

test('review round 6 #2: every verification that finds damage inside a write, maintenance included, keeps it from committing', () => {
  for (const how of ['Memory.verifyChain', 'verifyChain(tx)', 'walkChain(tx)'] as const) {
    const w = project();
    try {
      const { m } = w;
      m.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
      m.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
      m.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
      const head = m.head();
      let seen = false;
      let damaged: string | null = null;
      // The reviewer's repro: a maintenance write that verified, saw ok:false, and wrote anyway.
      throwsCode(
        () =>
          m.maintenance((tx) => {
            const report = how === 'Memory.verifyChain' ? m.verifyChain() : how === 'verifyChain(tx)' ? verifyChain(tx) : walkChain(tx);
            seen = !report.ok;
            damaged = tx.damaged;
            return setMission(tx, id<MissionId>('m2'), 'open');
          }),
        'CHAIN_BROKEN',
      );
      assert.equal(seen, true, how);
      assert.notEqual(damaged, null, `${how}: the write knows it saw damage`);
      assert.equal(m.head(), head, `${how}: nothing committed`);
      assert.notEqual(m.status().chainBroken, null);
      // The recovery's own verification still works.
      assert.ok(m.continueFromLastValid().removed > 0);
      m.write({ op: 'after', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open'));
    } finally {
      w.cleanup();
    }
  }
});

function markers(dir: string): string[] {
  return readdirSync(join(dir, '.mission-pipeline', 'locks')).filter((n) => /^chain-broken-.*\.json$/.test(n));
}

test('review round 7 #1: damage the unlatch check finds is notified like any other: a new marker, even when the database is busy', () => {
  const w = project({ busyTimeoutMs: 80 });
  try {
    const a = w.m;
    a.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    a.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    a.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    assert.equal(a.verifyChain().ok, false, 'a latched');
    const b = openMemory(w.dir, { git: null });
    try {
      b.continueFromLastValid();
    } finally {
      b.close();
    }
    assert.deepEqual(markers(w.dir), [], 'the recovery removed the marker it handled');
    // The reviewer's repro: new damage after the recovery; a reader blocks the database record.
    a.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'memory.init'").run();
    const holder = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
    holder.exec('BEGIN DEFERRED');
    holder.prepare('SELECT COUNT(*) FROM log').get();
    try {
      throwsCode(() => a.write({ op: 'latched-process', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m2'), 'open')), 'CHAIN_BROKEN');
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    assert.equal(markers(w.dir).length, 1, 'the new damage is marked');
    const c = openMemory(w.dir, { git: null });
    try {
      throwsCode(() => c.write({ op: 'new-process', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open')), 'CHAIN_BROKEN');
      assert.equal(c.stmt("SELECT COUNT(*) AS n FROM ops WHERE op IN ('latched-process', 'new-process')").get()!.n, 0);
    } finally {
      c.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review round 7 #2: every detection gets its own marker, so a recovery never removes a newer one with the same reason and revision', () => {
  const w = project({ busyTimeoutMs: 80 });
  try {
    const a = w.m;
    a.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    a.connection.prepare('UPDATE log SET committed_at = committed_at + 1 WHERE rev = 1').run();
    assert.equal(a.verifyChain().ok, false);
    const first = a.readMarker()!;
    // The reviewer's repro: right after the recovery's commit, its new event 1 is damaged too (the same reason, the same revision).
    const b = openMemory(w.dir, { git: null, busyTimeoutMs: 80 });
    const maintenance = b.maintenance.bind(b);
    const holder = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
    let seen = '';
    b.maintenance = ((fn: Parameters<typeof b.maintenance>[0], opts: Parameters<typeof b.maintenance>[1]) => {
      const out = maintenance(fn, opts);
      maintenance((tx) => setMission(tx, id<MissionId>('m2'), 'open'));
      b.connection.prepare('UPDATE log SET committed_at = committed_at + 1 WHERE rev = 1').run();
      holder.exec('BEGIN DEFERRED');
      holder.prepare('SELECT COUNT(*) FROM log').get();
      a.read((db) => {
        try {
          recordsByKind(db, { kinds: ['memory.truncated'] });
        } catch (e) {
          seen = (e as { code?: string }).code ?? '';
        }
      });
      return out;
    }) as typeof b.maintenance;
    try {
      b.continueFromLastValid();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
      b.close();
    }
    assert.equal(seen, 'CHAIN_BROKEN');
    const left = a.readMarker();
    assert.ok(left !== null && left.id !== first.id, 'the newer marker stays');
    const c = openMemory(w.dir, { git: null });
    try {
      throwsCode(() => c.write({ op: 'after-new-break', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m3'), 'open')), 'CHAIN_BROKEN');
      assert.equal(c.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'after-new-break'").get()!.n, 0);
    } finally {
      c.close();
    }
  } finally {
    w.cleanup();
  }
});

test('review round 7 #3: markers that cannot be listed fail closed: writes are refused, saying why', () => {
  const w = project({ busyTimeoutMs: 80 });
  const locks = join(w.dir, '.mission-pipeline', 'locks');
  try {
    const a = w.m;
    a.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    a.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    a.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    // The reviewer's repro: the break marked while the database is busy, then the folder made unlistable.
    const holder = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
    holder.exec('BEGIN IMMEDIATE');
    a.read((db) => {
      try {
        recordsByKind(db, { kinds: ['basis.version'] });
      } catch {
        /* caught */
      }
    });
    holder.exec('ROLLBACK');
    holder.close();
    assert.equal(a.getMeta('chain_broken'), null);
    chmodSync(locks, 0o300);
    const c = openMemory(w.dir, { git: null });
    try {
      throwsCode(() => c.write({ op: 'after-permission-error', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m2'), 'open')), 'CHAIN_BROKEN', /cannot be listed/);
      assert.match(c.status().chainBroken?.reason ?? '', /cannot be listed/);
      assert.equal(c.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'after-permission-error'").get()!.n, 0);
    } finally {
      chmodSync(locks, 0o755);
      c.close();
    }
  } finally {
    chmodSync(locks, 0o755);
    w.cleanup();
  }
});

test('review round 8: an old persistence error never keeps a new detection from being marked (Memory.verifyChain notifies inside its read)', () => {
  const w = project({ busyTimeoutMs: 80 });
  const locks = join(w.dir, '.mission-pipeline', 'locks');
  const holder = new DatabaseSync(join(w.dir, '.mission-pipeline', 'memory.db'));
  try {
    const a = w.m;
    a.write({ op: 'basis', payload: 1 }, (tx) => appendRecords(tx, [basis(1)]));
    a.write({ op: 'tail', payload: 1 }, (tx) => setMission(tx, M, 'open'));
    a.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'basis.version'").run();
    // The reviewer's repro: the first damage could be recorded neither in a marker (read-only folder) nor in the database (busy).
    holder.exec('BEGIN IMMEDIATE');
    chmodSync(locks, 0o555);
    throwsCode(() => a.read((db) => recordsByKind(db, { kinds: ['basis.version'] })), 'CHAIN_BROKEN');
    chmodSync(locks, 0o755);
    holder.exec('ROLLBACK');
    const b = openMemory(w.dir, { git: null, busyTimeoutMs: 80 });
    try {
      b.continueFromLastValid();
    } finally {
      b.close();
    }
    // New damage, found by a's verifyChain while a reader blocks the database record.
    a.connection.prepare("UPDATE log SET committed_at = committed_at + 1 WHERE kind = 'memory.init'").run();
    holder.exec('BEGIN DEFERRED');
    holder.prepare('SELECT COUNT(*) FROM log').get();
    try {
      assert.equal(a.verifyChain().ok, false);
    } finally {
      holder.exec('ROLLBACK');
    }
    assert.equal(markers(w.dir).length, 1, 'the new damage is marked');
    const c = openMemory(w.dir, { git: null, busyTimeoutMs: 80 });
    try {
      throwsCode(() => c.write({ op: 'after-unreported-break', payload: 1 }, (tx) => setMission(tx, id<MissionId>('m2'), 'open')), 'CHAIN_BROKEN');
      assert.equal(c.stmt("SELECT COUNT(*) AS n FROM ops WHERE op = 'after-unreported-break'").get()!.n, 0);
    } finally {
      c.close();
    }
  } finally {
    chmodSync(locks, 0o755);
    holder.close();
    w.cleanup();
  }
});
