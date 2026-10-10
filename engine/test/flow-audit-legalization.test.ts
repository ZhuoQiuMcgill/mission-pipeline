// Legalization (design 11.1, 5.2 part 3, 6.1, 10.1): the plan visible before it starts, node
// backfills generation by generation, the chain-acceptance object and its Auditor, the stamp as a
// proof-conditioned operation; a broken link refused; a failed backfill; an old-engine boundary
// node; the stamp lost when only the chain evidence is revoked; a restart mid-way.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { BaseRecord, ReviewContract } from '../src/common/records.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { advanceLegalization, legalizationState, requestLegalization, startLegalization } from '../src/flow/audit/flow.ts';
import type { AuditChainCard, AuditChainResult, AuditNodeCard, AuditNodeResult } from '../src/seat/cards/auditor.ts';

const M = 'M1' as MissionId;

function setup() {
  const p = fakePorts();
  const c = p.ledger.content;
  const obj = (id: string, prereqs: string[], reviews: ReviewContract[]): BaseRecord => ({
    kind: 'object.version',
    object: id as never,
    objectKind: 'product',
    mission: M,
    module: null,
    content: c.put(`content of ${id}`),
    prerequisites: c.putList(prereqs),
    scope: { paths: [`src/${id.toLowerCase()}.ts`], taskType: 'code' },
    reviews,
  });
  const judgment = (j: string, target: string, verdict: 'pass' | 'fail', evidence: string[], bases: string[], reliesOn: string[]): BaseRecord => ({
    kind: 'judgment',
    judgment: j as never,
    review: 'reviewer',
    executor: 'reviewer',
    target: target as never,
    verdict,
    evidence: c.putList(evidence),
    bases: c.putList(bases),
    constraints: c.putList([]),
    reliesOn: c.putList(reliesOn),
    issues: [],
    revokes: null,
    evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
    superseded: [],
    extends: null,
  });
  const reviewer = (reliesOn: string[]): ReviewContract[] => [{ review: 'reviewer', basisLines: ['S1' as never], reliesOn: reliesOn as never }];
  // the text of S1 (a requirement item, as the requirement hub records it): Auditors judge it, never a placeholder
  void p.ledger.append('item-S1', {
    events: [
      {
        mission: M,
        line: 'requirements',
        event: 'item',
        key: 'S1.v1',
        body: { line: 'S1', version: 'S1.v1', type: 'acceptance', text: 'parses every header field', source: { kind: 'words', message: 'm1', quote: 'it must parse all the fields' }, restatement: null, confirmedBy: null, notifyCondition: null },
      },
    ],
  });
  return { ...p, c, obj, judgment, reviewer, ports: { ledger: p.ledger, scheduler: p.scheduler, evaluator: p.evaluator } };
}

const BASE = (c: { putList(x: readonly string[]): unknown }): BaseRecord[] => {
  void c;
  return [
    { kind: 'basis.version', basisKind: 'standard', line: 'S1' as never, version: 'S1.v1' as never, mission: M, scope: null },
    { kind: 'env.snapshot', line: 'env.t' as never, snapshot: 'snap.1' as never },
    { kind: 'evidence', evidence: 'ev.A' as never, envLine: 'env.t' as never, envSnapshot: 'snap.1' as never, runClass: 'closed', fields: { exit: '0' } },
    { kind: 'evidence', evidence: 'ev.seam' as never, envLine: 'env.t' as never, envSnapshot: 'snap.1' as never, runClass: 'closed', fields: { exit: '0', command: 'npm run integration' } },
  ];
};

function only(s: ReturnType<typeof setup>, kind: string): FlowTask {
  const q = s.scheduler.queued(kind);
  assert.equal(q.length, 1, `one queued ${kind}: ${q.map((t) => t.task).join(', ')}`);
  return q[0] as FlowTask;
}

function nodePass(card: AuditNodeCard, verdict: 'pass' | 'fail' = 'pass'): AuditNodeResult {
  return {
    positions: card.positions.map((p) => ({
      review: p.review,
      verdict,
      items: p.bases.map((b) => ({ basis: b.id, met: verdict === 'pass' ? ('yes' as const) : ('no' as const), reason: 'read the code', evidence: [`file:${card.target.paths[0] ?? 'src/x.ts'}:1`] })),
      constraints: p.constraints.map((k) => ({ constraint: k.id, paths: k.paths })),
    })),
    findings: verdict === 'fail' ? ['the parser drops the last field'] : [],
    summary: 'done',
  };
}

