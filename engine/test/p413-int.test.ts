// 4.1.3 integration (card INT): the four parts joined, each join through one resolver.
//   2   a data pointer's check (P3) travels through P2's round end: typed on what the flow took in, it
//       labels the next round's attacker card and the hand-off of an exploration that converged with no
//       closing attacker
//   3   the repair entry's attempts (`mp pm repair --attempts`, `mp pm amend-attempts`) have their
//       commands checked as the author's register has (P3's checks)
//   4   a detached run (P4) of an attempt is a run a seat holds for the repair entry (P2): refused while
//       it runs; once it ended, the step dispatched again carries it
//   5   one writer of a decider's ruling (P1's accept-risk, P2's accept): same ids, executors, fields
//   6   a plan that took effect waived (P1) routes its explorations (P2's convergence) as any plan does
//   8   a detached run's process group ends whole (P4); a run `wait` shows can always be cited
//   11  accept-risk waits for a dependency reopened since (P1, sol r2); a change form answers an
//       earlier repair only on --answers (P2, sol r2; tested in p413-exploration-repair)

import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DATA_PARTIAL_OVER } from '../src/common/dataFile.ts';
import { explorationHandoffs, explorationState } from '../src/flow/exploration/flow.ts';
import type { XState } from '../src/flow/exploration/machine.ts';
import { DATA_LABEL } from '../src/seat/cards/experiment.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { seatCardEntry } from '../src/seat/cards/index.ts';
import { M, RUN_PLACEHOLDER, attack, blind, cardOf, finding, hand, only, recheckAll, reviseAll, submit, world, type World } from './flow-exploration-fixtures.ts';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { canonicalJson } from '../src/common/hash.ts';
import type { ContentHash } from '../src/common/ids.ts';
import { ENV_LINE } from '../src/evaluator/index.ts';
import { flowCtx } from '../src/flow/context.ts';
import { attemptRecorded } from '../src/flow/exploration/machine.ts';
import { repairsOf } from '../src/flow/repair.ts';
import { appendRecords } from '../src/memory/index.ts';
import { DETACHED_EVENT, DISPATCH_LINE, pmAmendAttempts, pmRelease, pmRepair, pmSay, processStart } from '../src/process/index.ts';
import { dispatchStepRuns } from '../src/process/detached.ts';
import { dispatchView, seatCard } from '../src/process/seat.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { FlowProject } from '../src/flow/ports.ts';
import { drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { answerEscalation, deciderOf, rulingJudgmentId } from '../src/flow/secretary.ts';
import { architect, detailedPlan, type ScriptedOutcome } from '../src/flow/scripted.ts';
import type { DetailedPlanDoc, PmPlanDoc } from '../src/flow/plandoc.ts';
import { pmWaive } from '../src/process/pm.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { stabilizeAll } from './flow-exploration-fixtures.ts';
import type { JudgmentRecord } from '../src/common/records.ts';
import { groupShellRunner } from '../src/process/runs.ts';
import { dispatchRuns } from '../src/process/ports.ts';
import { stepRuns } from '../src/process/detached.ts';
import { cli } from './cli-fixtures.ts';
import { processProject } from './process-fixtures.ts';

const DIR = mkdtempSync(join(tmpdir(), 'p413-int-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const state = (w: World): Promise<XState> => explorationState({ ledger: w.ledger }, M, w.x);

/** A sparse file over the partial-check size, and its pointer (checked partially at hand-back). */
function bigData(name: string): string {
  const path = join(DIR, name);
  mkdirSync(join(path, '..'), { recursive: true });
  const size = DATA_PARTIAL_OVER + 1;
  const fd = openSync(path, 'w');
  writeSync(fd, Buffer.from('x'), 0, 1, size - 1);
  closeSync(fd);
  return `data:${path}#sha256=${'9'.repeat(64)}&size=${size}`;
}

// ---------------------------------------------------------------- 2

describe('INT 2: a data citation travels through P2\'s round end and convergence', () => {
  test('the author\'s partial pointer labels round 2\'s attacker card (after the Stabilizer\'s hand-back and the round\'s end), and the hand-off of the exploration that converged with no closing attacker', async () => {
    const big = bigData('a/corpus.bin');
    const w = await world({ rounds: 3 });
    await w.advance();
    await hand(w, 'researcher-author', submit(`v1 rests on the corpus ${big}`));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules')]));
    await w.advance();
    // the author revises; the fixture hands the Stabilizer's judgment back through the seat path (P2 #25: its card at hand-back)
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    let s = await state(w);
    assert.equal(s.stabilizations.length, 1, 'round 1 judged');
    const author = [...s.consumed.values()].find((c) => c.kind === 'author' && c.version !== null && c.data !== undefined);
    assert.deepEqual(author?.kind === 'author' ? author.data?.map((d) => [d.pointer, d.check]) : null, [[big, 'partial']], 'typed on what the flow took in (machine.ts ConsumedBody.data)');
    // round 2: the re-check; the attacker's card labels the pointer partial
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(c.dataChecked, [{ pointer: big, check: 'partial', label: DATA_LABEL.partial }]);
    assert.ok(seatCardEntry('crititor').render(c).includes(`- ${big} — ${DATA_LABEL.partial}`));
    await hand(w, 'crititor', attack([], recheckAll(c, 'yes')));
    await w.advance();
    s = await state(w);
    assert.equal(s.stopped?.reason, 'converged', 'converged in round 2 by its Stabilizer (E-3)');
    assert.equal(w.scheduler.queued('crititor').length, 0, 'no closing attacker');
    const h = (await explorationHandoffs(w.ledger, M)).at(-1)!.handoff;
    assert.deepEqual(h.dataChecked?.map((d) => [d.pointer, d.check, d.label]), [[big, 'partial', DATA_LABEL.partial]]);
  });
});

// ---------------------------------------------------------------- a research exploration in its attempts phase (as P2's tests)

const URL = 'https://docs.example.org/';
const A1: RegisteredAttemptT = { id: 'A1', kind: 'experiment', purpose: 'does the lock survive a crash', steps: ['run the crash script 20 times'], data: 'the repository', measure: ['survivals'], assertions: ['all 20 survive'], commands: [{ id: 'step', command: 'sh crash.sh 20' }] };
const A2: RegisteredAttemptT = { id: 'A2', kind: 'reading', purpose: 'what the kernel documents', steps: ['read the locking documentation'], data: URL, measure: ['guarantee stated'], assertions: [] };
const REASON = 'Run the crash script 50 times, and search the whole domain.';

async function attemptsPhase(): Promise<{ w: World; words: string }> {
  const w = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' }, readingNetwork: [URL], rounds: 3 });
  await w.advance();
  await hand(w, 'researcher-author', submit('method v1', [], { attempts: [A1, A2] }));
  await w.advance();
  await hand(w, 'crititor', attack());
  await w.advance();
  return { w, words: say(w, REASON) };
}

const refusedWith = (code: string, re: RegExp) => (e: { code?: string; message?: string }): boolean => e.code === code && re.test(e.message ?? '');

// ---------------------------------------------------------------- 3

describe('INT 3: the repair entry checks an attempt\'s commands as the author\'s register does', () => {
  test('mp pm repair --attempts and the older amend-attempts refuse what the rerun would refuse later (NOT_ALLOWED, nothing written)', async () => {
    const { w, words } = await attemptsPhase();
    const bad: RegisteredAttemptT[] = [
      { ...A1, id: 'A3', commands: [{ id: 'c1', command: 'sh crash.sh 50', cwd: '/srv/lock' }] },
      { ...A1, id: 'A4', commands: [{ id: 'c1', command: 'sh a.sh' }, { id: 'c1', command: 'sh b.sh' }] },
      { ...A2, id: 'A5', commands: [{ id: 'c1', command: 'cat docs.txt' }] },
    ];
    const problems = [/attempts\[A3\]\.commands\[0\] \(c1\): the working directory "\/srv\/lock" is not relative to the repository root/, /attempts\[A4\]\.commands\[1\] \(c1\): the id "c1" is declared twice/, /attempts\[A5\]\.commands: a reading runs no commands/];
    for (const [i, a] of bad.entries()) {
      await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x, change: { form: 'attempts', attempts: [a] } }), refusedWith('NOT_ALLOWED', problems[i]!));
      await assert.rejects(pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [a], words }), refusedWith('NOT_ALLOWED', problems[i]!));
    }
    assert.deepEqual(await repairsOf(flowCtx(w.ports, M)), [], 'nothing written');
    assert.equal((await state(w)).amendments.length, 0);
    // the same attempt with a relative working directory is applied
    const fixed = await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x, change: { form: 'attempts', attempts: [{ ...bad[0]!, commands: [{ id: 'c1', command: 'sh crash.sh 50', cwd: 'lock' }] }] } });
    assert.equal(fixed.changed?.form, 'attempts');
  });
});

