// Execution flows with scripted seat results (no models): design 4.1–4.2, 8.1, 5.6, 6.2, 6.5,
// 3.8, 3.11, and restarting the flow from the memory's state. The flows run on a real project
// memory (4.1: test/flow-memory-fixtures.ts); seats hand back through `mp seat <id> handback`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { WI_CATALOG } from '../src/common/records.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { architect, constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, type Script } from '../src/flow/scripted.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import type { ScriptedOutcome } from '../src/flow/scripted.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { SEED_TEXT } from '../src/flow/scripted.ts';
import { commitStop, dispatchInfo, recordHandback, releaseStop } from '../src/memory/index.ts';
import type { FlowTask } from '../src/flow/ports.ts';

const M = 'm1' as MissionId;

async function setup(mode: 'stable' | 'fast' = 'stable') {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode });
  return { ports, engine: new FlowEngine(ports) };
}

function withKinds(over: Record<string, Script>, plan?: () => DetailedPlanDoc): Script {
  const base = happyScript(M, plan);
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

const accepted = async (ports: ReturnType<typeof memoryPorts>): Promise<string[]> => (await ports.ledger.events({ mission: M, event: 'accepted' })).map((e) => e.line).sort();

describe('flow: cards from detailed-plan tasks (4.2, 8.1)', () => {
  it('the Constructor and Reviewer cards carry the task, the product, the program runs and the contract binding', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const con = ports.scheduler.card<ConstructorCard>('con.m1.impl.1');
    assert.deepEqual(con.workspace.writablePaths, ['src/parser/impl/**'], 'the write paths are the task\'s write scope (4.1 §5.3)');
    assert.deepEqual(con.standards.map((s) => s.id), ['S1', 'S2']);
    assert.deepEqual(con.requirementItems.map((i) => i.text), ['A CSV parser', 'It has tests']);
    assert.equal(con.interfaces.implements[0]?.definition, 'parse(text: string): string[][]');
    const rev = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
    assert.equal(rev.review, 'reviewer');
    assert.equal(rev.verificationRuns.length, 1);
    assert.deepEqual(rev.declaredCommands.map((c) => c.command), ['npm test']);
    assert.deepEqual(ports.ledger.content.getList(rev.binding.reliesOn as never), ['dplan.m1.1.1']);
    assert.equal(ports.ledger.content.getList(rev.binding.bases as never).length, 4, 'two standards and two items, at their current versions');
    // the Constructor of impl waited for iface's acceptance (scheduling dependency) and saw its product
    const order = [...ports.scheduler.tasks.keys()];
    assert.ok(order.indexOf('con.m1.impl.1') > order.indexOf('rev.m1.iface.1'));
  });

  it('fast mode dispatches dependents on acceptance alone; stable mode waits until the inputs are proven', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl']);
    assert.equal((await new FlowEngine(ports).reconcile(M))[0]?.passes, 1, 'settled');
  });
});

