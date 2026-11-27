// 4.4 (F17): one copy of a card. A claim writes the card's text to its leaf only; the stored response
// of the dispatch and the recorded result of `mp sec card` name the leaf and its hash. A concurrent
// claim with the same operation id, and a retry of `mp sec card` with the same --op, read the card from
// its leaf; responses and results recorded by 4.3 carry the text and still read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../src/common/hash.ts';
import { beginAction, endAction } from '../src/cli/project.ts';
import { claimDispatch, dispatchLeaf, pmAction } from '../src/memory/index.ts';
import type { MissionId } from '../src/common/ids.ts';
import { openProcess } from '../src/process/context.ts';
import { pmDispatch, pmNext, storedCard } from '../src/process/pm.ts';
import { ENV_A, processProject, startAddMission } from './process-fixtures.ts';
import { project43, command43, done43, live43, escalation43 } from './p43-fixtures.ts';

async function readyCalibrator(p: ReturnType<typeof processProject>): Promise<string> {
  await startAddMission(p.ctx, 'm1');
  return (await pmNext(p.ctx)).ready.find((r) => r.kind === 'calibrator-1')!.step;
}

test('F17: a dispatch stores its card once, in the leaf; its stored response names the leaf and the hash', async () => {
  const p = processProject();
  try {
    const step = await readyCalibrator(p);
    const d = pmDispatch(p.ctx, step);
    const op = `dispatch:${step}:1`;
    const stored = JSON.parse((p.ctx.memory.stmt('SELECT response FROM ops WHERE op = ?').get(op) as { response: string }).response) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored).sort(), ['cardLeaf', 'cardSha256', 'dispatch', 'worktree'], '4.3 stored the card text in the response');
    assert.equal(stored['cardSha256'], sha256(d.card));
    const receipt = JSON.parse((p.ctx.memory.stmt("SELECT record FROM log WHERE kind = 'op.receipt' AND json_extract(record, '$.op') = ?").get(op) as { record: string }).record) as { response: string };
    assert.equal((JSON.parse(receipt.response) as { card?: string }).card, undefined);
    assert.equal(p.ctx.memory.readLeaf(d.cardLeaf)?.text, d.card);
    assert.equal(d.cardSha256, sha256(d.card));
  } finally {
    p.cleanup();
  }
});

test('F17: a concurrent claim with the same operation id reads the stored response back and still returns the card', async () => {
  const p = processProject();
  const other = openProcess(p.dir, { observe: () => ENV_A, ident: { name: 'mp test', email: 'mp@test' } });
  try {
    const step = await readyCalibrator(p);
    const seen: { first: ReturnType<typeof pmDispatch> | null } = { first: null };
    // the other process claims the same step while this one has read the dispatch count but not written yet
    const write = other.memory.write.bind(other.memory);
    (other.memory as { write: typeof write }).write = ((req: Parameters<typeof write>[0], fn: Parameters<typeof write>[1]) => {
      if (seen.first === null && typeof req.op === 'string' && req.op.startsWith('dispatch:')) seen.first = pmDispatch(p.ctx, step);
      return write(req, fn);
    }) as typeof write;
    const second = pmDispatch(other, step);
    const first = seen.first!;
    assert.ok(first !== null);
    assert.equal(second.dispatch, first.dispatch, 'the same claim');
    assert.equal(second.card, first.card);
    assert.equal(second.cardSha256, first.cardSha256);
  } finally {
    other.memory.close();
    p.cleanup();
  }
});

test('F17 compatibility: a claim retried across the upgrade gets its card from the response 4.3 stored', async () => {
  const p = processProject();
  try {
    const step = await readyCalibrator(p);
    const write = p.ctx.memory.write.bind(p.ctx.memory);
    let once = false;
    (p.ctx.memory as { write: typeof write }).write = ((req: Parameters<typeof write>[0], fn: Parameters<typeof write>[1]) => {
      if (!once && typeof req.op === 'string' && req.op.startsWith('dispatch:')) {
        once = true;
        // what 4.3 committed under this operation id and payload: the response carries the card's text
        write({ op: req.op, payload: req.payload, command: 'dispatch', filler: null }, (tx) => {
          claimDispatch(tx, { dispatch: 'D-1', task: step, seat: 'calibrator-1', card: 'the card as 4.3 rendered it' });
          return { dispatch: 'D-1', card: 'the card as 4.3 rendered it', cardLeaf: dispatchLeaf('m1' as MissionId, 'D-1', 'card'), worktree: null };
        });
      }
      return write(req, fn);
    }) as typeof write;
    const d = pmDispatch(p.ctx, step);
    assert.equal(d.dispatch, 'D-1', 'the same operation, no conflict');
    assert.equal(d.card, 'the card as 4.3 rendered it');
    assert.equal(d.cardSha256, sha256(d.card));
  } finally {
    p.cleanup();
  }
});

test('F17 compatibility: a stored response of 4.3 carries the text and still reads; a changed leaf is refused', () => {
  const p = processProject();
  try {
    assert.equal(storedCard(p.ctx, { dispatch: 'D-1', cardLeaf: 'missions/m1/dispatches/D-1/card.md', card: 'the card as 4.3 stored it', worktree: null }), 'the card as 4.3 stored it');
    assert.throws(() => storedCard(p.ctx, { dispatch: 'D-9', cardLeaf: 'missions/m1/dispatches/D-9/card.md', cardSha256: sha256('x'), worktree: null }), /missing/);
  } finally {
    p.cleanup();
  }
});

test('F17: the recorded result of mp sec card names the leaf and the hash; a retry prints the card from its leaf; a 4.3 result still replays', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    const r = await done43(p, ['sec', 'card', 'choice', '--op', 'card-once'], id);
    assert.match(r.card, /choice/);
    const action = p.ctx.memory.read((db) => pmAction(db, 'card-once'))!;
    const recorded = JSON.parse(p.ctx.memory.data.text(action.result!)) as { text: string; json: Record<string, unknown> };
    assert.equal(recorded.json['card'], undefined, '4.3 recorded the card text twice');
    assert.equal(recorded.json['cardSha256'], sha256(r.card));
    assert.equal(recorded.text, `card ${r.cardLeaf} (sha256 ${sha256(r.card)})`);
    const again = await command43(p, ['sec', 'card', 'choice', '--op', 'card-once'], id);
    assert.equal(again.replayed, true);
    assert.equal(again.result.card, r.card);
    // the 4.3 shape: the text inline in the recorded result
    const old = { op: 'card-43', command: 'sec card', args: { generation: id, args: { positionals: ['choice'], flags: {} } } };
    assert.equal(beginAction(p.ctx.memory, { ...old, filler: null }), null);
    endAction(p.ctx.memory, old, { exitCode: 0, text: 'the card as 4.3 recorded it', json: { dispatch: r.dispatch, card: 'the card as 4.3 recorded it', cardLeaf: r.cardLeaf } }, false);
    const replayed = await command43(p, ['sec', 'card', 'choice', '--op', 'card-43'], id);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.result.card, 'the card as 4.3 recorded it');
  } finally {
    p.cleanup();
  }
});