// ---------------------------------------------------------------- 4

/** A detached run recorded against a dispatch as its worker records it ("detached"), its worker this process (alive) or a pid that is gone. */
function detachedRun(w: World, dispatch: string, run: string, o: { readonly gone?: boolean } = {}): { readonly run: string; readonly evidence: string } {
  const info = dispatchView(w.ports.ctx, dispatch).info;
  const pid = o.gone === true ? spawnSync(process.execPath, ['-e', '0']).pid! : process.pid;
  const body = { run, evidence: `sample.${run}.step.sx`, command: 'step', dispatch, task: info.task, pid, start: o.gone === true ? 'linux:gone:1' : processStart(process.pid), host: hostname(), startedAt: Date.now() };
  w.memory.write({ op: `int-detached:${run}`, payload: {} }, (tx) => {
    appendRecords(tx, [{ kind: 'flow.event', mission: info.mission, line: DISPATCH_LINE(dispatch), event: DETACHED_EVENT, key: run, body: tx.data.put(canonicalJson(body)) as ContentHash }]);
  });
  return body;
}

/** The detached run's result as its worker records it: the evidence and the dispatch line's "run" event in one write. */
function finishDetached(w: World, dispatch: string, r: { readonly run: string; readonly evidence: string }): void {
  const info = dispatchView(w.ports.ctx, dispatch).info;
  const env = w.ports.ctx.environment();
  w.memory.write({ op: `int-finished:${r.run}`, payload: {} }, (tx) => {
    appendRecords(tx, [
      { kind: 'evidence', evidence: r.evidence as never, envLine: ENV_LINE, envSnapshot: env.identity, runClass: 'sampling', fields: { status: 'completed', exit: '0', command: 'step', dispatch, run: r.run } },
      { kind: 'flow.event', mission: info.mission, line: DISPATCH_LINE(dispatch), event: 'run', key: r.evidence, body: tx.data.put(canonicalJson({ run: r.evidence, command: 'step', completed: true, exit: '0', envLine: ENV_LINE, envSnapshot: env.identity, at: tx.at, detached: r.run })) as ContentHash },
    ]);
  });
}