describe('flow: the Reviewer rework loop (8.1, 6.5)', () => {
  it('initial + 2 reworks; the third rework exhausts the loop (WI-08 → Secretary grant), the fourth version passes; findings become open issues the next Reviewer answers', async () => {
    const { ports, engine } = await setup();
    const verdicts: Array<{ v: 'rework' | 'pass'; failing?: string; findings?: string[] }> = [
      { v: 'rework', failing: 'S1', findings: ['quoted newlines are dropped'] },
      { v: 'rework', failing: 'S2' },
      { v: 'rework', failing: 'S1' },
      { v: 'pass' },
    ];
    let i = 0;
    const secretaries: SecretaryCard[] = [];
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        reviewer: (t) => {
          const c = t.card as unknown as ReviewerCard;
          if (c.target.includes('iface')) return { handBack: reviewer(c, 'pass') };
          const v = verdicts[i++] ?? { v: 'pass' };
          return { handBack: reviewer(c, v.v, { ...(v.failing !== undefined ? { failing: v.failing } : {}), ...(v.findings ? { findings: v.findings } : {}) }) };
        },
        secretary: (t) => {
          const c = t.card as unknown as SecretaryCard;
          secretaries.push(c);
          return { handBack: secretary(c, 'grant', { grantExtra: 1 }) };
        },
      }),
    );
    const cons = [...ports.scheduler.tasks.keys()].filter((t) => t.startsWith('con.m1.impl.'));
    assert.deepEqual(cons, ['con.m1.impl.1', 'con.m1.impl.2', 'con.m1.impl.3', 'con.m1.impl.4']);
    assert.ok(ports.scheduler.card<ConstructorCard>('con.m1.impl.2').duties.includes('quoted newlines are dropped'), 'the rework card holds the issue list');
    const rev2 = ports.scheduler.card<ReviewerCard>('rev.m1.impl.2');
    assert.equal(rev2.openIssues.length, 1, 'the finding on version 1 is an open issue version 2 answers (5.6)');
    assert.equal(secretaries.length, 1);
    assert.equal(secretaries[0]?.request.source, 'loop-exhausted');
    assert.deepEqual(secretaries[0]?.options.map((o) => o.id), ['grant', 'replan', 'abandon', 'ask-user']);
    assert.equal(ports.ledger.notices.filter((n) => n.wi === 'WI-08').length, 1);
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl']);
    assert.equal((await new FlowEngine(ports).reconcile(M))[0]?.passes, 1, 'settled');
    assertNoticesHaveWi(ports.ledger.notices);
  });

  it('a Secretary re-plan sends the task back to the decision layer; the new plan restarts it at the next attempt', async () => {
    const { ports, engine } = await setup('fast');
    let planVersion = 0;
    const plans = [detailedPlan(M), { ...detailedPlan(M), tasks: detailedPlan(M).tasks.map((t) => (t.id === 'impl' ? { ...t, goal: 'Implement the parser, streaming' } : t)) }];
    let reworks = 0;
    await drive(
      engine,
      ports.scheduler,
      withKinds(
        {
          'architect-decompose': () => ({ handBack: architect(plans[Math.min(planVersion++, 1)] as DetailedPlanDoc) }),
          reviewer: (t) => {
            const c = t.card as unknown as ReviewerCard;
            if (c.target.includes('iface') || planVersion > 1) return { handBack: reviewer(c, 'pass') };
            reworks++;
            return { handBack: reviewer(c, 'rework', { failing: reworks % 2 === 0 ? 'S2' : 'S1' }) };
          },
          secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'replan', { instructions: 'stream the input instead of buffering it' }) }),
        },
      ),
    );
    assert.equal(planVersion, 2, 'the Architect decomposed again');
    const arch2 = ports.scheduler.card<{ revision: { instructions: string[] } }>('arch.m1.1.2');
    assert.ok(arch2.revision.instructions.some((x) => x.includes('stream the input')));
    const cons = [...ports.scheduler.tasks.keys()].filter((t) => t.startsWith('con.m1.impl.'));
    assert.equal(cons.at(-1), 'con.m1.impl.4', 'the re-specified task continues in its lineage at the next attempt');
    assert.equal(ports.scheduler.card<ConstructorCard>('con.m1.impl.4').goal, 'Implement the parser, streaming');
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl']);
    assert.equal((await new FlowEngine(ports).reconcile(M))[0]?.passes, 1, 'settled');
  });
});

describe('flow: escalations from execution (3.8, 3.2)', () => {
  it("the Reviewer's needs-decision goes to the Secretary; an important decision reaches the PM, the user's answer goes into a re-review", async () => {
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
        secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'ask-user') }),
      }),
    );
    assert.deepEqual(await accepted(ports), ['task:iface'], 'impl waits for the decision');
    const ask = ports.ledger.notices.find((n) => n.category === 'needs-user-decision');
    assert.ok(ask !== undefined && ask.askUser === true);
    await answerEscalation(ports, { mission: M, escalation: (ask.detail as { escalation: string }).escalation, option: 'answer', instructions: 'Quoted fields may span lines.', words: 'Yes, multi-line quotes are allowed.' });
    await drive(engine, ports.scheduler, happyScript(M));
    const re = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1.r1');
    assert.ok(re.decisionQuotes.includes('Quoted fields may span lines.'));
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl']);
    assert.equal((await new FlowEngine(ports).reconcile(M))[0]?.passes, 1, 'settled');
  });

  it("the Constructor's questions go to the Secretary without stopping the review", async () => {
    const { ports, engine } = await setup();
    const asked: SecretaryCard[] = [];
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        constructor: (t: FlowTask): ScriptedOutcome | null => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Should empty lines be skipped?'] } : {}) }),
        secretary: (t) => {
          const c = t.card as unknown as SecretaryCard;
          asked.push(c);
          return { handBack: secretary(c, 'answer', { instructions: 'Skip empty lines.' }) };
        },
      }),
    );
    assert.equal(asked[0]?.request.source, 'constructor-decision');
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl']);
    assert.equal((await new FlowEngine(ports).reconcile(M))[0]?.passes, 1, 'settled');
  });

  it('an interrupted Constructor dispatch is released and dispatched again (decision 15: 2 times); then WI-08 and the Secretary; past its grant the user decides', async () => {
    const { ports, engine } = await setup();
    let releases = 0;
    const secretaries: SecretaryCard[] = [];
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        constructor: (t: FlowTask): ScriptedOutcome | null => (t.task === 'con.m1.iface.1' && releases++ < 6 ? { release: 'abandoned' } : { handBack: constructorDone() }),
        secretary: (t) => {
          const c = t.card as unknown as SecretaryCard;
          secretaries.push(c);
          return { handBack: c.grantAvailable ? secretary(c, 'grant', { grantExtra: 1 }) : secretary(c, 'ask-user') };
        },
      }),
    );
    // three dispatches released: the third exhausts the loop; the Secretary grants once; exhausted again, only the user can add more
    assert.equal(secretaries.length, 2);
    assert.equal(secretaries[1]?.grantAvailable, false);
    assert.equal(secretaries[0]?.request.source, 'loop-exhausted');
    assert.deepEqual(secretaries[0]?.options.map((o) => o.id), ['grant', 'replan', 'abandon', 'ask-user']);
    assert.ok(ports.ledger.notices.some((n) => n.wi === 'WI-08' && n.category === 'loop-exhausted'));
    const toUser = ports.ledger.notices.find((n) => n.category === 'needs-user-decision');
    assert.ok(toUser !== undefined && toUser.askUser === true, 'past the Secretary\'s grant the user decides');
    assert.deepEqual(await accepted(ports), []);
    await answerEscalation(ports, { mission: M, escalation: (toUser.detail as { escalation: string }).escalation, option: 'abandon', words: 'Drop it.' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.equal((await ports.ledger.events({ mission: M, event: 'abandoned' })).length, 1);
    assertNoticesHaveWi(ports.ledger.notices);
  });
});

