// Code review round 9, class B in the legalization (design 11.1; 4.1 §4.1): while the labels the
// legalization decides on are recomputing, it decides nothing (no end, no Auditor queued, no chain
// object, no node card): a temporary state is never written as a permanent result. Real process
// with git: the legalization runs in the flow engine (`mp pm next`), its Auditors are dispatched and
// hand back through `mp seat`.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { BaseRecord, ReviewContract } from '../src/common/records.ts';
import { decisionLabels, setLabelBatchLimit } from '../src/evaluator/index.ts';
import { legalizationState } from '../src/flow/audit/flow.ts';
import { pmLegalize, pmMission, pmNext, pmSay, pmStartLegalization } from '../src/process/index.ts';
import type { AuditChainCard, AuditChainResult, AuditNodeCard, AuditNodeResult } from '../src/seat/cards/auditor.ts';
import { drained, frontier, seedFanout, sweepThenClean } from './exploration-exits.ts';
import { processProject, step, type ProcessProject } from './process-fixtures.ts';

/** A chain A ← B: A proven (its judgment cites a declared run), B with no judgment (pending a backfill); S1 the standard both are judged against. */
async function chain(p: ProcessProject, m: string): Promise<void> {
  pmMission(p.ctx, m);
  const ports = p.ctx.ports();
  const c = ports.ledger.content;
  const obj = (id: string, prereqs: string[], reviews: ReviewContract[]): BaseRecord => ({
    kind: 'object.version',
    object: id as never,
    objectKind: 'interpretation',
    mission: m as MissionId,
    module: null,
    content: c.put(`the content of ${id}`),
    prerequisites: c.putList(prereqs),
    scope: { paths: ['README.md'], taskType: 'code' },
    reviews,
  });
  const reviewer = (reliesOn: string[]): ReviewContract[] => [{ review: 'reviewer', basisLines: [`S1.${m}` as never], reliesOn: reliesOn as never }];
  await ports.ledger.append(`item:${m}`, {
    events: [
      {
        mission: m as MissionId,
        line: 'requirements',
        event: 'item',
        key: `S1.${m}.v1`,
        body: { line: `S1.${m}`, version: `S1.${m}.v1`, type: 'acceptance', text: 'parses every header field', source: { kind: 'words', words: 'W-1', quote: 'it must parse all the fields' }, restatement: null, confirmedBy: null, notifyCondition: null },
      },
    ],
  });
  await ports.ledger.append(`setup:${m}`, {
    records: [
      { kind: 'basis.version', basisKind: 'standard', line: `S1.${m}` as never, version: `S1.${m}.v1` as never, mission: m as MissionId, scope: null },
      { kind: 'env.snapshot', line: `env.${m}` as never, snapshot: 'snap.1' as never },
      { kind: 'evidence', evidence: `ev.A.${m}` as never, envLine: `env.${m}` as never, envSnapshot: 'snap.1' as never, runClass: 'declared', fields: { exit: '0' } },
      { kind: 'evidence', evidence: `ev.seam.${m}` as never, envLine: `env.${m}` as never, envSnapshot: 'snap.1' as never, runClass: 'declared', fields: { exit: '0', command: 'npm run integration' } },
      obj(`A.${m}`, [], reviewer([])),
      {
        kind: 'judgment',
        judgment: `jA.${m}` as never,
        review: 'reviewer',
        executor: 'reviewer',
        target: `A.${m}` as never,
        verdict: 'pass',
        evidence: c.putList([`ev.A.${m}`]),
        bases: c.putList([`S1.${m}.v1`]),
        constraints: c.putList([]),
        reliesOn: c.putList([]),
        issues: [],
        revokes: null,
        evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
        superseded: [],
        extends: null,
      },
      obj(`B.${m}`, [`A.${m}`], reviewer([`A.${m}`])),
    ],
  });
  await seedFanout(p, m, 400);
  const labels = p.ctx.memory.read((db) => decisionLabels(db, [`A.${m}`, `B.${m}`]));
  assert.deepEqual(labels, { [`A.${m}`]: 'proven', [`B.${m}`]: 'unaccepted' });
}