const A1_WIDER: RegisteredAttemptT = { ...A1, steps: ['run the crash script 50 times'], commands: [{ id: 'step', command: 'sh crash.sh 50' }] };
const experimentTask = (w: World): string => w.scheduler.queued('constructor-experiment').find((t) => (t.card as unknown as ExperimentCard).evidence.attempt === 'A1')!.task;
const handA1 = async (w: World, task: string, evidence: string): Promise<void> => {
  const fields = JSON.parse(JSON.stringify(blind(w.scheduler.card<ExperimentCard>(task))).split(RUN_PLACEHOLDER).join(`run:${evidence}`));
  assert.deepEqual(await w.scheduler.run(task, { handBack: fields }), []);
};

describe('INT 4: a detached run of an attempt is a run a seat holds for the repair entry', () => {
  test('its dispatch released while it runs: --attempts (and amend-attempts) replacing the attempt is DISPATCH_IN_FLIGHT; once it finished, the step dispatched again carries it, and the new seat cites it', async () => {
    const { w, words } = await attemptsPhase();
    const t1 = experimentTask(w);
    const d1 = w.scheduler.dispatchOf(t1);
    const r = detachedRun(w, d1, 'rerun-int4a');
    // the seat is gone: the PM releases the dispatch; the run goes on for the step
    await pmRelease(w.ports.ctx, d1, 'ended');
    const held = refusedWith('DISPATCH_IN_FLIGHT', new RegExp(`attempt A1 of exploration ${w.x} has a run a seat holds \\(detached run rerun-int4a of dispatch ${d1}, running since`));
    await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x, change: { form: 'attempts', attempts: [A1_WIDER] } }), held);
    await assert.rejects(pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [A1_WIDER], words }), held);
    assert.deepEqual(await repairsOf(flowCtx(w.ports, M)), [], 'nothing written');
    assert.equal(experimentTask(w), t1, 'the step still waits to be dispatched again');
    // the run ends; the step dispatched again: its card carries the finished run, and the new seat cites it
    finishDetached(w, d1, r);
    const d2 = w.scheduler.dispatchOf(t1);
    assert.notEqual(d2, d1);
    const card = seatCard(w.ports.ctx, d2).text;
    assert.ok(card.includes(`${r.run} (command step, by ${d1}): passed`), card);
    assert.ok(card.includes(`Cite it as evidence:${r.evidence}`));
    await handA1(w, t1, r.evidence);
    await w.advance();
    assert.equal(attemptRecorded(await state(w), 'A1'), true, 'the carried run backs the attempt\'s record');
  });

  test('handed back while its detached run still runs: --rerun of the attempt is DISPATCH_IN_FLIGHT until the run ends; a run whose worker is gone is recorded as lost and holds nothing', async () => {
    const { w, words } = await attemptsPhase();
    const t1 = experimentTask(w);
    const d1 = w.scheduler.dispatchOf(t1);
    const fg = w.scheduler.rerun(d1, 'step');
    const r = detachedRun(w, d1, 'rerun-int4b');
    await handA1(w, t1, fg);
    await w.advance();
    assert.equal(attemptRecorded(await state(w), 'A1'), true);
    const rerun = { mission: M, words, kind: 'new-question' as const, text: REASON, about: w.x, change: { form: 'rerun' as const, attempts: ['A1'] } };
    await assert.rejects(pmRepair(w.ports.ctx, rerun), refusedWith('DISPATCH_IN_FLIGHT', /detached run rerun-int4b/));
    assert.deepEqual(await repairsOf(flowCtx(w.ports, M)), []);
    finishDetached(w, d1, r);
    const ok = await pmRepair(w.ports.ctx, rerun);
    assert.equal(ok.changed?.form, 'rerun');
    // a worker that is gone: recorded as lost first (P4's resolver), so it holds nothing
    const t2 = experimentTask(w);
    const d2 = w.scheduler.dispatchOf(t2);
    const fg2 = w.scheduler.rerun(d2, 'step');
    const lost = detachedRun(w, d2, 'rerun-int4c', { gone: true });
    await handA1(w, t2, fg2);
    await w.advance();
    const again = await pmRepair(w.ports.ctx, rerun);
    assert.equal(again.changed?.form, 'rerun');
    const info = dispatchView(w.ports.ctx, d2).info;
    assert.equal(w.memory.read((db) => dispatchStepRuns(db, w.memory.data, info)).find((x) => x.run === lost.run)?.state, 'lost');
  });
});

