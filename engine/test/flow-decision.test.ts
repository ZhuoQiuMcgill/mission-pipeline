// The decision layer and execution flows with scripted seat results (no models): design 3.1–3.10,
// 4.1–4.2, 8.1, 6.5, 3.11.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { WI_CATALOG } from '../src/common/records.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { detailedPlan, drive, happyScript, pmPlan, seedMission } from '../src/flow/scripted.ts';

const M = 'm1' as MissionId;

async function setup(mode: 'stable' | 'fast' = 'stable') {
  const ports = fakePorts();
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['msg1'], changedItems: ['g1', 's1', 'a1'], mode });
  return { ports, engine: new FlowEngine(ports) };
}

describe('flow: happy path from requirement to accepted tasks', () => {
  it('runs Calibrator ①, Architect, mechanical checks, feasibility, Calibrator ②, then both tasks through Constructor and Reviewer (stable mode: all proven)', async () => {
    const { ports, engine } = await setup('stable');
    const ran = await drive(engine, ports.scheduler, happyScript(M));
    const kinds = ran.map((t) => ports.scheduler.card<{ seat: string }>(t).seat);
    assert.deepEqual(kinds, ['calibrator-1', 'architect-decompose', 'architect-feasibility', 'calibrator-2', 'constructor', 'reviewer', 'constructor', 'reviewer']);
    const accepted = await ports.ledger.events<{ product: string }>({ mission: M, event: 'accepted' });
    assert.deepEqual(accepted.map((a) => a.line).sort(), ['task:iface', 'task:impl']);
    const labels = await ports.evaluator.labels([...accepted.map((a) => a.body.product), 'pmplan.m1.1', 'dplan.m1.1.1']);
    for (const [id, l] of Object.entries(labels.labels)) assert.equal(l, 'proven', `${id} is ${l}`);
    assert.deepEqual(ports.ledger.notices, [], 'a clean run tells the PM nothing');
    const settled = await engine.reconcile(M);
    assert.equal(settled[0]?.passes, 1, 'a settled mission takes one pass (nothing is re-done)');
  });
});

import type { Calibrator1Card, Calibrator2Card } from '../src/seat/cards/calibrator.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { architect, cal1Fail, cal1Pass, cal2Escalate, feasibilityReturn, secretary, type Script } from '../src/flow/scripted.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';

/** happyScript with some kinds replaced. */
function withKinds(over: Record<string, Script>): Script {
  const base = happyScript(M);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

const PROPOSED_WI = new Set(['WI-23', 'WI-24', 'WI-26']);
function assertNoticesHaveWi(notices: ReadonlyArray<{ category: string; wi: string | null }>): void {
  const normal = new Set(['calibrator-1-returned', 'secretary-decision', 'needs-user-decision']);
  for (const n of notices) {
    if (n.wi === null) assert.ok(normal.has(n.category), `notice ${n.category} has no WI but is not a normal branch`);
    else assert.ok(WI_CATALOG.has(n.wi) || PROPOSED_WI.has(n.wi), `notice ${n.category} names unknown WI ${n.wi}`);
  }
}

describe('flow: Calibrator ① (3.3)', () => {
  it('a failing audit goes back to the PM with reasons and questions, the items contested; a new batch passes and the Architect starts', async () => {
    const { ports, engine } = await setup();
    let first = true;
    const ran = await drive(
      engine,
      ports.scheduler,
      withKinds({
        'calibrator-1': (t) => {
          const c = t.card as unknown as Calibrator1Card;
          if (first) {
            first = false;
            return { handBack: cal1Fail(c, 'e2', 'ask-user') };
          }
          return { handBack: cal1Pass(c) };
        },
      }),
    );
    assert.deepEqual(ran, ['cal1.m1.1'], 'nothing runs after a failed Calibrator ①');
    const n = ports.ledger.notices.find((x) => x.category === 'calibrator-1-returned');
    assert.ok(n !== undefined);
    assert.equal(n.wi, null, 'a return to the PM is a normal branch');
    assert.equal(n.askUser, true, 'the PM asks the user the question on the spot');
    const contested = await ports.ledger.events<{ line: string; contested: boolean }>({ mission: M, line: 'requirements', event: 'contested' });
    assert.deepEqual(contested.map((c) => [c.body.line, c.body.contested]), [['item.m1.s1', true]]);
    // the PM aligns with the user and records a new batch
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests in the repository' }] }), userWords: ['msg1'], changedItems: [] });
    const ran2 = await drive(engine, ports.scheduler, withKinds({ 'calibrator-1': (t) => ({ handBack: cal1Pass(t.card as unknown as Calibrator1Card) }) }));
    assert.equal(ran2[0], 'cal1.m1.2');
    assert.ok(ran2.includes('arch.m1.2.1'), 'the Architect starts once the plan passes');
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.2');
    assert.equal(card.mode.kind, 'full', 'the previous version did not pass: a full review');
    const released = await ports.ledger.events<{ line: string; contested: boolean }>({ mission: M, line: 'requirements', event: 'contested' });
    assert.deepEqual(released.at(-1)?.body, { line: 'item.m1.s1', contested: false, why: 'PM plan pmplan.m1.2 passed Calibrator ①' });
  });

  it('a batch after a pass is a continuation review of the changed elements, with old and new full text', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit and property tests' }] }), userWords: ['msg1'] });
    await engine.reconcile(M);
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.2');
    assert.deepEqual(card.mode, { kind: 'continuation', extends: 'j.cal1.m1.1' });
    assert.deepEqual(card.focus, ['e2']);
    assert.ok(card.materials.some((m) => m.id === 'plan-old') && card.materials.some((m) => m.id === 'plan'));
    // "needs full review" → a full review task, not a verdict
    ports.scheduler.run('cal1.m1.2', { handBack: { ...cal1Pass(card), verdict: 'needs-full-review' } });
    await engine.reconcile(M);
    const full = ports.scheduler.card<Calibrator1Card>('cal1.m1.2.full');
    assert.equal(full.mode.kind, 'full');
    assert.equal(full.focus.length, 2);
  });
});

