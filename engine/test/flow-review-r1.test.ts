// Regressions for the flow code review r1 (docs/design/code-reviews/CodeReview_Flows_r1_gpt-6.1-sol.md),
// the findings in the decision layer, execution, actions and adapters: #1, #6, #8–#16. Each
// test follows the reviewer's repro (no model; real ledger, real git where the finding needs it).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import type { ObjectVersionRecord } from '../src/common/records.ts';
import { basisIndex, countedReturn, flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import type { ScriptedOutcome } from '../src/flow/scripted.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { constraintLine, currentConstraints, currentItems, itemLine, recordConstraint, recordItem, requirementSetLine, withdrawItem } from '../src/flow/requirements.ts';
import { architect, cal1Pass, cal2Escalate, constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, type Script } from '../src/flow/scripted.ts';
import { SEED_TEXT } from '../src/flow/scripted.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { transformDescriptionHash } from '../src/git/representation.ts';
import { gitActions } from '../src/process/index.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { calibrator1Problems, type Calibrator1Card, type Calibrator2Card } from '../src/seat/cards/calibrator.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { processProject, write } from './process-fixtures.ts';

const M = 'm1' as MissionId;

async function setup(mode: 'stable' | 'fast' = 'fast') {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode });
  return { ports, engine: new FlowEngine(ports) };
}

function withKinds(over: Record<string, Script>): Script {
  const base = happyScript(M);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

// review r1 #1 (4.0: the snapshot and the export laid over it never write through a link) went with the 4.0
// program actions: 4.1 collects the candidate from the Constructor's worktree with git (src/git/workspace.ts).

describe('review r1 #6: loop caps hold on the project memory', () => {
  it('equal returns: the second is no progress; distinct returns: the cap holds; a repeated key counts once', async () => {
    const ports = memoryPorts();
    const ctx = flowCtx(ports, M);
    const same = [];
    for (let i = 1; i <= 6; i++) same.push(await countedReturn(ctx, { line: 'plan', key: `same:${i}`, lineage: 'plan.m1.same', loop: 'mechanical-return', signature: 'A' }));
    assert.deepEqual(same.map((r) => r.proceed), [true, false, false, false, false, false], 'two equal signatures in a row exhaust the loop (6.5)');
    assert.equal(same[0]?.status.attempts, 1, 'the attempt is counted in the memory');
    const distinct = [];
    for (let i = 1; i <= 4; i++) distinct.push(await countedReturn(ctx, { line: 'plan', key: `d:${i}`, lineage: 'plan.m1.d', loop: 'mechanical-return', signature: `S${i}` }));
    assert.deepEqual(distinct.map((r) => r.proceed), [true, true, true, false], 'three returns, the fourth exhausted');
    const again = await countedReturn(ctx, { line: 'plan', key: 'd:1', lineage: 'plan.m1.d', loop: 'mechanical-return', signature: 'S1' });
    assert.equal(again.proceed, true, 'the kept verdict');
    assert.equal(again.status.attempts, 3, 'a repeated key is not counted again');
  });
});

describe("review r1 #8: a refused Secretary grant leaves the user's exit open", () => {
  it('the grant is refused by the ledger (the Secretary already used it): the user is asked, and the user\'s grant goes through', async () => {
    const { ports, engine } = await setup();
    const bad = detailedPlan(M, { implProvenance: 'e1' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-decompose': () => ({ handBack: architect(bad) }), secretary: () => null }));
    const sec = ports.scheduler.queued('secretary')[0];
    assert.ok(sec !== undefined);
    // Dispatch refreshes the grant flag; consume it after claim to keep testing the apply-time race.
    ports.scheduler.dispatchOf(sec.task);
    // between the dispatch and the decision, the Secretary's one grant on the lineage is used elsewhere
    assert.equal((await ports.ledger.grantLoop({ lineage: 'plan.m1.1', loop: 'env-retry', by: 'secretary', extra: 1, op: 'elsewhere' })).granted, true);
    await ports.scheduler.run(sec.task, { handBack: secretary(sec.card as unknown as SecretaryCard, 'grant') });
    await engine.reconcile(M);
    const ask = ports.ledger.notices.find((n) => n.category === 'loop-exhausted-needs-user');
    assert.ok(ask !== undefined && ask.wi === 'WI-08' && ask.askUser === true);
    await answerEscalation(ports, { mission: M, escalation: (ask.detail as { escalation: string }).escalation, option: 'grant', grantExtra: 1, words: 'one more' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2, "the user's grant reopened the loop");
  });
});

describe('review r1 #9 and #10: constraint scopes and restored texts', () => {
  it('a scope change alone is a constraint.scope record and the cards read the new scope; a kind change is a new version', async () => {
    const ports = memoryPorts();
    await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'object', text: 'No secret logs', scope: { paths: ['a.ts'], taskTypes: [] } });
    const v1 = await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'object', text: 'No secret logs', scope: { paths: ['a.ts', 'b.ts'], taskTypes: [] } });
    const ctx = flowCtx(ports, M);
    assert.deepEqual((await currentConstraints(ctx))[0]?.scope.paths, ['a.ts', 'b.ts']);
    assert.equal((await ports.ledger.records(['constraint.scope'])).length, 1);
    const v2 = await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'instruction', text: 'No secret logs', scope: { paths: ['a.ts', 'b.ts'], taskTypes: [] } });
    assert.notEqual(v2, v1, 'a kind change is a new content version');
  });

  it('restoring an earlier text (A → B → A) makes a new current version, not the old one', async () => {
    const ports = memoryPorts();
    const a1 = await recordConstraint(ports, { mission: M, constraint: 'c2', kind: 'object', text: 'A', scope: { paths: ['**'], taskTypes: [] } });
    const b = await recordConstraint(ports, { mission: M, constraint: 'c2', kind: 'object', text: 'B', scope: { paths: ['**'], taskTypes: [] } });
    const a2 = await recordConstraint(ports, { mission: M, constraint: 'c2', kind: 'object', text: 'A', scope: { paths: ['**'], taskTypes: [] } });
    assert.notEqual(a2, a1);
    assert.notEqual(a2, b);
    assert.equal((await basisIndex(flowCtx(ports, M))).current.get('constraint.c2'), a2, 'the restored text is the current basis');
    assert.equal((await currentConstraints(flowCtx(ports, M)))[0]?.text, 'A');
  });
});