describe('flow: restart from ledger state (6.1, 4.1)', () => {
  it('a new engine on the same ledger and queue continues mid-way, repeating nothing; a lost write is retried', async () => {
    const { ports, engine } = await setup();
    // run until the first Constructor is queued, then "crash"
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null }));
    assert.ok(ports.scheduler.queued('constructor').length === 1);
    const before = ports.ledger.appended.length;
    // a restarted flow: nothing new happens until a result arrives
    const engine2 = new FlowEngine(ports);
    await engine2.reconcile(M);
    assert.equal(ports.ledger.appended.length, before, 'a restarted flow repeats nothing');
    // the product write is lost once (transient): the next reconciliation does it
    ports.ledger.failNext = (op) => op.startsWith('flow:product:m1:');
    await ports.scheduler.run('con.m1.iface.1', { handBack: constructorDone() });
    const r = await engine2.reconcile(M);
    assert.equal(r[0]?.errors.length, 1);
    assert.equal(ports.ledger.notices.length, 0, 'a transient error is not a program defect');
    await drive(new FlowEngine(ports), ports.scheduler, happyScript(M));
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl']);
    assert.equal((await new FlowEngine(ports).reconcile(M))[0]?.passes, 1, 'settled');
    const products = await ports.ledger.events({ mission: M, event: 'product' });
    assert.equal(products.length, 2, 'one product version per attempt, even after the lost write');
    const attempts = await ports.ledger.events({ mission: M, event: 'attempt' });
    assert.equal(attempts.length, 1);
  });
});

