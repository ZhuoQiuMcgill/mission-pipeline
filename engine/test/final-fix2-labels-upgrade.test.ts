import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { BaseRecord } from '../src/common/records.ts';
import { revision } from '../src/common/ids.ts';
import { runCli } from '../src/cli/main.ts';
import { currentEnvironment, decisionLabels, dependencyCycles, derivedState, drain, labelBatch, labelStatus, LABELS_EXTENSION, recompute, setLabelBatchLimit } from '../src/evaluator/index.ts';
import { fullCompute, type ResolvedRecord } from '../src/evaluator/semantics.ts';
import { LABEL_TABLES, metaGet, metaSet, projectRecord, resolveLists } from '../src/evaluator/store.ts';
import { openMemory, type Memory } from '../src/memory/index.ts';
import { builders, labelProject, Mirror, plainState, sameState } from './labels-fixtures.ts';
import { throwsCode } from './memory-fixtures.ts';

/** Rebuild the field stack's stored projection, admitting program judgments.
 * The log stays intact, with the actual executor; no upgrade marker remains.
 */
function stackIndex(m: Memory): void {
  m.maintenance((tx) => {
    for (const table of LABEL_TABLES) tx.stmt(`DELETE FROM ${table}`).run();
    for (const row of tx.stmt('SELECT rev, record FROM log ORDER BY rev').all() as Array<{ rev: number; record: string }>) {
      const rec = JSON.parse(row.record);
      const seeds = projectRecord(tx, rec.kind === 'judgment' ? { ...rec, executor: rec.executor === 'program' ? 'reviewer' : rec.executor } : rec, row.rev);
      for (const node of seeds) tx.stmt('INSERT OR IGNORE INTO lbl_work (node, queued, dirty, phase, cursor) VALUES (?, 1, 0, ?, NULL)').run(node, ['t', 'x', 'o'].includes(node.split(':')[0]!) ? 1 : 0);
    }
    metaSet(tx, 'rev', String(m.head()));
    // Let the current evaluator settle the old index before testing its upgrade.
    metaSet(tx, 'program-judgments-dropped', '1');
  });
  drain(m);
  m.maintenance((tx) => {
    tx.stmt("DELETE FROM lbl_meta WHERE key LIKE 'program-judgments%'").run();
  });
}

function append(mirror: Mirror, records: readonly (BaseRecord | Record<string, unknown>)[]): void {
  mirror.append(records.map((r) => resolveLists(mirror.m, r as BaseRecord) as ResolvedRecord));
}

const cliIo = (cwd: string) => ({ cwd, env: {}, process: { open: { git: null }, now: Date.now } });

function programRows(m: Memory): number {
  return Number(m.stmt("SELECT COUNT(*) AS n FROM lbl_judgments j JOIN log l ON j.rev = l.rev WHERE json_extract(l.record, '$.executor') = 'program'").get()!.n);
}

function snapshot(m: Memory): unknown {
  return LABEL_TABLES.map((table) => [table, m.stmt(`SELECT * FROM ${table}`).all().map((r) => JSON.stringify(r)).sort()]);
}

function judgmentRows(m: Memory): unknown {
  return m.stmt('SELECT * FROM lbl_judgments ORDER BY rev').all();
}

test('U1: a broken stack memory opens, reads recomputing, refuses writes, and exits through WI-29', async () => {
  const p = labelProject();
  try {
    const b = builders(p.m);
    append(new Mirror(p.m), [b.product('P'), { ...b.judge('JP', 'P'), executor: 'program' }]);
    p.m.write({}, (tx) => tx.append({ kind: 'mission.state', mission: 'm1' as never, state: 'open' }));
    stackIndex(p.m);
    const head = Number(p.m.head());
    p.m.connection.prepare('UPDATE log SET hash = ? WHERE rev = ?').run('0'.repeat(64), head);
    const m = p.reopen();
    assert.equal(programRows(m), 1, 'open leaves the old index intact');
    assert.equal(m.read(labelStatus).recomputing, true);
    assert.equal(m.read((db) => decisionLabels(db, ['P'])).P, 'recomputing');
    throwsCode(() => m.write({}, () => assert.fail('no decision runs')), 'CHAIN_BROKEN');
    for (const args of [['read', 'status', '--json'], ['pm', 'continue-from', String(head - 1), '--json']]) {
      const r = await runCli(args, cliIo(p.dir));
      assert.equal(r.exitCode, 0, r.stdout || r.stderr);
      if (args[0] === 'read') assert.match(r.stdout, /recomputing/);
    }
    const recovered = p.reopen();
    assert.equal(recovered.status().chainBroken, null);
    assert.equal(programRows(recovered), 0);
    assert.equal(metaGet(recovered, 'program-judgments-dropped'), '1');
    assert.equal(recovered.read(labelStatus).recomputing, false);
  } finally {
    p.cleanup();
  }
});