function chainPass(card: AuditChainCard, cite: string[] = ['evidence:ev.seam']): AuditChainResult {
  return {
    quotes: card.quotes.map((q) => ({ quote: q.id, honored: 'yes', reason: 'the endpoint does it', evidence: cite })),
    seams: card.seams.map((s) => ({ seam: s.id, holds: 'yes', reason: 'integration run', evidence: cite })),
    findings: [],
    verdict: 'pass',
  };
}

describe('legalization', () => {
  test('plan first; backfills generation by generation; chain object and Auditor; stamped; revoking only the chain evidence takes the stamp off', async () => {
    const s = setup();
    await s.ledger.append('setup', {
      records: [
        ...BASE(s.c),
        s.obj('A', [], s.reviewer([])),
        s.judgment('jA', 'A', 'pass', ['ev.A'], ['S1.v1'], []),
        s.obj('B', ['A'], s.reviewer(['A'])),
        s.obj('C', ['B'], s.reviewer(['B'])),
        s.judgment('jC', 'C', 'pass', [], ['S1.v1'], ['B']),
      ],
    });
    const before = await s.evaluator.labels(['A', 'B', 'C']);
    assert.deepEqual(before.labels, { A: 'proven', B: 'unaccepted', C: 'not-fully-proven' });

    const plan = await requestLegalization(s.ports, { legalization: 'L1', mission: M, endpoint: 'C', words: 'please legalize the parser', chainEvidence: ['ev.seam'], capabilities: [] });
    assert.deepEqual(plan.pending, ['B', 'C']);
    assert.deepEqual(plan.chain, ['A', 'B', 'C']);
    assert.equal(plan.seats, 3, 'one Auditor per pending node plus the chain Auditor, shown before it starts');
    const pn = s.ledger.notices.find((n) => n.category === 'legalization-plan');
    assert.equal(pn?.askUser, true);
    let r = await advanceLegalization(s.ports, M, 'L1');
    assert.equal(r.why, 'the user has not started it');
    assert.equal(s.scheduler.queued().length, 0, 'nothing starts before the user sees the plan');

    await startLegalization(s.ports, M, 'L1', 'go ahead');
    await advanceLegalization(s.ports, M, 'L1');
    // the top generation first: B (its parent A is proven); C waits
    const t1 = only(s, 'auditor-node');
    const card1 = t1.card as unknown as AuditNodeCard;
    assert.equal(card1.target.id, 'B');
    assert.deepEqual(card1.positions.map((p) => [p.review, p.reason]), [['reviewer', 'missing']]);
    assert.deepEqual(s.c.getList(card1.positions[0]?.binding.reliesOn as never), ['A']);
    assert.deepEqual(s.c.getList(card1.positions[0]?.binding.bases as never), ['S1.v1']);
    assert.deepEqual(s.scheduler.run(t1.task, { handBack: nodePass(card1) }), []);
    await advanceLegalization(s.ports, M, 'L1');

    // B proven made C's own judgment current again: C needs no backfill
    assert.equal(s.scheduler.queued('auditor-node').length, 0);
    const t2 = only(s, 'auditor-chain');
    const card2 = t2.card as unknown as AuditChainCard;
    assert.equal(card2.chain.object, 'chain.M1.L1');
    assert.deepEqual(card2.chain.nodes.map((n) => n.id), ['C', 'B', 'A'], 'endpoint first, then up the lineage');
    assert.equal(card2.seams.length, 2);
    assert.deepEqual(card2.evidence.map((e) => e.id), ['ev.seam']);
    const chainObj = (await s.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.object === 'chain.M1.L1');
    assert.equal(chainObj?.objectKind, 'chain-acceptance');
    assert.deepEqual(chainObj?.reviews.map((x) => [x.review, [...x.reliesOn]]), [['auditor-chain', ['A', 'B', 'C']]]);
    assert.deepEqual(s.scheduler.run(t2.task, { handBack: chainPass(card2) }), []);
    r = await advanceLegalization(s.ports, M, 'L1');
    assert.equal(r.state, 'ended');
    assert.equal(r.result?.outcome, 'stamped');
    assert.equal(r.result?.wi, null);
    const op = await s.evaluator.ops(['legal.M1.L1']);
    assert.equal(op.states['legal.M1.L1']?.allProven, true);
    assert.ok(op.states['legal.M1.L1']?.executedAsOf !== null);
    const judgments = (await s.ledger.records(['judgment'])).map((c) => c.record);
    assert.deepEqual(judgments.filter((j) => j.executor === 'auditor').map((j) => [j.target, j.review, j.verdict]), [
      ['B', 'reviewer', 'pass'],
      ['chain.M1.L1', 'auditor-chain', 'pass'],
    ]);
    assert.equal(s.ledger.notices.find((n) => n.category === 'legalization-stamped')?.wi, null);

    // only the chain evidence is revoked: the nodes stay proven, the chain object and the stamp do not
    await s.ledger.append('revoke-seam', { records: [{ kind: 'evidence.revoked', evidence: 'ev.seam' as never }] });
    const after = await s.evaluator.labels(['A', 'B', 'C', 'chain.M1.L1']);
    assert.deepEqual(after.labels, { A: 'proven', B: 'proven', C: 'proven', 'chain.M1.L1': 'not-fully-proven' });
    assert.equal((await s.evaluator.ops(['legal.M1.L1'])).states['legal.M1.L1']?.allProven, false);
  });

  test('a negated node on a required path: refused at the plan, with WI-25, and no Auditor starts', async () => {
    const s = setup();
    await s.ledger.append('setup', {
      records: [...BASE(s.c), s.obj('D', [], s.reviewer([])), s.judgment('jD', 'D', 'fail', [], ['S1.v1'], []), s.obj('E', ['D'], s.reviewer(['D'])), s.judgment('jE', 'E', 'pass', [], ['S1.v1'], ['D'])],
    });
    const plan = await requestLegalization(s.ports, { legalization: 'L2', mission: M, endpoint: 'E', words: 'legalize E', chainEvidence: [], capabilities: [] });
    assert.deepEqual(plan.blocked.map((b) => [b.id, b.label, b.path]), [['D', 'negated', ['E', 'D']]]);
    const r = await advanceLegalization(s.ports, M, 'L2');
    assert.equal(r.result?.outcome, 'refused');
    assert.equal(r.result?.wi, 'WI-25');
    const n = s.ledger.notices.find((x) => x.category === 'legalization-refused');
    assert.equal(n?.wi, 'WI-25');
    assert.equal(s.scheduler.queued().length, 0);
    await assert.rejects(() => startLegalization(s.ports, M, 'L2', 'go'), /already ended/);
  });

  test('a backfill that negates its node ends the legalization (WI-25); nothing is stamped', async () => {
    const s = setup();
    await s.ledger.append('setup', { records: [...BASE(s.c), s.obj('A', [], s.reviewer([])), s.judgment('jA', 'A', 'pass', ['ev.A'], ['S1.v1'], []), s.obj('B', ['A'], s.reviewer(['A']))] });
    await requestLegalization(s.ports, { legalization: 'L3', mission: M, endpoint: 'B', words: 'legalize B', chainEvidence: [], capabilities: [] });
    await startLegalization(s.ports, M, 'L3', 'go');
    await advanceLegalization(s.ports, M, 'L3');
    const t = only(s, 'auditor-node');
    assert.deepEqual(s.scheduler.run(t.task, { handBack: nodePass(t.card as unknown as AuditNodeCard, 'fail') }), []);
    const r = await advanceLegalization(s.ports, M, 'L3');
    assert.equal(r.result?.outcome, 'not-legalized');
    assert.equal(r.result?.wi, 'WI-25');
    assert.equal((await s.ledger.records(['op.pending'])).length, 0);
    assert.equal((await s.ledger.records(['issue'])).length, 1, 'the Auditor\'s finding is an issue record');
  });

  test('an old-engine boundary node (required review "auditor") is backfilled on that position; a pass refused when a basis is unmet', async () => {
    const s = setup();
    await s.ledger.append('setup', {
      records: [
        ...BASE(s.c),
        s.obj('OLD', [], [{ review: 'auditor', basisLines: [], reliesOn: [] }]),
        s.obj('P', ['OLD'], s.reviewer(['OLD'])),
        s.judgment('jP', 'P', 'pass', [], ['S1.v1'], ['OLD']),
      ],
    });
    await requestLegalization(s.ports, { legalization: 'L4', mission: M, endpoint: 'P', words: 'legalize P', chainEvidence: [], capabilities: [] });
    await startLegalization(s.ports, M, 'L4', 'go');
    await advanceLegalization(s.ports, M, 'L4');
    const t = only(s, 'auditor-node');
    const card = t.card as unknown as AuditNodeCard;
    assert.equal(card.target.boundary, true);
    assert.deepEqual(card.positions.map((p) => [p.review, p.reason]), [['auditor', 'missing']]);
    // the program's rule: a pass with a basis not met is refused
    const bad = nodePass(card);
    const first = bad.positions[0];
    if (first !== undefined && first.items[0] !== undefined) first.items[0] = { ...first.items[0], met: 'unclear' };
    assert.ok(s.scheduler.run(t.task, { handBack: bad }).some((p) => p.includes('"pass" leaves a basis')));
    assert.deepEqual(s.scheduler.run(t.task, { handBack: nodePass(card) }), []);
    await advanceLegalization(s.ports, M, 'L4');
    assert.deepEqual((await s.evaluator.labels(['OLD', 'P'])).labels, { OLD: 'proven', P: 'proven' });
    const tc = only(s, 'auditor-chain');
    assert.deepEqual(s.scheduler.run(tc.task, { handBack: chainPass(tc.card as unknown as AuditChainCard, ['file:src/p.ts:1']) }), []);
    const r = await advanceLegalization(s.ports, M, 'L4');
    assert.equal(r.result?.outcome, 'stamped');
  });

  test('the chain Auditor refuses: WI-25, and a new legalization makes a new chain object', async () => {
    const s = setup();
    await s.ledger.append('setup', { records: [...BASE(s.c), s.obj('A', [], s.reviewer([])), s.judgment('jA', 'A', 'pass', ['ev.A'], ['S1.v1'], [])] });
    await requestLegalization(s.ports, { legalization: 'L5', mission: M, endpoint: 'A', words: 'legalize A', chainEvidence: ['ev.seam'], capabilities: [] });
    await startLegalization(s.ports, M, 'L5', 'go');
    await advanceLegalization(s.ports, M, 'L5');
    const t = only(s, 'auditor-chain');
    const card = t.card as unknown as AuditChainCard;
    assert.deepEqual(card.seams, [], 'a one-node chain has no seams');
    const res = chainPass(card);
    assert.deepEqual(s.scheduler.run(t.task, { handBack: { ...res, quotes: res.quotes.map((q) => ({ ...q, honored: 'no' as const })), verdict: 'fail' } }), []);
    const r = await advanceLegalization(s.ports, M, 'L5');
    assert.equal(r.result?.outcome, 'chain-refused');
    assert.equal(r.result?.wi, 'WI-25');
    assert.equal((await s.evaluator.labels(['chain.M1.L5'])).labels['chain.M1.L5'], 'negated');
    await requestLegalization(s.ports, { legalization: 'L6', mission: M, endpoint: 'A', words: 'again', chainEvidence: ['ev.seam'], capabilities: [] });
    await startLegalization(s.ports, M, 'L6', 'go');
    await advanceLegalization(s.ports, M, 'L6');
    assert.equal((only(s, 'auditor-chain').card as unknown as AuditChainCard).chain.object, 'chain.M1.L6');
  });

  test('restart mid-legalization: a crash after submitting a task repeats nothing', async () => {
    const s = setup();
    await s.ledger.append('setup', { records: [...BASE(s.c), s.obj('A', [], s.reviewer([])), s.judgment('jA', 'A', 'pass', ['ev.A'], ['S1.v1'], []), s.obj('B', ['A'], s.reviewer(['A']))] });
    await requestLegalization(s.ports, { legalization: 'L7', mission: M, endpoint: 'B', words: 'legalize B', chainEvidence: [], capabilities: [] });
    await startLegalization(s.ports, M, 'L7', 'go');
    s.ledger.failNext = (op) => op.startsWith('aud:M1.L7:queue:');
    await assert.rejects(() => advanceLegalization(s.ports, M, 'L7'), /injected/);
    const tasks = [...s.scheduler.tasks.keys()];
    await advanceLegalization(s.ports, M, 'L7');
    assert.deepEqual([...s.scheduler.tasks.keys()], tasks);
    const st = await legalizationState(s.ports, M, 'L7');
    assert.equal(st.tasks.size, 1);
  });
});

