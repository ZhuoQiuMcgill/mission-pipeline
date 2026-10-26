// An exploration planned after others (design 3.10, 4.3; src/flow/exploration/predecessors.ts):
// its PM plan element's "after" names explorations whose work it builds on. The cards of the seats
// that know it (the author, the interpreter, the Crititor, the Stabilizer) carry, for each of them,
// the hand-off of its settle and its latest version (with the one it settled on when that is an
// earlier one): must-read for the author, readable for the others, never on a blind executor's
// card. The list comes from the plan in effect, and the claim selects it again, so a card queued
// before a predecessor settled reads its hand-off. Its first step waits, held in `mp pm next`,
// until they settled (src/process/explorationAfter.ts); an exploration already started is not held.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { xid } from '../src/flow/exploration/definition.ts';
import { explorationStep } from '../src/flow/exploration/step.ts';
import { EXPLORATION_SETTLED, PLAN_LINE, PM_PLAN_EFFECTIVE, SECRETARY_LINE, type ExplorationSettledBody, type PmPlanDoc, type PmPlanEffectiveBody } from '../src/flow/plandoc.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { ProcessError } from '../src/process/errors.ts';
import { pmDispatch, readSteps } from '../src/process/pm.ts';
import { dispatchView, seatRead } from '../src/process/seat.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard, InterpreterCard, RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { attack, blind, finding, reviseAll, stabilizeAll, submit, RUN_PLACEHOLDER } from './flow-exploration-fixtures.ts';
import { memoryPorts } from './flow-memory-fixtures.ts';

const M = 'M1' as MissionId;

type Element = PmPlanDoc['elements'][number];

/** An exploration element of the plan. */
function explore(id: string, x: string, after: string[] = [], rounds = 6, research = false): Element {
  return {
    id,
    kind: 'exploration',
    text: `the design of ${x}`,
    provenance: { by: 'pm' },
    exploration: { id: x, deliverable: `a design of ${x}`, fuzzyGoal: { quote: 'no obvious hole', words: 'W-1' }, attackScope: ['internal contradiction'], decision: { id: `D-${x}`, type: 'structure' }, budget: { rounds, micros: null }, stop: '', research },
    after,
    items: [],
  };
}

const REQUEST = { steps: ['run `node probe.js`'], data: 'fixture: probe.json', measure: ['result status'], assertions: ['the status is "ok"'] };

async function planned(elements: Element[]) {
  const p = memoryPorts();
  const ports = { ledger: p.ledger, scheduler: p.scheduler, evaluator: p.evaluator };
  let plans = 0;
  /** A PM plan version taking effect, as the decision layer records it once Calibrator ① passed it. */
  const effective = async (els: Element[]) => {
    const n = ++plans;
    const doc: PmPlanDoc = { format: 'mp4.pm-plan.v1', mission: M, round: n, order: 'free', elements: els, goalsBeyond: [], authorizations: [] };
    const body: PmPlanEffectiveBody = { plan: `pmplan.${n}`, batch: `b${n}`, round: n, doc: p.ledger.content.put(JSON.stringify(doc)), explorations: els.flatMap((e) => (e.exploration ? [e.exploration.id] : [])) };
    await p.ledger.append(`pm-effective-${n}`, { events: [{ mission: M, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE, key: `pmplan.${n}`, body }] });
  };
  await effective(elements);
  // passes until one makes no progress, as the flow engine does
  const step = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      const ctx = flowCtx(ports, M);
      await explorationStep(ctx);
      if (!ctx.progressed) break;
    }
  };
  /** The one queued task of a kind of exploration x (its own lineage or one of its evidence executions'); `claimed`: or its dispatch in flight. */
  const one = (x: string, kind: string, claimed = false): FlowTask => {
    const own = xid.lineage(M, x);
    const q = [...p.scheduler.tasks.values()]
      .filter((t) => (t.state === 'queued' || (claimed && t.state === 'running')) && t.spec.card.seat === kind && (t.spec.lineage === own || t.spec.lineage.startsWith(`${own}.ev`)))
      .map((t) => t.spec);
    assert.equal(q.length, 1, `one queued ${kind} of ${x}: ${q.map((t) => t.task).join(', ')}`);
    return q[0]!;
  };
  /** The card as its dispatch claimed it (the task claimed now, or its dispatch in flight). */
  const claimed = <C>(t: FlowTask): C => dispatchView(p.ctx, p.scheduler.dispatchOf(t.task)).card as unknown as C;
  /** Hand back a queued task as its seat would (every material page read); an author's round and a passed attack are stabilized by default. */
  const hand = async (x: string, kind: string, r: unknown): Promise<FlowTask> => {
    const t = one(x, kind, true);
    let fields = r;
    if (kind === 'constructor-experiment') fields = JSON.parse(JSON.stringify(r).split(RUN_PLACEHOLDER).join(`run:${p.scheduler.rerun(p.scheduler.dispatchOf(t.task), 'step')}`));
    assert.deepEqual(await p.scheduler.run(t.task, { handBack: fields }), []);
    await step();
    if (kind === 'researcher-author' || kind === 'crititor') {
      const st = p.scheduler.queued('stabilizer').find((q) => q.lineage === xid.lineage(M, x));
      if (st !== undefined) {
        assert.deepEqual(await p.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
        await step();
      }
    }
    return t;
  };
  const settled = async (x: string) => (await p.ledger.events<ExplorationSettledBody>({ mission: M, line: xid.line(x), event: EXPLORATION_SETTLED })).at(-1)?.body ?? null;
  return { ...p, ports, effective, step, one, claimed, hand, settled };
}