// ---------------------------------------------------------------- the delivery side (as P1's tests)

const TM = 'm1' as MissionId;
type Ports = ReturnType<typeof memoryPorts>;

async function delivery(mode: 'stable' | 'fast' = 'fast', project?: FlowProject): Promise<{ ports: Ports; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, TM);
  await submitPmBatch(ports, { mission: TM, plan: pmPlan(TM), userWords: ['W-1'], mode });
  return { ports, engine: new FlowEngine(project === undefined ? ports : { ...ports, project }) };
}

function withKinds(over: Record<string, Script>): Script {
  const base = happyScript(TM);
  return (t, sch) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, sch);
}

const eventsOf = async <B>(ports: Ports, line: string, event: string) => (await ports.ledger.events<B>({ mission: TM, line, event })).map((e) => ({ key: e.key, body: e.body }));

// ---------------------------------------------------------------- 11 (P1)

describe('INT 11 (P1, sol r2): accept-risk reads the dependencies as the pass does', () => {
  test('iface accepted, then reopened by a repair; accept-risk on impl waits (iface is not accepted now), the decision recorded; once iface is accepted again it is carried out as the pass would', async () => {
    const { ports, engine } = await delivery('fast');
    // iface passes; impl's Reviewer needs a decision, which waits
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return { handBack: reviewer(c, c.target.includes('impl') ? 'needs-decision' : 'pass') }; }, secretary: () => null }));
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'iface'), 'prod.con.m1.iface.1');
    const esc = (await eventsOf<{ id: string; source: string; options: string[] }>(ports, 'secretary', 'escalation')).find((e) => e.body.source === 'reviewer-needs-decision')!.body;
    assert.ok(esc.options.includes('accept-risk'));
    // the user's repair reopens iface; its new attempt is held; the Secretary decides accept-risk on impl meanwhile
    const w2 = say(ports, 'The interface misses a delimiter option.');
    await pmRepair(ports.ctx, { mission: TM, words: w2, kind: 'defect', text: 'misses a delimiter option' });
    await drive(engine, ports.scheduler, withKinds({
      'architect-repair': () => ({ handBack: { reopen: [{ task: 'iface', issue: 'add a delimiter option' }], add: [], note: 'iface owns it' } }),
      constructor: (t: Parameters<Script>[0]) => (t.task.includes('iface') ? null : happyScript(TM)(t, ports.scheduler)),
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'accept-risk', { classification: 'important-within-authority', notice: 'accept it as it is' }) }),
    }));
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'iface'), null, 'iface is reopened: not accepted now');
    assert.ok((await eventsOf(ports, 'secretary', 'decision')).some((e) => e.key.startsWith(esc.id)), 'the Secretary decided accept-risk');
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'impl'), null, 'impl is not accepted while iface is not (the pass would wait)');
    assert.ok(!(await eventsOf(ports, 'secretary', 'applied')).some((e) => e.key === esc.id), 'the decision stays recorded, not carried out');
    // iface is accepted again: the decision is carried out
    await drive(engine, ports.scheduler, happyScript(TM));
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'iface'), 'prod.con.m1.iface.2');
    const acc = (await eventsOf<{ k: number; decision?: { escalation: string; by: string }; judgment: string }>(ports, 'task:impl', 'accepted')).map((e) => e.body);
    assert.deepEqual(acc.map((a) => [a.k, a.decision?.escalation, a.decision?.by, a.judgment]), [[1, esc.id, 'secretary', `j.sec.${esc.id}`]]);
  });
});

