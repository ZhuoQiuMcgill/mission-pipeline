// 4.1.3 (P4 item 4, #33): a burst of dispatches does not fail spuriously. A dispatch write that ran
// over its work budget (OVER_BUDGET: waiting under load, not work) rolled back cleanly, so
// `mp pm dispatch` tries it once more by itself after a short random delay; a second OVER_BUDGET says
// that a plain retry is safe and that nothing was written. The budget itself is unchanged.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { LedgerError, listDispatches, type WriteTx } from '../src/memory/index.ts';
import { pmDispatch, pmNext } from '../src/process/index.ts';
import { processProject, startAddMission, type ProcessProject } from './process-fixtures.ts';

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

/** The memory's real budget check: the first `times` dispatch writes do more than 2 s of work (they wait), then roll back. */
function slowDispatchWrites(pp: ProcessProject, times: number): { readonly attempts: () => number } {
  const memory = pp.ctx.memory;
  const write = memory.write.bind(memory);
  let n = 0;
  (memory as { write: typeof memory.write }).write = ((req: Parameters<typeof memory.write>[0], fn: (tx: WriteTx) => unknown) => {
    if (typeof req.op !== 'string' || !req.op.startsWith('dispatch:')) return write(req, fn as never);
    n++;
    if (n > times) return write(req, fn as never);
    return write(req, ((tx: WriteTx) => {
      const out = fn(tx);
      const until = performance.now() + 2_100;
      while (performance.now() < until) {
        /* the wait a burst of dispatches causes */
      }
      return out;
    }) as never);
  }) as typeof memory.write;
  return { attempts: () => n };
}

async function ready(pp: ProcessProject): Promise<string> {
  await startAddMission(pp.ctx, 'm1');
  const s = (await pmNext(pp.ctx)).ready.find((r) => r.kind === 'calibrator-1');
  assert.ok(s !== undefined);
  return s.step;
}

describe('#33: mp pm dispatch retries its write once on OVER_BUDGET', () => {
  it('the first write runs over its budget and rolls back; the retry claims the step once', async () => {
    p = processProject();
    const step = await ready(p);
    const slow = slowDispatchWrites(p, 1);
    const d = pmDispatch(p.ctx, step);
    assert.equal(slow.attempts(), 2, 'tried twice');
    const dispatches = p.ctx.memory.read((db) => listDispatches(db, { task: step }));
    assert.deepEqual(dispatches.map((x) => x.dispatch), [d.dispatch], 'one dispatch, nothing left of the first attempt');
    assert.match(d.card, /card: dispatch D-1/);
  });

  it('a second OVER_BUDGET: refused, nothing written, and the message says a plain retry is safe; the retry then works', async () => {
    p = processProject();
    const step = await ready(p);
    const slow = slowDispatchWrites(p, 2);
    assert.throws(
      () => pmDispatch(p!.ctx, step),
      (e: unknown) => e instanceof LedgerError && e.code === 'OVER_BUDGET' && /nothing was written, and running the same command again is safe/.test(e.message),
    );
    assert.equal(slow.attempts(), 2, 'one retry, no more');
    assert.equal(p.ctx.memory.read((db) => listDispatches(db, { task: step })).length, 0, 'nothing was written');
    const d = pmDispatch(p.ctx, step);
    assert.equal(d.dispatch, 'D-1');
  });

  it('another refusal is not retried', async () => {
    p = processProject();
    const step = await ready(p);
    pmDispatch(p.ctx, step);
    const slow = slowDispatchWrites(p, 0);
    assert.throws(() => pmDispatch(p!.ctx, step), (e: unknown) => !(e instanceof LedgerError && e.code === 'OVER_BUDGET'));
    assert.ok(slow.attempts() <= 1);
  });
});