describe('legalization: evidence the Auditor may cite', () => {
  test('a run that needs a rerun (its environment changed) is not offered to the node Auditor', async () => {
    const s = setup();
    await s.ledger.append('setup', {
      records: [...BASE(s.c), s.obj('A', [], s.reviewer([])), s.judgment('jA', 'A', 'pass', ['ev.A'], ['S1.v1'], [])],
    });
    // the environment moves on: ev.A needs a rerun, so A's judgment is not current
    await s.ledger.append('env-2', { records: [{ kind: 'env.snapshot', line: 'env.t' as never, snapshot: 'snap.2' as never }] });
    assert.equal((await s.evaluator.labels(['A'])).labels['A'], 'not-fully-proven');
    await requestLegalization(s.ports, { legalization: 'L8', mission: M, endpoint: 'A', words: 'legalize A', chainEvidence: [], capabilities: [] });
    await startLegalization(s.ports, M, 'L8', 'go');
    await advanceLegalization(s.ports, M, 'L8');
    const card = only(s, 'auditor-node').card as unknown as AuditNodeCard;
    assert.deepEqual(card.positions.map((p) => [p.review, p.reason, p.prior]), [['reviewer', 'not-current', 'jA']]);
    assert.deepEqual(card.evidence, [], 'ev.A no longer applies: citing it would leave the backfill not current');
  });
});