describe('INT 11b (sol INT r1): with startOnHandback, accept-risk waits for a reopened dependency to be accepted again', () => {
  test('iface accepted, then reopened; its new attempt is verified but still in review; accept-risk on impl waits, and is carried out once iface is accepted again', async () => {
    const { ports, engine } = await delivery('fast', { localCommands: [], fullSuite: [], startOnHandback: [TM] });
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return { handBack: reviewer(c, c.target.includes('impl') ? 'needs-decision' : 'pass') }; }, secretary: () => null }));
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'iface'), 'prod.con.m1.iface.1');
    const esc = (await eventsOf<{ id: string; source: string; options: string[] }>(ports, 'secretary', 'escalation')).find((e) => e.body.source === 'reviewer-needs-decision')!.body;
    const w2 = say(ports, 'The interface misses a delimiter option.');
    await pmRepair(ports.ctx, { mission: TM, words: w2, kind: 'defect', text: 'misses a delimiter option' });
    // iface's new attempt is built and verified; its Reviewer has not judged it yet
    await drive(engine, ports.scheduler, withKinds({
      'architect-repair': () => ({ handBack: { reopen: [{ task: 'iface', issue: 'add a delimiter option' }], add: [], note: 'iface owns it' } }),
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('iface') ? null : { handBack: reviewer(c, 'needs-decision') }; },
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'accept-risk', { classification: 'important-within-authority', notice: 'accept it as it is' }) }),
    }));
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'iface'), null, 'iface is reopened and in review: not accepted now');
    assert.ok((await eventsOf(ports, 'task:iface', 'verified')).some((e) => e.key === '2'), "iface's new attempt has a verified hand-back (startOnHandback lets work start on it)");
    assert.ok((await eventsOf(ports, 'secretary', 'decision')).some((e) => e.key.startsWith(esc.id)), 'the Secretary decided accept-risk');
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'impl'), null, 'impl is not accepted while iface is not accepted now');
    assert.ok(!(await eventsOf(ports, 'secretary', 'applied')).some((e) => e.key === esc.id), 'the decision stays recorded, not carried out');
    await drive(engine, ports.scheduler, happyScript(TM));
    assert.equal(await acceptedProduct(flowCtx(ports, TM), 'iface'), 'prod.con.m1.iface.2');
    const acc = (await eventsOf<{ k: number; decision?: { escalation: string; by: string } }>(ports, 'task:impl', 'accepted')).map((e) => e.body);
    assert.deepEqual(acc.map((a) => [a.k, a.decision?.escalation, a.decision?.by]), [[1, esc.id, 'secretary']]);
  });
});

