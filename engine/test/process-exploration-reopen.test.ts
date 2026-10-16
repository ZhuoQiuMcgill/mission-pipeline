// The reopened exploration as a first-class state (code review r1 #3 carried through; stab8's
// maintainer item): a converged exploration whose experiment ran under another environment
// identity is reopened by a rerun (the same request, blind), and the same position judges the
// version again (the attacker's re-check, then its Stabilizer). Every exit of the reopened state
// ends in exactly one of: a settle (the current one: one per opening), an open escalation to the
// Secretary, or a step that is ready or in flight. Never "stopped with nothing pending".
//
// Real process, real git (as process-exploration.test.ts and cli-layers.test.ts):
//   a  the re-check passes                        → settled again on the same version (proven again)
//   b  the re-check refutes, the author revises,  → settled on the new version; the decision layer
//      it converges again                           re-plans from it; the product is proven
//   c  the re-check refutes and the rounds run out → budget-exhausted → the Secretary: grant (more
//                                                    rounds), accept-risk (settled), abandon (settled,
//                                                    no conclusion)
//   d  the Stabilizer judges the re-check round    → the Secretary asks, the user gives it up → settled
//      drifting                                     as no conclusion; the decision layer hears it
//   e  the rerun's evidence execution is given up  → the Secretary (WI-28/WI-08) abandons it: a failed
//      (its dispatches released until exhausted);   record, the re-check goes on; a given-up attacker
//      the re-check attacker's task given up        turn → the WI-28 stop escalation → restart
//   f  a second environment change while the       → reopened again before settling; settles once
//      re-check runs                                 after the second re-check
//   g  a PM plan revises the exploration while it  → redefined (not refused): it is not settled while
//      is reopened (and while it is settled)         reopened; refused with a notice while settled; a
//                                                    stop it reopens has its escalation superseded

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { resolveSubtasks } from '../src/cli/layers.ts';
import { buildGraph } from '../src/cli/tree.ts';
import type { MissionId } from '../src/common/ids.ts';
import { setLabelBatchLimit, type EnvironmentParts } from '../src/evaluator/index.ts';
import { flowCtx } from '../src/flow/context.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { fold, pendingTasks, settleKey, settleSince, type XEvent, type XState } from '../src/flow/exploration/machine.ts';
import { currentSettle, settledArtifactProven } from '../src/flow/exploration/step.ts';
import { PLAN_LINE } from '../src/flow/plandoc.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { openEscalations } from '../src/flow/secretary.ts';
import { assertExits as exitsOf, drained, frontier, seedFanout, sweepThenClean } from './exploration-exits.ts';
import { pmAnswer, pmClose, pmDispatch, pmMission, pmNext, pmPlan, pmRelease, pmRequirement, pmSay, readSteps } from '../src/process/index.ts';
import { dispatchView, recordEvidenceRequest, seatCheckout, seatRerun } from '../src/process/seat.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { addDetailedPlan, ENV_B, handBack, processProject, readAll, readyOf, step, type ProcessProject } from './process-fixtures.ts';

const ENV_C: EnvironmentParts = { os: 'thirdos', osVersion: '3', arch: 'riscv64', versions: { 'node --version': 'v22' } };
const PROBE = { files: { 'probe.js': "console.log('status: ok');\n" } };
const X = 'X1';

// ---------------------------------------------------------------- seats (scripted hand-backs)

