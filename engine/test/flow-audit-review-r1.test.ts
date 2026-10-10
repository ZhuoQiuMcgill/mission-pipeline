// Regression tests for the code review r1 of the flows, legalization findings: #3 the Auditor
// reviews the bound content (the product's commit, the current basis texts, a unit's members, the
// chain's products); #4 no seam is dropped; #5 the stamp is executed with its result in one
// transaction and the PM is told only after; #17 legalization ids are per mission. Each follows
// the reviewer's repro (scratch/review-more.ts auditWorld).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { advanceLegalization, legalizationState, requestLegalization, startLegalization } from '../src/flow/audit/flow.ts';
import type { AuditChainCard, AuditChainResult, AuditNodeCard, AuditNodeResult } from '../src/seat/cards/auditor.ts';

const M = 'M1' as MissionId;
const COMMIT = (i: number): string => String(i % 10).repeat(40);

/** A chain of `count` products: P0 relies on P1..P(count-1); every product but P0 has a current pass. */
async function auditWorld(count: number, o: { readonly withText?: boolean; readonly mission?: MissionId } = {}) {
  const mission = o.mission ?? M;
  const p = fakePorts();
  const c = p.ledger.content;
  const recs: BaseRecord[] = [{ kind: 'basis.version', basisKind: 'standard', line: 'std.task.S1' as never, version: 'std.task.S1.v1' as never, mission, scope: null }];
  for (let i = 0; i < count; i++) {
    const id = `P${i}`;
    const parents = i === 0 ? Array.from({ length: count - 1 }, (_, k) => `P${k + 1}`) : [];
    recs.push({
      kind: 'object.version',
      object: id as never,
      objectKind: 'product',
      mission,
      module: null,
      content: c.put(`git tree manifest of ${id}`),
      prerequisites: c.putList(parents),
      scope: { paths: [`src/product${i}.ts`], taskType: 'code' },
      reviews: [{ review: 'reviewer', basisLines: ['std.task.S1' as never], reliesOn: parents as never }],
      source: { commit: COMMIT(i) as never, writeScope: [`src/product${i}.ts`], transform: 'b'.repeat(64) as never },
    });
    if (i > 0)
      recs.push({
        kind: 'judgment',
        judgment: `j${i}` as never,
        target: id as never,
        review: 'reviewer',
        executor: 'reviewer',
        verdict: 'pass',
        bases: c.putList(['std.task.S1.v1']),
        constraints: c.putList([]),
        reliesOn: c.putList([]),
        evidence: c.putList([]),
        issues: [],
        revokes: null,
        extends: null,
        evidenceUse: { fields: [], statisticalOrExternal: false },
        superseded: [],
      });
  }
  await p.ledger.append('audit-setup', { records: recs });
  if (o.withText !== false) {
    // the standard's text, as the requirement hub records an acceptance item
    await p.ledger.append('item-S1', {
      events: [
        {
          mission,
          line: 'requirements',
          event: 'item',
          key: 'std.task.S1.v1',
          body: { line: 'std.task.S1', version: 'std.task.S1.v1', type: 'acceptance', text: 'every product passes its tests', source: { kind: 'words', message: 'm1', quote: 'all tests pass' }, restatement: null, confirmedBy: null, notifyCondition: null },
        },
      ],
    });
  }
  const snapshots: Array<{ purpose: string; commit?: string; products?: readonly string[] }> = [];
  p.scheduler.actions.snapshot = async (req) => {
    snapshots.push({ purpose: req.purpose, ...(req.commit !== undefined ? { commit: req.commit } : {}), ...(req.products !== undefined ? { products: req.products } : {}) });
    return { path: `/fake/snapshots/${req.purpose}`, commit: req.commit ?? 'c'.repeat(40) };
  };
  const ports = { ledger: p.ledger, scheduler: p.scheduler, evaluator: p.evaluator };
  await requestLegalization(ports, { legalization: 'L1', mission, endpoint: 'P0', words: 'legalize', chainEvidence: [], capabilities: [] });
  await startLegalization(ports, mission, 'L1', 'go');
  await advanceLegalization(ports, mission, 'L1');
  return { ...p, ports, snapshots, mission };
}

