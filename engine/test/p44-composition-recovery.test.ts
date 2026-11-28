// 4.4 (F14, final review F3-5): the prerequisite closures a process keeps rest on the history of its object versions
// and proof units. A chain recovery (continue from the last valid event) reuses revisions: a closure kept before it
// is built again once another history reaches the same revision.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BaseRecord } from '../src/common/records.ts';
import type { MissionId } from '../src/common/ids.ts';
import { appendRecords, openMemory, setMission, type Memory } from '../src/memory/index.ts';
import { COMPOSITIONS } from '../src/process/actions.ts';
import { processProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;

function product(m: Memory, object: string, prerequisites: readonly string[]): number {
  m.write({}, (tx) => {
    const content = tx.data.put(`body ${object}`);
    appendRecords(tx, [{ kind: 'object.version', object, objectKind: 'product', mission: M, module: null, content, prerequisites: tx.data.putList([...prerequisites]), scope: { paths: [`${object}.txt`], taskType: 'implementation' }, reviews: [], source: { commit: 'a'.repeat(40), writeScope: [`${object}.txt`], transform: content } } as unknown as BaseRecord]);
  });
  return Number((m.stmt("SELECT MAX(rev) AS r FROM log WHERE kind = 'object.version'").get() as { r: number }).r);
}

/** One event that is no object version. */
const filler = (m: Memory, n: number): number => {
  m.write({}, (tx) => setMission(tx, `f${n}` as MissionId, 'open'));
  return Number(m.head());
};

test('F14 (F3-5): a closure kept before a chain recovery is built again when another history records the same revision', async () => {
  const p = processProject();
  let other: Memory | null = null;
  try {
    const m = p.ctx.memory;
    m.write({}, (tx) => setMission(tx, M, 'open'));
    product(m, 'pa', []);
    product(m, 'pb', []);
    const damaged = filler(m, 1);
    filler(m, 2);
    const n = product(m, 'pp', ['pa']);
    const actions = p.ctx.actions();
    let before = COMPOSITIONS.built;
    assert.deepEqual(await actions.composition(['pp']), ['pa', 'pp']);
    assert.deepEqual(await actions.composition(['pp']), ['pa', 'pp']);
    assert.equal(COMPOSITIONS.built - before, 1, 'kept while nothing is recorded');
    // another process finds the chain broken before pp and continues from the last valid event; pp is recorded
    // again, built on pb, at the same revision
    m.connection.prepare('UPDATE log SET committed_at = committed_at + 1 WHERE rev = ?').run(damaged);
    other = openMemory(p.dir, { git: null });
    const cut = other.continueFromLastValid();
    assert.ok(cut.removed > 0 && cut.kept < damaged);
    for (let i = 3; Number(other.head()) < n - 1; i++) filler(other, i);
    assert.equal(product(other, 'pp', ['pb']), n, 'the other history reaches the same revision');
    before = COMPOSITIONS.built;
    assert.deepEqual(await actions.composition(['pp']), ['pb', 'pp'], 'the closure of the history recorded now');
    assert.equal(COMPOSITIONS.built - before, 1, 'built again');
  } finally {
    other?.close();
    p.cleanup();
  }
});