// ---------------------------------------------------------------- a mission whose PM plan holds an exploration X1 (e2 waits for it)

const X = 'X1';

async function explorationMission(o: { readonly rounds: number; readonly mode?: 'fast' | 'stable' }): Promise<{ ports: Ports; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, TM);
  const plan = pmPlan(TM);
  const doc: PmPlanDoc = {
    ...plan,
    elements: [
      plan.elements[0]!,
      { id: 'x1', kind: 'exploration', text: 'Find the streaming approach', provenance: { by: 'pm' }, after: [], items: [], exploration: { id: X, deliverable: 'a design', fuzzyGoal: { quote: 'Build me a CSV parser', words: 'W-1' }, attackScope: ['internal contradiction'], decision: { id: 'd1', type: 'structure' }, budget: { rounds: o.rounds, micros: null }, stop: '', research: false } },
      { ...plan.elements[1]!, after: [X] },
    ],
  };
  await submitPmBatch(ports, { mission: TM, plan: doc, userWords: ['W-1'], mode: o.mode ?? 'fast' });
  return { ports, engine: new FlowEngine(ports) };
}

/** The Architect plans only what does not wait for X1 while it has not stood; then the whole plan. */
function planAround(cards: Array<{ unsettledExplorations: string[]; explorationConclusions: Array<{ exploration: string }> }>): Script {
  return (t) => {
    const c = t.card as unknown as { unsettledExplorations: string[]; explorationConclusions: Array<{ exploration: string }> };
    cards.push(c);
    const full = detailedPlan(TM);
    const round: DetailedPlanDoc = c.unsettledExplorations.includes(X) ? { ...full, tasks: [full.tasks[0]!] } : full;
    return { handBack: architect(round) };
  };
}

/** The exploration's seats: v1, one attack round that passes, the Stabilizer on track. */
const convergingSeats: Record<string, Script> = {
  'researcher-author': (): ScriptedOutcome => ({ handBack: submit('the streaming design v1') }),
  crititor: (): ScriptedOutcome => ({ handBack: attack() }),
  stabilizer: (t): ScriptedOutcome => ({ handBack: stabilizeAll(t.card as unknown as StabilizerCard) }),
};

// ---------------------------------------------------------------- 6

describe('INT 6: a plan that took effect waived routes its explorations as any plan in effect', () => {
  for (const mode of ['fast', 'stable'] as const) {
    test(`${mode} mode: the waived plan is in effect while X1 runs; X1 converges by its Stabilizer (no closing attacker), is routed to the Architect, and the next plan takes effect waived too`, async () => {
      const { ports, engine } = await explorationMission({ rounds: 3, mode });
      const w2 = say(ports, 'I decide the plan myself: skip the plan reviews.');
      await pmWaive(ports.ctx, { mission: TM, check: 'plan-reviews', words: w2 });
      const cards: Array<{ unsettledExplorations: string[]; explorationConclusions: Array<{ exploration: string }> }> = [];
      const ran = await drive(engine, ports.scheduler, withKinds({ 'architect-decompose': planAround(cards), ...convergingSeats }));
      assert.ok(!ran.some((t) => /feas|cal2/.test(t)), `no plan review ran: ${ran.join(', ')}`);
      assert.deepEqual(ran.filter((t) => ports.scheduler.tasks.get(t)?.spec.card.seat === 'crititor').length, 1, 'one attack round: no closing attacker');
      const effective = await eventsOf<{ dplan: string; reviewsWaived?: { by: string; ref: string } }>(ports, 'plan', 'effective');
      assert.deepEqual(effective.map((e) => [e.body.dplan, e.body.reviewsWaived?.by, e.body.reviewsWaived?.ref]), [['dplan.m1.1.1', 'words', w2], ['dplan.m1.1.2', 'words', w2]]);
      const s = await explorationState({ ledger: ports.ledger }, TM, X);
      assert.equal(s.stopped?.reason, 'converged');
      assert.deepEqual((await eventsOf<{ exploration: string; route: string }>(ports, 'plan', 'exploration-routed')).map((e) => [e.body.exploration, e.body.route]), [[X, 'architect']]);
      assert.deepEqual([cards[0]?.unsettledExplorations, cards.at(-1)?.explorationConclusions.map((c) => c.exploration)], [[X], [X]]);
      assert.notEqual(await acceptedProduct(flowCtx(ports, TM), 'impl'), null, 'the work that waited for X1 is planned and done');
    });
  }
});