const nodePass = (card: AuditNodeCard): AuditNodeResult => ({
  positions: card.positions.map((x) => ({ review: x.review, verdict: 'pass', items: x.bases.map((b) => ({ basis: b.id, met: 'yes', reason: 'checked', evidence: [`file:${card.target.paths[0]}:1`] })), constraints: x.constraints.map((k) => ({ constraint: k.id, paths: k.paths })) })),
  findings: [],
  summary: 'checked',
});
const chainPass = (card: AuditChainCard, seams = card.seams): AuditChainResult => ({
  quotes: card.quotes.map((q) => ({ quote: q.id, honored: 'yes', reason: 'checked', evidence: ['file:src/product0.ts:1'] })),
  seams: seams.map((s) => ({ seam: s.id, holds: 'yes', reason: 'checked', evidence: ['file:src/product0.ts:1'] })),
  findings: [],
  verdict: 'pass',
});

describe('review r1 #3: the Auditor reviews the bound content', () => {
  test('the node Auditor reads the product at its own commit, with the standard\'s text and the task\'s rerun commands', async () => {
    const p = await auditWorld(2);
    const t = p.scheduler.queued('auditor-node')[0];
    assert.ok(t);
    const card = t.card as unknown as AuditNodeCard;
    assert.equal(card.target.id, 'P0');
    const snap = p.snapshots.find((x) => x.purpose === card.workspace.snapshot.split('/').at(-1));
    assert.deepEqual(snap, { purpose: snap?.purpose, commit: COMMIT(0) }, 'the snapshot is the product version itself, not the base');
    assert.match(card.positions[0]?.bases[0]?.text ?? '', /every product passes its tests/);
    assert.doesNotMatch(card.positions[0]?.bases[0]?.text ?? '', /^basis /);
    assert.deepEqual(card.materials, [], 'a product\'s tree manifest is not offered as its content');
  });

  test('a basis whose text is not recorded: no placeholder card; the legalization ends with WI-25', async () => {
    const p = await auditWorld(2, { withText: false });
    assert.equal(p.scheduler.queued('auditor-node').length, 0);
    const r = await advanceLegalization(p.ports, M, 'L1');
    assert.equal(r.result?.outcome, 'not-legalized');
    assert.equal(r.result?.wi, 'WI-25');
    assert.match(r.result?.why ?? '', /std\.task\.S1 .* not recorded/);
  });

  test('the chain Auditor reads every product of the chain laid over the endpoint\'s commit', async () => {
    const p = await auditWorld(3);
    const t = p.scheduler.queued('auditor-node')[0] as NonNullable<ReturnType<typeof p.scheduler.queued>[0]>;
    assert.deepEqual(p.scheduler.run(t.task, { handBack: nodePass(t.card as unknown as AuditNodeCard) }), []);
    await advanceLegalization(p.ports, M, 'L1');
    const chain = p.scheduler.queued('auditor-chain')[0]?.card as unknown as AuditChainCard;
    const snap = p.snapshots.find((x) => x.purpose.endsWith('-chain'));
    assert.equal(snap?.commit, COMMIT(0));
    assert.deepEqual([...(snap?.products ?? [])].sort(), ['P0', 'P1', 'P2']);
    assert.equal(chain.workspace.snapshot, `/fake/snapshots/${snap?.purpose}`);
  });
});

describe('review r1 #4: no seam is dropped', () => {
  test('62 required seams: all on the card, the complete table must-read; a hand-back answering 60 is refused', async () => {
    const p = await auditWorld(63);
    let t = p.scheduler.queued('auditor-node')[0] as NonNullable<ReturnType<typeof p.scheduler.queued>[0]>;
    assert.deepEqual(p.scheduler.run(t.task, { handBack: nodePass(t.card as unknown as AuditNodeCard) }), []);
    await advanceLegalization(p.ports, M, 'L1');
    t = p.scheduler.queued('auditor-chain')[0] as NonNullable<ReturnType<typeof p.scheduler.queued>[0]>;
    const chain = t.card as unknown as AuditChainCard;
    assert.equal(chain.seams.length, 62);
    const table = chain.materials.find((m) => m.id === 'seams');
    assert.equal(table?.mustRead, true);
    assert.equal(p.ledger.content.get(table?.ref as string).split('\n').length, 62);
    const partial = p.scheduler.run(t.task, { handBack: chainPass(chain, chain.seams.slice(0, 60)) });
    assert.ok(partial.some((x) => x.includes('"seam-61" is answered 0 times')), partial.join('; '));
    assert.deepEqual(p.scheduler.run(t.task, { handBack: chainPass(chain) }), []);
    const r = await advanceLegalization(p.ports, M, 'L1');
    assert.equal(r.result?.outcome, 'stamped');
  });
});