describe('project constraints (9.5): recorded from any mission, in force for every mission by their own scope', () => {
  const M2 = 'm2' as MissionId;
  const conCard = (ports: ReturnType<typeof memoryPorts>) => ports.scheduler.card<{ constraints: Array<{ id: string; text: string }> }>('con.m1.impl.1');

  it('M2 records c1 v2: M1 has v2 in force and its covered product is degraded (5.2)', async () => {
    const { ports, engine } = await setup();
    await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'object', text: 'No secret logs', scope: { paths: ['src/parser/**'], taskTypes: [] } });
    await drive(engine, ports.scheduler, happyScript(M));
    const products = (await ports.ledger.events<{ object: string; task: string }>({ mission: M, event: 'product' })).map((e) => e.body.object);
    assert.ok(products.length > 0);
    const before = (await ports.evaluator.labels(products)).labels;
    const v2 = await recordConstraint(ports, { mission: M2, constraint: 'c1', kind: 'object', text: 'No secret or token logs', scope: { paths: ['src/parser/**'], taskTypes: [] } });
    const inM1 = await currentConstraints(flowCtx(ports, M));
    assert.deepEqual(inM1.map((c) => [c.line, c.version, c.text]), [['constraint.c1', v2, 'No secret or token logs']], "M2's version is in force for M1");
    const after = (await ports.evaluator.labels(products)).labels;
    const impl = products.find((p) => p.includes('impl')) ?? products[0]!;
    assert.equal(before[impl], 'proven', JSON.stringify(before));
    assert.notEqual(after[impl], 'proven', `a new content version recorded from M2 degrades M1's covered product: ${JSON.stringify(after)}`);
    // a narrower scope recorded from M2 that still covers the product does not degrade it further (5.2 v30)
    await recordConstraint(ports, { mission: M2, constraint: 'c1', kind: 'object', text: 'No secret or token logs', scope: { paths: ['src/parser/impl/**', 'src/parser/api.ts'], taskTypes: [] } });
    assert.equal((await currentConstraints(flowCtx(ports, M)))[0]?.version, v2, 'a scope change is no new content version');
    assert.deepEqual((await currentConstraints(flowCtx(ports, M)))[0]?.scope.paths, ['src/parser/impl/**', 'src/parser/api.ts']);
  });

  it("M2 adds c2 over M1's paths: it reaches M1's cards; constraints whose path or task type do not match stay off", async () => {
    const { ports, engine } = await setup();
    await recordConstraint(ports, { mission: M2, constraint: 'c2', kind: 'instruction', text: 'Keep the parser pure', scope: { paths: ['src/parser/**'], taskTypes: [] } });
    await recordConstraint(ports, { mission: M2, constraint: 'c3', kind: 'object', text: 'Docs in English', scope: { paths: ['docs/**'], taskTypes: [] } });
    await recordConstraint(ports, { mission: M, constraint: 'c4', kind: 'object', text: 'Integration only', scope: { paths: ['**'], taskTypes: ['integration'] } });
    await drive(engine, ports.scheduler, happyScript(M));
    const ids = conCard(ports).constraints.map((c) => c.id);
    assert.ok(ids.includes('constraint.c2'), `recorded from M2, scoped to M1's paths: ${ids.join(', ')}`);
    assert.ok(!ids.includes('constraint.c3'), 'another path');
    assert.ok(!ids.includes('constraint.c4'), 'another task type');
  });

  it('scope changes from two missions get their own ops (no OP_CONFLICT)', async () => {
    const ports = memoryPorts();
    await recordConstraint(ports, { mission: M, constraint: 'c5', kind: 'object', text: 'T', scope: { paths: ['a/**'], taskTypes: [] } });
    await recordConstraint(ports, { mission: M, constraint: 'c5', kind: 'object', text: 'T', scope: { paths: ['b/**'], taskTypes: [] } });
    await recordConstraint(ports, { mission: M2, constraint: 'c5', kind: 'object', text: 'T', scope: { paths: ['c/**'], taskTypes: [] } });
    assert.deepEqual((await currentConstraints(flowCtx(ports, M)))[0]?.scope.paths, ['c/**']);
    assert.deepEqual((await currentConstraints(flowCtx(ports, M2)))[0]?.scope.paths, ['c/**']);
  });
});