const STABILIZE = (c: StabilizerCard) => ({ findings: c.findings.map((f) => ({ finding: f.id, verdict: 'in-scope', severity: 'serious', reason: 'checked', question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } });
const DRIFTING = (c: StabilizerCard) => ({ ...STABILIZE(c), round: { verdict: 'drifting', reason: 'moved away from the question', question: 'is the question still the same?' } });
/** The attacker's re-checks: each finding due resolved or not, citing the rebuttal's current record (after a rerun, its replacement). */
const RECHECK = (resolved: 'yes' | 'no') => (c: CrititorCard) => ({
  findings: [],
  rechecks: c.priorFindings
    .filter((f) => f.status === 'awaiting-recheck')
    .map((f) => ({ finding: f.id, resolved, reason: resolved === 'yes' ? 'the run covers it' : 'still there on this machine', evidence: f.disposition?.evidence !== undefined && f.disposition.evidence !== null ? [f.disposition.evidence] : [] })),
  settled: [],
  reply: 'ok',
});
const REVISE = (n: number) => (c: AuthorCard) => ({ step: 'submit', message: `v${n}`, artifact: `v${n}: an LFU cache, take ${n}`, dispositions: c.openFindings.map((f) => ({ finding: f.id, action: 'revise', note: 'changed' })), directionQuestions: [], attempts: [] });
const SECRETARY = (option: string, grantExtra = 0) => () => ({ option, classification: option === 'ask-user' ? 'needs-user' : 'detail', authorization: null, reason: `the Secretary decides: ${option}`, instructions: '', grantExtra, notice: option === 'ask-user' ? 'ask the user' : '', mayMatter: false });

/** The one ready experiment: dispatched, its command run in its worktree, handed back citing the run. */
async function experiment(p: ProcessProject): Promise<void> {
  const s = await readyOf(p.ctx, 'constructor-experiment');
  const d = pmDispatch(p.ctx, s.step);
  readAll(p.ctx, d.dispatch);
  await seatCheckout(p.ctx, d.dispatch);
  const run = await seatRerun(p.ctx, d.dispatch, 'probe');
  const card = dispatchView(p.ctx, d.dispatch).card as unknown as { steps: string[]; measure: string[]; assertions: string[] };
  const ptr = `run:${run.run}`;
  const a = await handBack(p.ctx, d.dispatch, { steps: card.steps.map((_, i) => ({ step: i + 1, done: 'yes', note: 'done' })), measurements: card.measure.map((x) => ({ measure: x, value: 'ok', source: `stdout of ${ptr}` })), assertions: card.assertions.map((_, i) => ({ assertion: i + 1, holds: 'yes', basis: `exit code of ${ptr}` })), observations: '' });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
}

type Seat = 'stabilizer' | 'crititor' | 'researcher-author' | 'constructor-experiment';

/** The exploration's ready steps handed back by `seats`, until none of theirs is ready; the kinds in order. */
async function drive(p: ProcessProject, seats: Partial<Record<Seat, (c: any) => unknown>>, max = 14): Promise<string[]> {
  const seq: string[] = [];
  for (let i = 0; i < max; i++) {
    const r = (await pmNext(p.ctx)).ready.find((x) => Object.hasOwn(seats, x.kind));
    if (r === undefined) break;
    seq.push(r.kind);
    if (r.kind === 'constructor-experiment') await experiment(p);
    else await step(p.ctx, r.kind, seats[r.kind as Seat]!);
  }
  return seq;
}

// ---------------------------------------------------------------- the invariant

/** The exits of the exploration X1 (test/exploration-exits.ts). */
const assertExits = (p: ProcessProject, m: string, tag: string): Promise<XState> => exitsOf(p, m, X, tag);

// ---------------------------------------------------------------- setup

/**
 * A mission whose exploration X1 (structure decision D1) rests on an experiment (`node probe.js`):
 * the author's rebuttal cites the run, the re-check confirms it, the closing attacker passes; it
 * converges after 3 rounds and settles. `waiting`: a deliverable e1 waits for X1, and the decision
 * layer plans it after X1 stood (the Architect, Calibrator ②: effective).
 */
async function convergedOnExperiment(p: ProcessProject, m: string, o: { rounds: number; waiting?: boolean; type?: 'structure' | 'direction' }): Promise<{ readonly evidence: string; readonly words: string; readonly plan: (round: number, change?: Record<string, unknown>) => Record<string, unknown> }> {
  pmMission(p.ctx, m);
  const w = pmSay(p.ctx, `Find a cache design with no obvious logical hole, then an add function built on it. The details are yours to decide. (${m})`).words;
  await pmRequirement(p.ctx, { mission: m, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
  if (o.waiting === true) await pmRequirement(p.ctx, { mission: m, item: 'g1', type: 'goal', text: 'An add function', quote: 'an add function', words: w });
  const plan = (round: number, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    format: 'mp4.pm-plan.v1',
    mission: m,
    round,
    order: 'free',
    elements: [
      {
        id: 'x',
        kind: 'exploration',
        text: 'Design the cache',
        provenance: { by: 'user', words: w, quote: 'Find a cache design' },
        exploration: { id: X, deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: o.type ?? 'structure' }, budget: { rounds: o.rounds, micros: null }, stop: '', research: false, ...change },
        after: [],
        items: [],
      },
      ...(o.waiting === true ? [{ id: 'e1', kind: 'deliverable', text: 'An add function with a check', provenance: { by: 'user', words: w, quote: 'an add function' }, after: [X], items: ['g1'] }] : []),
    ],
    goalsBeyond: [],
    authorizations: ['a1'],
  });
  await pmPlan(p.ctx, { mission: m, words: [w], plan: plan(1) });
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  // the author asks for an experiment first
  const s = await readyOf(p.ctx, 'researcher-author');
  const d = pmDispatch(p.ctx, s.step);
  readAll(p.ctx, d.dispatch);
  const a = await recordEvidenceRequest(p.ctx, d.dispatch, { request: { steps: ['run the probe'], data: 'the repository', measure: ['status'], assertions: ['the probe prints a status'], executor: 'experiment', commands: [{ id: 'probe', command: 'node probe.js' }] }, notes: 'need a run' });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  await experiment(p);
  let evidence = '';
  await step(p.ctx, 'researcher-author', (c) => {
    evidence = c.evidence[0].id;
    return { step: 'submit', message: 'v1', artifact: 'v1: an LRU cache', dispositions: [], directionQuestions: [], attempts: [] };
  });
  await step(p.ctx, 'crititor', () => ({ findings: [{ severity: 'serious', class: 'internal contradiction', title: 'two answers', basis: 'the passage', consequence: 'no answer', direction: 'pick one', evidence: [] }], rechecks: [], settled: [], reply: 'assessment' }));
  await step(p.ctx, 'researcher-author', (c) => ({ step: 'submit', message: 'rebut', artifact: 'v1: an LRU cache', dispositions: c.openFindings.map((f: { id: string }) => ({ finding: f.id, action: 'rebut', note: 'the run', evidence })), directionQuestions: [], attempts: [] }));
  await drive(p, { stabilizer: STABILIZE, crititor: RECHECK('yes') });
  const st = await assertExits(p, m, 'converged');
  assert.equal(st.stopped?.reason, 'converged');
  assert.equal(st.settled?.key, X, 'the first settle keeps the exploration id as its key');
  assert.equal((await settledArtifactProven(p.ctx.ports(), m as MissionId, X)).proven, true);
  if (o.waiting === true) {
    // X1 stood: the decision layer plans the part that waited for it (the Architect and Calibrator ②, as often as it asks)
    for (let i = 0; i < 6; i++) {
      const r = (await pmNext(p.ctx)).ready.find((x) => x.kind === 'architect-decompose' || x.kind === 'calibrator-2');
      if (r === undefined) break;
      if (r.kind === 'architect-decompose') await step(p.ctx, r.kind, () => addDetailedPlan(m));
      else await step(p.ctx, r.kind, (c) => cal2Pass(c));
    }
    assert.ok(planEvents(p, m, 'effective').length >= 1, 'the plan that rests on X1 is effective');
    assert.deepEqual(planEvents(p, m, 'exploration-routed').map((e) => e.key), [X]);
  }
  return { evidence, words: w, plan };
}

/** After the move (another environment identity): the rerun of the experiment, then the attacker's re-check of the rebuttal on its new record. */
async function moveAndRecheck(p: ProcessProject, m: string, resolved: 'yes' | 'no', env: EnvironmentParts = ENV_B): Promise<void> {
  p.reopen(env);
  const s = await assertExits(p, m, 'reopened');
  assert.equal(s.settled, null, 'reopened: nothing is current');
  assert.equal((await settledArtifactProven(p.ctx.ports(), m as MissionId, X)).proven, false, 'reopened: the decision layer plans nothing from the earlier conclusion');
  assert.ok(notices(p).includes('exploration-reopened'));
  await experiment(p);
  await step(p.ctx, 'crititor', RECHECK(resolved));
}

/** The notices raised so far (their categories, oldest first). */
const notices = (p: ProcessProject): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.category') AS category FROM log WHERE kind = 'alert' ORDER BY rev").all() as Array<{ category: string }>).map((r) => r.category));
const planEvents = (p: ProcessProject, m: string, event: string): Array<{ key: string; body: Record<string, unknown> }> =>
  p.ctx.memory.read((db) => db.stmt('SELECT key, body FROM flow_events WHERE mission = ? AND line = ? AND event = ? ORDER BY revision').all(m, PLAN_LINE, event) as Array<{ key: string; body: string }>).map((r) => ({ key: r.key, body: JSON.parse(p.ctx.memory.data.text(r.body)) as Record<string, unknown> }));
const lineEvents = (p: ProcessProject, m: string, event: string): string[] => p.ctx.memory.read((db) => (db.stmt('SELECT key FROM flow_events WHERE mission = ? AND line = ? AND event = ? ORDER BY revision').all(m, `exploration:${X}`, event) as Array<{ key: string }>).map((r) => r.key));
const escalationIds = (p: ProcessProject, m: string): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT key FROM flow_events WHERE mission = ? AND line = 'secretary' AND event = 'escalation' ORDER BY revision").all(m) as Array<{ key: string }>).map((r) => r.key));
const label = async (p: ProcessProject): Promise<string> => (await resolveSubtasks(p.ctx)).entries.find((e) => e.kind === 'exploration' && e.id === X)!.label;
/** The exploration's state in the tree reads (`mp read tree`, `why`): the latest of stopped / settled / reopened. */
const treeState = (p: ProcessProject, m: string): string | null => buildGraph(p.ctx, { mission: m }).nodes.get(`exploration:${m}/${X}`)?.state ?? null;

/** A close with risk, and its snapshot document. */
async function closeSnapshot(p: ProcessProject, m: string): Promise<{ unfinished: { explorations: string[] }; risks: string[]; proof: Array<{ object: string; kind: string }> }> {
  const c = await pmClose(p.ctx, m, { mode: 'with-risk' });
  return JSON.parse(p.ctx.memory.data.text(c.snapshot)) as { unfinished: { explorations: string[] }; risks: string[]; proof: Array<{ object: string; kind: string }> };
}

/** The re-check refutes and the author revises until the rounds run out: the budget stop and its escalation. */
async function refutedToBudget(p: ProcessProject, m: string, first: number): Promise<XState> {
  let n = first;
  await drive(p, { stabilizer: STABILIZE, 'researcher-author': (c: AuthorCard) => REVISE(n++)(c), crititor: RECHECK('no') });
  const s = await assertExits(p, m, 'budget');
  assert.equal(s.stopped?.reason, 'budget-exhausted');
  return s;
}

// ---------------------------------------------------------------- the exits

describe('the reopened exploration: every exit settles, escalates, or has a step to take', () => {
  const ps: ProcessProject[] = [];
  const fresh = (): ProcessProject => {
    const p = processProject(PROBE);
    ps.push(p);
    return p;
  };
  after(() => {
    setLabelBatchLimit(null);
    sweepThenClean(ps);
  });

  it('a: the re-check passes: settled again on the same version, proven again, not routed again', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm1', { rounds: 3 });
    const before = await explorationState(p.ctx.ports(), 'm1' as MissionId, X);
    const routed = planEvents(p, 'm1', 'exploration-routed').length;
    assert.equal(treeState(p, 'm1'), 'settled: conclusion (converged)');
    await moveAndRecheck(p, 'm1', 'yes');
    assert.match(treeState(p, 'm1') ?? '', /^reopened: /);
    await drive(p, { stabilizer: STABILIZE });
    const s = await assertExits(p, 'm1', 'a');
    assert.equal(s.stopped?.reason, 'converged');
    assert.deepEqual(lineEvents(p, 'm1', 'settled'), [X, `${X}#2`], 'one settle per opening');
    assert.equal(s.settled?.n, 2);
    assert.equal(s.settled?.body.artifact, before.version!.id, 'the same version');
    const c = await currentSettle(p.ctx.ports(), 'm1' as MissionId, X);
    assert.equal(c?.since.key, X, 'a re-settle that confirms the conclusion: routed under the first settle');
    assert.equal((await settledArtifactProven(p.ctx.ports(), 'm1' as MissionId, X)).proven, true);
    assert.equal(planEvents(p, 'm1', 'exploration-routed').length, routed, 'the decision layer does not route a confirmed conclusion again');
    assert.match(await label(p), /^concluded: conclusion \(converged\), product proven$/);
    assert.equal(treeState(p, 'm1'), 'settled: conclusion (converged)');
    // a retry of the same steps settles nothing more
    for (let i = 0; i < 3; i++) await pmNext(p.ctx);
    assert.equal(lineEvents(p, 'm1', 'settled').length, 2);
  });

  it('b: the re-check refutes, the author revises, it converges on a new version: settled on it, the decision layer re-plans from it, proven', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm2', { rounds: 6, waiting: true });
    const v1 = (await explorationState(p.ctx.ports(), 'm2' as MissionId, X)).version!.id;
    assert.deepEqual(planEvents(p, 'm2', 'exploration-routed').map((e) => e.key), [X]);
    await moveAndRecheck(p, 'm2', 'no');
    await drive(p, { stabilizer: STABILIZE, 'researcher-author': REVISE(2), crititor: RECHECK('yes') });
    const s = await assertExits(p, 'm2', 'b');
    assert.equal(s.stopped?.reason, 'converged');
    const v2 = s.version!.id;
    assert.notEqual(v2, v1);
    assert.equal(s.settled?.key, `${X}#2`);
    assert.equal(s.settled?.body.artifact, v2, 'settled on the new version');
    const proof = await settledArtifactProven(p.ctx.ports(), 'm2' as MissionId, X);
    assert.deepEqual([proof.artifact, proof.proven], [v2, true]);
    // the decision layer heard the changed conclusion: routed under its own settle, a new Architect attempt that rests on v2
    assert.deepEqual(planEvents(p, 'm2', 'exploration-routed').map((e) => e.key), [X, `${X}#2`]);
    const arch = await readyOf(p.ctx, 'architect-decompose');
    const d = pmDispatch(p.ctx, arch.step);
    const card = dispatchView(p.ctx, d.dispatch).card as unknown as { explorationConclusions: Array<{ exploration: string; summary: string }>; unsettledExplorations: string[]; revision: { instructions: string[] } | null; output: { calibrator2: { reliesOn: string[] } } };
    assert.deepEqual(card.unsettledExplorations, []);
    assert.ok(card.explorationConclusions.some((c) => c.exploration === X && c.summary.includes(v2)), JSON.stringify(card.explorationConclusions));
    assert.ok(card.output.calibrator2.reliesOn.includes(v2) && !card.output.calibrator2.reliesOn.includes(v1), JSON.stringify(card.output.calibrator2));
    assert.match(card.revision?.instructions.join(' ') ?? '', /stood again with a changed result/);
    await pmRelease(p.ctx, d.dispatch, 'ended');
    assert.match(await label(p), /^concluded: conclusion \(converged\), product proven; replaces the conclusion recorded before an environment change: conclusion \(converged\), product negated/);
    await assertExits(p, 'm2', 'b end');
  });

  it('b2: the changed conclusion re-settles while the labels recompute: nothing is routed or told until they are current; then it is routed and planned from', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm12', { rounds: 6, waiting: true });
    await seedFanout(p, 'm12', 400);
    await moveAndRecheck(p, 'm12', 'no');
    await step(p.ctx, 'researcher-author', REVISE(2));
    await step(p.ctx, 'stabilizer', STABILIZE);
    await step(p.ctx, 'crititor', RECHECK('yes'));
    const unproven = notices(p).filter((n) => n === 'exploration-conclusion-unproven').length;
    await frontier(p, 'm12');
    await step(p.ctx, 'stabilizer', STABILIZE);
    const s = await explorationState(p.ctx.ports(), 'm12' as MissionId, X);
    assert.equal(s.settled?.key, `${X}#2`, 'the flow settles: a record of the stop, not of a proof');
    await pmNext(p.ctx);
    assert.deepEqual(planEvents(p, 'm12', 'exploration-routed').map((e) => e.key), [X], 'not routed while recomputing');
    assert.equal(notices(p).filter((n) => n === 'exploration-conclusion-unproven').length, unproven, 'no "unproven" notice while recomputing');
    drained(p);
    await pmNext(p.ctx);
    assert.deepEqual(planEvents(p, 'm12', 'exploration-routed').map((e) => e.key), [X, `${X}#2`]);
    const arch = await readyOf(p.ctx, 'architect-decompose');
    const card = dispatchView(p.ctx, pmDispatch(p.ctx, arch.step).dispatch).card as unknown as { output: { calibrator2: { reliesOn: string[] } } };
    assert.ok(card.output.calibrator2.reliesOn.includes(s.settled!.body.artifact!), JSON.stringify(card.output.calibrator2));
    await assertExits(p, 'm12', 'b2');
  });

  it('a rerun closes the routing escalation of the conclusion it reopens in its own write: the Secretary in flight hands back accept into history', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm13', { rounds: 3, type: 'direction' });
    const routing = `explore.m13.${X}`;
    const sec = pmDispatch(p.ctx, `sec.${routing}`).dispatch;
    p.reopen(ENV_B);
    await assertExits(p, 'm13', 'reopened');
    const rerunOp = p.ctx.memory.read((db) => (db.stmt("SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.event') = 'rerun' AND json_extract(record, '$.line') = ?").get(`exploration:${X}`) as { op: string }).op);
    const closeOp = p.ctx.memory.read((db) => (db.stmt("SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.event') = 'applied' AND json_extract(record, '$.key') = ?").get(routing) as { op: string }).op);
    assert.equal(closeOp, rerunOp, 'closed in the rerun\'s own write');
    readAll(p.ctx, sec);
    const a = await handBack(p.ctx, sec, { option: 'accept', classification: 'detail', authorization: null, reason: 'accept it', instructions: '', grantExtra: 0, notice: '', mayMatter: false });
    assert.ok(a.kind === 'recorded' && a.outcome !== 'accepted', JSON.stringify(a));
    await assertExits(p, 'm13', 'after the late hand-back');
  });

  it('c1: the re-check refutes and the rounds run out: the Secretary grants more rounds, then accepts the risk: settled', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm3', { rounds: 3 });
    await moveAndRecheck(p, 'm3', 'no');
    const s1 = await refutedToBudget(p, 'm3', 2);
    const stop1 = `xp.m3.${X}.stop${s1.stopped!.n}`;
    assert.ok(escalationIds(p, 'm3').includes(stop1), 'the stop after the reopening is routed to the Secretary');
    assert.ok(notices(p).includes('exploration-budget-exhausted'));
    assert.match(await label(p), /^stopped \(budget-exhausted\); concluded earlier: conclusion \(converged\), before an environment change/);
    assert.equal(treeState(p, 'm3'), 'stopped (budget-exhausted)');
    // grant: one more round
    await step(p.ctx, 'secretary', SECRETARY('grant', 1));
    const granted = await assertExits(p, 'm3', 'granted');
    assert.equal(granted.stopped, null);
    assert.ok(granted.rulings.some((r) => r.decision === 'extend'));
    const s2 = await refutedToBudget(p, 'm3', 3);
    assert.ok(s2.stopped!.n > s1.stopped!.n);
    const stop2 = `xp.m3.${X}.stop${s2.stopped!.n}`;
    assert.ok(escalationIds(p, 'm3').includes(stop2), 'each stop has its own escalation');
    // accept the risk: settled as a conclusion on the ruled version
    await step(p.ctx, 'secretary', SECRETARY('accept-risk'));
    const s = await assertExits(p, 'm3', 'c1');
    assert.equal(s.settled?.key, `${X}#2`);
    assert.deepEqual([s.settled?.body.outcome, s.settled?.body.stop], ['conclusion', 'budget']);
    assert.ok(s.settled!.body.unresolved.some((u) => u.startsWith('residual risk')), JSON.stringify(s.settled!.body.unresolved));
    assert.match(await label(p), /^concluded: conclusion \(budget\)/);
    assert.equal(treeState(p, 'm3'), 'settled: conclusion (budget)');
  });

  it('c2: the re-check refutes and the rounds run out: the Secretary gives it up: settled as no conclusion, the decision layer hears it', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm4', { rounds: 3, waiting: true });
    await moveAndRecheck(p, 'm4', 'no');
    await refutedToBudget(p, 'm4', 2);
    await step(p.ctx, 'secretary', SECRETARY('abandon'));
    const s = await assertExits(p, 'm4', 'c2');
    assert.equal(s.settled?.key, `${X}#2`);
    assert.deepEqual([s.settled?.body.outcome, s.settled?.body.stop], ['no-conclusion', 'budget']);
    // 3.10: no conclusion goes to the Secretary, the PM and the user (a routing escalation of its own)
    assert.ok(escalationIds(p, 'm4').includes(`explore.m4.${X}.s2`), JSON.stringify(escalationIds(p, 'm4')));
    assert.match(await label(p), /^concluded: no-conclusion \(budget\); replaces the conclusion recorded before an environment change: conclusion \(converged\)/);
    // the closing snapshot reads the current settle
    const doc = await closeSnapshot(p, 'm4');
    assert.deepEqual(doc.unfinished.explorations, []);
    assert.ok(doc.risks.includes(`exploration ${X} ended without a conclusion (budget)`), JSON.stringify(doc.risks));
  });

  it('a close while reopened: the closing snapshot names the exploration as not settled, not its earlier conclusion', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm10', { rounds: 3 });
    p.reopen(ENV_B);
    await assertExits(p, 'm10', 'reopened');
    const doc = await closeSnapshot(p, 'm10');
    assert.deepEqual(doc.unfinished.explorations, [X]);
    assert.ok(!doc.proof.some((o) => o.kind === 'exploration'), JSON.stringify(doc.proof));
  });

  it('d: the Stabilizer judges the re-check drifting, the Secretary asks, the user gives it up: settled as no conclusion; the work planned after it is handed to the decision layer', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm5', { rounds: 3, waiting: true });
    await moveAndRecheck(p, 'm5', 'yes');
    await step(p.ctx, 'stabilizer', DRIFTING);
    const awaiting = await assertExits(p, 'm5', 'drifting');
    assert.equal(awaiting.turn, 'await-ruling');
    await step(p.ctx, 'secretary', SECRETARY('ask-user'));
    const nx = await pmNext(p.ctx);
    const esc = nx.waitingOnUser.find((w) => w.subject === `exploration:${X}`)!.escalation;
    await pmAnswer(p.ctx, { mission: 'm5', escalation: esc, option: 'abandon', words: pmSay(p.ctx, 'Give this exploration up. (m5)').words });
    const s = await assertExits(p, 'm5', 'd');
    assert.equal(s.stopped?.reason, 'stopped-by-decision');
    assert.equal(s.settled?.key, `${X}#2`);
    assert.equal(s.settled?.body.outcome, 'no-conclusion');
    // the decision layer heard it: the no conclusion is routed (the Secretary, then the PM and the user re-plan the waiting part)
    assert.ok(escalationIds(p, 'm5').includes(`explore.m5.${X}.s2`), JSON.stringify(escalationIds(p, 'm5')));
    assert.ok((await pmNext(p.ctx)).ready.some((r) => r.kind === 'secretary' && r.step === `sec.explore.m5.${X}.s2`));
  });

  it('e: the rerun execution is given up (its dispatches released until exhausted): a failed record, the re-check goes on, the stop escalates, abandoned: settled', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm6', { rounds: 3 });
    p.reopen(ENV_B);
    await assertExits(p, 'm6', 'reopened');
    for (let i = 0; i < 6; i++) {
      const r = (await pmNext(p.ctx)).ready.find((x) => x.kind === 'constructor-experiment');
      if (r === undefined) break;
      await pmRelease(p.ctx, pmDispatch(p.ctx, r.step).dispatch, 'abandoned');
    }
    const exhausted = await assertExits(p, 'm6', 'rerun exhausted');
    assert.equal(exhausted.stopped, null);
    const fail = (await openEscalations(flowCtx(p.ctx.ports(), 'm6' as MissionId), `exploration:${X}`)).find((e) => e.id.startsWith('fail.'));
    assert.ok(fail !== undefined, 'the used-up rerun goes to the Secretary');
    await step(p.ctx, 'secretary', SECRETARY('abandon'));
    const after1 = await assertExits(p, 'm6', 'rerun abandoned');
    const rerun = [...after1.reruns.values()][0]!;
    assert.equal(after1.evidence.get(rerun)?.status, 'failed', 'the given-up rerun is recorded as failed');
    assert.equal(after1.turn, 'attacker');
    // the attacker re-checks the rebuttal on the failed record: refuted; the rounds run out
    await step(p.ctx, 'crititor', RECHECK('no'));
    await refutedToBudget(p, 'm6', 2);
    await step(p.ctx, 'secretary', SECRETARY('abandon'));
    const s = await assertExits(p, 'm6', 'e');
    assert.deepEqual([s.settled?.key, s.settled?.body.outcome], [`${X}#2`, 'no-conclusion']);
  });

  it('e2: the re-check attacker\'s task is given up outside the flow: the WI-28 stop escalation; restarted, it re-checks and settles again', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm7', { rounds: 3 });
    p.reopen(ENV_B);
    await experiment(p);
    const att = await readyOf(p.ctx, 'crititor');
    assert.equal(await p.ctx.ports().scheduler.cancel(att.step), true);
    const stopped = await assertExits(p, 'm7', 'seat abandoned');
    assert.equal(stopped.stopped?.reason, 'seat-abandoned');
    assert.ok(escalationIds(p, 'm7').includes(`xp.m7.${X}.stop${stopped.stopped!.n}`), 'the WI-28 escalation of the stop after the reopening');
    await step(p.ctx, 'secretary', SECRETARY('restart'));
    await assertExits(p, 'm7', 'restarted');
    await drive(p, { crititor: RECHECK('yes'), stabilizer: STABILIZE });
    const s = await assertExits(p, 'm7', 'e2');
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.settled?.key, `${X}#2`);
  });

  it('f: a second environment change while the re-check runs: reopened again before it settles; settled once after the second re-check', async () => {
    const p = fresh();
    await convergedOnExperiment(p, 'm8', { rounds: 3 });
    p.reopen(ENV_B);
    await assertExits(p, 'm8', 'reopened on B');
    await experiment(p);
    // the re-check is in flight when the folder moves again
    const r = await readyOf(p.ctx, 'crititor');
    const d = pmDispatch(p.ctx, r.step);
    p.reopen(ENV_C);
    readAll(p.ctx, d.dispatch);
    const a = await handBack(p.ctx, d.dispatch, RECHECK('yes')(dispatchView(p.ctx, d.dispatch).card as unknown as CrititorCard));
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    await drive(p, { stabilizer: STABILIZE });
    // converged on a record of B: reopened again (no settle in between), its rerun under C is ready
    const again = await assertExits(p, 'm8', 'reopened on C');
    assert.equal(again.stopped, null);
    assert.equal(again.reruns.size, 2, JSON.stringify([...again.reruns]));
    assert.deepEqual(lineEvents(p, 'm8', 'settled'), [X], 'a convergence on stale evidence does not settle');
    await drive(p, { 'constructor-experiment': () => null, crititor: RECHECK('yes'), stabilizer: STABILIZE });
    const s = await assertExits(p, 'm8', 'f');
    assert.equal(s.stopped?.reason, 'converged');
    assert.deepEqual(lineEvents(p, 'm8', 'settled'), [X, `${X}#2`]);
    assert.equal((await settledArtifactProven(p.ctx.ports(), 'm8' as MissionId, X)).proven, true);
  });

  it('g: a PM plan revising the exploration: refused with a notice while it is settled; applied while a rerun has reopened it; it settles under the definition in force', async () => {
    const p = fresh();
    const { words, plan } = await convergedOnExperiment(p, 'm9', { rounds: 3 });
    // while settled: the plan change does not reopen it
    await pmPlan(p.ctx, { mission: 'm9', words: [words], plan: plan(2, { attackScope: ['internal contradiction', 'gets stuck'] }) });
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await assertExits(p, 'm9', 'changed while settled');
    assert.ok(notices(p).includes('exploration-changed-after-settling'));
    assert.deepEqual(lineEvents(p, 'm9', 'redefined'), []);
    // reopened by the move: not settled, so the definition in force applies, and a change while reopened too
    p.reopen(ENV_B);
    await assertExits(p, 'm9', 'reopened');
    assert.deepEqual(lineEvents(p, 'm9', 'redefined'), ['2'], 'the definition in force applies once it is reopened');
    await pmPlan(p.ctx, { mission: 'm9', words: [words], plan: plan(3, { attackScope: ['internal contradiction', 'gets stuck'], budget: { rounds: 5, micros: null } }) });
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    const s0 = await assertExits(p, 'm9', 'changed while reopened');
    assert.deepEqual(lineEvents(p, 'm9', 'redefined'), ['2', '3']);
    assert.equal(s0.def?.budget.rounds, 5);
    assert.equal(notices(p).filter((n) => n === 'exploration-changed-after-settling').length, 1, 'no notice for a change while reopened');
    await drive(p, { 'constructor-experiment': () => null, crititor: RECHECK('yes'), stabilizer: STABILIZE });
    const s = await assertExits(p, 'm9', 'g');
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.settled?.key, `${X}#2`);
    assert.equal(s.defined?.basisVersion.endsWith('.v3'), true, s.defined?.basisVersion);
    assert.equal((await settledArtifactProven(p.ctx.ports(), 'm9' as MissionId, X)).proven, true);
  });

  it('g2: reopened, the re-check refutes and the rounds run out; a PM plan raises the budget instead of the Secretary deciding: the stop escalation is superseded, the rounds go on, it settles', async () => {
    const p = fresh();
    const { words, plan } = await convergedOnExperiment(p, 'm11', { rounds: 3 });
    await moveAndRecheck(p, 'm11', 'no');
    const stopped = await refutedToBudget(p, 'm11', 2);
    const stopEsc = `xp.m11.${X}.stop${stopped.stopped!.n}`;
    assert.ok(escalationIds(p, 'm11').includes(stopEsc));
    await pmPlan(p.ctx, { mission: 'm11', words: [words], plan: plan(2, { budget: { rounds: 5, micros: null } }) });
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    const resumed = await assertExits(p, 'm11', 'redefined');
    assert.equal(resumed.stopped, null, 'the redefinition reopened the budget stop');
    const open = await openEscalations(flowCtx(p.ctx.ports(), 'm11' as MissionId), `exploration:${X}`);
    assert.ok(!open.some((e) => e.id === stopEsc), 'the stop it left is closed as superseded');
    await drive(p, { crititor: RECHECK('yes'), stabilizer: STABILIZE });
    const s = await assertExits(p, 'm11', 'g2');
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.settled?.key, `${X}#2`);
  });
});