describe('review r1 #5: the stamp and its result are one transaction; the PM is told after', () => {
  async function chained() {
    const p = await auditWorld(2);
    const t = p.scheduler.queued('auditor-node')[0] as NonNullable<ReturnType<typeof p.scheduler.queued>[0]>;
    assert.deepEqual(p.scheduler.run(t.task, { handBack: nodePass(t.card as unknown as AuditNodeCard) }), []);
    await advanceLegalization(p.ports, M, 'L1');
    const c = p.scheduler.queued('auditor-chain')[0] as NonNullable<ReturnType<typeof p.scheduler.queued>[0]>;
    assert.deepEqual(p.scheduler.run(c.task, { handBack: chainPass(c.card as unknown as AuditChainCard) }), []);
    return p;
  }

  test('a stop at execution: nothing stamped, no success notice; once it is lifted, stamped and told once', async () => {
    const p = await chained();
    const orig = p.ledger.commitProofOp.bind(p.ledger);
    p.ledger.commitProofOp = async () => {
      throw Object.assign(new Error('STOPPED: a stop restriction covers this operation'), { code: 'STOPPED' });
    };
    const r1 = await advanceLegalization(p.ports, M, 'L1');
    assert.equal(r1.state, 'waiting');
    assert.match(r1.why, /stop restriction/);
    assert.equal(p.ledger.notices.filter((n) => n.category === 'legalization-stamped').length, 0);
    assert.equal((await p.ledger.records(['op.executed'])).length, 0);
    p.ledger.commitProofOp = orig;
    const r2 = await advanceLegalization(p.ports, M, 'L1');
    assert.equal(r2.result?.outcome, 'stamped');
    assert.equal((await p.ledger.records(['op.executed'])).length, 1);
    assert.equal(p.ledger.notices.filter((n) => n.category === 'legalization-stamped').length, 1);
  });

  test('a crash after the commit but before the notice: the next pass tells the PM; nothing is executed twice', async () => {
    const p = await chained();
    const origNotify = p.ledger.notify.bind(p.ledger);
    p.ledger.notify = async (n) => {
      if (n.category === 'legalization-stamped') throw new Error('UNAVAILABLE: the monitor is down');
      return origNotify(n);
    };
    await assert.rejects(() => advanceLegalization(p.ports, M, 'L1'), /monitor is down/);
    const st = await legalizationState(p.ports, M, 'L1');
    assert.equal(st.result?.outcome, 'stamped', 'the execution and its result were committed together');
    p.ledger.notify = origNotify;
    const r = await advanceLegalization(p.ports, M, 'L1');
    assert.equal(r.result?.outcome, 'stamped');
    assert.equal(p.ledger.notices.filter((n) => n.category === 'legalization-stamped').length, 1);
    assert.equal((await p.ledger.records(['op.executed'])).length, 1);
  });

  test('the ledger ended the operation (derived state not computable, WI-11): a new operation is registered and stamped', async () => {
    const p = await chained();
    const orig = p.ledger.commitProofOp.bind(p.ledger);
    let first = true;
    p.ledger.commitProofOp = async (req) => {
      if (first) {
        first = false;
        throw Object.assign(new Error('EVALUATOR_FAULT: the derived state cannot be computed'), { code: 'EVALUATOR_FAULT' });
      }
      return orig(req);
    };
    const r = await advanceLegalization(p.ports, M, 'L1');
    assert.equal(r.result?.outcome, 'stamped');
    const st = await legalizationState(p.ports, M, 'L1');
    assert.equal(st.ops.length, 2);
    assert.equal(r.result?.stamp?.op, st.ops[1]);
  });
});