describe('review r3: ill-formed ids, withdrawals, line kinds', () => {
  const words = { kind: 'words' as const, words: 'W-1', quote: 'as the user said' };

  it('lone surrogates are refused: idPart, plan standards and verification commands, items', async () => {
    const { idPart } = await import('../src/common/ids.ts');
    const { DetailedPlanDoc } = await import('../src/flow/plandoc.ts');
    assert.throws(() => idPart('\ud800'), /not well-formed/);
    assert.throws(() => idPart('x'.repeat(80) + '\udc00'), /not well-formed/, 'the hashed branch too');
    const plan = detailedPlan('m1');
    const impl = plan.tasks[1]!;
    const bad = (t: Partial<typeof impl>) => ({ ...plan, tasks: [plan.tasks[0], { ...impl, ...t }] });
    assert.ok(DetailedPlanDoc.safeParse(plan).success);
    assert.equal(DetailedPlanDoc.safeParse(bad({ verificationCommands: [{ id: '\ud800', command: 'a' }, { id: '\ud801', command: 'b' }] })).success, false);
    assert.equal(DetailedPlanDoc.safeParse(bad({ standards: [{ id: '\ud800', text: 'a' }] })).success, false);
    await assert.rejects(recordItem(memoryPorts(), { mission: M, item: '\ud800', type: 'goal', text: 't', source: words }), /not allowed/);
  });

  it('withdrawing "R!1" is refused and "R-1" stays; a missing item is refused; nothing is written', async () => {
    const ports = memoryPorts();
    await recordItem(ports, { mission: M, item: 'R-1', type: 'goal', text: 'keep me', source: words });
    const before = (await ports.ledger.records(['basis.withdrawn'])).length;
    await assert.rejects(withdrawItem(ports, { mission: M, item: 'R!1', reason: 'x' }), /item id "R!1" is not allowed/);
    await assert.rejects(withdrawItem(ports, { mission: M, item: 'R-2', reason: 'x' }), /has no requirement item R-2/);
    assert.equal((await ports.ledger.records(['basis.withdrawn'])).length, before);
    assert.deepEqual((await currentItems(flowCtx(ports, M))).map((i) => i.line), ['item.m1.R-1']);
    await withdrawItem(ports, { mission: M, item: 'R-1', reason: 'the user withdrew it' });
    await withdrawItem(ports, { mission: M, item: 'R-1', reason: 'the user withdrew it' }); // a retry
    assert.deepEqual(await currentItems(flowCtx(ports, M)), []);
  });

  it('mission "constraint" with item "security" leaves the project constraint "security" intact', async () => {
    const ports = memoryPorts();
    const MC = 'constraint' as MissionId;
    const v = await recordConstraint(ports, { mission: M, constraint: 'security', kind: 'object', text: 'No secrets in logs', scope: { paths: ['**'], taskTypes: [] } });
    await recordItem(ports, { mission: MC, item: 'security', type: 'goal', text: 'harden it', source: words });
    const inForce = async () => (await currentConstraints(flowCtx(ports, M))).map((c) => [c.line, c.version, c.text]);
    assert.deepEqual(await inForce(), [['constraint.security', v, 'No secrets in logs']]);
    await withdrawItem(ports, { mission: MC, item: 'security', reason: 'dropped' });
    assert.deepEqual(await inForce(), [['constraint.security', v, 'No secrets in logs']], 'the withdrawal hit the item only');
    assert.deepEqual((await ports.ledger.records(['basis.withdrawn'])).map((c) => (c.record as { line: string }).line), ['item.constraint.security']);
  });

  it('basis lines of different kinds never overlap: each starts with its own fixed kind', async () => {
    const { xid } = await import('../src/flow/exploration/definition.ts');
    const { standardLine } = await import('../src/flow/planning.ts');
    const names = ['constraint', 'item', 'std', 'reqset', 'xpdef', 'xpenv', 'security', 'm1', 'v1', 'a-b'];
    const builders: Record<string, (a: string, b: string) => string> = {
      item: (a, b) => itemLine(a, b),
      constraint: (_a, b) => constraintLine(b),
      std: (a, b) => standardLine(a, b, b),
      reqset: (a) => requirementSetLine(a),
      xpdef: (a, b) => xid.basisLine(a, b),
      xpenv: (a, b) => xid.envLine(a, b),
    };
    const owner = new Map<string, string>();
    for (const [kind, f] of Object.entries(builders)) {
      for (const a of names) for (const b of names) {
        const line = f(a, b);
        assert.equal(line.split('.')[0], kind, `${line} starts with its kind`);
        const o = owner.get(line);
        assert.ok(o === undefined || o === kind, `${line} is built by both ${o} and ${kind}`);
        owner.set(line, kind);
      }
    }
  });
});

