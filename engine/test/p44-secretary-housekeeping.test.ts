// 4.4 (F19): smaller items after an upgrade. `mp pm secretary stop --idle` retires a generation with no
// stop when no mission is open and nothing is in flight; `mp sec handbook` before `mp sec session` says
// to run the session first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashJson } from '../src/common/hash.ts';
import { liveSecretary } from '../src/memory/resident.ts';
import { project43, command43, done43, live43, escalation43 } from './p43-fixtures.ts';

test('F19: mp sec handbook before mp sec session says to run the session first', async () => {
  const p = project43();
  try {
    const g = await done43(p, ['pm', 'secretary', 'start']);
    assert.match(g.prompt, /Run mp sec session first; then read your handbook \(mp sec handbook\)/);
    const early = await command43(p, ['sec', 'handbook'], g.generation);
    assert.equal(early.error.code, 'NOT_ALLOWED');
    assert.match(early.error.message, /S-1 is pending: run mp sec session first/, '4.3 said only that the generation cannot operate');
    await done43(p, ['sec', 'session', '--filled-by', 'harness/secretary'], g.generation);
    assert.match((await done43(p, ['sec', 'handbook'], g.generation)).path, /SECRETARY\.md$/);
  } finally {
    p.cleanup();
  }
});

test('F19: mp pm secretary stop --idle retires a generation only when no mission is open and nothing is in flight', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    const d = await done43(p, ['sec', 'card', 'choice'], id);
    const open = await command43(p, ['pm', 'secretary', 'stop', '--idle']);
    assert.equal(open.error.code, 'NOT_ALLOWED');
    assert.match(open.error.message, /open: m1; in flight or not confirmed ended: D-1/);
    assert.equal((await command43(p, ['pm', 'secretary', 'stop'])).error.code, 'NOT_ALLOWED', 'without --idle the stop grace applies as before');
    const words = await done43(p, ['pm', 'say', 'Close this mission', '--tag', 'instruction']);
    await done43(p, ['pm', 'close', 'm1', '--words', words.words]);
    assert.match((await command43(p, ['pm', 'secretary', 'stop', '--idle'])).error.message, /open: none; in flight or not confirmed ended: D-1/);
    await done43(p, ['sec', 'release', d.dispatch, '--ended'], id);
    const r = await done43(p, ['pm', 'secretary', 'stop', '--idle']);
    assert.equal(r.generation, id);
    assert.match(r.stopHint, /nothing was in flight/);
    assert.equal(liveSecretary(p.ctx.memory), null);
    assert.equal((await command43(p, ['pm', 'next'])).code, 0, 'the 4.2 loop is available again');
  } finally {
    p.cleanup();
  }
});

test('F19 compatibility: without --idle the stop writes the payload 4.3 wrote, so a 4.3 operation retried under 4.4 replays', async () => {
  const p = project43();
  try {
    await live43(p);
    await done43(p, ['pm', 'secretary', 'stop', '--gone', '--op', 'stop-43']);
    const receipt = JSON.parse((p.ctx.memory.stmt("SELECT record FROM log WHERE kind = 'op.receipt' AND json_extract(record, '$.op') = 'secretary:stop:stop-43'").get() as { record: string }).record) as { payloadHash: string };
    assert.equal(receipt.payloadHash, hashJson({ op: 'stop-43', gone: true }));
    assert.equal((await command43(p, ['pm', 'secretary', 'stop', '--gone', '--op', 'stop-43'])).replayed, true);
  } finally {
    p.cleanup();
  }
});