describe('review r1 #17: legalization ids are per mission', () => {
  test('two missions each legalize "L1": distinct tasks, chain objects and stamps', async () => {
    const out: Array<{ task: string; lineage: string; judgment: string; chain: string }> = [];
    for (const mission of ['M1', 'M2'] as MissionId[]) {
      const w = await auditWorld(1, { mission });
      const n = w.scheduler.queued('auditor-node')[0] as NonNullable<ReturnType<typeof w.scheduler.queued>[0]>;
      const card = n.card as unknown as AuditNodeCard;
      assert.deepEqual(w.scheduler.run(n.task, { handBack: nodePass(card) }), []);
      await advanceLegalization(w.ports, mission, 'L1');
      const c = w.scheduler.queued('auditor-chain')[0]?.card as unknown as AuditChainCard;
      out.push({ task: n.task, lineage: n.lineage, judgment: card.positions[0]?.binding.judgment ?? '', chain: c.chain.object });
    }
    assert.deepEqual(out, [
      { task: 'aud.M1.L1.1.node', lineage: 'aud.M1.L1', judgment: 'audj.M1.L1.1.1', chain: 'chain.M1.L1' },
      { task: 'aud.M2.L1.1.node', lineage: 'aud.M2.L1', judgment: 'audj.M2.L1.1.1', chain: 'chain.M2.L1' },
    ]);
  });
});

describe('review r1 #3: a proof unit is audited on its members', () => {
  test('the unit Auditor reads every member laid over the base, with all members\' paths', async () => {
    const p = fakePorts();
    const c = p.ledger.content;
    const obj = (id: string, prereqs: string[], i: number): BaseRecord => ({
      kind: 'object.version',
      object: id as never,
      objectKind: 'product',
      mission: M,
      module: null,
      content: c.put(`manifest ${id}`),
      prerequisites: c.putList(prereqs),
      scope: { paths: [`src/${id}.ts`], taskType: 'code' },
      reviews: [],
      source: { commit: COMMIT(i) as never, writeScope: [`src/${id}.ts`], transform: 'b'.repeat(64) as never },
    });
    await p.ledger.append('setup', {
      records: [
        { kind: 'basis.version', basisKind: 'standard', line: 'std.task.S1' as never, version: 'std.task.S1.v1' as never, mission: M, scope: null },
        obj('X', ['Y'], 1),
        obj('Y', ['X'], 2),
        { kind: 'proof.unit', unit: 'U' as never, members: c.putList(['X', 'Y']), reviews: [{ review: 'integration', basisLines: ['std.task.S1' as never], reliesOn: [] }] },
      ],
      events: [
        {
          mission: M,
          line: 'requirements',
          event: 'item',
          key: 'std.task.S1.v1',
          body: { line: 'std.task.S1', version: 'std.task.S1.v1', type: 'acceptance', text: 'X and Y work together', source: { kind: 'words', message: 'm1', quote: 'they must work together' }, restatement: null, confirmedBy: null, notifyCondition: null },
        },
      ],
    });
    const snapshots: Array<{ products?: readonly string[] }> = [];
    p.scheduler.actions.snapshot = async (req) => {
      snapshots.push({ ...(req.products !== undefined ? { products: req.products } : {}) });
      return { path: `/fake/snapshots/${req.purpose}`, commit: 'c'.repeat(40) };
    };
    const ports = { ledger: p.ledger, scheduler: p.scheduler, evaluator: p.evaluator };
    await requestLegalization(ports, { legalization: 'LU', mission: M, endpoint: 'X', words: 'legalize', chainEvidence: [], capabilities: [] });
    await startLegalization(ports, M, 'LU', 'go');
    await advanceLegalization(ports, M, 'LU');
    const card = p.scheduler.queued('auditor-node')[0]?.card as unknown as AuditNodeCard;
    assert.equal(card.target.id, 'U');
    assert.equal(card.target.kind, 'unit');
    assert.deepEqual(card.target.paths, ['src/X.ts', 'src/Y.ts']);
    assert.deepEqual([...(snapshots.at(-1)?.products ?? [])].sort(), ['X', 'Y']);
    assert.match(card.positions[0]?.bases[0]?.text ?? '', /X and Y work together/);
  });
});