describe('legalization: a generation in parallel', () => {
  test('siblings of one generation each get their own Auditor at once', async () => {
    const s = setup();
    await s.ledger.append('setup', {
      records: [
        ...BASE(s.c),
        s.obj('A', [], s.reviewer([])),
        s.judgment('jA', 'A', 'pass', ['ev.A'], ['S1.v1'], []),
        s.obj('B1', ['A'], s.reviewer(['A'])),
        s.obj('B2', ['A'], s.reviewer(['A'])),
        s.obj('C', ['B1', 'B2'], s.reviewer(['B1', 'B2'])),
      ],
    });
    const plan = await requestLegalization(s.ports, { legalization: 'L9', mission: M, endpoint: 'C', words: 'legalize C', chainEvidence: [], capabilities: [] });
    assert.equal(plan.seats, 4);
    await startLegalization(s.ports, M, 'L9', 'go');
    const r = await advanceLegalization(s.ports, M, 'L9');
    assert.equal(r.why, 'node Auditors are running');
    const q = s.scheduler.queued('auditor-node').map((t) => (t.card as unknown as AuditNodeCard).target.id).sort();
    assert.deepEqual(q, ['B1', 'B2']);
    for (const t of s.scheduler.queued('auditor-node')) assert.deepEqual(s.scheduler.run(t.task, { handBack: nodePass(t.card as unknown as AuditNodeCard) }), []);
    await advanceLegalization(s.ports, M, 'L9');
    // C has no judgment of its own: it is the next generation
    const c = only(s, 'auditor-node').card as unknown as AuditNodeCard;
    assert.equal(c.target.id, 'C');
    assert.deepEqual(s.c.getList(c.positions[0]?.binding.reliesOn as never), ['B1', 'B2']);
  });
});