describe('review r1 #11: Calibrator ① cites the user, not the PM', () => {
  it('"user-said" must cite the user\'s words; "detail-within-authority" must cite an authorization', async () => {
    const { ports, engine } = await setup();
    await engine.reconcile(M);
    const c = ports.scheduler.card<Calibrator1Card>('cal1.m1.1');
    const r = cal1Pass(c);
    const viaPlan = { ...r, elements: r.elements.map((e) => ({ ...e, quotes: ['plan#1'] })) };
    assert.ok(calibrator1Problems(c, viaPlan, new Set(c.materials.map((m) => `${m.id}#1`))).some((p) => /user's words/.test(p)));
    const detail = { ...r, elements: r.elements.map((e) => ({ ...e, finding: 'detail-within-authority' as const, quotes: ['words#1'] })) };
    assert.ok(calibrator1Problems(c, detail, new Set(c.materials.map((m) => `${m.id}#1`))).some((p) => /authorization/.test(p)));
    assert.deepEqual(calibrator1Problems(c, r, new Set(c.materials.map((m) => `${m.id}#1`))), [], 'citing the user\'s words passes');
  });
});

describe('review r1 #12: a stale Calibrator ① pass does not release the plan', () => {
  it('a basis changed while Calibrator ① ran: no release, a fresh full review runs, then the plan takes effect', async () => {
    const { ports, engine } = await setup();
    await engine.reconcile(M);
    const c = ports.scheduler.card<Calibrator1Card>('cal1.m1.1');
    ports.scheduler.dispatchOf(c.task); // the change arrives after the dispatch-time refresh
    await recordItem(ports, { mission: M, item: 'g2', type: 'goal', text: 'Also TSV', source: { kind: 'words', words: 'W-1', quote: 'CSV parser' } });
    await ports.scheduler.run('cal1.m1.1', { handBack: cal1Pass(c) });
    await engine.reconcile(M);
    assert.equal((await ports.ledger.events({ mission: M, event: 'pm-plan-effective' })).length, 0);
    assert.equal(ports.scheduler.queued('architect-decompose').length, 0);
    const re = ports.scheduler.card<Calibrator1Card>('cal1.m1.1.re1');
    assert.equal(re.mode.kind, 'full');
    await ports.scheduler.run('cal1.m1.1.re1', { handBack: cal1Pass(re) });
    await engine.reconcile(M);
    assert.equal((await ports.ledger.events({ mission: M, event: 'pm-plan-effective' })).length, 1);
  });
});

describe('review r1 #13: recovery neither skips a step nor conflicts', () => {
  it('a lost re-answer write is retried as the same operation; a lost re-plan attempt is created on the next pass', async () => {
    const { ports, engine } = await setup();
    let first = true;
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        reviewer: (t) => {
          const c = t.card as unknown as ReviewerCard;
          if (c.target.includes('impl') && first) {
            first = false;
            return { handBack: reviewer(c, 'needs-decision') };
          }
          return { handBack: reviewer(c, 'pass') };
        },
        secretary: () => null,
      }),
    );
    assert.equal((await ports.ledger.events({ mission: M, event: 'reanswer' })).length, 0, 'the answer is still to be applied');
    // the Secretary answers; carrying it out is lost once
    const sec = ports.scheduler.queued('secretary')[0] as FlowTask;
    await ports.scheduler.run(sec.task, { handBack: secretary(sec.card as unknown as SecretaryCard, 'answer', { instructions: 'multi-line quotes are allowed' }) });
    ports.ledger.failNext = (op) => op.startsWith('flow:reanswer:m1:');
    const r1 = await engine.reconcile(M);
    assert.equal(r1[0]?.errors.length, 1);
    await drive(engine, ports.scheduler, happyScript(M));
    assert.equal((await ports.ledger.events({ mission: M, event: 'reanswer' })).length, 1, 'one re-review, no OP_CONFLICT');
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2);
  });

  it('a re-plan request whose routing and next attempt are lost together is routed on the next pass', async () => {
    const { ports, engine } = await setup();
    let reworks = 0;
    let routedOnce = false;
    const script = withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('iface') || routedOnce) return { handBack: reviewer(c, 'pass') };
        reworks++;
        return { handBack: reviewer(c, 'rework', { failing: reworks % 2 === 0 ? 'S2' : 'S1' }) };
      },
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'replan', { instructions: 'split it' }) }),
      'architect-decompose': (t) => {
        if ((t.card as { revision?: { instructions: string[] } }).revision?.instructions.some((x) => x.startsWith('Re-plan'))) routedOnce = true;
        return { handBack: architect(detailedPlan(M)) };
      },
    });
    ports.ledger.failNext = (op) => op.startsWith('flow:attempt:m1:pmplan.m1.1:2');
    await drive(engine, ports.scheduler, script).catch(() => undefined);
    await drive(engine, ports.scheduler, script);
    assert.equal((await ports.ledger.events({ mission: M, event: 'replan-routed' })).length, 1);
    assert.ok(routedOnce, 'the Architect got the re-plan');
  });
});

