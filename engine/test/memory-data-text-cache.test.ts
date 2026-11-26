// The texts DataStore.text keeps (src/memory/data.ts): a read after a write in the same process
// sees that write; parsed bodies are never shared between reads; only committed values are kept;
// get() still refuses a damaged row, and another DataStore (another process) reads afresh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id, type ContentHash, type MissionId } from '../src/common/ids.ts';
import { appendRecords, DataStore, setMission, type WriteTx } from '../src/memory/index.ts';
import { MemoryFlowLedger } from '../src/process/ports.ts';
import { project, throwsCode } from './memory-fixtures.ts';

const M = id<MissionId>('m1');

function appendEvent(tx: WriteTx, key: string, body: string): void {
  appendRecords(tx, [{ kind: 'flow.event', mission: M, line: 'probe', event: 'e', key, body: tx.data.put(body) as ContentHash }]);
}

test('text cache: flow events appended after a read are seen by the next read in the same process; bodies are parsed afresh', async () => {
  const w = project();
  try {
    const { m } = w;
    m.write({}, (tx) => setMission(tx, M, 'open'));
    m.write({}, (tx) => appendEvent(tx, 'a', '{"n":1}'));
    const ledger = new MemoryFlowLedger({ memory: m } as never);
    const first = await ledger.events<{ n: number }>({ mission: M });
    assert.deepEqual(first.map((e) => [e.key, e.body.n]), [['a', 1]]);
    // a new body, and the first body again (the same hash) under another key
    m.write({}, (tx) => {
      appendEvent(tx, 'b', '{"n":2}');
      appendEvent(tx, 'c', '{"n":1}');
    });
    const second = await ledger.events<{ n: number }>({ mission: M });
    assert.deepEqual(second.map((e) => [e.key, e.body.n]), [['a', 1], ['b', 2], ['c', 1]]);
    // a parsed body belongs to its caller: two events with one body get two objects, and changing one changes no later read
    assert.notEqual(second[0]!.body, second[2]!.body);
    (second[0]!.body as { n: number }).n = 99;
    const third = await ledger.events<{ n: number }>({ mission: M, line: 'probe', event: 'e' });
    assert.deepEqual(third.map((e) => [e.key, e.body.n]), [['a', 1], ['b', 2], ['c', 1]]);
  } finally {
    w.cleanup();
  }
});

test('text cache: only committed values are kept; get() still refuses a damaged row; another DataStore reads afresh', () => {
  const w = project();
  try {
    const { m } = w;
    // a value read inside a write that rolls back is not kept: afterwards it is missing, as before
    let lost = '' as ContentHash;
    assert.throws(
      () =>
        m.write({}, (tx) => {
          lost = tx.data.put('only in a rolled-back write') as ContentHash;
          assert.equal(tx.data.text(lost), 'only in a rolled-back write');
          throw new Error('roll back');
        }),
      /roll back/,
    );
    throwsCode(() => m.data.text(lost), 'CONTENT_MISSING', /not in the memory/);
    // a staged value is readable; committed with the record that names it; read again from the row
    m.write({}, (tx) => setMission(tx, M, 'open'));
    const h = m.data.put('{"v":"committed"}') as ContentHash;
    assert.equal(m.data.text(h), '{"v":"committed"}');
    m.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: M, line: 'probe', event: 'e', key: 'k', body: h }]));
    assert.equal(m.data.text(h), '{"v":"committed"}');
    assert.equal(m.data.text(h), '{"v":"committed"}');
    // damage after the text was read: get() (lists, record checks) still refuses the row; text() keeps
    // serving the value the hash names, checked against it when it was first read
    m.connection.prepare("UPDATE data SET body = CAST('tampered' AS BLOB) WHERE hash = ?").run(h);
    throwsCode(() => m.data.get(h), 'CONTENT_MISSING', /damaged/);
    assert.equal(m.data.text(h), '{"v":"committed"}');
    // a fresh DataStore (as in the next process) keeps nothing yet: it sees the damage
    const fresh = new DataStore({ db: m, inWrite: () => false });
    throwsCode(() => fresh.text(h), 'CONTENT_MISSING', /damaged/);
  } finally {
    w.cleanup();
  }
});