describe('legalization: a failed node Auditor', () => {
  test('goes to the Secretary; abandoned, the legalization ends with WI-25', async () => {
    const { answerEscalation } = await import('../src/flow/secretary.ts');
    const { SECRETARY_LINE } = await import('../src/flow/plandoc.ts');
    const s = setup();
    await s.ledger.append('setup', { records: [...BASE(s.c), s.obj('A', [], s.reviewer([])), s.judgment('jA', 'A', 'pass', ['ev.A'], ['S1.v1'], []), s.obj('B', ['A'], s.reviewer(['A']))] });
    await requestLegalization(s.ports, { legalization: 'L10', mission: M, endpoint: 'B', words: 'legalize B', chainEvidence: [], capabilities: [] });
    await startLegalization(s.ports, M, 'L10', 'go');
    await advanceLegalization(s.ports, M, 'L10');
    const t = only(s, 'auditor-node');
    s.scheduler.run(t.task, { fail: 'seat-failure' });
    let r = await advanceLegalization(s.ports, M, 'L10');
    assert.equal(r.state, 'waiting');
    const esc = (await s.ledger.events<{ id: string; source: string; subject: string }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).map((e) => e.body);
    assert.equal(esc[0]?.subject, 'audit:L10');
    await answerEscalation(s.ports, { mission: M, escalation: esc[0]?.id as string, option: 'abandon', words: 'stop' });
    r = await advanceLegalization(s.ports, M, 'L10');
    assert.equal(r.result?.outcome, 'not-legalized');
    assert.equal(r.result?.wi, 'WI-25');
  });
});