const nodeResult = (card: AuditNodeCard, verdict: 'pass' | 'fail'): AuditNodeResult => ({
  positions: card.positions.map((p) => ({
    review: p.review,
    verdict,
    items: p.bases.map((b) => ({ basis: b.id, met: verdict === 'pass' ? ('yes' as const) : ('no' as const), reason: 'read it', evidence: ['file:README.md:1'] })),
    constraints: p.constraints.map((k) => ({ constraint: k.id, paths: k.paths })),
  })),
  findings: verdict === 'fail' ? ['the parser drops the last field'] : [],
  summary: 'done',
});
const chainResult = (card: AuditChainCard, m: string): AuditChainResult => ({
  quotes: card.quotes.map((q) => ({ quote: q.id, honored: 'yes', reason: 'the endpoint does it', evidence: [`evidence:ev.seam.${m}`] })),
  seams: card.seams.map((s) => ({ seam: s.id, holds: 'yes', reason: 'integration run', evidence: [`evidence:ev.seam.${m}`] })),
  findings: [],
  verdict: 'pass',
});
const queued = async (p: ProcessProject, kind: string): Promise<string[]> => (await pmNext(p.ctx)).ready.filter((r) => r.kind === kind).map((r) => r.step);

describe('legalization while the labels recompute: nothing is decided until they are current', () => {
  const ps: ProcessProject[] = [];
  after(() => {
    setLabelBatchLimit(null);
    sweepThenClean(ps);
  });

  it('started and backfilled while recomputing: no Auditor queued, no end; after the drain it goes on and is stamped', async () => {
    const p = processProject();
    ps.push(p);
    const m = 'm1';
    await chain(p, m);
    const w = pmSay(p.ctx, 'Please legalize the parser. (m1)').words;
    await pmLegalize(p.ctx, { legalization: 'L1', mission: m, endpoint: `B.${m}`, words: 'Please legalize the parser.', chainEvidence: [`ev.seam.${m}`], capabilities: [] });
    // the user starts it during a frontier: no node Auditor is queued while the labels recompute
    await frontier(p, m, 2);
    await pmStartLegalization(p.ctx, { mission: m, legalization: 'L1', words: w });
    assert.deepEqual(await queued(p, 'auditor-node'), []);
    assert.equal((await legalizationState(p.ctx.ports(), m as MissionId, 'L1')).result, null);
    drained(p);
    assert.equal((await queued(p, 'auditor-node')).length, 1, 'once current: the backfill of B');
    // the backfill finishes during another frontier: the legalization neither ends nor goes on
    await frontier(p, m, 3);
    await step(p.ctx, 'auditor-node', (c) => nodeResult(c as AuditNodeCard, 'pass'));
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    const during = await legalizationState(p.ctx.ports(), m as MissionId, 'L1');
    assert.equal(during.result, null, 'no end from a temporary state');
    assert.equal(during.chain, null, 'no chain object');
    assert.deepEqual(await queued(p, 'auditor-chain'), []);
    assert.deepEqual(await queued(p, 'auditor-node'), [], 'no Auditor for a node whose label only recomputes');
    // current again: B is proven by the backfill; the chain object and its Auditor; stamped
    drained(p);
    assert.equal(p.ctx.memory.read((db) => decisionLabels(db, [`B.${m}`]))[`B.${m}`], 'proven');
    await step(p.ctx, 'auditor-chain', (c) => chainResult(c as AuditChainCard, m));
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    const done = await legalizationState(p.ctx.ports(), m as MissionId, 'L1');
    assert.equal(done.result?.outcome, 'stamped', JSON.stringify(done.result));
  });

  it('a backfill that does not prove its node during recomputing: no end until the drain; then it ends not-legalized', async () => {
    const p = processProject();
    ps.push(p);
    const m = 'm2';
    await chain(p, m);
    const w = pmSay(p.ctx, 'Please legalize the parser. (m2)').words;
    await pmLegalize(p.ctx, { legalization: 'L2', mission: m, endpoint: `B.${m}`, words: 'Please legalize the parser.', chainEvidence: [`ev.seam.${m}`], capabilities: [] });
    await pmStartLegalization(p.ctx, { mission: m, legalization: 'L2', words: w });
    assert.equal((await queued(p, 'auditor-node')).length, 1);
    await frontier(p, m, 2);
    await step(p.ctx, 'auditor-node', (c) => nodeResult(c as AuditNodeCard, 'fail'));
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    assert.equal((await legalizationState(p.ctx.ports(), m as MissionId, 'L2')).result, null, 'no end while recomputing');
    assert.deepEqual(await queued(p, 'auditor-node'), []);
    drained(p);
    await pmNext(p.ctx);
    const done = await legalizationState(p.ctx.ports(), m as MissionId, 'L2');
    assert.equal(done.result?.outcome, 'not-legalized', JSON.stringify(done.result));
    assert.match(done.result?.why ?? '', /negated/);
    assert.equal(done.result?.wi, 'WI-25');
  });
});