const after = (ms: readonly MaterialRef[]) => ms.filter((m) => m.id.startsWith('after-'));
const byId = (ms: readonly MaterialRef[], id: string) => ms.find((m) => m.id === id);

describe('an exploration planned after others', () => {
  test("its first step is held until they settle; its claimed card then carries their hand-off and latest version, must-read for the author and served by mp seat read", async () => {
    const w = await planned([explore('elA', 'A'), explore('elB', 'B', ['elA'])]);
    await w.step();
    const bt = w.one('B', 'researcher-author');
    // held in mp pm next with the explorations it waits for; A's author is ready
    const steps = readSteps(w.ctx);
    assert.deepEqual(steps.ready.map((r) => r.step), [w.one('A', 'researcher-author').task]);
    const held = steps.held.find((h) => h.step === bt.task);
    assert.ok(held, 'B\'s first step is held');
    assert.match(held.why, /^exploration B waits for A \(not settled\) to settle: element elB of PM plan pmplan\.1 places it after A/);
    assert.throws(() => pmDispatch(w.ctx, bt.task, { filledBy: 'test-harness/scripted' }), (e: unknown) => e instanceof ProcessError && e.code === 'NOT_READY' && /waits for A/.test(e.message));
    assert.deepEqual(after((bt.card as unknown as AuthorCard).materials), [], 'nothing of A yet');

    // A converges: its author's version, the attack, the closing attacker
    await w.hand('A', 'researcher-author', submit('design A v1'));
    assert.ok(readSteps(w.ctx).held.some((h) => h.step === bt.task), 'still held while A runs');
    await w.hand('A', 'crititor', attack());
    await w.hand('A', 'crititor', attack());
    const s = await w.settled('A');
    assert.equal(s?.outcome, 'conclusion');
    assert.ok(readSteps(w.ctx).ready.some((r) => r.step === bt.task), 'ready once A settled');

    // queued before A settled, the card gets A's hand-off at its claim
    const queued = w.one('B', 'researcher-author').card as unknown as AuthorCard;
    assert.deepEqual(after(queued.materials), [], 'built when A had nothing to hand on');
    const card = w.claimed<AuthorCard>(bt);
    assert.deepEqual(after(card.materials).map((m) => [m.id, m.mustRead]), [['after-A-handoff', true], ['after-A-latest', true]]);
    assert.match(byId(card.materials, 'after-A-handoff')!.title, /^Exploration A, planned before this one: its hand-off \(settled: conclusion, converged, on xpv\.M1\.A\./);
    assert.match(byId(card.materials, 'after-A-latest')!.title, /its latest version xpv\.M1\.A\.\S+ \(the version it settled on\)$/);
    // must read: a hand-back that skipped A's hand-off is refused
    const unread = new Set(card.materials.filter((m) => m.id !== 'after-A-handoff').flatMap((m) => Array.from({ length: m.pages }, (_, i) => `${m.id}#${i + 1}`)));
    const problems = await w.scheduler.run(bt.task, { handBack: submit('design B v1'), materialsRead: unread });
    assert.ok(problems.some((x) => x.includes('must-read page after-A-handoff#1 was not read')), problems.join('; '));
    // mp seat read serves it: A's settle and the hand-off of the stop it settled on
    const d = w.scheduler.dispatchOf(bt.task);
    const handoff = seatRead(w.ctx, d, 'after-A-handoff');
    assert.equal(handoff.mustRead, true);
    const doc = JSON.parse(handoff.text.slice(handoff.text.indexOf('\n') + 1)) as { exploration: string; settled: ExplorationSettledBody; handoff: { format: string; version: { id: string } } };
    assert.equal(doc.exploration, 'A');
    assert.deepEqual(doc.settled, s);
    assert.equal(doc.handoff.format, 'mp4.exploration-handoff.v1');
    assert.equal(doc.handoff.version.id, s?.artifact);
    assert.ok(seatRead(w.ctx, d, 'after-A-latest').text.endsWith('\ndesign A v1'));
    assert.deepEqual(await w.scheduler.run(bt.task, { handBack: submit('design B v1') }), [], 'accepted once read');
  });

  test("a blind executor gets nothing of them; the Crititor and the Stabilizer may read them; a continued author must", async () => {
    const w = await planned([explore('elA', 'A'), explore('elB', 'B', ['elA'])]);
    await w.step();
    await w.hand('A', 'researcher-author', submit('design A v1'));
    await w.hand('A', 'crititor', attack());
    await w.hand('A', 'crititor', attack());
    assert.equal((await w.settled('A'))?.outcome, 'conclusion');

    // B's author asks for evidence: the run is blind
    const bt = w.one('B', 'researcher-author');
    await w.scheduler.run(bt.task, { evidence: REQUEST, notes: 'where I was' });
    await w.step();
    const xt = w.one('B', 'constructor-experiment');
    const ex = xt.card as unknown as ExperimentCard;
    assert.deepEqual(ex.materials, []);
    assert.deepEqual(w.claimed<ExperimentCard>(xt).materials, []);
    assert.ok(!JSON.stringify(w.claimed<ExperimentCard>(xt)).includes('after-A'), 'no material of A reaches a blind card');
    await w.hand('B', 'constructor-experiment', blind(ex));

    // the author continues on a card built now: A's materials, must-read; the claim selects the same
    const at = w.one('B', 'researcher-author');
    const author = at.card as unknown as AuthorCard;
    assert.equal(author.continuation?.previous, bt.task);
    assert.deepEqual(after(author.materials).map((m) => [m.id, m.mustRead]), [['after-A-handoff', true], ['after-A-latest', true]]);
    assert.deepEqual(w.claimed<AuthorCard>(at), author);
    await w.hand('B', 'researcher-author', submit('design B v1'));

    // the Crititor may read them
    const ct = w.one('B', 'crititor');
    const crititor = ct.card as unknown as CrititorCard;
    assert.deepEqual(after(crititor.materials).map((m) => [m.id, m.mustRead]), [['after-A-handoff', false], ['after-A-latest', false]]);
    assert.deepEqual(w.claimed<CrititorCard>(ct), crititor);
    assert.deepEqual(await w.scheduler.run(ct.task, { handBack: attack([finding('serious', 'internal contradiction', 'two rules')]) }), []);
    await w.step();
    const b2 = w.one('B', 'researcher-author').card as unknown as AuthorCard;
    assert.deepEqual(await w.scheduler.run(w.one('B', 'researcher-author').task, { handBack: submit('design B v2', reviseAll(b2)) }), []);
    await w.step();
    // and so may the Stabilizer
    const st = w.one('B', 'stabilizer');
    const stab = st.card as unknown as StabilizerCard;
    assert.deepEqual(after(stab.materials).map((m) => [m.id, m.mustRead]), [['after-A-handoff', false], ['after-A-latest', false]]);
    assert.deepEqual(w.claimed<StabilizerCard>(st), stab);
  });

  test("a research exploration: its registered attempts run blind without them; its interpreter may read them", async () => {
    const w = await planned([explore('elA', 'A'), explore('elB', 'B', ['elA'], 6, true)]);
    await w.step();
    await w.hand('A', 'researcher-author', submit('design A v1'));
    await w.hand('A', 'crititor', attack());
    await w.hand('A', 'crititor', attack());
    assert.equal((await w.settled('A'))?.outcome, 'conclusion');
    const attempt: RegisteredAttemptT = { id: 'T1', kind: 'experiment', purpose: 'does it hold', steps: ['run probe.sh'], data: '', measure: ['count'], assertions: [] };
    await w.hand('B', 'researcher-author', submit('method v1', [], { attempts: [attempt] }));
    await w.hand('B', 'crititor', attack());
    const xt = w.one('B', 'constructor-experiment');
    assert.equal((xt.card as unknown as ExperimentCard).evidence.attempt, 'T1');
    assert.deepEqual(w.claimed<ExperimentCard>(xt).materials, []);
    await w.hand('B', 'constructor-experiment', blind(xt.card as unknown as ExperimentCard));
    const it = w.one('B', 'researcher-interpreter');
    const ic = it.card as unknown as InterpreterCard;
    assert.deepEqual(after(ic.materials).map((m) => [m.id, m.mustRead]), [['after-A-handoff', false], ['after-A-latest', false]]);
    assert.deepEqual(w.claimed<InterpreterCard>(it), ic);
  });

  test('a predecessor that settled on an earlier version: the latest is labelled so, and the one it settled on is readable', async () => {
    const w = await planned([explore('elA', 'A', [], 1), explore('elB', 'B', ['A'])]);
    await w.step();
    await w.hand('A', 'researcher-author', submit('design A v1'));
    await w.hand('A', 'crititor', attack([finding('serious', 'internal contradiction', 'two rules')]));
    const a2 = w.one('A', 'researcher-author').card as unknown as AuthorCard;
    await w.hand('A', 'researcher-author', submit('design A v2', reviseAll(a2)));
    // the budget is used: the user accepts the attacked version with its finding as a residual risk
    const esc = (await w.ledger.events<{ id: string; source: string }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).find((e) => e.body.source === 'exploration-budget');
    assert.ok(esc);
    await answerEscalation(w.ports, { mission: M, escalation: esc.body.id, option: 'accept-risk', words: 'take it with that risk' });
    await w.step();
    const s = await w.settled('A');
    assert.equal(s?.stop, 'budget');
    const v1 = s?.artifact as string;

    // an "after" entry may name the exploration itself: B starts, and its card names both versions
    const card = w.claimed<AuthorCard>(w.one('B', 'researcher-author'));
    assert.deepEqual(after(card.materials).map((m) => [m.id, m.mustRead]), [['after-A-handoff', true], ['after-A-latest', true], ['after-A-settled', false]]);
    assert.match(byId(card.materials, 'after-A-handoff')!.title, new RegExp(`settled: conclusion, budget, on ${v1.replace(/\./g, '\\.')}\\)$`));
    assert.match(byId(card.materials, 'after-A-latest')!.title, new RegExp(`its latest version (\\S+) \\(it settled on the earlier version ${v1.replace(/\./g, '\\.')}\\)$`));
    assert.equal(w.ledger.content.get(byId(card.materials, 'after-A-latest')!.ref), 'design A v2');
    assert.equal(w.ledger.content.get(byId(card.materials, 'after-A-settled')!.ref), 'design A v1');
    assert.equal(byId(card.materials, 'after-A-settled')!.title, `Exploration A, planned before this one: version ${v1}, the one it settled on (not its latest)`);
  });

  test('an exploration planned after none: never held, and its cards are as they were (the claim changes nothing)', async () => {
    const w = await planned([explore('elA', 'A'), explore('elB', 'B', ['elA']), explore('elC', 'C')]);
    await w.step();
    const ct = w.one('C', 'researcher-author');
    assert.ok(readSteps(w.ctx).ready.some((r) => r.step === ct.task));
    const queued = ct.card as unknown as AuthorCard;
    assert.deepEqual(after(queued.materials), []);
    const claimed = w.claimed<AuthorCard>(ct);
    assert.equal(canonicalJson(claimed), canonicalJson(queued));
    await w.hand('C', 'researcher-author', submit('design C v1'));
    const c = w.one('C', 'crititor');
    assert.deepEqual(after((c.card as unknown as CrititorCard).materials), []);
    assert.equal(canonicalJson(w.claimed<CrititorCard>(c)), canonicalJson(c.card));
  });

  test('a later plan that places a started exploration after another holds nothing; its next cards carry the materials', async () => {
    const w = await planned([explore('elA', 'A'), explore('elD', 'D')]);
    await w.step();
    await w.hand('A', 'researcher-author', submit('design A v1'));
    await w.hand('D', 'researcher-author', submit('design D v1'));
    const dc = w.one('D', 'crititor');
    assert.deepEqual(after((dc.card as unknown as CrititorCard).materials), []);
    // the next plan version places D after A, which has not settled
    await w.effective([explore('elA', 'A'), explore('elD', 'D', ['elA'])]);
    await w.step();
    assert.ok(readSteps(w.ctx).ready.some((r) => r.step === dc.task), 'D was started: not held');
    // its queued card gets A's latest version at the claim; A has not settled, so there is no hand-off yet
    const card = w.claimed<CrititorCard>(dc);
    assert.deepEqual(after(card.materials).map((m) => [m.id, m.mustRead]), [['after-A-latest', false]]);
    assert.match(byId(card.materials, 'after-A-latest')!.title, /\(it has not settled\)$/);
  });
});
