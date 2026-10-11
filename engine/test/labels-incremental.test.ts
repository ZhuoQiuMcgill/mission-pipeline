// The stored labels equal the full recomputation (4.1 §4.1; 5.4, 5.5): random
// and realistic record streams appended to a project memory in random writes,
// with batches small enough that the frontier outlives writes and new records
// join it, compared with fullCompute whenever the frontier is drained. While
// work is left, every decision label reads "recomputing". A rebuild, a
// recompute, and an index caught up after writes made without the extension
// give the same labels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Revision } from '../src/common/ids.ts';
import { decisionLabels, derivedState, drain, labelBatch, labelStatus, LABELS_EXTENSION, recompute, setLabelBatchLimit } from '../src/evaluator/index.ts';
import { fullCompute, type ResolvedRecord } from '../src/evaluator/semantics.ts';
import { randomRecords, realisticRecords, rng } from './evaluator-fixtures.ts';
import { labelProject, Mirror, plainState, sameState } from './labels-fixtures.ts';

const LIMITS = [1, 3, 17, 60, 400, 20_000];

function check(seed: number, count: number, maxBatch: number, gen: (seed: number, count: number) => ResolvedRecord[]): void {
  const records = gen(seed, count);
  const r = rng(seed ^ 0x2545f491);
  const p = labelProject();
  const mirror = new Mirror(p.m);
  try {
    let i = 0;
    while (i < records.length) {
      setLabelBatchLimit(LIMITS[Math.floor(r() * LIMITS.length)]!);
      const size = 1 + Math.floor(r() * maxBatch);
      mirror.append(records.slice(i, i + size));
      i += size;
      const st = p.m.read((db) => labelStatus(db));
      if (st.recomputing) {
        // Every decision sees "recomputing", whatever its target.
        assert.deepEqual(Object.values(p.m.read((db) => decisionLabels(db, ['O1', 'U1', 'GHOST']))), ['recomputing', 'recomputing', 'recomputing']);
        if (r() < 0.5) labelBatch(p.m);
      }
      if (r() < 0.3 || i >= records.length) {
        try {
          mirror.state();
        } catch (e) {
          throw new Error(`seed ${seed}, after ${i} records: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
}

test('stored labels equal full recomputation: random streams, random writes and batch sizes', () => {
  for (let seed = 1; seed <= 60; seed++) check(seed, 80, 6, randomRecords);
});

test('stored labels equal full recomputation: realistic streams, random writes and batch sizes', () => {
  for (let seed = 2001; seed <= 2040; seed++) check(seed, 150, 10, realisticRecords);
});

test('stored labels equal full recomputation: one record per write, one unit per batch', () => {
  for (let seed = 501; seed <= 520; seed++) {
    const records = randomRecords(seed, 60);
    const p = labelProject();
    const mirror = new Mirror(p.m);
    setLabelBatchLimit(1);
    try {
      for (const rec of records) mirror.append([rec]);
      mirror.state();
    } finally {
      setLabelBatchLimit(null);
      p.cleanup();
    }
  }
});

test('a rebuild and a recompute give the stored labels back, row for row', () => {
  for (const seed of [7, 2003, 2011]) {
    const records = (seed > 2000 ? realisticRecords : randomRecords)(seed, 150);
    const p = labelProject();
    const mirror = new Mirror(p.m);
    try {
      for (let i = 0; i < records.length; i += 10) mirror.append(records.slice(i, i + 10));
      const before = plainState(mirror.state());
      p.m.rebuild();
      assert.deepEqual(plainState(p.m.read((db) => derivedState(db))), before, `seed ${seed}: rebuild`);
      assert.equal(p.m.read((db) => labelStatus(db)).recomputing, false);
      recompute(p.m);
      assert.deepEqual(plainState(p.m.read((db) => derivedState(db))), before, `seed ${seed}: recompute`);
      // Reopened from the file.
      const m = p.reopen();
      assert.deepEqual(plainState(m.read((db) => derivedState(db))), before, `seed ${seed}: reopened`);
    } finally {
      p.cleanup();
    }
  }
});

test('events written without the labels extension are indexed by a catch-up batch, in order; until then the labels read "recomputing"', () => {
  const records = realisticRecords(2024, 160);
  const p = labelProject();
  const mirror = new Mirror(p.m);
  try {
    mirror.append(records.slice(0, 60));
    mirror.state();
    // Another mp without the extension (or before it was installed) writes on.
    const bare = p.reopen({ extensions: [] });
    const other = new Mirror(bare);
    other.append(records.slice(60, 120));
    const m = p.reopen({ extensions: [LABELS_EXTENSION] });
    const st = m.read((db) => labelStatus(db));
    assert.equal(st.recomputing, true);
    assert.ok(st.head > st.revision, 'the labels reflect an older revision than the head');
    assert.equal(m.read((db) => decisionLabels(db, ['O1'])).O1, 'recomputing');
    // The next write catches up first (its beforeWrite batch), then goes on.
    const again = new Mirror(m);
    again.append(records.slice(120));
    drain(m);
    const all = [...mirror.accepted, ...other.accepted, ...again.accepted];
    const at = all.at(-1)!.revision as Revision;
    sameState(m.read((db) => derivedState(db)), fullCompute(all, at), ' after the catch-up');
    assert.equal(m.read((db) => labelStatus(db)).revision, m.read((db) => labelStatus(db)).head);
  } finally {
    p.cleanup();
  }
});

test('the stored frontier is resumed by every later write: small batches, interleaved writes, the same final state', () => {
  const records = realisticRecords(2077, 200);
  const p = labelProject();
  const mirror = new Mirror(p.m);
  setLabelBatchLimit(5);
  try {
    for (let i = 0; i < records.length; i += 4) mirror.append(records.slice(i, i + 4));
    // Each write did at most a few units of its own propagation and one batch before it: work is left.
    assert.equal(p.m.read((db) => labelStatus(db)).recomputing, true);
    const d = drain(p.m);
    assert.ok(d.batches > 1, `drained in ${d.batches} batches`);
    assert.equal(d.status.recomputing, false);
    sameState(p.m.read((db) => derivedState(db)), fullCompute(mirror.accepted, mirror.accepted.at(-1)!.revision as Revision));
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});