describe('review r1 #14: notices and Constructor questions survive a crash', () => {
  it('a Secretary notice that failed once is sent on the next pass', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ 'calibrator-2': (t) => ({ handBack: cal2Escalate(t.card as unknown as Calibrator2Card, 'a public format') }), secretary: () => null }));
    const sec = ports.scheduler.queued('secretary')[0] as FlowTask;
    await ports.scheduler.run(sec.task, { handBack: secretary(sec.card as unknown as SecretaryCard, 'ask-user') });
    ports.ledger.failNotifyNext = (n) => n.category === 'needs-user-decision';
    const r = await engine.reconcile(M);
    assert.equal(r[0]?.errors.length, 1, 'the notice failed');
    assert.equal(ports.ledger.notices.filter((n) => n.category === 'needs-user-decision').length, 0);
    await engine.reconcile(M);
    assert.equal(ports.ledger.notices.filter((n) => n.category === 'needs-user-decision').length, 1, 'the notice reached the PM after the failure');
  });

  it("the Constructor's questions are raised even when the escalation write is lost after the product", async () => {
    const { ports, engine } = await setup();
    ports.ledger.failNext = (op) => op.startsWith('flow:escalation:m1:cdec.');
    await drive(engine, ports.scheduler, withKinds({ constructor: (t: FlowTask): ScriptedOutcome | null => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Skip empty lines?'] } : {}) }), secretary: () => null })).catch(() => undefined);
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
    assert.equal(ports.scheduler.queued('secretary').filter((t) => t.task.includes('cdec')).length, 1);
  });
});

// review r1 #15 (4.0: a failed verification unit) has no 4.1 counterpart: `mp` runs the declared commands
// itself, inside the hand-back and the flow's verify step, and a run that cannot start is a recorded result.

describe('review r1 #16 (4.1): a product version is recorded once for its candidate commit', () => {
  it('a second product call returns the same version; the bound transform description is stored by its hash', async () => {
    const pp = processProject();
    try {
      const base = pp.git('rev-parse', 'HEAD');
      write(pp.dir, 'src/b.ts', 'export const b = 1;\n');
      pp.git('add', 'src/b.ts');
      pp.git('commit', '-q', '-m', 'candidate');
      const candidate = pp.git('rev-parse', 'HEAD');
      const actions = gitActions(pp.ctx);
      const req = { mission: M, module: 'm', task: 'con.m1.t.1', dispatch: 'D-1', candidate, base, writeScope: ['src/b.ts'], taskType: 'implementation', prerequisites: [], reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }] as never, predecessor: null };
      const first = await actions.product(req);
      const again = await actions.product(req);
      assert.deepEqual(again, first);
      assert.deepEqual(first.changedPaths, ['src/b.ts']);
      const versions = pp.ctx.memory.read((db) => db.stmt("SELECT record FROM log WHERE kind = 'object.version'").all() as Array<{ record: string }>).map((r) => JSON.parse(r.record) as ObjectVersionRecord);
      assert.equal(versions.length, 1);
      assert.equal(versions[0]!.source!.commit, candidate);
      const hash = versions[0]!.source!.transform;
      const bound = JSON.parse(pp.ctx.memory.data.text(hash));
      assert.equal(transformDescriptionHash(bound), hash, 'the stored bytes are the ones hashed');
    } finally {
      pp.cleanup();
    }
  });
});