// ---------------------------------------------------------------- 5

describe('INT 5: one writer of a decider\'s ruling (accept-risk on a task, and a ruling at an exploration\'s budget stop)', () => {
  test('the user\'s rulings on both sides: the same id form, executor and fields; a decision the program recorded has no decider', async () => {
    // P1: accept-risk on a task's needs-decision, on the user's words
    const t = await delivery('fast');
    await drive(t.engine, t.ports.scheduler, withKinds({ reviewer: (x) => { const c = x.card as unknown as ReviewerCard; return { handBack: reviewer(c, c.target.includes('impl') ? 'needs-decision' : 'pass') }; }, secretary: (x) => ({ handBack: secretary(x.card as unknown as SecretaryCard, 'ask-user') }) }));
    const te = (await eventsOf<{ id: string; source: string }>(t.ports, 'secretary', 'escalation')).find((e) => e.body.source === 'reviewer-needs-decision')!.body.id;
    const tw = say(t.ports, 'Accept the parser as it is.');
    await answerEscalation(t.ports, { mission: TM, escalation: te, option: 'accept-risk', words: `Accept the parser as it is. (${tw})` });
    await drive(t.engine, t.ports.scheduler, happyScript(TM));
    // P2: the budget step's ruling on an exploration, on the user's words (accept-risk: the serious finding stays
    // unresolved on the revision; plain accept writes through the same helper, but only on a version no pass
    // stands on, which 4.1.3 leaves to records an older engine wrote)
    const x = await explorationMission({ rounds: 1 });
    let attacked = false;
    await drive(x.engine, x.ports.scheduler, withKinds({
      'architect-decompose': planAround([]),
      'researcher-author': (q) => ({ handBack: submit(attacked ? 'v2' : 'v1', attacked ? reviseAll(q.card as unknown as AuthorCard) : []) }),
      crititor: () => ((attacked = true), { handBack: attack([finding('serious', 'internal contradiction', 'two rules')]) }),
      stabilizer: (q) => ({ handBack: stabilizeAll(q.card as unknown as StabilizerCard) }),
      secretary: (q) => ({ handBack: secretary(q.card as unknown as SecretaryCard, 'ask-user') }),
    }));
    const xe = (await eventsOf<{ id: string; source: string; options: string[] }>(x.ports, 'secretary', 'escalation')).find((e) => e.body.source === 'exploration-budget')!.body;
    assert.ok(xe.options.includes('accept-risk'), xe.options.join(', '));
    const xw = say(x.ports, 'That design is fine as it is.');
    await answerEscalation(x.ports, { mission: TM, escalation: xe.id, option: 'accept-risk', words: `That design is fine as it is. (${xw})` });
    await drive(x.engine, x.ports.scheduler, withKinds({ 'architect-decompose': planAround([]) }));
    const ruling = async (ports: Ports, id: string): Promise<JudgmentRecord> => (await ports.ledger.judgment(id)) as JudgmentRecord;
    const a = await ruling(t.ports, rulingJudgmentId(te, 'user'));
    const b = await ruling(x.ports, rulingJudgmentId(xe.id, 'user'));
    assert.ok(a !== null && b !== null, 'both rulings are written, under the same id form');
    assert.deepEqual([a.executor, a.verdict, b.executor, b.verdict], ['user', 'pass', 'user', 'pass']);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'the same fields');
    assert.deepEqual([a.issues, a.superseded, a.extends, b.issues, b.superseded, b.extends], [[], [], null, [], [], null]);
    assert.equal((await explorationState({ ledger: x.ports.ledger }, TM, X)).rulings.at(-1)?.decision, 'accept-risk');
    assert.deepEqual([deciderOf('user'), deciderOf('secretary'), deciderOf('program')], ['user', 'secretary', null], 'no judgment in the program\'s name');
  });
});