describe('flow: every exception names its WI (3.11)', () => {
  it('a Secretary that cannot decide hands the decision to the PM (WI-24); a stopped decision-layer seat waits (WI-26); a malformed acceptance is a defect (WI-20)', async () => {
    const { ports, engine } = await setup();
    // Calibrator ①'s hand-back arrives after a stop (recorded, not accepted): nothing the program can carry out → WI-26, the plan waits
    await engine.reconcile(M);
    await ports.scheduler.run('cal1.m1.1', {
      handBack: {},
      before: () => ports.memory.write({ stop: true }, (tx) => commitStop(tx, { stop: 'st1' as never, scope: { kind: 'mission', mission: M }, words: 'stop', at: 1 })),
    } as never);
    ports.memory.write({}, (tx) => releaseStop(tx, 'st1' as never));
    await engine.reconcile(M);
    assert.ok(ports.ledger.notices.some((n) => n.wi === 'WI-26'));
    // a new batch after the stop: Calibrator ② escalates, the Secretary's seat fails → WI-24
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { goalsBeyond: ['later: a CLI'] }), userWords: ['W-1'] });
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        'calibrator-2': (t) => ({ handBack: { mappings: [], supplements: [], verdict: 'escalate', escalation: 'x' } as never }),
        secretary: () => ({ release: 'ended' }),
      }),
    ).catch(() => undefined);
    // (the scripted escalate above is refused by the program's rules: the Calibrator must judge every focus element)
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        'calibrator-2': (t) => {
          const c = t.card as unknown as import('../src/seat/cards/calibrator.ts').Calibrator2Card;
          return { handBack: { mappings: c.focus.filter((f) => c.elements.find((e) => e.id === f)?.mapsTo).map((f) => ({ element: f, faithful: false, reason: 'narrowed' })), supplements: c.focus.filter((f) => !c.elements.find((e) => e.id === f)?.mapsTo).map((f) => ({ element: f, finding: 'detail' as const, reason: 'ok' })), verdict: 'escalate', escalation: 'a mapping narrows the user goal' } };
        },
        secretary: () => ({ release: 'ended' }),
      }),
    );
    const undecided = ports.ledger.notices.find((n) => n.category === 'secretary-undecided');
    assert.ok(undecided !== undefined && undecided.wi === 'WI-24' && undecided.askUser === true);
    assertNoticesHaveWi(ports.ledger.notices);
  });

  it('an accepted Constructor hand-back without its candidate is a program defect (WI-20): only that task waits', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null }));
    // a hand-back recorded without the candidate (a defect: mp seat handback always collects one)
    const d = ports.scheduler.dispatchOf('con.m1.iface.1');
    ports.memory.write({ op: `defect:${d}`, payload: d }, (tx) =>
      recordHandback(tx, { dispatch: d, report: 'done', result: { format: 'mp41.handback.v1', kind: 'handed-back', seat: 'x', fields: constructorDone(), records: [], candidate: null, request: null, notes: null, runs: [] } }),
    );
    assert.equal(ports.memory.read((db) => dispatchInfo(db, d))?.handback, 'accepted');
    await engine.reconcile(M);
    const n = ports.ledger.notices.find((x) => x.category === 'flow-internal-error');
    assert.ok(n !== undefined && n.wi === 'WI-20');
    assert.equal((await ports.ledger.events({ mission: M, event: 'product' })).length, 0);
    assertNoticesHaveWi(ports.ledger.notices);
  });

  it('a re-plan that drops a task while its seat runs: the attempt finishes, queued work is cancelled (WI-23)', async () => {
    const { ports, engine } = await setup('fast');
    let planVersion = 0;
    const withDocs = detailedPlan(M, { extraTask: true });
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-decompose': () => ({ handBack: architect(planVersion++ === 0 ? withDocs : detailedPlan(M)) }),
        constructor: (t: FlowTask): ScriptedOutcome | null => (t.task.startsWith('con.m1.docs') ? null : { handBack: constructorDone() }),
      }),
    );
    const docs = ports.scheduler.tasks.get('con.m1.docs.1');
    assert.ok(docs !== undefined);
    ports.scheduler.dispatchOf('con.m1.docs.1'); // the docs Constructor is running when the plan changes
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] }), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, withKinds({ 'architect-decompose': () => ({ handBack: architect(detailedPlan(M)) }) }));
    const n = ports.ledger.notices.find((x) => x.wi === 'WI-23');
    assert.ok(n !== undefined, 'the PM is told about work in flight on a dropped task');
    assert.equal((await ports.ledger.events({ mission: M, line: 'task:docs', event: 'dropped' })).length, 1);
    assertNoticesHaveWi(ports.ledger.notices);
  });
});

describe('flow: re-plan questions and 3.2 routing', () => {
  it('a requirement withdrawn after acceptance: the Secretary judges whether to re-plan (6.2)', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, happyScript(M));
    const { withdrawItem } = await import('../src/flow/requirements.ts');
    await withdrawItem(ports, { mission: M, item: 's1', reason: 'the user no longer wants tests' });
    let asked: SecretaryCard | null = null;
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        secretary: (t) => {
          asked = t.card as unknown as SecretaryCard;
          return { handBack: secretary(asked, 'accept') };
        },
      }),
    );
    const a = asked as SecretaryCard | null;
    assert.equal(a?.request.source, 'replan');
    assert.equal(a?.request.subject, 'task:impl', 'only the task resting on the withdrawn item');
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl']);
    assert.equal((await new FlowEngine(ports).reconcile(M))[0]?.passes, 1, 'settled');
  });

  it('3.2: conflicts and deliverable changes go to the user; unclear reversibility counts as irreversible; reversible details may be noted', async () => {
    const { routeDecision } = await import('../src/flow/requirements.ts');
    assert.deepEqual(routeDecision({ changesDeliverable: false, reversible: 'yes', conflictsWithUser: true, userMayCare: false }), { kind: 'user', why: 'conflict', pause: true });
    assert.deepEqual(routeDecision({ changesDeliverable: true, reversible: 'yes', conflictsWithUser: false, userMayCare: false }), { kind: 'user', why: 'deliverable', pause: true });
    assert.deepEqual(routeDecision({ changesDeliverable: false, reversible: 'unclear', conflictsWithUser: false, userMayCare: false }), { kind: 'user', why: 'irreversible', pause: true });
    assert.deepEqual(routeDecision({ changesDeliverable: false, reversible: 'yes', conflictsWithUser: false, userMayCare: true }), { kind: 'detail', mayMatter: true });
  });
});