describe('flow: mechanical checks (3.5) and their loop (6.5)', () => {
  it('three returns to the Architect, the fourth failure exhausts the loop: WI-08 and the Secretary, whose one grant lets the fixed plan through', async () => {
    const { ports, engine } = await setup();
    const good = detailedPlan(M);
    const bad: DetailedPlanDoc[] = [
      detailedPlan(M, { implProvenance: 'e1' }), // e2 not covered
      { ...good, tasks: good.tasks.map((t) => (t.id === 'impl' ? { ...t, dependsOn: [] } : t)) }, // uses Parser before its definition task
      { ...good, tasks: [...good.tasks, { ...(good.tasks[1] as DetailedPlanDoc['tasks'][number]), id: 'other', writeScope: ['src/parser/impl/x.ts'] }] }, // parallel write overlap, no integration task
      detailedPlan(M, { implProvenance: 'e1' }),
    ];
    let attempt = 0;
    let secretaryCard: SecretaryCard | null = null;
    const ran = await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-decompose': (t) => {
          const c = t.card as unknown as ArchitectDecomposeCard;
          if (attempt > 0) assert.ok((c.revision?.mechanicalFailures.length ?? 0) > 0 || (c.revision?.instructions.length ?? 0) > 0, 'a revision says why');
          return { handBack: architect(bad[attempt++] ?? good) };
        },
        secretary: (t) => {
          secretaryCard = t.card as unknown as SecretaryCard;
          return { handBack: secretary(secretaryCard, 'grant', { grantExtra: 1 }) };
        },
      }),
    );
    assert.equal(ran.filter((t) => t.startsWith('arch.')).length, 5, 'four failing attempts and one that passes');
    const sc = secretaryCard as SecretaryCard | null;
    assert.ok(sc !== null);
    assert.equal(sc.request.source, 'loop-exhausted');
    assert.deepEqual(sc.options.map((o) => o.id), ['grant', 'ask-user']);
    assert.equal(sc.grantAvailable, true);
    const wi = ports.ledger.notices.filter((n) => n.wi === 'WI-08');
    assert.equal(wi.length, 1);
    assert.ok((await ports.ledger.events({ mission: M, event: 'accepted' })).length === 2, 'the tasks run after the grant');
    assertNoticesHaveWi(ports.ledger.notices);
  });

  it('the same failure twice in a row is no progress: exhausted at once; after the Secretary\'s grant only the user can grant more', async () => {
    const { ports, engine } = await setup();
    const bad = detailedPlan(M, { implProvenance: 'e1' });
    const grants: SecretaryCard[] = [];
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-decompose': () => ({ handBack: architect(bad) }),
        secretary: (t) => {
          const c = t.card as unknown as SecretaryCard;
          grants.push(c);
          return { handBack: secretary(c, c.grantAvailable ? 'grant' : 'ask-user') };
        },
      }),
    );
    assert.equal(grants.length, 2);
    assert.equal(grants[0]?.grantAvailable, true);
    assert.equal(grants[1]?.grantAvailable, false, "the second exhaustion: the Secretary's grant is used");
    const ask = ports.ledger.notices.find((n) => n.category === 'needs-user-decision');
    assert.ok(ask !== undefined && ask.askUser === true);
    // the user grants more; the Architect fixes the plan
    const esc = (ask.detail as { escalation: string }).escalation;
    await answerEscalation(ports, { mission: M, escalation: esc, option: 'grant', grantExtra: 2, words: 'Give it two more tries.' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2);
    assertNoticesHaveWi(ports.ledger.notices);
  });

  it('an order change against the user-specified order goes to the Secretary, not back to the Architect', async () => {
    const ports = fakePorts();
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { order: 'user' }), userWords: ['msg1'] });
    const engine = new FlowEngine(ports);
    const swapped = detailedPlan(M);
    const plan: DetailedPlanDoc = { ...swapped, tasks: swapped.tasks.map((t) => (t.id === 'iface' ? { ...t, provenance: { planElement: 'e2' } } : { ...t, provenance: { planElement: 'e1' } })) };
    let card: SecretaryCard | null = null;
    const ran = await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-decompose': () => ({ handBack: architect(plan) }),
        secretary: (t) => {
          card = t.card as unknown as SecretaryCard;
          return { handBack: secretary(card, 'accept') };
        },
      }),
    );
    assert.equal((card as SecretaryCard | null)?.request.source, 'order-change');
    assert.equal(ran.filter((t) => t.startsWith('arch.')).length, 1);
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2);
  });
});