// ---------------------------------------------------------------- 8

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

describe('INT 8: P4\'s general fixes', () => {
  test('a detached run\'s command group on its time limit: a child that ignores SIGTERM and holds none of the shell\'s output still gets the SIGKILL; the run answers once the group is gone', { skip: process.platform === 'win32' }, async () => {
    const pidFile = join(DIR, `bg-${process.pid}.pid`);
    const runner = groupShellRunner({ graceMs: 200 });
    const out = await runner({ command: `(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 30`, cwd: DIR, timeoutMs: 300 });
    assert.equal(out.timedOut, true);
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(child > 0);
    assert.equal(alive(child), false, 'no process of the group outlives the run');
  });

  test('a dispatch with more runs than one page: every run `wait` and the carried card show is one the hand-back may cite (dispatchRuns reads stepRuns)', async () => {
    const { w } = await attemptsPhase();
    const t1 = experimentTask(w);
    const d1 = w.scheduler.dispatchOf(t1);
    const info = dispatchView(w.ports.ctx, d1).info;
    const env = w.ports.ctx.environment();
    const n = 1001;
    for (const [from, to] of [[1, 600], [601, n]] as const) {
      w.memory.write({ op: `int-many-runs:${from}`, payload: {} }, (tx) => {
        const recs = [];
        for (let i = from; i <= to; i++) {
          const run = `rerun-many-${String(i).padStart(4, '0')}`;
          recs.push({ kind: 'flow.event' as const, mission: info.mission, line: DISPATCH_LINE(d1), event: 'run', key: run, body: tx.data.put(canonicalJson({ run, command: 'step', completed: true, exit: '0', envLine: ENV_LINE, envSnapshot: env.identity })) as ContentHash });
        }
        appendRecords(tx, recs);
      });
    }
    const shown = w.memory.read((db) => stepRuns(db, w.memory.data, info));
    const citable = w.memory.read((db) => dispatchRuns(db, w.memory.data, info));
    assert.equal(shown.length, n);
    assert.deepEqual(citable.map((r) => r.run), shown.map((r) => r.evidence), 'the same runs, in the order they were recorded');
    assert.equal(citable.at(-1)?.run, 'rerun-many-1001');
    assert.equal(citable.at(-1)?.envSnapshot, env.identity);
    // the last one backs a hand-back
    await handA1(w, t1, 'rerun-many-1001');
  });
});

// ---------------------------------------------------------------- 9 and 11 (P2): the command line

describe('INT 9: the commands show their new forms', () => {
  test('mp pm repair --answers goes with --attempts only; the help names it; the older names say which repair form they are', async () => {
    const p = processProject();
    try {
      const words = pmSay(p.ctx, 'Run it again.').words;
      const bad = await cli(p.dir, ['pm', 'repair', 'm1', '--words', words, '--kind', 'new-question', '--text', 'Run it again.', '--about', 'X1', '--rerun', 'A1', '--answers', 'R-1']);
      assert.equal(bad.code, 64, bad.err);
      assert.match(bad.err, /--answers goes with --attempts/);
      const help = await cli(p.dir, ['help', 'pm', 'repair']);
      assert.match(help.out, /--answers R-<n>: with --attempts, this change also settles that earlier repair/);
      const top = await cli(p.dir, ['--help']);
      for (const [name, form] of [['amend-attempts', '--attempts'], ['rerun-attempt', '--rerun'], ['resnapshot-exploration', '--resnapshot']]) assert.match(top.out, new RegExp(`mp pm ${name} +older name of mp pm repair ${form}, kept for one release`));
      for (const shown of ['mp pm waive', 'mp seat <dispatch> wait', '--detach']) assert.ok(top.out.includes(shown), shown);
      assert.match((await cli(p.dir, ['help', 'read', 'show'])).out, /mp read show evidence\|dispatch <id> --check-data/);
    } finally {
      p.cleanup();
    }
  });
});
