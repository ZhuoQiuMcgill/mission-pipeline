// The tree reads credit a judgment only to the dispatch whose accepted hand-back committed it (design
// 4.1 §3.2, §8.4; code review r2): a release or a stop committed between a Reviewer's hand-back check
// and its write leaves that hand-back recorded and not accepted, with the judgment it carried never
// committed; the step is dispatched again and the new dispatch commits the judgment under the same
// id. `mp read why` on the product links the judgment to the new dispatch, never to the old one.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { forgetObservedEnvironment } from '../src/evaluator/index.ts';
import { appendRecords, claimDispatch, commitStop, initMemory, openMemory, queueTask, releaseDispatch, releaseStop, type WriteTx } from '../src/memory/index.ts';
import { processContext, recordSeatHandBack } from '../src/process/index.ts';
import { builders } from './labels-fixtures.ts';

const observe = () => ({ os: 'testos', osVersion: '1', arch: 'x64', versions: {} });

async function why(dir: string, id: string): Promise<{ nodes: Array<{ key: string; by: string | null }>; edges: Array<{ from: string; to: string; rel: string }> }> {
  forgetObservedEnvironment();
  const r = await runCli(['read', 'why', id, '--json'], { cwd: dir, env: {}, process: { observe, open: { git: null } } as never });
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  return (JSON.parse(r.stdout) as { result: { nodes: Array<{ key: string; by: string | null }>; edges: Array<{ from: string; to: string; rel: string }> } }).result;
}

/** The Reviewer's hand-back of D-old meets `between` after its check and before its write; then D-new hands back the same judgment J. */
async function lateHandBack(between: 'release' | 'stop'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mp-late-'));
  initMemory(dir, { git: null });
  forgetObservedEnvironment();
  for (const args of [['pm', 'mission', 'open', 'm1'], ['pm', 'say', 'Build this product']]) await runCli(args, { cwd: dir, env: {}, process: { observe, open: { git: null } } as never });
  forgetObservedEnvironment();
  await runCli(['pm', 'requirement', 'add', 'm1', 'g', '--type', 'goal', '--text', 'Build this product', '--quote', 'Build this product', '--words', 'W-1'], { cwd: dir, env: {}, process: { observe, open: { git: null } } as never });
  const m = openMemory(dir, { git: null });
  try {
    forgetObservedEnvironment();
    const ctx = processContext(m, { observe });
    const env = ctx.environment().identity;
    const b = builders(m);
    let spec = '';
    m.write({}, (tx) => {
      appendRecords(tx, [b.basis('S', 'S.v1', 'standard'), b.product('P', { reviews: [{ review: 'reviewer', basisLines: ['item.m1.g'] }] }), b.evidence('E', env, 'declared', { status: 'completed', exit: '0', object: 'P' })]);
      const card = {
        seat: 'reviewer',
        target: 'P',
        review: 'reviewer',
        standards: [{ id: 'S.v1', text: 'S' }],
        materials: [],
        verificationRuns: [{ evidence: 'E', command: 'test', summary: 'passed' }],
        selfReportedGaps: [],
        openIssues: [],
        binding: { judgment: 'J', bases: tx.data.putList(['item.m1.g.v1', 'S.v1']), constraints: tx.data.putList([]), reliesOn: tx.data.putList([]), revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [] },
      };
      spec = tx.data.put(JSON.stringify({ format: 'mp41.task.v1', mission: 'm1', card, binds: ['P'] }));
      queueTask(tx, { task: 'review', lineage: 'review', mission: 'm1' as never, card: spec as never });
      claim(tx, 'D-old', spec);
    });
    const fields = { judgments: [{ standard: 'S.v1', met: 'yes', reason: 'checked', evidence: ['evidence:E'] }], gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' };
    const oldFields = { ...fields, verdict: 'rework', judgments: [{ standard: 'S.v1', met: 'no', reason: 'a gap', evidence: ['evidence:E'] }] };
    // the PM's release, or a stop, committed at the transaction boundary between the hand-back's check and its write
    const write = m.write.bind(m);
    let injected = false;
    (m as unknown as { write: typeof m.write }).write = ((req: Parameters<typeof m.write>[0], fn: Parameters<typeof m.write>[1]) => {
      if (req.op === 'handback:D-old' && !injected) {
        injected = true;
        if (between === 'release') write({ op: 'release-at-boundary', payload: {} }, (tx) => releaseDispatch(tx, { dispatch: 'D-old', how: 'ended' }));
        else write({ op: 'stop-at-boundary', payload: {}, stop: true }, (tx) => commitStop(tx, { stop: 'S1' as never, scope: { kind: 'mission', mission: 'm1' as never }, words: 'stop', at: 1 }));
      }
      return write(req, fn);
    }) as typeof m.write;
    const old = await recordSeatHandBack(ctx, 'D-old', { report: 'Old report: rework', fields: oldFields, advance: false });
    assert.equal(old.kind === 'recorded' ? old.outcome : old.kind, between === 'release' ? 'after-release' : 'after-stop');
    (m as unknown as { write: typeof m.write }).write = write;
    m.write({}, (tx) => {
      if (between === 'stop') {
        releaseStop(tx, 'S1' as never);
        queueTask(tx, { task: 'review', lineage: 'review', mission: 'm1' as never, card: spec as never });
      }
      claim(tx, 'D-new', spec);
    });
    const fresh = await recordSeatHandBack(ctx, 'D-new', { report: 'New report', fields, advance: false });
    assert.equal(fresh.kind === 'recorded' ? fresh.outcome : fresh.kind, 'accepted');
    m.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: 'm1', line: 'task:con', event: 'accepted', key: '1', body: tx.data.put(JSON.stringify({ product: 'P', judgment: 'J' })) } as never]));
  } finally {
    m.close();
  }
  return dir;
}

function claim(tx: WriteTx, dispatch: string, spec: string): void {
  claimDispatch(tx, { dispatch, task: 'review', seat: 'reviewer', filler: { harness: dispatch === 'D-old' ? 'old' : 'new', model: null } });
  appendRecords(tx, [{ kind: 'flow.event', mission: 'm1', line: `dispatch:${dispatch}`, event: 'claimed', key: '1', body: tx.data.put(JSON.stringify({ spec })) } as never]);
}

describe('mp read why credits a judgment to the accepted hand-back that committed it (code review r2)', () => {
  for (const between of ['release', 'stop'] as const) {
    it(`a ${between} between the old hand-back's check and its write; the step dispatched again`, async () => {
      const dir = await lateHandBack(between);
      try {
        const w = await why(dir, 'P');
        const keys = w.nodes.map((n) => n.key);
        assert.ok(keys.includes('judgment:J'));
        assert.ok(keys.includes('dispatch:D-new'), keys.join(', '));
        const fromJ = w.edges.filter((e) => e.from === 'judgment:J');
        assert.ok(fromJ.some((e) => e.to === 'dispatch:D-new' && e.rel === 'handed back by'), JSON.stringify(fromJ));
        assert.ok(!fromJ.some((e) => e.to === 'dispatch:D-old'), JSON.stringify(fromJ));
        assert.match(w.nodes.find((n) => n.key === 'judgment:J')!.by!, /dispatch D-new/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