describe('flow: feasibility review (3.6)', () => {
  it('one return to the Architect; still unresolved → the Secretary accepts the risk, its ruling revokes the negation and the plan is proven', async () => {
    const { ports, engine } = await setup('stable');
    let card: SecretaryCard | null = null;
    const ran = await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-feasibility': (t) => ({ handBack: feasibilityReturn(t.card as unknown as ArchitectFeasibilityCard, 'the parser buffers whole files in memory') }),
        secretary: (t) => {
          card = t.card as unknown as SecretaryCard;
          return { handBack: secretary(card, 'accept-risk', { classification: 'important-within-authority' }) };
        },
      }),
    );
    assert.deepEqual(ran.filter((t) => t.startsWith('arch.') || t.startsWith('feas.')), ['arch.m1.1.1', 'feas.dplan.m1.1.1', 'arch.m1.1.2', 'feas.dplan.m1.1.2']);
    const arch2 = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2');
    assert.ok(arch2.revision?.feasibilityFindings[0]?.includes('buffers whole files'));
    const sc = card as SecretaryCard | null;
    assert.equal(sc?.request.source, 'feasibility-unresolved');
    assert.equal(sc?.position?.review, 'feasibility');
    const labels = await ports.evaluator.labels(['dplan.m1.1.2']);
    assert.equal(labels.labels['dplan.m1.1.2'], 'proven', 'the ruling revokes the feasibility negation (8.1)');
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2);
    assert.ok(ports.ledger.notices.some((n) => n.category === 'secretary-decision'), 'important within authority: the PM is told');
    assert.equal((await engine.reconcile(M))[0]?.passes, 1, 'applied decisions are not re-applied');
  });
});

describe('flow: Calibrator ② (3.7) and the Secretary (3.8, 3.2)', () => {
  it('an escalation that needs the user pauses only the plan; the PM records the user\'s answer and the plan takes effect', async () => {
    const { ports, engine } = await setup('stable');
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        'calibrator-2': (t) => ({ handBack: cal2Escalate(t.card as unknown as Calibrator2Card, 'the module layout fixes a public file format') }),
        secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'ask-user') }),
      }),
    );
    assert.equal((await ports.ledger.events({ mission: M, event: 'effective' })).length, 0);
    const ask = ports.ledger.notices.find((n) => n.category === 'needs-user-decision');
    assert.ok(ask !== undefined && ask.askUser === true && ask.wi === null);
    await answerEscalation(ports, { mission: M, escalation: (ask.detail as { escalation: string }).escalation, option: 'accept', words: 'Yes, that format is fine.' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.equal((await ports.ledger.events({ mission: M, event: 'effective' })).length, 1);
    assert.equal((await ports.evaluator.labels(['dplan.m1.1.1'])).labels['dplan.m1.1.1'], 'proven', "the user's ruling revokes the Calibrator ② negation");
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2);
    assert.equal((await engine.reconcile(M))[0]?.passes, 1);
  });

  it('a send-back from the Secretary returns the plan to the Architect with the instructions', async () => {
    const { ports, engine } = await setup();
    let escalated = false;
    const ran = await drive(
      engine,
      ports.scheduler,
      withKinds({
        'calibrator-2': (t) => {
          const c = t.card as unknown as Calibrator2Card;
          if (!escalated) {
            escalated = true;
            return { handBack: cal2Escalate(c, 'the Architect added a cache nobody asked for') };
          }
          return null;
        },
        secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'send-back', { instructions: 'drop the cache' }) }),
      }),
    );
    assert.ok(ran.includes('arch.m1.1.2'));
    assert.deepEqual(ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2').revision?.instructions, ['drop the cache']);
  });
});

describe('flow: a single-task plan (3.4, 3.6)', () => {
  it('skips the feasibility review and the chain still proves the product (5.2)', async () => {
    const ports = fakePorts();
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!] }), userWords: ['msg1'], mode: 'stable' });
    const engine = new FlowEngine(ports);
    const full = detailedPlan(M);
    const single: DetailedPlanDoc = { ...full, newInterfaces: [], tasks: [{ ...(full.tasks[1] as DetailedPlanDoc['tasks'][number]), implements: [], dependsOn: [], provenance: { planElement: 'e1' } }] };
    const ran = await drive(engine, ports.scheduler, happyScript(M, () => single));
    assert.deepEqual(ran.map((t) => ports.scheduler.card<{ seat: string }>(t).seat), ['calibrator-1', 'architect-decompose', 'calibrator-2', 'constructor', 'reviewer']);
    const acc = await ports.ledger.events<{ product: string }>({ mission: M, event: 'accepted' });
    assert.equal((await ports.evaluator.labels([acc[0]!.body.product])).labels[acc[0]!.body.product], 'proven');
  });
});