void (null as unknown as DetailedPlanDoc);

describe('review r1 #2 (decision layer): plans rest on the proof of the explorations they plan from', () => {
  const X = 'X1';
  async function explorationWorld(artifactProven: boolean) {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    const plan = pmPlan(M);
    const doc = {
      ...plan,
      elements: [
        plan.elements[0]!,
        {
          id: 'x1',
          kind: 'exploration' as const,
          text: 'Find the streaming approach',
          provenance: { by: 'pm' as const },
          after: [],
          items: [],
          exploration: { id: X, deliverable: 'a design', fuzzyGoal: { quote: 'Build me a CSV parser', words: 'W-1' }, attackScope: ['contradictions'], decision: { id: 'd1', type: 'structure' as const }, budget: { rounds: 3, micros: null }, stop: '', research: false },
        },
        { ...plan.elements[1]!, after: [X] },
      ],
    };
    // the exploration's product, its Crititor pass (proven), and its "settled" event
    const c = ports.ledger.content;
    const artifact = 'xart.m1.X1';
    const records: import('../src/common/records.ts').BaseRecord[] = [
      { kind: 'object.version', object: artifact as never, objectKind: 'interpretation', mission: M, module: null, content: c.put('the design'), prerequisites: c.putList([]), scope: { paths: ['explorations/x1.md'], taskType: 'exploration' }, reviews: [{ review: 'crititor', basisLines: [], reliesOn: [] }] },
    ];
    if (artifactProven) records.push({ kind: 'judgment', judgment: 'j.x1.pass' as never, review: 'crititor', executor: 'crititor', target: artifact as never, verdict: 'pass', evidence: c.putList([]), bases: c.putList([]), constraints: c.putList([]), reliesOn: c.putList([]), issues: [], revokes: null, evidenceUse: { fields: [], statisticalOrExternal: false }, superseded: [], extends: null });
    await ports.ledger.append('x:settle', {
      records,
      events: [{ mission: M, line: `exploration:${X}`, event: 'settled', key: X, body: { exploration: X, decision: { id: 'd1', type: 'structure' }, outcome: 'conclusion', stop: 'converged', artifact, summary: 'stream it', unresolved: [] } }],
    });
    await submitPmBatch(ports, { mission: M, plan: doc, userWords: ['W-1'], mode: 'stable' });
    return { ports, engine: new FlowEngine(ports), artifact };
  }

  it('a settled exploration whose product is not proven does not stand: nothing that waits for it is planned, and it is no conclusion', async () => {
    const { ports, engine } = await explorationWorld(false);
    // this round plans only what does not wait for the exploration
    const full = detailedPlan(M);
    const round: DetailedPlanDoc = { ...full, tasks: [full.tasks[0] as DetailedPlanDoc['tasks'][number]] };
    type ArchCard = { unsettledExplorations: string[]; pmPlan: { elements: Array<{ id: string; after: string[] }> }; output: { calibrator2: { reliesOn: string[] } } };
    const seen: { card: ArchCard | null } = { card: null };
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-decompose': (t) => {
          seen.card = t.card as unknown as ArchCard;
          return { handBack: architect(round) };
        },
        secretary: () => null,
      }),
    );
    const card = seen.card as ArchCard;
    assert.ok(card !== null);
    assert.deepEqual(card.unsettledExplorations, [X], 'the historical settled event alone does not make it stand');
    assert.deepEqual(card.pmPlan.elements.find((e) => e.id === 'e2')?.after, [X]);
    assert.deepEqual(card.output.calibrator2.reliesOn, ['pmplan.m1.1']);
    const esc = ports.scheduler.queued('secretary').map((t) => t.card as unknown as SecretaryCard).find((x) => x.request.subject === `exploration:${X}`);
    assert.ok(esc !== undefined, 'routed as no conclusion (to the Secretary, the PM and the user), not to the Architect');
    // a decision the flow carries out (code review S1): the PM re-plans the waiting part with the user
    assert.deepEqual(esc.options.map((o) => o.id), ['replan', 'ask-user']);
  });

  it('the detailed plan relies on the exploration product: negating it degrades the plan and the products built on it', async () => {
    const { ports, engine, artifact } = await explorationWorld(true);
    await drive(engine, ports.scheduler, happyScript(M));
    const eff = (await ports.ledger.events<{ dplan: string }>({ mission: M, event: 'effective' })).at(-1)?.body.dplan as string;
    const plan = (await ports.ledger.objectVersion(eff)) as ObjectVersionRecord;
    assert.ok(plan.reviews.every((r) => (r.reliesOn as readonly string[]).includes(artifact)), 'calibrator-2 and feasibility contracts rely on the artifact');
    const products = (await ports.ledger.events<{ product: string }>({ mission: M, event: 'accepted' })).map((e) => e.body.product);
    assert.equal(products.length, 2);
    assert.ok(Object.values((await ports.evaluator.labels([eff, ...products])).labels).every((l) => l === 'proven'));
    // the exploration's product is negated
    const c = ports.ledger.content;
    await ports.ledger.append('x:negate', { records: [{ kind: 'judgment', judgment: 'j.x1.fail' as never, review: 'crititor', executor: 'crititor', target: artifact as never, verdict: 'fail', evidence: c.putList([]), bases: c.putList([]), constraints: c.putList([]), reliesOn: c.putList([]), issues: [], revokes: null, evidenceUse: { fields: [], statisticalOrExternal: false }, superseded: [], extends: null }] });
    const after = (await ports.evaluator.labels([artifact, eff, ...products])).labels;
    assert.equal(after[artifact], 'negated');
    for (const id of [eff, ...products]) assert.notEqual(after[id], 'proven', `${id} is no longer proven`);
  });
});