test('U2: open and stop do no upgrade; bounded batches allow one oversized removal and match fullCompute', async () => {
  const p = labelProject();
  try {
    const b = builders(p.m);
    const mirror = new Mirror(p.m);
    const evidence = Array.from({ length: 300 }, (_, i) => `E${i}`);
    append(mirror, [
      { kind: 'env.snapshot', line: 'env', snapshot: 's1' },
      ...evidence.map((e) => b.evidence(e, 's1', 'sampling', { timing: '1' })),
      ...Array.from({ length: 1500 }, (_, i) => [b.product(`P${i}`), { ...b.judge(`J${i}`, `P${i}`, i === 750 ? { evidence, fields: ['timing'] } : {}), ...(i === 750 ? { executor: 'program' } : {}) }]).flat(),
    ]);
    stackIndex(p.m);
    // Historical sampled citations are admission data and must survive removal.
    p.m.maintenance((tx) => { for (const e of evidence) tx.stmt('INSERT OR IGNORE INTO lbl_cites VALUES (?, ?)').run(e, 'J750'); });
    let began = 0;
    const m = p.reopen({ hooks: { afterBegin: () => { began++; } } });
    assert.equal(began, 0, 'opening a settled stack memory begins no transaction');
    const beforeStop = judgmentRows(m);
    const stop = await runCli(['pm', 'stop', 'Stop all work', '--scope', 'all', '--json'], cliIo(p.dir));
    assert.equal(stop.exitCode, 0, stop.stdout || stop.stderr);
    assert.equal(Number(m.stmt('SELECT COUNT(*) AS n FROM stops').get()!.n), 1);
    assert.deepEqual(judgmentRows(m), beforeStop);
    assert.equal(metaGet(m, 'program-judgments-from'), null);
    setLabelBatchLimit(256);
    let oversized = 0;
    let batches = 0;
    for (let r; (r = labelBatch(m)) !== null;) {
      assert.ok(++batches < 1000, 'the drain must finish');
      assert.ok(r.done || r.progress > 0);
      if (batches === 1) {
        const cursor = metaGet(m, 'program-judgments-from');
        assert.ok(Number(cursor) > 0, 'the upgrade has begun');
        const rows = judgmentRows(m);
        const stopped = await runCli(['pm', 'stop', 'Stop during the upgrade', '--scope', 'all', '--json'], cliIo(p.dir));
        assert.equal(stopped.exitCode, 0, stopped.stdout || stopped.stderr);
        assert.equal(Number(m.stmt('SELECT COUNT(*) AS n FROM stops').get()!.n), 2);
        assert.equal(metaGet(m, 'program-judgments-from'), cursor, 'a stop never advances the upgrade');
        assert.deepEqual(judgmentRows(m), rows);
      }
      if (r.oversized) {
        oversized++;
        assert.equal(r.progress, 1, 'an oversized removal is the lone first step');
        assert.ok(r.units > 256);
      } else assert.ok(r.units <= 256, JSON.stringify(r));
    }
    assert.ok(batches > 1);
    assert.equal(oversized, 1);
    assert.equal(programRows(m), 0);
    assert.equal(Number(m.stmt("SELECT COUNT(*) AS n FROM lbl_cites WHERE judgment = 'J750'").get()!.n), 300);
    sameState(m.read(derivedState), fullCompute(mirror.accepted, revision(Number(m.head()))));
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('U3: dependents, negation refolds and past-state continuations agree with fullCompute and recompute', () => {
  const p = labelProject();
  try {
    const b = builders(p.m);
    const mirror = new Mirror(p.m);
    append(mirror, [
      b.product('P'), { ...b.judge('JP', 'P'), executor: 'program' },
      b.product('D', { prereqs: ['P'] }), b.judge('JD', 'D'),
      b.product('A'), b.judge('FAIL', 'A', { verdict: 'fail' }),
      { ...b.judge('REVOKE', 'A'), executor: 'program', revokes: 'FAIL' }, b.judge('LATER', 'A'),
      { ...b.product('ACONT'), predecessor: 'A' }, { ...b.judge('PAST-STATE', 'ACONT'), extends: 'LATER' },
      { ...b.product('Q'), predecessor: 'P' }, { ...b.judge('CONT', 'Q'), extends: 'JP' },
      // A continuation reads the earlier position state even when its current
      // deciding judgment is a seat judgment unaffected by the removal.
      b.product('R'), { ...b.judge('PAST', 'R'), executor: 'program' },
      { ...b.product('S'), predecessor: 'R' }, { ...b.judge('HIST', 'S'), extends: 'PAST' }, b.judge('NOW', 'R'),
      b.product('C'), { ...b.judge('CYCLE', 'C', { reliesOn: ['C'] }), executor: 'program' },
    ]);
    stackIndex(p.m);
    assert.equal(p.m.read((db) => decisionLabels(db, ['D'])).D, 'recomputing');
    assert.equal(p.m.read(labelStatus).recomputing, true);
    drain(p.m);
    const state = p.m.read(derivedState);
    assert.equal(state.targets.get('D')?.label, 'not-fully-proven');
    assert.equal(state.targets.get('A')?.label, 'negated');
    assert.equal(state.judgmentCurrent.get('CONT' as never), false);
    assert.equal(state.judgmentCurrent.get('HIST' as never), false);
    assert.equal(state.judgmentCurrent.get('PAST-STATE' as never), false, 'continuations of retained judgments also see their refolded past state');
    assert.deepEqual(p.m.read(dependencyCycles), [], 'cycles containing a removed judgment disappear');
    assert.ok(p.m.stmt("SELECT 1 FROM lbl_edges WHERE src = 'j:JP' AND dst = 'j:CONT'").get(), 'a continuation owns its incoming edge');
    assert.equal(p.m.stmt("SELECT 1 FROM lbl_edges WHERE src = 'j:JP' AND dst = 'e:P'").get(), undefined);
    assert.equal(p.m.stmt("SELECT 1 FROM lbl_edges WHERE src = 'p:C' AND dst = 'j:CYCLE'").get(), undefined);
    assert.deepEqual({ ...p.m.stmt("SELECT state, decided_by FROM lbl_judgments WHERE judgment = 'LATER'").get() }, { state: 'fail', decided_by: 'FAIL' });
    sameState(state, fullCompute(mirror.accepted, revision(Number(p.m.head()))));
    const rows = judgmentRows(p.m);
    recompute(p.m);
    assert.deepEqual(plainState(p.m.read(derivedState)), plainState(state));
    assert.deepEqual(judgmentRows(p.m), rows);
    assert.equal(metaGet(p.m, 'program-judgments-dropped'), '1');
    p.m.rebuild();
    assert.deepEqual(plainState(p.m.read(derivedState)), plainState(state));
    assert.equal(metaGet(p.m, 'program-judgments-dropped'), '1');
    const moved = p.reopen({ machine: 'upgrade-test/other-machine' });
    assert.deepEqual(plainState(moved.read(derivedState)), plainState(state));
    assert.equal(metaGet(moved, 'program-judgments-dropped'), '1');
  } finally {
    p.cleanup();
  }
});

test('U4: two opens leave the index; alternating batches share a monotonic stored cursor', () => {
  const p = labelProject();
  let other: Memory | undefined;
  try {
    currentEnvironment(p.m, { observe: () => ({ os: 'upgrade-test', osVersion: '1', arch: 'x64', versions: {} }) });
    const b = builders(p.m);
    append(new Mirror(p.m), Array.from({ length: 800 }, (_, i) => [b.product(`P${i}`), { ...b.judge(`J${i}`, `P${i}`), ...([0, 399, 799].includes(i) ? { executor: 'program' } : {}) }]).flat());
    stackIndex(p.m);
    let began = 0;
    const m = p.reopen({ hooks: { afterBegin: () => { began++; } } });
    other = openMemory(p.dir, { git: null, extensions: [LABELS_EXTENSION], hooks: { afterBegin: () => { began++; } } });
    assert.equal(began, 0, 'concurrent opens repeat no work');
    assert.equal(programRows(m), 3);
    setLabelBatchLimit(256);
    throwsCode(() => m.maintenance((tx) => LABELS_EXTENSION.gateProof!(tx, { opId: 'upgrade-decision' })), 'RECOMPUTING', /program judgments from before 4\.1\.1 \(U-24\)/);
    assert.equal(programRows(m), 3, 'a refused decision leaves no partial upgrade');
    let cursor = 0;
    let removed = 0;
    for (let i = 0; i < 100; i++) {
      const r = labelBatch(i % 2 === 0 ? m : other);
      const next = Number(metaGet(m, 'program-judgments-from') ?? 0);
      assert.ok(next >= cursor, `${cursor} -> ${next}`);
      cursor = next;
      const count = 3 - programRows(m);
      assert.ok(count >= removed);
      removed = count;
      if (r === null || r.done) break;
      assert.ok(r.progress > 0);
    }
    assert.equal(removed, 3);
    assert.equal(metaGet(other, 'program-judgments-dropped'), '1');
    assert.equal(labelBatch(m), null);
    assert.equal(labelBatch(other), null);
  } finally {
    other?.close();
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('U5: a process killed after removal but before commit loses removal, seeds and cursor together', () => {
  const p = labelProject();
  try {
    const b = builders(p.m);
    append(new Mirror(p.m), [b.product('P'), { ...b.judge('JP', 'P'), executor: 'program' }]);
    stackIndex(p.m);
    const before = snapshot(p.m);
    const code = String.raw`
      import { writeSync } from 'node:fs';
      import { openMemory } from ${JSON.stringify(new URL('../src/memory/index.ts', import.meta.url).href)};
      import { labelBatch } from ${JSON.stringify(new URL('../src/evaluator/index.ts', import.meta.url).href)};
      let m;
      m = openMemory(process.argv[1], { git: null, hooks: { beforeCommit() {
        writeSync(1, JSON.stringify({ cursor: m?.stmt("SELECT value FROM lbl_meta WHERE key = 'program-judgments-from'").get()?.value ?? null, rows: m?.stmt("SELECT COUNT(*) AS n FROM lbl_judgments").get().n ?? null }) + '\n');
        process.kill(process.pid, 'SIGKILL');
      } } });
      labelBatch(m);
    `;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code, p.dir], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.ok(child.stdout.trim(), 'the upgrade reached its pre-commit hook');
    const pending = JSON.parse(child.stdout.trim());
    assert.ok(Number(pending.cursor) > 0, 'the bounded step stored its cursor before the crash');
    assert.equal(pending.rows, 0);
    assert.deepEqual(snapshot(p.m), before, 'SQLite rolls the whole step back');
    assert.equal(programRows(p.m), 1);
    drain(p.m);
    assert.equal(programRows(p.m), 0);
    assert.equal(p.m.read(labelStatus).recomputing, false);
  } finally {
    p.cleanup();
  }
});

test('U6: a 4.1.0 index without program judgments scans once; an empty new index marks before catch-up', () => {
  const p = labelProject();
  const fresh = labelProject({ extensions: [] });
  try {
    const b = builders(p.m);
    append(new Mirror(p.m), [b.product('P'), b.judge('J', 'P')]);
    stackIndex(p.m);
    const before = plainState(p.m.read(derivedState));
    const r = labelBatch(p.m);
    assert.ok(r, 'the unmarked judgment index needs a first check');
    assert.equal(r.done, true);
    assert.equal(r.units, 2, 'one judgment plus the page step');
    assert.equal(metaGet(p.m, 'program-judgments-dropped'), '1');
    assert.equal(Number(p.m.stmt('SELECT COUNT(*) AS n FROM lbl_work').get()!.n), 0);
    assert.deepEqual(plainState(p.m.read(derivedState)), before);
    assert.equal(labelBatch(p.m), null);
    const f = builders(fresh.m);
    append(new Mirror(fresh.m), [f.product('NEW'), f.judge('NEWJ', 'NEW')]);
    const m = fresh.reopen({ extensions: [LABELS_EXTENSION] });
    assert.equal(metaGet(m, 'program-judgments-dropped'), null);
    assert.equal(labelBatch(m)?.done, true);
    assert.equal(metaGet(m, 'program-judgments-dropped'), '1');
    assert.equal(m.read((db) => decisionLabels(db, ['NEW'])).NEW, 'proven');
  } finally {
    p.cleanup();
    fresh.cleanup();
  }
});

test('U7: an edited executor inside the log leaves the upgrade undone, refuses proof and exits through WI-29; an intact twin completes', async () => {
  for (const variant of ['batch', 'gate', 'intact'] as const) {
    const p = labelProject();
    try {
      currentEnvironment(p.m, { observe: () => ({ os: 'upgrade-test', osVersion: '1', arch: 'x64', versions: {} }) });
      const b = builders(p.m);
      append(new Mirror(p.m), [b.product('P'), { ...b.judge('JP', 'P'), executor: 'program' }, b.pending('OP', ['P'])]);
      stackIndex(p.m);
      assert.equal(p.m.read(labelStatus).recomputing, true);
      const row = p.m.stmt("SELECT j.rev, l.record FROM lbl_judgments j JOIN log l ON l.rev = j.rev WHERE j.judgment = 'JP'").get() as { rev: number; record: string };
      assert.ok(Number(row.rev) < Number(p.m.head()), 'JP is an interior event: the open check does not hash it');
      if (variant !== 'intact') {
        // The stored hash stays: the record no longer matches it.
        p.m.connection.prepare('UPDATE log SET record = ? WHERE rev = ?').run(JSON.stringify({ ...JSON.parse(row.record), executor: 'reviewer' }), row.rev);
      }
      const m = p.reopen();
      currentEnvironment(m, { observe: () => ({ os: 'upgrade-test', osVersion: '1', arch: 'x64', versions: {} }) });
      assert.equal(m.status().chainBroken, null, 'opening checks only the tail');
      const decide = () => m.write({}, (tx) => {
        LABELS_EXTENSION.gateProof!(tx, { opId: 'OP' });
        tx.append({ kind: 'op.executed', op: 'OP', asOf: m.head() } as never);
      });
      if (variant === 'intact') {
        const r = labelBatch(m);
        assert.equal(r?.done, true);
        assert.equal(metaGet(m, 'program-judgments-dropped'), '1');
        assert.equal(programRows(m), 0);
        assert.notEqual(m.read((db) => decisionLabels(db, ['P'])).P, 'proven');
        throwsCode(decide, 'STALE_REQUEST', /not proven now: P/);
        continue;
      }
      if (variant === 'batch') throwsCode(() => labelBatch(m), 'CHAIN_BROKEN');
      throwsCode(decide, 'CHAIN_BROKEN');
      throwsCode(() => drain(m), 'CHAIN_BROKEN');
      assert.equal(Number(m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'op.executed'").get()!.n), 0, 'no decision was recorded');
      assert.equal(metaGet(m, 'program-judgments-dropped'), null, 'the upgrade is not marked done');
      assert.equal(metaGet(m, 'program-judgments-from'), null, 'the cursor never passed the damaged event');
      assert.equal(m.read(labelStatus).recomputing, true);
      assert.equal(m.read((db) => decisionLabels(db, ['P'])).P, 'recomputing');
      const broken = m.status().chainBroken;
      assert.equal(broken?.lastValid, Number(row.rev) - 1);
      throwsCode(() => recompute(m), 'CHAIN_BROKEN');
      const status = await runCli(['read', 'status', '--json'], cliIo(p.dir));
      assert.equal(status.exitCode, 0, status.stdout || status.stderr);
      assert.match(status.stdout, /CHAIN_BROKEN/);
      assert.match(status.stdout, /WI-29/);
      const recover = await runCli(['pm', 'continue-from', String(broken!.lastValid), '--json'], cliIo(p.dir));
      assert.equal(recover.exitCode, 0, recover.stdout || recover.stderr);
      const recovered = p.reopen();
      assert.equal(recovered.status().chainBroken, null);
      assert.equal(metaGet(recovered, 'program-judgments-dropped'), '1');
      assert.equal(recovered.read(labelStatus).recomputing, false);
      assert.notEqual(recovered.read((db) => decisionLabels(db, ['P'])).P, 'proven');
    } finally {
      p.cleanup();
    }
  }
});