describe('the fold: the current settle is the one since the last reopening', () => {
  const defined: XEvent = { event: 'defined', key: 'definition', body: { definition: { research: false, budget: { rounds: 3, spendMicros: null } }, definitionDoc: 'd', basisLine: 'b', basisVersion: 'b.v1', envLine: 'e', envSnapshot: 'e1', snapshot: { path: 'p', commit: 'c' } } };
  const stopped = (n: number, reason: string): XEvent => ({ event: 'stopped', key: String(n), body: { n, reason, wi: null, handoff: 'h', version: 'v1' } });
  const settled = (n: number, outcome: string, artifact: string | null): XEvent => ({ event: 'settled', key: settleKey(X, n).key, body: { exploration: X, decision: { id: 'D1', type: 'structure' }, outcome, stop: 'converged', artifact, summary: '', unresolved: [] } });
  const rerun = (ids: string[]): XEvent => ({ event: 'rerun', key: ids.join(','), body: { evidence: ids, environment: 'env2' } });

  it('a rerun reopens a converged, settled exploration: nothing is current; the next settle is current and numbered', () => {
    let s = fold([defined, stopped(1, 'converged'), settled(1, 'conclusion', 'v1')]);
    assert.equal(s.settled?.key, X);
    s = fold([defined, stopped(1, 'converged'), settled(1, 'conclusion', 'v1'), rerun(['e1'])]);
    assert.deepEqual([s.stopped, s.settled, s.settles.length], [null, null, 1]);
    // the same evidence again adds nothing: no reopening
    s = fold([defined, stopped(1, 'converged'), settled(1, 'conclusion', 'v1'), rerun(['e1']), stopped(2, 'converged'), settled(2, 'conclusion', 'v1'), rerun(['e1'])]);
    assert.equal(s.settled?.key, `${X}#2`);
    assert.equal(settleSince(s)?.key, X, 'a confirming re-settle: the conclusion was first recorded by the first settle');
    s = fold([defined, stopped(1, 'converged'), settled(1, 'conclusion', 'v1'), rerun(['e1']), stopped(2, 'converged'), settled(2, 'conclusion', 'v2')]);
    assert.equal(settleSince(s)?.key, `${X}#2`, 'a changed conclusion is its own');
  });

  it('a redefinition that reopens a stop makes its settle history; one that leaves a converged stop does not', () => {
    const redefined: XEvent = { event: 'redefined', key: '2', body: { definition: { research: false, budget: { rounds: 5, spendMicros: null } }, definitionDoc: 'd2', basisVersion: 'b.v2' } };
    let s = fold([defined, stopped(1, 'budget-exhausted'), settled(1, 'no-conclusion', null), redefined]);
    assert.deepEqual([s.stopped, s.settled], [null, null]);
    s = fold([defined, stopped(1, 'converged'), settled(1, 'conclusion', 'v1'), redefined]);
    assert.equal(s.settled?.key, X);
  });
});