describe('derived ids stay injective (review r1 #17)', () => {
  it('a dotted mission is refused by the flows; dotted local parts are escaped', async () => {
    const { xid } = await import('../src/flow/exploration/definition.ts');
    const { aid } = await import('../src/flow/audit/flow.ts');
    const { standardLine } = await import('../src/flow/planning.ts');
    const { idPart } = await import('../src/flow/context.ts');
    assert.throws(() => flowCtx(memoryPorts(), 'a.b' as MissionId), /mission id "a\.b" is not allowed/);
    assert.notEqual(xid.lineage('m', 'a.ev1'), xid.evidenceLineage('m', 'a', 1));
    assert.notEqual(xid.basisLine('m', 'x.v1'), xid.basisVersion('m', 'x', 1));
    assert.notEqual(aid.stampOp('m', 'L.r2', 1), aid.stampOp('m', 'L', 2));
    assert.notEqual(standardLine('m', 'a.b', 'c'), standardLine('m', 'a', 'b.c'));
    assert.equal(standardLine('m', 'T1', 's1'), 'std.m.T1.s1', 'plain parts are unchanged');
    assert.equal(xid.lineage('m', 'x1'), 'xp.m.x1');
    assert.equal(idPart('c1'), 'c1');
    assert.notEqual(idPart('a.b'), idPart('a-b'));
  });

  it('review r2 repros: a raw id equal to another id\'s encoding no longer collides (exploration, standards)', async () => {
    const { explorationDefinition, xid } = await import('../src/flow/exploration/definition.ts');
    const { defineExploration } = await import('../src/flow/exploration/flow.ts');
    const { standardLine } = await import('../src/flow/planning.ts');
    const { idPart } = await import('../src/flow/context.ts');
    assert.equal(idPart('E1'), 'E1');
    assert.equal(idPart('a-b'), 'a-2db');
    assert.equal(idPart('a.b'), 'a-2eb');
    // exploration: both definitions commit (the fake ledger refuses a reused op with another payload, as the real one)
    const { ledger, scheduler } = memoryPorts();
    const M1 = 'M1' as MissionId;
    const raws = ['a.b', idPart('a.b'), 'a-b-2e7336dc', 'a-b'];
    for (const x of raws) {
      await defineExploration({ ledger, scheduler }, explorationDefinition({ exploration: x, mission: M1, product: 'design', goal: 'g', decision: { type: 'structure', text: 'd' }, budget: { rounds: 2 } }));
    }
    assert.equal(new Set(raws.map((x) => xid.op('M1', x, 'define'))).size, raws.length);
    // standards: the task part and the standard part
    const parts = ['a_b', 'a-b-648fa9b3', idPart('a_b'), 'a-b', 'a.b'];
    assert.equal(new Set(parts.map((p) => standardLine('m', p, 's'))).size, parts.length);
    assert.equal(new Set(parts.map((p) => standardLine('m', 'T', p))).size, parts.length);
  });

  it('item and constraint ids keep only characters their ledger lines keep ("R_1" would meet "R-1")', async () => {
    const ports = memoryPorts();
    const M1 = 'M1' as MissionId;
    await assert.rejects(recordConstraint(ports, { mission: M1, constraint: 'c_1', kind: 'object', text: 't', scope: { paths: ['**'], taskTypes: [] } }), /constraint id "c_1" is not allowed/);
    await assert.rejects(recordItem(ports, { mission: M1, item: 'R_1', type: 'goal', text: 't', source: { kind: 'pm' } as never }), /item id "R_1" is not allowed/);
    await recordConstraint(ports, { mission: M1, constraint: 'c-1a', kind: 'object', text: 't', scope: { paths: ['**'], taskTypes: [] } });
  });

  it('idPart is injective over adversarial samples, never holds ".", and stays short', async () => {
    const { idPart, ID_PART_MAX } = await import('../src/common/ids.ts');
    const alphabet = ['a', 'b', 'z', 'Z', '2', 'e', 'f', '0', '-', '.', '_', ' ', ':', 'é', '中'];
    const inputs = new Set<string>(['', '-', '--', '-2e', '-2d', '-zz', '-zz0123456789abcdef', 'a-zz', '-2', '-g0', 'x'.repeat(64), 'x'.repeat(65), '-'.repeat(30), '.'.repeat(22)]);
    let seed = 7;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let i = 0; i < 4000; i++) inputs.add(Array.from({ length: rnd(9) }, () => alphabet[rnd(alphabet.length)]).join(''));
    for (let i = 0; i < 200; i++) inputs.add(`${'y'.repeat(60 + rnd(10))}${Array.from({ length: rnd(5) }, () => alphabet[rnd(alphabet.length)]).join('')}`); // long, shared heads
    for (const x of [...inputs]) inputs.add(idPart(x)); // every encoding is also tried as a raw id
    const seen = new Map<string, string>();
    for (const x of inputs) {
      const e = idPart(x);
      assert.ok(seen.get(e) === undefined || seen.get(e) === x, `${JSON.stringify(x)} and ${JSON.stringify(seen.get(e))} both encode to ${e}`);
      seen.set(e, x);
      assert.match(e, /^[A-Za-z0-9-]+$/);
      assert.ok(e.length <= ID_PART_MAX, e);
      if (!e.includes('-zz')) {
        assert.match(e, /^(?:[A-Za-z0-9]|-[0-9a-f]{2})+$/, 'every "-" is followed by two hex digits');
        const decoded = Buffer.from(e.replace(/-([0-9a-f]{2})|([A-Za-z0-9])/g, (_m, h: string | undefined, c: string | undefined) => (h !== undefined ? `%${h}` : c!)).replace(/%([0-9a-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
        assert.equal(decoded, x, 'escaped parts decode back');
      } else assert.ok(x.length === 0 || Buffer.byteLength(x) > 21 || /[^A-Za-z0-9]/.test(x), 'only long or empty inputs are hashed');
    }
  });
});
